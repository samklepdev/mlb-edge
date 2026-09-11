import { query } from '@mlb-edge/db';

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export async function buildPlayerIndex(): Promise<Map<string, number>> {
  const res = await query<{ id: number; full_name: string }>('SELECT id, full_name FROM players');
  const m = new Map<string, number>();
  for (const r of res.rows) m.set(normalize(r.full_name), r.id);
  return m;
}

// Key: "<home>|<away>" (normalized). Odds API and MLB use the same full team names.
export async function buildGameIndex(date: string): Promise<Map<string, number>> {
  const res = await query<{ id: number; home: string; away: string }>(
    `SELECT g.id, th.name AS home, ta.name AS away
     FROM games g
     JOIN teams th ON th.id = g.home_team_id
     JOIN teams ta ON ta.id = g.away_team_id
     WHERE g.game_date = $1`,
    [date],
  );
  const m = new Map<string, number>();
  for (const r of res.rows) m.set(`${normalize(r.home)}|${normalize(r.away)}`, r.id);
  return m;
}
