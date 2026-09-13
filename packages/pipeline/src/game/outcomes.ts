import { query } from '@mlb-edge/db';

// Team outcomes are DERIVED, not ingested: player_game_batting carries r and
// team_id, and every non-synthetic game has exactly two teams with batting
// rows. This is the ground truth the model is graded against.
export interface TeamGameOutcome {
  gameId: number;
  teamId: number;
  oppTeamId: number;
  isHome: boolean;
  runsFor: number;
  runsAgainst: number;
  won: boolean;
}

// One row per (game, team). `before` restricts to games strictly before a date
// -- the lookahead guard every history query in this repo uses.
export async function teamOutcomes(before?: string): Promise<TeamGameOutcome[]> {
  const params: string[] = [];
  let dateFilter = '';
  if (before) {
    params.push(before);
    dateFilter = `AND g.game_date < $${params.length}`;
  }
  const res = await query<{
    game_id: number; team_id: number; opp_team_id: number;
    is_home: boolean; runs_for: number; runs_against: number;
  }>(
    `WITH s AS (
       SELECT b.game_id, b.team_id, sum(b.r)::int AS runs
       FROM player_game_batting b
       JOIN games g ON g.id = b.game_id
       WHERE NOT g.is_synthetic ${dateFilter}
       GROUP BY b.game_id, b.team_id
     )
     SELECT s.game_id, s.team_id,
            o.team_id AS opp_team_id,
            (s.team_id = g.home_team_id) AS is_home,
            s.runs AS runs_for,
            o.runs AS runs_against
     FROM s
     JOIN s o ON o.game_id = s.game_id AND o.team_id <> s.team_id
     JOIN games g ON g.id = s.game_id
     -- A completed MLB game cannot end tied. Equal derived runs means an
     -- incomplete or suspended box score; scoring it as a draw would inject an
     -- impossible outcome into calibration, so it is excluded here and counted
     -- by outcomeExclusions().
     WHERE s.runs <> o.runs`,
    params,
  );
  return res.rows.map((r) => ({
    gameId: r.game_id,
    teamId: r.team_id,
    oppTeamId: r.opp_team_id,
    isHome: r.is_home,
    runsFor: Number(r.runs_for),
    runsAgainst: Number(r.runs_against),
    won: Number(r.runs_for) > Number(r.runs_against),
  }));
}

// What the outcome layer refused to score, so it is reported rather than silent.
export async function outcomeExclusions(): Promise<{ ties: number; missingSide: number }> {
  const res = await query<{ ties: string; missing_side: string }>(
    `WITH s AS (
       SELECT b.game_id, b.team_id, sum(b.r)::int AS runs
       FROM player_game_batting b JOIN games g ON g.id = b.game_id
       WHERE NOT g.is_synthetic
       GROUP BY b.game_id, b.team_id
     ),
     per_game AS (
       SELECT game_id, count(*) AS sides, min(runs) AS lo, max(runs) AS hi
       FROM s GROUP BY game_id
     )
     SELECT count(*) FILTER (WHERE sides = 2 AND lo = hi) AS ties,
            count(*) FILTER (WHERE sides <> 2)            AS missing_side
     FROM per_game`,
  );
  return { ties: Number(res.rows[0].ties), missingSide: Number(res.rows[0].missing_side) };
}
