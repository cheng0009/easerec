/**
 * whisper.cpp CLI wrapper. The binary + ggml model are provisioned by
 * scripts/download-whisper.ps1 (mirror-aware) into:
 *   <project>/src-tauri/whisper/whisper-cli.exe
 *   <project>/src-tauri/whisper/models/<name>.bin
 * The wrapper spawns the CLI as a child process (same pattern as ffmpeg),
 * preferring the -oj JSON output and falling back to SRT parsing.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWhisperJson, parseWhisperSrt, type WhisperSegment } from "./cues";

export interface WhisperBin {
  exe: string;
  modelPath: string;
}

export function resolveWhisper(projectDir: string, modelPath: string): WhisperBin | null {
  const candidates = [
    path.join(projectDir, "src-tauri", "whisper", "whisper-cli.exe"),
    path.join(projectDir, "src-tauri", "whisper", "main.exe"),
    path.join(process.resourcesPath || "", "whisper", "whisper-cli.exe"),
  ].filter((p) => p && path.isAbsolute(p));
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      const model = modelPath && fs.existsSync(modelPath)
        ? modelPath
        : defaultModelPath(projectDir);
      if (model) return { exe, modelPath: model };
      return null;
    }
  }
  return null;
}

export const WHISPER_MODELS = ["tiny", "base", "small", "medium"] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number];

export function defaultModelPath(projectDir: string, model: WhisperModel = "base"): string | null {
  const candidates = [
    path.join(projectDir, "src-tauri", "whisper", "models", `ggml-${model}.bin`),
    process.resourcesPath
      ? path.join(process.resourcesPath, "whisper", "models", `ggml-${model}.bin`)
      : "",
  ].filter((p) => p && path.isAbsolute(p));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Build the whisper-cli argument list (pure, testable). */
export function buildWhisperArgs(
  wavPath: string,
  outBase: string,
  modelPath: string,
  opts: { language?: string; glossary?: string; threads?: number } = {},
): string[] {
  const args = [
    "-m", modelPath,
    "-f", wavPath,
    "-oj", "-of", outBase,
    "-sow", // split on word (keeps offsets stable across builds)
    "-t", String(opts.threads ?? Math.max(2, Math.min(8, os.cpus?.().length ?? 4))),
  ];
  if (opts.language && opts.language !== "auto") args.push("-l", opts.language);
  if (opts.glossary && opts.glossary.trim()) {
    // Initial prompt biases the tokenizer toward the user's vocabulary.
    args.push("--prompt", `术语表：${opts.glossary.trim()}\n以下是普通话转写。`);
  }
  return args;
}

export interface WhisperRunResult {
  segments: WhisperSegment[];
  raw: string;
  ok: boolean;
  error?: string;
}

/** Run whisper-cli on a wav and parse its JSON output. */
export function runWhisper(
  bin: WhisperBin,
  wavPath: string,
  outDir: string,
  opts: { language?: string; glossary?: string; timeoutMs?: number } = {},
): Promise<WhisperRunResult> {
  const outBase = path.join(outDir, `asr_${Date.now()}`);
  const args = buildWhisperArgs(wavPath, outBase, bin.modelPath, opts);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin.exe, args, { windowsHide: true });
    } catch (e) {
      resolve({ segments: [], raw: "", ok: false, error: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, opts.timeoutMs ?? 30 * 60 * 1000);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ segments: [], raw: stdout, ok: false, error: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const jsonPath = outBase + ".json";
      try {
        if (fs.existsSync(jsonPath)) {
          const segments = parseWhisperJson(fs.readFileSync(jsonPath, "utf8"));
          resolve({ segments, raw: stdout, ok: segments.length > 0 });
          return;
        }
      } catch { /* fall through */ }
      // Fallback: parse the CLI's SRT-ish stdout.
      const segments = parseWhisperSrt(stdout);
      resolve({
        segments,
        raw: stdout + "\n" + stderr,
        ok: segments.length > 0,
        error: segments.length ? undefined : `whisper exit ${code}: ${stderr.split("\n").slice(-3).join(" | ")}`,
      });
    });
  });
}
