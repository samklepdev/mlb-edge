import Link from 'next/link';

// Wordmark plus navigation. No prose.
//
// Every page used to carry a sentence here explaining what it was for, and on
// the data views those sentences had become disclaimers against predictions the
// pages do not make. The caveats that are genuinely load-bearing -- the CLV
// sample warnings, the calibration notes -- live in the BODY beside the figures
// they qualify, which is where they belong and where they remain.
//
// One component rather than five copies, so the nav cannot drift page to page.
const LINKS = [
  { href: '/', label: 'Props' },
  { href: '/slate', label: 'Slate' },
  { href: '/model', label: 'Model' },
] as const;

export function Masthead({ section }: { section: string }) {
  return (
    <header className="masthead">
      {/* An inner row rather than laying the children out directly: .masthead is
          a single centred track whose width is what aligns the bar's contents
          with the page's content column, and its rule carries a long note about
          approaches that broke that alignment. Putting the flex row one level
          in leaves all of it untouched. */}
      <div className="mast-inner">
        <h1 className="wordmark">
          {/* Links home from everywhere except home, where a self-link is
              noise. */}
          {section === 'props' ? 'mlb-edge' : <Link href="/">mlb-edge</Link>}
          {' '}<span>/ {section}</span>
        </h1>
        <nav className="mnav" aria-label="Sections">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`mnav-link${l.label.toLowerCase() === section ? ' mnav-on' : ''}`}
              aria-current={l.label.toLowerCase() === section ? 'page' : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
