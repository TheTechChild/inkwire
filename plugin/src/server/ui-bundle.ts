// The panel files, made in memory (no dist/). Node runs the server from the
// TypeScript source, but a browser cannot, so the daemon bundles
// plugin/src/ui/main.ts with esbuild and keeps the result in memory, with
// index.html and styles.css. The daemon entry starts the bundle at boot. After
// the first good bundle, the panel comes only from memory: Claude Code installs
// each update into a new cache folder and removes the old folder later, so a
// daemon must not read its plugin folder for each request. A failed bundle is
// not kept, so the next request tries again.
//
// For yarn dev (INKWIRE_UI_WATCH=1), the bundle watches the source and makes
// the files in memory again after each change.
import { readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildContext, BuildOptions, BuildResult } from "esbuild";

/** plugin/src/ui/. */
export const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));

/** The flat files of the panel: name → content. */
export type UiFiles = ReadonlyMap<string, Buffer>;

/** The panel files of one source folder. */
export interface UiBundle {
  /** The panel files. The first call starts the bundle; later calls get the same files. */
  files(): Promise<UiFiles>;
  /** Stop the watch (dev). The files stay. */
  close(): void;
}

/** The files that are copied, not bundled. */
const STATIC_FILES = ["index.html", "styles.css"];

function options(uiDir: string): BuildOptions & { write: false } {
  return {
    entryPoints: [path.join(uiDir, "main.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    sourcemap: true,
    outdir: path.join(uiDir, "out"),
    write: false,
    logLevel: "silent",
  };
}

function collect(uiDir: string, result: BuildResult<{ write: false }>): Map<string, Buffer> {
  const out = path.join(uiDir, "out");
  const files = new Map<string, Buffer>();
  for (const f of result.outputFiles) files.set(path.relative(out, f.path), Buffer.from(f.contents));
  for (const name of STATIC_FILES) files.set(name, readFileSync(path.join(uiDir, name)));
  return files;
}

/** The panel bundle of a source folder. With watch, a change to the source makes the files again. */
export function createUiBundle(uiDir: string, opts: { watch?: boolean } = {}): UiBundle {
  let current: Promise<UiFiles> | null = null;
  let ctx: BuildContext<BuildOptions & { write: false }> | null = null;
  let watcher: FSWatcher | null = null;
  let closed = false;

  const once = async (): Promise<UiFiles> => {
    // A dynamic import: the relay and the in-process tests that never serve the panel do not load esbuild.
    const esbuild = await import("esbuild");
    return collect(uiDir, await esbuild.build(options(uiDir)));
  };

  const watched = async (): Promise<UiFiles> => {
    const esbuild = await import("esbuild");
    let resolveFirst: (files: UiFiles) => void = () => {};
    let rejectFirst: (err: unknown) => void = () => {};
    const firstFiles = new Promise<UiFiles>((res, rej) => {
      resolveFirst = res;
      rejectFirst = rej;
    });
    let settled = false;
    ctx = await esbuild.context({
      ...options(uiDir),
      plugins: [
        {
          name: "inkwire-ui-memory",
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length > 0) {
                const why = result.errors.map((e) => e.text).join("; ");
                if (!settled) {
                  settled = true;
                  rejectFirst(new Error(why));
                } else console.error(`inkwire daemon: panel bundle failed: ${why}`);
                return;
              }
              try {
                const files = collect(uiDir, result as BuildResult<{ write: false }>);
                if (!settled) {
                  settled = true;
                  resolveFirst(files);
                } else {
                  current = Promise.resolve(files);
                  console.error("inkwire daemon: panel bundle made again");
                }
              } catch (err) {
                if (!settled) {
                  settled = true;
                  rejectFirst(err);
                }
              }
            });
          },
        },
      ],
    });
    await ctx.watch();
    // esbuild watches only the files of the bundle: index.html and styles.css need their own watch.
    watcher = watch(uiDir, (_event, name) => {
      if (name && STATIC_FILES.includes(String(name))) void ctx?.rebuild().catch(() => {});
    });
    watcher.unref();
    return firstFiles;
  };

  return {
    files() {
      if (!current) {
        current = (opts.watch && !closed ? watched() : once()).catch((err: unknown) => {
          current = null;
          void ctx?.dispose();
          ctx = null;
          watcher?.close();
          watcher = null;
          throw err;
        });
      }
      return current;
    },
    close() {
      closed = true;
      watcher?.close();
      watcher = null;
      void ctx?.dispose();
      ctx = null;
    },
  };
}

let fallback: UiBundle | null = null;

/** The panel files of this plugin copy, for a server that was given no bundle (in-process tests). */
export function uiFiles(): Promise<UiFiles> {
  fallback ??= createUiBundle(UI_DIR);
  return fallback.files();
}
