import { describe, expect, it } from "vitest";
import {
  bitrateFor,
  brandLayout,
  burnStage,
  coalesceBurnRects,
  concatArgs,
  concatListContent,
  extractWavStage,
  hasEdits,
  planExport,
  secs,
  verticalArgs,
  verticalGeometry,
  type CameraSample,
  type ExportSettings,
} from "./plan";
import { appendEdit, emptyEdl, type CutEdit, type MaskEdit, type MaskRegion, type SpeedupEdit } from "../../src/recording/edl";

const cut = (startMs: number, endMs: number): CutEdit => ({ type: "cut", startMs, endMs, reason: "rewind" });
const speedup = (startMs: number, endMs: number, audio: "mute" | "whoosh" = "whoosh"): SpeedupEdit =>
  ({ type: "speedup", startMs, endMs, targetSecs: [3, 5], audio });
const mask = (startMs: number, endMs: number, region: Partial<MaskRegion> = {}, pending = false): MaskEdit =>
  ({ type: "mask", startMs, endMs, region: { x: 0.25, y: 0.2, w: 0.5, h: 0.3, ...region }, style: "black", muteAudio: false, startSource: "match", pending });

const baseSettings = (): ExportSettings => ({
  fps: 60,
  zoomEnabled: false,
  zoomLevel: 1.5,
  brandOutro: false,
  brandFontPath: "C:/Windows/Fonts/msyh.ttc",
  brandLogoPath: "",
  brandTitle: "简录 EaseRec",
  brandSlogan: "简录，让知识输出回归纯粹。",
  loudnorm: false,
  subtitles: false,
  subtitleStyle: {
    fontFamily: "Microsoft YaHei", fontSize: 28, color: "#FFFFFF", outlineColor: "#000000",
    outlineWidth: 2, position: "bottom", marginV: 40,
  },
  llmEnabled: false,
  glossary: "",
  introEnabled: false,
  introPath: "",
  introDurationS: 3,
  outroEnabled: false,
  outroPath: "",
  outroDurationS: 3,
  vertical: false,
  sourceWidth: 3840,
  sourceHeight: 2160,
  verticalWidth: 1080,
  verticalHeight: 1920,
});

const kindsOf = (stages: { kind: string }[]) => stages.map((s) => s.kind);

