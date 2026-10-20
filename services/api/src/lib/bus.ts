/**
 * In-process pub/sub feeding the browser's SSE connection.
 *
 * Local dev uses this directly. In Lambda there is no long-lived connection to hold, so the
 * deployed build falls back to the frontend polling `/api/sessions/:id` and `/api/timeline`
 * — the UI treats SSE as an enhancement, not a requirement, which is why the demo survives
 * being run against either target.
 */

import type { AgentTurn, CareSession, TimelineEntry } from '@careflow/shared';

export type BusEvent =
  | { type: 'session'; session: CareSession; turn: AgentTurn | null }
  | { type: 'timeline'; entry: TimelineEntry };

type Listener = (event: BusEvent) => void;

export class Bus {
  private listeners = new Set<Listener>();
  /** Short replay buffer so a browser that reconnects mid-demo does not miss a beat. */
  private recent: { at: string; event: BusEvent }[] = [];

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: BusEvent): void {
    this.recent.push({ at: new Date().toISOString(), event });
    if (this.recent.length > 100) this.recent.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken client must never take down event delivery for the others, and on
        // demo day the "broken client" is usually a browser tab somebody just closed.
      }
    }
  }

  replaySince(iso: string): BusEvent[] {
    return this.recent.filter((r) => r.at > iso).map((r) => r.event);
  }

  get subscriberCount() {
    return this.listeners.size;
  }
}
