-- Backtest table: for a historical projection, evaluate the model's P(over line)
-- at standard lines against the actual outcome. This measures whether the model
-- is CALIBRATED against reality, independent of any market. No odds required.
CREATE TABLE model_evals (
  id            BIGSERIAL PRIMARY KEY,
  player_id     INTEGER NOT NULL REFERENCES players(id),
  game_id       INTEGER NOT NULL REFERENCES games(id),
  prop_type     TEXT NOT NULL,
  line          NUMERIC NOT NULL,
  model_prob    NUMERIC NOT NULL,   -- model P(actual > line)
  actual        NUMERIC NOT NULL,   -- realized stat
  hit           BOOLEAN NOT NULL,   -- actual > line
  model_version TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, game_id, prop_type, line, model_version)
);
CREATE INDEX ON model_evals (model_version, prop_type);