describe("planExport", () => {
  it("emits a single legacy transcode when nothing is enabled", () => {
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings: baseSettings(),
    });
    expect(kindsOf(plan.stages)).toEqual(["transcode"]);
    // 4K source -> capped 40 Mbps (libopenh264 defaults to ~2 Mbps without it)
    expect(plan.stages[0].args).toEqual([
      "-y", "-i", "C:/rec/r.webm",
      "-c:v", "libopenh264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
      "-b:v", "40M", "-maxrate", "40M", "-bufsize", "80M",
      "-c:a", "aac", "-ar", "48000", "-ac", "2", "-video_track_timescale", "90000",
      "-r", "60", "-movflags", "+faststart", "C:/out/o.mp4",
    ]);
  });

  it("builds segment + concat stages for a rewind cut", () => {
    const edl = appendEdit(emptyEdl(), cut(20000, 24000));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 60000, settings: baseSettings(),
    });
    expect(kindsOf(plan.stages)).toEqual(["segment", "segment", "concat", "transcode"]);
    const seg0 = plan.stages[0];
    expect(seg0.args).toContain("-ss");
    expect(seg0.args!.slice(seg0.args!.indexOf("-ss") + 1, seg0.args!.indexOf("-ss") + 2)).toEqual(["0.000"]);
    const seg1 = plan.stages[1];
    expect(seg1.args!.slice(seg1.args!.indexOf("-ss") + 1, seg1.args!.indexOf("-ss") + 2)).toEqual(["24.000"]);
    expect(seg1.output).toContain("seg_1.mp4");
    // concat stage carries list plumbing for the runner
    expect(plan.stages[2].listFile).toContain("concat.txt");
    expect(plan.stages[2].inputs).toHaveLength(2);
    // finalize copies the timeline to the output
    expect(plan.stages[3].args).toContain("-c");
    expect(plan.stages[3].args).toContain("copy");
    expect(plan.report.cuts).toBe(1);
    expect(plan.report.cutsMs).toBe(4000);
    expect(plan.report.outputDurationMs).toBe(56000);
  });

  it("compresses speedup segments and replaces audio with the whoosh", () => {
    const edl = appendEdit(emptyEdl(), speedup(10000, 70000, "whoosh"));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 80000, settings: baseSettings(),
    });
    const seg1 = plan.stages[1];
    expect(seg1.kind).toBe("segment");
    const all = seg1.args!.join(" ");
    const fc = seg1.args!.indexOf("-filter_complex");
    expect(fc).toBeGreaterThan(0);
    const filter = seg1.args![fc + 1];
    expect(filter).toContain("setpts=PTS/");
    expect(all).toContain("anoisesrc=color=pink");
    expect(filter).toContain("lowpass=f=900");
    // 60s source -> 5s output: speed = 12
    expect(filter).toContain("PTS/12.000000");
    expect(plan.report.speedups).toBe(1);
  });

  it("burns a centered '此处快进' label onto compressed (whoosh) segments", () => {
    const edl = appendEdit(emptyEdl(), speedup(10000, 70000, "whoosh"));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 80000, settings: baseSettings(),
    });
    const seg1 = plan.stages[1];
    expect(seg1.kind).toBe("segment");
    const filter = seg1.args![seg1.args!.indexOf("-filter_complex") + 1];
    expect(filter).toContain("drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc'");
    expect(filter).toContain("此处快进");
    expect(filter).toContain("x=(w-text_w)/2:y=(h-text_h)/2");
    // No label when no CJK font is configured (must never break the graph).
    const noFont = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 80000, settings: { ...baseSettings(), brandFontPath: "" },
    });
    const f2 = noFont.stages[1].args![noFont.stages[1].args!.indexOf("-filter_complex") + 1];
    expect(f2).not.toContain("drawtext=");
    expect(f2).toContain("setpts=PTS/");
  });

  it("mutes audio for mute speedups instead of the whoosh", () => {
    const edl = appendEdit(emptyEdl(), speedup(10000, 70000, "mute"));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 80000, settings: baseSettings(),
    });
    const seg1 = plan.stages[1];
    expect(seg1.args).toContain("-an");
    expect(seg1.args!.join(" ")).toContain("setpts=PTS/");
    expect(seg1.args!.join(" ")).not.toContain("anoisesrc");
  });

  it("orders audio pass -> asr hook -> burn when subtitles are on", () => {
    const settings = { ...baseSettings(), loudnorm: true, subtitles: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    expect(kindsOf(plan.stages)).toEqual(["audio", "transcode", "asr", "burn", "transcode"]);
    // audio filters chain loudnorm only (silence trim was removed — recording
    // legitimately allows long no-speech stretches, so auto-cropping is unsafe)
    const audioArgs = plan.stages[0].args!;
    const af = audioArgs[audioArgs.indexOf("-af") + 1];
    expect(af).not.toContain("silenceremove");
    expect(af).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
    // wav extraction feeds the ASR hook
    expect(plan.stages[1].output).toContain("audio16k.wav");
    // burn consumes the ass file and produces subbed.mp4
    const burn = plan.stages[3];
    expect(burn.args!.join(" ")).toContain("ass=");
    expect(burn.output).toContain("subbed.mp4");
  });

  it("skips extract/asr/burn entirely when the recording has no audio stream", () => {
    // subtitles requested + no audio track must NOT schedule wav-extract /
    // whisper / subtitle burn — otherwise the extract fails hard, or Whisper
    // hallucinates fake subtitles over the silence.
    const settings = { ...baseSettings(), loudnorm: true, subtitles: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings, hasAudio: false,
    });
    const kinds = kindsOf(plan.stages);
    expect(kinds).not.toContain("audio");
    expect(kinds).not.toContain("asr");
    expect(kinds).not.toContain("burn");
    expect(plan.stages.some((s) => s.output.includes("audio16k.wav"))).toBe(false);
  });

  it("keeps the subtitle pipeline when hasAudio is absent (legacy default)", () => {
    const settings = { ...baseSettings(), loudnorm: true, subtitles: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    expect(kindsOf(plan.stages)).toEqual(["audio", "transcode", "asr", "burn", "transcode"]);
  });

  it("audio pass copies the video stream through untouched (no full re-encode)", () => {
    // The stage only transforms audio; re-encoding the picture here cost a
    // full-length encode per export while changing nothing.
    const settings = { ...baseSettings(), loudnorm: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    const audioArgs = plan.stages[0].args!;
    expect(audioArgs[audioArgs.indexOf("-c:v") + 1]).toBe("copy");
    expect(audioArgs.join(" ")).not.toContain("libopenh264");
    expect(audioArgs.join(" ")).not.toContain("-pix_fmt");
    expect(audioArgs.join(" ")).not.toContain("-r");
    // audio still re-encodes to the pipeline's uniform aac 48k stereo
    expect(audioArgs[audioArgs.indexOf("-c:a") + 1]).toBe("aac");
  });

  it("chains a timbre style into the serial -af chain (no reverb)", () => {
    const settings = { ...baseSettings(), voiceEnhance: true, voiceEnhanceStrength: "standard", voiceTimbre: "magnetic" };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    const audioArgs = plan.stages[0].args!;
    const af = audioArgs[audioArgs.indexOf("-af") + 1];
    // cleanup first, timbre second — EQ on denoised/compressed audio
    expect(af.indexOf("acompressor")).toBeLessThan(af.indexOf("bass=g=3:f=130"));
    expect(af).toContain("aexciter=amount=2.2:drive=6:freq=5500");
    expect(af).not.toContain("deesser");
  });

  it("bright timbre de-esses after the presence boost", () => {
    const settings = { ...baseSettings(), voiceEnhance: true, voiceEnhanceStrength: "light", voiceTimbre: "bright" };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    const af = plan.stages[0].args![plan.stages[0].args!.indexOf("-af") + 1];
    expect(af).toContain("treble=g=2:f=5000");
    expect(af.indexOf("treble")).toBeLessThan(af.indexOf("deesser"));
  });

  it("reverb builds a parallel wet graph: dry pristine, loudnorm after the mix", () => {
    const settings = { ...baseSettings(), loudnorm: true, voiceReverb: "studio" };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    const audioArgs = plan.stages[0].args!;
    expect(audioArgs).not.toContain("-af");
    const fc = audioArgs[audioArgs.indexOf("-filter_complex") + 1];
    expect(fc).toContain("asplit=2[dc][wc]");
    expect(fc).toContain("aecho=0.55:0.8:28|46|71|103:0.22|0.18|0.14|0.10");
    // stereowiden option names pinned — a wrong guess ("cross"/"dry") only
    // explodes at export time on the user's machine
    expect(fc).toContain("stereowiden=delay=15:feedback=0.2:crossfeed=0.3:drymix=0.8");
    expect(fc).toContain("[dc]volume=0.95[dd]");
    // wet is damped and scaled before it rejoins the dry path
    expect(fc.indexOf("lowpass=f=6500")).toBeLessThan(fc.indexOf("[dd][wo]amix"));
    // loudness normalization is the LAST voice step
    expect(fc.indexOf("amix=inputs=2:duration=first:normalize=0,loudnorm")).toBeGreaterThan(0);
    expect(audioArgs[audioArgs.indexOf("-map", audioArgs.indexOf("-map") + 1) + 1]).toBe("[va]");
  });

  it("reverb composes with the bgm mix (two amix nodes, music under the voice)", () => {
    const settings = { ...baseSettings(), voiceEnhance: true, voiceTimbre: "magnetic", voiceReverb: "light", bgmPath: "C:/m/bgm.mp3", bgmVolume: "low" };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    const audioArgs = plan.stages[0].args!;
    expect(audioArgs).toContain("-stream_loop");
    const fc = audioArgs[audioArgs.indexOf("-filter_complex") + 1];
    // timbre rides the dry+wet pre-mix; bgm joins afterwards at its own level
    expect(fc.indexOf("bass=g=3:f=130")).toBeLessThan(fc.indexOf("asplit=2"));
    expect(fc).toContain("[1:a]volume=0.10[m]");
    expect(fc).toContain("[va][m]amix=inputs=2:duration=first:normalize=0[aout]");
    expect((fc.match(/amix=inputs=2/g) || []).length).toBe(2);
  });

  it("schedules the audio pass for a timbre/reverb even without the cleanup chain", () => {
    const settings = { ...baseSettings(), voiceTimbre: "bright", voiceReverb: "light" };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    expect(kindsOf(plan.stages)[0]).toBe("audio");
    const fc = plan.stages[0].args![plan.stages[0].args!.indexOf("-filter_complex") + 1];
    expect(fc).not.toContain("afftdn"); // cleanup off: only timbre + reverb run
    expect(fc).toContain("deesser");
  });

  it("burn uses a relative ass path with cwd (Windows colon-safe)", () => {
    const st = burnStage("C:\\tmp\\subbed.mp4", "C:\\tmp\\out.mp4", "C:\\tmp\\work\\subs.ass", 30);
    const vf = st.args![st.args!.indexOf("-vf") + 1];
    expect(vf).toBe("ass=subs.ass");
    expect(st.cwd).toBe("C:\\tmp\\work");
  });

  it("plans intro/outro final concat before finalize", () => {
    const settings = {
      ...baseSettings(),
      introEnabled: true, introPath: "C:/assets/intro.mp4",
      outroEnabled: true, outroPath: "C:/assets/outro.mp4",
    };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    expect(kindsOf(plan.stages)).toEqual(["final-concat", "transcode"]);
    expect(plan.stages[0].inputs).toEqual(["C:/assets/intro.mp4", "C:/rec/r.webm", "C:/assets/outro.mp4"]);
    expect(plan.stages[0].partDurations).toEqual([0, 0, 0]); // all videos: duration inherited
  });

  it("still-image intro/outro get their own hold duration in final concat", () => {
    const settings = {
      ...baseSettings(),
      introEnabled: true, introPath: "C:/assets/intro.png", introDurationS: 3,
      outroEnabled: true, outroPath: "C:/assets/outro.jpg", outroDurationS: 5,
    };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    const fc = plan.stages.find((st) => st.kind === "final-concat")!;
    expect(fc.inputs).toEqual(["C:/assets/intro.png", "C:/rec/r.webm", "C:/assets/outro.jpg"]);
    expect(fc.partDurations).toEqual([3, 0, 5]);
  });

  it("appends a generated brand outro as the very last concat part", () => {
    const settings = { ...baseSettings(), brandOutro: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    const brand = plan.stages.find((st) => st.kind === "brand")!;
    expect(brand).toBeTruthy();
    expect(brand.output).toContain("brand.mp4");
    const all = brand.args!.join(" ");
    expect(all).toContain("color=c=0x0a0a0f");
    expect(all).toContain("anullsrc=r=48000:cl=stereo:d=3");
    expect(all).toContain("drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc'");
    expect(all).toMatch(/让\s*知\s*识\s*输\s*出\s*回\s*归\s*纯\s*粹/);
    const fc = plan.stages.find((st) => st.kind === "final-concat")!;
    expect(fc.inputs![fc.inputs!.length - 1]).toContain("brand.mp4");
  });

  it("brand outro is omitted when the switch is off", () => {
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings: baseSettings(),
    });
    expect(plan.stages.some((st) => st.kind === "brand")).toBe(false);
    expect(plan.stages.some((st) => st.kind === "final-concat")).toBe(false);
  });

  it("brand outro with a logo runs a separate overlay pass", () => {
    const settings = { ...baseSettings(), brandOutro: true, brandLogoPath: "C:/brand/logo.png" };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    const brands = plan.stages.filter((st) => st.kind === "brand");
    expect(brands.length).toBe(2);
    const fc = plan.stages.find((st) => st.kind === "final-concat")!;
    expect(fc.inputs![fc.inputs!.length - 1]).toContain("brand.mp4");
    const logoPass = brands[1];
    expect(logoPass.args).toContain("-loop");
    expect(logoPass.args).toContain("C:/brand/logo.png");
    const filter = logoPass.args![logoPass.args!.indexOf("-filter_complex") + 1];
    expect(filter).toContain("[1:v]scale=");
    expect(filter).toContain("fade=t=in:st=0.25:d=0.8:alpha=1");
    expect(filter).toMatch(/\[0:v\]\[lg\]overlay=x=\d+:y=\d+:shortest=1\[v\]/);
    expect(filter).not.toContain("drawtext");
    const textStage = brands[0];
    expect(textStage.args).toContain("-vf");
    expect(textStage.args).not.toContain("-filter_complex");
    expect(textStage.args).not.toContain("-loop");
  });

  it("brand composition is 10% bigger end to end (BRAND_SCALE)", () => {
    // 1920x1080 landscape: slogan 21 -> 23px, logo ink box 59 -> 64px tall.
    const L = brandLayout(1920, 1080, "让知识输出回归纯粹", "Let knowledge output return to purity.");
    expect(L.sloganSize).toBe(23);
    expect(L.logoH).toBe(64);
    // Portrait: the stacked mark grows 115 -> 127px.
    const P = brandLayout(1080, 1920, "让知识输出回归纯粹", "Let knowledge output return to purity.");
    expect(P.logoH).toBe(127);
  });

  it("justifies the Chinese slogan to the English line width (both orientations)", () => {    const zh = "让知识输出回归纯粹";
    const en = "Let knowledge output return to purity.";
    for (const [w, h] of [[1920, 1080], [1080, 1920]] as const) {
      const L = brandLayout(w, h, zh, en);
      expect(L.justifiedSlogan).not.toBe(zh);
      expect(L.justifiedSlogan).toMatch(/让\s+知\s+识/);
      if (!L.portrait) {
        expect(L.textLeft).toBeGreaterThan(L.logoX + L.logoW);
        expect(L.zhYExpr).toContain("(h-text_h)/2");
      } else {
        expect(L.zhY).toBeGreaterThan(L.logoY + L.logoH);
        expect(L.logoX).toBe(Math.round((w - L.logoW) / 2));
      }
    }
  });

  it("appends a vertical stage derived from the final output", () => {
    const settings = { ...baseSettings(), vertical: true, subtitles: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
    });
    const v = plan.stages.find((s) => s.kind === "vertical")!;
    expect(v.output).toBe("C:/out/o_vertical.mp4");
    expect(v.sendcmdFile).toContain("vertical_sendcmd.txt");
  });

  it("final concat may stream-copy when the zoom pass encoded the main line (aac source)", () => {
    // Zoom spans re-encode the whole timeline with the pipeline's own encoder
    // settings and the source audio is aac -> the brand card can be
    // normalized and spliced without re-encoding the film.
    const settings = { ...baseSettings(), zoomEnabled: true, brandOutro: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
      mouseTrack: Array.from({ length: 100 }, (_, i) => ({ tMs: i * 500, x: 0.5, y: 0.5 })),
      inputAudioCodec: "aac",
    });
    expect(plan.copyConcat).toBe(true);
    const fc = plan.stages.find((st) => st.kind === "final-concat")!;
    expect(fc.mainPart).toContain("zoomed.mp4");
    expect(fc.inputs).toContain(fc.mainPart);
  });

  it("final concat keeps the re-encode path for an untouched source line", () => {
    // No zoom/segments/masks: the main line is still the SOURCE stream, whose
    // params the pipeline does not control -> filter concat (status quo).
    const settings = { ...baseSettings(), brandOutro: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
      inputAudioCodec: "aac",
    });
    expect(plan.copyConcat).toBe(false);
  });

  it("final concat keeps the re-encode path for a non-aac source without an audio pass", () => {
    // webm/opus source with every audio feature off: the main line's audio
    // stays opus, which cannot concat-copy against aac brand parts.
    const settings = { ...baseSettings(), zoomEnabled: true, brandOutro: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
      mouseTrack: Array.from({ length: 100 }, (_, i) => ({ tMs: i * 500, x: 0.5, y: 0.5 })),
      inputAudioCodec: "opus",
    });
    expect(plan.copyConcat).toBe(false);
  });

  it("an audio pass (aac re-encode) re-enables copy concat regardless of the source codec", () => {
    const settings = { ...baseSettings(), zoomEnabled: true, brandOutro: true, loudnorm: true };
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000, settings,
      mouseTrack: Array.from({ length: 100 }, (_, i) => ({ tMs: i * 500, x: 0.5, y: 0.5 })),
      inputAudioCodec: "opus",
      hasAudio: true,
    });
    expect(plan.copyConcat).toBe(true);
  });

  it("segments alone (no zoom) also mark the main line as pipeline-encoded", () => {
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: appendEdit(emptyEdl(), cut(20000, 24000)), durationMs: 60000,
      settings: { ...baseSettings(), brandOutro: true },
      inputAudioCodec: "aac",
    });
    expect(plan.copyConcat).toBe(true);
  });

  it("voice swap without subtitles still schedules audio pass + extract + asr (no burn)", () => {
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000,
      settings: { ...baseSettings(), voiceSwap: true },
      hasAudio: true,
    });
    expect(kindsOf(plan.stages)).toEqual(["audio", "transcode", "asr", "transcode"]);
    const audioArgs = plan.stages[0].args!;
    // Second input is the synthesized voice track.
    const i1 = audioArgs.indexOf("-i");
    const i2 = audioArgs.indexOf("-i", i1 + 1);
    expect(audioArgs[i2 + 1]).toContain("voice_track.wav");
    // Audio is taken from the TRACK, not the recording; video is copied.
    expect(audioArgs[audioArgs.indexOf("-map") + 1]).toBe("0:v:0");
    expect(audioArgs.join(" ")).toContain("-map 1:a:0");
    expect(audioArgs.join(" ")).toContain("-c:v copy");
    expect(audioArgs.join(" ")).not.toContain("afftdn");
  });

  it("voice swap + BGM mixes the music under the synthesized track", () => {
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000,
      settings: { ...baseSettings(), voiceSwap: true, bgmPath: "C:/m/bgm.mp3", bgmVolume: "high", loudnorm: true },
      hasAudio: true,
    });
    const audioArgs = plan.stages[0].args!;
    const fc = audioArgs[audioArgs.indexOf("-filter_complex") + 1];
    // loudnorm rides the synthesized voice; the bgm joins at its own level.
    expect(fc).toContain("[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[va]");
    expect(fc).toContain("[2:a]volume=0.35[m]");
    expect(fc).toContain("[va][m]amix=inputs=2:duration=first:normalize=0[aout]");
    // The cleanup chain never touches TTS output.
    expect(fc).not.toContain("afftdn");
    expect(fc).not.toContain("aecho");
  });

  it("voice swap is dropped on a no-audio recording", () => {
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 60000,
      settings: { ...baseSettings(), voiceSwap: true },
      hasAudio: false,
    });
    const kinds = kindsOf(plan.stages);
    expect(kinds).not.toContain("audio");
    expect(kinds).not.toContain("asr");
  });

  it("a lone click drives a zoom region even with no dwell track", () => {
    // Fast flitting (150ms static bursts, teleports between) yields no
    // dwells — only the CLICK can produce zoom spans.
    const track: { tMs: number; x: number; y: number }[] = [];
    for (let seg = 0; seg < 40; seg++) {
      const x = seg % 2 === 0 ? 0.25 : 0.75;
      for (let k = 0; k < 5; k++) track.push({ tMs: seg * 160 + k * 30, x, y: 0.5 });
    }
    const noClick = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 6400,
      settings: { ...baseSettings(), zoomEnabled: true },
      mouseTrack: track,
    });
    expect(kindsOf(noClick.stages)).toEqual(["transcode"]); // nothing to zoom

    const clicked = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl: emptyEdl(), durationMs: 6400,
      settings: { ...baseSettings(), zoomEnabled: true },
      mouseTrack: track,
      mouseClicks: [{ tMs: 3200, x: 0.3, y: 0.3 }],
    });
    const kinds = kindsOf(clicked.stages);
    expect(kinds).toContain("zoomspan");
    expect(kinds).toContain("concat");
    // The click's zoom eases in BEFORE the click (lead-in) — a span's -ss
    // must start earlier than the click time.
    const spans = clicked.stages.filter((s) => s.kind === "zoomspan");
    const eased = spans.find((s) => s.args!.includes("-vf"));
    expect(eased).toBeTruthy();
  });
});

