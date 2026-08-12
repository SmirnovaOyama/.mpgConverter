/** Error types raised by the converter. */

export type ErrorCode =
  | "FFMPEG_NOT_FOUND"
  | "INPUT_NOT_FOUND"
  | "NOT_A_FILE"
  | "NO_VIDEO_STREAM"
  | "OUTPUT_COLLISION"
  | "FFMPEG_FAILED"
  | "ABORTED"
  | "BAD_OPTION";

/** An error with a stable machine-readable `code`. */
export class ConversionError extends Error {
  readonly code: ErrorCode;
  /** ffmpeg's stderr tail, when the failure came from ffmpeg. */
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "ConversionError";
    this.code = code;
    this.detail = detail;
  }
}

/** ffmpeg could not be located; carries platform-specific install hints. */
export function ffmpegNotFound(): ConversionError {
  const hints = [
    "mpgconv needs ffmpeg. Install it one of these ways:",
    "",
    "  npm install ffmpeg-static ffprobe-static   # bundled binaries, no system install",
    "  brew install ffmpeg                        # macOS",
    "  sudo apt install ffmpeg                    # Debian/Ubuntu",
    "  winget install Gyan.FFmpeg                 # Windows",
    "",
    "Already have it somewhere unusual? Point at it directly:",
    "  FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe mpgconv ...",
  ].join("\n");
  return new ConversionError("FFMPEG_NOT_FOUND", "ffmpeg executable not found", hints);
}
