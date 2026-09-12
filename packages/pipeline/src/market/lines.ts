import { query, withTx } from '@mlb-edge/db';
import { getEvents, getEventOdds } from '../clients/oddsApi.js';
import { MODEL_VERSION } from '../project/model.js';
import { pOver, pOverFromPmf, deVig } from '@mlb-edge/db';
import { buildGameIndex, buildPlayerIndex, normalize } from './match.js';
import type { PropKind } from '../project/index.js';
import { actualFor } from '../props.js';

const MARKET_TO_PROP: Record<string, PropKind> = {
  batter_total_bases: 'total_bases',
  batter_hits: 'hits',
  batter_home_runs: 'home_runs',
  pitcher_strikeouts: 'strikeouts',
};
const MARKETS = Object.keys(MARKET_TO_PROP);

export interface PullOptions {
  books: string[];      // bookmaker keys to store
  sharp: string;        // reference/sharp bookmaker key (preferred for pricing)
  regions: string;      // e.g. 'us' or 'us,eu'
  edgeThreshold: number; // minimum |model - fair| to log a pick
}

interface LineRow {
  playerId: number;
  gameId: number;
  prop: PropKind;
  line: number;
  overOdds: number;
  underOdds: number;
  source: string;
  isSharp: boolean;
}

const key = (p: number, g: number, prop: string) => `${p}:${g}:${prop}`;

// Games on this slate whose first pitch has passed. A NULL start_time satisfies
// neither this test nor captureClosing's `start_time > now()`, so such a game is
// never treated as started -- only the synthetic sentinel has one, and it carries
// no market_lines rows.
async function startedGameIds(date: string): Promise<Set<number>> {
  const res = await query<{ id: number }>(
    'SELECT id FROM games WHERE game_date = $1 AND start_time <= now()',
    [date],
  );
  return new Set(res.rows.map((r) => r.id));
}

// Fetch all requested books' lines for a date, resolved to our player/game ids.
interface FetchResult {
  rows: LineRow[];
  gameIds: number[];
  unmatchedPlayers: number;
  oddsEvents: number;   // events the Odds API returned
  dbGames: number;      // games in our DB for this date
  matchedEvents: number; // events that resolved to a DB game
  skippedStartedGames: number; // matched events skipped because first pitch had passed
}
async function fetchLines(date: string, opts: PullOptions): Promise<FetchResult> {
  const [events, gameIndex, playerIndex, startedGames] = await Promise.all([
    getEvents(),
    buildGameIndex(date),
    buildPlayerIndex(),
    startedGameIds(date),
  ]);
  const wanted = new Set([...opts.books, opts.sharp]);

  const rows: LineRow[] = [];
  const gameIds = new Set<number>();
  let unmatchedPlayers = 0;
  let matchedEvents = 0;
  let skippedStartedGames = 0;

  for (const ev of events) {
    const gameId = gameIndex.get(`${normalize(ev.home_team)}|${normalize(ev.away_team)}`);
    if (gameId == null) continue; // event isn't on our slate for this date
    matchedEvents++;
    // A price quoted after first pitch is a LIVE in-game price. Skipping here --
    // after the match so it can be counted, BEFORE getEventOdds so it costs
    // nothing -- does double duty: the live quote never reaches market_lines
    // (where loadStoredLines and getPlayerCard would prefer it for being newest),
    // and no credit is spent fetching data we would refuse to use.
    if (startedGames.has(gameId)) { skippedStartedGames++; continue; }
    const odds = await getEventOdds(ev.id, MARKETS, opts.regions);

    for (const bk of odds.bookmakers) {
      if (!wanted.has(bk.key)) continue;
      for (const mkt of bk.markets) {
        const prop = MARKET_TO_PROP[mkt.key];
        if (!prop) continue;

        // group Over/Under by (player, line)
        const byPlayer = new Map<string, { over?: number; under?: number; line: number; player: string }>();
        for (const o of mkt.outcomes) {
          if (o.description == null || o.point == null) continue;
          const gk = `${o.description}@${o.point}`;
          const cur = byPlayer.get(gk) ?? { line: o.point, player: o.description };
          if (o.name.toLowerCase() === 'over') cur.over = o.price;
          else if (o.name.toLowerCase() === 'under') cur.under = o.price;
          byPlayer.set(gk, cur);
        }

        for (const g of byPlayer.values()) {
          if (g.over == null || g.under == null) continue;
          const playerId = playerIndex.get(normalize(g.player));
          if (playerId == null) { unmatchedPlayers++; continue; }
          rows.push({
            playerId, gameId, prop, line: g.line,
            overOdds: g.over, underOdds: g.under,
            source: bk.key, isSharp: bk.key === opts.sharp,
          });
          gameIds.add(gameId);
        }
      }
    }
  }
  return {
    rows,
    gameIds: [...gameIds],
    unmatchedPlayers,
    oddsEvents: events.length,
    dbGames: gameIndex.size,
    matchedEvents,
    skippedStartedGames,
  };
}

