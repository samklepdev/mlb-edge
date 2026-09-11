import { query } from '../pool.js';
import { pOver, pOverFromPmf, deVig } from '../prob.js';
import type { PlayerCard, PlayerCardRow } from '../types.js';

// A player's read for a slate: projection, market line, model probability, the
// de-vigged fair probability for the SAME side, and the edge between them.
export async function getPlayerCard(playerId: number, date: string): Promise<PlayerCard | null> {
  const p = (await query<{ full_name: string }>('SELECT full_name FROM players WHERE id = $1', [playerId])).rows[0];
  if (!p) return null;

  // only the current model version (avoids showing stale v0.1 rows alongside v0.2)
  const projections = (
    await query<{
      game_id: number; prop_type: string; proj_mean: string; proj_stdev: string | null;
      dist: number[] | null; home: string | null; away: string | null;
    }>(
      `SELECT p.game_id, p.prop_type, p.proj_mean, p.proj_stdev, p.dist,
              th.name AS home, ta.name AS away
       FROM projections p
       JOIN games g ON g.id = p.game_id
       LEFT JOIN teams th ON th.id = g.home_team_id
       LEFT JOIN teams ta ON ta.id = g.away_team_id
       WHERE p.player_id = $1 AND g.game_date = $2
         AND p.model_version = (SELECT max(model_version) FROM projections)
       ORDER BY p.game_id, p.prop_type`,
      [playerId, date],
    )
  ).rows;

  const lines = (
    await query<{ game_id: number; prop_type: string; line: string; over_odds: number | null; under_odds: number | null }>(
      `SELECT DISTINCT ON (game_id, prop_type)
              game_id, prop_type, line, over_odds, under_odds
       FROM market_lines
       WHERE player_id = $1
       ORDER BY game_id, prop_type, is_sharp DESC, fetched_at DESC`,
      [playerId],
    )
  ).rows;
  const lineKey = (g: number, prop: string) => `${g}:${prop}`;
  const lineMap = new Map(lines.map((l) => [lineKey(l.game_id, l.prop_type), l]));

  const picks = (
    await query<{ game_id: number; prop_type: string }>(
      `SELECT pk.game_id, pk.prop_type FROM picks pk JOIN games g ON g.id = pk.game_id
       WHERE pk.player_id = $1 AND g.game_date = $2`,
      [playerId, date],
    )
  ).rows;
  const pickSet = new Set(picks.map((pk) => lineKey(pk.game_id, pk.prop_type)));

  const rows: PlayerCardRow[] = projections.map((pr) => {
    const mean = Number(pr.proj_mean);
    const stdev = pr.proj_stdev == null ? null : Number(pr.proj_stdev);
    const ml = lineMap.get(lineKey(pr.game_id, pr.prop_type));
    const matchup = pr.away && pr.home ? `${pr.away} @ ${pr.home}` : null;

    let line: number | null = null;
    let modelProb: number | null = null;
    let fairProb: number | null = null;
    let edgePct: number | null = null;
    let side: 'over' | 'under' | null = null;

    if (ml) {
      line = Number(ml.line);
      const modelOver = pr.dist ? pOverFromPmf(pr.dist, line) : stdev != null ? pOver(mean, stdev, line) : null;
      if (modelOver != null && ml.over_odds != null && ml.under_odds != null) {
        const { fairOver, fairUnder } = deVig(ml.over_odds, ml.under_odds);
        const edgeOver = modelOver - fairOver;
        if (edgeOver >= 0) { side = 'over'; modelProb = modelOver; fairProb = fairOver; }
        else { side = 'under'; modelProb = 1 - modelOver; fairProb = fairUnder; }
        edgePct = modelProb - fairProb; // same side on both sides of the subtraction
      } else if (modelOver != null) {
        modelProb = modelOver; // no odds: just show model P(over)
      }
    }

    return {
      propType: pr.prop_type, matchup, projMean: mean, projStdev: stdev, line,
      modelProb, fairProb, edgePct, side,
      hasPick: pickSet.has(lineKey(pr.game_id, pr.prop_type)),
    };
  });

  return { playerId, playerName: p.full_name, date, rows };
}
