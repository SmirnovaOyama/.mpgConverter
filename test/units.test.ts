import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  buildFfmpegArgs,
  formatBitrate,
  parseBitrate,
  PRESETS,
  snapFrameRate,
  snapSampleRate,
} from "../src/presets.ts";
import { defaultOutputPath, expandInputs, normalizeExtension, resolveOutputPath } from "../src/discover.ts";
import { parseProgressBlock, parseTimecode } from "../src/convert.ts";
import { parseFfmpegBanner, parseProbeJson, parseRational } from "../src/probe.ts";
import { ConversionError } from "../src/errors.ts";
import { formatNotice, type Notice } from "../src/notices.ts";
import type { MediaInfo } from "../src/types.ts";

/** The notice codes raised, in order. */
function codes(notices: Notice[]): string[] {
  return notices.map((item) => item.code);
}

/** Read the value that follows `flag` in an ffmpeg argument vector. */
function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function mediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    duration: 60,
    size: 1_000_000,
    video: { index: 0, codec: "h264", width: 1920, height: 1080, fps: 30, sampleRate: null, channels: null },
    audio: { index: 1, codec: "aac", width: null, height: null, fps: null, sampleRate: 48000, channels: 2 },
    ...overrides,
  };
}

describe("parseBitrate / formatBitrate", () => {
  it("parses ffmpeg bitrate notation", () => {
    assert.equal(parseBitrate("4000k"), 4_000_000);
    assert.equal(parseBitrate("1.5M"), 1_500_000);
    assert.equal(parseBitrate("800000"), 800_000);
    assert.equal(parseBitrate(" 224k "), 224_000);
  });

  it("rejects nonsense", () => {
    assert.throws(() => parseBitrate("fast"), ConversionError);
    assert.throws(() => parseBitrate("0k"), ConversionError);
    assert.throws(() => parseBitrate("-5k"), ConversionError);
  });

  it("round-trips through formatBitrate", () => {
    assert.equal(formatBitrate(6_000_000), "6000k");
    assert.equal(formatBitrate(1234), "1234");
    assert.equal(parseBitrate(formatBitrate(parseBitrate("4000k") * 1.5)), 6_000_000);
  });
});

describe("snapFrameRate", () => {
  it("keeps rates that are already legal", () => {
    assert.equal(snapFrameRate(25).text, "25");
    assert.equal(snapFrameRate(60).text, "60");
  });

  it("expresses NTSC rates as exact rationals", () => {
    assert.equal(snapFrameRate(29.97).text, "30000/1001");
    assert.equal(snapFrameRate(23.976).text, "24000/1001");
  });

  it("pulls illegal rates to the nearest legal one", () => {
    assert.equal(snapFrameRate(15).text, "24000/1001");
    assert.equal(snapFrameRate(48).text, "50");
    assert.equal(snapFrameRate(120).text, "60");
  });
});

describe("snapSampleRate", () => {
  it("maps to the three rates MP2 supports", () => {
    assert.equal(snapSampleRate(48000), 48000);
    assert.equal(snapSampleRate(22050), 32000);
    assert.equal(snapSampleRate(96000), 48000);
    assert.equal(snapSampleRate(44100), 44100);
  });
});

