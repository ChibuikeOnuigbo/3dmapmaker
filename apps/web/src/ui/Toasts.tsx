/**
 * apps/web — transient notifications (ACCEPTANCE (f): errors must be visible).
 *
 * Toasts auto-dismiss, but errors and warnings stay until dismissed so a
 * failure is never something you had to be watching for.
 */
import React, { useEffect } from 'react';
import { useStore } from '../state/store';

const TONE_LABEL: Record<string, string> = { info: 'Info', ok: 'Done', warn: 'Warning', error: 'Error' };
const STICKY = new Set(['warn', 'error']);

export function Toasts(): React.ReactElement | null {
  const notifications = useStore((s) => s.ui.notifications);
  const dismiss = useStore((s) => s.dismissNotification);

  useEffect(() => {
    if (notifications.length === 0) return;
    const timers = notifications
      .filter((n) => !STICKY.has(n.tone))
      .map((n) => window.setTimeout(() => dismiss(n.id), 4500));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [notifications, dismiss]);

  if (notifications.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {notifications.slice(-5).map((n) => (
        <div key={n.id} className={`toast toast--${n.tone}`}>
          <span className="toast__tone">{TONE_LABEL[n.tone] ?? n.tone}</span>
          <span className="toast__text">{n.text}</span>
          <button type="button" className="toast__close" aria-label="Dismiss notification" onClick={() => dismiss(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
