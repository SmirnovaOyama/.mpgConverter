/** UI wiring for the browser converter. */

import { PRESET_NAMES } from "../../src/presets.ts";
import { formatNotice, notice, type Notice } from "../../src/notices.ts";
import type { EncodeOptions, PresetName, QualityTier } from "../../src/types.ts";
import { createDropdown, type Dropdown } from "./dropdown.ts";
import { applyTranslations, getLocale, setLocale, t } from "./i18n.ts";
import {
  cancelConversion,
  CancelledError,
  convertFile,
  downloadName,
  isLoaded,
  LARGE_FILE_BYTES,
  loadFfmpeg,
  type WebConvertResult,
} from "./converter.ts";

type ItemState = "queued" | "converting" | "done" | "failed" | "cancelled";

interface QueueItem {
  id: number;
  file: File;
  state: ItemState;
  ratio: number | null;
  result: WebConvertResult | null;
  error: string | null;
  /** Object URL for the finished file; revoked when the item goes away. */
  url: string | null;
  element: HTMLLIElement;
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const dropzone = $<HTMLElement>("#drop");
const fileInput = $<HTMLInputElement>("#file-input");
const queueList = $<HTMLUListElement>("#queue");
const convertButton = $<HTMLButtonElement>("#convert");
const cancelButton = $<HTMLButtonElement>("#cancel");
const clearButton = $<HTMLButtonElement>("#clear");
const downloadAllButton = $<HTMLButtonElement>("#download-all");
const statusText = $<HTMLElement>("#status");
const presetHost = $<HTMLElement>("#preset");
const presetHint = $<HTMLElement>("#preset-hint");
const qualityHost = $<HTMLElement>("#quality");
const videoBitrate = $<HTMLInputElement>("#video-bitrate");
const audioBitrate = $<HTMLInputElement>("#audio-bitrate");
const sizeInput = $<HTMLInputElement>("#size");
const fpsInput = $<HTMLInputElement>("#fps");
const sampleButton = $<HTMLButtonElement>("#sample");
const settingsPanel = $<HTMLElement>("#settings");
const settingsToggle = $<HTMLButtonElement>("#settings-toggle");
const languageButton = $<HTMLButtonElement>("#language");
const actionsBar = $<HTMLElement>("#actions");
const loader = $<HTMLElement>("#loader");
const loaderFill = $<HTMLElement>("#loader-fill");
const loaderText = $<HTMLElement>("#loader-text");
const template = $<HTMLTemplateElement>("#item-template");

const items: QueueItem[] = [];
let nextId = 1;
let running = false;
let cancelRequested = false;

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// --- Settings ---

let presetDropdown: Dropdown;
let qualityDropdown: Dropdown;

/**
 * Build both dropdowns. Called again after a language switch, because the
 * option labels are translated and the component renders them once.
 */
function buildDropdowns(preset = "mpeg2", quality = "balanced"): void {
  presetHost.replaceChildren();
  qualityHost.replaceChildren();

  presetDropdown = createDropdown(
    presetHost,
    // Preset names are technical identifiers, so they read the same either way.
    PRESET_NAMES.map((name) => ({ value: name, label: name })),
    preset,
    "preset-label",
  );
  qualityDropdown = createDropdown(
    qualityHost,
    [
      { value: "fast", label: t("quality.fast") },
      { value: "balanced", label: t("quality.balanced") },
      { value: "best", label: t("quality.best") },
    ],
    quality,
    "quality-label",
  );

  presetDropdown.onChange(syncPresetHint);
  syncPresetHint();
}

function syncPresetHint(): void {
  presetHint.textContent = t(`preset.${presetDropdown.value}`);
}

// Settings stay out of the way until asked for.
settingsToggle.addEventListener("click", () => {
  const open = settingsToggle.getAttribute("aria-expanded") === "true";
  settingsToggle.setAttribute("aria-expanded", String(!open));
  settingsPanel.hidden = open;
});

languageButton.addEventListener("click", () => {
  setLocale(getLocale() === "zh" ? "en" : "zh");
  applyTranslations();
  // Rebuild anything whose text was generated rather than declared in markup.
  buildDropdowns(presetDropdown.value, qualityDropdown.value);
  for (const item of items) render(item);
  syncControls();
});

/** Read the form into the options shared with the CLI. */
function readOptions(): EncodeOptions {
  const options: EncodeOptions = {
    preset: presetDropdown.value as PresetName,
    quality: qualityDropdown.value as QualityTier,
  };

  if (videoBitrate.value.trim()) options.videoBitrate = videoBitrate.value.trim();
  if (audioBitrate.value.trim()) options.audioBitrate = audioBitrate.value.trim();

  const size = /^(\d+)\s*[xX]\s*(\d+)$/.exec(sizeInput.value.trim());
  if (size) options.size = [Number(size[1]), Number(size[2])];

  const fps = Number(fpsInput.value.trim());
  if (fpsInput.value.trim() && Number.isFinite(fps) && fps > 0) options.fps = fps;

  return options;
}

// --- Queue rendering ---

function stateLabel(item: QueueItem): string {
  switch (item.state) {
    case "queued":
      return t("state.queued");
    case "converting":
      return item.ratio === null
        ? t("state.converting")
        : t("state.convertingPercent", { percent: Math.round(item.ratio * 100) });
    case "done":
      return t("state.done", { seconds: ((item.result?.elapsedMs ?? 0) / 1000).toFixed(1) });
    case "cancelled":
      return t("state.cancelled");
    case "failed":
      return t("state.failed");
  }
}

function render(item: QueueItem): void {
  const element = item.element;
  element.className = `item ${item.state}`;
  if (item.state === "converting" && item.ratio === null) element.classList.add("indeterminate");

  const fill = element.querySelector<HTMLElement>(".fill")!;
  fill.style.width = `${Math.round((item.ratio ?? 0) * 100)}%`;

  element.querySelector<HTMLElement>(".state")!.textContent = stateLabel(item);

  // Numbered by queue position. Kept in a separate element so selecting the
  // filename does not pick up the number.
  const index = document.createElement("span");
  index.className = "item-index";
  index.textContent = `${items.indexOf(item) + 1}.`;
  element
    .querySelector<HTMLElement>(".item-name")!
    .replaceChildren(index, document.createTextNode(item.file.name));

  element.querySelector<HTMLElement>(".item-meta")!.textContent =
    item.state === "done"
      ? `${formatBytes(item.file.size)} → ${formatBytes(item.result?.bytes ?? 0)}`
      : formatBytes(item.file.size);

  const download = element.querySelector<HTMLAnchorElement>(".download")!;
  if (item.state === "done" && item.url) {
    download.hidden = false;
    download.href = item.url;
    download.download = item.result?.name ?? downloadName(item.file.name);
    download.textContent = t("btn.download");
  } else {
    download.hidden = true;
  }

  // Notices arrive as codes from the shared encoding logic, translated here.
  const notes: Notice[] = [...(item.result?.warnings ?? [])];
  if (item.state === "queued" && item.file.size > LARGE_FILE_BYTES) {
    notes.push(notice("large-file", { size: formatBytes(item.file.size) }));
  }

  const list = element.querySelector<HTMLUListElement>(".notes")!;
  list.replaceChildren();
  if (item.error) {
    const li = document.createElement("li");
    li.className = "error";
    li.textContent = item.error;
    list.append(li);
  }
  for (const note of notes) {
    const li = document.createElement("li");
    li.textContent = formatNotice(note, getLocale());
    list.append(li);
  }
}

function removeItem(item: QueueItem): void {
  if (item.url) URL.revokeObjectURL(item.url);
  item.element.remove();
  items.splice(items.indexOf(item), 1);
  // The rows below have all shifted up a place.
  for (const remaining of items) render(remaining);
  syncControls();
}

function addFiles(files: FileList | File[]): void {
  for (const file of Array.from(files)) {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const element = fragment.querySelector<HTMLLIElement>(".item")!;

    const item: QueueItem = {
      id: nextId++,
      file,
      state: "queued",
      ratio: null,
      result: null,
      error: null,
      url: null,
      element,
    };

    element.querySelector<HTMLButtonElement>(".remove")!.addEventListener("click", () => {
      if (item.state !== "converting") removeItem(item);
    });

    items.push(item);
    queueList.append(element);
    render(item);
  }
  setStatus(null);
}

/**
 * An explicit message that outranks the default empty status.
 *
 * Without this, any `syncControls()` after `setStatus()` silently wipes the
 * message — which is exactly when something has gone wrong and the user most
 * needs to see it.
 *
 * Held as a key rather than rendered text, so switching language re-translates
 * whatever is currently on screen.
 */
let pinnedStatus: { key: string; params: Record<string, string | number> } | null = null;

function setStatus(key: string | null, params: Record<string, string | number> = {}): void {
  pinnedStatus = key === null ? null : { key, params };
  syncControls();
}

function syncControls(): void {
  const pending = items.filter((item) => item.state === "queued").length;
  const finished = items.filter((item) => item.state === "done" && item.url).length;
  // Nothing to act on until a file is dropped, so the whole bar stays hidden.
  actionsBar.hidden = items.length === 0;
  convertButton.disabled = running || pending === 0;
  convertButton.textContent = pending > 1 ? t("btn.convertMany", { n: pending }) : t("btn.convert");
  cancelButton.hidden = !running;
  cancelButton.textContent = t("btn.cancel");
  // One finished file already has its own download link on the row.
  downloadAllButton.hidden = running || finished < 2;
  downloadAllButton.textContent = t("btn.downloadAll");
  clearButton.hidden = running;
  clearButton.textContent = t("btn.clear");
  statusText.textContent = pinnedStatus ? t(pinnedStatus.key, pinnedStatus.params) : "";
}

// --- Input ---

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) addFiles(fileInput.files);
  fileInput.value = "";
});

