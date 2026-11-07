import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jpegSize, sampleTimeline, writeMjpegAvi } from "./daemon/avi.ts";

// Smallest valid-looking JPEG header: SOI, SOF0 (8-bit, 32×16, 1 component), EOI.
function fakeJpeg(w: number, h: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xd9])]);
}

test("jpegSize reads SOF dimensions", () => {
  assert.deepEqual(jpegSize(fakeJpeg(32, 16)), { width: 32, height: 16 });
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
});

test("timeline repeats frames until the next one", () => {
  const frames = [{ file: "a", ts: 1000 }, { file: "b", ts: 1250 }, { file: "c", ts: 1600 }];
  assert.deepEqual(sampleTimeline(frames, 2000, 10), [0, 0, 0, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual(sampleTimeline([], 2000, 10), []);
});

test("writes a RIFF AVI with an index entry per frame", () => {
  const dir = mkdtempSync(join(tmpdir(), "bctl-avi-"));
  try {
    const frames = [0, 300, 700].map((t, i) => {
      const file = join(dir, `${i}.jpg`);
      writeFileSync(file, fakeJpeg(32, 16));
      return { file, ts: 10_000 + t };
    });
    const out = join(dir, "out.avi");
    const r = writeMjpegAvi(frames, 11_000, out, 10);
    assert.equal(r.frames, 10);
    assert.equal(r.width, 32);
    const b = readFileSync(out);
    assert.equal(b.toString("ascii", 0, 4), "RIFF");
    assert.equal(b.readUInt32LE(4), b.length - 8);
    assert.equal(b.toString("ascii", 8, 12), "AVI ");
    const idx = b.indexOf("idx1");
    assert.ok(idx > 0);
    assert.equal(b.readUInt32LE(idx + 4), 16 * 10);
    const movi = b.indexOf("movi");
    const firstOffset = b.readUInt32LE(idx + 8 + 8);
    assert.equal(b.toString("ascii", movi + firstOffset, movi + firstOffset + 4), "00dc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
