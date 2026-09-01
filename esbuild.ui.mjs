import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist/ui", { recursive: true });
cpSync("src/ui/index.html", "dist/ui/index.html");
cpSync("src/ui/styles.css", "dist/ui/styles.css");

const options = {
  entryPoints: ["src/ui/main.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/ui/main.js",
  sourcemap: true,
  target: "es2022",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
