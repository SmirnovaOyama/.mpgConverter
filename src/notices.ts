/**
 * Notices: the non-fatal things the converter had to change about a source.
 *
 * These are produced deep in the encoding logic but displayed in several places
 * — the CLI, JSON output, and a browser UI that may be running in another
 * language — so they travel as a code plus parameters and are turned into
 * prose only at the edge.
 */

/** What a notice is about. */
export type NoticeCode =
  | "frame-rate-snapped"
  | "audio-resampled"
  | "size-rounded"
  | "odd-dimensions"
  | "preset-overridden"
  | "probe-failed"
  | "output-exists"
  | "large-file";

/** Which setting was overridden on a disc preset. */
export type OverriddenSetting =
  | "video-bitrate"
  | "audio-bitrate"
  | "quantiser"
  | "frame-rate"
  | "frame-size";

export interface Notice {
  code: NoticeCode;
  params: Record<string, string | number>;
}

/** Languages the notices can be rendered in. */
export type Locale = "en" | "zh";

export function notice(code: NoticeCode, params: Record<string, string | number> = {}): Notice {
  return { code, params };
}

const SETTING_NAMES: Record<Locale, Record<OverriddenSetting, string>> = {
  en: {
    "video-bitrate": "Video bitrate",
    "audio-bitrate": "Audio bitrate",
    quantiser: "Quantiser",
    "frame-rate": "Frame rate",
    "frame-size": "Frame size",
  },
  zh: {
    "video-bitrate": "视频码率",
    "audio-bitrate": "音频码率",
    quantiser: "量化参数",
    "frame-rate": "帧率",
    "frame-size": "画面尺寸",
  },
};

type Renderer = (params: Record<string, string | number>, locale: Locale) => string;

const MESSAGES: Record<Locale, Record<NoticeCode, Renderer>> = {
  en: {
    "frame-rate-snapped": (p) =>
      `Frame rate snapped ${p["from"]} -> ${p["to"]} (MPEG-1/2 allows a fixed set)`,
    "audio-resampled": (p) =>
      `Audio resampled ${p["from"]} Hz -> ${p["to"]} Hz (MP2 requires 32/44.1/48 kHz)`,
    "size-rounded": (p) =>
      `Size rounded ${p["from"]} -> ${p["to"]} (MPEG needs even dimensions)`,
    "odd-dimensions": (p) => `Odd source dimensions ${p["from"]} cropped to ${p["to"]}`,
    "preset-overridden": (p, locale) =>
      `${SETTING_NAMES[locale][p["setting"] as OverriddenSetting]} overridden on preset ${p["preset"]}; output may not be spec-compliant`,
    "probe-failed": () => "Could not analyse the source; converting with safe defaults",
    "output-exists": () => "Output already exists (use --overwrite to replace it)",
    "large-file": (p) =>
      `${p["size"]} is large for in-browser conversion and may run out of memory`,
  },
  zh: {
    "frame-rate-snapped": (p) => `帧率已调整：${p["from"]} → ${p["to"]}（MPEG-1/2 只允许固定的几种帧率）`,
    "audio-resampled": (p) =>
      `音频已重采样：${p["from"]} Hz → ${p["to"]} Hz（MP2 只支持 32/44.1/48 kHz）`,
    "size-rounded": (p) => `尺寸已取整：${p["from"]} → ${p["to"]}（MPEG 要求宽高为偶数）`,
    "odd-dimensions": (p) => `源尺寸为奇数 ${p["from"]}，已裁剪为 ${p["to"]}`,
    "preset-overridden": (p, locale) =>
      `预设 ${p["preset"]} 的${SETTING_NAMES[locale][p["setting"] as OverriddenSetting]}已被覆盖，输出可能不符合规范`,
    "probe-failed": () => "无法分析源文件，将使用安全的默认设置转换",
    "output-exists": () => "输出文件已存在（使用 --overwrite 覆盖）",
    "large-file": (p) => `${p["size"]} 对浏览器内转换来说偏大，可能会耗尽内存`,
  },
};

/** Render a notice as a sentence in the given language. */
export function formatNotice(item: Notice, locale: Locale = "en"): string {
  const table = MESSAGES[locale] ?? MESSAGES.en;
  const render = table[item.code];
  // An unknown code should still surface something rather than vanish.
  return render ? render(item.params, locale) : item.code;
}

export function formatNotices(notices: readonly Notice[], locale: Locale = "en"): string[] {
  return notices.map((item) => formatNotice(item, locale));
}
