-- Raw, immutable API captures: exactly what we fetched, and when.
-- This is what lets you re-derive everything without re-fetching, and
-- backtest using ONLY information available at prediction time.
CREATE TABLE raw_api_responses (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}',
  payload     JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON raw_api_responses (source, endpoint, fetched_at);

CREATE TABLE teams (
  id    INTEGER PRIMARY KEY,          -- MLB team id
  name  TEXT NOT NULL
);

CREATE TABLE players (
  id         INTEGER PRIMARY KEY,     -- MLB person id
  full_name  TEXT NOT NULL,
  position   TEXT,
  bats       TEXT,
  throws     TEXT
);

CREATE TABLE games (
  id            INTEGER PRIMARY KEY,  -- gamePk
  game_date     DATE NOT NULL,
  start_time    TIMESTAMPTZ,
  home_team_id  INTEGER REFERENCES teams(id),
  away_team_id  INTEGER REFERENCES teams(id),
  venue_id      INTEGER,
  venue_name    TEXT,
  status        TEXT NOT NULL
);
CREATE INDEX ON games (game_date);

CREATE TABLE probable_pitchers (
  game_id     INTEGER NOT NULL REFERENCES games(id),
  side        TEXT NOT NULL CHECK (side IN ('home','away')),
  pitcher_id  INTEGER NOT NULL REFERENCES players(id),
  PRIMARY KEY (game_id, side)
);

CREATE TABLE game_conditions (
  game_id    INTEGER PRIMARY KEY REFERENCES games(id),
  condition  TEXT,
  temp_f     NUMERIC,
  wind       TEXT
);

-- Rolled-up per-player-per-game batting line. Projections read from here.
CREATE TABLE player_game_batting (
  game_id   INTEGER NOT NULL REFERENCES games(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  team_id   INTEGER REFERENCES teams(id),
  pa        INTEGER NOT NULL DEFAULT 0,
  ab        INTEGER NOT NULL DEFAULT 0,
  h         INTEGER NOT NULL DEFAULT 0,
  doubles   INTEGER NOT NULL DEFAULT 0,
  triples   INTEGER NOT NULL DEFAULT 0,
  hr        INTEGER NOT NULL DEFAULT 0,
  bb        INTEGER NOT NULL DEFAULT 0,
  so        INTEGER NOT NULL DEFAULT 0,
  tb        INTEGER NOT NULL DEFAULT 0,
  rbi       INTEGER NOT NULL DEFAULT 0,
  r         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX ON player_game_batting (player_id);

CREATE TABLE player_game_pitching (
  game_id   INTEGER NOT NULL REFERENCES games(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  team_id   INTEGER REFERENCES teams(id),
  outs      INTEGER NOT NULL DEFAULT 0,   -- innings pitched * 3
  so        INTEGER NOT NULL DEFAULT 0,
  bb        INTEGER NOT NULL DEFAULT 0,
  h         INTEGER NOT NULL DEFAULT 0,
  er        INTEGER NOT NULL DEFAULT 0,
  bf        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX ON player_game_pitching (player_id);
