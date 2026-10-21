/**
 * The four section glyphs, inline.
 *
 * lucide-react is the obvious source, but it would be this app's first icon dependency for
 * four shapes used in one place. These are drawn on the same 24px grid with the same 1.8
 * stroke, so they sit together, and they inherit `currentColor` so the dock's selected and
 * unselected states need no second asset.
 */

const base = {
  viewBox: '0 0 24 24',
  width: 22,
  height: 22,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

/** Patient: a speech bubble — the screen is a conversation. */
export function PatientIcon() {
  return (
    <svg {...base}>
      <path d="M20.5 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-5A7.5 7.5 0 1 1 20.5 11.5Z" />
    </svg>
  );
}

/** Caregiver: a person with a care mark. */
export function CaregiverIcon() {
  return (
    <svg {...base}>
      <circle cx="9.5" cy="8" r="3.2" />
      <path d="M3.5 20a6 6 0 0 1 12 0" />
      <path d="M18.5 5.5v5M16 8h5" />
    </svg>
  );
}

/** Timeline: events on a line, in order. */
export function TimelineIcon() {
  return (
    <svg {...base}>
      <path d="M6 3.5v17" />
      <circle cx="6" cy="8" r="2.1" />
      <circle cx="6" cy="16" r="2.1" />
      <path d="M11 8h8M11 16h6" />
    </svg>
  );
}

/** Safety: a shield, with the check that says the limits are enforced. */
export function SafetyIcon() {
  return (
    <svg {...base}>
      <path d="M12 3.2 5 6v5.5c0 4 2.9 7.6 7 9.3 4.1-1.7 7-5.3 7-9.3V6l-7-2.8Z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </svg>
  );
}
