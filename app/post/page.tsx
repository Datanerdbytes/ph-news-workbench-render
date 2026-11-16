'use client';

import { useState } from 'react';
import {
  Link2,
  PenLine,
  Play,
  SendHorizontal,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { AssistantChat } from '@/components/assistant-chat';
import { FacebookPreview } from '@/components/facebook-preview';
import { useFacebookConnection } from '@/components/facebook-connection';
import { Button } from '@/components/ui/button';
import {
  ComposerCard,
  FieldLabel,
  FilePicker,
  PageSelector,
  PublishPage,
  ResultList,
  ScheduleField,
  defaultScheduleValue,
  inputClass,
  mediaFileError,
  textareaClass,
  useManagedPages,
  type PublishResult,
} from '@/components/publishing/publish-page';
import { resolveScheduledFor } from '@/lib/publishing/schedule';
import {
  MediaPreviewCard,
  MediaPreviewMedia,
} from '@/components/publishing/media-preview-card';

const MAX_MESSAGE_LENGTH = 5000;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

type PostPublishResponse = {
  results?: PublishResult[];
  warning?: string;
  error?: string;
};

export default function PostPage() {
  const pages = useManagedPages();
  const connection = useFacebookConnection();
  const [message, setMessage] = useState('');
  const [link, setLink] = useState('');
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduledFor, setScheduledFor] = useState(defaultScheduleValue);
  const [scheduleError, setScheduleError] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PublishResult[] | null>(null);
  // Optional video attachment: with one present the post publishes through
  // /api/videos with the message as the video's description — Facebook has
  // no "text post with a video attached" type on the Graph API.
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);

  function applyVideoFile(next: File | null) {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoFile(next);
    setVideoUrl(next ? URL.createObjectURL(next) : null);
    setPreviewFailed(false);
    // Video posts don't carry a link share — drop any typed link on attach.
    if (next) setLink('');
  }

  const selectedPage = pages.pages.find((page) => page.id === pages.selected[0]);
  const canPublish = message.trim().length > 0;

  async function post() {
    if (!canPublish) return;
    let scheduledForIso: string | null = null;
    if (scheduleOn) {
      const schedule = resolveScheduledFor(scheduledFor);
      if (schedule.iso === null) {
        setScheduleError(schedule.error);
        return;
      }
      scheduledForIso = schedule.iso;
      setScheduleError('');
    }
    setBusy(true);
    setResults(null);
    try {
      let data: PostPublishResponse | null;
      if (videoFile) {
        const form = new FormData();
        form.append('video', videoFile);
        form.append('description', message);
        if (scheduledForIso) form.append('scheduledFor', scheduledForIso);
        form.append('pageIds', JSON.stringify(pages.selected));
        // Real upload progress for the browser→workbench leg, same as the
        // Videos composer; the chunked workbench→Facebook leg that follows
        // is the "Publishing…" phase.
        data = await new Promise<PostPublishResponse | null>(
          (resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/videos');
            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable) {
                setUploadPct(Math.round((event.loaded / event.total) * 100));
              }
            };
            xhr.onload = () => {
              let body: PostPublishResponse | null = null;
              try {
                body = JSON.parse(xhr.responseText) as PostPublishResponse;
              } catch {
                body = null;
              }
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve(body ?? {});
              } else {
                reject(
                  new Error(body?.error ?? 'The post could not be published.')
                );
              }
            };
            xhr.onerror = () =>
              reject(new Error('The post could not be published.'));
            xhr.send(form);
          },
        );
      } else {
        const res = await fetch('/api/posts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message,
            link: link.trim(),
            pageIds: pages.selected,
            ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
          }),
        });
        data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.error ?? 'The post could not be published.');
        }
      }
      setResults(data?.results ?? []);
      toast.success(scheduleOn ? 'Post scheduled' : 'Post published', {
        description: data?.warning,
      });
      setMessage('');
      setLink('');
      // The next post publishes now unless scheduling is deliberately re-enabled.
      setScheduleOn(false);
      setScheduleError('');
      applyVideoFile(null);
    } catch (error) {
      toast.error('Post failed', {
        description:
          error instanceof Error ? error.message : 'The post could not be published.',
      });
    } finally {
      setBusy(false);
      setUploadPct(null);
    }
  }

  return (
    <PublishPage eyebrow="Publishing" title="Post">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
      <ComposerCard
        icon={<PenLine className="size-4" />}
        title="New post"
        badge={videoFile ? 'Text + video' : 'Text post'}
      >
        <div>
          <FieldLabel htmlFor="post-message" hint={`${message.length}/${MAX_MESSAGE_LENGTH}`}>
            Message
          </FieldLabel>
          <textarea
            id="post-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={8}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Write the post…"
            className={textareaClass}
          />
        </div>

        <FilePicker
          id="post-video"
          accept="video/mp4,video/quicktime"
          label={videoFile ? 'Replace video' : 'Attach a video — optional'}
          hint="MP4/MOV · 1 GB max"
          file={videoFile}
          onPick={applyVideoFile}
          onClear={() => applyVideoFile(null)}
          icon={<Upload className="size-3.5" />}
          validate={(picked) =>
            mediaFileError(picked, {
              types: ['video/mp4', 'video/quicktime'],
              extensions: ['.mp4', '.mov'],
              typeLabel: 'an MP4 or MOV file',
              maxBytes: MAX_VIDEO_BYTES,
              maxLabel: '1 GB',
            })
          }
        />

        {!videoFile && (
          <div>
            <FieldLabel htmlFor="post-link" hint="Optional">
              Link
            </FieldLabel>
            <div className="relative">
              <Link2
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint"
                aria-hidden
              />
              <input
                id="post-link"
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="https://…"
                className={`${inputClass} pl-8`}
                type="url"
              />
            </div>
          </div>
        )}

        <PageSelector
          pages={pages.pages}
          selected={pages.selected}
          onSelect={pages.selectOne}
          loading={pages.loading}
        />

        <ScheduleField
          enabled={scheduleOn}
          onEnabled={setScheduleOn}
          value={scheduledFor}
          onChange={(next) => {
            setScheduledFor(next);
            setScheduleError('');
          }}
          error={scheduleError}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="brand"
            size="sm"
            onClick={post}
            disabled={!canPublish || busy || !pages.selected.length}
          >
            <SendHorizontal className="size-3.5" aria-hidden />
            {busy
              ? uploadPct != null && uploadPct < 100
                ? `Uploading ${uploadPct}%…`
                : 'Publishing…'
              : scheduleOn
                ? 'Schedule post'
                : 'Publish post'}
          </Button>
        </div>

        <ResultList results={results ?? []} />
      </ComposerCard>
        </div>

        <div className="self-start xl:sticky xl:top-[70px]">
          {videoFile && videoUrl && !previewFailed ? (
            <MediaPreviewCard
              statusLabel="Ready to publish"
              ready
              label="Video"
              footer={
                <p className="truncate text-[12px] font-semibold">
                  {videoFile.name}
                </p>
              }
            >
              <MediaPreviewMedia className="aspect-video">
                <video
                  key={videoUrl}
                  src={videoUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onError={() => setPreviewFailed(true)}
                  className="h-full w-full object-contain"
                />
              </MediaPreviewMedia>
            </MediaPreviewCard>
          ) : (
            <FacebookPreview
              text={message}
              link={link.trim() || undefined}
              connected={connection.connected}
              pageName={selectedPage?.name}
              pagePicture={selectedPage?.picture}
            />
          )}
        </div>
      </div>
      <AssistantChat
        draft={message}
        onDraftChange={setMessage}
        contextLabel="post message (5,000 character limit)"
      />
    </PublishPage>
  );
}
