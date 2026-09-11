-- One projection per player/game/prop per model version, so re-running
-- `project` updates in place instead of duplicating.
ALTER TABLE projections
  ADD CONSTRAINT projections_unique_key UNIQUE (player_id, game_id, prop_type, model_version);
