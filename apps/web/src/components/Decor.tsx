/**
 * Decorative marks: the hand-drawn arrow, the wave line, and the lime blobs.
 *
 * All of them are `aria-hidden` and `pointer-events: none` — they carry no information, and
 * a screen reader announcing "image" four times before the status line would make the page
 * worse for the people most likely to be using one.
 *
 * The arrow draws itself in on reveal via `stroke-dasharray`; `--len` has to roughly match
 * the path length or the dash never fully clears.
 */

export function Scribble({ className = 'scribble' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 180 120"
      aria-hidden="true"
      focusable="false"
      style={{ ['--len' as string]: '420' }}
    >
      {/* A loose curve sweeping right then hooking back down to an arrowhead. */}
      <path d="M8 96C34 40 86 8 150 22c22 5 24 26 6 34-20 9-44-2-40-20" />
      <path d="M150 22c-6 6-9 13-9 21M150 22c7 4 12 9 15 16" />
    </svg>
  );
}

export function Wave({ className = 'wave' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 320 60"
      // Stretched to the panel rather than letterboxed, so it behaves as a texture.
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M0 42c26 0 30-30 56-30s28 36 54 36 32-44 58-44 30 28 56 28 28-16 54-16" />
    </svg>
  );
}

/**
 * A lime circle bleeding off a card corner.
 *
 * Sized and positioned in percentages so it scales with the card rather than drifting when
 * the layout reflows at larger text sizes.
 */
export function Blob({
  corner = 'br',
  size = '46%',
  tone = 'lime',
}: {
  corner?: 'br' | 'tr' | 'bl';
  size?: string;
  tone?: 'lime' | 'ink' | 'coral';
}) {
  const place: Record<string, React.CSSProperties> = {
    br: { right: '-10%', bottom: '-45%' },
    tr: { right: '-12%', top: '-45%' },
    bl: { left: '-12%', bottom: '-45%' },
  };
  const colour =
    tone === 'ink' ? 'var(--ink)' : tone === 'coral' ? 'var(--coral)' : 'var(--lime)';

  return (
    <span
      className="blob"
      aria-hidden="true"
      style={{ ...place[corner], width: size, aspectRatio: '1', background: colour }}
    />
  );
}