describe("buildFfmpegArgs", () => {
  const base = { input: "in.mov", output: "out.part" };

  it("builds a default MPEG-2 command", () => {
    const warnings: Notice[] = [];
    const args = buildFfmpegArgs({ ...base, preset: PRESETS.mpeg2, options: { input: "in.mov" }, info: mediaInfo(), warnings });

    assert.equal(valueOf(args, "-c:v"), "mpeg2video");
    assert.equal(valueOf(args, "-c:a"), "mp2");
    assert.equal(valueOf(args, "-b:v"), "4000k");
    assert.equal(valueOf(args, "-maxrate"), "6000k");
    assert.equal(valueOf(args, "-pix_fmt"), "yuv420p");
    assert.equal(valueOf(args, "-r"), "30");
    assert.equal(valueOf(args, "-f"), "mpeg");
    assert.equal(args.at(-1), "out.part");
    assert.deepEqual(warnings, []);
  });

  it("maps the real video stream, not attached cover art", () => {
    const warnings: Notice[] = [];
    const info = mediaInfo({
      video: { index: 2, codec: "h264", width: 640, height: 480, fps: 25, sampleRate: null, channels: null },
    });
    const args = buildFfmpegArgs({ ...base, preset: PRESETS.mpeg2, options: { input: "in.mov" }, info, warnings });
    assert.equal(valueOf(args, "-map"), "0:2");
  });

  it("falls back to generic stream selectors without a probe", () => {
    const warnings: Notice[] = [];
    const args = buildFfmpegArgs({ ...base, preset: PRESETS.mpeg2, options: { input: "in.mov" }, info: null, warnings });
    assert.ok(args.join(" ").includes("-map 0:v:0 -map 0:a:0?"));
    // Dimensions are unknown, so normalise defensively.
    assert.equal(valueOf(args, "-vf"), "scale=trunc(iw/2)*2:trunc(ih/2)*2");
  });

  it("snaps an illegal source frame rate and says so", () => {
    const warnings: Notice[] = [];
    const info = mediaInfo({
      video: { index: 0, codec: "vp9", width: 1280, height: 720, fps: 15, sampleRate: null, channels: null },
    });
    buildFfmpegArgs({ ...base, preset: PRESETS.mpeg2, options: { input: "in.mov" }, info, warnings });
    assert.deepEqual(codes(warnings), ["frame-rate-snapped"]);
    assert.deepEqual(warnings[0]!.params, { from: "15.000", to: "24000/1001" });
  });

  it("evens out odd dimensions", () => {
    const warnings: Notice[] = [];
    const info = mediaInfo({
      video: { index: 0, codec: "h264", width: 1921, height: 1080, fps: 25, sampleRate: null, channels: null },
    });
    const args = buildFfmpegArgs({ ...base, preset: PRESETS.mpeg2, options: { input: "in.mov" }, info, warnings });
    assert.equal(valueOf(args, "-vf"), "scale=trunc(iw/2)*2:trunc(ih/2)*2");
    assert.ok(codes(warnings).includes("odd-dimensions"));
  });

  it("downmixes surround audio but leaves mono alone", () => {
    const surround: Notice[] = [];
    const surroundArgs = buildFfmpegArgs({
      ...base,
      preset: PRESETS.mpeg2,
      options: { input: "in.mov" },
      info: mediaInfo({
        audio: { index: 1, codec: "eac3", width: null, height: null, fps: null, sampleRate: 48000, channels: 6 },
      }),
      warnings: surround,
    });
    assert.equal(valueOf(surroundArgs, "-ac"), "2");

    const mono: Notice[] = [];
    const monoArgs = buildFfmpegArgs({
      ...base,
      preset: PRESETS.mpeg2,
      options: { input: "in.mov" },
      info: mediaInfo({
        audio: { index: 1, codec: "aac", width: null, height: null, fps: null, sampleRate: 44100, channels: 1 },
      }),
      warnings: mono,
    });
    assert.equal(monoArgs.includes("-ac"), false);
    assert.equal(valueOf(monoArgs, "-ar"), "44100");
  });

  it("resamples audio to a rate MP2 accepts", () => {
    const warnings: Notice[] = [];
    const args = buildFfmpegArgs({
      ...base,
      preset: PRESETS.mpeg2,
      options: { input: "in.mov" },
      info: mediaInfo({
        audio: { index: 1, codec: "opus", width: null, height: null, fps: null, sampleRate: 22050, channels: 2 },
      }),
      warnings,
    });
    assert.equal(valueOf(args, "-ar"), "32000");
    assert.deepEqual(codes(warnings), ["audio-resampled"]);
  });

  it("prefers an explicit quantiser over a bitrate", () => {
    const warnings: Notice[] = [];
    const args = buildFfmpegArgs({
      ...base,
      preset: PRESETS.mpeg2,
      options: { input: "in.mov", qscale: 4, videoBitrate: "9000k" },
      info: mediaInfo(),
      warnings,
    });
    assert.equal(valueOf(args, "-q:v"), "4");
    assert.equal(args.includes("-b:v"), false);
  });

  it("rejects an out-of-range quantiser", () => {
    assert.throws(
      () =>
        buildFfmpegArgs({
          ...base,
          preset: PRESETS.mpeg2,
          options: { input: "in.mov", qscale: 99 },
          info: mediaInfo(),
          warnings: [] as Notice[],
        }),
      ConversionError,
    );
  });

  it("rounds a requested size down to even and honours it", () => {
    const warnings: Notice[] = [];
    const args = buildFfmpegArgs({
      ...base,
      preset: PRESETS.mpeg2,
      options: { input: "in.mov", size: [721, 481] },
      info: mediaInfo(),
      warnings,
    });
    assert.equal(valueOf(args, "-vf"), "scale=720:480:flags=bicubic");
    assert.ok(codes(warnings).includes("size-rounded"));
  });

  it("lets -target drive the disc presets", () => {
    const warnings: Notice[] = [];
    const args = buildFfmpegArgs({
      ...base,
      preset: PRESETS["dvd-ntsc"],
      options: { input: "in.mov" },
      info: mediaInfo(),
      warnings,
    });
    assert.equal(valueOf(args, "-target"), "ntsc-dvd");
    assert.equal(valueOf(args, "-f"), "dvd");
    // The target already sets rate, size and bitrate.
    assert.equal(args.includes("-b:v"), false);
    assert.equal(args.includes("-r"), false);
    assert.equal(args.includes("-vf"), false);
    assert.deepEqual(warnings, []);
  });

  it("warns when a disc preset is overridden", () => {
    const warnings: Notice[] = [];
    buildFfmpegArgs({
      ...base,
      preset: PRESETS["vcd-pal"],
      options: { input: "in.mov", videoBitrate: "5000k" },
      info: mediaInfo(),
      warnings,
    });
    assert.ok(codes(warnings).includes("preset-overridden"));
  });

  it("applies the quality tier", () => {
    const best = buildFfmpegArgs({
      ...base,
      preset: PRESETS.mpeg2,
      options: { input: "in.mov", quality: "best" },
      info: mediaInfo(),
      warnings: [] as Notice[],
    });
    assert.equal(valueOf(best, "-mbd"), "rd");
    assert.equal(valueOf(best, "-trellis"), "2");

    const balanced = buildFfmpegArgs({
      ...base,
      preset: PRESETS.mpeg2,
      options: { input: "in.mov" },
      info: mediaInfo(),
      warnings: [] as Notice[],
    });
    assert.equal(balanced.includes("-mbd"), false);
  });
});

