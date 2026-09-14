import { getLiveFeed, type LiveFeedResponse, type LivePlay } from '../clients/mlbStatsApi.js';
import { query } from '@mlb-edge/db';

// Plate-appearance-level platoon splits, parsed out of the live feed's
// allPlays. See migrations/009 for why this is PA-level and not a
// starter-hand approximation.

export interface PlatoonCounts {
  pa: number; singles: number; doubles: number; triples: number; hr: number; so: number;
}
export interface PlatoonRow extends PlatoonCounts {
  playerId: number;
  pitchHand: 'L' | 'R';
  batSide: 'L' | 'R';
}

const empty = (): PlatoonCounts => ({ pa: 0, singles: 0, doubles: 0, triples: 0, hr: 0, so: 0 });

// Event codes, verified against 7 games / 150 player-lines with zero
// reconciliation discrepancies. `eventType` is the machine-readable code;
// `event` is a display string and must not be matched on.
//
// Everything not listed is still a plate appearance (field_out, walk,
// hit_by_pitch, sac_fly, fielders_choice, ...) and contributes only to `pa`.
// That fail-open default is safe HERE, unlike in actualFor: an unrecognised
// event undercounts a hit category, and the reconciliation gate below catches
// exactly that by comparing against the boxscore.
function applyEvent(c: PlatoonCounts, eventType: string | undefined): void {
  c.pa++;
  switch (eventType) {
    case 'single': c.singles++; break;
    case 'double': c.doubles++; break;
    case 'triple': c.triples++; break;
    case 'home_run': c.hr++; break;
    case 'strikeout':
    case 'strikeout_double_play':
    case 'strikeout_triple_play': c.so++; break;
    default: break;
  }
}

const isHand = (v: string | undefined): v is 'L' | 'R' => v === 'L' || v === 'R';

// `result.type === 'atBat'` is NOT sufficient to mean "a plate appearance
// happened". The feed also types a play that way when the inning ends on a
// baserunner while someone is at the plate -- the batter's PA never completes
// and carries to the next inning, and the boxscore does not count it.
//
// This was caught by the reconciliation gate, not by reading docs: 3 of the
// first 10 games disagreed with the boxscore by exactly one PA, e.g. game
// 823737, "With Tyler Stephenson batting, Sal Stewart picked off and caught
// stealing 2nd base" -- eventType `pickoff_caught_stealing_2b`, feed pa=5,
// boxscore pa=4.
//
// The signal is whether the BATTER moved from the plate. Every completed plate
// appearance puts the batter in `runners` with `movement.originBase === null`,
// whether they reached base or were put out; a play that resolves on someone
// else's baserunning does not.
//
// Two weaker rules were tried against real data first and both leaked:
//   - `result.type === 'atBat'`: the feed types the pickoff that way too.
//   - "the last playEvent is a pitch": a runner can be caught stealing ON a
//     pitch (game 824712, `caught_stealing_2b`), which passes that test while
//     the batter's PA still never completed.
// This rule is also the semantically honest one -- it asks the question the
// boxscore is answering -- rather than a list of event codes to keep patched.
function isCompletedPa(p: LivePlay): boolean {
  if (p.result?.type !== 'atBat') return false;
  const batterId = p.matchup?.batter?.id;
  if (!batterId) return false;
  return (p.runners ?? []).some(
    (r) => r.details?.runner?.id === batterId && r.movement?.originBase == null,
  );
}

// Aggregate a feed's plays into (player, pitcher hand, batter side) lines.
//
// Switch hitters are the reason bat_side is a key rather than a lookup: the
// same player can appear twice in one game, once from each side, and the feed
// reports the side actually used.
export function platoonRowsFromFeed(feed: LiveFeedResponse | null): PlatoonRow[] {
  const plays: LivePlay[] = feed?.liveData?.plays?.allPlays ?? [];
  const agg = new Map<string, PlatoonRow>();

  for (const p of plays) {
    if (!isCompletedPa(p)) continue;
    const playerId = p.matchup?.batter?.id;
    const pitchHand = p.matchup?.pitchHand?.code?.toUpperCase();
    const batSide = p.matchup?.batSide?.code?.toUpperCase();
    if (!playerId || !isHand(pitchHand) || !isHand(batSide)) continue;

    const key = `${playerId}|${pitchHand}|${batSide}`;
    let row = agg.get(key);
    if (!row) {
      row = { playerId, pitchHand, batSide, ...empty() };
      agg.set(key, row);
    }
    applyEvent(row, p.result?.eventType);
  }
  return [...agg.values()];
}

export interface PlatoonWriteResult {
  gameId: number;
  rows: number;
  players: number;
  /** Players whose parsed totals disagree with player_game_batting. */
  mismatches: string[];
}

// Write one game's platoon rows, but only after they reconcile.
//
// The gate is the whole safety story for this ingest. Parsing play events into
// outcome counts is the risky part of the change, and player_game_batting is a
// source already known to be correct, derived independently from the boxscore.
// If the two disagree the parse is wrong, and writing anyway would put quietly
// bad data underneath a model -- the worst outcome available here. So a
// mismatch writes nothing for that game and reports.
export async function ingestGamePlatoon(gameId: number): Promise<PlatoonWriteResult> {
  return writeGamePlatoon(gameId, await getLiveFeed(gameId).catch(() => null));
}

