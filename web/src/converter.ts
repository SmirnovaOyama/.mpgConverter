/**
 * Browser conversion via ffmpeg.wasm.
 *
 * Everything runs in the visitor's tab: no upload, no server. The encoding
 * decisions come from the same `buildEncodeArgs` the CLI uses, and the source is
 * inspected by parsing ffmpeg's own log banner — which stands in for ffprobe,
 * since there is no ffprobe in the WebAssembly build.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { parseFfmpegBanner } from "../../src/banner.ts";
import { buildEncodeArgs, PRESETS } from "../../src/presets.ts";
import { notice, type Notice } from "../../src/notices.ts";
import type { EncodeOptions, MediaInfo, PresetName } from "../../src/types.ts";

/**
 * Where the ~32 MB WebAssembly core is fetched from.
 *
 * It cannot be served from Cloudflare Workers static assets, whose per-file
 * limit is 25 MiB, so the default is a CDN. Override with `VITE_CORE_BASE` to
 * self-host from R2 or, in local development, from `web/public/core`.
 */
// Must be the ESM build: ffmpeg.wasm always spawns its worker with
// `type: "module"`, where `importScripts` does not exist, so the worker reaches
// the core through a dynamic `import()` that a UMD script cannot satisfy.
const CDN_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";
const CORE_BASE: string = (import.meta.env.VITE_CORE_BASE as string | undefined) ?? CDN_BASE;

/** Beyond roughly this size the wasm heap tends to run out before finishing. */
export const LARGE_FILE_BYTES = 300 * 1024 * 1024;

export interface LoadProgress {
  received: number;
  total: number;
  file: string;
}

export interface ConversionProgress {
  /** 0..1, or `null` when the duration is unknown. */
  ratio: number | null;
  /** Seconds of output encoded so far. */
  seconds: number;
}

export interface WebConvertResult {
  blob: Blob;
  /** Suggested download filename. */
  name: string;
  bytes: number;
  info: MediaInfo | null;
  warnings: Notice[];
  /** The ffmpeg arguments used, for display. */
  command: string[];
  elapsedMs: number;
}

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

/** Set by {@link cancelConversion} so the in-flight job can report accurately. */
let cancelled = false;

/** Thrown by {@link convertFile} when the user stopped the job. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Stop the running conversion.
 *
 * ffmpeg.wasm's `signal` option only rejects the pending promise — the worker
 * carries on encoding, burning CPU and blocking the next job. Terminating the
 * worker is the only way to actually stop it, at the cost of reloading the core
 * next time (served from the browser cache, so it is quick).
 */
export function cancelConversion(): void {
  if (!instance) return;
  cancelled = true;
  instance.terminate();
  instance = null;
  loading = null;
}

/** Log lines from the current ffmpeg invocation, used for probing and errors. */
let logBuffer: string[] = [];

