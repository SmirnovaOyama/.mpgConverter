/**
 * Copy the ffmpeg.wasm core into `web/public/core` so the app can be developed
 * and tested without reaching for a CDN.
 *
 * Note the core wasm is ~32 MB, which exceeds Cloudflare's 25 MiB per-asset
 * limit — this copy is for local development, or as a staging step before
 * uploading the files to R2. Production defaults to the CDN.
 */

import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const target = path.join(root, "web", "public", "core");

let source;
try {
  // The package's exports map hides package.json, so resolve the entry itself.
  // `require.resolve` picks the UMD build; the worker needs ESM (see converter.ts).
  const umd = path.dirname(require.resolve("@ffmpeg/core"));
  source = path.join(path.dirname(umd), "esm");
  await fs.access(source);
} catch {
  console.error("@ffmpeg/core (ESM build) not found. Run: npm install");
  process.exit(1);
}

await fs.mkdir(target, { recursive: true });

for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  const from = path.join(source, name);
  const to = path.join(target, name);
  await fs.copyFile(from, to);
  const { size } = await fs.stat(to);
  console.log(`${name}  ${(size / 1024 / 1024).toFixed(1)} MB  ->  web/public/core/`);
}

console.log("\nRun the dev server against these with:\n  VITE_CORE_BASE=/core npm run web:dev");
