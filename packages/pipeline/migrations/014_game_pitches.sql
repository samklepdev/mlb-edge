-- One row per pitch.
--
-- This is the table that unlocks the whole Statcast-shaped half of the feature
-- list in one ingest: pitch-type splits, whiff and CSW rates, chase rate, exit
-- velocity, launch angle. All of it is in liveData.plays.allPlays[].playEvents
-- of the feed this project ALREADY downloads for every game (the same payload
-- the platoon capture reads), and none of it has ever been stored.
--
-- Roughly 282 pitches per game over ~2,400 games, so expect ~677k rows.
--
-- Deliberately per-pitch rather than pre-aggregated by (player, pitch type).
-- Aggregates cannot be un-summed: exit velocity, plate location and count state
-- are all lost, and the point of this table is to let questions be asked that
-- were not anticipated when it was written.
CREATE TABLE IF NOT EXISTS game_pitches (
  game_id      INTEGER  NOT NULL REFERENCES games(id),
  -- (at_bat_index, pitch_number) is the feed's own addressing and is stable
  -- across re-ingests, which is what makes this idempotent.
  at_bat_index SMALLINT NOT NULL,
  pitch_number SMALLINT NOT NULL,

  batter_id    INTEGER  NOT NULL REFERENCES players(id),
  pitcher_id   INTEGER  NOT NULL REFERENCES players(id),
  bat_side     TEXT,
  pitch_hand   TEXT,

  -- NULL for a handful of pitches the feed does not classify; kept rather than
  -- guessed, so "unclassified" stays visible in any split.
  pitch_type   TEXT,
  call_code    TEXT     NOT NULL,

  is_strike    BOOLEAN  NOT NULL,
  in_play      BOOLEAN  NOT NULL,
  is_swing     BOOLEAN  NOT NULL,
  is_whiff     BOOLEAN  NOT NULL,
  -- Zones 1-9 are inside the strike zone, 11-14 outside. `in_zone` is derived
  -- from that so chase rate does not have to re-encode the convention.
  zone         SMALLINT,
  in_zone      BOOLEAN,

  start_speed  NUMERIC(4,1),
  plate_x      NUMERIC(5,2),
  plate_z      NUMERIC(5,2),

  -- Present only on batted balls (~17% of pitches).
  launch_speed NUMERIC(4,1),
  launch_angle NUMERIC(5,1),
  hit_distance SMALLINT,
  trajectory   TEXT,

  -- Count BEFORE this pitch, so two-strike and ahead/behind splits are possible.
  balls        SMALLINT,
  strikes      SMALLINT,

  PRIMARY KEY (game_id, at_bat_index, pitch_number)
);

CREATE INDEX IF NOT EXISTS game_pitches_batter_idx  ON game_pitches (batter_id, pitch_type);
CREATE INDEX IF NOT EXISTS game_pitches_pitcher_idx ON game_pitches (pitcher_id, pitch_type);
