/**
 * mpg-converter — convert any video ffmpeg can read into an MPEG program stream.
 *
 * ```ts
 * import { convertToMpg } from "mpg-converter";
 *
 * const result = await convertToMpg({
 *   input: "clip.mov",
 *   preset: "mpeg2",
 *   onProgress: (p) => console.log(p.ratio),
 * });
 * console.log(result.output); // clip.mpg
 * ```
 */

import { convertToMpg } from "./convert.ts";
import { resolveOutputPath } from "./discover.ts";
import type { ConvertOptions, ConvertResult } from "./types.ts";

export { convertToMpg, parseProgressBlock, parseTimecode } from "./convert.ts";
export { resolveBinaries, clearBinaryCache } from "./binaries.ts";
export { probeMedia, parseFfmpegBanner, parseProbeJson, parseRational } from "./probe.ts";
export {
  buildEncodeArgs,
  buildFfmpegArgs,
  formatBitrate,
  isPresetName,
  MP2_SAMPLE_RATES,
  MPEG_FRAME_RATES,
  parseBitrate,
  PRESET_NAMES,
  PRESETS,
  snapFrameRate,
  snapSampleRate,
} from "./presets.ts";
export {
  defaultOutputPath,
  expandInputs,
  normalizeExtension,
  resolveOutputPath,
  VIDEO_EXTENSIONS,
} from "./discover.ts";
export { ConversionError } from "./errors.ts";
export { formatNotice, formatNotices, notice } from "./notices.ts";
export type { Locale, Notice, NoticeCode, OverriddenSetting } from "./notices.ts";
export type { ErrorCode } from "./errors.ts";
export type {
  BinaryPaths,
  ConvertOptions,
  ConvertResult,
  ConvertStatus,
  EncodeOptions,
  MediaInfo,
  PresetName,
  Progress,
  QualityTier,
  StreamInfo,
} from "./types.ts";

/** A conversion that threw, kept alongside the successes in a batch run. */
export interface ConvertFailure {
  input: string;
  error: Error;
}

export interface BatchOptions extends Omit<ConvertOptions, "input"> {
  /**
   * Exact destination for the output. Only honoured when there is a single
   * input; with several inputs use `outputDir`.
   */
  output?: string;
  /** Destination directory for every output. Defaults to each input's own directory. */
  outputDir?: string;
  /** How many files to convert at once. Defaults to 1. */
  jobs?: number;
  /** Keep going after a file fails. Defaults to `true`. */
  continueOnError?: boolean;
  /** Called as each file starts. */
  onFileStart?: (input: string, index: number, total: number) => void;
  /** Called as each file finishes successfully. */
  onFileDone?: (result: ConvertResult, index: number, total: number) => void;
  /** Called when a file fails, whether or not the batch continues. */
  onFileError?: (input: string, error: Error, index: number, total: number) => void;
}

export interface BatchResult {
  results: ConvertResult[];
  failures: ConvertFailure[];
}

/**
 * Convert many files, optionally several at a time.
 *
 * Failures are collected rather than thrown unless `continueOnError` is `false`,
 * so one bad file does not abandon the rest of a batch.
 */
export async function convertMany(inputs: string[], options: BatchOptions = {}): Promise<BatchResult> {
  const jobs = Math.max(1, Math.floor(options.jobs ?? 1));
  const total = inputs.length;
  // Indexed so that results stay in input order regardless of completion order.
  const slots = new Array<ConvertResult | undefined>(total);
  const failures: ConvertFailure[] = [];

  // An exact `output` only makes sense for a single input.
  const explicitOutput = total === 1 ? options.output : undefined;

  // Shared cursor: each worker takes the next index until the list is exhausted.
  let cursor = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = cursor++;
      if (index >= total) return;
      const input = inputs[index]!;

      options.onFileStart?.(input, index, total);
      try {
        const result = await convertToMpg({
          ...options,
          input,
          output:
            explicitOutput ??
            resolveOutputPath({
              input,
              output: options.outputDir,
              outputIsDirectory: true,
            }),
        });
        slots[index] = result;
        options.onFileDone?.(result, index, total);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push({ input, error: failure });
        options.onFileError?.(input, failure, index, total);
        if (options.continueOnError === false) {
          stopped = true;
          throw failure;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(jobs, total || 1) }, worker));
  return { results: slots.filter((slot): slot is ConvertResult => slot !== undefined), failures };
}
