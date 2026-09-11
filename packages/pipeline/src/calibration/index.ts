import { calibrationBuckets } from '@mlb-edge/db';

export async function calibrationReport(): Promise<void> {
  const buckets = await calibrationBuckets(10);
  if (buckets.length === 0) {
    console.log('No settled picks yet -- project, log picks, settle results, then re-run.');
    return;
  }
  console.log('bucket       n    predicted  actual   gap');
  for (const b of buckets) {
    console.log(
      `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(5)}    ` +
        `${b.predicted.toFixed(3)}    ${b.actual.toFixed(3)}   ` +
        `${b.gap >= 0 ? '+' : ''}${b.gap.toFixed(3)}`,
    );
  }
  console.log('\nWant: actual ~ predicted in every populated bucket (gap near 0).');
}
