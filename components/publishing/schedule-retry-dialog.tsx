'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
  MAX_SCHEDULE_MS,
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
export function uploadLeadMessage(
  seedAfterMs: number,
  requiredLeadMs = MIN_SCHEDULE_MS + seedAfterMs
): string {
  const upload = Math.ceil(seedAfterMs / 60_000);
  const ahead = Math.ceil(requiredLeadMs / 60_000);
  return `The last upload took about ${upload} min — pick at least ${ahead} min ahead.`;
}

/** What a local datetime-local value actually parses to. */
function parsedMs(value: string): number {
  return new Date(value).getTime();
}

/**
 * Earliest pickable value in the picker's local format that clears every
 * bound: the 10-minute floor plus the expected wait, the slot the server
 * refused, and the 75-day ceiling. Local formatting drops the offset, so a
 * DST fall-back's second occurrence parses up to two hours early; scan
 * forward a minute at a time until the parsed value clears the target. The
 * optional pad pushes the target past the dialog's next clock tick. A window
 * too narrow for a bound yields null rather than a candidate that fails it.
 */
function retryMinimum(
  now: number,
  extraMs: number,
  afterMs: number,
  padMs = 0
): string | null {
  const target = Math.max(
    now + MIN_SCHEDULE_MS + extraMs + padMs,
    afterMs ? afterMs + 1 : 0
  );
  const max = now + MAX_SCHEDULE_MS;
  for (let step = 0; step <= 180; step += 1) {
    const value = toLocalInput(new Date(target + step * 60_000));
    const ms = parsedMs(value);
    if (ms >= target && ms <= max) return value;
  }
  return null;
}

/**
 * The slot the prompt opens with: padded a minute so it survives the dialog's
 * clock ticks, or the true earliest when the window is too narrow for that.
 */
function seedScheduleValue(
  now: number,
  extraMs: number,
  afterMs: number
): string {
  return (
    retryMinimum(now, extraMs, afterMs, 60_000) ??
    retryMinimum(now, extraMs, afterMs) ??
    ''
  );
}

/** The server refused that slot; re-offering it just earns another 400. */
export function retryAfterMessage(value: string): string {
  return `The server already refused ${value.replace('T', ' ')} — pick a later time.`;
}

/** The first selectable time, when the server-adjusted limit blocks a pick. */
export function retryFloorMessage(minValue: string): string {
  return `Pick ${minValue.replace('T', ' ')} or later — the server's clock runs ahead of this one.`;
}

/** A spring-forward gap: the local clock never reaches this time. */
export function missingLocalTimeMessage(value: string): string {
  return `${value.replace('T', ' ')} does not exist on that date — the clock skips over it. Pick another time.`;
}

export type SubmitSchedule =
  | { kind: 'ok'; iso: string; picked?: string }
  | { kind: 'cancelled' };

export type SubmitScheduleOptions = {
  /**
   * How long the next upload takes. The retry must survive it, so it is added
   * to whichever floor is higher.
   */
  seedAfterMs?: number;
  /**
   * The server's floor relative to the rejection — its clock offset plus its
   * own 10-minute minimum, measured when the refusal arrived. A duration, not
   * an instant, so the limit still advances while the user sits in the dialog.
   */
  serverLeadMs?: number;
  /**
   * Epoch ms of the slot the server refused. The next pick must be strictly
   * later — re-offering the refused value just earns another rejection.
   */
  afterMs?: number;
  /** The refused slot in picker format, for the "pick a later time" copy. */
  afterLabel?: string;
  /** Ask even when the browser clock accepts it — the server rejected it. */
  forcePrompt?: boolean;
  /** Replaces the default "slot is no longer valid" sentence. */
  message?: string;
};

type RetryLimits = {
  /** Required lead beyond the 10-minute floor. */
  extraMs: number;
  uploadMs: number;
  serverLeadMs: number;
  afterMs: number;
  afterLabel: string;
};

/**
 * Promise plumbing for the retry dialog. Call `resolveSubmit` once the bake and
 * staging are done: it returns the ISO time to submit, opens the dialog when
 * the chosen time is stale, and reports a cancelled prompt so the caller can
 * stop without submitting. Render `dialog` somewhere in the composer.
 */
