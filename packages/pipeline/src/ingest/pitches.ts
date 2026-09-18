import { getLiveFeed, type LiveFeedResponse, type LivePlay } from '../clients/mlbStatsApi.js';
import { query } from '@mlb-edge/db';

// Per-pitch capture from the live feed's playEvents.
//
// Same payload the platoon capture reads, and the same argument: `ingest games`
// already downloads it for every game, so this costs no extra request on the
// ingest path -- only the history backfill has to fetch.

export interface PitchRow {
  atBatIndex: number; pitchNumber: number;
  batterId: number; pitcherId: number;
  batSide: string | null; pitchHand: string | null;
  pitchType: string | null; callCode: string;
  isStrike: boolean; inPlay: boolean; isSwing: boolean; isWhiff: boolean;
  zone: number | null; inZone: boolean | null;
  startSpeed: number | null; plateX: number | null; plateZ: number | null;
  launchSpeed: number | null; launchAngle: number | null;
  hitDistance: number | null; trajectory: string | null;
  balls: number | null; strikes: number | null;
}

// MLB's pitch-result codes, split by whether the batter offered.
//
// Enumerated from real pitches rather than from documentation: B, C, F, S, X,
// D, E, *B, T, O, W, H, L, P, M, Q. Both sets are explicit and a code in
// NEITHER is counted and reported rather than silently treated as a take --
// the reconciliation gate below checks pitch COUNT, so a misclassified swing
// would otherwise pass unnoticed.
// 'O' is a second foul-tip code alongside 'T' -- found by the unknown-code
// report, not by documentation, and confirmed from the feed's own description.
// It is contact, so it counts as a swing and NOT as a whiff.
const SWING = new Set(['F', 'S', 'T', 'O', 'W', 'L', 'M', 'Q', 'X', 'D', 'E']);
const TAKE = new Set(['B', '*B', 'C', 'H', 'P', 'V', 'VB', 'AB', 'IB', 'I']);
// A swing that missed. Foul tips (T) are contact, fouls (F) are contact.
// 'Q' is a Swinging Pitchout -- a swing at a pitch thrown deliberately wide,
// so it misses. Also found by the unknown-code report rather than documentation.
const WHIFF = new Set(['S', 'W', 'M', 'Q']);

export interface PitchParse {
  rows: PitchRow[];
  /** Call codes in neither set, with counts. Surfaced so an unrecognised code
   *  cannot quietly become "no swing". */
  unknownCalls: Record<string, number>;
}

// A pitching change arrives as an `action` event INSIDE a plate appearance,
// and `matchup.pitcher` names whoever FINISHED it -- so every pitch thrown
// before the change would otherwise be credited to the reliever who replaced
// him. This is the exact mirror of the batter-substitution case the platoon
// capture hit, and the count gate caught it the same way: game 825034, Pete
// Fairbanks parsed 5 against a boxscore 6, with the missing pitch sitting at
// the start of the NEXT plate appearance under Jack Ralston's name.
const isPitchingChange = (e: { type?: string; details?: { description?: string } }) =>
  e.type === 'action' && /pitching change/i.test(e.details?.description ?? '');

