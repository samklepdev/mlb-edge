import { query, withTx } from '@mlb-edge/db';
import { getEvents, getEventOdds } from '../clients/oddsApi.js';
import { MODEL_VERSION } from '../project/model.js';
import { pOver, pOverFromPmf, deVig } from '@mlb-edge/db';
import { buildGameIndex, buildPlayerIndex, normalize } from './match.js';

type Prop = 'total_bases' | 'strikeouts';
const MARKET_TO_PROP: Record<string, Prop> = {
  batter_total_bases: 'total_bases',
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
  prop: Prop;
  line: number;
  overOdds: number;
  underOdds: number;
  source: string;
  isSharp: boolean;
}

const key = (p: number, g: number, prop: string) => `${p}:${g}:${prop}`;

// Fetch all requested books' lines for a date, resolved to our player/game ids.
interface FetchResult {
  rows: LineRow[];
  gameIds: number[];
  unmatchedPlayers: number;
  oddsEvents: number;   // events the Odds API returned
  dbGames: number;      // games in our DB for this date
  matchedEvents: number; // events that resolved to a DB game
}
async function fetchLines(date: string, opts: PullOptions): Promise<FetchResult> {
  const [events, gameIndex, playerIndex] = await Promise.all([
    getEvents(),
    buildGameIndex(date),
    buildPlayerIndex(),
  ]);
  const wanted = new Set([...opts.books, opts.sharp]);

  const rows: LineRow[] = [];
  const gameIds = new Set<number>();
  let unmatchedPlayers = 0;
  let matchedEvents = 0;

  for (const ev of events) {
    const gameId = gameIndex.get(`${normalize(ev.home_team)}|${normalize(ev.away_team)}`);
    if (gameId == null) continue; // event isn't on our slate for this date
    matchedEvents++;
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
}

// Pull lines, store them, then price each projection against the reference book
// and log a pick wherever the model beats the de-vigged market by the threshold.
export async function pullLines(date: string, opts: PullOptions): Promise<PullResult> {
  const { rows, gameIds, unmatchedPlayers, oddsEvents, dbGames, matchedEvents } = await fetchLines(date, opts);
  await storeLines(rows);

  const projections = await loadProjections(date);
  const ref = referenceLines(rows);

  interface PickRow {
    playerId: number; gameId: number; prop: Prop; side: 'over' | 'under';
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
    if (edge < opts.edgeThreshold) continue;
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

  return {
    linesStored: rows.length,
    picksWritten: picks.length,
    matchedGames: gameIds.length,
    unmatchedPlayers,
    oddsEvents,
    dbGames,
    matchedEvents,
  };
}

// Re-fetch near game time and record closing line value on existing picks.
export async function captureClosing(date: string, opts: PullOptions): Promise<number> {
  const { rows } = await fetchLines(date, opts);
  await storeLines(rows);
  const ref = referenceLines(rows);

  const openPicks = (
    await query<{ id: number; player_id: number; game_id: number; prop_type: string; side: 'over' | 'under' }>(
      `SELECT pk.id, pk.player_id, pk.game_id, pk.prop_type, pk.side
       FROM picks pk JOIN games g ON g.id = pk.game_id
       WHERE g.game_date = $1`,
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
             clv_pct = $3 - pick_fair_prob
         WHERE id = $4`,
        [r.line, closeOdds, closeFair.toFixed(4), pk.id],
      );
      updated++;
    }
  });
  return updated;
}

// Grade settled picks against actual box-score outcomes (TB / SO from rollups).
export async function settleResults(date: string): Promise<number> {
  const rows = (
    await query<{ id: number; prop_type: string; side: 'over' | 'under'; pick_line: string; tb: number | null; so: number | null }>(
      `SELECT pk.id, pk.prop_type, pk.side, pk.pick_line, b.tb, ps.so
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
      const actual = r.prop_type === 'total_bases' ? r.tb : r.so;
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
