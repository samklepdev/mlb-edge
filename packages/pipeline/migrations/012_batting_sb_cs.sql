-- Stolen bases and caught stealing.
--
-- Not needed by any prop that ships with this migration. They are here because
-- every DFS batter fantasy score (PrizePicks, Underdog) weights stolen bases,
-- and without the column those props cannot be computed at all -- only
-- approximated by dropping a term, which is how you get a number that looks
-- like a fantasy score and is not one.
--
-- Same trick as 011: both fields are already in the boxscore payloads archived
-- in raw_api_responses, and every game with batting rows has its payload
-- stored, so this costs no API calls.
ALTER TABLE player_game_batting ADD COLUMN IF NOT EXISTS sb INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_game_batting ADD COLUMN IF NOT EXISTS cs INTEGER NOT NULL DEFAULT 0;

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
         coalesce((p.value->'stats'->'batting'->>'stolenBases')::int, 0)    AS sb,
         coalesce((p.value->'stats'->'batting'->>'caughtStealing')::int, 0) AS cs
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
SET sb = lines.sb, cs = lines.cs
FROM lines
WHERE lines.game_id = b.game_id AND lines.player_id = b.player_id;
