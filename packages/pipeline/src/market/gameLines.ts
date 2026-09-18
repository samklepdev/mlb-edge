import { getGameOdds, lastQuota, type OddsEventOdds } from '../clients/oddsApi.js';
import { query, withTx } from '@mlb-edge/db';
import { buildGameIndex, normalize } from './match.js';

// Run lines and totals for a slate.
//
// One league-wide request covers every upcoming game, so this costs a couple of
// credits rather than one per game. The free tier carries no historical odds,
// which is why this can only build forward -- a date already played will return
// nothing no matter when it is run.

export interface GameLinesResult {
  date: string;
  oddsEvents: number;
  matchedGames: number;
  unmatchedEvents: string[];
  rowsWritten: number;
  skippedStarted: number;
  quota: { used: number | null; remaining: number | null };
}

export interface GameLinesOptions {
  books: string[];
  sharp: string;
  regions: string;
}

export async function pullGameLines(
  date: string, opts: GameLinesOptions,
): Promise<GameLinesResult> {
  const events: OddsEventOdds[] = await getGameOdds(['spreads', 'totals'], opts.regions);
  const index = await buildGameIndex(date);

  // Games that have already started. A price quoted after first pitch is a live
  // in-game number, and storing it beside pre-game ones would silently corrupt
  // any later comparison -- the exact mistake the player-prop side had to be
  // repaired for.
  const started = new Set(
    (
      await query<{ id: number }>(
        `SELECT id FROM games WHERE game_date = $1 AND (start_time IS NULL OR start_time <= now())`,
        [date],
      )
    ).rows.map((r) => r.id),
  );

  const out: GameLinesResult = {
    date, oddsEvents: events.length, matchedGames: 0, unmatchedEvents: [],
    rowsWritten: 0, skippedStarted: 0, quota: lastQuota,
  };

  interface Row {
    gameId: number; source: string; market: 'run_line' | 'total';
    side: string; line: number; odds: number; isSharp: boolean;
  }
  const rows: Row[] = [];
  const matched = new Set<number>();

  for (const ev of events) {
    const gameId = index.get(`${normalize(ev.home_team)}|${normalize(ev.away_team)}`);
    if (gameId == null) {
      // Only report events whose teams look like this slate at all; the
      // league-wide endpoint returns every upcoming game, most of which belong
      // to other dates and are not failures.
      continue;
    }
    if (started.has(gameId)) { out.skippedStarted++; continue; }
    matched.add(gameId);

    for (const bk of ev.bookmakers ?? []) {
      const wanted = opts.books.includes(bk.key) || bk.key === opts.sharp;
      if (!wanted) continue;
      const isSharp = bk.key === opts.sharp;

      for (const mk of bk.markets ?? []) {
        if (mk.key === 'spreads') {
          for (const o of mk.outcomes ?? []) {
            if (o.point == null) continue;
            // Outcomes are named by TEAM; map back to the side we store.
            const side = normalize(o.name) === normalize(ev.home_team) ? 'home'
              : normalize(o.name) === normalize(ev.away_team) ? 'away' : null;
            if (!side) continue;
            rows.push({ gameId, source: bk.key, market: 'run_line', side, line: o.point, odds: o.price, isSharp });
          }
        } else if (mk.key === 'totals') {
          for (const o of mk.outcomes ?? []) {
            if (o.point == null) continue;
            const side = o.name.toLowerCase() === 'over' ? 'over'
              : o.name.toLowerCase() === 'under' ? 'under' : null;
            if (!side) continue;
            rows.push({ gameId, source: bk.key, market: 'total', side, line: o.point, odds: o.price, isSharp });
          }
        }
      }
    }
  }
  out.matchedGames = matched.size;

  await withTx(async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO game_market_lines (game_id, source, market, side, line, odds, is_sharp)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.gameId, r.source, r.market, r.side, r.line, r.odds, r.isSharp],
      );
    }
  });
  out.rowsWritten = rows.length;
  out.quota = lastQuota;
  return out;
}
