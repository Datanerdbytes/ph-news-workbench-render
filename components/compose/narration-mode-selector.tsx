"use client";

import { AudioLines, CircleOff, PersonStanding } from "lucide-react";
import { cn } from "@/lib/utils";

export type NarrationMode = "off" | "voice" | "avatar";

const MODES = [
  { id: "off", label: "Off", icon: CircleOff },
  { id: "voice", label: "Voice-over", icon: AudioLines },
  { id: "avatar", label: "Talking avatar", icon: PersonStanding },
] as const;

type NarrationModeSelectorProps = {
  mode: NarrationMode;
  onModeChange: (mode: NarrationMode) => void;
  disabled?: boolean;
};

export function NarrationModeSelector({
  mode,
  onModeChange,
  disabled = false,
}: NarrationModeSelectorProps) {
  return (
    <div className="rounded-xl border border-border/80 bg-muted/20 p-3 sm:p-4">
      <div className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        <AudioLines className="h-4 w-4 text-primary" aria-hidden="true" />
        Narration
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Choose how the current draft should be spoken.
      </p>
      <div
        role="group"
        aria-label="Narration mode"
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {MODES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            onClick={() => onModeChange(id)}
            disabled={disabled}
            className={cn(
              "flex min-h-11 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
              mode === id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background hover:bg-accent",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