for (const type of ["dragenter", "dragover"]) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  });
}
dropzone.addEventListener("drop", (event) => {
  const dropped = (event as DragEvent).dataTransfer?.files;
  if (dropped?.length) addFiles(dropped);
});

// The whole page swallows stray drops so the browser does not navigate away.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

clearButton.addEventListener("click", () => {
  for (const item of [...items]) removeItem(item);
});

downloadAllButton.addEventListener("click", async () => {
  downloadAllButton.disabled = true;
  try {
    for (const item of items) {
      if (item.state !== "done" || !item.url) continue;
      const link = document.createElement("a");
      link.href = item.url;
      link.download = item.result?.name ?? downloadName(item.file.name);
      document.body.append(link);
      link.click();
      link.remove();
      // Browsers throttle downloads fired back to back.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } finally {
    downloadAllButton.disabled = false;
  }
});

sampleButton.addEventListener("click", async () => {
  sampleButton.disabled = true;
  try {
    const response = await fetch("sample.mp4");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    addFiles([new File([blob], "sample.mp4", { type: "video/mp4" })]);
  } catch (error) {
    setStatus("status.sampleFailed", { message: (error as Error).message });
  } finally {
    sampleButton.disabled = false;
  }
});

// --- Conversion ---

async function ensureEngine(): Promise<void> {
  if (isLoaded()) return;

  loader.hidden = false;
  const totals = new Map<string, { received: number; total: number }>();
  try {
    await loadFfmpeg(({ received, total, file }) => {
      totals.set(file, { received, total });
      let done = 0;
      let expected = 0;
      for (const entry of totals.values()) {
        done += entry.received;
        expected += entry.total;
      }
      if (expected > 0) {
        loaderFill.style.width = `${Math.round((done / expected) * 100)}%`;
        loaderText.textContent = t("loader.progress", {
          done: formatBytes(done),
          total: formatBytes(expected),
        });
      }
    });
  } finally {
    loader.hidden = true;
    loaderText.textContent = t("loader.downloading");
  }
}

cancelButton.addEventListener("click", () => {
  if (!running || cancelRequested) return;
  cancelRequested = true;
  setStatus("status.cancelling");
  cancelConversion();
});

convertButton.addEventListener("click", async () => {
  if (running) return;
  running = true;
  cancelRequested = false;
  setStatus(null);

  try {
    setStatus("status.starting");
    await ensureEngine();
  } catch (error) {
    running = false;
    setStatus("status.engineFailed", { message: (error as Error).message });
    return;
  }

  const options = readOptions();
  const pending = items.filter((item) => item.state === "queued");

  // One shared wasm instance means strictly one file at a time.
  for (const [index, item] of pending.entries()) {
    if (cancelRequested) break;

    item.state = "converting";
    item.ratio = null;
    item.error = null;
    render(item);
    setStatus("status.converting", { index: index + 1, total: pending.length });

    try {
      const result = await convertFile(item.file, {
        ...options,
        onProgress: ({ ratio }) => {
          item.ratio = ratio;
          render(item);
        },
      });
      item.result = result;
      item.url = URL.createObjectURL(result.blob);
      item.ratio = 1;
      item.state = "done";
    } catch (error) {
      if (error instanceof CancelledError || cancelRequested) {
        // Anything still queued stays queued, ready to run again.
        item.state = "cancelled";
        item.ratio = null;
      } else {
        item.error = (error as Error).message;
        item.state = "failed";
      }
    }
    render(item);
  }

  const failed = items.filter((item) => item.state === "failed").length;
  running = false;

  if (cancelRequested) setStatus("status.cancelled");
  else if (failed > 0) setStatus("status.someFailed", { count: failed });
  else setStatus("status.allDone");

  cancelRequested = false;
});

// --- Boot ---

setLocale(getLocale());
applyTranslations();
buildDropdowns();
syncControls();
