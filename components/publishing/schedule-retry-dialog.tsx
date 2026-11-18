'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
  MIN_SCHEDULE_MS,
  resolveScheduledFor,
} from '@/lib/publishing/schedule';
import {
  inputClass,
  scheduleBounds,
  toLocalInput,
  useScheduleClock,
} from './publish-page';

/**
 * The composer's chosen slot elapsed while the bake/staging ran. The media is
 * already prepared, so the only open question is when Facebook should publish
 * it — the request must not throw the finished work away over a stale time.
 */
export function staleScheduleMessage(value: string, noun: string): string {
  return `Your ${value.replace('T', ' ')} slot is no longer valid. Pick a new time — the ${noun} is already prepared, so nothing has to be rendered or uploaded again.`;
}

/** Videos cannot reuse the transfer, so its copy must not promise that. */
export function slowUploadMessage(value: string): string {
  return `Your ${value.replace('T', ' ')} slot was rejected once the upload landed. Pick a new time — the video is already rendered, so only the upload repeats.`;
}

/** Why a time that clears the 10-minute floor still fails after a slow upload. */
export function uploadLeadMessage(seedAfterMs: number): string {
  const upload = Math.ceil(seedAfterMs / 60_000);
  const ahead = Math.ceil((MIN_SCHEDULE_MS + seedAfterMs) / 60_000);
  return `The last upload took about ${upload} min — pick at least ${ahead} min ahead.`;
}

/** A server limit advances with elapsed time even if the device clock jumps. */
type ServerFloor = { minimumMs: number; receivedAt: number };

function serverMinimum(floor?: ServerFloor): number {
  return floor
    ? floor.minimumMs + Math.max(0, performance.now() - floor.receivedAt)
    : 0;
}

/**
 * Search from the later instant, then validate the formatted local value.
 * A two-hour DST fall-back can parse a formatted time as its first occurrence.
 * Never return a candidate that fails either minimum or the 75-day window.
 */
function retryMinimum(
  now: number,
  extraMs: number,
  afterMs: number,
  serverMin = 0
): string | null {
  const minimum = Math.max(now + MIN_SCHEDULE_MS + extraMs, serverMin);
  const start = Math.max(
    Math.ceil((now + MIN_SCHEDULE_MS + extraMs + 60_000) / 60_000) * 60_000,
    Math.floor(Math.max(afterMs, serverMin) / 60_000) * 60_000 + 60_000
  );
  for (let step = 0; step <= 180; step += 1) {
    const value = toLocalInput(new Date(start + step * 60_000));
    const resolved = resolveScheduledFor(value, new Date(now));
    if (resolved.iso === null) continue;
    const ms = new Date(resolved.iso).getTime();
    if (ms >= minimum && ms > afterMs) return value;
  }
  return null;
}

/** The slot the prompt opens with — '' only when no slot can clear both. */
function seedScheduleValue(
  now: number,
  extraMs: number,
  afterMs: number,
  serverFloor?: ServerFloor
): string {
  return retryMinimum(now, extraMs, afterMs, serverMinimum(serverFloor)) ?? '';
}

/** The server refused that slot; re-offering it just earns another 400. */
export function retryAfterMessage(value: string): string {
  return `The server already refused ${value.replace('T', ' ')} — pick a later time.`;
}

export type SubmitSchedule =
  | { kind: 'ok'; iso: string; picked?: string }
  | { kind: 'cancelled' };

