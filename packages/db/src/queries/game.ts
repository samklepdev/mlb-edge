import { query } from '../pool.js';
import type { GameDetail, GameBattingLine, GamePitchingLine, GamePick } from '../types.js';

// One game's full read: the result if it has been played, the pregame picture
// if it has not, and either way what the model said about it.
//
// The model's picks are the point of this page. A score on its own is
// something any scoreboard has; what this project can show is the prop picks
// it flagged for that game and, once settled, how they landed. Note that those
// are PROP picks -- per-player lines -- and must not be presented as a
// prediction about the game's outcome (CLAUDE.md: "Don't dress up prop numbers
// as team/game predictions"). Nothing here projects a winner or a run total.
export async function getGameDetail(gameId: number): Promise<GameDetail | null> {
  const g = (
    await query<{
      id: number; game_date: string; start_time: Date | null; status: string;
      venue_name: string | null;
      home_id: number | null; away_id: number | null;
      home: string | null; away: string | null;
      condition: string | null; temp_f: string | null; wind: string | null;
    }>(
      `SELECT g.id, to_char(g.game_date, 'YYYY-MM-DD') AS game_date,
              g.start_time, g.status, g.venue_name,
              g.home_team_id AS home_id, g.away_team_id AS away_id,
              th.name AS home, ta.name AS away,
              c.condition, c.temp_f, c.wind
       FROM games g
       LEFT JOIN teams th ON th.id = g.home_team_id
       LEFT JOIN teams ta ON ta.id = g.away_team_id
       LEFT JOIN game_conditions c ON c.game_id = g.id
       WHERE g.id = $1`,
      [gameId],
    )
  ).rows[0];
  if (!g) return null;

  // There is no score column anywhere in the schema. Runs are summed from the
  // box score, which is the only place they exist -- so a game that is Final
  // but whose boxscore was never ingested correctly reports no score rather
  // than a zero. (One such game exists today.)
  const score = (
    await query<{ away_r: string | null; home_r: string | null }>(
      `SELECT sum(b.r) FILTER (WHERE b.team_id = g.away_team_id) AS away_r,
              sum(b.r) FILTER (WHERE b.team_id = g.home_team_id) AS home_r
       FROM games g JOIN player_game_batting b ON b.game_id = g.id
       WHERE g.id = $1`,
      [gameId],
    )
  ).rows[0];

  const probables = (
    await query<{ side: string; pitcher_id: number; full_name: string; throws: string | null }>(
      `SELECT pp.side, pp.pitcher_id, pl.full_name, pl.throws
       FROM probable_pitchers pp
       JOIN players pl ON pl.id = pp.pitcher_id
       WHERE pp.game_id = $1`,
      [gameId],
    )
  ).rows;

  const batting = (
    await query<{
      player_id: number; full_name: string; team_id: number | null;
      pa: number; ab: number; h: number; hr: number; tb: number; so: number; bb: number; r: number; rbi: number;
    }>(
      `SELECT b.player_id, pl.full_name, b.team_id,
              b.pa, b.ab, b.h, b.hr, b.tb, b.so, b.bb, b.r, b.rbi
       FROM player_game_batting b
       JOIN players pl ON pl.id = b.player_id
       WHERE b.game_id = $1
       ORDER BY b.team_id, b.pa DESC, pl.full_name`,
      [gameId],
    )
  ).rows;

  const pitching = (
    await query<{
      player_id: number; full_name: string; team_id: number | null;
      outs: number; so: number; bb: number; h: number; er: number; bf: number;
    }>(
      `SELECT p.player_id, pl.full_name, p.team_id, p.outs, p.so, p.bb, p.h, p.er, p.bf
       FROM player_game_pitching p
       JOIN players pl ON pl.id = p.player_id
       WHERE p.game_id = $1
       ORDER BY p.team_id, p.bf DESC, pl.full_name`,
      [gameId],
    )
  ).rows;

  const picks = (
    await query<{
      player_id: number; full_name: string; prop_type: string; side: 'over' | 'under';
      pick_line: string; pick_prob: string; edge_pct: string | null; result: string | null;
    }>(
      `SELECT pk.player_id, pl.full_name, pk.prop_type, pk.side,
              pk.pick_line, pk.pick_prob, pk.edge_pct, pk.result
       FROM picks pk
       JOIN players pl ON pl.id = pk.player_id
       WHERE pk.game_id = $1
       ORDER BY pk.edge_pct DESC NULLS LAST, pl.full_name`,
      [gameId],
    )
  ).rows;

  const toBatting = (r: (typeof batting)[number]): GameBattingLine => ({
    playerId: r.player_id, playerName: r.full_name, teamId: r.team_id,
    pa: r.pa, ab: r.ab, h: r.h, hr: r.hr, tb: r.tb, so: r.so, bb: r.bb, r: r.r, rbi: r.rbi,
  });
  const toPitching = (r: (typeof pitching)[number]): GamePitchingLine => ({
    playerId: r.player_id, playerName: r.full_name, teamId: r.team_id,
    outs: r.outs, so: r.so, bb: r.bb, h: r.h, er: r.er, bf: r.bf,
  });

  const probable = (side: 'home' | 'away') => {
    const p = probables.find((x) => x.side === side);
    return p ? { playerId: p.pitcher_id, playerName: p.full_name, throws: p.throws } : null;
  };

  return {
    gameId: g.id,
    date: g.game_date,
    startTime: g.start_time,
    status: g.status,
    venue: g.venue_name,
    home: { teamId: g.home_id, name: g.home ?? '—', runs: score?.home_r == null ? null : Number(score.home_r) },
    away: { teamId: g.away_id, name: g.away ?? '—', runs: score?.away_r == null ? null : Number(score.away_r) },
    weather: g.condition == null && g.temp_f == null && g.wind == null
      ? null
      : { condition: g.condition, tempF: g.temp_f == null ? null : Number(g.temp_f), wind: g.wind },
    probableHome: probable('home'),
    probableAway: probable('away'),
    batting: batting.map(toBatting),
    pitching: pitching.map(toPitching),
    picks: picks.map((p): GamePick => ({
      playerId: p.player_id, playerName: p.full_name, propType: p.prop_type,
      side: p.side, line: Number(p.pick_line), modelProb: Number(p.pick_prob),
      edgePct: p.edge_pct == null ? null : Number(p.edge_pct),
      result: p.result === 'win' || p.result === 'loss' ? p.result : null,
    })),
  };
}
