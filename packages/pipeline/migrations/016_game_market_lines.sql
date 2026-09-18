-- Game-level market lines: run line (spread) and total runs.
--
-- Separate from market_lines rather than another prop_type in it. That table is
-- keyed by player_id NOT NULL and every reader assumes a player prop -- pricing,
-- settlement, CLV and the explorer all join through it. A game line has no
-- player, so squeezing it in would mean a nullable player_id and a null check in
-- every one of those readers.
--
-- Two shapes in one table, distinguished by `market`:
--   run_line  -- one row per TEAM. `line` is that team's handicap (-1.5 / +1.5)
--               and `side` is 'home' or 'away'.
--   total     -- one row per SIDE of the same number. `line` is the total and
--               `side` is 'over' or 'under'.
-- Keeping both in one table means one fetch, one guard, and one place to look.
CREATE TABLE IF NOT EXISTS game_market_lines (
  game_id    INTEGER NOT NULL REFERENCES games(id),
  source     TEXT    NOT NULL,
  market     TEXT    NOT NULL CHECK (market IN ('run_line', 'total')),
  side       TEXT    NOT NULL CHECK (side IN ('home', 'away', 'over', 'under')),
  line       NUMERIC NOT NULL,
  odds       INTEGER NOT NULL,
  is_sharp   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Same guard the player-prop side learned the hard way: a quote fetched at or
  -- after first pitch is a LIVE in-game price, not a pre-game one, and readers
  -- must be able to exclude it. Recording when it was taken is what makes that
  -- possible at all.
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (game_id, source, market, side, fetched_at)
);

CREATE INDEX IF NOT EXISTS game_market_lines_game_idx
  ON game_market_lines (game_id, market, fetched_at DESC);
