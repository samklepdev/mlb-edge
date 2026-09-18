import type { ArsenalRow } from '@mlb-edge/db';

// Pitch codes as MLB's feed emits them. Presentation only -- nothing
// downstream reads these names, and an unmapped code falls through to the raw
// code rather than an invented one. Same reasoning as PropLabel: a raw code
// sitting among words is obviously wrong and asks to be fixed here, where a
// guessed name just looks settled.
const PITCH: Record<string, string> = {
  FF: 'Four-seam', SI: 'Sinker', FC: 'Cutter', FA: 'Fastball',
  SL: 'Slider', ST: 'Sweeper', SV: 'Slurve', CU: 'Curve',
  KC: 'Knuckle-curve', CS: 'Slow curve',
  CH: 'Changeup', FS: 'Splitter', FO: 'Forkball',
  KN: 'Knuckleball', EP: 'Eephus', SC: 'Screwball', UN: 'Unknown',
};

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const band = (lo: number | null, hi: number | null) =>
  lo == null || hi == null ? null : `${Math.round(lo * 100)}–${Math.round(hi * 100)}`;

export function ArsenalTable({
  rows, pitcherName, throws, mode, batterName, hiddenTypes,
}: {
  rows: ArsenalRow[];
  pitcherName: string;
  throws: string | null;
  mode: 'cross' | 'own';
  batterName: string | null;
  hiddenTypes: number;
}) {
  const heading = mode === 'own' ? 'Arsenal' : 'Versus pitch types';

  if (rows.length === 0) {
    return (
      <section className="ex-arsenal">
        <h2 className="ex-h">{heading}</h2>
        <p className="cap">
          No pitch data for {pitcherName} on or before this game — either a first
          start, or a start that predates the pitch-level ingest (which begins
          2026-03-15).
        </p>
      </section>
    );
  }

  const cross = mode === 'cross';
  // Distinguishes "we have no pitch history for this batter at all" from "he
  // has simply never offered at this one pitch", which the per-row dashes
  // cannot say on their own.
  const batterBlank = cross && rows.every((r) => r.bSwings === 0);

  return (
    <section className="ex-arsenal">
      <h2 className="ex-h">{heading}</h2>
      <p className="cap">
        {pitcherName}{throws ? ` (${throws}HP)` : ''}, season to date.
      </p>

      <div className="tscroll" tabIndex={0} role="region"
        aria-label={cross
          ? `${pitcherName} arsenal versus ${batterName} by pitch type, scrollable`
          : `${pitcherName} arsenal by pitch type, scrollable`}>
        <table>
          <thead>
            {cross && (
              <tr>
                <td />
                {/* A spanning band rather than repeating "pitcher"/"batter" in
                    six headers. aria-hidden because the scope'd headers below
                    already name each column for a screen reader, and announcing
                    the band again turns every cell into a sentence. */}
                <th colSpan={3} className="ars-band" aria-hidden="true">pitcher</th>
                <th colSpan={3} className="ars-band" aria-hidden="true">
                  {batterName ?? 'batter'}, season
                </th>
              </tr>
            )}
            <tr>
              <th scope="col">Pitch</th>
              <th scope="col">Use%</th>
              <th scope="col">Velo</th>
              <th scope="col">Whiff%</th>
              {cross && <th scope="col">Swings</th>}
              {cross && <th scope="col">Whiff%</th>}
              {cross && <th scope="col">Chase%</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const whiffBand = band(r.bWhiffLo, r.bWhiffHi);
              const chaseBand = band(r.bChaseLo, r.bChaseHi);
              return (
                <tr key={r.pitchType}>
                  <th scope="row">{PITCH[r.pitchType] ?? r.pitchType}</th>
                  <td className="num">{pct(r.usage)}</td>
                  <td className="num">{r.velo == null ? '—' : r.velo.toFixed(1)}</td>
                  <td className="num">{pct(r.pWhiffPct)}</td>
                  {cross && <td className="num">{r.bSwings}</td>}
                  {cross && (
                    <td className="num">
                      {pct(r.bWhiffPct)}
                      {whiffBand && <span className="ars-ci"> ({whiffBand})</span>}
                    </td>
                  )}
                  {cross && (
                    <td className="num">
                      {pct(r.bChasePct)}
                      {chaseBand && <span className="ars-ci"> ({chaseBand})</span>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hiddenTypes > 0 && (
        <p className="cap">
          {hiddenTypes} pitch type{hiddenTypes === 1 ? '' : 's'} under 5% usage not
          shown. Not folded into an &ldquo;other&rdquo; row: averaging a
          knuckle-curve with an eephus produces a number about nothing.
        </p>
      )}

      {batterBlank && (
        <p className="cap">
          No pitch-level history for {batterName} before this game, so the batter
          columns are empty. What the starter throws still stands on its own.
        </p>
      )}

      {cross ? (
        <p className="cap">
          Season to date, capped at this game&apos;s date. <strong>The Window,
          Venue and Pitcher-hand filters do not apply here</strong> — narrowed to
          the last 15 games, a typical batter has around a dozen swings against a
          secondary pitch, which supports no statement at all. Both pitcher hands
          are pooled; the vs-hand table above splits by hand at plate-appearance
          level. Parenthesised figures are 95% intervals — a wide one means the
          row is noise, not a small effect. Nothing in the model reads any of
          this; it is context, not input.
        </p>
      ) : (
        <p className="cap">
          Season to date, capped at this game&apos;s date, against all batters.
          The Window, Venue and Pitcher-hand filters do not apply. Nothing in the
          model reads these figures; they are context, not input.
        </p>
      )}
    </section>
  );
}
