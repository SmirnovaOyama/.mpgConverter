/**
 * Encoding presets and ffmpeg argument construction.
 *
 * MPEG-1 and MPEG-2 are old, rigid formats: only a fixed set of frame rates and
 * audio sample rates is legal, dimensions must be even, and the pixel format has
 * to be 8-bit 4:2:0. Anything else makes the encoder refuse the stream outright,
 * so the builder below normalises the source into that box and records what it
 * had to change.
 */

import { ConversionError } from "./errors.ts";
import { notice, type Notice, type OverriddenSetting } from "./notices.ts";
import type { ConvertOptions, EncodeOptions, MediaInfo, PresetName, QualityTier } from "./types.ts";

/** Frame rates permitted by the MPEG-1/2 video specs, as exact rationals. */
export const MPEG_FRAME_RATES: readonly { num: number; den: number }[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
];

/** Sample rates the MP2 audio encoder accepts. */
export const MP2_SAMPLE_RATES: readonly number[] = [32000, 44100, 48000];

export interface PresetDef {
  name: PresetName;
  description: string;
  /** Value for ffmpeg's `-f`, needed because we encode to a temporary filename. */
  format: string;
  /** `-target` value for the disc-compliance presets. */
  target?: string;
  /** Disc presets dictate size, frame rate and bitrate; overriding them breaks compliance. */
  fixed: boolean;
  videoCodec?: string;
  audioCodec?: string;
  videoBitrate?: string;
  audioBitrate?: string;
  /** Preferred sample rate when the source rate is unknown. */
  sampleRate?: number;
}