describe("privacy mask burn", () => {
  const filterOf = (args: string[]): string => args[args.indexOf("-filter_complex") + 1];

  it("burns a pixelated mosaic from the backtraced first appearance to the recording end", () => {
    // startMs = backtrace result (content first appeared at 5s, box drawn at 12s)
    // endMs = F6-off time — the mosaic must STILL cover the region afterwards
    // (before AND after the box selection), all the way to the last frame.
    const edl = appendEdit(emptyEdl(), mask(5000, 12000));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 60000, settings: baseSettings(),
    });
    expect(kindsOf(plan.stages)).toEqual(["maskburn", "transcode"]);
    const burn = plan.stages[0];
    expect(burn.kind).toBe("maskburn");
    expect(burn.args).toContain("-map");
    expect(burn.args).toContain("[vout]");
    // mosaic cells pixelate the rect content: downscale area + upscale neighbor
    const f = filterOf(burn.args!);
    expect(f).toContain("crop=w=1920:h=648:x='960*between(t,5.000,60.000)':y='432*between(t,5.000,60.000)'");
    expect(f).toContain("scale=160:54:flags=area");
    expect(f).toContain("scale=1920:648:flags=neighbor");
    // masked window is the SOURCE timeline [backtrace start, recording end]
    expect(f).toContain("enable='between(t,5.000,60.000)'");
    // mask-only film must NOT re-slice segments (mask passes time through)
    expect(plan.stages.some((s) => s.kind === "segment")).toBe(false);
    expect(plan.report.masks).toBe(1);
  });

  it("extends a never-closed mask to the recording end", () => {
    const edl = appendEdit(emptyEdl(), mask(1000, 1500, {}, true));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 60000, settings: baseSettings(),
    });
    const f = filterOf(plan.stages[0].args!);
    expect(plan.stages[0].kind).toBe("maskburn");
    expect(f).toContain("enable='between(t,1.000,60.000)'");
  });

  it("remaps a mask rect into region-crop space and burns the cropped input", () => {
    const edl = appendEdit(emptyEdl(), mask(2000, 8000, { x: 0.35, y: 0.35, w: 0.2, h: 0.2 }));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 60000,
      settings: { ...baseSettings(), sourceWidth: 1920, sourceHeight: 1080 },
      recordRegion: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      inputVideoSize: { width: 3840, height: 2160 },
    });
    expect(kindsOf(plan.stages)).toEqual(["zoomspan", "maskburn", "transcode"]);
    const burn = plan.stages[1];
    const input = burn.args![burn.args!.indexOf("-i") + 1];
    expect(input).toContain("cropped.mp4");
    // normalized full-frame 0.35 -> crop-space 0.5; pixels on 1920x1080 crop
    const f = filterOf(burn.args!);
    expect(f).toContain("crop=w=768:h=432:x='960*between(t,2.000,60.000)':y='540*between(t,2.000,60.000)'");
  });

