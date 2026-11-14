import { upload } from '@vercel/blob/client';

/**
 * Browser-side staging helper. `@vercel/blob/client` uploads straight from
 * the browser to the Blob store; the s3 and hf drivers need a small hop
 * through `/api/stage` instead (presigned PUT for s3, a multipart stream for
 * hf). The composer pages call `stageUpload` and get back the same `.url`
 * contract regardless of which driver the server picked.
 *
 * The driver for the CLIENT half is inlined at build time from
 * NEXT_PUBLIC_STORAGE_DRIVER (default "blob") — switching drivers means a
 * rebuild, because HF Docker Spaces cannot inject build-time env.
 */

export type StagedUploadResult = {
  url: string;
  pathname: string;
  contentType: string;
};

export type StageUploadOptions = {
  contentType?: string;
  onUploadProgress?: (progress: { percentage: number }) => void;
};

const CLIENT_DRIVER = (process.env.NEXT_PUBLIC_STORAGE_DRIVER ?? 'blob').trim();

export async function stageUpload(
  pathname: string,
  file: File | Blob,
  options: StageUploadOptions = {}
): Promise<StagedUploadResult> {
  if (CLIENT_DRIVER === 'blob') {
    return upload(pathname, file, {
      access: 'public',
      handleUploadUrl: '/api/blob',
      contentType: options.contentType,
      onUploadProgress: options.onUploadProgress,
    });
  }
  if (CLIENT_DRIVER === 's3') {
    return stageViaPresignedPut(pathname, file, options);
  }
  return stageViaServer(pathname, file, options);
}

async function stageViaPresignedPut(
  pathname: string,
  file: File | Blob,
  options: StageUploadOptions
): Promise<StagedUploadResult> {
  const contentType =
    options.contentType ?? (file as File).type ?? 'application/octet-stream';
  const response = await fetch('/api/stage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pathname,
      contentType,
      size: file.size,
    }),
  });
  if (!response.ok) {
    throw new Error(await stageErrorMessage(response));
  }
  const { uploadUrl, publicUrl } = (await response.json()) as {
    uploadUrl: string;
    publicUrl: string;
  };
  await xhrSend(uploadUrl, 'PUT', file, contentType, options.onUploadProgress);
  return { url: publicUrl, pathname, contentType };
}

async function stageViaServer(
  pathname: string,
  file: File | Blob,
  options: StageUploadOptions
): Promise<StagedUploadResult> {
  const contentType =
    options.contentType ?? (file as File).type ?? 'application/octet-stream';
  const form = new FormData();
  form.append('pathname', pathname);
  form.append('file', file, (file as File).name ?? 'upload.bin');
  const text = await xhrSend(
    '/api/stage',
    'POST',
    form,
    undefined,
    options.onUploadProgress
  );
  const { url } = JSON.parse(text) as { url: string };
  return { url, pathname, contentType };
}

function xhrSend(
  url: string,
  method: 'PUT' | 'POST',
  body: File | Blob | FormData,
  contentType: string | undefined,
  onUploadProgress?: (progress: { percentage: number }) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    // Presigned PUTs must send the exact Content-Type that was signed; the
    // multipart POST sets its own boundary, so only PUT gets the header.
    if (contentType && method === 'PUT') {
      xhr.setRequestHeader('Content-Type', contentType);
    }
    if (onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onUploadProgress({
            percentage: Math.round((event.loaded / event.total) * 100),
          });
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
      } else {
        reject(new Error(`The upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('The upload failed.'));
    xhr.send(body);
  });
}

async function stageErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return body?.error ?? 'The upload was rejected.';
}
