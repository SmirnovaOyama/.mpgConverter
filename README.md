# mpgConverter

Convert any video ffmpeg can read into an MPEG program stream (`.mpg`) — in the browser, from
the command line, or from Node code.

MPEG-1/2 is a rigid format. Only a fixed set of frame rates is legal, audio must be 32/44.1/48 kHz
mono or stereo, frame dimensions must be even, and the pixel format has to be 8-bit 4:2:0. Rather
than letting the encoder reject a file, this tool inspects the source, normalises it into what the
format allows, and reports every adjustment it made.

| Goal | Use |
| --- | --- |
| Give other people a converter | The [web app](#web-app) — runs in their browser, nothing is uploaded |
| Convert files on your own machine | The [CLI](#cli) — native ffmpeg, full speed |
| Convert from Node code | The [library](#library) |

All three share one implementation of the encoding decisions, so a file converted in the browser is
treated exactly the same as one converted on the command line.

## Web app

A static single-page app that converts entirely in the visitor's browser using ffmpeg compiled to
WebAssembly. There is no server code, nothing is uploaded, and it costs nothing to run.

- Drag and drop, or pick files; anything ffmpeg can demux is accepted
- Queue with per-file progress, warnings and downloads
- Cancel a conversion mid-encode; files still queued stay queued
- English and Chinese, detected from the browser and switchable in the header
- Eight presets, plus bitrate, quantiser, frame size and frame rate overrides

```bash
npm install
npm run web:core   # optional: stage the ffmpeg core locally for development
npm run web:dev    # http://localhost:5173
```

It reuses `buildEncodeArgs` and the banner parser from `src/`, so presets, frame-rate snapping and
audio resampling behave identically to the CLI. There is no ffprobe in the WebAssembly build, so the
source is inspected by running a no-output pass and parsing ffmpeg's own log banner.

### Deploying to Cloudflare

```bash
npm run deploy
```

`wrangler.jsonc` declares an assets-only Worker. There is no server code to run, because the
conversion happens client-side. The built bundle is roughly 100 KB.

Two things are worth knowing:

- **The ffmpeg core is not deployed with the app.** `ffmpeg-core.wasm` is about 31 MB and Cloudflare
  rejects any single static asset over 25 MiB. Production loads it from a CDN, pinned to the version
  in `package.json`. The build removes the locally staged copy and warns about any oversized asset
  before it can fail a deploy.
- **To self-host the core instead**, upload `node_modules/@ffmpeg/core/dist/esm/` to R2, or any
  origin that allows cross-origin reads, and point the build at it:

  ```bash
  VITE_CORE_BASE=https://your-bucket.example.com/ffmpeg-core npm run web:build
  ```

  It must be the **ESM** build. ffmpeg.wasm always spawns its worker as a module worker, where
  `importScripts` does not exist, so the UMD build cannot be loaded.

The app uses the single-threaded core, which needs no `COOP`/`COEP` cross-origin isolation headers.
Encoding is therefore slower than native ffmpeg, and available memory caps practical input size at a
few hundred megabytes.

## CLI

```bash
npm run build
npx mpgconv holiday.mp4                       # -> holiday.mpg
npx mpgconv clip.mov -o /tmp/clip.mpg -p mpeg1
npx mpgconv ./footage -R -d ./out -j 4 -y     # recurse, four at a time, overwrite
npx mpgconv weird-file.~ --dry-run            # print the ffmpeg command, run nothing
```

Files named directly are converted whatever they are called — ffmpeg detects the real container, so
an extensionless dump or an odd suffix still works. Directories are scanned for known video
extensions only; extend that with `--ext`.

| Flag | Meaning |
| --- | --- |
| `-o, --output <path>` | Output file, or output directory when there are several inputs |
| `-d, --output-dir <dir>` | Write every output into `<dir>` |
| `-p, --preset <name>` | Encoding preset (default `mpeg2`) |
| `-b, --video-bitrate <rate>` | e.g. `4000k`, `1.5M` |
| `-a, --audio-bitrate <rate>` | e.g. `224k` |
| `-q, --qscale <1-31>` | Constant quantiser instead of a target bitrate |
| `-r, --fps <n>` | Output frame rate, snapped to a legal MPEG rate |
| `-s, --size <WxH>` | Output frame size, e.g. `720x480` |
| `-Q, --quality <tier>` | `fast`, `balanced` or `best` |
| `-j, --jobs <n>` | Convert n files at once |
| `-e, --ext <ext>` | Extra extension to pick up when scanning directories |
| `-R, --recursive` | Recurse into subdirectories |
| `-y, --overwrite` | Replace existing outputs (otherwise they are skipped) |
| `-n, --dry-run` | Print the ffmpeg command without running it |
| `--json` | Machine-readable results |
| `--quiet` | Suppress progress output |
| `--list-presets` | Show the available presets and exit |

Exit codes: `0` success, `1` at least one file failed, `2` bad usage, `3` ffmpeg missing, `130`
cancelled with Ctrl-C.

### Presets

| Preset | Output |
| --- | --- |
| `mpeg2` | MPEG-2 video + MP2 audio (default) |
| `mpeg1` | MPEG-1 video + MP2 audio; maximum compatibility with old players |
| `vcd-ntsc`, `vcd-pal` | Video CD |
| `svcd-ntsc`, `svcd-pal` | Super Video CD |
| `dvd-ntsc`, `dvd-pal` | DVD-Video |

The disc presets drive ffmpeg's `-target`, which fixes size, frame rate and bitrate. Overriding those
is allowed but warns that the result may not be spec-compliant.

## Library

```ts
import { convertToMpg, convertMany, formatNotice } from "mpg-converter";

const result = await convertToMpg({
  input: "clip.mov",
  preset: "mpeg2",
  quality: "best",
  onProgress: (p) => process.stdout.write(`\r${Math.round((p.ratio ?? 0) * 100)}%`),
});

console.log(result.output, result.bytes);
for (const warning of result.warnings) console.log(formatNotice(warning, "en"));

// Many files, four at a time; failures are collected rather than thrown.
const { results, failures } = await convertMany(["a.mp4", "b.mkv"], { jobs: 4 });
```

`convertToMpg` accepts an `AbortSignal`. `buildEncodeArgs` and `buildFfmpegArgs` are exported if you
want to build the command yourself.

Warnings are returned as `{ code, params }` rather than prose, so the same result can be rendered in
any supported language via `formatNotice(notice, locale)`.

## What it normalises

| Source | Action |
| --- | --- |
| Frame rate not in the MPEG table (15, 48, 120 fps and so on) | Snapped to the nearest legal rate, as an exact rational such as `30000/1001` |
| Audio sample rate MP2 rejects (96 kHz, 22.05 kHz) | Resampled to 32/44.1/48 kHz |
| More than two audio channels | Downmixed to stereo; mono is left alone |
| Odd frame dimensions | Cropped to even |
| 10-bit or non-4:2:0 pixel formats | Converted to `yuv420p` |
| Cover art in an audio container | Skipped in favour of the real video stream |

Every adjustment is reported on the result and shown by both front ends.

Output is written to a temporary `.part` file and renamed into place only on success, so an
interrupted run never leaves a truncated `.mpg` behind. An input that is already `.mpg` becomes
`name.converted.mpg` rather than overwriting itself.

## ffmpeg

For the CLI and library, ffmpeg is located in this order: the `ffmpegPath` option, `$FFMPEG_PATH`,
the `ffmpeg-static` package, then `$PATH`.

```bash
npm install ffmpeg-static   # bundled binary, no system install
brew install ffmpeg         # macOS
sudo apt install ffmpeg     # Debian and Ubuntu
winget install Gyan.FFmpeg  # Windows
```

`ffmpeg-static` fetches its binary from an install script, which recent npm versions hold for
approval. If the CLI reports no ffmpeg after a fresh install, run `npm approve-scripts ffmpeg-static`
and reinstall, or use a system ffmpeg.

ffprobe is used when available for exact stream metadata. It is often missing — `ffmpeg-static` ships
only ffmpeg, and `ffprobe-static` publishes an x86-64 macOS binary that cannot run on Apple Silicon —
so the converter falls back to parsing the banner from `ffmpeg -i`, which recovers duration,
dimensions, frame rate and audio layout. Nothing is lost but a little precision.

## Development

```bash
npm test              # 57 tests; most need no ffmpeg
npm run typecheck     # CLI and library
npm run typecheck:web # browser app
npm run build         # tsc -> dist/
npm run web:build     # vite -> web/dist/
```

The development scripts run the TypeScript sources directly through Node's built-in type stripping,
which needs Node 24 or newer (Node 22.6+ works with `--experimental-strip-types`). The compiled
package runs on Node 20.11+.

| Path | What it is |
| --- | --- |
| `src/presets.ts` | Presets and `buildEncodeArgs` — every encoding decision, shared by all front ends |
| `src/notices.ts` | Warning codes and their English and Chinese renderings |
| `src/banner.ts` | Pure parser for ffmpeg's stream banner; no Node imports, so it bundles for the browser |
| `src/probe.ts` | ffprobe JSON, falling back to the banner parser |
| `src/convert.ts` | Spawning ffmpeg, progress parsing, atomic output |
| `src/cli.ts` | Argument parsing and terminal output |
| `web/src/converter.ts` | The same encoding logic driven through ffmpeg.wasm |
| `web/src/main.ts` | Queue, settings and conversion UI |
| `web/src/dropdown.ts` | Custom listbox replacing the native `select` |
| `web/src/i18n.ts` | Interface strings in English and Chinese |

## License

MIT. See [LICENSE](LICENSE).