export const PRESETS: Record<PresetName, PresetDef> = {
  mpeg2: {
    name: "mpeg2",
    description: "MPEG-2 video + MP2 audio in an MPEG program stream (default)",
    format: "mpeg",
    fixed: false,
    videoCodec: "mpeg2video",
    audioCodec: "mp2",
    videoBitrate: "4000k",
    audioBitrate: "224k",
    sampleRate: 48000,
  },
  mpeg1: {
    name: "mpeg1",
    description: "MPEG-1 video + MP2 audio; maximum compatibility with old players",
    format: "mpeg",
    fixed: false,
    videoCodec: "mpeg1video",
    audioCodec: "mp2",
    videoBitrate: "1800k",
    audioBitrate: "224k",
    sampleRate: 44100,
  },
  "vcd-ntsc": {
    name: "vcd-ntsc",
    description: "Video CD, NTSC (352x240, 29.97fps, 1150k)",
    format: "vcd",
    target: "ntsc-vcd",
    fixed: true,
  },
  "vcd-pal": {
    name: "vcd-pal",
    description: "Video CD, PAL (352x288, 25fps, 1150k)",
    format: "vcd",
    target: "pal-vcd",
    fixed: true,
  },
  "svcd-ntsc": {
    name: "svcd-ntsc",
    description: "Super Video CD, NTSC (480x480, 29.97fps)",
    format: "svcd",
    target: "ntsc-svcd",
    fixed: true,
  },
  "svcd-pal": {
    name: "svcd-pal",
    description: "Super Video CD, PAL (480x576, 25fps)",
    format: "svcd",
    target: "pal-svcd",
    fixed: true,
  },
  "dvd-ntsc": {
    name: "dvd-ntsc",
    description: "DVD-Video, NTSC (720x480, 29.97fps)",
    format: "dvd",
    target: "ntsc-dvd",
    fixed: true,
  },
  "dvd-pal": {
    name: "dvd-pal",
    description: "DVD-Video, PAL (720x576, 25fps)",
    format: "dvd",
    target: "pal-dvd",
    fixed: true,
  },
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export function isPresetName(value: string): value is PresetName {
  return Object.hasOwn(PRESETS, value);
}

/** Encoder effort knobs. `balanced` is ffmpeg's own default. */
const QUALITY_ARGS: Record<QualityTier, string[]> = {
  fast: ["-mbd", "simple"],
  balanced: [],
  best: ["-mbd", "rd", "-trellis", "2", "-cmp", "2", "-subcmp", "2"],
};

/** Parse `"4000k"`, `"1.5M"`, `"800000"` into bits per second. */
export function parseBitrate(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(value.trim());
  if (!match) {
    throw new ConversionError(
      "BAD_OPTION",
      `Invalid bitrate ${JSON.stringify(value)} (expected e.g. "4000k", "1.5M" or "800000")`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const scale = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  const bits = Math.round(amount * scale);
  if (bits <= 0) {
    throw new ConversionError("BAD_OPTION", `Bitrate must be greater than zero, got ${value}`);
  }
  return bits;
}

/** Render bits per second back into ffmpeg's compact notation. */
export function formatBitrate(bits: number): string {
  const rounded = Math.round(bits);
  return rounded % 1000 === 0 ? `${rounded / 1000}k` : `${rounded}`;
}

/** Snap an arbitrary frame rate to the nearest one MPEG-1/2 allows. */
export function snapFrameRate(fps: number): { num: number; den: number; value: number; text: string } {
  let best = MPEG_FRAME_RATES[0]!;
  let bestDelta = Infinity;
  for (const rate of MPEG_FRAME_RATES) {
    const delta = Math.abs(rate.num / rate.den - fps);
    if (delta < bestDelta) {
      best = rate;
      bestDelta = delta;
    }
  }
  return {
    num: best.num,
    den: best.den,
    value: best.num / best.den,
    text: best.den === 1 ? String(best.num) : `${best.num}/${best.den}`,
  };
}

/** Snap an arbitrary sample rate to the nearest one MP2 allows. */
export function snapSampleRate(rate: number): number {
  let best = MP2_SAMPLE_RATES[0]!;
  let bestDelta = Infinity;
  for (const candidate of MP2_SAMPLE_RATES) {
    const delta = Math.abs(candidate - rate);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

/** Round down to an even number; MPEG macroblocks are 16x16 and demand even dimensions. */
function toEven(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export interface BuildEncodeArgsParams {
  preset: PresetDef;
  options: EncodeOptions;
  /** Source metadata, when the file could be probed. */
  info: MediaInfo | null;
  /** Collects non-fatal notes about what was normalised. */
  warnings: Notice[];
}

export interface BuildArgsParams extends BuildEncodeArgsParams {
  input: string;
  /** Where ffmpeg should write. Usually a temporary `.part` file. */
  output: string;
  options: ConvertOptions;
}

/**
 * Build the ffmpeg arguments that sit between the input and the output: stream
 * mapping, codecs, rates, filters and the container.
 *
 * Pure apart from pushing onto `warnings`, and free of any filesystem or process
 * concepts, so the browser build can use it unchanged.
 */
export function buildEncodeArgs(params: BuildEncodeArgsParams): string[] {
  const { preset, options, info, warnings } = params;
  const args: string[] = [];

  // Stream selection. Map by absolute index when we probed the file, so that a
  // cover-art "video" stream in an audio container can't be picked by mistake.
  if (info?.video) {
    args.push("-map", `0:${info.video.index}`);
    if (info.audio) args.push("-map", `0:${info.audio.index}`);
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?");
  }
  args.push("-sn", "-dn");

  if (preset.target) args.push("-target", preset.target);

  const warnFixed = (setting: OverriddenSetting) => {
    if (preset.fixed) {
      warnings.push(notice("preset-overridden", { setting, preset: preset.name }));
    }
  };

  // --- Video ---
  if (preset.videoCodec) args.push("-c:v", preset.videoCodec);

  if (options.qscale !== undefined) {
    if (!Number.isFinite(options.qscale) || options.qscale < 1 || options.qscale > 31) {
      throw new ConversionError("BAD_OPTION", `--qscale must be between 1 and 31, got ${options.qscale}`);
    }
    warnFixed("quantiser");
    args.push("-q:v", String(options.qscale));
  } else {
    const bitrate = options.videoBitrate ?? (preset.fixed ? undefined : preset.videoBitrate);
    if (options.videoBitrate) warnFixed("video-bitrate");
    if (bitrate) {
      const bits = parseBitrate(bitrate);
      args.push(
        "-b:v", formatBitrate(bits),
        "-maxrate", formatBitrate(bits * 1.5),
        "-bufsize", formatBitrate(bits * 2),
      );
    }
  }

  if (!preset.fixed) args.push("-bf", "2");
  args.push("-pix_fmt", "yuv420p");
  args.push(...QUALITY_ARGS[options.quality ?? "balanced"]);

  // --- Audio ---
  if (preset.audioCodec) args.push("-c:a", preset.audioCodec);

  const audioBitrate = options.audioBitrate ?? (preset.fixed ? undefined : preset.audioBitrate);
  if (options.audioBitrate) warnFixed("audio-bitrate");
  if (audioBitrate) args.push("-b:a", formatBitrate(parseBitrate(audioBitrate)));

  if (!preset.fixed) {
    const channels = info?.audio?.channels ?? null;
    // MP2 handles mono and stereo only; anything wider gets downmixed.
    if (channels === null || channels > 2) args.push("-ac", "2");

    const sourceRate = info?.audio?.sampleRate ?? null;
    const targetRate = sourceRate === null ? preset.sampleRate : snapSampleRate(sourceRate);
    if (targetRate !== undefined && targetRate !== null) {
      if (sourceRate !== null && sourceRate !== targetRate) {
        warnings.push(notice("audio-resampled", { from: sourceRate, to: targetRate }));
      }
      args.push("-ar", String(targetRate));
    }
  }

  // --- Frame rate ---
  if (options.fps !== undefined) {
    if (!Number.isFinite(options.fps) || options.fps <= 0) {
      throw new ConversionError("BAD_OPTION", `--fps must be a positive number, got ${options.fps}`);
    }
    warnFixed("frame-rate");
    const snapped = snapFrameRate(options.fps);
    if (Math.abs(snapped.value - options.fps) > 0.001) {
      warnings.push(notice("frame-rate-snapped", { from: options.fps, to: snapped.text }));
    }
    args.push("-r", snapped.text);
  } else if (!preset.fixed) {
    // Disc presets set their own rate via -target; everything else follows the
    // source, snapped to the nearest legal value.
    const sourceFps = info?.video?.fps ?? null;
    if (sourceFps !== null) {
      const snapped = snapFrameRate(sourceFps);
      if (Math.abs(snapped.value - sourceFps) > 0.01) {
        warnings.push(notice("frame-rate-snapped", { from: sourceFps.toFixed(3), to: snapped.text }));
      }
      args.push("-r", snapped.text);
    }
  }

  // --- Scaling ---
  const filter = buildScaleFilter(options, info, warnings, preset);
  if (filter) args.push("-vf", filter);

  args.push("-f", preset.format);
  return args;
}

/**
 * Build the full ffmpeg argument vector for one file-to-file conversion.
 *
 * Wraps {@link buildEncodeArgs} with the process-level flags the CLI needs. This
 * is exactly what `--dry-run` prints.
 */
export function buildFfmpegArgs(params: BuildArgsParams): string[] {
  const { input, output, ...rest } = params;
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    "-progress", "pipe:1",
    "-nostats",
    // Safe unconditionally: we always encode to a fresh temporary file and only
    // move it into place afterwards, so this can never clobber a real output.
    "-y",
    "-i", input,
    ...buildEncodeArgs(rest),
    output,
  ];
}

function buildScaleFilter(
  options: EncodeOptions,
  info: MediaInfo | null,
  warnings: Notice[],
  preset: PresetDef,
): string | null {
  if (options.size) {
    const [rawWidth, rawHeight] = options.size;
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth < 2 || rawHeight < 2) {
      throw new ConversionError("BAD_OPTION", `--size must be positive, got ${rawWidth}x${rawHeight}`);
    }
    const width = toEven(rawWidth);
    const height = toEven(rawHeight);
    if (width !== rawWidth || height !== rawHeight) {
      warnings.push(
        notice("size-rounded", { from: `${rawWidth}x${rawHeight}`, to: `${width}x${height}` }),
      );
    }
    if (preset.fixed) {
      warnings.push(notice("preset-overridden", { setting: "frame-size", preset: preset.name }));
    }
    return `scale=${width}:${height}:flags=bicubic`;
  }

  // -target already forces a compliant frame size.
  if (preset.fixed) return null;

  const width = info?.video?.width ?? null;
  const height = info?.video?.height ?? null;
  if (width !== null && height !== null) {
    if (width % 2 === 0 && height % 2 === 0) return null;
    warnings.push(
      notice("odd-dimensions", {
        from: `${width}x${height}`,
        to: `${toEven(width)}x${toEven(height)}`,
      }),
    );
  }
  // Dimensions unknown (no ffprobe) or odd: normalise defensively.
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
}
