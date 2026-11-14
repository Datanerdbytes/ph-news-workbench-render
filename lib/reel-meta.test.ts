import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMp4DurationSeconds, readMp4DurationSecondsFromFile } from "./reel-meta";

/** Build one ISO-BMFF box: 4-byte big-endian size + 4-byte type + payload. */
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

/** 64-bit variant for boxes larger than 4 GB. */
function largeBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, "ascii");
  header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([header, payload]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(96);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return box("mvhd", payload);
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  const payload = Buffer.alloc(44);
  payload.writeUInt8(1, 0); // version 1: 64-bit durations
  payload.writeUInt32BE(timescale, 20);
  payload.writeBigUInt64BE(duration, 24);
  return box("mvhd", payload);
}

function moov(...children: Buffer[]): Buffer {
  return box("moov", Buffer.concat(children));
}

const FTYP = box("ftyp", Buffer.from("isomiso2avc1mp41", "ascii"));

describe("readMp4DurationSeconds", () => {
  it("reads a version-0 mvhd", () => {
    // 1800 ticks at 600 ticks/s = 3 seconds.
    const file = Buffer.concat([FTYP, moov(mvhdV0(600, 1800))]);
    expect(readMp4DurationSeconds(file)).toBe(3);
  });

  it("reads a version-1 mvhd with a 64-bit duration", () => {
    const file = Buffer.concat([
      FTYP,
      moov(mvhdV1(2 ** 30, BigInt(2 ** 33))),
    ]);
    expect(readMp4DurationSeconds(file)).toBe(8);
  });

  it("finds moov even when other boxes precede it and are nested", () => {
    const file = Buffer.concat([
      FTYP,
      box("wide", Buffer.alloc(40)),
      moov(box("udta", Buffer.alloc(16)), mvhdV0(1000, 65_000)),
    ]);
    expect(readMp4DurationSeconds(file)).toBe(65);
  });

  it("supports 64-bit box headers", () => {
    const file = Buffer.concat([FTYP, largeBox("moov", mvhdV0(1000, 4_500))]);
    expect(readMp4DurationSeconds(file)).toBe(4.5);
  });

  it("returns null without moov or mvhd", () => {
    expect(readMp4DurationSeconds(Buffer.alloc(0))).toBeNull();
    expect(readMp4DurationSeconds(Buffer.from("not an mp4 at all"))).toBeNull();
    expect(readMp4DurationSeconds(FTYP)).toBeNull();
    expect(readMp4DurationSeconds(moov(box("udta", Buffer.alloc(16))))).toBeNull();
  });

  it("returns null for a zero timescale", () => {
    expect(readMp4DurationSeconds(moov(mvhdV0(0, 1800)))).toBeNull();
    expect(readMp4DurationSeconds(moov(mvhdV1(0, BigInt(1800))))).toBeNull();
  });

  it("returns null for truncated mvhd payloads", () => {
    const truncatedV0 = box("mvhd", Buffer.alloc(18)); // needs >= 20
    expect(readMp4DurationSeconds(moov(truncatedV0))).toBeNull();

    const truncatedV1 = Buffer.alloc(30);
    truncatedV1.writeUInt8(1, 0); // version 1 needs >= 32
    expect(readMp4DurationSeconds(moov(box("mvhd", truncatedV1)))).toBeNull();
  });
});

describe("readMp4DurationSecondsFromFile", () => {
  const workDirs: string[] = [];

  async function writeFixture(name: string, contents: Buffer): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "reel-meta-test-"));
    workDirs.push(dir);
    const filePath = path.join(dir, name);
    await writeFile(filePath, contents);
    return filePath;
  }

  afterEach(async () => {
    for (const dir of workDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a version-0 mvhd from disk", async () => {
    const file = await writeFixture(
      "v0.mp4",
      Buffer.concat([FTYP, moov(mvhdV0(600, 1800))])
    );
    await expect(readMp4DurationSecondsFromFile(file)).resolves.toBe(3);
  });

  it("reads moov at the end of the file (non-faststart MP4)", async () => {
    const file = await writeFixture(
      "moov-last.mp4",
      Buffer.concat([FTYP, box("mdat", Buffer.alloc(256)), moov(mvhdV0(1000, 65_000))])
    );
    await expect(readMp4DurationSecondsFromFile(file)).resolves.toBe(65);
  });

  it("supports 64-bit box headers via seeks", async () => {
    const file = await writeFixture(
      "large-box.mp4",
      Buffer.concat([FTYP, largeBox("moov", mvhdV0(1000, 4_500))])
    );
    await expect(readMp4DurationSecondsFromFile(file)).resolves.toBe(4.5);
  });

  it("returns null without moov or mvhd", async () => {
    const junk = await writeFixture("junk.bin", Buffer.from("not an mp4 at all"));
    const noMoov = await writeFixture("ftyp-only.mp4", FTYP);
    const empty = await writeFixture("empty.mp4", Buffer.alloc(0));
    const mvhdless = await writeFixture(
      "mvhdless.mp4",
      moov(box("udta", Buffer.alloc(16)))
    );
    await expect(readMp4DurationSecondsFromFile(junk)).resolves.toBeNull();
    await expect(readMp4DurationSecondsFromFile(noMoov)).resolves.toBeNull();
    await expect(readMp4DurationSecondsFromFile(empty)).resolves.toBeNull();
    await expect(readMp4DurationSecondsFromFile(mvhdless)).resolves.toBeNull();
  });

  it("returns null for a zero timescale", async () => {
    const file = await writeFixture(
      "zero-timescale.mp4",
      moov(mvhdV0(0, 1800))
    );
    await expect(readMp4DurationSecondsFromFile(file)).resolves.toBeNull();
  });

  it("returns null for truncated mvhd payloads", async () => {
    const truncatedV0 = box("mvhd", Buffer.alloc(18)); // needs >= 20
    const file = await writeFixture("truncated.mp4", moov(truncatedV0));
    await expect(readMp4DurationSecondsFromFile(file)).resolves.toBeNull();
  });
});