// Choose one reference line per (player,game,prop): the sharp book if present.
function referenceLines(rows: LineRow[]): Map<string, LineRow> {
  const ref = new Map<string, LineRow>();
  for (const r of rows) {
    const k = key(r.playerId, r.gameId, r.prop);
    const cur = ref.get(k);
    if (!cur || (r.isSharp && !cur.isSharp)) ref.set(k, r);
  }
  return ref;
}

async function loadProjections(date: string): Promise<Map<string, { mean: number; stdev: number; pmf: number[] | null }>> {
  const res = await query<{ player_id: number; game_id: number; prop_type: string; proj_mean: string; proj_stdev: string | null; dist: number[] | null }>(
    `SELECT p.player_id, p.game_id, p.prop_type, p.proj_mean, p.proj_stdev, p.dist
     FROM projections p JOIN games g ON g.id = p.game_id
     WHERE g.game_date = $1 AND p.model_version = $2`,
    [date, MODEL_VERSION],
  );
  const m = new Map<string, { mean: number; stdev: number; pmf: number[] | null }>();
  for (const r of res.rows) {
    m.set(key(r.player_id, r.game_id, r.prop_type), {
      mean: Number(r.proj_mean),
      stdev: r.proj_stdev == null ? 0 : Number(r.proj_stdev),
      pmf: r.dist,
    });
  }
  return m;
}

async function storeLines(rows: LineRow[]): Promise<void> {
  if (rows.length === 0) return;
  await withTx(async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO market_lines (player_id, game_id, prop_type, line, over_odds, under_odds, source, is_sharp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.playerId, r.gameId, r.prop, r.line, r.overOdds, r.underOdds, r.source, r.isSharp],
      );
    }
  });
}

export interface PullResult {
  linesStored: number;
  picksWritten: number;
  matchedGames: number;
  unmatchedPlayers: number;
  oddsEvents: number;
  dbGames: number;
  matchedEvents: number;
  skippedStartedGames: number;
}