it("masks before slicing so cuts keep the mosaic on the kept footage", () => {
    const edl = appendEdit(appendEdit(emptyEdl(), mask(5000, 20000)), cut(30000, 40000));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 60000, settings: baseSettings(),
    });
    expect(plan.stages[0].kind).toBe("maskburn");
    expect(plan.stages.some((s) => s.kind === "segment")).toBe(true);
  });

  it("burns an extra mosaic wherever the masked content recurs (maskTracks)", () => {
    const edl = appendEdit(emptyEdl(), mask(5000, 20000, { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 60000, settings: baseSettings(),
      maskTracks: [[{
        t0: 800, t1: 1200,
        rect: { x: 0.1, y: 0.2, w: 0.2, h: 0.1 },
      }]],
    });
    const burn = plan.stages[0];
    expect(burn.kind).toBe("maskburn");
    const f = filterOf(burn.args!);
    // static full-window mosaic for [startMs -> end] stays
    expect(f).toContain("enable='between(t,5.000,60.000)+between(t,0.300,1.700)'");
    // occurrence mosaic with a padded window around [0.8s, 1.2s]
    expect(f).toContain("crop=w=768:h=216:x='1920*between(t,5.000,60.000)+384*between(t,0.300,1.700)':y='1080*between(t,5.000,60.000)+432*between(t,0.300,1.700)'");
  });

  it("merges same-size masks into one grouped pass", () => {
    const edl = appendEdit(
      appendEdit(emptyEdl(), mask(1000, 6000, { x: 0.2, y: 0.2, w: 0.3, h: 0.3 })),
      mask(8000, 12000, { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }),
    );
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 60000, settings: baseSettings(),
    });
    const f = filterOf(plan.stages[0].args!);
    // Same-size rects share ONE crop/pixelate pass — the x/y/enable
    // expressions carry one between() term per rect.
    expect(f).toContain("enable='between(t,1.000,60.000)+between(t,8.000,60.000)'");
    expect(f).toContain("'768*between(t,1.000,60.000)+2304*between(t,8.000,60.000)'");
  });
});

