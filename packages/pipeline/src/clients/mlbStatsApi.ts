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

// Only `weather` was typed here for a long time, which hid the fact that the
// same payload carries every plate appearance of the game with the batter's
// side and the pitcher's hand on it. That is the source for platoon splits,
// and it costs no extra request -- ingestBoxscore already fetches this.
export interface LivePlay {
  result?: { type?: string; eventType?: string };
  // `runners` is what tells a completed plate appearance from a play that
  // merely happened while someone was batting; see isCompletedPa.
  runners?: Array<{
    details?: { runner?: { id?: number } };
    movement?: { originBase?: string | null };
  }>;
  // Every pitch of the plate appearance, plus non-pitch actions. The pitch
  // events carry type, velocity, location and batted-ball data -- the whole
  // Statcast-shaped half of what this project was missing.
  playEvents?: Array<{
    isPitch?: boolean;
    pitchNumber?: number;
    /** 'pitch' | 'action' | ... -- an `action` can be a pitching change, which
     *  happens MID plate appearance and re-attributes every pitch after it. */
    type?: string;
    /** On a pitching-change action this is the INCOMING pitcher. */
    player?: { id?: number };
    details?: {
      call?: { code?: string };
      type?: { code?: string };
      description?: string;
      event?: string;
      isStrike?: boolean;
      isBall?: boolean;
      isInPlay?: boolean;
    };
    pitchData?: {
      startSpeed?: number;
      zone?: number;
      coordinates?: { pX?: number; pZ?: number };
    };
    hitData?: {
      launchSpeed?: number;
      launchAngle?: number;
      totalDistance?: number;
      trajectory?: string;
    };
    count?: { balls?: number; strikes?: number };
  }>;
  about?: { atBatIndex?: number };
  matchup?: {
    batter?: { id?: number };
    pitcher?: { id?: number };
    batSide?: { code?: string };
    pitchHand?: { code?: string };
  };
}
export interface LiveFeedResponse {
  gameData?: { weather?: { condition?: string; temp?: string; wind?: string } };
  liveData?: { plays?: { allPlays?: LivePlay[] } };
}
export function getLiveFeed(gamePk: number): Promise<LiveFeedResponse> {
  return getJson(`/api/v1.1/game/${gamePk}/feed/live`);
}

// Handedness lives on /people, not on the boxscore: the boxscore's `person`
// object carries only id/link/fullName/boxscoreName, so bats/throws cannot be
// recovered from the payloads already in raw_api_responses.
//
// `personIds` is a comma-separated batch, which is what makes backfilling the
// whole players table cheap -- see PEOPLE_BATCH in ingest/people.ts.
export interface PeopleResponse {
  people?: Array<{
    id: number;
    fullName?: string;
    batSide?: { code?: string };
    pitchHand?: { code?: string };
  }>;
}
export function getPeople(personIds: readonly number[]): Promise<PeopleResponse> {
  return getJson(`/api/v1/people?personIds=${personIds.join(',')}`);
}

export type { StatMap, BoxscorePlayer };
