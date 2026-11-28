"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { AppFrame } from "@/components/app-frame";
import { useFacebookConnection } from "@/components/facebook-connection";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  PageAvatar,
  useManagedPages,
} from "@/components/publishing/page-selection";
import { cn } from "cn";
import { authClient } from "@/lib/auth-client";
import { validateNewPassword } from "@/lib/password";
import { isTextModel, textModelLabel, TEXT_MODELS } from "@/lib/models";
import { isThemeId, THEMES, type ThemeId } from "@/lib/themes";
import {
  DEFAULT_TTS_PROVIDER,
  isTtsProviderId,
  MAX_ASSEMBLYAI_CLONED_VOICES,
  MAX_ASSEMBLYAI_VOICE_ID_LENGTH,
  normalizeAssemblyAiVoiceIds,
  TTS_PROVIDERS,
  type TtsProviderId,
} from "@/lib/tts/providers";

type WorkspaceInfo = {
  id: string;
  name: string;
  role: string;
  memberCount: number;
  aiModel: string | null;
  defaultModel: string;
  ttsProvider: TtsProviderId;
  ttsConfigured: boolean;
  assemblyAiKeyConfigured: boolean;
  assemblyAiVoiceIds: string[];
};

/**
 * Picks which connected Page every composer starts on. Writes the workspace's
 * `is_primary` flag through the shared page-selection store, so the sidebar
 * and every composer reflect the change immediately.
 */