describe("output paths", () => {
  it("swaps the extension for .mpg", () => {
    assert.equal(defaultOutputPath(path.join("a", "b.mp4")), path.join("a", "b.mpg"));
    assert.equal(defaultOutputPath(path.join("a", "clip.MOV")), path.join("a", "clip.mpg"));
  });

  it("handles unusual and missing extensions", () => {
    assert.equal(defaultOutputPath(path.join("a", "weird.~")), path.join("a", "weird.mpg"));
    assert.equal(defaultOutputPath(path.join("a", "noextension")), path.join("a", "noextension.mpg"));
  });

  it("never targets its own input", () => {
    assert.equal(defaultOutputPath(path.join("a", "b.mpg")), path.join("a", "b.converted.mpg"));
    assert.equal(defaultOutputPath(path.join("a", "b.MPG")), path.join("a", "b.converted.mpg"));
  });

  it("treats --output as a file for one input and a directory for many", () => {
    assert.equal(resolveOutputPath({ input: "x/a.mp4", output: "out/final.mpg" }), "out/final.mpg");
    assert.equal(
      resolveOutputPath({ input: path.join("x", "a.mp4"), output: "out", outputIsDirectory: true }),
      path.join("out", "a.mpg"),
    );
  });
});

describe("expandInputs", () => {
  let dir = "";

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpgconv-test-"));
    await fs.mkdir(path.join(dir, "nested"));
    await fs.writeFile(path.join(dir, "a.mp4"), "");
    await fs.writeFile(path.join(dir, "b.MOV"), "");
    await fs.writeFile(path.join(dir, "notes.txt"), "");
    await fs.writeFile(path.join(dir, "odd.~"), "");
    await fs.writeFile(path.join(dir, ".hidden.mp4"), "");
    await fs.writeFile(path.join(dir, "half.mpg.part"), "");
    await fs.writeFile(path.join(dir, "nested", "c.mkv"), "");
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("scans a directory for known video extensions", async () => {
    const found = await expandInputs([dir]);
    assert.deepEqual(found.map((file) => path.basename(file)).sort(), ["a.mp4", "b.MOV"]);
  });

  it("recurses on request", async () => {
    const found = await expandInputs([dir], { recursive: true });
    assert.deepEqual(found.map((file) => path.basename(file)).sort(), ["a.mp4", "b.MOV", "c.mkv"]);
  });

  it("picks up extra extensions", async () => {
    const found = await expandInputs([dir], { extensions: ["~"] });
    assert.ok(found.some((file) => file.endsWith("odd.~")));
  });

  it("accepts explicitly named files whatever they are called", async () => {
    const found = await expandInputs([path.join(dir, "notes.txt"), path.join(dir, "odd.~")]);
    assert.equal(found.length, 2);
  });

  it("de-duplicates overlapping arguments", async () => {
    const found = await expandInputs([dir, path.join(dir, "a.mp4")]);
    assert.equal(found.filter((file) => file.endsWith("a.mp4")).length, 1);
  });

  it("reports a missing path", async () => {
    await assert.rejects(() => expandInputs([path.join(dir, "nope.mp4")]), /No such file or directory/);
  });

  it("normalises extension spellings", () => {
    assert.equal(normalizeExtension("MP4"), ".mp4");
    assert.equal(normalizeExtension(".AVI"), ".avi");
    assert.equal(normalizeExtension(""), "");
  });
});

