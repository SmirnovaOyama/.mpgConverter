import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { quoteArg } from "../src/cli.ts";
import { resolveBinaries } from "../src/binaries.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI as a real child process.
 *
 * Capturing in-process would mean monkey-patching `process.stdout.write`, which
 * also swallows the test reporter's output.
 */
function run(args: string[]): Promise<Captured> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}

async function hasFfmpeg(): Promise<boolean> {
  try {
    await resolveBinaries();
    return true;
  } catch {
    return false;
  }
}

describe("cli", () => {
  it("prints help", async () => {
    const { code, stdout } = await run(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage/);
    assert.match(stdout, /--preset/);
  });

  it("prints a version", async () => {
    const { code, stdout } = await run(["--version"]);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it("lists presets", async () => {
    const { code, stdout } = await run(["--list-presets"]);
    assert.equal(code, 0);
    assert.match(stdout, /mpeg2/);
    assert.match(stdout, /dvd-pal/);
  });

  it("requires at least one input", async () => {
    const { code, stderr } = await run([]);
    assert.equal(code, 2);
    assert.match(stderr, /No input files/);
  });

  it("rejects unknown options", async () => {
    const { code } = await run(["--nope", "x.mp4"]);
    assert.equal(code, 2);
  });

  it("rejects an unknown preset", async () => {
    const { code, stderr } = await run(["x.mp4", "--preset", "betamax"]);
    assert.equal(code, 2);
    assert.match(stderr, /Unknown preset/);
  });

  it("rejects conflicting destinations", async () => {
    const { code, stderr } = await run(["x.mp4", "-o", "a.mpg", "-d", "out"]);
    assert.equal(code, 2);
    assert.match(stderr, /not both/);
  });

  it("reports a missing input", async () => {
    const { code, stderr } = await run([path.join(os.tmpdir(), "definitely-missing-441.mp4")]);
    assert.equal(code, 2);
    assert.match(stderr, /No such file or directory/);
  });

  it("quotes shell arguments safely", () => {
    assert.equal(quoteArg("simple.mp4"), "simple.mp4");
    assert.equal(quoteArg("with space.mp4"), "'with space.mp4'");
    assert.equal(quoteArg("scale=trunc(iw/2)*2"), "'scale=trunc(iw/2)*2'");
  });
});

describe("cli --dry-run", { skip: (await hasFfmpeg()) ? false : "ffmpeg not installed" }, () => {
  let dir = "";

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpgconv-cli-"));
    await fs.writeFile(path.join(dir, "clip.mov"), "");
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("prints a runnable command without writing anything", async () => {
    const { code, stdout } = await run([path.join(dir, "clip.mov"), "--dry-run"]);
    assert.equal(code, 0);
    assert.match(stdout, /-c:v mpeg2video/);
    assert.match(stdout, /-f mpeg/);
    assert.match(stdout, /clip\.mpg/);
    // The temporary encode target must never leak into the printed command.
    assert.equal(stdout.includes(".part"), false);
    await assert.rejects(() => fs.stat(path.join(dir, "clip.mpg")));
  });

  it("honours the preset flag", async () => {
    const { stdout } = await run([path.join(dir, "clip.mov"), "--dry-run", "-p", "vcd-pal"]);
    assert.match(stdout, /-target pal-vcd/);
  });
});
