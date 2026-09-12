import { withTx } from '@mlb-edge/db';
import { MODEL_VERSION, RECENT_DAYS, MIN_PA, MIN_BF, PA_CLAMP, BF_CLAMP, clamp } from './model.js';
import { parkFactor, tempFactor, pitcherTbFactor, teamKFactor } from './factors.js';
import { projectTotalBases, projectHits, projectHomeRuns, projectStrikeouts } from './projectors.js';
import {
  getGamesOn, getLeagueBatting, getLeaguePitching, getBatterHistory, getPitcherHistory,
  getRecentBattersByTeam, getTeamKRates, getProbablePitchers,
} from './data.js';

// Single source of truth for prop identifiers: the CLI whitelist and the type
// are both derived from this, so they cannot drift apart.
export const ALL_PROPS = ['total_bases', 'hits', 'home_runs', 'strikeouts'] as const;
export type PropKind = (typeof ALL_PROPS)[number];

// Props driven by the batter loop (they share rosters, matchup adj, and expPa).
const BATTER_PROPS = ['total_bases', 'hits', 'home_runs'] as const;

interface ProjectionRow {
  playerId: number;
  gameId: number;
  propType: PropKind;
  mean: number;
  stdev: number;
  pmf: number[];
}

function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function runProjections(date: string, props: PropKind[]): Promise<number> {
  const before = date; // strictly earlier games only -- the lookahead guard
  const since = daysBefore(date, RECENT_DAYS);

  const games = await getGamesOn(date);
  if (games.length === 0) return 0;

  const gameIds = games.map((g) => g.id);
  const [pitchers, probables] = await Promise.all([getPitcherHistory(before), getProbablePitchers(gameIds)]);
  const rows: ProjectionRow[] = [];

  const batterProps = BATTER_PROPS.filter((p) => props.includes(p));
  if (batterProps.length > 0) {
    const [league, pLeague, batters, rosters] = await Promise.all([
      getLeagueBatting(before), getLeaguePitching(before), getBatterHistory(before), getRecentBattersByTeam(before, since),
    ]);

    for (const g of games) {
      const sides: Array<{ teamId: number | null; oppSide: 'home' | 'away' }> = [
        { teamId: g.home_team_id, oppSide: 'away' },
        { teamId: g.away_team_id, oppSide: 'home' },
      ];
      for (const { teamId, oppSide } of sides) {
        if (teamId == null) continue;
        const roster = rosters.get(teamId) ?? [];
        const oppId = probables.get(g.id)?.[oppSide];
        const opp = oppId ? pitchers.get(oppId) : undefined;
        const pFactor = opp && opp.bf > 0 ? pitcherTbFactor(opp.h / opp.bf, pLeague.hPerBf) : 1;
        const adj = pFactor * parkFactor(g.venue_name) * tempFactor(g.temp_f);

        for (const pid of roster) {
          const hist = batters.get(pid);
          if (!hist || hist.pa < MIN_PA) continue;
          const expPa = clamp(hist.pa / Math.max(1, hist.games), PA_CLAMP[0], PA_CLAMP[1]);
          const a = { hist, league, expPa, adj };
          for (const prop of batterProps) {
            const { mean, stdev, pmf } =
              prop === 'total_bases' ? projectTotalBases(a)
              : prop === 'hits' ? projectHits(a)
              : prop === 'home_runs' ? projectHomeRuns(a)
              : ((): never => {
                  throw new Error(`unhandled batter prop: ${prop satisfies never}`);
                })();
            rows.push({ playerId: pid, gameId: g.id, propType: prop, mean, stdev, pmf });
          }
        }
      }
    }
  }

  if (props.includes('strikeouts')) {
    const [pLeague, league, teamK] = await Promise.all([
      getLeaguePitching(before), getLeagueBatting(before), getTeamKRates(before, since),
    ]);

    for (const g of games) {
      const pk = probables.get(g.id);
      if (!pk) continue;
      const starters: Array<{ side: 'home' | 'away'; oppTeam: number | null }> = [
        { side: 'home', oppTeam: g.away_team_id },
        { side: 'away', oppTeam: g.home_team_id },
      ];
      for (const { side, oppTeam } of starters) {
        const pid = pk[side];
        if (!pid) continue;
        const hist = pitchers.get(pid);
        // Same threshold, two samples: the strikeout rate still draws on all
        // appearances (hist.bf), while the workload draws on starts only
        // (hist.startBf) -- each must independently clear MIN_BF before we
        // trust it, or a reliever with heavy relief volume but a thin start
        // sample could sail through on the rate gate and get a workload
        // estimate from a couple of short outings. This also subsumes the
        // old zero-starts check: hist.startBf >= MIN_BF (30) is impossible
        // with zero starts, so hist.starts is guaranteed > 0 below and the
        // division stays safe -- do not add back a separate starts === 0 guard.
        if (!hist || hist.bf < MIN_BF || hist.startBf < MIN_BF) continue;
        const expBf = clamp(hist.startBf / hist.starts, BF_CLAMP[0], BF_CLAMP[1]);
        const tk = oppTeam == null ? undefined : teamK.get(oppTeam);
        const oppKFactor = tk && tk.pa > 0 ? teamKFactor(tk.so / tk.pa, league.soPerPa) : 1;
        const { mean, stdev, pmf } = projectStrikeouts({ hist, leagueSoPerBf: pLeague.soPerBf, expBf, oppKFactor });
        rows.push({ playerId: pid, gameId: g.id, propType: 'strikeouts', mean, stdev, pmf });
      }
    }
  }

  await upsertProjections(rows, gameIds, props);
  return rows.length;
}

async function upsertProjections(
  rows: ProjectionRow[],
  gameIds: number[],
  props: PropKind[],
): Promise<void> {
  if (gameIds.length === 0) return;
  await withTx(async (c) => {
    // Idempotent: replace this slate's projections for the requested props.
    // Upserting alone leaves orphans -- rows for players who no longer qualify
    // (say, MIN_PA against less history) survive under the same model_version
    // and still feed the backtest. Version filtering catches drift ACROSS
    // versions, never within one.
    //
    // Scoping the delete to `props` is load-bearing: re-projecting `hits` alone
    // must not wipe this slate's `strikeouts`.
    await c.query(
      'DELETE FROM projections WHERE game_id = ANY($1) AND model_version = $2 AND prop_type = ANY($3)',
      [gameIds, MODEL_VERSION, props],
    );
    for (const r of rows) {
      await c.query(
        `INSERT INTO projections (player_id, game_id, prop_type, proj_mean, proj_stdev, model_version, dist)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (player_id, game_id, prop_type, model_version)
         DO UPDATE SET proj_mean = EXCLUDED.proj_mean, proj_stdev = EXCLUDED.proj_stdev, dist = EXCLUDED.dist, created_at = now()`,
        [r.playerId, r.gameId, r.propType, r.mean.toFixed(4), r.stdev.toFixed(4), MODEL_VERSION, JSON.stringify(r.pmf)],
      );
    }
  });
}