export function pitchRowsFromFeed(feed: LiveFeedResponse | null): PitchParse {
  const plays: LivePlay[] = feed?.liveData?.plays?.allPlays ?? [];
  const rows: PitchRow[] = [];
  const unknownCalls: Record<string, number> = {};
  // Two mounds, tracked independently. The sides alternate, so a single
  // "current pitcher" is wrong the moment a half-inning flips -- and resetting
  // to matchup.pitcher at the boundary is ALSO wrong, because matchup.pitcher
  // names whoever FINISHED the plate appearance.
  //
  // Game 823033, top of the 4th, is the case that proves it: Kyle Leahy threw
  // three pitches, rain delayed the game, George Soriano replaced him, and
  // Soriano finished the PA. matchup.pitcher is Soriano, so resetting to him at
  // the boundary handed him Leahy's three pitches. Remembering each side's last
  // pitcher instead gets it right, and the boxscore count gate is what surfaced
  // both attempts.
  const byHalf: Record<string, number | null> = { top: null, bottom: null };

  for (const p of plays) {
    const batterId = p.matchup?.batter?.id;
    const pitcherId = p.matchup?.pitcher?.id;
    const atBatIndex = p.about?.atBatIndex;
    if (batterId == null || pitcherId == null || atBatIndex == null) continue;

    const events = p.playEvents ?? [];
    const half = p.about?.halfInning === 'bottom' ? 'bottom' : 'top';
    // Whoever was last on this side's mound. Falls back to matchup.pitcher only
    // for the first plate appearance each side pitches.
    let current: number = byHalf[half] ?? pitcherId;

    for (const e of events) {
      if (isPitchingChange(e) && e.player?.id != null) { current = e.player.id; continue; }
      if (!e.isPitch) continue;
      const call = e.details?.call?.code;
      const pitchNumber = e.pitchNumber;
      if (!call || pitchNumber == null) continue;

      if (!SWING.has(call) && !TAKE.has(call)) {
        unknownCalls[call] = (unknownCalls[call] ?? 0) + 1;
      }

      const zone = e.pitchData?.zone ?? null;
      rows.push({
        atBatIndex, pitchNumber, batterId, pitcherId: current,
        batSide: p.matchup?.batSide?.code?.toUpperCase() ?? null,
        pitchHand: p.matchup?.pitchHand?.code?.toUpperCase() ?? null,
        pitchType: e.details?.type?.code ?? null,
        callCode: call,
        isStrike: e.details?.isStrike === true,
        inPlay: e.details?.isInPlay === true,
        isSwing: SWING.has(call),
        isWhiff: WHIFF.has(call),
        zone,
        // 1-9 inside, 11-14 outside. Anything else is unknown rather than
        // false, so chase rate can exclude it instead of counting it as a
        // pitch in the zone.
        inZone: zone == null ? null : zone >= 1 && zone <= 9,
        startSpeed: e.pitchData?.startSpeed ?? null,
        plateX: e.pitchData?.coordinates?.pX ?? null,
        plateZ: e.pitchData?.coordinates?.pZ ?? null,
        launchSpeed: e.hitData?.launchSpeed ?? null,
        launchAngle: e.hitData?.launchAngle ?? null,
        hitDistance: e.hitData?.totalDistance ?? null,
        trajectory: e.hitData?.trajectory ?? null,
        balls: e.count?.balls ?? null,
        strikes: e.count?.strikes ?? null,
      });
    }
    // Whoever finished the plate appearance holds the mound for this side.
    byHalf[half] = pitcherId;
  }
  return { rows, unknownCalls };
}

export interface PitchWriteResult {
  gameId: number;
  written: number;
  mismatches: string[];
  unknownCalls: Record<string, number>;
}

