import { getSchedule } from '../clients/mlbStatsApi.js';
import { query, withTx } from '@mlb-edge/db';

// Pull a day's schedule: upsert teams + games, capture probable pitchers.
export async function ingestSchedule(date: string): Promise<number> {
  const data = await getSchedule(date);

  await query(
    `INSERT INTO raw_api_responses(source, endpoint, params, payload)
     VALUES ('mlb', 'schedule', $1, $2)`,
    [JSON.stringify({ date }), JSON.stringify(data)],
  );

  let count = 0;
  for (const d of data.dates ?? []) {
    for (const g of d.games ?? []) {
      await withTx(async (c) => {
        for (const side of [g.teams.home, g.teams.away]) {
          await c.query(
            `INSERT INTO teams(id, name) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
            [side.team.id, side.team.name],
          );
        }
        await c.query(
          `INSERT INTO games(id, game_date, start_time, home_team_id, away_team_id,
                             venue_id, venue_name, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, start_time = EXCLUDED.start_time`,
          [
            g.gamePk, d.date, g.gameDate,
            g.teams.home.team.id, g.teams.away.team.id,
            g.venue?.id ?? null, g.venue?.name ?? null,
            g.status.detailedState,
          ],
        );
        const sides = [
          ['home', g.teams.home] as const,
          ['away', g.teams.away] as const,
        ];
        for (const [sideName, side] of sides) {
          const pp = side.probablePitcher;
          if (!pp) continue;
          await c.query(
            `INSERT INTO players(id, full_name) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name`,
            [pp.id, pp.fullName],
          );
          await c.query(
            `INSERT INTO probable_pitchers(game_id, side, pitcher_id) VALUES ($1, $2, $3)
             ON CONFLICT (game_id, side) DO UPDATE SET pitcher_id = EXCLUDED.pitcher_id`,
            [g.gamePk, sideName, pp.id],
          );
        }
      });
      count++;
    }
  }
  return count;
}
