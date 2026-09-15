-- Hit-by-pitch and sacrifice flies, so OBP and BABIP can be computed exactly
-- rather than approximated.
--
--   OBP   = (H + BB + HBP) / (AB + BB + HBP + SF)
--   BABIP = (H - HR) / (AB - K - HR + SF)
--
-- Without these two columns both formulas have to drop terms, which produces a
-- number that is close to right, carries the standard label, and is quietly
-- wrong -- the worst kind of figure for a project whose point is honest
-- measurement.
--
-- No refetch is needed. Both fields are already in the boxscore payloads
-- archived in raw_api_responses (`hitByPitch`, `sacFlies`), and every one of the
-- 2,392 games with batting rows has its payload stored -- verified, 0 missing.
-- The backfill below reads those, so this migration costs no API calls.
ALTER TABLE player_game_batting ADD COLUMN IF NOT EXISTS hbp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_game_batting ADD COLUMN IF NOT EXISTS sf  INTEGER NOT NULL DEFAULT 0;

-- Backfill from the newest archived payload per game. DISTINCT ON picks one
-- row per gamePk because a game can have been ingested more than once.
WITH latest AS (
  SELECT DISTINCT ON ((params->>'gamePk')::int)
         (params->>'gamePk')::int AS game_id, payload
  FROM raw_api_responses
  WHERE source = 'mlb' AND endpoint = 'boxscore'
  ORDER BY (params->>'gamePk')::int, fetched_at DESC
),
lines AS (
  SELECT l.game_id,
         (p.value->'person'->>'id')::int                     AS player_id,
         coalesce((p.value->'stats'->'batting'->>'hitByPitch')::int, 0) AS hbp,
         coalesce((p.value->'stats'->'batting'->>'sacFlies')::int, 0)   AS sf
  FROM latest l
  CROSS JOIN LATERAL (
    SELECT value FROM jsonb_each(l.payload->'teams'->'home'->'players')
    UNION ALL
    SELECT value FROM jsonb_each(l.payload->'teams'->'away'->'players')
  ) p
  WHERE p.value->'stats'->'batting' IS NOT NULL
    AND p.value->'stats'->'batting' <> '{}'::jsonb
)
UPDATE player_game_batting b
SET hbp = lines.hbp, sf = lines.sf
FROM lines
WHERE lines.game_id = b.game_id AND lines.player_id = b.player_id;