describe("coalesceBurnRects", () => {
  const r = (x: number, y: number, t0: number, t1: number): Parameters<typeof coalesceBurnRects>[0][number] =>
    ({ x, y, w: 0.2, h: 0.1, t0, t1 });

  it("merges same-spot blink runs into one continuous window", () => {
    const out = coalesceBurnRects([
      r(0.5, 0.5, 1.0, 2.0),
      r(0.5, 0.5, 3.5, 4.0),  // gap 1.5s (>0.5 tolerance) -> new span
      r(0.5, 0.5, 4.2, 6.0),  // overlaps previous -> same span
      r(0.5, 0.5, 6.1, 6.5),  // within +0.5s tolerance -> merges with [3.5,6]
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].t0).toBe(1.0);
    expect(out[0].t1).toBe(2.0);
    expect(out[1].t0).toBe(3.5);
    expect(out[1].t1).toBe(6.5);
  });

  it("keeps different spots separate", () => {
    const out = coalesceBurnRects([
      r(0.5, 0.5, 1.0, 2.0),
      r(0.1, 0.8, 1.0, 2.0),
      r(0.1, 0.8, 2.5, 3.0),  // merges with the second spot
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((m) => m.x === 0.5)!.t1).toBe(2.0);
    expect(out.find((m) => m.x === 0.1)!.t1).toBe(3.0);
  });
});

describe("privacy mask burn chunking (Windows command-line cap)", () => {
  it("splits a huge occurrence set into passes whose graphs stay under the budget", () => {
    const edl = appendEdit(emptyEdl(), mask(500, 800, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }));
    const runs: Array<{ t0: number; t1: number; rect: MaskRegion }> = [];
    for (let i = 0; i < 1500; i++) {
      runs.push({
        t0: 900 + i * 1.25,
        t1: 900 + i * 1.25 + 0.4,
        rect: { x: (i % 50) / 50, y: Math.floor(i / 50) / 30, w: 0.08, h: 0.08 },
      });
    }
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 4000, settings: baseSettings(),
      maskTracks: [runs],
    });
    const burns = plan.stages.filter((s) => s.kind === "maskburn");
    expect(burns.length).toBeGreaterThan(1);
    for (const b of burns) {
      const g = b.args![b.args!.indexOf("-filter_complex") + 1];
      expect(g.length).toBeLessThan(30000);
    }
    expect(plan.stages[plan.stages.length - 1].kind).toBe("transcode");
  });

  it("keeps a small mask set on a single pass", () => {
    const edl = appendEdit(emptyEdl(), mask(500, 800));
    const plan = planExport({
      inputPath: "C:/rec/r.webm", outputPath: "C:/out/o.mp4", workDir: "C:/tmp",
      edl, durationMs: 4000, settings: baseSettings(),
    });
    expect(plan.stages.filter((s) => s.kind === "maskburn")).toHaveLength(1);
  });
});