/** Fetch a URL into a blob: URL, reporting download progress. */
async function toBlobURL(
  url: string,
  mimeType: string,
  onProgress?: (progress: LoadProgress) => void,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url} (HTTP ${response.status})`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const file = url.slice(url.lastIndexOf("/") + 1);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ received, total, file });
  }

  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mimeType }));
}

/** Download and initialise the ffmpeg core. Safe to call repeatedly. */
export function loadFfmpeg(onProgress?: (progress: LoadProgress) => void): Promise<FFmpeg> {
  if (instance) return Promise.resolve(instance);
  if (loading) return loading;

  const fetchCore = (base: string) =>
    Promise.all([
      toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript", onProgress),
      toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm", onProgress),
    ]);

  loading = (async () => {
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      logBuffer.push(message);
      // The banner is short; this only guards against a runaway encoder log.
      if (logBuffer.length > 4000) logBuffer.splice(0, 2000);
    });

    let urls: [string, string];
    try {
      urls = await fetchCore(CORE_BASE);
    } catch (error) {
      // A self-hosted core that is missing should not break the app.
      if (CORE_BASE === CDN_BASE) throw error;
      urls = await fetchCore(CDN_BASE);
    }

    await ffmpeg.load({ coreURL: urls[0], wasmURL: urls[1] });
    instance = ffmpeg;
    return ffmpeg;
  })();

  // Allow a retry after a failed load.
  loading.catch(() => {
    loading = null;
  });

  return loading;
}

/** True once the core is in memory, so the UI can skip the loading state. */
export function isLoaded(): boolean {
  return instance !== null;
}

/**
 * ffmpeg's virtual filesystem is happiest with plain ASCII names, and the name
 * ends up inside a command line, so strip anything surprising.
 */
function safeName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, "_").replace(/^[._]+/, "");
  return cleaned.length > 0 ? cleaned.slice(-80) : fallback;
}

/** Replace the extension with `.mpg` for the download name. */
export function downloadName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const isAlreadyMpg = dot > 0 && name.slice(dot).toLowerCase() === ".mpg";
  return `${stem}${isAlreadyMpg ? ".converted" : ""}.mpg`;
}

/**
 * Inspect the source by running a no-output pass and parsing the banner.
 *
 * Uses the `null` muxer rather than a bare `-i`, so ffmpeg exits cleanly and the
 * wasm instance stays usable for the real encode.
 */
async function probe(ffmpeg: FFmpeg, name: string): Promise<MediaInfo | null> {
  logBuffer = [];
  try {
    await ffmpeg.exec(["-hide_banner", "-i", name, "-t", "0.001", "-f", "null", "-"]);
  } catch {
    // A failure here is not fatal; fall through and see what the log holds.
  }
  const text = logBuffer.join("\n");
  if (!text.includes("Stream #")) return null;
  const info = parseFfmpegBanner(text);
  return info.video || info.audio ? info : null;
}

export interface ConvertFileOptions extends EncodeOptions {
  onProgress?: (progress: ConversionProgress) => void;
  signal?: AbortSignal;
}

/**
 * Convert one file to `.mpg` entirely in the browser.
 *
 * The shared ffmpeg instance handles one job at a time, so callers must not run
 * these concurrently.
 */
export async function convertFile(file: File, options: ConvertFileOptions = {}): Promise<WebConvertResult> {
  cancelled = false;
  const ffmpeg = await loadFfmpeg();
  const presetName: PresetName = options.preset ?? "mpeg2";
  const preset = PRESETS[presetName];

  const inputName = safeName(file.name, "input.bin");
  const outputName = "output.mpg";
  const startedAt = performance.now();

  await ffmpeg.writeFile(inputName, await fetchFile(file));

  try {
    const info = await probe(ffmpeg, inputName);
    const warnings: Notice[] = [];
    if (!info) warnings.push(notice("probe-failed"));

    const args = ["-i", inputName, ...buildEncodeArgs({ preset, options, info, warnings }), outputName];

    const duration = info?.duration ?? null;
    const onProgress = options.onProgress;
    const handler = ({ time }: { progress: number; time: number }) => {
      // `time` is microseconds of output written.
      const seconds = Math.max(0, time / 1_000_000);
      onProgress?.({
        seconds,
        ratio: duration && duration > 0 ? Math.min(1, seconds / duration) : null,
      });
    };
    if (onProgress) ffmpeg.on("progress", handler);

    logBuffer = [];
    let code: number;
    try {
      if (options.signal?.aborted) throw new CancelledError();
      code = await ffmpeg.exec(args);
    } catch (error) {
      // Terminating the worker rejects this promise; report it as a cancel.
      throw cancelled ? new CancelledError() : error;
    } finally {
      if (onProgress) ffmpeg.off("progress", handler);
    }

    if (cancelled) throw new CancelledError();
    if (code !== 0) {
      const tail = logBuffer.slice(-6).join("\n").trim();
      throw new Error(tail || `ffmpeg exited with code ${code}`);
    }

    const data = await ffmpeg.readFile(outputName);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) throw new Error("ffmpeg produced an empty file");

    return {
      blob: new Blob([bytes as BlobPart], { type: "video/mpeg" }),
      name: downloadName(file.name),
      bytes: bytes.length,
      info,
      warnings,
      command: ["ffmpeg", ...args],
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    // Free the wasm heap whatever happened, or the next file runs out of memory.
    // After a cancel the worker is gone and these simply reject; that is fine.
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
