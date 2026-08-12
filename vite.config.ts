import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/** Cloudflare rejects any single static asset larger than this. */
const CLOUDFLARE_ASSET_LIMIT = 25 * 1024 * 1024;

/**
 * `web/public/core` holds the ~32 MB ffmpeg core staged by `npm run web:core`
 * for local development. It must not reach the deployed bundle: it is three
 * times Cloudflare's per-asset limit, so uploading it fails the whole deploy.
 * Production loads the core from the CDN (or from R2, via VITE_CORE_BASE).
 */
function excludeDevCore(): Plugin {
  return {
    name: "exclude-dev-core",
    apply: "build",
    closeBundle() {
      const staged = path.resolve(import.meta.dirname, "web/dist/core");
      if (fs.existsSync(staged)) {
        fs.rmSync(staged, { recursive: true, force: true });
        this.info("removed web/dist/core (dev-only ffmpeg core, served from the CDN in production)");
      }
    },
  };
}

/** Fail loudly at build time rather than mid-deploy. */
function checkAssetSizes(): Plugin {
  return {
    name: "check-asset-sizes",
    apply: "build",
    closeBundle() {
      const root = path.resolve(import.meta.dirname, "web/dist");
      if (!fs.existsSync(root)) return;

      const oversized: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (fs.statSync(full).size > CLOUDFLARE_ASSET_LIMIT) {
            oversized.push(`${path.relative(root, full)} (${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MB)`);
          }
        }
      };
      walk(root);

      if (oversized.length > 0) {
        this.warn(
          `These assets exceed Cloudflare's 25 MiB per-file limit and will fail to deploy:\n  ${oversized.join("\n  ")}`,
        );
      }
    },
  };
}

export default defineConfig({
  root: "web",
  plugins: [excludeDevCore(), checkAssetSizes()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  optimizeDeps: {
    // ffmpeg.wasm resolves its worker through `import.meta.url`, which Vite's
    // dependency pre-bundling rewrites into something that no longer resolves.
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
  server: {
    port: 5173,
  },
});
