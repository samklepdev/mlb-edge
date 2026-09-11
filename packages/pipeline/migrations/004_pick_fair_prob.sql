-- De-vigged market probability of the taken side, captured at pick time and at
-- close. CLV is close_fair_prob - pick_fair_prob: positive means the market
-- moved toward our side after we bet -- the leading indicator that an edge is real.
ALTER TABLE picks
  ADD COLUMN pick_fair_prob  NUMERIC,
  ADD COLUMN close_fair_prob NUMERIC;
