import { open, type FileHandle } from 'node:fs/promises';

// Reads the track duration from an MP4/MOV container's mvhd atom so the
// server can enforce Reel length without a media library.
type BoxRange = { start: number; end: number };

function findBox(
  buffer: Buffer,
  from: number,
  to: number,
  type: string
): BoxRange | null {
  let offset = from;
  while (offset + 8 <= to) {
    let size = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) return null;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) return null;
    if (boxType === type) {
      return { start: offset + header, end: offset + size };
    }
    offset += size;
  }
  return null;
}

export function readMp4DurationSeconds(buffer: Buffer): number | null {
  const moov = findBox(buffer, 0, buffer.length, 'moov');
  if (!moov) return null;
  const mvhd = findBox(buffer, moov.start, moov.end, 'mvhd');
  if (!mvhd) return null;

  const payloadLength = mvhd.end - mvhd.start;
  const version = buffer.readUInt8(mvhd.start);
  if (version === 1) {
    if (payloadLength < 32) return null;
    const timescale = buffer.readUInt32BE(mvhd.start + 20);
    const duration = Number(buffer.readBigUInt64BE(mvhd.start + 24));
    return timescale > 0 ? duration / timescale : null;
  }
  if (payloadLength < 20) return null;
  const timescale = buffer.readUInt32BE(mvhd.start + 12);
  const duration = buffer.readUInt32BE(mvhd.start + 16);
  return timescale > 0 ? duration / timescale : null;
}

async function findBoxInFile(
  handle: FileHandle,
  from: number,
  to: number,
  type: string
): Promise<BoxRange | null> {
  const header = Buffer.alloc(16);
  let offset = from;
  while (offset + 8 <= to) {
    const { bytesRead } = await handle.read(header, 0, Math.min(16, to - offset), offset);
    if (bytesRead < 8) return null;
    let size = header.readUInt32BE(0);
    const boxType = header.toString('ascii', 4, 8);
    let headerLength = 8;
    if (size === 1) {
      if (bytesRead < 16) return null;
      size = Number(header.readBigUInt64BE(8));
      headerLength = 16;
    } else if (size === 0) {
      // "extends to end of file" — only legal at the top level.
      size = to - offset;
    }
    if (size < headerLength || offset + size > to) return null;
    if (boxType === type) {
      return { start: offset + headerLength, end: offset + size };
    }
    offset += size;
  }
  return null;
}

/**
 * File-based twin of readMp4DurationSeconds: walks the box tree with seeks,
 * reading only 16-byte headers plus the ≤40-byte mvhd payload. Constant
 * memory — video routes use this so a 1 GB upload never touches the heap.
 */
export async function readMp4DurationSecondsFromFile(
  filePath: string
): Promise<number | null> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const moov = await findBoxInFile(handle, 0, size, 'moov');
    if (!moov) return null;
    const mvhd = await findBoxInFile(handle, moov.start, moov.end, 'mvhd');
    if (!mvhd) return null;

    const payloadLength = mvhd.end - mvhd.start;
    const payload = Buffer.alloc(Math.min(payloadLength, 40));
    const { bytesRead } = await handle.read(payload, 0, payload.length, mvhd.start);
    if (bytesRead < payload.length) return null;

    const version = payload.readUInt8(0);
    if (version === 1) {
      if (payloadLength < 32) return null;
      const timescale = payload.readUInt32BE(20);
      const duration = Number(payload.readBigUInt64BE(24));
      return timescale > 0 ? duration / timescale : null;
    }
    if (payloadLength < 20) return null;
    const timescale = payload.readUInt32BE(12);
    const duration = payload.readUInt32BE(16);
    return timescale > 0 ? duration / timescale : null;
  } finally {
    await handle.close();
  }
}