// Price lines against current projections and replace this slate's picks.
// Shared by `lines pull` (lines fresh from the API) and `lines reprice`
// (lines already stored, no API call). The pricing rule is identical either
// way -- only where the lines come from differs.
async function priceAndWritePicks(date: string, rows: LineRow[], edgeThreshold: number): Promise<number> {
  const projections = await loadProjections(date);
  const ref = referenceLines(rows);
  const gameIds = [...new Set(rows.map((r) => r.gameId))];

  interface PickRow {
    playerId: number; gameId: number; prop: PropKind; side: 'over' | 'under';
    prob: number; line: number; odds: number; fair: number; edge: number;
  }
  const picks: PickRow[] = [];

  for (const [k, r] of ref) {
    const proj = projections.get(k);
    if (!proj) continue;
    const modelOver = proj.pmf ? pOverFromPmf(proj.pmf, r.line) : pOver(proj.mean, proj.stdev, r.line);
    const { fairOver } = deVig(r.overOdds, r.underOdds);
    const edgeOver = modelOver - fairOver;
    const side: 'over' | 'under' = edgeOver >= 0 ? 'over' : 'under';
    const edge = Math.abs(edgeOver);
    if (edge < edgeThreshold) continue;
    picks.push({
      playerId: r.playerId, gameId: r.gameId, prop: r.prop, side,
      prob: side === 'over' ? modelOver : 1 - modelOver,
      line: r.line, odds: side === 'over' ? r.overOdds : r.underOdds,
      fair: side === 'over' ? fairOver : 1 - fairOver,
      edge,
    });
  }

  await withTx(async (c) => {
    if (gameIds.length > 0) {
      // idempotent: replace this slate's model picks (leaves demo/other games alone)
      await c.query('DELETE FROM picks WHERE game_id = ANY($1)', [gameIds]);
    }
    for (const p of picks) {
      await c.query(
        `INSERT INTO picks
           (player_id, game_id, prop_type, side, pick_prob, pick_line, pick_odds, edge_pct, pick_fair_prob)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.playerId, p.gameId, p.prop, p.side, p.prob.toFixed(4), p.line, p.odds, p.edge.toFixed(4), p.fair.toFixed(4)],
      );
    }
  });

  return picks.length;
}

// Pull lines, store them, then price each projection against the reference book
// and log a pick wherever the model beats the de-vigged market by the threshold.
export async function pullLines(date: string, opts: PullOptions): Promise<PullResult> {
  const { rows, gameIds, unmatchedPlayers, oddsEvents, dbGames, matchedEvents, skippedStartedGames } =
    await fetchLines(date, opts);
  await storeLines(rows);
  const picksWritten = await priceAndWritePicks(date, rows, opts.edgeThreshold);

  return {
    linesStored: rows.length,
    picksWritten,
    matchedGames: gameIds.length,
    unmatchedPlayers,
    oddsEvents,
    dbGames,
    matchedEvents,
    skippedStartedGames,
  };
}

// Re-read the lines already stored for a slate: one row per player/game/prop,
// preferring the sharp book and then the most recent fetch -- the same
// preference order getPlayerCard uses.
async function loadStoredLines(date: string): Promise<LineRow[]> {
  const res = await query<{
    player_id: number; game_id: number; prop_type: string; line: string;
    over_odds: number | null; under_odds: number | null; source: string; is_sharp: boolean;
  }>(
    `SELECT DISTINCT ON (ml.player_id, ml.game_id, ml.prop_type)
            ml.player_id, ml.game_id, ml.prop_type, ml.line,
            ml.over_odds, ml.under_odds, ml.source, ml.is_sharp
     FROM market_lines ml JOIN games g ON g.id = ml.game_id
     WHERE g.game_date = $1
       -- A quote fetched at or after first pitch is a LIVE in-game price. The
       -- ORDER BY below prefers the newest row, so without this a late capture's
       -- live quote would win. DISTINCT ON applies WHERE first, so excluding the
       -- live row falls back to the newest PRE-START row for that key at no cost
       -- -- no fallback logic is needed here.
       -- NULL start_time makes this NULL, i.e. excluded: an unverifiable
       -- timestamp is not trusted (matches how close_captured_at treats NULL).
       AND ml.fetched_at < g.start_time
     ORDER BY ml.player_id, ml.game_id, ml.prop_type, ml.is_sharp DESC, ml.fetched_at DESC`,
    [date],
  );
  const out: LineRow[] = [];
  for (const r of res.rows) {
    // Both sides are required to de-vig; a one-sided row carries no fair price.
    if (r.over_odds == null || r.under_odds == null) continue;
    out.push({
      playerId: r.player_id, gameId: r.game_id, prop: r.prop_type as PropKind,
      line: Number(r.line), overOdds: r.over_odds, underOdds: r.under_odds,
      source: r.source, isSharp: r.is_sharp,
    });
  }
  return out;
}

// Re-price a slate from lines already in the database. Zero API calls, so
// iterating on the model costs no odds quota.
export async function repriceLines(
  date: string,
  edgeThreshold: number,
): Promise<{ linesRead: number; picksWritten: number }> {
  const rows = await loadStoredLines(date);
  const picksWritten = await priceAndWritePicks(date, rows, edgeThreshold);
  return { linesRead: rows.length, picksWritten };
}

export interface CaptureResult {
  updated: number;
  skipped: number;
  gamesStarted: number;
  nextFirstPitch: Date | null;
  lastFirstPitch: Date | null;
  fetched: boolean;
}

// Capture closing lines, but only for games that have not started. A price
// quoted after first pitch is a LIVE in-game price: recording it as a "closing"
// line is what contaminated 164 of the first 500 CLV rows.
export async function captureClosing(date: string, opts: PullOptions): Promise<CaptureResult> {
  // Slate timing BEFORE any network call. If nothing is upcoming there is no
  // closing market left to capture, and a full fetch costs ~120 credits against
  // a 500/month free tier -- so this early exit is the difference between
  // spending 120 credits and spending 0.
  const timing = (
    await query<{ upcoming: string; started: string; next_start: Date | null; last_start: Date | null }>(
      `SELECT count(*) FILTER (WHERE g.start_time >  now()) AS upcoming,
              count(*) FILTER (WHERE g.start_time <= now()) AS started,
              min(g.start_time) FILTER (WHERE g.start_time > now()) AS next_start,
              max(g.start_time) AS last_start
       FROM games g
       WHERE g.game_date = $1 AND NOT g.is_synthetic`,
      [date],
    )
  ).rows[0];

  const upcoming = Number(timing.upcoming);
  const gamesStarted = Number(timing.started);

  const skipped = Number(
    (
      await query<{ n: string }>(
        `SELECT count(*) AS n
         FROM picks pk JOIN games g ON g.id = pk.game_id
         WHERE g.game_date = $1 AND g.start_time <= now() AND NOT g.is_synthetic`,
        [date],
      )
    ).rows[0].n,
  );

  if (upcoming === 0) {
    return {
      updated: 0, skipped, gamesStarted,
      nextFirstPitch: null, lastFirstPitch: timing.last_start, fetched: false,
    };
  }

  const { rows } = await fetchLines(date, opts);
  await storeLines(rows);
  const ref = referenceLines(rows);

  // `g.start_time > now()` is the guard: a started game's picks are never
  // written. Wall-clock at capture time, so a rain-delayed game counts as
  // started -- correct, because its market is no longer a closing market either.
  const openPicks = (
    await query<{ id: number; player_id: number; game_id: number; prop_type: string; side: 'over' | 'under' }>(
      `SELECT pk.id, pk.player_id, pk.game_id, pk.prop_type, pk.side
       FROM picks pk JOIN games g ON g.id = pk.game_id
       WHERE g.game_date = $1 AND g.start_time > now()`,
      [date],
    )
  ).rows;

  let updated = 0;
  await withTx(async (c) => {
    for (const pk of openPicks) {
      const r = ref.get(key(pk.player_id, pk.game_id, pk.prop_type));
      if (!r) continue;
      const { fairOver, fairUnder } = deVig(r.overOdds, r.underOdds);
      const closeFair = pk.side === 'over' ? fairOver : fairUnder;
      const closeOdds = pk.side === 'over' ? r.overOdds : r.underOdds;
      await c.query(
        `UPDATE picks
         SET close_line = $1, close_odds = $2, close_fair_prob = $3,
             clv_pct = $3 - pick_fair_prob, close_captured_at = now()
         WHERE id = $4`,
        [r.line, closeOdds, closeFair.toFixed(4), pk.id],
      );
      updated++;
    }
  });

  return {
    updated, skipped, gamesStarted,
    nextFirstPitch: timing.next_start, lastFirstPitch: timing.last_start, fetched: true,
  };
}

// Grade settled picks against actual box-score outcomes (TB / hits / HR from
// batting rollups, SO from pitching rollups).
export async function settleResults(date: string): Promise<number> {
  const rows = (
    await query<{ id: number; prop_type: string; side: 'over' | 'under'; pick_line: string; tb: number | null; h: number | null; hr: number | null; so: number | null }>(
      `SELECT pk.id, pk.prop_type, pk.side, pk.pick_line, b.tb, b.h, b.hr, ps.so
       FROM picks pk
       JOIN games g ON g.id = pk.game_id
       LEFT JOIN player_game_batting  b  ON b.game_id  = pk.game_id AND b.player_id  = pk.player_id
       LEFT JOIN player_game_pitching ps ON ps.game_id = pk.game_id AND ps.player_id = pk.player_id
       WHERE g.game_date = $1 AND g.status ILIKE '%final%' AND pk.result IS NULL`,
      [date],
    )
  ).rows;

  let settled = 0;
  await withTx(async (c) => {
    for (const r of rows) {
      const actual = actualFor(r.prop_type, r);
      if (actual == null) continue;
      const line = Number(r.pick_line);
      let won: boolean | null;
      let result: 'win' | 'loss' | 'push';
      if (actual === line) { result = 'push'; won = null; }
      else {
        won = r.side === 'over' ? actual > line : actual < line;
        result = won ? 'win' : 'loss';
      }
      await c.query('UPDATE picks SET result = $1, won = $2 WHERE id = $3', [result, won, r.id]);
      settled++;
    }
  });
  return settled;
}
