/**
 * Scroll reveals.
 *
 * One quiet fade, uniform across the app. The staggered, directional variants were removed
 * with the rest of the decorative layer: on a list they made the newest row arrive last,
 * which is the wrong way round for the entry someone is waiting to see.
 *
 * One IntersectionObserver watches everything marked `data-reveal` and adds `is-visible`
 * when it comes into view; the CSS does the rest. Elements are unobserved once revealed, so
 * scrolling back up does not re-animate — content that keeps re-fading is distracting
 * rather than lively.
 *
 * Two details that matter for a care product:
 *
 *  - If `prefers-reduced-motion` is set, everything is marked visible immediately and no
 *    observer is created. The CSS also forces `opacity: 1`, so even a failure here cannot
 *    leave someone with a blank page — a reveal that never fires is the worst possible
 *    outcome of an accessibility setting.
 *  - A MutationObserver picks up nodes added later (switching tabs, a new agent turn),
 *    which a one-shot query at mount would miss entirely.
 */

import { useEffect } from 'react';

const VISIBLE = 'is-visible';

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function useReveal(): void {
  useEffect(() => {
    const reveal = (el: Element) => el.classList.add(VISIBLE);

    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      document.querySelectorAll('[data-reveal]').forEach(reveal);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          reveal(entry.target);
          observer.unobserve(entry.target);
        }
      },
      {
        // Fire slightly before the element reaches the viewport edge, so the animation is
        // already finishing by the time it is properly in view.
        rootMargin: '0px 0px -8% 0px',
        threshold: 0.06,
      },
    );

    const observeAll = () => {
      document.querySelectorAll(`[data-reveal]:not(.${VISIBLE})`).forEach((el) => {
        // Anything already on screen at mount is revealed straight away rather than
        // waiting for a scroll that may never come on a short page.
        const box = el.getBoundingClientRect();
        if (box.top < window.innerHeight && box.bottom > 0) reveal(el);
        else observer.observe(el);
      });
    };

    observeAll();

    const mutations = new MutationObserver(observeAll);
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);
}

/**
 * Marks the header once the page has scrolled, so it can lift off the hero with a border
 * and shadow. Uses a sentinel observer rather than a scroll listener — no work on every
 * frame, and no layout thrash from reading scrollY.
 */
export function useStuckHeader(): void {
  useEffect(() => {
    const header = document.querySelector('.app-header');
    if (!header) return;

    const sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;pointer-events:none';
    document.body.prepend(sentinel);

    const observer = new IntersectionObserver(
      ([entry]) => header.classList.toggle('is-stuck', !entry?.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(sentinel);

    return () => {
      observer.disconnect();
      sentinel.remove();
    };
  }, []);
}
