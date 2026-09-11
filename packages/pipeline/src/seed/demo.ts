import { withTx } from '@mlb-edge/db';

// Deterministic PRNG so the demo is reproducible.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROPS = ['total_bases', 'hits', 'strikeouts', 'runs'] as const;
const DEMO_GAME = 999999;
const DEMO_TEAM = 99999;
const N = 160;

// Inserts SYNTHETIC, clearly-fake settled picks so the dashboard has something
// to render before you have real picks. The data is deliberately a touch
// overconfident (reality slightly below the model) so the calibration gap is
// visible -- that is the lesson, not a bug. Idempotent: re-running replaces it.
export async function seedDemo(): Promise<number> {
  const rng = mulberry32(42);

  return withTx(async (c) => {
    await c.query(
      `INSERT INTO teams(id, name) VALUES ($1, 'DEMO Synthetic')
       ON CONFLICT (id) DO NOTHING`,
      [DEMO_TEAM],
    );
    await c.query(
      `INSERT INTO games(id, game_date, home_team_id, away_team_id, status)
       VALUES ($1, DATE '2099-01-01', $2, $2, 'Final')
       ON CONFLICT (id) DO UPDATE SET game_date = DATE '2099-01-01'`,
      [DEMO_GAME, DEMO_TEAM],
    );
    for (let i = 0; i < 12; i++) {
      await c.query(
        `INSERT INTO players(id, full_name) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [900000 + i, `Demo Player ${i + 1}`],
      );
    }
    await c.query('DELETE FROM picks WHERE game_id = $1', [DEMO_GAME]);

    for (let i = 0; i < N; i++) {
      const prop = PROPS[Math.floor(rng() * PROPS.length)];
      const player = 900000 + Math.floor(rng() * 12);
      const pickProb = 0.5 + rng() * 0.22;            // model P(win): 0.50..0.72
      const trueProb = pickProb - (0.02 + rng() * 0.06); // reality a bit lower
      const won = rng() < trueProb;
      const clv = 0.01 + (rng() - 0.35) * 0.05;        // small, mostly positive
      const line = 1.5 + Math.floor(rng() * 6) * 0.5;
      await c.query(
        `INSERT INTO picks
           (player_id, game_id, prop_type, side, pick_prob, pick_line, pick_odds,
            edge_pct, close_line, close_odds, clv_pct, result, won)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          player, DEMO_GAME, prop, rng() < 0.5 ? 'over' : 'under',
          pickProb.toFixed(4), line, -119,
          (pickProb - 0.52).toFixed(4), line, -110, clv.toFixed(4),
          won ? 'win' : 'loss', won,
        ],
      );
    }
    return N;
  });
}
