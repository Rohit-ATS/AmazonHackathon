/**
 * The section bar, as a magnifying dock.
 *
 * Built from the dock component's behaviour rather than its code. The original needs
 * framer-motion, lucide-react, Tailwind and a shadcn `cn` helper; this app has none of
 * those, and the brief for it was explicit that four screens do not need a component
 * library. The magnification is a distance falloff and a spring-ish easing, which is about
 * sixty lines — cheaper than ~35KB gzipped of animation runtime for one navigation bar.
 *
 * Two deliberate differences from the reference, both because this is a tab bar rather
 * than an app dock:
 *
 *  - The items stay real `<button role="tab">`s with `aria-selected`, not divs with
 *    `role="button"` and `tabIndex={0}`. Screen-reader users get "tab 2 of 4, selected";
 *    the dock's own markup would announce four unrelated buttons.
 *  - Labels appear on hover *and* on focus, and the selected tab keeps its label on screen
 *    permanently. A bar whose meaning is only available to a mouse is not navigation.
 */

import { useCallback, useRef } from 'react';

export interface DockItemSpec {
  id: string;
  label: string;
  icon: React.ReactNode;
}

interface Props {
  items: DockItemSpec[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Labels the tablist for assistive technology. */
  label: string;
  /** The id of the element the tabs control. */
  controls: string;
}

/**
 * How far from the pointer an item still reacts, and how much it grows at the centre.
 * Scaled gently so items stay comfortably inside the dock container without clipping.
 */
const DISTANCE = 100;
const MAGNIFY = 0.08;

export function Dock({ items, activeId, onSelect, label, controls }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  /**
   * Writes the scale straight onto each element as a custom property.
   *
   * Pointer moves fire far faster than React should re-render: putting this in state would
   * rerender the whole bar on every mousemove, for an effect the compositor can do on its
   * own. The CSS transition supplies the spring.
   */
  const magnify = useCallback((pointerX: number | undefined) => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    for (const item of items) {
      const el = itemRefs.current[item.id];
      if (!el) continue;

      if (pointerX === undefined) {
        el.style.setProperty('--mag', '0');
        continue;
      }
      const box = el.getBoundingClientRect();
      const centre = box.left + box.width / 2;
      const falloff = Math.max(0, 1 - Math.abs(pointerX - centre) / DISTANCE);
      // Squared, so the item under the pointer clearly leads instead of the whole bar
      // swelling together.
      el.style.setProperty('--mag', String(falloff * falloff * MAGNIFY));
    }
  }, [items]);

  return (
    <nav className="dock-wrap" aria-label={label}>
      <div
        className="dock"
        ref={barRef}
        role="tablist"
        aria-label={label}
        onPointerMove={(event) => magnify(event.clientX)}
        onPointerLeave={() => magnify(undefined)}
      >
        {items.map((item) => {
          const selected = item.id === activeId;
          return (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[item.id] = el;
              }}
              type="button"
              className={`dock-item${selected ? ' is-selected' : ''}`}
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={selected}
              aria-controls={controls}
              onClick={() => onSelect(item.id)}
              onFocus={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                magnify(box.left + box.width / 2);
              }}
              onBlur={() => magnify(undefined)}
            >
              <span className="dock-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="dock-label">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
