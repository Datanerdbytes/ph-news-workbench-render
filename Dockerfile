# syntax=docker/dockerfile:1

# --- deps: resolve the lockfile once, cached across code changes -----------
FROM node:22-slim AS deps
WORKDIR /app
# husky's prepare step needs a .git dir the container does not have
ENV HUSKY=0
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

# --- builder: compile the standalone server bundle -------------------------
FROM node:22-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 HUSKY=0
# NEXT_PUBLIC_* is inlined into the client bundle at build time. HF Spaces
# cannot inject build args — to switch the staging driver there, change the
# ARG defaults below and re-push (see README → "Storage drivers").
ARG NEXT_PUBLIC_STORAGE_DRIVER=blob
ARG NEXT_PUBLIC_BLOB_ROOT=
ENV NEXT_PUBLIC_STORAGE_DRIVER=$NEXT_PUBLIC_STORAGE_DRIVER \
    NEXT_PUBLIC_BLOB_ROOT=$NEXT_PUBLIC_BLOB_ROOT
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runner: standalone output + ffmpeg, non-root uid 1000 -----------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=7860 \
    HOSTNAME=0.0.0.0
# ffmpeg powers /api/reels/prepare (reel normalization) when
# ENABLE_LOCAL_VIDEO_PROCESSING=1 — remove this line for a ~200MB slimmer
# image that falls back to using the original video untouched.
#
# The apt versions are not pinned: the image is rebuilt on every deploy and a
# pinned version disappears from the mirror as soon as Debian publishes a new
# revision, which breaks the build rather than hardening it.
# hadolint ignore=DL3008
# bubblewrap + socat + ripgrep power the verified isolation runner for
# native media processes (lib/live/media-sandbox.ts): the sandboxed source
# side has NO direct network access — every connection is forced through the
# sandbox's local filtering proxies. ripgrep is a required Linux dependency
# of the sandbox runtime itself.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
       bubblewrap socat ripgrep librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp resolves public video links behind the Live Page's Source URL field
# (lib/live/resolve.ts runs `yt-dlp -J --no-playlist <url>`). The official
# static Linux binary is pinned to one release so the artifact is reproducible
# and Trivy scans of the image stay clean — bump the pin deliberately, and
# check the release notes for CVE fixes when you do. The release ships one
# binary per architecture: the deploy target (Render) is amd64, and a local
# build on an Apple-silicon Mac is arm64, so the download follows BuildKit's
# TARGETARCH instead of assuming x86-64. TARGETARCH is declared without a
# default on purpose: a default here would shadow the value BuildKit injects
# for the target platform, and the amd64 binary does not run under Rosetta.
ARG YTDLP_VERSION=2026.10.26
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      arm64) YTDLP_ASSET=yt-dlp_linux_aarch64 ;; \
      *) YTDLP_ASSET=yt-dlp_linux ;; \
    esac \
    && curl -fsSL \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_ASSET}" \
      -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && yt-dlp --version
# Hugging Face Spaces require the container to run as uid 1000; the base
# image's `node` user is exactly that, so reuse it. The numeric form is what
# the runtime resolves to anyway, and hadolint cannot look a name up.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER 1000:1000
EXPOSE 7860
CMD ["node", "server.js"]
