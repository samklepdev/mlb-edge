-- Plate-appearance-level platoon splits: a batter's game line broken out by the
-- handedness of the pitcher actually faced.
--
-- This data was already being downloaded and discarded. `ingestBoxscore` calls
-- /api/v1.1/game/{pk}/feed/live for every game and reads exactly one field off
-- it (gameData.weather), while the same payload carries liveData.plays.allPlays
-- with matchup.batSide and matchup.pitchHand on every plate appearance.
--
-- The alternative -- attributing a batter's whole game line to the opposing
-- STARTER's hand -- was rejected. A starter faces only ~55-65% of a game's
-- plate appearances, and the bullpen remainder is not hand-neutral: managers
-- deploy same-handed relievers deliberately, so the contamination correlates
-- with the very variable being measured. probable_pitchers also covers just
-- 2,396 of 4,782 games, so half of history would need the starter itself
-- proxied by max(bf). PA-level data removes all of that.
CREATE TABLE IF NOT EXISTS player_game_platoon (
  game_id    INTEGER NOT NULL REFERENCES games(id),
  player_id  INTEGER NOT NULL REFERENCES players(id),
  -- Hand of the pitcher faced in these plate appearances.
  pitch_hand TEXT    NOT NULL CHECK (pitch_hand IN ('L', 'R')),
  -- Side the batter ACTUALLY hit from. In the key, not derived from
  -- players.bats, because a switch hitter legitimately produces two rows for
  -- one game -- and players.bats reports them as 'S', which is not a side.
  bat_side   TEXT    NOT NULL CHECK (bat_side IN ('L', 'R')),
  pa         INTEGER NOT NULL DEFAULT 0,
  singles    INTEGER NOT NULL DEFAULT 0,
  doubles    INTEGER NOT NULL DEFAULT 0,
  triples    INTEGER NOT NULL DEFAULT 0,
  hr         INTEGER NOT NULL DEFAULT 0,
  so         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, player_id, pitch_hand, bat_side)
);

CREATE INDEX IF NOT EXISTS player_game_platoon_player_idx
  ON player_game_platoon (player_id, pitch_hand);