function DefaultPagePicker({ connected }: { connected: boolean }) {
  const { pages, setPrimaryPage } = useManagedPages();
  const [saving, setSaving] = useState(false);

  async function choose(pageId: string) {
    setSaving(true);
    try {
      await setPrimaryPage(pageId);
      toast.success("Default publishing page updated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save the default."
      );
    } finally {
      setSaving(false);
    }
  }

  if (!connected || !pages.length) return null;

  return (
    <div className="mt-3">
      <p className="text-[11px] font-semibold">Default publishing page</p>
      <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
        Every composer starts on this page. Switch pages per post right inside
        the composer.
      </p>
      <div
        role="radiogroup"
        aria-label="Default publishing page"
        className="mt-2 flex flex-wrap gap-1.5"
      >
        {pages.map((page) => (
          <button
            key={page.id}
            type="button"
            role="radio"
            aria-checked={page.primary}
            disabled={saving}
            onClick={() => void choose(page.id)}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-2.5 text-xs font-semibold transition-colors disabled:opacity-60",
              page.primary
                ? "border-ink bg-ink text-paper"
                : "border-border bg-background text-muted-foreground hover:text-foreground"
            )}
          >
            <PageAvatar page={page} className="size-[18px] text-[8px]" />
            <span className="max-w-[150px] truncate">{page.name}</span>
            {page.primary && (
              <span className="rounded-full bg-white/15 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider">
                Default
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceError, setWorkspaceError] = useState(false);
  const [prefsError, setPrefsError] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [assemblyAiKey, setAssemblyAiKey] = useState("");
  const [assemblyAiVoiceIdsText, setAssemblyAiVoiceIdsText] = useState("");
  const [savingTts, setSavingTts] = useState(false);
  const [ttsError, setTtsError] = useState("");
  const [theme, setTheme] = useState<ThemeId>("ink-white");
  // The <html> data-theme attribute derives from the saved preference state —
  // one writer, covering initial load, optimistic switches, and reverts.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [savingTheme, setSavingTheme] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const { data: session } = authClient.useSession();
  const connection = useFacebookConnection();

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/workspace", { signal: controller.signal, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) {
          setWorkspaceError(true);
          return;
        }
        setWorkspace(data);
        setAssemblyAiVoiceIdsText(
          Array.isArray(data.assemblyAiVoiceIds)
            ? data.assemblyAiVoiceIds.join("\n")
            : "",
        );
        setTtsError("");
        setName(data.name ?? "");
        // A workspace saved under the old NIM catalog can still carry a model
        // id this build does not know. Show the model drafts actually use.
        const stored = typeof data.aiModel === "string" ? data.aiModel.trim() : "";
        setModel(
          stored && isTextModel(stored) ? stored : data.defaultModel ?? ""
        );
        setWorkspaceError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setWorkspaceError(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/preferences", { signal: controller.signal, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && isThemeId(data.theme)) {
          setTheme(data.theme);
          setPrefsError(false);
        } else if (!data) {
          setPrefsError(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setPrefsError(true);
      });
    return () => controller.abort();
  }, []);

  async function changeTheme(next: ThemeId) {
    if (next === theme || savingTheme) return;
    const previous = theme;
    setTheme(next);
    setSavingTheme(true);
    try {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save the theme.");
      toast.success("Theme updated", {
        description: `Now using ${THEMES.find((option) => option.id === next)?.label}.`,
      });
    } catch (error) {
      setTheme(previous);
      toast.error("Could not save", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setSavingTheme(false);
    }
  }

  async function saveWorkspace(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!workspace || trimmed === workspace.name) return;
    setSaving(true);
    try {
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save the workspace.");
      setWorkspace((current) =>
        current ? { ...current, name: data.name } : current
      );
      toast.success("Workspace updated", {
        description: `Now called "${data.name}".`,
      });
    } catch (error) {
      toast.error("Could not save", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function changeModel(next: string) {
    if (!workspace || next === model) return;
    const previous = model;
    setModel(next);
    setSavingModel(true);
    try {
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiModel: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save the model.");
      setWorkspace((current) =>
        current ? { ...current, aiModel: data.aiModel } : current
      );
      toast.success("AI model updated", {
        description: `New drafts use ${textModelLabel(next)}.`,
      });
    } catch (error) {
      setModel(previous);
      toast.error("Could not save", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setSavingModel(false);
    }
  }

  async function changeTtsProvider(next: TtsProviderId) {
    if (
      !workspace ||
      workspace.role !== "owner" ||
      savingTts ||
      next === workspace.ttsProvider
    ) {
      return;
    }
    if (next === "assemblyai" && !workspace.assemblyAiKeyConfigured) {
      setTtsError("Save an AssemblyAI API key below before switching providers.");
      return;
    }

    setSavingTts(true);
    setTtsError("");
    try {
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttsProvider: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not change the provider.");
      setWorkspace((current) =>
        current
          ? {
              ...current,
              ttsProvider: next,
              ttsConfigured: Boolean(data.ttsConfigured),
              assemblyAiKeyConfigured: Boolean(data.assemblyAiKeyConfigured),
            }
          : current,
      );
      toast.success("Voice-over provider updated", {
        description: `Compose will use ${TTS_PROVIDERS.find((provider) => provider.id === next)?.label}.`,
      });
    } catch (error) {
      setTtsError(
        error instanceof Error ? error.message : "Could not change the provider.",
      );
    } finally {
      setSavingTts(false);
    }
  }

  async function saveAssemblyAiKey(event: React.FormEvent) {
    event.preventDefault();
    const key = assemblyAiKey.trim();
    if (!workspace || workspace.role !== "owner" || !key || savingTts) return;

    setSavingTts(true);
    setTtsError("");
    try {
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assemblyaiApiKey: key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save the API key.");
      setAssemblyAiKey("");
      setWorkspace((current) =>
        current
          ? {
              ...current,
              assemblyAiKeyConfigured: Boolean(data.assemblyAiKeyConfigured),
              ttsConfigured: Boolean(data.ttsConfigured),
            }
          : current,
      );
      toast.success("AssemblyAI API key saved", {
        description: "The key is encrypted and is never shown again.",
      });
    } catch (error) {
      setTtsError(
        error instanceof Error ? error.message : "Could not save the API key.",
      );
    } finally {
      setSavingTts(false);
    }
  }

  async function removeAssemblyAiKey() {
    if (!workspace || workspace.role !== "owner" || savingTts) return;
    setSavingTts(true);
    setTtsError("");
    try {
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assemblyaiApiKey: null,
          ...(workspace.ttsProvider === "assemblyai"
            ? { ttsProvider: "azure" }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not remove the API key.");
      setAssemblyAiKey("");
      setWorkspace((current) =>
        current
          ? {
              ...current,
              ttsProvider: isTtsProviderId(data.ttsProvider)
                ? data.ttsProvider
                : current.ttsProvider,
              ttsConfigured: Boolean(data.ttsConfigured),
              assemblyAiKeyConfigured: false,
            }
          : current,
      );
      toast.success("AssemblyAI API key removed");
    } catch (error) {
      setTtsError(
        error instanceof Error ? error.message : "Could not remove the API key.",
      );
    } finally {
      setSavingTts(false);
    }
  }

  async function saveAssemblyAiVoiceIds(event: React.FormEvent) {
    event.preventDefault();
    const voiceIds = normalizeAssemblyAiVoiceIds(
      assemblyAiVoiceIdsText
        .split(/\r?\n/)
        .map((voiceId) => voiceId.trim())
        .filter(Boolean),
    );
    if (!workspace || workspace.role !== "owner" || savingTts) return;
    if (!voiceIds) {
      setTtsError(
        `Enter up to ${MAX_ASSEMBLYAI_CLONED_VOICES} valid AssemblyAI voice IDs, each no longer than ${MAX_ASSEMBLYAI_VOICE_ID_LENGTH} characters.`,
      );
      return;
    }

    setSavingTts(true);
    setTtsError("");
    try {
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assemblyaiVoiceIds: voiceIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save the voice IDs.");
      const savedVoiceIds = Array.isArray(data.assemblyAiVoiceIds)
        ? data.assemblyAiVoiceIds
        : voiceIds;
      setAssemblyAiVoiceIdsText(savedVoiceIds.join("\n"));
      setWorkspace((current) =>
        current ? { ...current, assemblyAiVoiceIds: savedVoiceIds } : current,
      );
      toast.success(
        savedVoiceIds.length ? "AssemblyAI cloned voices saved" : "AssemblyAI cloned voices removed",
        {
          description: savedVoiceIds.length
            ? "These voices are now available in Compose."
            : "Compose will use the built-in AssemblyAI voices.",
        },
      );
    } catch (error) {
      setTtsError(
        error instanceof Error ? error.message : "Could not save the voice IDs.",
      );
    } finally {
      setSavingTts(false);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    const validation = validateNewPassword(newPassword, confirmPassword);
    if (validation) {
      toast.error("Check the new password", { description: validation });
      return;
    }

    setSavingPassword(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (error) throw new Error(error.message ?? "Could not update the password.");
      toast.success("Password updated", {
        description: "Other signed-in devices were signed out.",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      toast.error("Could not update the password", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setSavingPassword(false);
    }
  }

  const isOwner = workspace?.role === "owner";

  return (
    <AppFrame>
      <div className="mx-auto w-full max-w-[880px] px-4 py-6 sm:px-6 lg:py-7">
        <p className="eyebrow">Manage</p>
        <h1 className="page-title mt-1">Settings</h1>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Workspace identity, your account and the publishing connection.
        </p>

        <section className="mt-5 rounded-xl border border-border bg-card p-4">
          <h2 className="text-[13px] font-semibold">Workspace</h2>
          <p className="text-[10.5px] text-muted-foreground">
            {isOwner
              ? "Shown across the sidebar and shared with your team."
              : "Only workspace owners can rename the workspace."}
          </p>
          {workspaceError && (
            <p className="mt-1.5 text-[11px] text-destructive">
              Couldn&apos;t load your workspace settings — values below may be
              out of date.
            </p>
          )}
          <form onSubmit={saveWorkspace} className="mt-3 flex flex-wrap gap-2">
            <label className="sr-only" htmlFor="workspace-name">
              Workspace name
            </label>
            <input
              id="workspace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!isOwner || saving}
              maxLength={60}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            />
            <Button
              type="submit"
              disabled={!isOwner || saving || name.trim() === workspace?.name}
              className="h-9"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[10.5px] text-muted-foreground">
            <span>
              Your role:{" "}
              <strong className="font-semibold text-foreground">
                {isOwner ? "Owner" : "Editor"}
              </strong>
            </span>
            <span>
              Members:{" "}
              <strong className="font-semibold text-foreground">
                {workspace?.memberCount ?? "—"}
              </strong>
            </span>
          </div>
        </section>

        <section className="mt-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-[13px] font-semibold">Account</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                Name
              </dt>
              <dd className="mt-0.5 text-[12.5px] font-medium">
                {session?.user?.name ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                Email
              </dt>
              <dd className="mt-0.5 truncate text-[12.5px] font-medium">
                {session?.user?.email ?? "—"}
              </dd>
            </div>
          </dl>
        </section>

        <section className="mt-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-[13px] font-semibold">Password</h2>
          <p className="text-[10.5px] text-muted-foreground">
            Changing the password signs out your other devices.
          </p>
          <form onSubmit={changePassword} className="mt-3 grid gap-2 sm:max-w-md">
            <label className="sr-only" htmlFor="current-password">
              Current password
            </label>
            <input
              id="current-password"
              type="password"
              name="current-password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={savingPassword}
              required
              placeholder="Current password"
              className="h-9 rounded-lg border border-border bg-background px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            />
            <label className="sr-only" htmlFor="new-password">
              New password (at least 8 characters)
            </label>
            <input
              id="new-password"
              type="password"
              name="new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={savingPassword}
              required
              minLength={8}
              placeholder="New password (at least 8 characters)"
              className="h-9 rounded-lg border border-border bg-background px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            />
            <label className="sr-only" htmlFor="confirm-password">
              Confirm new password
            </label>
            <input
              id="confirm-password"
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={savingPassword}
              required
              placeholder="Confirm new password"
              className="h-9 rounded-lg border border-border bg-background px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            />
            <div>
              <Button
                type="submit"
                disabled={
                  savingPassword ||
                  !currentPassword ||
                  !newPassword ||
                  !confirmPassword
                }
                className="h-9"
              >
                {savingPassword ? "Updating…" : "Update password"}
              </Button>
            </div>
          </form>
        </section>

        <section className="mt-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-[13px] font-semibold">Appearance</h2>
          <p className="text-[10.5px] text-muted-foreground">
            Color combination for your account. Applies everywhere you sign in.
          </p>
          {prefsError && (
            <p className="mt-1.5 text-[11px] text-destructive">
              Couldn&apos;t load your saved theme — showing the default until
              it loads.
            </p>
          )}
          <div
            className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
            role="radiogroup"
            aria-label="Theme"
          >
            {THEMES.map((option) => {
              const selected = option.id === theme;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={savingTheme}
                  onClick={() => void changeTheme(option.id)}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60 ${
                    selected
                      ? "border-ring bg-brand-soft/60 ring-2 ring-ring/30"
                      : "border-border hover:bg-surface-2"
                  }`}
                >
                  <span className="flex shrink-0 items-center -space-x-1">
                    <span
                      className="size-5 rounded-full border border-border"
                      style={{ background: option.background }}
                    />
                    <span
                      className="size-5 rounded-full border border-white/60"
                      style={{ background: option.brand }}
                    />
                    <span
                      className="size-5 rounded-full border border-white/60"
                      style={{ background: option.accent }}
                    />
                  </span>
                  <span className="min-w-0 flex-1 text-[12px] font-medium">
                    {option.label}
                  </span>
                  {selected && (
                    <Check className="size-4 shrink-0 text-brand-accent" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-[13px] font-semibold">AI model</h2>
          <p className="text-[10.5px] text-muted-foreground">
            {isOwner
              ? "Free OpenRouter model that writes drafts for this workspace."
              : "Only workspace owners can change the model."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="ai-model">
              AI model
            </label>
            <select
              id="ai-model"
              value={model}
              onChange={(event) => void changeModel(event.target.value)}
              disabled={!isOwner || savingModel || !model}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            >
              {TEXT_MODELS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {savingModel && (
              <span className="text-[10.5px] text-muted-foreground">
                Saving…
              </span>
            )}
          </div>
          <p className="mt-2 text-[10.5px] text-muted-foreground">
            {TEXT_MODELS.find((option) => option.id === model)?.detail ??
              "Served through OpenRouter's free tier."}
          </p>
        </section>

        <section id="text-to-speech" className="mt-3 scroll-mt-6 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold">Text-to-speech</h2>
            {savingTts && (
              <span className="text-[10.5px] text-muted-foreground">Saving…</span>
            )}
          </div>
          <p className="mt-0.5 text-[10.5px] text-muted-foreground">
            {isOwner
              ? "Choose the voice-over provider used by every composer in this workspace."
              : "Only workspace owners can change the voice-over provider."}
          </p>
          <div
            className="mt-3 grid gap-2 sm:grid-cols-2"
            role="radiogroup"
            aria-label="Text-to-speech provider"
          >
            {TTS_PROVIDERS.map((provider) => {
              const selected = provider.id === (workspace?.ttsProvider ?? DEFAULT_TTS_PROVIDER);
              return (
                <button
                  key={provider.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!isOwner || savingTts}
                  onClick={() => void changeTtsProvider(provider.id)}
                  className={cn(
                    "flex min-h-11 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60",
                    selected
                      ? "border-ring bg-brand-soft/60 ring-2 ring-ring/30"
                      : "border-border hover:bg-surface-2",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold">{provider.label}</span>
                    <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-foreground">
                      {provider.detail}
                    </span>
                  </span>
                  {selected && (
                    <Check className="size-4 shrink-0 text-brand-accent" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
            {!workspace
              ? "Loading the saved provider…"
              : workspace.ttsConfigured
                ? `${TTS_PROVIDERS.find((provider) => provider.id === workspace.ttsProvider)?.label} is ready for voice-over generation.`
                : workspace.ttsProvider === "azure"
                  ? "Azure Speech is selected. Add AZURE_SPEECH_KEY and AZURE_SPEECH_REGION to the server environment to enable it."
                  : "AssemblyAI is selected but no API key is saved."}
          </p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
            Provider changes apply to the next voice-over. Regenerate existing narration afterward. Talking avatars always use Azure Speech.
          </p>

          <form
            onSubmit={saveAssemblyAiKey}
            className="mt-4 space-y-2 border-t border-border/60 pt-4"
          >
            <label htmlFor="assemblyai-api-key" className="block text-[11px] font-semibold">
              AssemblyAI API key
            </label>
            <p id="assemblyai-key-help" className="text-[10.5px] leading-relaxed text-muted-foreground">
              Save your key before selecting AssemblyAI. It is encrypted at rest and never returned to the browser.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                id="assemblyai-api-key"
                type="password"
                autoComplete="off"
                value={assemblyAiKey}
                onChange={(event) => setAssemblyAiKey(event.target.value)}
                disabled={!isOwner || savingTts}
                aria-describedby="assemblyai-key-help tts-settings-error"
                maxLength={4096}
                placeholder={
                  workspace?.assemblyAiKeyConfigured
                    ? "Enter a new key to replace the saved key"
                    : "Paste your AssemblyAI API key"
                }
                className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
              />
              <Button
                type="submit"
                disabled={!isOwner || savingTts || !assemblyAiKey.trim()}
                className="h-11"
              >
                {savingTts ? "Saving…" : "Save key"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10.5px] text-muted-foreground">
                {workspace?.assemblyAiKeyConfigured
                  ? "API key saved."
                  : "No AssemblyAI API key saved."}
              </span>
              {workspace?.assemblyAiKeyConfigured ? (
                <ConfirmButton
                  variant="ghost"
                  className="h-11"
                  onConfirm={removeAssemblyAiKey}
                  disabled={!isOwner || savingTts}
                  confirmLabel="Confirm removal"
                  busyLabel="Removing…"
                >
                  Remove key
                </ConfirmButton>
              ) : null}
            </div>
            <p className="text-[10.5px] leading-relaxed text-muted-foreground">
              Removing the key switches an active AssemblyAI workspace back to Azure Speech.
            </p>
          </form>
          <form
            onSubmit={saveAssemblyAiVoiceIds}
            className="mt-4 space-y-2 border-t border-border/60 pt-4"
          >
            <label htmlFor="assemblyai-voice-ids" className="block text-[11px] font-semibold">
              AssemblyAI cloned voice IDs
            </label>
            <p id="assemblyai-voices-help" className="text-[10.5px] leading-relaxed text-muted-foreground">
              Paste one cloned voice ID per line from AssemblyAI. Saved IDs appear in Compose when AssemblyAI is selected and work with English voice-over only.
            </p>
            <textarea
              id="assemblyai-voice-ids"
              value={assemblyAiVoiceIdsText}
              onChange={(event) => setAssemblyAiVoiceIdsText(event.target.value)}
              disabled={!isOwner || savingTts}
              aria-describedby="assemblyai-voices-help tts-settings-error"
              rows={4}
              maxLength={MAX_ASSEMBLYAI_CLONED_VOICES * (MAX_ASSEMBLYAI_VOICE_ID_LENGTH + 1)}
              autoComplete="off"
              spellCheck={false}
              placeholder={"cloned-voice-id-or-uuid\nanother-cloned-voice-id"}
              className="min-h-11 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10.5px] text-muted-foreground">
                {workspace?.assemblyAiVoiceIds?.length ?? 0} cloned voice{workspace?.assemblyAiVoiceIds?.length === 1 ? "" : "s"} saved.
              </span>
              <Button
                type="submit"
                disabled={!isOwner || savingTts}
                className="h-11"
              >
                {savingTts ? "Saving…" : "Save voice IDs"}
              </Button>
            </div>
          </form>
          <p
            id="tts-settings-error"
            role="alert"
            className={cn(
              "mt-2 text-[11px] text-destructive",
              !ttsError && "hidden",
            )}
          >
            {ttsError}
          </p>
        </section>

        <section className="mt-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-[13px] font-semibold">Publishing</h2>
          <p className="text-[10.5px] text-muted-foreground">
            The Facebook Page this workspace publishes to.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <span className="grid size-8 place-items-center rounded-md bg-facebook text-[11px] font-bold text-white">
              f
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold">
                {connection.loading
                  ? "Checking…"
                  : connection.connected
                    ? (connection.page?.name ?? "Facebook Page")
                    : "No Page connected"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {connection.connected
                  ? "Ready to publish and schedule"
                  : "Connect a Page to publish"}
              </p>
            </div>
            {connection.connected ? (
              <ConfirmButton
                variant="outline"
                className="h-8"
                onConfirm={() => connection.disconnect()}
                disabled={connection.refreshing}
                confirmLabel="Confirm disconnect"
                busyLabel="Disconnecting…"
              >
                Disconnect
              </ConfirmButton>
            ) : (
              <Button
                type="button"
                className="h-8"
                disabled={connection.loading}
                onClick={connection.connect}
              >
                Connect
              </Button>
            )}
          </div>
          <DefaultPagePicker connected={connection.connected} />
        </section>

        <Link
          href="/team"
          className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="grid size-8 place-items-center rounded-lg bg-surface-3 text-secondary-foreground">
            <UserPlus className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-semibold">Team &amp; invites</p>
            <p className="text-[10.5px] text-muted-foreground">
              Add editors and manage pending invites
            </p>
          </div>
          <ChevronRight className="size-4 text-faint" aria-hidden />
        </Link>
      </div>
    </AppFrame>
  );
}
