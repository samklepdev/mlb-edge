-- Your model's output: a DISTRIBUTION, not a point estimate.
-- Store mean + stdev (or a full pmf later), the model version, and the
-- creation time, so backtests can't cheat with information from the future.
CREATE TABLE projections (
  id            BIGSERIAL PRIMARY KEY,
  player_id     INTEGER NOT NULL REFERENCES players(id),
  game_id       INTEGER NOT NULL REFERENCES games(id),
  prop_type     TEXT NOT NULL,          -- 'total_bases','hits','strikeouts',...
  proj_mean     NUMERIC NOT NULL,
  proj_stdev    NUMERIC,
  model_version TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON projections (player_id, game_id, prop_type);

-- Market lines from any source. is_sharp flags a reference book whose closing
-- line you trust as "truth" for de-vigging and CLV.
CREATE TABLE market_lines (
  id          BIGSERIAL PRIMARY KEY,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  game_id     INTEGER NOT NULL REFERENCES games(id),
  prop_type   TEXT NOT NULL,
  line        NUMERIC NOT NULL,
  over_odds   INTEGER,                  -- American odds
  under_odds  INTEGER,
  source      TEXT NOT NULL,            -- 'prizepicks','pinnacle',...
  is_sharp    BOOLEAN NOT NULL DEFAULT false,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON market_lines (player_id, game_id, prop_type, fetched_at);

-- The heart of CLV + calibration. Every pick you'd actually make is logged
-- here with the probability your model assigned and the line you took, BEFORE
-- the game. Later you fill in the closing line (CLV) and the result.
CREATE TABLE picks (
  id           BIGSERIAL PRIMARY KEY,
  player_id    INTEGER NOT NULL REFERENCES players(id),
  game_id      INTEGER NOT NULL REFERENCES games(id),
  prop_type    TEXT NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('over','under')),
  pick_prob    NUMERIC NOT NULL,        -- model P(this side wins), 0..1
  pick_line    NUMERIC NOT NULL,
  pick_odds    INTEGER,
  edge_pct     NUMERIC,                 -- pick_prob - de-vigged market prob
  close_line   NUMERIC,                 -- filled at game time
  close_odds   INTEGER,
  clv_pct      NUMERIC,                 -- signed line movement toward the pick
  result       TEXT CHECK (result IN ('win','loss','push')),
  won          BOOLEAN,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON picks (prop_type);
CREATE INDEX ON picks (created_at);
