/**
 * The listening orb.
 *
 * Adapted from the siri-orb component. Two deliberate departures from the original:
 *
 *  - It is plain CSS, not Tailwind, and it lives beside the other components rather than in
 *    `components/ui`. This app is Vite + React + plain CSS with no shadcn registry, so a
 *    `components/ui` folder would imply a convention the project does not have. The original
 *    only needed Tailwind for a `cn` helper it defined itself, so nothing is lost.
 *  - Its `<style>` block moved into styles.css. Inline `<style>` re-emits the same rules on
 *    every render and would be the only one in the codebase; `@property --angle` has to be
 *    global anyway.
 *
 * `level` is the live microphone amplitude, 0 to 1. It drives a CSS variable rather than
 * React state on every frame, so the loudness animation never re-renders the tree.
 */

import { useMemo } from 'react';

export interface SiriOrbProps {
  /** Rendered size, e.g. "168px". */
  size?: string;
  /** Live microphone amplitude, 0–1. Scales the orb as the patient speaks. */
  level?: number;
  animationDuration?: number;
  className?: string;
  colors?: { bg?: string; c1?: string; c2?: string; c3?: string };
}

// Thresholds from the original: the blur, contrast and dot grid all have to shrink with the
// orb or a small one turns into a grey disc.
const SMALL = 50;
const TINY = 30;
const MEDIUM = 100;

export function SiriOrb({
  size = '168px',
  level = 0,
  animationDuration = 20,
  className,
  colors,
}: SiriOrbProps) {
  const style = useMemo(() => {
    // CareFlow's palette rather than the original's pastels: lime on near-black.
    const c = {
      bg: '#0c0d0c',
      c1: '#d9f550',
      c2: '#eefbb0',
      c3: '#c7e52f',
      ...colors,
    };

    const px = Number.parseInt(size.replace('px', ''), 10) || 168;
    const blur = px < SMALL ? Math.max(px * 0.008, 1) : Math.max(px * 0.015, 4);
    const contrast = px < SMALL ? Math.max(px * 0.004, 1.2) : Math.max(px * 0.008, 1.5);
    const dot = px < SMALL ? Math.max(px * 0.004, 0.05) : Math.max(px * 0.008, 0.1);
    const shadow = px < SMALL ? Math.max(px * 0.004, 0.5) : Math.max(px * 0.008, 2);

    const maskRadius = px < TINY ? '0%' : px < SMALL ? '5%' : px < MEDIUM ? '15%' : '25%';
    const finalContrast =
      px < TINY ? 1.1 : px < SMALL ? Math.max(contrast * 1.2, 1.3) : contrast;

    // Clamped so a cough cannot throw the orb across the screen.
    const amplitude = Math.min(Math.max(level, 0), 1);

    return {
      width: size,
      height: size,
      '--bg': c.bg,
      '--c1': c.c1,
      '--c2': c.c2,
      '--c3': c.c3,
      '--animation-duration': `${animationDuration}s`,
      '--blur-amount': `${blur}px`,
      '--contrast-amount': finalContrast,
      '--dot-size': `${dot}px`,
      '--shadow-spread': `${shadow}px`,
      '--mask-radius': maskRadius,
      '--level': amplitude,
    } as React.CSSProperties;
  }, [size, level, animationDuration, colors]);

  return <div className={`siri-orb${className ? ` ${className}` : ''}`} style={style} aria-hidden="true" />;
}
