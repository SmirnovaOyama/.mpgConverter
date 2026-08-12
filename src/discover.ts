/** Turning CLI arguments into a concrete list of input and output paths. */

import fs from "node:fs/promises";
import path from "node:path";
import { ConversionError } from "./errors.ts";

/**
 * Extensions picked up when scanning a directory. Files named explicitly on the
 * command line are always accepted, whatever they are called — ffmpeg sniffs the
 * container itself, so an extensionless dump or an odd suffix still converts.
 */
export const VIDEO_EXTENSIONS: readonly string[] = [
  ".3gp", ".asf", ".avi", ".dv", ".f4v", ".flv", ".m2ts", ".m2v", ".m4v",
  ".mkv", ".mov", ".mp4", ".mpe", ".mpeg", ".mpg", ".mts", ".mxf", ".ogv",
  ".rm", ".rmvb", ".ts", ".vob", ".webm", ".wmv", ".y4m",
];

/** Normalise `mp4` / `.MP4` into `.mp4`. */
export function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/**
 * Swap an input's extension for `.mpg`.
 *
 * A source that is already `.mpg` becomes `name.converted.mpg` so the conversion
 * never targets its own input.
 */
export function defaultOutputPath(input: string): string {
  const dir = path.dirname(input);
  const ext = path.extname(input);
  const stem = ext ? path.basename(input, ext) : path.basename(input);
  const suffix = ext.toLowerCase() === ".mpg" ? ".converted.mpg" : ".mpg";
  return path.join(dir, `${stem}${suffix}`);
}

/**
 * Decide where one conversion should write.
 *
 * `--output` names a file for a single input and a directory for several, which
 * the caller signals with `outputIsDirectory`.
 */
export function resolveOutputPath(params: {
  input: string;
  output?: string;
  outputIsDirectory?: boolean;
}): string {
  const { input, output, outputIsDirectory } = params;
  if (!output) return defaultOutputPath(input);
  if (outputIsDirectory) {
    return path.join(output, path.basename(defaultOutputPath(input)));
  }
  return output;
}

/** True for `.part` scratch files and dotfiles, which directory scans skip. */
function isIgnorable(name: string): boolean {
  return name.startsWith(".") || name.endsWith(".part");
}

async function collectDirectory(
  dir: string,
  extensions: Set<string>,
  recursive: boolean,
  found: string[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (isIgnorable(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await collectDirectory(full, extensions, recursive, found);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
}

/**
 * Expand files and directories into a sorted, de-duplicated list of inputs.
 *
 * @throws ConversionError with code `INPUT_NOT_FOUND` for a path that does not exist.
 */
export async function expandInputs(
  inputs: string[],
  options: { recursive?: boolean; extensions?: string[] } = {},
): Promise<string[]> {
  const extensions = new Set(
    (options.extensions ?? []).map(normalizeExtension).filter(Boolean).concat(VIDEO_EXTENSIONS),
  );
  const found: string[] = [];

  for (const raw of inputs) {
    const resolved = path.resolve(raw);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      throw new ConversionError("INPUT_NOT_FOUND", `No such file or directory: ${raw}`);
    }

    if (stat.isDirectory()) {
      await collectDirectory(resolved, extensions, options.recursive ?? false, found);
    } else if (stat.isFile()) {
      found.push(resolved);
    } else {
      throw new ConversionError("NOT_A_FILE", `Not a regular file: ${raw}`);
    }
  }

  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}
