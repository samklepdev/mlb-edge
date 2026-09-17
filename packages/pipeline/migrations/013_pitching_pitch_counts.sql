-- Pitch counts per pitcher-game.
--
-- These exist to be the RECONCILIATION SOURCE for the per-pitch table in 014.
-- Parsing 677k pitches out of play-by-play is the riskiest ingest in this
-- repo so far, and it needs what the platoon capture had: an independently
-- derived number to check the parse against. `numberOfPitches` comes from the
-- boxscore, which is a different part of the payload from `allPlays`, so a
-- parsing mistake cannot corrupt both in the same direction.
--
-- `strikes` is stored because strike rate is a real stat, but it is
-- DELIBERATELY NOT used as a gate. The boxscore counts every pitch that is not
-- a ball -- fouls and balls in play included -- while the feed's
-- details.isStrike is narrower. Measured on game 824981 the two disagree for
-- every pitcher (8 vs 12, 4 vs 11, 51 vs 63), while pitch counts match exactly
-- for all nine. Gating on strikes would fail 100% of games.
--
-- No refetch: both fields are in the boxscore payloads already archived in
-- raw_api_responses.
ALTER TABLE player_game_pitching ADD COLUMN IF NOT EXISTS pitches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE player_game_pitching ADD COLUMN IF NOT EXISTS strikes INTEGER NOT NULL DEFAULT 0;

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
         coalesce((p.value->'stats'->'pitching'->>'numberOfPitches')::int, 0) AS pitches,
         coalesce((p.value->'stats'->'pitching'->>'strikes')::int, 0)         AS strikes
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
SET pitches = lines.pitches, strikes = lines.strikes
FROM lines
WHERE lines.game_id = pg.game_id AND lines.player_id = pg.player_id;
