-- Synthetic fixtures (the demo seed) must never reach RESULT aggregates --
-- the scorecard, CLV, or pick calibration. Before this flag, every settled
-- pick in the database was demo data with deliberately positive edges, and
-- the dashboard reported it as though the model beat the market.
--
-- A flag rather than filtering on the magic id or the 2099 sentinel date:
-- it is greppable, self-documenting, and survives either of those changing.
ALTER TABLE games ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false;
UPDATE games SET is_synthetic = true WHERE id = 999999;
