import { clamp } from './model.js';

// Approximate, illustrative run-scoring park factors (1.0 = neutral). Replace
// with a maintained source (e.g. a yearly table) before trusting these.
const PARK_FACTORS: Record<string, number> = {
  'Coors Field': 1.15,
  'Fenway Park': 1.05,
  'Great American Ball Park': 1.06,
  'Globe Life Field': 1.02,
  'Yankee Stadium': 1.03,
  'Petco Park': 0.94,
  'Oracle Park': 0.93,
  'T-Mobile Park': 0.94,
  'loanDepot park': 0.95,
  'Comerica Park': 0.96,
};

export function parkFactor(venue: string | null): number {
  if (!venue) return 1;
  return PARK_FACTORS[venue] ?? 1;
}

// Warmer air carries the ball a little further; small, clamped effect.
export function tempFactor(tempF: number | null): number {
  if (tempF == null) return 1;
  return clamp(1 + (tempF - 70) * 0.0015, 0.97, 1.05);
}

// How much the opposing starter inflates/suppresses hits, as a proxy from
// hits-allowed per batter faced vs league. (We don't store TB-allowed yet.)
export function pitcherTbFactor(pitcherHPerBf: number, leagueHPerBf: number): number {
  if (leagueHPerBf <= 0) return 1;
  return clamp(pitcherHPerBf / leagueHPerBf, 0.8, 1.25);
}

// How strikeout-prone the opposing lineup is vs league (for pitcher K props).
export function teamKFactor(teamSoPerPa: number, leagueSoPerPa: number): number {
  if (leagueSoPerPa <= 0) return 1;
  return clamp(teamSoPerPa / leagueSoPerPa, 0.85, 1.2);
}
