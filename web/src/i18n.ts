/**
 * Interface strings in English and Chinese.
 *
 * Conversion notices are not here — they originate in the shared encoding code
 * and are translated by `src/notices.ts`, so both front ends stay in step.
 */

import type { Locale } from "../../src/notices.ts";

export type { Locale };

type Dictionary = Record<string, string>;

const EN: Dictionary = {
  "drop.title": "Drop the videos you want to convert here",
  "drop.aria": "Choose video files to convert",
  "drop.browse": "or click here to browse and select files",
  "drop.sample": "try a sample",
  settings: "Settings",
  language: "中文",
  "language.aria": "切换到中文",
  "label.preset": "Preset",
  "label.quality": "Quality",
  "label.videoBitrate": "Video bitrate",
  "label.audioBitrate": "Audio bitrate",
  "label.size": "Frame size",
  "label.fps": "Frame rate",
  "quality.fast": "Fast",
  "quality.balanced": "Balanced",
  "quality.best": "Best",
  "placeholder.fps": "source",
  "hint.blank": "Everything follows the source if you left blank, normalised to what MPEG-1/2 allows.",
  "btn.convert": "Convert",
  "btn.convertMany": "Convert {n} files",
  "btn.clear": "Clear",
  "btn.downloadAll": "Download all",
  "btn.cancel": "Cancel",
  "btn.download": "Download",
  "btn.remove": "Remove",
  "state.queued": "Queued",
  "state.converting": "Converting…",
  "state.convertingPercent": "Converting… {percent}%",
  "state.done": "Done in {seconds}s",
  "state.failed": "Failed",
  "state.cancelled": "Cancelled",
  "status.starting": "Starting the ffmpeg engine…",
  "status.engineFailed": "Engine failed to load: {message}",
  "status.converting": "Converting {index} of {total}…",
  "status.allDone": "All done",
  "status.someFailed": "{count} file(s) failed",
  "status.cancelled": "Cancelled",
  "status.cancelling": "Cancelling…",
  "status.sampleFailed": "Could not load the sample: {message}",
  "loader.downloading": "Downloading the ffmpeg engine…",
  "loader.progress": "Downloading the ffmpeg engine… {done} of {total}",
  footer: "This application runs entirely in your browser, and nothing is uploaded.",
  "error.cancelled": "Cancelled",
  "preset.mpeg2": "MPEG-2 video + MP2 audio in an MPEG program stream (default)",
  "preset.mpeg1": "MPEG-1 video + MP2 audio; maximum compatibility with old players",
  "preset.vcd-ntsc": "Video CD, NTSC (352x240, 29.97fps, 1150k)",
  "preset.vcd-pal": "Video CD, PAL (352x288, 25fps, 1150k)",
  "preset.svcd-ntsc": "Super Video CD, NTSC (480x480, 29.97fps)",
  "preset.svcd-pal": "Super Video CD, PAL (480x576, 25fps)",
  "preset.dvd-ntsc": "DVD-Video, NTSC (720x480, 29.97fps)",
  "preset.dvd-pal": "DVD-Video, PAL (720x576, 25fps)",
};

const ZH: Dictionary = {
  "drop.title": "将要转换的视频拖入到这里",
  "drop.aria": "选择要转换的视频文件",
  "drop.browse": "或者点击此处浏览并选择文件",
  "drop.sample": "试试示例文件",
  settings: "设置",
  language: "EN",
  "language.aria": "Switch to English",
  "label.preset": "预设",
  "label.quality": "质量",
  "label.videoBitrate": "视频码率",
  "label.audioBitrate": "音频码率",
  "label.size": "画面尺寸",
  "label.fps": "帧率",
  "quality.fast": "快速",
  "quality.balanced": "均衡",
  "quality.best": "最佳",
  "placeholder.fps": "跟随源文件",
  "hint.blank": "留空则全部跟随源文件，并自动调整为 MPEG-1/2 允许的取值。",
  "btn.convert": "开始转换",
  "btn.convertMany": "转换 {n} 个文件",
  "btn.clear": "清空",
  "btn.downloadAll": "下载全部",
  "btn.cancel": "取消",
  "btn.download": "下载",
  "btn.remove": "移除",
  "state.queued": "排队中",
  "state.converting": "转换中…",
  "state.convertingPercent": "转换中… {percent}%",
  "state.done": "完成，用时 {seconds} 秒",
  "state.failed": "失败",
  "state.cancelled": "已取消",
  "status.starting": "正在启动 ffmpeg 引擎…",
  "status.engineFailed": "引擎加载失败：{message}",
  "status.converting": "正在转换第 {index} / {total} 个…",
  "status.allDone": "全部完成",
  "status.someFailed": "{count} 个文件转换失败",
  "status.cancelled": "已取消",
  "status.cancelling": "正在取消…",
  "status.sampleFailed": "无法加载示例文件：{message}",
  "loader.downloading": "正在下载 ffmpeg 引擎…",
  "loader.progress": "正在下载 ffmpeg 引擎… {done} / {total}",
  footer: "本应用完全在你的浏览器中运行，不会上传任何文件。",
  "error.cancelled": "已取消",
  "preset.mpeg2": "MPEG-2 视频 + MP2 音频，封装为 MPEG program stream（默认）",
  "preset.mpeg1": "MPEG-1 视频 + MP2 音频，老设备兼容性最好",
  "preset.vcd-ntsc": "Video CD，NTSC 制式（352x240，29.97fps，1150k）",
  "preset.vcd-pal": "Video CD，PAL 制式（352x288，25fps，1150k）",
  "preset.svcd-ntsc": "Super Video CD，NTSC 制式（480x480，29.97fps）",
  "preset.svcd-pal": "Super Video CD，PAL 制式（480x576，25fps）",
  "preset.dvd-ntsc": "DVD-Video，NTSC 制式（720x480，29.97fps）",
  "preset.dvd-pal": "DVD-Video，PAL 制式（720x576，25fps）",
};

const DICTIONARIES: Record<Locale, Dictionary> = { en: EN, zh: ZH };

const STORAGE_KEY = "mpgconv.locale";

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    // Private browsing can make localStorage throw; fall back to the browser.
  }
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((tag) => tag.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

let locale: Locale = detectLocale();

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  locale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not being able to remember the choice is not worth failing over.
  }
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
}

/** Look up a string, filling `{name}` placeholders. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = DICTIONARIES[locale][key] ?? EN[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/**
 * Fill every element carrying a `data-i18n` attribute.
 *
 * Keeps the markup readable and means re-rendering on a language switch is one
 * call rather than a list of assignments that can drift out of date.
 */
export function applyTranslations(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    element.textContent = t(element.dataset["i18n"]!);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    (element as HTMLInputElement).placeholder = t(element.dataset["i18nPlaceholder"]!);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    element.setAttribute("aria-label", t(element.dataset["i18nAria"]!));
  }
  // The document title is a brand name, so it stays as authored in the markup.
}
