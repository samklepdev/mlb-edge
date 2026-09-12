// Inclusive list of YYYY-MM-DD strings from `from` to `to`.
// UTC throughout: slate dates are calendar dates, not instants, and using
// local time would shift the range by a day west of Greenwich.
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date "${from}" (expected YYYY-MM-DD)`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) throw new Error(`invalid date "${to}" (expected YYYY-MM-DD)`);
  if (d > end) throw new Error(`--from ${from} is after --to ${to}`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