// Takes an already-fetched feed. `ingestBoxscore` holds one for every game it
// processes, so the normal ingest path costs no extra request; only the history
// backfill has to fetch.
//
// Must run AFTER player_game_batting is committed for this game -- the gate
// below reads it.
export async function writeGamePlatoon(
  gameId: number, feed: LiveFeedResponse | null,
): Promise<PlatoonWriteResult> {
  const rows = platoonRowsFromFeed(feed);
  const result: PlatoonWriteResult = { gameId, rows: 0, players: 0, mismatches: [] };
  if (rows.length === 0) return result;

  // Collapse to per-player totals for the comparison; the boxscore has no
  // handedness breakdown to compare against, only the game total.
  const totals = new Map<number, PlatoonCounts>();
  for (const r of rows) {
    const t = totals.get(r.playerId) ?? empty();
    t.pa += r.pa; t.singles += r.singles; t.doubles += r.doubles;
    t.triples += r.triples; t.hr += r.hr; t.so += r.so;
    totals.set(r.playerId, t);
  }

  const box = (
    await query<{ player_id: number; pa: number; h: number; doubles: number; triples: number; hr: number; so: number }>(
      `SELECT player_id, pa, h, doubles, triples, hr, so
       FROM player_game_batting WHERE game_id = $1`,
      [gameId],
    )
  ).rows;

  for (const b of box) {
    const t = totals.get(b.player_id);
    // A batter with 0 PA appears in the boxscore but in no play; that is the
    // DNP case, not a mismatch.
    if (!t) { if (b.pa > 0) result.mismatches.push(`${b.player_id}: absent from feed, boxscore pa=${b.pa}`); continue; }
    const singles = b.h - b.doubles - b.triples - b.hr;
    const diffs: string[] = [];
    if (t.pa !== b.pa) diffs.push(`pa ${t.pa}!=${b.pa}`);
    if (t.singles !== singles) diffs.push(`1B ${t.singles}!=${singles}`);
    if (t.doubles !== b.doubles) diffs.push(`2B ${t.doubles}!=${b.doubles}`);
    if (t.triples !== b.triples) diffs.push(`3B ${t.triples}!=${b.triples}`);
    if (t.hr !== b.hr) diffs.push(`HR ${t.hr}!=${b.hr}`);
    if (t.so !== b.so) diffs.push(`SO ${t.so}!=${b.so}`);
    if (diffs.length > 0) result.mismatches.push(`${b.player_id}: ${diffs.join(', ')}`);
  }
  if (result.mismatches.length > 0) return result;

  // Only players the boxscore knows about: player_game_platoon has an FK to
  // players, and a pinch runner who never batted has no play anyway.
  const known = new Set(box.map((b) => b.player_id));
  const writable = rows.filter((r) => known.has(r.playerId));

  for (const r of writable) {
    await query(
      `INSERT INTO player_game_platoon
         (game_id, player_id, pitch_hand, bat_side, pa, singles, doubles, triples, hr, so)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (game_id, player_id, pitch_hand, bat_side) DO UPDATE SET
         pa = EXCLUDED.pa, singles = EXCLUDED.singles, doubles = EXCLUDED.doubles,
         triples = EXCLUDED.triples, hr = EXCLUDED.hr, so = EXCLUDED.so`,
      [gameId, r.playerId, r.pitchHand, r.batSide, r.pa, r.singles, r.doubles, r.triples, r.hr, r.so],
    );
  }
  result.rows = writable.length;
  result.players = new Set(writable.map((r) => r.playerId)).size;
  return result;
}

export interface PlatoonBackfillResult {
  games: number; ok: number; skipped: number; failed: number; rows: number;
  mismatchedGames: Array<{ gameId: number; sample: string }>;
}

// Backfill history. Each game is one feed/live fetch (~900KB), so this is the
// expensive step; `getJson` has no throttle, hence the pause.
export async function backfillPlatoon(opts: {
  from?: string; to?: string; limit?: number; pauseMs?: number;
  onProgress?: (done: number, total: number) => void;
} = {}): Promise<PlatoonBackfillResult> {
  const where: string[] = ['NOT g.is_synthetic', 'EXISTS (SELECT 1 FROM player_game_batting b WHERE b.game_id = g.id)'];
  const params: unknown[] = [];
  if (opts.from) { params.push(opts.from); where.push(`g.game_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`g.game_date <= $${params.length}`); }
  // Resumable by construction: a game already carrying platoon rows is skipped,
  // so an interrupted run is restarted by re-running the same command.
  where.push('NOT EXISTS (SELECT 1 FROM player_game_platoon p WHERE p.game_id = g.id)');

  let sql = `SELECT g.id FROM games g WHERE ${where.join(' AND ')} ORDER BY g.game_date DESC, g.id`;
  if (opts.limit) { params.push(opts.limit); sql += ` LIMIT $${params.length}`; }

  const ids = (await query<{ id: number }>(sql, params)).rows.map((r) => r.id);
  const out: PlatoonBackfillResult = {
    games: ids.length, ok: 0, skipped: 0, failed: 0, rows: 0, mismatchedGames: [],
  };
  const pause = opts.pauseMs ?? 200;

  for (let i = 0; i < ids.length; i++) {
    try {
      const r = await ingestGamePlatoon(ids[i]);
      if (r.mismatches.length > 0) {
        out.failed++;
        out.mismatchedGames.push({ gameId: ids[i], sample: r.mismatches[0] });
      } else if (r.rows === 0) {
        out.skipped++;
      } else {
        out.ok++;
        out.rows += r.rows;
      }
    } catch {
      out.failed++;
    }
    opts.onProgress?.(i + 1, ids.length);
    if (i + 1 < ids.length) await new Promise((res) => setTimeout(res, pause));
  }
  return out;
}
