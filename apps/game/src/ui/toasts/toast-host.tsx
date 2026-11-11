// The toast host (issue #61): one toast per `notify` event that
// GatewayClient.onEvents delivers (and per EQUIPMENT_SOLD, a log event the #99
// sign-off gives a notification, #136), in a corner over the map.
//
// It keeps only a bounded queue of toast view models (display text and a
// tone, built when the event arrives) and their dismiss timers: no copy of
// game state (CLAUDE.md rule 7). Toasts are announced politely to assistive
// tech, can be dismissed, and go on their own after a while unless the pointer
// or focus is on them.

import { useEffect, useRef, useState } from "react";
import { useGateway } from "../../state/app-context.tsx";
import { CloseIcon, ToneIcon } from "../icons.tsx";
import { TOAST_HOST_COPY } from "./copy.ts";
import { toastsFor, type ToastView } from "./toast-view.ts";

/** Toasts shown at once; older ones drop off first. */
export const MAX_TOASTS = 4;
/** How long a toast stays without attention, in real milliseconds. */
export const TOAST_LIFETIME_MS = 8_000;

/** Appends new toasts, keeping the newest `max`. */
export function enqueue(queue: readonly ToastView[], incoming: readonly ToastView[], max: number = MAX_TOASTS): ToastView[] {
  const known = new Set(queue.map((t) => t.id));
  return [...queue, ...incoming.filter((t) => !known.has(t.id))].slice(-max);
}

export function ToastHost() {
  const gateway = useGateway();
  const [toasts, setToasts] = useState<readonly ToastView[]>([]);
  const [held, setHeld] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = (id: string) => setToasts((q) => q.filter((t) => t.id !== id));

  useEffect(
    () =>
      // Log batches too, for the few log events that get a toast (EQUIPMENT_SOLD).
      gateway.onEvents((events) => {
        const incoming = toastsFor(events, gateway.view.snapshot);
        if (incoming.length > 0) setToasts((q) => enqueue(q, incoming));
      }),
    [gateway],
  );

  // One timer per visible toast; none while the pointer or focus is on the host.
  useEffect(() => {
    const live = timers.current;
    const ids = new Set(toasts.map((t) => t.id));
    for (const [id, timer] of live) {
      if (held || !ids.has(id)) {
        clearTimeout(timer);
        live.delete(id);
      }
    }
    if (!held) {
      for (const t of toasts) {
        if (!live.has(t.id)) live.set(t.id, setTimeout(() => dismiss(t.id), TOAST_LIFETIME_MS));
      }
    }
  }, [toasts, held]);

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live.values()) clearTimeout(timer);
      live.clear();
    };
  }, []);

  return (
    <section
      className="toast-host"
      aria-label={TOAST_HOST_COPY.region}
      data-testid="toasts"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false);
      }}
    >
      <ol className="toast-list" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <li key={t.id} className="toast" data-tone={t.tone} data-event={t.eventType} data-testid="toast">
            <ToneIcon tone={t.tone} />
            <div className="toast-text">
              <p className="toast-title">{t.title}</p>
              <p className="toast-body">{t.body}</p>
            </div>
            <button type="button" className="icon-button toast-dismiss" aria-label={TOAST_HOST_COPY.dismiss(t.title)} onClick={() => dismiss(t.id)} data-testid="toast-dismiss">
              <CloseIcon />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