export function useScheduleRetry() {
  const [prompt, setPrompt] = useState<
    (RetryLimits & { message: string; value: string }) | null
  >(null);
  const resolveRef = useRef<((value: string | null) => void) | null>(null);
  const mountedRef = useRef(true);

  const ask = useCallback(
    (message: string, limits: RetryLimits): Promise<string | null> => {
      return new Promise((resolve) => {
        resolveRef.current = resolve;
        // Seeded with the earliest valid slot so one click is enough.
        setPrompt({
          message,
          ...limits,
          value: seedScheduleValue(Date.now(), limits.extraMs, limits.afterMs),
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
      const limits: RetryLimits = {
        extraMs: 0,
        uploadMs: options.seedAfterMs ?? 0,
        serverLeadMs: options.serverLeadMs ?? 0,
        afterMs: options.afterMs ?? 0,
        afterLabel: options.afterLabel ?? '',
      };
      // Whichever floor is higher wins; the upload wait stacks on top of it.
      const requiredLeadMs =
        Math.max(MIN_SCHEDULE_MS, limits.serverLeadMs) + limits.uploadMs;
      limits.extraMs = requiredLeadMs - MIN_SCHEDULE_MS;
      // The direct path skips the dialog, so it must still honour the caller's
      // limits — a supplied lead or refused slot can make an otherwise valid
      // window time fail.
      if (!options.forcePrompt) {
        const direct = resolveScheduledFor(value);
        if (direct.iso !== null) {
          const directMs = new Date(direct.iso).getTime();
          const clearsLead = directMs - Date.now() >= requiredLeadMs;
          const clearsAfter = !limits.afterMs || directMs > limits.afterMs;
          if (clearsLead && clearsAfter) {
            return { kind: 'ok', iso: direct.iso };
          }
        }
      }
      let current = value;
      for (;;) {
        const picked = await ask(
          options.message ?? staleScheduleMessage(current, noun),
          limits
        );
        if (picked === null) return { kind: 'cancelled' };
        const chosen = resolveScheduledFor(picked);
        const chosenMs =
          chosen.iso === null ? null : new Date(chosen.iso).getTime();
        // Judged against the clock at confirm time: a user who waits in the
        // dialog has to pick later, because the next upload lands later too.
        const clearsLead =
          chosenMs !== null && chosenMs - Date.now() >= requiredLeadMs;
        const clearsAfter =
          !limits.afterMs || (chosenMs !== null && chosenMs > limits.afterMs);
        if (chosen.iso !== null && clearsLead && clearsAfter) {
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
      extraMs={prompt.extraMs}
      uploadMs={prompt.uploadMs}
      serverLeadMs={prompt.serverLeadMs}
      afterMs={prompt.afterMs}
      afterLabel={prompt.afterLabel}
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
  extraMs,
  uploadMs,
  serverLeadMs,
  afterMs,
  afterLabel,
  onChange,
  onConfirm,
  onCancel,
}: {
  message: string;
  value: string;
  extraMs: number;
  uploadMs: number;
  serverLeadMs: number;
  afterMs: number;
  afterLabel: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // The window keeps closing while the prompt is open, so the value is judged
  // against the current clock — same as the composer's ScheduleField.
  const now = useScheduleClock();
  const inputRef = useRef<HTMLInputElement>(null);
  const bounds = scheduleBounds(now);
  // The picker's min is the true earliest — confirmation judges against the
  // live clock anyway, so padding it would hide a currently valid minute.
  const min = retryMinimum(now.getTime(), extraMs, afterMs) ?? bounds.min;
  const maxMs = now.getTime() + MAX_SCHEDULE_MS;
  // Local strings drop the offset: a ceiling inside a fall-back's second
  // occurrence parses to the earlier hour and would mark valid times out of
  // range, so the native cap is dropped when it cannot round-trip.
  const max =
    Math.abs(parsedMs(bounds.max) - maxMs) < 60_000 ? bounds.max : undefined;
  const resolution = resolveScheduledFor(value, now);
  const chosenMs =
    resolution.iso === null ? null : new Date(resolution.iso).getTime();
  // A spring-forward day parses a skipped local time as the minute after the
  // gap; submitting that instant would publish an hour off the shown time.
  const roundTrips =
    chosenMs !== null && toLocalInput(new Date(chosenMs)) === value;
  let error: string | null = null;
  if (resolution.iso === null) {
    error = resolution.error;
  } else if (!roundTrips) {
    error = missingLocalTimeMessage(value);
  } else if (afterMs && chosenMs !== null && chosenMs <= afterMs) {
    error = retryAfterMessage(afterLabel);
  } else if (
    chosenMs !== null &&
    serverLeadMs > MIN_SCHEDULE_MS &&
    chosenMs - now.getTime() < serverLeadMs
  ) {
    error = retryFloorMessage(min);
  } else if (
    chosenMs !== null &&
    uploadMs > 0 &&
    chosenMs - now.getTime() < MIN_SCHEDULE_MS + extraMs
  ) {
    error = uploadLeadMessage(uploadMs, MIN_SCHEDULE_MS + extraMs);
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
          max={max}
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
