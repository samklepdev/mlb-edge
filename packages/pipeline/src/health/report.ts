import { query } from '@mlb-edge/db';
import { K_PA } from '../project/model.js';

// Own-weight: how much of a projected rate comes from the player's own record
// rather than the league prior. shrinkRate weights own data at n/(n+K), so this
// hits 0.5 exactly at n = K_PA -- the point where a batter's own sample finally
// carries as much weight as the prior.
function ownWeight(pa: number): number {
  return pa / (pa + K_PA);
}

// Collapse a sorted date list into contiguous runs, so gaps are visible as
// separate ranges instead of hiding inside a single min..max span.
function islands(dates: string[]): Array<{ from: string; to: string; days: number }> {
  const out: Array<{ from: string; to: string; days: number }> = [];
  for (const d of dates) {
    const last = out[out.length - 1];
    if (last) {
      const next = new Date(`${last.to}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      if (next.toISOString().slice(0, 10) === d) {
        last.to = d;
        last.days++;
        continue;
      }
    }
    out.push({ from: d, to: d, days: 1 });
  }
  return out;
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86400000);
}

export async function healthReport(): Promise<void> {
  const dateRows = (
    await query<{ game_date: string }>(
      `SELECT DISTINCT game_date::text AS game_date FROM games
       WHERE status ILIKE '%final%' AND NOT is_synthetic
       ORDER BY game_date`,
    )
  ).rows;

  console.log('data health\n===========\n');

  if (dateRows.length === 0) {
    console.log('No final games ingested yet. Run:');
    console.log('  npm run ingest -- schedule --from <d> --to <d>');
    console.log('  npm run ingest -- games    --from <d> --to <d>');
    return;
  }

  const runs = islands(dateRows.map((r) => r.game_date));
  console.log(`date coverage: ${dateRows.length} date(s) in ${runs.length} block(s)`);
  runs.forEach((r, i) => {
    console.log(`  ${r.from} -> ${r.to}  (${r.days} day${r.days === 1 ? '' : 's'})`);
    const next = runs[i + 1];
    if (next) console.log(`     ... gap of ${daysBetween(r.to, next.from) - 1} days ...`);
  });
  if (runs.length > 1) {
    console.log('\n  Gaps matter: getBatterHistory pools every prior game with no recency');
    console.log('  bound, so history from across a gap is weighted like last week\'s.');
  }

  const pa = (
    await query<{ median: string | null; max: string | null; batters: string }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pa) AS median,
              max(pa) AS max,
              count(*) AS batters
       FROM (SELECT b.player_id, sum(b.pa) AS pa
             FROM player_game_batting b JOIN games g ON g.id = b.game_id
             WHERE NOT g.is_synthetic
             GROUP BY b.player_id HAVING sum(b.pa) >= 20) t`,
    )
  ).rows[0];

  const medianPa = pa?.median == null ? 0 : Number(pa.median);
  const maxPa = pa?.max == null ? 0 : Number(pa.max);
  const w = ownWeight(medianPa);

  console.log(`\nbatter sample vs shrinkage (K_PA = ${K_PA})`);
  console.log(`  batters with >= 20 PA : ${Number(pa?.batters ?? 0)}`);
  console.log(`  median PA             : ${medianPa.toFixed(0)}`);
  console.log(`  max PA                : ${maxPa.toFixed(0)}`);
  console.log(`  own-weight at median  : ${(w * 100).toFixed(0)}%  (league prior supplies the other ${((1 - w) * 100).toFixed(0)}%)`);

  const evals = (
    await query<{ prop_type: string; n: string }>(
      `SELECT me.prop_type, count(*) AS n
       FROM model_evals me
       JOIN games g ON g.id = me.game_id
       WHERE me.model_version = (SELECT max(model_version) FROM model_evals) AND NOT g.is_synthetic
       GROUP BY 1 ORDER BY 2 DESC`,
    )
  ).rows;
  console.log('\nmodel evaluations by prop');
  if (evals.length === 0) console.log('  none yet -- run: npm run backfill -- --from <d> --to <d>');
  for (const e of evals) console.log(`  ${e.prop_type.padEnd(14)} ${Number(e.n).toLocaleString()}`);

  console.log('\nverdict');
  if (w < 0.33) {
    console.log('  MOSTLY LEAGUE PRIOR. Projections are largely the league average, not');
    console.log('  this player. Good calibration here is expected by construction -- it is');
    console.log('  not yet evidence the model knows anything player-specific.');
    console.log(`  Ingest more history: own-weight reaches 50% at ${K_PA} PA per batter.`);
  } else if (w < 0.5) {
    console.log('  PARTIALLY PLAYER-SPECIFIC. The prior still outweighs a typical');
    console.log('  batter\'s own record. Read calibration results with caution.');
  } else {
    console.log('  PLAYER-SPECIFIC. A typical batter\'s own sample now outweighs the');
    console.log('  league prior, so calibration results reflect the model, not the prior.');
  }
}
