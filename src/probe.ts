/**
 * Reading media metadata.
 *
 * ffprobe is preferred, but it is genuinely often missing — `ffmpeg-static`
 * ships only ffmpeg, and `ffprobe-static` publishes an x86-64 binary for macOS
 * that cannot run on Apple Silicon. So there is a second path that parses the
 * banner `ffmpeg -i` prints, which recovers everything the converter needs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseFfmpegBanner } from "./banner.ts";
import type { BinaryPaths, MediaInfo, StreamInfo } from "./types.ts";

export { parseFfmpegBanner } from "./banner.ts";

const execFileAsync = promisify(execFile);

/** Parse ffprobe's `"30000/1001"` rational strings. Returns `null` for `"0/0"`. */
export function parseRational(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [numText, denText] = value.split("/");
  const num = Number(numText);
  const den = denText === undefined ? 1 : Number(denText);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) return null;
  return num / den;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStream(raw: any): StreamInfo {
  return {
    index: toNumber(raw?.index) ?? 0,
    codec: typeof raw?.codec_name === "string" ? raw.codec_name : null,
    width: toNumber(raw?.width),
    height: toNumber(raw?.height),
    // avg_frame_rate is the honest average; r_frame_rate is the container's
    // nominal base rate and is the better fallback for VFR sources.
    fps: parseRational(raw?.avg_frame_rate) ?? parseRational(raw?.r_frame_rate),
    sampleRate: toNumber(raw?.sample_rate),
    channels: toNumber(raw?.channels),
  };
}

/** Shape ffprobe's JSON into the handful of fields the converter uses. */
export function parseProbeJson(json: unknown): MediaInfo {
  const root = json as any;
  const streams: any[] = Array.isArray(root?.streams) ? root.streams : [];
  const video = streams.find((s) => s?.codec_type === "video" && s?.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s?.codec_type === "audio");

  return {
    duration: toNumber(root?.format?.duration),
    size: toNumber(root?.format?.size),
    video: video ? toStream(video) : null,
    audio: audio ? toStream(audio) : null,
  };
}

/** Probe by parsing `ffmpeg -i`, which exits non-zero because no output was given. */
async function probeWithFfmpeg(file: string, ffmpeg: string): Promise<MediaInfo | null> {
  try {
    await execFileAsync(ffmpeg, ["-hide_banner", "-i", file], {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return null;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (typeof stderr !== "string" || !stderr.includes("Stream #")) return null;
    const info = parseFfmpegBanner(stderr);
    return info.video || info.audio ? info : null;
  }
}

/**
 * Probe a media file, preferring ffprobe and falling back to `ffmpeg -i`.
 *
 * Returns `null` only when neither path yields anything; the caller then
 * converts without a progress percentage rather than failing.
 */
export async function probeMedia(file: string, binaries: BinaryPaths): Promise<MediaInfo | null> {
  if (binaries.ffprobe) {
    try {
      const { stdout } = await execFileAsync(
        binaries.ffprobe,
        [
          "-v", "error",
          "-print_format", "json",
          "-show_format",
          "-show_streams",
          file,
        ],
        { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      return parseProbeJson(JSON.parse(stdout));
    } catch {
      // Fall through to the ffmpeg banner.
    }
  }
  return probeWithFfmpeg(file, binaries.ffmpeg);
}