describe("progress parsing", () => {
  it("reads ffmpeg timecodes", () => {
    assert.equal(parseTimecode("00:00:12.500000"), 12.5);
    assert.equal(parseTimecode("01:02:03"), 3723);
    assert.equal(parseTimecode("garbage"), null);
  });

  it("prefers out_time over the microsecond fields", () => {
    const progress = parseProgressBlock(
      new Map([
        ["frame", "300"],
        ["total_size", "2048"],
        ["out_time", "00:00:10.000000"],
        ["out_time_ms", "999999999"],
        ["speed", "2.5x"],
        ["progress", "continue"],
      ]),
      "in.mov",
      20,
    );
    assert.equal(progress.seconds, 10);
    assert.equal(progress.ratio, 0.5);
    assert.equal(progress.frames, 300);
    assert.equal(progress.speed, 2.5);
    assert.equal(progress.bytes, 2048);
  });

  it("falls back to microseconds and reports no ratio without a duration", () => {
    const progress = parseProgressBlock(
      new Map([["out_time_us", "5000000"], ["progress", "continue"]]),
      "in.mov",
      null,
    );
    assert.equal(progress.seconds, 5);
    assert.equal(progress.ratio, null);
  });
});

describe("probe parsing", () => {
  it("reads rationals", () => {
    assert.equal(parseRational("30000/1001"), 30000 / 1001);
    assert.equal(parseRational("25/1"), 25);
    assert.equal(parseRational("0/0"), null);
    assert.equal(parseRational(undefined), null);
  });

  it("skips attached cover art when choosing the video stream", () => {
    const info = parseProbeJson({
      format: { duration: "12.5", size: "1024" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
        { index: 1, codec_type: "video", codec_name: "h264", width: 640, height: 480, avg_frame_rate: "25/1" },
        { index: 2, codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2 },
      ],
    });
    assert.equal(info.video?.index, 1);
    assert.equal(info.video?.fps, 25);
    assert.equal(info.audio?.sampleRate, 44100);
    assert.equal(info.duration, 12.5);
  });

  it("survives empty input", () => {
    const info = parseProbeJson({});
    assert.equal(info.video, null);
    assert.equal(info.audio, null);
    assert.equal(info.duration, null);
  });
});

