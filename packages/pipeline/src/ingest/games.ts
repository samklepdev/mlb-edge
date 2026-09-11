import { getBoxscore, getLiveFeed, type StatMap } from '../clients/mlbStatsApi.js';
import { query, withTx } from '@mlb-edge/db';

const num = (v: number | string | undefined, d = 0): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? (n as number) : d;
};

// "6.1" innings -> 19 outs
const ipToOuts = (ip: number | string | undefined): number => {
  if (ip == null) return 0;
  const [whole, frac = '0'] = String(ip).split('.');
  return num(whole) * 3 + num(frac);
};

// Pull boxscores for every FINAL game already stored for a date.
export async function ingestFinalGames(date: string): Promise<number> {
  const rows = (
    await query<{ id: number; status: string }>(
      'SELECT id, status FROM games WHERE game_date = $1',
      [date],
    )
  ).rows;
  const finals = rows.filter((r) => /final|completed|game over/i.test(r.status));
  for (const g of finals) await ingestBoxscore(g.id);
  return finals.length;
}

export async function ingestBoxscore(gamePk: number): Promise<void> {
  const box = await getBoxscore(gamePk);
  const feed = await getLiveFeed(gamePk).catch(() => null);

  await query(
    `INSERT INTO raw_api_responses(source, endpoint, params, payload)
     VALUES ('mlb', 'boxscore', $1, $2)`,
    [JSON.stringify({ gamePk }), JSON.stringify(box)],
  );

  await withTx(async (c) => {
    const w = feed?.gameData?.weather;
    if (w) {
      await c.query(
        `INSERT INTO game_conditions(game_id, condition, temp_f, wind)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (game_id) DO UPDATE SET
           condition = EXCLUDED.condition, temp_f = EXCLUDED.temp_f, wind = EXCLUDED.wind`,
        [gamePk, w.condition ?? null, w.temp ? num(w.temp) : null, w.wind ?? null],
      );
    }

    for (const side of [box.teams.home, box.teams.away]) {
      for (const key of Object.keys(side.players)) {
        const p = side.players[key];
        await c.query(
          `INSERT INTO players(id, full_name, position) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET
             full_name = EXCLUDED.full_name, position = EXCLUDED.position`,
          [p.person.id, p.person.fullName, p.position?.abbreviation ?? null],
        );

        const b: StatMap | undefined = p.stats?.batting;
        if (b && Object.keys(b).length > 0) {
          const h = num(b.hits);
          const d2 = num(b.doubles);
          const t3 = num(b.triples);
          const hr = num(b.homeRuns);
          // Total bases sometimes absent; derive it: TB = h + 2B + 2*3B + 3*HR
          const tb = b.totalBases != null ? num(b.totalBases) : h + d2 + 2 * t3 + 3 * hr;
          await c.query(
            `INSERT INTO player_game_batting
               (game_id, player_id, team_id, pa, ab, h, doubles, triples, hr, bb, so, tb, rbi, r)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (game_id, player_id) DO UPDATE SET
               pa=EXCLUDED.pa, ab=EXCLUDED.ab, h=EXCLUDED.h, doubles=EXCLUDED.doubles,
               triples=EXCLUDED.triples, hr=EXCLUDED.hr, bb=EXCLUDED.bb, so=EXCLUDED.so,
               tb=EXCLUDED.tb, rbi=EXCLUDED.rbi, r=EXCLUDED.r`,
            [
              gamePk, p.person.id, side.team.id,
              num(b.plateAppearances), num(b.atBats), h, d2, t3, hr,
              num(b.baseOnBalls), num(b.strikeOuts), tb, num(b.rbi), num(b.runs),
            ],
          );
        }

        const pit: StatMap | undefined = p.stats?.pitching;
        if (pit && Object.keys(pit).length > 0) {
          await c.query(
            `INSERT INTO player_game_pitching
               (game_id, player_id, team_id, outs, so, bb, h, er, bf)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (game_id, player_id) DO UPDATE SET
               outs=EXCLUDED.outs, so=EXCLUDED.so, bb=EXCLUDED.bb,
               h=EXCLUDED.h, er=EXCLUDED.er, bf=EXCLUDED.bf`,
            [
              gamePk, p.person.id, side.team.id,
              ipToOuts(pit.inningsPitched), num(pit.strikeOuts), num(pit.baseOnBalls),
              num(pit.hits), num(pit.earnedRuns), num(pit.battersFaced),
            ],
          );
        }
      }
    }
  });
}
