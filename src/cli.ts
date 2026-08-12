#!/usr/bin/env node
/** Command line front end: `mpgconv <input...> [options]`. */

import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { convertMany } from "./index.ts";
import { ConversionError } from "./errors.ts";
import { expandInputs, VIDEO_EXTENSIONS } from "./discover.ts";
import { isPresetName, PRESET_NAMES, PRESETS } from "./presets.ts";
import { formatNotice } from "./notices.ts";
import type { ConvertResult, PresetName, Progress, QualityTier } from "./types.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_NO_FFMPEG = 3;
const EXIT_CANCELLED = 130;

function version(): string {
  try {
    const require = createRequire(import.meta.url);
    return require("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function usage(): string {
  const presets = PRESET_NAMES.map((name) => `    ${name.padEnd(11)} ${PRESETS[name].description}`).join("\n");
  return `mpgconv — convert video files to MPEG program streams (.mpg)

Usage
  mpgconv <input...> [options]

Inputs may be files or directories. Files named directly are converted whatever
their extension (ffmpeg detects the real container); directories are scanned for
known video extensions, extendable with --ext.

Options
  -o, --output <path>        Output file, or output directory for multiple inputs
  -d, --output-dir <dir>     Write every output into <dir>
  -p, --preset <name>        Encoding preset (default: mpeg2)
  -b, --video-bitrate <rate> Video bitrate, e.g. 4000k or 1.5M
  -a, --audio-bitrate <rate> Audio bitrate, e.g. 224k
  -q, --qscale <1-31>        Constant quantiser instead of a target bitrate
  -r, --fps <n>              Output frame rate (snapped to a legal MPEG rate)
  -s, --size <WxH>           Output frame size, e.g. 720x480
  -Q, --quality <tier>       fast | balanced | best (default: balanced)
  -j, --jobs <n>             Convert n files at once (default: 1)
  -e, --ext <ext>            Extra extension to pick up when scanning directories
  -R, --recursive            Recurse into subdirectories
  -y, --overwrite            Replace existing output files
  -n, --dry-run              Print the ffmpeg command without running it
      --json                 Emit machine-readable JSON results
      --quiet                Suppress progress output
      --list-presets         Show the available presets and exit
  -h, --help                 Show this help
  -V, --version              Show the version

Presets
${presets}

Environment
  FFMPEG_PATH, FFPROBE_PATH  Explicit binary locations, overriding auto-detection

Examples
  mpgconv holiday.mp4
  mpgconv clip.mov -o /tmp/clip.mpg -p mpeg1 -b 1200k
  mpgconv ./footage -R -d ./out -j 4 -y
  mpgconv weird-file.~ --dry-run
`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Renders a single-line progress bar, redrawn in place on a TTY. */
function createProgressBar() {
  let active = false;
  return {
    render(label: string, progress: Progress): void {
      const columns = Math.max(40, process.stderr.columns ?? 80);
      const width = 20;
      const ratio = progress.ratio;
      const filled = ratio === null ? 0 : Math.round(ratio * width);
      const bar = ratio === null ? "-".repeat(width) : "#".repeat(filled) + ".".repeat(width - filled);
      const percent = ratio === null ? "  ??%" : `${String(Math.round(ratio * 100)).padStart(3)}%`;
      const speed = progress.speed ? ` ${progress.speed.toFixed(1)}x` : "";
      const tail = ` [${bar}] ${percent} ${formatSeconds(progress.seconds)}${speed}`;
      const room = Math.max(8, columns - tail.length - 1);
      const name = label.length > room ? `…${label.slice(label.length - room + 1)}` : label.padEnd(room);
      process.stderr.write(`\r${name}${tail}`);
      active = true;
    },
    clear(): void {
      if (!active) return;
      const columns = Math.max(40, process.stderr.columns ?? 80);
      process.stderr.write(`\r${" ".repeat(columns - 1)}\r`);
      active = false;
    },
  };
}

function parseSize(value: string): [number, number] {
  const match = /^(\d+)\s*[xX]\s*(\d+)$/.exec(value.trim());
  if (!match) {
    throw new ConversionError("BAD_OPTION", `Invalid --size ${JSON.stringify(value)} (expected e.g. 720x480)`);
  }
  return [Number(match[1]), Number(match[2])];
}

function parsePositiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConversionError("BAD_OPTION", `${flag} expects a positive number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: "string", short: "o" },
        "output-dir": { type: "string", short: "d" },
        preset: { type: "string", short: "p" },
        "video-bitrate": { type: "string", short: "b" },
        "audio-bitrate": { type: "string", short: "a" },
        qscale: { type: "string", short: "q" },
        fps: { type: "string", short: "r" },
        size: { type: "string", short: "s" },
        quality: { type: "string", short: "Q" },
        jobs: { type: "string", short: "j" },
        ext: { type: "string", short: "e", multiple: true },
        recursive: { type: "boolean", short: "R", default: false },
        overwrite: { type: "boolean", short: "y", default: false },
        "dry-run": { type: "boolean", short: "n", default: false },
        json: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        "list-presets": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    return EXIT_USAGE;
  }

  const flags = parsed.values;

  if (flags.help) {
    process.stdout.write(usage());
    return EXIT_OK;
  }
  if (flags.version) {
    process.stdout.write(`${version()}\n`);
    return EXIT_OK;
  }
  if (flags["list-presets"]) {
    for (const name of PRESET_NAMES) {
      process.stdout.write(`${name.padEnd(11)} ${PRESETS[name].description}\n`);
    }
    return EXIT_OK;
  }
  if (parsed.positionals.length === 0) {
    process.stderr.write(`No input files given.\n\n${usage()}`);
    return EXIT_USAGE;
  }

  const json = flags.json === true;
  const quiet = flags.quiet === true || json;

  // --- Validate options before touching the filesystem ---
  let preset: PresetName = "mpeg2";
  let quality: QualityTier = "balanced";
  let size: [number, number] | undefined;
  let fps: number | undefined;
  let qscale: number | undefined;
  let jobs = 1;

  try {
    if (flags.preset !== undefined) {
      if (!isPresetName(flags.preset)) {
        throw new ConversionError(
          "BAD_OPTION",
          `Unknown preset ${JSON.stringify(flags.preset)}. Available: ${PRESET_NAMES.join(", ")}`,
        );
      }
      preset = flags.preset;
    }
    if (flags.quality !== undefined) {
      if (flags.quality !== "fast" && flags.quality !== "balanced" && flags.quality !== "best") {
        throw new ConversionError(
          "BAD_OPTION",
          `Unknown --quality ${JSON.stringify(flags.quality)}. Available: fast, balanced, best`,
        );
      }
      quality = flags.quality;
    }
    if (flags.size !== undefined) size = parseSize(flags.size);
    if (flags.fps !== undefined) fps = parsePositiveNumber(flags.fps, "--fps");
    if (flags.qscale !== undefined) qscale = parsePositiveNumber(flags.qscale, "--qscale");
    if (flags.jobs !== undefined) jobs = Math.floor(parsePositiveNumber(flags.jobs, "--jobs"));
    if (flags.output && flags["output-dir"]) {
      throw new ConversionError("BAD_OPTION", "Use either --output or --output-dir, not both");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }

  // --- Resolve inputs and destinations ---
  let inputs: string[];
  try {
    inputs = await expandInputs(parsed.positionals, {
      recursive: flags.recursive === true,
      extensions: flags.ext ?? [],
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }

  if (inputs.length === 0) {
    process.stderr.write(
      `No video files found.\nScanned extensions: ${VIDEO_EXTENSIONS.join(" ")}\n` +
        `Add more with --ext, recurse with --recursive, or name files directly.\n`,
    );
    return EXIT_USAGE;
  }

  let outputDir: string | undefined = flags["output-dir"];
  let singleOutput: string | undefined;
  if (flags.output) {
    // One input plus a plain path means "write exactly here"; anything else
    // (several inputs, or a path that is already a directory) means a directory.
    if (inputs.length > 1 || (await isDirectory(flags.output))) {
      outputDir = flags.output;
    } else {
      singleOutput = flags.output;
    }
  }

  // --- Convert ---
  const controller = new AbortController();
  let cancelled = false;
  const onSigint = () => {
    cancelled = true;
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  const bar = createProgressBar();
  const showBar = !quiet && jobs === 1 && process.stderr.isTTY === true && flags["dry-run"] !== true;
  const total = inputs.length;

  const describe = (result: ConvertResult): string => {
    const seconds = result.elapsedMs / 1000;
    return `${path.relative(process.cwd(), result.output) || result.output} (${formatBytes(result.bytes)}${
      seconds >= 0.05 ? `, ${seconds.toFixed(1)}s` : ""
    })`;
  };

  const printWarnings = (result: ConvertResult) => {
    if (quiet) return;
    // The CLI is English-only; the browser renders the same notices localised.
    for (const warning of result.warnings) {
      process.stderr.write(`  ! ${formatNotice(warning, "en")}\n`);
    }
  };

  try {
    const { results, failures } = await convertMany(inputs, {
      preset,
      quality,
      ...(size ? { size } : {}),
      ...(fps !== undefined ? { fps } : {}),
      ...(qscale !== undefined ? { qscale } : {}),
      ...(flags["video-bitrate"] ? { videoBitrate: flags["video-bitrate"] } : {}),
      ...(flags["audio-bitrate"] ? { audioBitrate: flags["audio-bitrate"] } : {}),
      overwrite: flags.overwrite === true,
      dryRun: flags["dry-run"] === true,
      jobs,
      signal: controller.signal,
      ...(outputDir ? { outputDir } : {}),
      ...(singleOutput ? { output: singleOutput } : {}),
      onFileStart: (input, index) => {
        if (quiet || showBar) return;
        process.stderr.write(`[${index + 1}/${total}] ${path.relative(process.cwd(), input) || input}\n`);
      },
      onProgress: showBar
        ? (progress) => bar.render(path.relative(process.cwd(), progress.input) || progress.input, progress)
        : undefined,
      onFileDone: (result, index) => {
        if (showBar) bar.clear();
        if (result.status === "dry-run") {
          if (!json) process.stdout.write(`${result.command.map(quoteArg).join(" ")}\n`);
        } else if (!quiet) {
          const prefix = `[${index + 1}/${total}]`;
          const verb = result.status === "skipped" ? "skip" : "done";
          process.stderr.write(`${prefix} ${verb} ${describe(result)}\n`);
        }
        printWarnings(result);
      },
      onFileError: (input, error, index) => {
        if (showBar) bar.clear();
        if (json) return;
        const label = path.relative(process.cwd(), input) || input;
        process.stderr.write(`[${index + 1}/${total}] FAIL ${label}: ${error.message}\n`);
        if (error instanceof ConversionError && error.detail) {
          process.stderr.write(`${indent(error.detail)}\n`);
        }
      },
    });

    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            results: results.map((result) => ({
              ...result,
              warnings: result.warnings.map((warning) => ({
                ...warning,
                message: formatNotice(warning, "en"),
              })),
            })),
            failures: failures.map((failure) => ({
              input: failure.input,
              error: failure.error.message,
              code: failure.error instanceof ConversionError ? failure.error.code : null,
            })),
          },
          null,
          2,
        )}\n`,
      );
    }

    if (cancelled) return EXIT_CANCELLED;
    if (failures.length > 0) {
      if (!quiet) {
        process.stderr.write(`\n${failures.length} of ${total} file(s) failed.\n`);
      }
      return EXIT_FAILED;
    }
    return EXIT_OK;
  } catch (error) {
    if (showBar) bar.clear();
    if (cancelled) return EXIT_CANCELLED;
    if (error instanceof ConversionError) {
      process.stderr.write(`${error.message}\n`);
      if (error.detail) process.stderr.write(`${error.detail}\n`);
      return error.code === "FFMPEG_NOT_FOUND" ? EXIT_NO_FFMPEG : EXIT_FAILED;
    }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return EXIT_FAILED;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }
}

/** Quote an argument so the printed --dry-run command can be pasted into a shell. */
export function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

// Only self-execute as a program, so tests can import `main` freely.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
