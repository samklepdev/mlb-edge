import { clvByProp, clvExcludedCount } from '@mlb-edge/db';

export async function clvReport(): Promise<void> {
  const rows = await clvByProp();
  if (rows.length === 0) {
    console.log(
      'No settled picks with closing lines yet.\n' +
        'Log picks (Phase 3) and capture closing lines (Phase 4), then re-run.',
    );
    return;
  }
  console.log('prop_type            n     avg_clv   hit_rate');
  for (const r of rows) {
    const clv = r.avgClv == null ? '  n/a ' : r.avgClv.toFixed(3).padStart(6);
    const hr = r.hitRate == null ? ' n/a ' : r.hitRate.toFixed(3);
    console.log(`${r.propType.padEnd(20)} ${String(r.n).padStart(4)}  ${clv}    ${hr}`);
  }
  const excluded = await clvExcludedCount();
  if (excluded > 0) {
    console.log(`${excluded} row(s) excluded: closing line captured at or after first pitch (not a closing price)`);
  }
}
