import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type DiskDownload = {
  id: string;
  platform: string;
  filePath: string;
  fileName: string;
  createdAt: number;
};

const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mkv", ".mov", ".m4v"];

/**
 * The worker's Safari conversion writes the H.264 rendition next to the
 * yt-dlp source. The rendition is the one that reached the cloud library, so
 * it is the one that represents the download.
 */
const SAFARI_RENDITION_SUFFIX = " (H.264)";

export function downloadRoot() {
  if (process.env.VIDEO_DOWNLOADER_ROOT) {
    return path.resolve(process.env.VIDEO_DOWNLOADER_ROOT);
  }
  return path.join(os.homedir(), "Downloads", "VideoDownloader");
}

export function diskJobId(relativePath: string) {
  return `disk-${createHash("sha1").update(relativePath).digest("hex").slice(0, 24)}`;
}

function isSafariRendition(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(`${SAFARI_RENDITION_SUFFIX.toLowerCase()}.mp4`);
}

/**
 * Picks the one file that represents a job folder. A folder holds one
 * download, so returning several files for it would list that download more
 * than once.
 */
export function preferredJobFile(fileNames: string[]): string | null {
  if (fileNames.length === 0) return null;
  const rendition = fileNames.find(isSafariRendition);
  if (rendition) return rendition;
  // No rendition: the folder holds a single plain download.
  return fileNames[0];
}

/** Recovers finished downloads from ~/Downloads/VideoDownloader/{platform}/{job}/{file}. */
export async function discoverDiskDownloads(
  root = downloadRoot()
): Promise<DiskDownload[]> {
  let platforms: string[];
  try {
    platforms = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const files: DiskDownload[] = [];
  for (const platform of platforms) {
    let jobs: string[];
    try {
      jobs = (await readdir(path.join(root, platform), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const job of jobs) {
      let names: string[];
      try {
        names = await readdir(path.join(root, platform, job));
      } catch {
        continue;
      }
      const videoNames = names.filter((name) =>
        VIDEO_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))
      );
      // One folder is one download: surface a single file for it. Try the
      // preferred Safari rendition first, but fall back to the source if the
      // rendition is missing, empty, or not a regular file — a failed
      // conversion can leave an empty H.264 file behind that must not hide
      // a valid download.
      const preferred = preferredJobFile(videoNames);
      const candidates = preferred
        ? [preferred, ...videoNames.filter((name) => name !== preferred)]
        : videoNames;
      let file: { filePath: string; fileName: string; createdAt: number } | null = null;
      for (const name of candidates) {
        const filePath = path.join(root, platform, job, name);
        let info;
        try {
          info = await stat(filePath);
        } catch {
          continue;
        }
        if (info.isFile() && info.size > 0) {
          file = { filePath, fileName: name, createdAt: info.mtimeMs };
          break;
        }
      }
      if (!file) continue;
      files.push({
        id: diskJobId(path.join(platform, job, file.fileName)),
        platform,
        filePath: file.filePath,
        fileName: file.fileName,
        createdAt: file.createdAt,
      });
    }
  }
  return files.sort((a, b) => b.createdAt - a.createdAt);
}

export function findDiskDownload(id: string, root = downloadRoot()) {
  if (!id.startsWith("disk-")) return null;
  return discoverDiskDownloads(root).then((files) => files.find((f) => f.id === id) ?? null);
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

export function videoContentType(fileName: string) {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "video/mp4";
}

/** Shapes a recovered file like a finished job so the page renders it directly. */
export function publicDiskDownload(disk: DiskDownload) {
  return {
    id: disk.id,
    platform: disk.platform,
    quality: "",
    status: "done" as const,
    progress: null,
    statusMessage: "",
    fileName: disk.fileName,
    saveLocation: disk.filePath,
    error: null,
    createdAt: disk.createdAt,
    source: "disk" as const,
  };
}
