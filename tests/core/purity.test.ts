// Enforce the layer rule: src/core and src/shared are pure — no node
// builtins, no server or ui imports, no Date.now / Math.random in core.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(path.join(srcRoot, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(srcRoot, dir, f));
}

describe("layer purity", () => {
  it.each(["core", "shared"])("src/%s imports no node builtins, server, or ui", (dir) => {
    for (const file of tsFiles(dir)) {
      const text = readFileSync(file, "utf8");
      const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const imp of imports) {
        expect(imp, `${path.basename(file)} imports ${imp}`).not.toMatch(/^node:/);
        expect(imp, `${path.basename(file)} imports ${imp}`).not.toMatch(/\/(server|ui)\//);
      }
    }
  });

  it("src/core uses no wall clock or randomness", () => {
    for (const file of tsFiles("core")) {
      const text = readFileSync(file, "utf8");
      expect(text, path.basename(file)).not.toMatch(/Date\.now|Math\.random/);
    }
  });
});
