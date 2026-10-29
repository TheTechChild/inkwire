// SVG → PNG via resvg (SPEC § 6: no headless Chromium). Fonts: the files of
// plugin/assets/fonts/ go to <dataDir>/fonts/ one time, at boot
// (installFonts), and each render loads them from there; system fonts fill the
// gaps. Claude Code installs each update into a new cache folder and removes
// the old folder later, so a render must not read the plugin folder. The
// native @resvg/resvg-js 2.6.2 reads fonts from files only (fontBuffers is in
// its WASM build only), so the copy is in the data dir, not in memory. The
// parity test is structural, so exact font metrics are not load-bearing.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

/** plugin/assets/fonts/ of this copy. */
export const FONTS_DIR = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));

const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

/**
 * Copy the font files of `from` to <dataDir>/fonts/ and give their paths there.
 * A file is written only when it is missing or its content differs, through a
 * rename, so a render of another daemon never reads half a file. Never throws:
 * on an error the render uses the fonts that are already there, else system fonts.
 */
export function installFonts(dataDir: string, from: string = FONTS_DIR): string[] {
  const dir = path.join(dataDir, "fonts");
  const out: string[] = [];
  try {
    const names = existsSync(from) ? readdirSync(from).filter((f) => FONT_FILE.test(f)).sort() : [];
    if (names.length > 0) mkdirSync(dir, { recursive: true });
    for (const name of names) {
      const target = path.join(dir, name);
      try {
        const content = readFileSync(path.join(from, name));
        if (!existsSync(target) || !readFileSync(target).equals(content)) {
          const tmp = `${target}.${process.pid}.tmp`;
          writeFileSync(tmp, content);
          renameSync(tmp, target);
        }
        out.push(target);
      } catch (err) {
        console.error(`inkwire: font ${name} not installed: ${err instanceof Error ? err.message : String(err)}`);
        if (existsSync(target)) out.push(target);
      }
    }
  } catch (err) {
    console.error(`inkwire: fonts not installed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/** Render an SVG to PNG with these font files (from installFonts) and the system fonts. */
export function rasterizeSvg(svg: string, fontFiles: string[] = []): Buffer {
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: true,
      fontFiles: fontFiles.filter((f) => existsSync(f)),
      defaultFontFamily: "sans-serif",
    },
  });
  return Buffer.from(resvg.render().asPng());
}

const CHILD = fileURLToPath(new URL("./rasterize-child.ts", import.meta.url));
export const RASTERIZE_TIMEOUT_MS = 30_000;

/**
 * rasterizeSvg in a child process. A Rust panic in resvg aborts the whole
 * process and no try/catch can stop it, so the daemon never runs resvg itself.
 * Rejects when the child fails, with the last line of its stderr.
 */
export function rasterizeIsolated(svg: string, fontFiles: string[] = [], timeoutMs = RASTERIZE_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.stdin.on("error", () => {}); // the child died before it read the input; "close" reports it
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`server render failed to start: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(Buffer.concat(out));
      const why = signal === "SIGKILL" ? `timed out after ${timeoutMs} ms` : (code ?? signal);
      const detail = err.trim().split("\n").find((l) => l.includes("panicked")) ?? err.trim().split("\n").pop() ?? "";
      if (err) console.error(`inkwire: server render failed (${why}):\n${err.trim()}`);
      reject(new Error(`server render failed (${why})${detail ? `: ${detail}` : ""}`));
    });
    child.stdin.end(JSON.stringify({ svg, fontFiles }));
  });
}