export type SubmitScheduleOptions = {
  /**
   * How far ahead of "now" the next known wait sits before the prompt opens —
   * e.g. the upload time of the attempt the server just rejected. The seed
   * and the picked time must survive that wait, not just the 10-minute floor.
   */
  seedAfterMs?: number;
  /**
   * Epoch ms of the slot the server refused. The next pick must be strictly
   * later — the server's clock may run ahead of ours, so re-offering the
   * refused value just earns another rejection.
   */
  afterMs?: number;
  /** Server minimum plus upload duration, measured when the refusal arrives. */
  serverFloor?: ServerFloor;
  /** The refused slot in picker format, for the "pick a later time" copy. */
  afterLabel?: string;
  /** Ask even when the browser clock accepts it — the server rejected it. */
  forcePrompt?: boolean;
  /** Replaces the default "slot is no longer valid" sentence. */
  message?: string;
};

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
    minDelayMs: number;
    afterMs: number;
    afterLabel: string;
    serverFloor?: ServerFloor;
  } | null>(null);
  const resolveRef = useRef<((value: string | null) => void) | null>(null);
  const mountedRef = useRef(true);

  const ask = useCallback(
    (
      message: string,
      seedAfterMs = 0,
      afterMs = 0,
      afterLabel = '',
      serverFloor?: ServerFloor
    ): Promise<string | null> => {
      return new Promise((resolve) => {
        resolveRef.current = resolve;
        // Seeded with the earliest valid slot so one click is enough.
        setPrompt({
          message,
          value: seedScheduleValue(Date.now(), seedAfterMs, afterMs, serverFloor),
          minDelayMs: seedAfterMs,
          afterMs,
          afterLabel,
          serverFloor,
        });
      });
    },
    []
  );

  const settle = useCallback((value: string | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setPrompt(null);
    resolve?.(value);
  }, []);

  // Navigating away must still settle the awaiting submit — the cancellation
  // branch is what releases staged media — and staging that finishes after
  // the unmount must not open a prompt nobody can answer.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const resolve = resolveRef.current;
      resolveRef.current = null;
      resolve?.(null);
    };
  }, []);

  const resolveSubmit = useCallback(
    async (
      value: string,
      noun: string,
      options: SubmitScheduleOptions = {}
    ): Promise<SubmitSchedule> => {
      if (!mountedRef.current) return { kind: 'cancelled' };
      if (!options.forcePrompt) {
        const direct = resolveScheduledFor(value);
        if (direct.iso !== null) return { kind: 'ok', iso: direct.iso };
      }
      let current = value;
      const afterMs = options.afterMs ?? 0;
      for (;;) {
        const picked = await ask(
          options.message ?? staleScheduleMessage(current, noun),
          options.seedAfterMs,
          afterMs,
          options.afterLabel ?? '',
          options.serverFloor
        );
        if (picked === null) return { kind: 'cancelled' };
        const chosen = resolveScheduledFor(picked);
        const chosenMs =
          chosen.iso === null ? null : new Date(chosen.iso).getTime();
        const clearsLead =
          !options.seedAfterMs ||
          (chosenMs !== null &&
            chosenMs - Date.now() >= MIN_SCHEDULE_MS + options.seedAfterMs);
        const clearsAfter = !afterMs || (chosenMs !== null && chosenMs > afterMs);
        if (chosen.iso !== null && clearsLead && clearsAfter &&
          chosenMs !== null && chosenMs >= serverMinimum(options.serverFloor)) {
          return { kind: 'ok', iso: chosen.iso, picked };
        }
        if (!mountedRef.current) return { kind: 'cancelled' };
        // The click can outlive the dialog's last clock tick, so the confirm
        // is judged again here. Reopen with a fresh seed instead of
        // discarding the prepared media over a time the dialog let through.
        current = picked;
      }
    },
    [ask]
  );

  const dialog = prompt ? (
    <ScheduleRetryDialog
      message={prompt.message}
      value={prompt.value}
      minDelayMs={prompt.minDelayMs}
      afterMs={prompt.afterMs}
      afterLabel={prompt.afterLabel}
      serverFloor={prompt.serverFloor}
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
  minDelayMs,
  afterMs,
  afterLabel,
  serverFloor,
  onChange,
  onConfirm,
  onCancel,
}: {
  message: string;
  value: string;
  minDelayMs: number;
  afterMs: number;
  afterLabel: string;
  serverFloor?: ServerFloor;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // The window keeps closing while the prompt is open, so the value is judged
  // against the current clock — same as the composer's ScheduleField.
  const now = useScheduleClock();
  const inputRef = useRef<HTMLInputElement>(null);
  const bounds = scheduleBounds(now);
  const serverMin = serverMinimum(serverFloor);
  const minimum = retryMinimum(now.getTime(), minDelayMs, afterMs, serverMin);
  const min = minimum ?? bounds.max;
  const resolution = resolveScheduledFor(value, now);
  let error: string | null = null;
  if (resolution.iso === null) {
    error = resolution.error;
  } else if (afterMs && new Date(resolution.iso).getTime() <= afterMs) {
    error = retryAfterMessage(afterLabel);
  } else if (
    minDelayMs > 0 &&
    new Date(resolution.iso).getTime() - now.getTime() <
      MIN_SCHEDULE_MS + minDelayMs
  ) {
    error = uploadLeadMessage(minDelayMs);
  } else if (new Date(resolution.iso).getTime() < serverMin) {
    error = minimum
      ? `Pick ${minimum.replace('T', ' ')} or later to allow time for the upload.`
      : 'No available time clears the upload limit within the scheduling window.';
  }
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
          aria-invalid={error !== null}
          aria-describedby={error !== null ? 'reschedule-error' : undefined}
          min={min}
          max={bounds.max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${inputClass} mt-1.5`}
        />
      </label>
      {error !== null && (
        <p
          id="reschedule-error"
          role="alert"
          className="mt-1 text-[11px] text-destructive"
        >
          {error}
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
          disabled={error !== null}
        >
          Schedule at {value.replace('T', ' ')}
        </Button>
      </div>
    </Modal>
  );
}