describe("concat helpers", () => {
  it("writes a concat list with forward slashes and escaped quotes", () => {
    expect(concatListContent(["C:\\a b\\x.mp4", "C:/y'z.mp4"]))
      .toBe("file 'C:/a b/x.mp4'\nfile 'C:/y'\\''z.mp4'\n");
  });

  it("concatArgs copies by default and re-encodes when asked", () => {
    expect(concatArgs("l.txt", "o.mp4", false)).toContain("-c");
    expect(concatArgs("l.txt", "o.mp4", true, 60).join(" ")).toContain("-r 60");
  });
});

describe("vertical geometry", () => {
  it("static centered crop without samples; full-height 9:16 window", () => {
    const geo = verticalGeometry([], 3840, 2160);
    expect(geo.cropH).toBe(2160);
    expect(geo.cropW).toBe(1216); // 2160*9/16 = 1215 -> even 1216
    expect(geo.sendcmd).toBe(`0.000 crop x ${(3840 - 1216) / 2};\n`);
  });

  it("tracks the camera center and clamps to the frame", () => {
    const samples: CameraSample[] = [
      { tMs: 0, x: 0.0, y: 0, w: 0.5, h: 1 },   // center at 0.25 -> x = 960-608 = 352
      { tMs: 1000, x: 0.9, y: 0, w: 0.1, h: 1 }, // center at 0.95 -> clamped to 3840-1216
    ];
    const geo = verticalGeometry(samples, 3840, 2160);
    const lines = geo.sendcmd.trim().split("\n");
    expect(lines[0]).toBe("0.000 crop x 352;");
    expect(lines[1]).toBe("1.000 crop x 2624;");
  });

  it("verticalArgs wires sendcmd + crop + scale", () => {
    const geo = verticalGeometry([], 3840, 2160);
    const args = verticalArgs("in.mp4", "out_v.mp4", geo, "C:\\tmp\\cmds.txt", 1080, 1920, 60);
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("sendcmd=f=cmds.txt");
    expect(vf).toContain("crop=w=1216:h=2160");
    expect(vf).toContain("scale=1080:1920");
  });
});

describe("bitrateFor", () => {
  it("scales with resolution and caps at 40 Mbps", () => {
    expect(bitrateFor(1920, 1080)).toBe(12);
    expect(bitrateFor(2560, 1440)).toBe(21);
    expect(bitrateFor(3840, 2160)).toBe(40);
    expect(bitrateFor(640, 360)).toBeGreaterThanOrEqual(6);
  });
});

describe("misc builders", () => {
  it("formats seconds with ms precision", () => {
    expect(secs(0)).toBe("0.000");
    expect(secs(61234)).toBe("61.234");
  });

  it("wav extraction forces mono 16k pcm", () => {
    const st = extractWavStage("in.mp4", "a.wav");
    expect(st.args).toContain("-ac");
    expect(st.args).toContain("16000");
  });

  it("hasEdits reflects the EDL", () => {
    expect(hasEdits(emptyEdl())).toBe(false);
    expect(hasEdits(appendEdit(emptyEdl(), cut(0, 100)))).toBe(true);
  });
});
