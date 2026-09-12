-- `lines capture` had no knowledge of first pitch, so running it after a game
-- started recorded LIVE IN-GAME odds into close_line and clv_pct as though they
-- were closing prices. 164 of 500 CLV rows (33%) were contaminated this way,
-- including 124 of the 157 rows behind the +0.265% headline forward-test figure.
--
-- picks had no record of WHEN a close was taken (created_at is when the PICK was
-- written), so no read-time filter could tell a good historical capture from a
-- bad one. This column supplies that, and Task 3's guard keeps it honest going
-- forward.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS close_captured_at TIMESTAMPTZ;

-- Backfill: approximate each existing capture with the LAST market_lines fetch
-- for that slate. This is an APPROXIMATION and is deliberately conservative --
-- using the latest fetch can only make a capture look later than it really was,
-- so it over-excludes rather than over-trusts. For a measurement tool that is
-- the correct direction to err.
--
-- The demo seed is untouched by construction: the sentinel game (2099-01-01)
-- has zero market_lines rows, so this join matches nothing for it and its 160
-- picks keep a NULL close_captured_at -- which the CLV filter treats as "not
-- verifiable" rather than "trusted".
UPDATE picks pk
SET close_captured_at = sub.last_fetch
FROM games g,
     (SELECT g2.game_date, max(ml.fetched_at) AS last_fetch
      FROM market_lines ml JOIN games g2 ON g2.id = ml.game_id
      GROUP BY g2.game_date) sub
WHERE g.id = pk.game_id
  AND sub.game_date = g.game_date
  AND pk.close_line IS NOT NULL
  AND pk.close_captured_at IS NULL;
