/** Running ffmpeg for a single file, with progress and atomic output. */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveBinaries } from "./binaries.ts";
import { ConversionError } from "./errors.ts";
import { buildFfmpegArgs, isPresetName, PRESETS } from "./presets.ts";
import { probeMedia } from "./probe.ts";
import { notice, type Notice } from "./notices.ts";
import { defaultOutputPath } from "./discover.ts";
import type { ConvertOptions, ConvertResult, MediaInfo, Progress } from "./types.ts";

/** How much of ffmpeg's stderr to keep for error reporting. */
const STDERR_LIMIT = 64 * 1024;

/** `00:01:02.345678` -> seconds. */
export function parseTimecode(value: string): number | null {
  const match = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Turn one `-progress` block (a run of `key=value` lines) into a Progress.
 *
 * `out_time` is preferred over `out_time_ms`, whose units have historically been
 * microseconds despite the name.
 */
export function parseProgressBlock(
  fields: Map<string, string>,
  input: string,
  duration: number | null,
): Progress {
  const timecode = fields.get("out_time");
  const micros = fields.get("out_time_us") ?? fields.get("out_time_ms");

  let seconds = 0;
  const fromTimecode = timecode ? parseTimecode(timecode) : null;
  if (fromTimecode !== null) {
    seconds = fromTimecode;
  } else if (micros !== undefined) {
    const parsed = Number(micros);
    if (Number.isFinite(parsed)) seconds = Math.max(0, parsed / 1_000_000);
  }

  const frames = Number(fields.get("frame"));
  const bytes = Number(fields.get("total_size"));
  const speed = Number(String(fields.get("speed") ?? "").replace(/x$/, ""));

  return {
    input,
    seconds,
    ratio: duration && duration > 0 ? Math.min(1, seconds / duration) : null,
    frames: Number.isFinite(frames) ? frames : null,
    speed: Number.isFinite(speed) && speed > 0 ? speed : null,
    bytes: Number.isFinite(bytes) ? bytes : null,
  };
}

interface RunOptions {
  input: string;
  duration: number | null;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

/** Spawn ffmpeg and resolve when it exits cleanly. */
function runFfmpeg(bin: string, args: string[], options: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    let stderr = "";
    let stdoutBuffer = "";
    const fields = new Map<string, string>();
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };

    function onAbort() {
      child.kill("SIGTERM");
      // ffmpeg normally exits promptly; escalate if it does not.
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref?.();
      finish(new ConversionError("ABORTED", `Conversion of ${options.input} was cancelled`));
    }

    if (options.signal) {
      if (options.signal.aborted) {
        child.kill("SIGKILL");
        finish(new ConversionError("ABORTED", `Conversion of ${options.input} was cancelled`));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        const equals = line.indexOf("=");
        if (equals === -1) continue;
        const key = line.slice(0, equals).trim();
        const value = line.slice(equals + 1).trim();
        fields.set(key, value);
        // `progress` terminates each block.
        if (key === "progress") {
          if (options.onProgress) {
            options.onProgress(parseProgressBlock(fields, options.input, options.duration));
          }
          fields.clear();
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT);
    });

    child.once("error", (error) => {
      finish(
        new ConversionError(
          "FFMPEG_FAILED",
          `Could not start ffmpeg: ${error.message}`,
          stderr.trim() || undefined,
        ),
      );
    });

    child.once("close", (code, signalName) => {
      if (code === 0) {
        finish();
        return;
      }
      const how = signalName ? `signal ${signalName}` : `exit code ${code}`;
      finish(
        new ConversionError(
          "FFMPEG_FAILED",
          `ffmpeg failed with ${how} while converting ${options.input}`,
          stderr.trim() || undefined,
        ),
      );
    });
  });
}

async function statOrNull(file: string) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/**
 * Convert one file to `.mpg`.
 *
 * ffmpeg writes to a temporary sibling file that is renamed into place only on
 * success, so an interrupted run never leaves a truncated `.mpg` behind.
 */
export async function convertToMpg(options: ConvertOptions): Promise<ConvertResult> {
  const presetName = options.preset ?? "mpeg2";
  if (!isPresetName(presetName)) {
    throw new ConversionError("BAD_OPTION", `Unknown preset ${JSON.stringify(presetName)}`);
  }
  const preset = PRESETS[presetName];

  const input = path.resolve(options.input);
  const output = path.resolve(options.output ?? defaultOutputPath(input));

  const inputStat = await statOrNull(input);
  if (!inputStat) {
    throw new ConversionError("INPUT_NOT_FOUND", `Input file not found: ${options.input}`);
  }
  if (!inputStat.isFile()) {
    throw new ConversionError("NOT_A_FILE", `Not a file: ${options.input}`);
  }
  if (input === output) {
    throw new ConversionError(
      "OUTPUT_COLLISION",
      `Refusing to overwrite the input file: ${input}`,
      "Pass --output to write somewhere else.",
    );
  }

  const warnings: Notice[] = [];
  const binaries = await resolveBinaries(options);

  const info: MediaInfo | null = await probeMedia(input, binaries);
  if (!info) {
    warnings.push(notice("probe-failed"));
  }
  if (info && !info.video) {
    throw new ConversionError(
      "NO_VIDEO_STREAM",
      `No video stream in ${options.input}`,
      "MPEG program streams need video; convert audio-only files with ffmpeg directly.",
    );
  }

  const existing = await statOrNull(output);
  if (existing && !options.overwrite && !options.dryRun) {
    return {
      status: "skipped",
      input,
      output,
      command: [],
      elapsedMs: 0,
      bytes: existing.size,
      source: info,
      warnings: [...warnings, notice("output-exists")],
    };
  }

  const tempOutput = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${randomBytes(4).toString("hex")}.part`,
  );

  const args = buildFfmpegArgs({ input, output: tempOutput, preset, options, info, warnings });

  if (options.dryRun) {
    return {
      status: "dry-run",
      input,
      output,
      // Show the real destination rather than the temporary name.
      command: [binaries.ffmpeg, ...args.map((arg) => (arg === tempOutput ? output : arg))],
      elapsedMs: 0,
      bytes: null,
      source: info,
      warnings,
    };
  }

  await fs.mkdir(path.dirname(output), { recursive: true });

  const startedAt = Date.now();
  try {
    await runFfmpeg(binaries.ffmpeg, args, {
      input,
      duration: info?.duration ?? null,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    await fs.rename(tempOutput, output);
  } catch (error) {
    await fs.rm(tempOutput, { force: true }).catch(() => {});
    throw error;
  }

  const finalStat = await statOrNull(output);
  return {
    status: "converted",
    input,
    output,
    command: [binaries.ffmpeg, ...args],
    elapsedMs: Date.now() - startedAt,
    bytes: finalStat?.size ?? null,
    source: info,
    warnings,
  };
}
