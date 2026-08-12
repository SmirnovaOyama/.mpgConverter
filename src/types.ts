/** Shared types for the .mpg converter. */

import type { Notice } from "./notices.ts";

/** Names of the built-in encoding presets. */
export type PresetName =
  | "mpeg2"
  | "mpeg1"
  | "vcd-ntsc"
  | "vcd-pal"
  | "svcd-ntsc"
  | "svcd-pal"
  | "dvd-ntsc"
  | "dvd-pal";

/** Encoder effort tiers, traded against speed. */
export type QualityTier = "fast" | "balanced" | "best";

/** Paths to the external binaries this package drives. */
export interface BinaryPaths {
  ffmpeg: string;
  /** `null` when ffprobe could not be found — conversion still works, without duration/progress. */
  ffprobe: string | null;
}

/** A single decoded stream from `ffprobe`. */
export interface StreamInfo {
  index: number;
  codec: string | null;
  width: number | null;
  height: number | null;
  /** Frames per second as a decimal, when it could be determined. */
  fps: number | null;
  sampleRate: number | null;
  channels: number | null;
}

/** The subset of `ffprobe` output the converter cares about. */
export interface MediaInfo {
  /** Container duration in seconds, when known. */
  duration: number | null;
  /** Total size in bytes, when known. */
  size: number | null;
  video: StreamInfo | null;
  audio: StreamInfo | null;
}

/** Progress emitted while a file is being transcoded. */
export interface Progress {
  /** Absolute path of the file being converted. */
  input: string;
  /** Seconds of output written so far. */
  seconds: number;
  /** 0..1, or `null` when the input duration is unknown. */
  ratio: number | null;
  /** Frames encoded so far, when reported. */
  frames: number | null;
  /** Encoding speed relative to realtime (e.g. `2.5` means 2.5x), when reported. */
  speed: number | null;
  /** Output bytes written so far, when reported. */
  bytes: number | null;
}

/**
 * The encoding knobs, independent of where the media comes from.
 *
 * Kept separate from {@link ConvertOptions} so the browser build — which has no
 * file paths, no child processes and no ffprobe — can reuse the same
 * normalisation logic.
 */
export interface EncodeOptions {
  /** Encoding preset. Defaults to `"mpeg2"`. */
  preset?: PresetName;
  /** Target video bitrate, e.g. `"4000k"`. Ignored by the vcd/svcd/dvd presets and by `qscale`. */
  videoBitrate?: string;
  /** Target audio bitrate, e.g. `"224k"`. Ignored by the vcd/svcd/dvd presets. */
  audioBitrate?: string;
  /** Constant quantizer (1 = best, 31 = worst). Takes precedence over `videoBitrate`. */
  qscale?: number;
  /** Output frame rate. Snapped to the nearest rate MPEG-1/2 allows. */
  fps?: number;
  /** Output frame size as `[width, height]`. Odd values are rounded down to even. */
  size?: [number, number];
  /** Encoder effort. Defaults to `"balanced"`. */
  quality?: QualityTier;
}

/** Options for converting a file on disk, used by the library API and the CLI. */
export interface ConvertOptions extends EncodeOptions {
  /** Source file. Any container/extension ffmpeg can demux is accepted. */
  input: string;
  /** Destination `.mpg` file. Defaults to the input path with a `.mpg` extension. */
  output?: string;
  /** Overwrite an existing output file. Defaults to `false` (the file is skipped). */
  overwrite?: boolean;
  /** Build the command but do not run it. */
  dryRun?: boolean;
  /** Explicit ffmpeg binary, overriding auto-detection. */
  ffmpegPath?: string;
  /** Explicit ffprobe binary, overriding auto-detection. */
  ffprobePath?: string;
  /** Cancels the running ffmpeg process. */
  signal?: AbortSignal;
  /** Called roughly four times a second while encoding. */
  onProgress?: (progress: Progress) => void;
}

/** How a single conversion ended. */
export type ConvertStatus = "converted" | "skipped" | "dry-run";

/** The outcome of one conversion. */
export interface ConvertResult {
  status: ConvertStatus;
  input: string;
  output: string;
  /** The exact argument vector handed to ffmpeg. */
  command: string[];
  /** Wall-clock duration of the ffmpeg run, in milliseconds. `0` for skips and dry runs. */
  elapsedMs: number;
  /** Output size in bytes, when the file was written. */
  bytes: number | null;
  /** Probe of the source file, when ffprobe was available. */
  source: MediaInfo | null;
  /** Non-fatal notes about what was normalised, ready to be localised. */
  warnings: Notice[];
}
