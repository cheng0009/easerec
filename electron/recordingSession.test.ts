import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listRecordings,
  readEdlFile,
  RecordingSession,
  sidecarPaths,
  writeEdlFile,
} from "./recordingSession";
import { emptyEdl, type CutEdit } from "../src/recording/edl";

const cut = (startMs: number, endMs: number): CutEdit => ({ type: "cut", startMs, endMs, reason: "rewind" });

let dir: string;
afterEach(() => {
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ""; }
});

function tempDir(): string {
  dir = mkdtempSync(path.join(tmpdir(), "dc-session-"));
  return dir;
}

describe("RecordingSession", () => {
  it("begin creates webm + sidecars; chunks append in order", () => {
    const s = RecordingSession.begin(tempDir());
    expect(existsSync(s.paths.webmPath)).toBe(true);
    expect(existsSync(s.paths.editsPath)).toBe(true);
    s.appendChunk(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
    s.appendChunk(new Uint8Array([1, 2, 3, 4, 5]));
    s.appendChunk(new Uint8Array([6, 7]));
    const written = readFileSync(s.paths.webmPath);
    expect([...written]).toEqual([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7]);
    expect(s.webmBytes).toBe(11);
  });

  it("end() finalizes with duration and stops accepting writes", () => {
    const s = RecordingSession.begin(tempDir());
    s.addEdit(cut(0, 1000));
    s.end(65000);
    const edl = readEdlFile(s.paths.editsPath);
    expect(edl.finalized).toBe(true);
    expect(edl.durationMs).toBe(65000);
    expect(edl.edits).toHaveLength(1);
    // closed: further chunks/edits are ignored
    s.appendChunk(new Uint8Array([9, 9]));
    s.addEdit(cut(2000, 3000));
    expect(readEdlFile(s.paths.editsPath).edits).toHaveLength(1);
  });

  it("addEdit normalizes and persists; updateEdit replaces by index", () => {
    const s = RecordingSession.begin(tempDir());
    const { index: i1 } = s.addEdit(cut(1000, 2000));
    const { index: i2 } = s.addEdit(cut(2000, 3000)); // touching -> merged
    expect(i1).toBe(0);
    expect(i2).toBe(0);
    expect(s.getEdl().edits).toHaveLength(1);
    expect(s.getEdl().edits[0]).toMatchObject({ startMs: 1000, endMs: 3000 });

    const updated = s.updateEdit(0, cut(500, 900));
    expect(updated.edits[0]).toMatchObject({ startMs: 500, endMs: 900 });
    expect(readEdlFile(s.paths.editsPath).edits[0]).toMatchObject({ startMs: 500 });
  });

  it("camera samples append as JSONL", () => {
    const s = RecordingSession.begin(tempDir());
    s.appendCameraSample({ tMs: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.9 });
    s.appendCameraSample({ tMs: 100, x: 0.2, y: 0.1, w: 0.5, h: 0.9 });
    const lines = readFileSync(s.paths.camTrackPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ tMs: 100, x: 0.2 });
  });

  it("adopt() resumes an existing webm (crash recovery)", () => {
    const d = tempDir();
    const webm = path.join(d, "old.webm");
    writeFileSync(webm, Buffer.from([1, 2, 3]));
    writeEdlFile(webm + ".edits.json", { ...emptyEdl(), edits: [cut(0, 100)] });
    const s = RecordingSession.adopt(webm);
    expect(s.webmBytes).toBe(3);
    expect(s.getEdl().edits).toHaveLength(1);
  });
});

describe("listRecordings", () => {
  it("lists webm files with finalized flags, newest first", () => {
    const d = tempDir();
    const a = path.join(d, "a.webm");
    const b = path.join(d, "b.webm");
    writeFileSync(a, Buffer.alloc(10));
    writeEdlFile(a + ".edits.json", { ...emptyEdl(), finalized: true });
    writeFileSync(b, Buffer.alloc(5));
    writeEdlFile(b + ".edits.json", { ...emptyEdl(), finalized: false });
    const list = listRecordings(d);
    expect(list).toHaveLength(2);
    const fin = list.find((e) => e.webmPath === a)!;
    const unfinished = list.find((e) => e.webmPath === b)!;
    expect(fin.finalized).toBe(true);
    expect(unfinished.finalized).toBe(false);
    expect(list[0].mtimeMs).toBeGreaterThanOrEqual(list[1].mtimeMs);
    expect(sidecarPaths(a).editsPath).toBe(a + ".edits.json");
  });

  it("ignores non-webm files and missing directories", () => {
    const d = tempDir();
    writeFileSync(path.join(d, "x.txt"), "nope");
    writeFileSync(path.join(d, "y.webm"), Buffer.alloc(1));
    expect(listRecordings(d)).toHaveLength(1);
    expect(listRecordings(path.join(d, "nope-missing"))).toEqual([]);
  });
});
