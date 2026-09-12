// Inclusive list of YYYY-MM-DD strings from `from` to `to`.
// UTC throughout: slate dates are calendar dates, not instants, and using
// local time would shift the range by a day west of Greenwich.
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
