// MLB's image CDN is keyed by the same person id we store in `players.id`
// (see migrations/001_core.sql: `id INTEGER PRIMARY KEY -- MLB person id`),
// so headshots need no ingest, no schema, and no API key.
//
// The `d_people:generic:headshot:67:current.png` segment is a Cloudinary
// *default image* transform: when the CDN has no photo for an id it serves a
// generic silhouette instead of 404ing. That one detail is what lets unmatched
// players and the demo seed's sentinel ids degrade gracefully with no
// client-side code. Don't drop it.
const CDN = 'https://img.mlbstatic.com/mlb-photos/image/upload';

export function headshotUrl(playerId: number, width: number): string {
  return `${CDN}/d_people:generic:headshot:67:current.png/w_${width},q_auto:best/v1/people/${playerId}/headshot/67/current`;
}

export function Headshot({ playerId, size = 56 }: { playerId: number; size?: number }) {
  return (
    <img
      className="headshot"
      src={headshotUrl(playerId, size * 2)} // 2x source for the displayed box
      width={size}
      height={size}
      // Decorative: the player's name sits beside this as real text, so alt
      // text here would make a screen reader announce the name twice.
      alt=""
    />
  );
}