// Write one game's pitches, but only after the count reconciles.
//
// The gate compares parsed pitches per pitcher against
// player_game_pitching.pitches, which comes from the BOXSCORE -- a different
// part of the payload from allPlays, so one parsing mistake cannot corrupt both
// in the same direction. Verified on game 824981: all nine pitchers matched
// exactly (20/20, 23/23, 95/95, ...).
//
// It does NOT check strikes. The boxscore counts every pitch that is not a
// ball, including fouls and balls in play, while the feed's details.isStrike is
// narrower -- the two disagree for every pitcher (8 vs 12, 51 vs 63), so
// gating on it would fail 100% of games. See migration 013.
export async function writeGamePitches(
  gameId: number, feed: LiveFeedResponse | null,
): Promise<PitchWriteResult> {
  const { rows, unknownCalls } = pitchRowsFromFeed(feed);
  const out: PitchWriteResult = { gameId, written: 0, mismatches: [], unknownCalls };
  if (rows.length === 0) return out;

  const byPitcher = new Map<number, number>();
  for (const r of rows) byPitcher.set(r.pitcherId, (byPitcher.get(r.pitcherId) ?? 0) + 1);

  const box = (
    await query<{ player_id: number; pitches: number }>(
      `SELECT player_id, pitches FROM player_game_pitching
       WHERE game_id = $1 AND pitches > 0`,
      [gameId],
    )
  ).rows;
  // No stored pitch counts means nothing to reconcile against -- refuse rather
  // than write unchecked. This is the case for a game whose boxscore predates
  // migration 013's backfill.
  if (box.length === 0) {
    out.mismatches.push('no stored pitch counts for this game');
    return out;
  }

  for (const b of box) {
    const got = byPitcher.get(b.player_id) ?? 0;
    if (got !== b.pitches) out.mismatches.push(`${b.player_id}: parsed ${got}, boxscore ${b.pitches}`);
  }
  for (const [pid, n] of byPitcher) {
    if (!box.some((b) => b.player_id === pid)) out.mismatches.push(`${pid}: parsed ${n}, absent from boxscore`);
  }
  if (out.mismatches.length > 0) return out;

  // Chunked multi-row insert: a game is ~282 pitches, and one round trip per
  // pitch would make the history backfill an order of magnitude slower than
  // the fetch it is already bound by.
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const tuples = slice.map((r) => {
      const b = params.length;
      params.push(
        gameId, r.atBatIndex, r.pitchNumber, r.batterId, r.pitcherId,
        r.batSide, r.pitchHand, r.pitchType, r.callCode,
        r.isStrike, r.inPlay, r.isSwing, r.isWhiff, r.zone, r.inZone,
        r.startSpeed, r.plateX, r.plateZ,
        r.launchSpeed, r.launchAngle, r.hitDistance, r.trajectory,
        r.balls, r.strikes,
      );
      return `(${Array.from({ length: 24 }, (_, k) => `$${b + k + 1}`).join(',')})`;
    });
    await query(
      `INSERT INTO game_pitches
         (game_id, at_bat_index, pitch_number, batter_id, pitcher_id,
          bat_side, pitch_hand, pitch_type, call_code,
          is_strike, in_play, is_swing, is_whiff, zone, in_zone,
          start_speed, plate_x, plate_z,
          launch_speed, launch_angle, hit_distance, trajectory,
          balls, strikes)
       VALUES ${tuples.join(',')}
       ON CONFLICT (game_id, at_bat_index, pitch_number) DO NOTHING`,
      params,
    );
  }
  out.written = rows.length;
  return out;
}

export interface PitchBackfillResult {
  games: number; ok: number; skipped: number; failed: number; pitches: number;
  unknownCalls: Record<string, number>;
  mismatchedGames: Array<{ gameId: number; sample: string }>;
}

export async function backfillPitches(opts: {
  from?: string; to?: string; limit?: number; pauseMs?: number;
  onProgress?: (done: number, total: number, pitches: number) => void;
} = {}): Promise<PitchBackfillResult> {
  const where: string[] = [
    'NOT g.is_synthetic',
    'EXISTS (SELECT 1 FROM player_game_pitching p WHERE p.game_id = g.id AND p.pitches > 0)',
    // Resumable: a game that already has pitches is skipped, so an interrupted
    // run continues by re-running the same command.
    'NOT EXISTS (SELECT 1 FROM game_pitches gp WHERE gp.game_id = g.id)',
  ];
  const params: unknown[] = [];
  if (opts.from) { params.push(opts.from); where.push(`g.game_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`g.game_date <= $${params.length}`); }

  let sql = `SELECT g.id FROM games g WHERE ${where.join(' AND ')} ORDER BY g.game_date DESC, g.id`;
  if (opts.limit) { params.push(opts.limit); sql += ` LIMIT $${params.length}`; }

  const ids = (await query<{ id: number }>(sql, params)).rows.map((r) => r.id);
  const out: PitchBackfillResult = {
    games: ids.length, ok: 0, skipped: 0, failed: 0, pitches: 0,
    unknownCalls: {}, mismatchedGames: [],
  };
  const pause = opts.pauseMs ?? 200;

  for (let i = 0; i < ids.length; i++) {
    try {
      const feed = await getLiveFeed(ids[i]).catch(() => null);
      const r = await writeGamePitches(ids[i], feed);
      for (const [k, v] of Object.entries(r.unknownCalls)) {
        out.unknownCalls[k] = (out.unknownCalls[k] ?? 0) + v;
      }
      if (r.mismatches.length > 0) {
        out.failed++;
        out.mismatchedGames.push({ gameId: ids[i], sample: r.mismatches[0] });
      } else if (r.written === 0) {
        out.skipped++;
      } else {
        out.ok++;
        out.pitches += r.written;
      }
    } catch {
      out.failed++;
    }
    opts.onProgress?.(i + 1, ids.length, out.pitches);
    if (i + 1 < ids.length) await new Promise((res) => setTimeout(res, pause));
  }
  return out;
}
