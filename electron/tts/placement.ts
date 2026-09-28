/**
 * Voice-swap placement — deciding where each synthesized clip sits on the
 * export timeline, PURE (no fs/spawn) so the timing rules are unit-testable.
 *
 * The film's video timeline is NEVER stretched (screen recording: the picture
 * must stay as recorded), so the synthesized voice adapts to the timeline:
 *   - A clip starts where its original segment started.
 *   - Its slot runs until the NEXT spoken segment begins (speech gaps absorb
 *     shorter clips; cleaned speech is almost always shorter than the
 *     original, fillers removed).
 *   - A clip longer than its slot is sped up locally with atempo (clamped to
 *     a sane ceiling) instead of overlapping the next words.
 */

export interface SynthItem {
  /** Original segment start on the EXPORT timeline, ms. */
  startMs: number;
  /** Original segment end, ms. */
  endMs: number;
  /** Cleaned text actually spoken by the TTS. */
  text: string;
  /** Synthesized clip duration, ms. */
  synthMs: number;
  /** Synthesized clip audio file. */
  file: string;
}

export interface Placement {
  file: string;
  text: string;
  /** Placed start (= original start, or nudged past a bleeding predecessor). */
  startMs: number;
  /** Placed end = start + synthMs / atempo. */
  endMs: number;
  /** Local speedup applied to fit the slot (1 = none). */
  atempo: number;
}

export const MAX_ATEMPO = 2.0;

/** Plan placements for the synthesized clips. Items must be non-empty
 *  (filler-only segments were dropped beforehand). */
export function planPlacement(
  items: SynthItem[],
  totalDurationMs: number,
  opts: { maxTempo?: number } = {},
): Placement[] {
  const maxTempo = Math.max(1, opts.maxTempo ?? MAX_ATEMPO);
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  const out: Placement[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    const prev = out[out.length - 1];
    let start = Math.max(0, it.startMs);
    if (prev && prev.endMs > start) start = prev.endMs; // never talk over the previous clip
    const next = sorted[i + 1];
    // Slot: until the next segment starts; the last clip may breathe into the
    // tail of the film but never past the end.
    let slotEnd = next
      ? Math.max(next.startMs, start + 500)
      : Math.min(Math.max(totalDurationMs, start + 1000), start + Math.max(8000, it.synthMs * 1.5));
    slotEnd = Math.max(slotEnd, start + 500);
    const slot = slotEnd - start;
    const atempo = it.synthMs > slot ? Math.min(maxTempo, it.synthMs / slot) : 1;
    out.push({
      file: it.file,
      text: it.text,
      startMs: start,
      endMs: start + it.synthMs / atempo,
      atempo,
    });
  }
  return out;
}

/** Subtitle segments reflecting what is ACTUALLY spoken now: cleaned text with
 *  the placement-adjusted clock (a sped-up cue ends earlier). */
export function placementsToSubtitleSegments(p: Placement[]): { startMs: number; endMs: number; text: string }[] {
  return p
    .filter((x) => x.text.trim().length > 0)
    .map((x) => ({ startMs: Math.round(x.startMs), endMs: Math.round(x.endMs), text: x.text }));
}
