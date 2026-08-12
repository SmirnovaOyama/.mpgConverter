/**
 * Parsing the human-readable banner ffmpeg prints for its inputs.
 *
 * This is the metadata path used whenever ffprobe's JSON is unavailable: on the
 * CLI when ffprobe is missing, and in the browser build, where the only ffmpeg
 * there is runs as WebAssembly and reports through its log callback.
 *
 * Deliberately free of any Node imports so it can be bundled for the browser.
 */

import type { MediaInfo } from "./types.ts";

/** Channel counts for the layout names ffmpeg prints in its stream banner. */
const CHANNEL_LAYOUTS: Record<string, number> = {
  mono: 1,
  stereo: 2,
  downmix: 2,
  "2.1": 3,
  "3.0": 3,
  "3.1": 4,
  "4.0": 4,
  quad: 4,
  "5.0": 5,
  "5.1": 6,
  "6.0": 6,
  "6.1": 7,
  "7.0": 7,
  "7.1": 8,
};

/** `00:00:05.01` -> seconds. */
function bannerTimecode(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Parse the banner ffmpeg writes for an input file.
 *
 * Less precise than ffprobe's JSON — frame rates arrive rounded to two decimals —
 * but every value is only ever used after being snapped to a legal MPEG value,
 * so the rounding does not change the result.
 */
export function parseFfmpegBanner(text: string): MediaInfo {
  const info: MediaInfo = { duration: null, size: null, video: null, audio: null };

  const duration = /^\s*Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/m.exec(text);
  if (duration?.[1]) info.duration = bannerTimecode(duration[1]);

  const streamLine = /^\s*Stream #\d+:(\d+)[^\s:]*(?:\([^)]*\))?:\s*(Video|Audio):\s*(.*)$/gm;
  for (let match = streamLine.exec(text); match; match = streamLine.exec(text)) {
    const index = Number(match[1]);
    const kind = match[2];
    const rest = match[3] ?? "";

    if (kind === "Video" && !info.video) {
      // Cover art masquerades as a video stream; ffmpeg labels it.
      if (/attached pic/i.test(rest)) continue;
      const size = /(?:^|[\s,])(\d{2,5})x(\d{2,5})(?:[\s,[]|$)/.exec(rest);
      const fps = /([\d.]+)\s*fps/.exec(rest);
      info.video = {
        index,
        codec: /^([\w-]+)/.exec(rest)?.[1] ?? null,
        width: size?.[1] ? Number(size[1]) : null,
        height: size?.[2] ? Number(size[2]) : null,
        fps: fps?.[1] && Number(fps[1]) > 0 ? Number(fps[1]) : null,
        sampleRate: null,
        channels: null,
      };
    } else if (kind === "Audio" && !info.audio) {
      const rate = /(\d+)\s*Hz/.exec(rest);
      const explicit = /(\d+)\s*channels?/.exec(rest);
      const layout = Object.keys(CHANNEL_LAYOUTS).find((name) =>
        new RegExp(`(?:^|,\\s*)${name.replace(".", "\\.")}(?:\\(|,|\\s|$)`).test(rest),
      );
      info.audio = {
        index,
        codec: /^([\w-]+)/.exec(rest)?.[1] ?? null,
        width: null,
        height: null,
        fps: null,
        sampleRate: rate?.[1] ? Number(rate[1]) : null,
        channels: explicit?.[1] ? Number(explicit[1]) : layout ? CHANNEL_LAYOUTS[layout]! : null,
      };
    }
  }

  return info;
}
