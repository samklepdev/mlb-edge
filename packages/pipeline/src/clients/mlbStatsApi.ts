import { config } from '@mlb-edge/db';

// Thin typed client over the public MLB Stats API (no key required).
// Only the fields we actually consume are typed; the raw payload is stored
// verbatim in raw_api_responses so nothing is lost.
async function getJson<T>(path: string): Promise<T> {
  const url = path.startsWith('http') ? path : `${config.mlbApiBase}${path}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`MLB API ${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

export interface ScheduleResponse {
  dates?: Array<{ date: string; games?: ScheduleGame[] }>;
}
export interface ScheduleGame {
  gamePk: number;
  gameDate: string;
  status: { abstractGameState: string; detailedState: string };
  teams: { home: ScheduleSide; away: ScheduleSide };
  venue?: { id: number; name: string };
}
interface ScheduleSide {
  team: { id: number; name: string };
  probablePitcher?: { id: number; fullName: string };
}

export function getSchedule(date: string): Promise<ScheduleResponse> {
  return getJson(`/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,venue`);
}

type StatMap = Record<string, number | string | undefined>;
export interface BoxscoreResponse {
  teams: { home: BoxscoreTeam; away: BoxscoreTeam };
}
interface BoxscoreTeam {
  team: { id: number; name: string };
  players: Record<string, BoxscorePlayer>;
}
interface BoxscorePlayer {
  person: { id: number; fullName: string };
  position?: { abbreviation?: string };
  stats?: { batting?: StatMap; pitching?: StatMap };
}
export function getBoxscore(gamePk: number): Promise<BoxscoreResponse> {
  return getJson(`/api/v1/game/${gamePk}/boxscore`);
}

export interface LiveFeedResponse {
  gameData?: { weather?: { condition?: string; temp?: string; wind?: string } };
}
export function getLiveFeed(gamePk: number): Promise<LiveFeedResponse> {
  return getJson(`/api/v1.1/game/${gamePk}/feed/live`);
}

export type { StatMap, BoxscorePlayer };
