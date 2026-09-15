-- Line shopping: where the pick would actually be bet, and what that is worth.
--
-- Pricing has always used ONE book per prop -- the sharp one (Pinnacle), via
-- loadStoredLines' DISTINCT ON ... ORDER BY is_sharp DESC. That is right for
-- estimating the TRUE probability, because the sharp book's de-vigged number is
-- the best available estimate of it. It is wrong for estimating what a bet is
-- worth, because the sharp book is usually the WORST price a bettor can get:
-- tight lines are the whole reason it is the reference.
--
-- So the two roles are split, and this records the second one. `pick_fair_prob`
-- and `edge_pct` keep their existing meaning -- probability vs the sharp book's
-- de-vigged line -- so every historical pick stays comparable. These columns add
-- the execution side: the best price across the books actually stored, and the
-- expected value there.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS best_book TEXT;
ALTER TABLE picks ADD COLUMN IF NOT EXISTS best_odds INTEGER;
-- A book can quote a different LINE, not just a different price, so the line has
-- to be stored alongside: without it `best_odds` is uninterpretable.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS best_line NUMERIC;
-- EV per 1 unit staked at (best_line, best_odds), under the model's probability.
-- It is the only figure that compares two books quoting different lines.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS best_ev NUMERIC;
-- EV at the reference book, so the VALUE OF SHOPPING is (best_ev - ref_ev)
-- rather than an unanchored number.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS ref_ev NUMERIC;
-- How many books were available to choose from. 1 means no shopping happened
-- and best_* is just the reference book restated -- which is the honest reading
-- of most rows today, and the reason this is reported rather than assumed.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS books_compared INTEGER;
