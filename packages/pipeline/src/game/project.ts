import { query, withTx } from '@mlb-edge/db';
import { teamOutcomes } from './outcomes.js';
import { runsPmf } from './distribution.js';
import {
  TEAM_MODEL_VERSION, K_G, RUNS_DISPERSION, LEAGUE_RUNS,
  LEAGUE_RUNS_HOME, LEAGUE_RUNS_AWAY, LEAGUE_ER_PER_BF, STARTER_OUT_SHARE, PARK_FACTOR,
} from './model.js';
import { K_BF, MIN_BF } from '../project/model.js';

interface TeamRates { scoredPerGame: number; allowedPerGame: number; games: number }

// Shrink a team's own rate toward the league mean by K_G pseudo-games.
function shrink(own: number, games: number, league: number): number {
  return (own * games + league * K_G) / (games + K_G);
}

// Starter's run-suppression multiplier, weighted by the share of a game a
// starter actually covers, with the rest at league-average bullpen. Uses the
// STARTS-ONLY sample: a reliever's rate does not describe him as a starter --
// the same reasoning behind the strikeout workload fix.
function starterAdj(erPerBf: number | null): number {
  if (erPerBf == null) return 1.0;
  return STARTER_OUT_SHARE * (erPerBf / LEAGUE_ER_PER_BF) + (1 - STARTER_OUT_SHARE);
}

export interface TeamProjectionResult { rows: number; starterFallbacks: number }

export async function runTeamProjections(date: string): Promise<TeamProjectionResult> {
  const games = (
    await query<{ id: number; home_team_id: number; away_team_id: number }>(
      `SELECT id, home_team_id, away_team_id FROM games
       WHERE game_date = $1 AND NOT is_synthetic
         AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL`,
      [date],
    )
  ).rows;
  if (games.length === 0) return { rows: 0, starterFallbacks: 0 };

  // History strictly before the slate -- the lookahead guard.
  const hist = await teamOutcomes(date);
  const agg = new Map<number, TeamRates>();
  for (const o of hist) {
    const t = agg.get(o.teamId) ?? { scoredPerGame: 0, allowedPerGame: 0, games: 0 };
    t.scoredPerGame += o.runsFor;
    t.allowedPerGame += o.runsAgainst;
    t.games += 1;
    agg.set(o.teamId, t);
  }

  // Probable starters and their starts-only ER/BF, before this date.
  // probable_pitchers has no team_id column -- it records `side`
  // ('home'/'away'), so team_id is derived via games.home_team_id /
  // away_team_id. The starts-only subquery (EXISTS against
  // probable_pitchers) and the lookahead guard (g2.game_date < $1) are
  // otherwise unchanged from the spec.
  const starters = (
    await query<{ game_id: number; team_id: number; er_per_bf: number | null }>(
      `SELECT pp.game_id,
              (CASE WHEN pp.side = 'home' THEN g.home_team_id ELSE g.away_team_id END) AS team_id,
              (SELECT sum(p.er)::float8 / NULLIF(sum(p.bf), 0)
               FROM player_game_pitching p
               JOIN games g2 ON g2.id = p.game_id
               WHERE p.player_id = pp.pitcher_id AND g2.game_date < $1
                 AND EXISTS (SELECT 1 FROM probable_pitchers pp2
                             WHERE pp2.game_id = p.game_id AND pp2.pitcher_id = p.player_id)
               HAVING sum(p.bf) >= $2) AS er_per_bf
       FROM probable_pitchers pp
       JOIN games g ON g.id = pp.game_id
       WHERE g.game_date = $1`,
      [date, MIN_BF],
    )
  ).rows;
  const starterBy = new Map<string, number | null>();
  for (const s of starters) starterBy.set(`${s.game_id}:${s.team_id}`, s.er_per_bf);

  const league = LEAGUE_RUNS;
  let starterFallbacks = 0;
  const rows: { gameId: number; teamId: number; mean: number; pmf: number[] }[] = [];

  for (const g of games) {
    for (const [teamId, oppId, isHome] of [
      [g.home_team_id, g.away_team_id, true] as const,
      [g.away_team_id, g.home_team_id, false] as const,
    ]) {
      const own = agg.get(teamId);
      const opp = agg.get(oppId);
      const offense = own && own.games > 0
        ? shrink(own.scoredPerGame / own.games, own.games, league) / league : 1;
      const defense = opp && opp.games > 0
        ? shrink(opp.allowedPerGame / opp.games, opp.games, league) / league : 1;

      // The OPPONENT's starter suppresses THIS team's runs.
      const oppStarter = starterBy.get(`${g.id}:${oppId}`) ?? null;
      if (oppStarter == null) starterFallbacks++;
      const adj = starterAdj(oppStarter);

      const homeField = (isHome ? LEAGUE_RUNS_HOME : LEAGUE_RUNS_AWAY) / league;
      const mean = league * offense * defense * adj * homeField * PARK_FACTOR;
      rows.push({ gameId: g.id, teamId, mean, pmf: runsPmf(mean, RUNS_DISPERSION) });
    }
  }

  await withTx(async (c) => {
    // Idempotent: replace this slate's team projections for this version.
    await c.query(
      'DELETE FROM team_projections WHERE game_id = ANY($1) AND model_version = $2',
      [games.map((g) => g.id), TEAM_MODEL_VERSION],
    );
    for (const r of rows) {
      const stdev = Math.sqrt(r.mean + (r.mean * r.mean) / RUNS_DISPERSION);
      await c.query(
        `INSERT INTO team_projections (game_id, team_id, market, proj_mean, proj_stdev, dist, model_version)
         VALUES ($1, $2, 'runs', $3, $4, $5, $6)`,
        [r.gameId, r.teamId, r.mean.toFixed(4), stdev.toFixed(4), JSON.stringify(r.pmf), TEAM_MODEL_VERSION],
      );
    }
  });

  return { rows: rows.length, starterFallbacks };
}
