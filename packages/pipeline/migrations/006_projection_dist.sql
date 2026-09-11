-- Exact game-level probability mass function for the projection, so pricing can
-- compute P(over line) by summation instead of a normal approximation.
ALTER TABLE projections ADD COLUMN dist JSONB;
