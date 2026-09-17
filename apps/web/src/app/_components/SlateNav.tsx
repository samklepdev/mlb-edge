import Link from 'next/link';

// Slate date navigation.
//
// A plain <form method="get"> with a native date input, not a client component:
// these pages are force-dynamic server renders and this needs no interactivity
// beyond "navigate to ?date=". Keeping it server-rendered means no JS is
// required to change date, and nothing here can drift into importing
// @mlb-edge/db from a "use client" file -- `pg` is server-only.
//
// prev/next come from the `games` table rather than `projections`, so they can
// reach a date whose games have been ingested but not yet projected. That was
// the case that made ingested games look missing.
export function SlateNav({
  date, prev, next, min, max,
}: {
  date: string;
  prev: string | null;
  next: string | null;
  min: string | null;
  max: string | null;
}) {
  return (
    <div className="slatenav">
      {prev ? (
        <Link className="snav-btn" href={`/slate?date=${prev}`} aria-label={`Previous slate, ${prev}`}>
          ← {prev}
        </Link>
      ) : (
        <span className="snav-btn snav-off" aria-hidden="true">←</span>
      )}

      <form className="snav-form" method="get" action="/slate">
        <label className="snav-label" htmlFor="slate-date">Slate date</label>
        <input
          className="snav-date"
          type="date"
          id="slate-date"
          name="date"
          defaultValue={date}
          min={min ?? undefined}
          max={max ?? undefined}
        />
        <button className="snav-btn" type="submit">Go</button>
      </form>

      {next ? (
        <Link className="snav-btn" href={`/slate?date=${next}`} aria-label={`Next slate, ${next}`}>
          {next} →
        </Link>
      ) : (
        <span className="snav-btn snav-off" aria-hidden="true">→</span>
      )}
    </div>
  );
}
