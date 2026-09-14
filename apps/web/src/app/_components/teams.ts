// MLB team ids, verified against the `teams` table on 2026-09-14.
//
// Deliberately a frozen map rather than a `teams.abbrev` column: adding one
// would mean a migration, an ingest change, and a re-ingest to backfill 30 rows
// that have not changed in decades. If anything outside the web app ever needs
// abbreviations, promote it then.
//
// The table also holds minor-league, exhibition, All-Star, and demo-sentinel
// clubs (37 rows total), which is why `abbrev` must degrade rather than throw.
const TEAM_ABBREV: Record<number, string> = {
  108: 'LAA', 109: 'ARI', 110: 'BAL', 111: 'BOS', 112: 'CHC',
  113: 'CIN', 114: 'CLE', 115: 'COL', 116: 'DET', 117: 'HOU',
  118: 'KC',  119: 'LAD', 120: 'WSH', 121: 'NYM', 133: 'ATH',
  134: 'PIT', 135: 'SD',  136: 'SEA', 137: 'SF',  138: 'STL',
  139: 'TB',  140: 'TEX', 141: 'TOR', 142: 'MIN', 143: 'PHI',
  144: 'ATL', 145: 'CWS', 146: 'MIA', 147: 'NYY', 158: 'MIL',
};

// Falls back to the first three letters of the stored name, so an unmapped id
// still renders something truthful instead of a blank or a throw.
export function abbrev(id: number | null, name: string): string {
  if (id != null && TEAM_ABBREV[id]) return TEAM_ABBREV[id];
  return (name ?? '').trim().slice(0, 3).toUpperCase() || '???';
}

// Keyed by the same team id we already store, exactly as the image CDN in
// Headshot.tsx is keyed by person id. No ingest, no schema, no API key.
//
// Unlike the headshot CDN there is no default-image transform here, so an
// unknown id 404s. Callers render this as a CSS background-image, where a 404
// degrades to blank space rather than a broken-image icon.
export function logoUrl(id: number | null): string | null {
  return id == null ? null : `https://www.mlbstatic.com/team-logos/${id}.svg`;
}
