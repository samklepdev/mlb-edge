-- Game-outcome model (v0). Deliberately SEPARATE from projections/model_evals:
-- both of those have player_id NOT NULL, and a game outcome has no player.
-- CLAUDE.md requires team win/margin to be "a separate game-outcome model, not
-- a prop-model extension" -- separate tables are what enforces that, and they
-- also keep TEAM_MODEL_VERSION out of any column shared with MODEL_VERSION
-- (max(model_version) is a lexicographic comparison and mixing the two would
-- silently strand rows).
CREATE TABLE IF NOT EXISTS team_projections (
  id            BIGSERIAL PRIMARY KEY,
  game_id       INTEGER NOT NULL REFERENCES games(id),
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  market        TEXT    NOT NULL,           -- 'runs' (per-team run distribution)
  proj_mean     NUMERIC NOT NULL,
  proj_stdev    NUMERIC,
  dist          JSONB,                      -- exact PMF, index = runs
  model_version TEXT    NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, team_id, market, model_version)
);

CREATE TABLE IF NOT EXISTS team_model_evals (
  id            BIGSERIAL PRIMARY KEY,
  game_id       INTEGER NOT NULL REFERENCES games(id),
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  market        TEXT    NOT NULL,           -- 'moneyline' | 'run_line' | 'total'
  line          NUMERIC NOT NULL,
  model_prob    NUMERIC NOT NULL,
  actual        NUMERIC NOT NULL,
  hit           BOOLEAN NOT NULL,
  model_version TEXT    NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, team_id, market, line, model_version)
);

CREATE INDEX IF NOT EXISTS team_model_evals_version_market_idx
  ON team_model_evals (model_version, market);
