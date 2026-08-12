# mpgConverter

**English** | [中文](#中文)

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
npm run dev        # http://localhost:5173
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
npm run dev           # web app on http://localhost:5173
npm run cli -- --help # run the CLI from source
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

---

# 中文

[English](#mpgconverter) | **中文**

把任何 ffmpeg 能读取的视频转换成 MPEG program stream（`.mpg`）—— 可以在浏览器里用，也可以用命令行，
或者从 Node 代码调用。

MPEG-1/2 是一种约束很严的格式：帧率只能取固定的几个值，音频必须是 32/44.1/48 kHz 的单声道或立体声，
画面宽高必须是偶数，像素格式必须是 8-bit 4:2:0。与其让编码器直接拒绝文件，这个工具会先分析源文件，
把它规范化成格式允许的样子，并把每一处调整都告诉你。

| 目的 | 使用方式 |
| --- | --- |
| 让别人也能用的转换器 | [网页应用](#网页应用) —— 在对方浏览器里运行，不上传任何文件 |
| 在自己电脑上转换文件 | [命令行](#命令行) —— 原生 ffmpeg，速度最快 |
| 从 Node 代码调用 | [库](#库) |

三者共用同一套编码决策实现，所以浏览器里转换出来的文件，和命令行转换出来的完全一致。

## 网页应用

一个纯静态的单页应用，使用编译成 WebAssembly 的 ffmpeg，完全在访问者的浏览器里完成转换。
没有服务端代码，不上传任何文件，运行起来也不产生费用。

- 拖放或点选文件，ffmpeg 能解封装的格式都可以
- 队列显示每个文件的进度、提示信息和下载入口
- 转换过程中可以取消，队列中尚未开始的文件保持排队
- 中英双语，自动跟随浏览器语言，也可以在页面右上角切换
- 八种预设，另有码率、量化参数、画面尺寸、帧率可覆盖

```bash
npm install
npm run web:core   # 可选：把 ffmpeg 核心放到本地供开发使用
npm run dev        # http://localhost:5173
```

它复用了 `src/` 里的 `buildEncodeArgs` 和 banner 解析器，因此预设、帧率对齐、音频重采样的行为
与命令行完全一致。WebAssembly 版本里没有 ffprobe，所以源文件信息是通过跑一次无输出的解析、
再解析 ffmpeg 自己的日志 banner 得到的。

### 部署到 Cloudflare

```bash
npm run deploy
```

`wrangler.jsonc` 声明的是一个纯静态资源 Worker。因为转换发生在客户端，所以没有服务端代码需要运行。
构建产物大约 100 KB。

有两点需要知道：

- **ffmpeg 核心不会随应用一起部署。** `ffmpeg-core.wasm` 约 31 MB，而 Cloudflare 拒绝任何超过
  25 MiB 的单个静态资源。生产环境从 CDN 加载它，版本与 `package.json` 中锁定的一致。构建时会
  自动移除本地暂存的副本，并在有超限资源时提前告警，避免部署到一半才失败。
- **如果想自己托管核心文件**，把 `node_modules/@ffmpeg/core/dist/esm/` 上传到 R2，或任何允许
  跨域读取的源站，然后在构建时指向它：

  ```bash
  VITE_CORE_BASE=https://your-bucket.example.com/ffmpeg-core npm run web:build
  ```

  必须使用 **ESM** 构建。ffmpeg.wasm 总是以 module worker 的方式启动它的 worker，那里没有
  `importScripts`，所以 UMD 构建无法加载。

应用使用单线程核心，因此不需要 `COOP`/`COEP` 跨域隔离响应头。代价是编码速度慢于原生 ffmpeg，
且受可用内存限制，实际能处理的文件大小上限在几百 MB 左右。

## 命令行

```bash
npm run build
npx mpgconv holiday.mp4                       # -> holiday.mpg
npx mpgconv clip.mov -o /tmp/clip.mpg -p mpeg1
npx mpgconv ./footage -R -d ./out -j 4 -y     # 递归、四个并发、覆盖已有文件
npx mpgconv weird-file.~ --dry-run            # 只打印 ffmpeg 命令，不实际执行
```

直接指定的文件不论叫什么名字都会被转换 —— ffmpeg 会自行识别真实容器格式，所以没有扩展名的文件
或者奇怪的后缀都能处理。目录则只扫描已知的视频扩展名，可以用 `--ext` 扩充。

| 参数 | 含义 |
| --- | --- |
| `-o, --output <path>` | 输出文件；有多个输入时表示输出目录 |
| `-d, --output-dir <dir>` | 所有输出写入 `<dir>` |
| `-p, --preset <name>` | 编码预设（默认 `mpeg2`） |
| `-b, --video-bitrate <rate>` | 例如 `4000k`、`1.5M` |
| `-a, --audio-bitrate <rate>` | 例如 `224k` |
| `-q, --qscale <1-31>` | 使用恒定量化参数，替代目标码率 |
| `-r, --fps <n>` | 输出帧率，会对齐到合法的 MPEG 帧率 |
| `-s, --size <WxH>` | 输出画面尺寸，例如 `720x480` |
| `-Q, --quality <tier>` | `fast`、`balanced` 或 `best` |
| `-j, --jobs <n>` | 同时转换 n 个文件 |
| `-e, --ext <ext>` | 扫描目录时额外识别的扩展名 |
| `-R, --recursive` | 递归子目录 |
| `-y, --overwrite` | 覆盖已存在的输出（否则跳过） |
| `-n, --dry-run` | 只打印 ffmpeg 命令，不执行 |
| `--json` | 输出机器可读的结果 |
| `--quiet` | 不显示进度 |
| `--list-presets` | 列出所有预设并退出 |

退出码：`0` 成功，`1` 至少一个文件失败，`2` 参数有误，`3` 找不到 ffmpeg，`130` 被 Ctrl-C 取消。

### 预设

| 预设 | 输出 |
| --- | --- |
| `mpeg2` | MPEG-2 视频 + MP2 音频（默认） |
| `mpeg1` | MPEG-1 视频 + MP2 音频，老设备兼容性最好 |
| `vcd-ntsc`、`vcd-pal` | Video CD |
| `svcd-ntsc`、`svcd-pal` | Super Video CD |
| `dvd-ntsc`、`dvd-pal` | DVD-Video |

光盘类预设走的是 ffmpeg 的 `-target`，它会固定画面尺寸、帧率和码率。你仍然可以覆盖这些值，
但工具会提示结果可能不符合规范。

## 库

```ts
import { convertToMpg, convertMany, formatNotice } from "mpg-converter";

const result = await convertToMpg({
  input: "clip.mov",
  preset: "mpeg2",
  quality: "best",
  onProgress: (p) => process.stdout.write(`\r${Math.round((p.ratio ?? 0) * 100)}%`),
});

console.log(result.output, result.bytes);
for (const warning of result.warnings) console.log(formatNotice(warning, "zh"));

// 多个文件、四个并发；失败会被收集起来而不是抛出。
const { results, failures } = await convertMany(["a.mp4", "b.mkv"], { jobs: 4 });
```

`convertToMpg` 支持传入 `AbortSignal`。如果你想自己拼命令，`buildEncodeArgs` 和 `buildFfmpegArgs`
也都有导出。

提示信息返回的是 `{ code, params }` 结构而不是成句的文字，因此同一个结果可以通过
`formatNotice(notice, locale)` 渲染成任意受支持的语言。

## 自动规范化的内容

| 源文件情况 | 处理方式 |
| --- | --- |
| 帧率不在 MPEG 允许的取值内（15、48、120 fps 等） | 对齐到最接近的合法帧率，并写成 `30000/1001` 这样的精确分数 |
| MP2 不支持的音频采样率（96 kHz、22.05 kHz 等） | 重采样到 32/44.1/48 kHz |
| 音频超过两个声道 | 缩混为立体声；单声道保持不变 |
| 画面宽高为奇数 | 裁剪为偶数 |
| 10-bit 或非 4:2:0 的像素格式 | 转换为 `yuv420p` |
| 音频容器里的封面图 | 跳过，改用真正的视频流 |

每一处调整都会记录在结果里，并在两个前端中显示出来。

输出会先写入临时的 `.part` 文件，只有成功后才重命名到位，因此中断的任务不会留下损坏的 `.mpg`。
如果输入本身就是 `.mpg`，输出会变成 `name.converted.mpg`，不会覆盖自己。

## ffmpeg

命令行和库按以下顺序查找 ffmpeg：`ffmpegPath` 选项、`$FFMPEG_PATH`、`ffmpeg-static` 包，最后是 `$PATH`。

```bash
npm install ffmpeg-static   # 自带二进制，无需安装到系统
brew install ffmpeg         # macOS
sudo apt install ffmpeg     # Debian 和 Ubuntu
winget install Gyan.FFmpeg  # Windows
```

`ffmpeg-static` 通过安装脚本下载二进制文件，而较新版本的 npm 会拦下这类脚本等待确认。
如果全新安装后命令行提示找不到 ffmpeg，执行 `npm approve-scripts ffmpeg-static` 后重新安装，
或者直接使用系统的 ffmpeg。

有 ffprobe 时会用它获取精确的流信息。但它经常缺失 —— `ffmpeg-static` 只带 ffmpeg，而
`ffprobe-static` 在 macOS 上发布的是 x86-64 二进制，在 Apple Silicon 上跑不起来 ——
这种情况下转换器会退回解析 `ffmpeg -i` 的输出 banner，同样能得到时长、尺寸、帧率和声道信息，
只是精度略低一些。

## 开发

```bash
npm run dev           # 网页应用，http://localhost:5173
npm run cli -- --help # 从源码运行命令行工具
npm test              # 57 个测试，大部分不需要 ffmpeg
npm run typecheck     # 命令行与库
npm run typecheck:web # 网页应用
npm run build         # tsc -> dist/
npm run web:build     # vite -> web/dist/
```

开发脚本依赖 Node 内置的类型擦除直接运行 TypeScript 源码，这需要 Node 24 或更高版本
（Node 22.6+ 加上 `--experimental-strip-types` 也可以）。编译后的包在 Node 20.11+ 上即可运行。

| 路径 | 说明 |
| --- | --- |
| `src/presets.ts` | 预设和 `buildEncodeArgs` —— 所有编码决策，被全部前端共用 |
| `src/notices.ts` | 提示信息的代码及其中英文文案 |
| `src/banner.ts` | ffmpeg 流信息 banner 的纯解析器，不引入任何 Node 模块，因此可以打包进浏览器 |
| `src/probe.ts` | ffprobe 的 JSON 输出，失败时回退到 banner 解析器 |
| `src/convert.ts` | 启动 ffmpeg 进程、解析进度、原子化写入输出 |
| `src/cli.ts` | 参数解析与终端输出 |
| `web/src/converter.ts` | 同一套编码逻辑，通过 ffmpeg.wasm 驱动 |
| `web/src/main.ts` | 队列、设置与转换界面 |
| `web/src/dropdown.ts` | 替代原生 `select` 的自定义下拉框 |
| `web/src/i18n.ts` | 界面文案的中英文词条 |

## 许可证

MIT，详见 [LICENSE](LICENSE)。