describe("ffmpeg banner fallback", () => {
  // Verbatim `ffmpeg -hide_banner -i` output, used when ffprobe is missing.
  const banner = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/source.mp4':
  Metadata:
    major_brand     : isom
    encoder         : Lavf60.3.100
  Duration: 00:00:05.01, start: 0.000000, bitrate: 5642 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 5446 kb/s, 23.98 fps, 23.98 tbr, 24k tbn (default)
    Metadata:
      handler_name    : VideoHandler
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 96000 Hz, 5.1, fltp, 186 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
At least one output file must be specified`;

  it("recovers everything the converter needs", () => {
    const info = parseFfmpegBanner(banner);
    assert.equal(info.duration, 5.01);
    assert.equal(info.video?.index, 0);
    assert.equal(info.video?.codec, "h264");
    assert.equal(info.video?.width, 1920);
    assert.equal(info.video?.height, 1080);
    assert.equal(info.video?.fps, 23.98);
    assert.equal(info.audio?.index, 1);
    assert.equal(info.audio?.sampleRate, 96000);
    assert.equal(info.audio?.channels, 6);
  });

  it("feeds frame rate snapping correctly despite rounded values", () => {
    const info = parseFfmpegBanner(banner);
    assert.equal(snapFrameRate(info.video!.fps!).text, "24000/1001");
  });

  it("reads stereo and mono layouts", () => {
    const stereo = parseFfmpegBanner(
      `  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s`,
    );
    assert.equal(stereo.audio?.channels, 2);
    const mono = parseFfmpegBanner(`  Stream #0:0: Audio: mp3, 44100 Hz, mono, fltp, 64 kb/s`);
    assert.equal(mono.audio?.channels, 1);
  });

  it("ignores cover art and picks the real video stream", () => {
    const info = parseFfmpegBanner(`  Duration: 00:01:02.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc), 600x600 [SAR 1:1 DAR 1:1], 90k tbr (attached pic)
  Stream #0:1: Video: h264 (Main), yuv420p, 720x576, 25 fps, 25 tbr, 90k tbn
  Stream #0:2: Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s`);
    assert.equal(info.video?.index, 1);
    assert.equal(info.video?.width, 720);
    assert.equal(info.video?.fps, 25);
    assert.equal(info.audio?.channels, 6);
    assert.equal(info.duration, 62);
  });

  it("returns empty fields for unparseable text", () => {
    const info = parseFfmpegBanner("something went wrong");
    assert.equal(info.video, null);
    assert.equal(info.audio, null);
  });
});

describe("notices", () => {
  it("renders every code in both languages", () => {
    const samples: Notice[] = [
      { code: "frame-rate-snapped", params: { from: "15.000", to: "24000/1001" } },
      { code: "audio-resampled", params: { from: 22050, to: 32000 } },
      { code: "size-rounded", params: { from: "721x481", to: "720x480" } },
      { code: "odd-dimensions", params: { from: "1921x1080", to: "1920x1080" } },
      { code: "preset-overridden", params: { setting: "video-bitrate", preset: "vcd-pal" } },
      { code: "probe-failed", params: {} },
      { code: "output-exists", params: {} },
      { code: "large-file", params: { size: "400 MB" } },
    ];

    for (const sample of samples) {
      const english = formatNotice(sample, "en");
      const chinese = formatNotice(sample, "zh");
      // Neither may fall back to printing the raw code.
      assert.notEqual(english, sample.code);
      assert.notEqual(chinese, sample.code);
      assert.notEqual(english, chinese);
      assert.ok(/[\u4e00-\u9fff]/.test(chinese), `${sample.code} has no Chinese text`);
    }
  });

  it("substitutes parameters", () => {
    const item: Notice = { code: "audio-resampled", params: { from: 22050, to: 32000 } };
    assert.match(formatNotice(item, "en"), /22050 Hz -> 32000 Hz/);
    assert.match(formatNotice(item, "zh"), /22050 Hz → 32000 Hz/);
  });

  it("translates the overridden setting name too", () => {
    const item: Notice = { code: "preset-overridden", params: { setting: "frame-rate", preset: "dvd-pal" } };
    assert.match(formatNotice(item, "en"), /Frame rate overridden/);
    assert.match(formatNotice(item, "zh"), /帧率/);
  });

  it("defaults to English and never drops an unknown code", () => {
    assert.match(formatNotice({ code: "probe-failed", params: {} }), /Could not analyse/);
    assert.equal(formatNotice({ code: "made-up" as Notice["code"], params: {} }, "zh"), "made-up");
  });
});
