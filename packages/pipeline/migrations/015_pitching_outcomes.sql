-- The rest of a pitcher's line: what he allowed, not just how much of it.
--
-- player_game_pitching stored outs/so/bb/h/er/bf/pitches/strikes, which is
-- enough for K%, BB% and ERA and nothing else. The opponent-pitcher panel needs
-- OBP against, LOB%, HR/9 and wOBA against, and every one of those needs a term
-- that was not stored:
--
--   HR/9   <- home runs allowed
--   LOB%   <- runs allowed (not EARNED runs) and home runs
--   OBP    <- hit batsmen, at-bats, sacrifice flies
--   wOBA   <- the extra-base breakdown: doubles and triples
--
-- All of them are already in the boxscore payloads archived in
-- raw_api_responses, so this costs no API calls -- the same trick as 011
-- (hbp/sf), 012 (sb/cs) and 013 (pitch counts).
--
-- `hbp` uses hitByPitch rather than hitBatsmen: MLB reports both, and
-- hitByPitch is the one that pairs with the batter-side column added in 011.
ALTER TABLE player_game_pitching ADD COLUMN IF NOT EXISTS hr      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_game_pitching ADD COLUMN IF NOT EXISTS r       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_game_pitching ADD COLUMN IF NOT EXISTS hbp     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_game_pitching ADD COLUMN IF NOT EXISTS ab      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_game_pitching ADD COLUMN IF NOT EXISTS doubles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_game_pitching ADD COLUMN IF NOT EXISTS triples INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_game_pitching ADD COLUMN IF NOT EXISTS sf      INTEGER NOT NULL DEFAULT 0;

WITH latest AS (
  SELECT DISTINCT ON ((params->>'gamePk')::int)
         (params->>'gamePk')::int AS game_id, payload
  FROM raw_api_responses
  WHERE source = 'mlb' AND endpoint = 'boxscore'
  ORDER BY (params->>'gamePk')::int, fetched_at DESC
),
lines AS (
  SELECT l.game_id,
         (p.value->'person'->>'id')::int AS player_id,
         coalesce((p.value->'stats'->'pitching'->>'homeRuns')::int, 0)   AS hr,
         coalesce((p.value->'stats'->'pitching'->>'runs')::int, 0)       AS r,
         coalesce((p.value->'stats'->'pitching'->>'hitByPitch')::int, 0) AS hbp,
         coalesce((p.value->'stats'->'pitching'->>'atBats')::int, 0)     AS ab,
         coalesce((p.value->'stats'->'pitching'->>'doubles')::int, 0)    AS doubles,
         coalesce((p.value->'stats'->'pitching'->>'triples')::int, 0)    AS triples,
         coalesce((p.value->'stats'->'pitching'->>'sacFlies')::int, 0)   AS sf
  FROM latest l
  CROSS JOIN LATERAL (
    SELECT value FROM jsonb_each(l.payload->'teams'->'home'->'players')
    UNION ALL
    SELECT value FROM jsonb_each(l.payload->'teams'->'away'->'players')
  ) p
  WHERE p.value->'stats'->'pitching' IS NOT NULL
    AND p.value->'stats'->'pitching' <> '{}'::jsonb
)
UPDATE player_game_pitching pg
SET hr = lines.hr, r = lines.r, hbp = lines.hbp, ab = lines.ab,
    doubles = lines.doubles, triples = lines.triples, sf = lines.sf
FROM lines
WHERE lines.game_id = pg.game_id AND lines.player_id = pg.player_id;
