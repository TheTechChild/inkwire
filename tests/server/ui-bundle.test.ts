// The panel comes from memory (ui-bundle.ts): the daemon bundles plugin/src/ui
// at boot, and after that it does not read the plugin folder. Claude Code
// installs each update into a new cache folder and removes the old one later.
import { appendFileSync, cpSync, renameSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startDaemon } from "../../plugin/src/server/daemon.ts";
import { createUiBundle } from "../../plugin/src/server/ui-bundle.ts";
import { root, tempDir, waitFor } from "../integration/daemon-helpers.ts";

/** A copy of plugin/src (the panel imports core and shared) with node_modules beside it. Returns its src/. */
function sourceCopy(name: string): string {
  const base = tempDir(name);
  const src = path.join(base, "plugin", "src");
  cpSync(path.join(root, "plugin", "src"), src, { recursive: true });
  symlinkSync(path.join(root, "node_modules"), path.join(base, "node_modules"), "dir");
  return src;
}

describe("the panel bundle in memory", () => {
  it("serves the panel after the source folder is renamed away", async () => {
    const src = sourceCopy("ui-moved");
    const d = (await startDaemon({
      config: { port: 0, dataDir: tempDir("ui-moved-data"), idleGraceMs: null },
      build: { id: "uimoved", built_at: null },
      uiDir: path.join(src, "ui"),
      exit: () => {},
    }))!;
    try {
      // The daemon entry starts the bundle at boot.
      await d.ui.files();
      const plugin = path.dirname(src);
      renameSync(plugin, `${plugin}-removed`);
      const base = `http://127.0.0.1:${d.port}`;
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("main.js");
      const js = await fetch(`${base}/main.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toMatch(/javascript/);
      expect((await js.text()).length).toBeGreaterThan(1000);
      const css = await fetch(`${base}/styles.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toMatch(/css/);
      expect((await fetch(`${base}/main.js.map`)).status).toBe(200);
    } finally {
      d.shutdown("test end");
    }
  }, 30_000);

  it("gives the same files to every call, and bundles one time", async () => {
    const bundle = createUiBundle(path.join(sourceCopy("ui-once"), "ui"));
    const a = await bundle.files();
    expect(await bundle.files()).toBe(a);
    expect([...a.keys()].sort()).toEqual(["index.html", "main.js", "main.js.map", "styles.css"]);
    bundle.close();
  }, 30_000);

  it("a failed bundle is not kept: the next call tries again", async () => {
    const bundle = createUiBundle(path.join(tempDir("ui-none"), "ui"));
    await expect(bundle.files()).rejects.toThrow();
    await expect(bundle.files()).rejects.toThrow();
    bundle.close();
  });

  it("with watch (yarn dev), a change to the panel source makes the files in memory again", async () => {
    const ui = path.join(sourceCopy("ui-watch"), "ui");
    const bundle = createUiBundle(ui, { watch: true });
    try {
      const first = await bundle.files();
      appendFileSync(path.join(ui, "styles.css"), "\n/* watch-css-mark */\n");
      await waitFor(async () => (await bundle.files()).get("styles.css")!.toString().includes("watch-css-mark"), 10_000);
      appendFileSync(path.join(ui, "main.ts"), '\nconsole.debug("watch-js-mark");\n');
      await waitFor(async () => (await bundle.files()).get("main.js")!.toString().includes("watch-js-mark"), 10_000);
      expect(first.get("main.js")!.toString()).not.toContain("watch-js-mark");
    } finally {
      bundle.close();
    }
  }, 30_000);
});
