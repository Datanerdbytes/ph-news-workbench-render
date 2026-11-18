'use client';

import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { resolveScheduledFor } from '@/lib/publishing/schedule';
import { inputClass, scheduleBounds, useScheduleClock } from './publish-page';

/**
 * The composer's chosen slot elapsed while the bake/staging ran. The media is
 * already prepared, so the only open question is when Facebook should publish
 * it — the request must not throw the finished work away over a stale time.
 */
export function staleScheduleMessage(value: string, noun: string): string {
  return `Your ${value.replace('T', ' ')} slot is no longer valid. Pick a new time — the ${noun} is already prepared, so nothing has to be rendered or uploaded again.`;
}

export type SubmitSchedule =
  | { kind: 'ok'; iso: string; picked?: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: string };

/**
 * Promise plumbing for the retry dialog. Call `resolveSubmit` once the bake and
 * staging are done: it returns the ISO time to submit, opens the dialog when
 * the chosen time is stale, and reports a cancelled prompt so the caller can
 * stop without submitting. Render `dialog` somewhere in the composer.
 */
export function useScheduleRetry() {
  const [prompt, setPrompt] = useState<{
    message: string;
    value: string;
  } | null>(null);
  const resolveRef = useRef<((value: string | null) => void) | null>(null);

  const ask = useCallback((message: string): Promise<string | null> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      // Seeded with the earliest valid slot so one click is enough.
      setPrompt({ message, value: scheduleBounds(new Date()).min });
    });
  }, []);

  const settle = useCallback((value: string | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setPrompt(null);
    resolve?.(value);
  }, []);

  const resolveSubmit = useCallback(
    async (value: string, noun: string): Promise<SubmitSchedule> => {
      const direct = resolveScheduledFor(value);
      if (direct.iso !== null) return { kind: 'ok', iso: direct.iso };
      const picked = await ask(staleScheduleMessage(value, noun));
      if (picked === null) return { kind: 'cancelled' };
      // The dialog disables confirm out of window, but re-resolve so an
      // invalid time can never fall through as an unscheduled publish.
      const chosen = resolveScheduledFor(picked);
      if (chosen.iso === null) return { kind: 'error', error: chosen.error };
      return { kind: 'ok', iso: chosen.iso, picked };
    },
    [ask]
  );

  const dialog = prompt ? (
    <ScheduleRetryDialog
      message={prompt.message}
      value={prompt.value}
      onChange={(next) =>
        setPrompt((current) => (current ? { ...current, value: next } : current))
      }
      onConfirm={() => settle(prompt.value)}
      onCancel={() => settle(null)}
    />
  ) : null;

  return { resolveSubmit, dialog };
}

function ScheduleRetryDialog({
  message,
  value,
  onChange,
  onConfirm,
  onCancel,
}: {
  message: string;
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // The window keeps closing while the prompt is open, so the value is judged
  // against the current clock — same as the composer's ScheduleField.
  const now = useScheduleClock();
  const inputRef = useRef<HTMLInputElement>(null);
  const bounds = scheduleBounds(now);
  const resolution = resolveScheduledFor(value, now);
  return (
    <Modal
      open
      onClose={onCancel}
      title="The schedule time passed while staging"
      initialFocusRef={inputRef}
    >
      <p className="mt-2 text-xs text-muted-foreground">{message}</p>
      <label className="mt-4 block">
        <span className="text-xs font-medium">New publish time</span>
        <input
          ref={inputRef}
          type="datetime-local"
          aria-label="New publish date and time"
          aria-invalid={resolution.iso === null}
          aria-describedby={
            resolution.iso === null ? 'reschedule-error' : undefined
          }
          min={bounds.min}
          max={bounds.max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${inputClass} mt-1.5`}
        />
      </label>
      {resolution.iso === null && (
        <p
          id="reschedule-error"
          role="alert"
          className="mt-1 text-[11px] text-destructive"
        >
          {resolution.error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="brand"
          size="sm"
          onClick={onConfirm}
          disabled={resolution.iso === null}
        >
          Schedule at {value.replace('T', ' ')}
        </Button>
      </div>
    </Modal>
  );
}
