// The server render's fonts (rasterize.ts): the daemon copies plugin/assets/fonts
// to <dataDir>/fonts/ at boot, and each render loads them from there, not from
// the plugin folder (Claude Code removes an old cache folder after an update).
// The native @resvg/resvg-js 2.6.2 reads fonts from files only.
import { cpSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FONTS_DIR, installFonts, rasterizeSvg } from "../../plugin/src/server/rasterize.ts";
import { tempDir } from "../integration/daemon-helpers.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const fontNames = () => readdirSync(FONTS_DIR).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f)).sort();

const textSvg = (family: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="40"><rect width="240" height="40" fill="#fff"/>` +
  `<text x="4" y="28" font-family="${family}" font-size="20" fill="#000">inkwire 0123</text></svg>`;

describe("fonts in the data dir", () => {
  it("copies each font file of the plugin to <dataDir>/fonts/ with the same bytes", () => {
    const dataDir = tempDir("fonts");
    const files = installFonts(dataDir);
    expect(fontNames().length).toBeGreaterThan(0);
    expect(files.map((f) => path.basename(f))).toEqual(fontNames());
    for (const f of files) {
      expect(path.dirname(f)).toBe(path.join(dataDir, "fonts"));
      expect(readFileSync(f).equals(readFileSync(path.join(FONTS_DIR, path.basename(f))))).toBe(true);
    }
    expect(readdirSync(path.join(dataDir, "fonts")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes a file again only when it is missing or its content differs", () => {
    const dataDir = tempDir("fonts-again");
    const [first] = installFonts(dataDir);
    const before = statSync(first!).mtimeMs;
    installFonts(dataDir);
    expect(statSync(first!).mtimeMs).toBe(before);
    writeFileSync(first!, "broken");
    installFonts(dataDir);
    expect(readFileSync(first!).equals(readFileSync(path.join(FONTS_DIR, path.basename(first!))))).toBe(true);
  });

  it("renders with the installed fonts after the plugin's font folder is gone", () => {
    const from = path.join(tempDir("fonts-src"), "fonts");
    cpSync(FONTS_DIR, from, { recursive: true });
    const dataDir = tempDir("fonts-moved");
    const files = installFonts(dataDir, from);
    renameSync(from, `${from}-removed`);
    const png = rasterizeSvg(textSvg("IBM Plex Mono"), files);
    expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    // The installed fonts change the text pixels: the render loads them (not only system fonts).
    // Two installed families give two renders; with no font files both fall back to one default.
    const mono = rasterizeSvg(textSvg("IBM Plex Mono"), files);
    const sans = rasterizeSvg(textSvg("IBM Plex Sans"), files);
    expect(mono.equals(sans)).toBe(false);
  });

  it("gives no files when the plugin has no font folder, and the render uses system fonts", () => {
    const dataDir = tempDir("fonts-none");
    expect(installFonts(dataDir, path.join(tempDir("fonts-empty"), "fonts"))).toEqual([]);
    expect(rasterizeSvg(textSvg("sans-serif")).subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });
});
