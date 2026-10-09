// ADR 0001: the link is a replaceable layer. Nothing outside src/link/ imports
// the socket library for MCP. src/server/ws.ts (the panel hub) is the one
// other ws user, and it must not touch the /mcp link. The relay must not
// reach the store, session.ts or better-sqlite3.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!);
}

const rel = (file: string) => path.relative(srcRoot, file).split(path.sep).join("/");

describe("link boundary", () => {
  it("only src/link/ and src/server/ws.ts import ws", () => {
    for (const file of tsFiles(srcRoot)) {
      const r = rel(file);
      if (r.startsWith("link/") || r === "server/ws.ts") continue;
      for (const imp of imports(file)) expect(imp, `${r} imports ${imp}`).not.toMatch(/^ws(\/|$)/);
    }
  });

  it("src/server/ws.ts does not touch /mcp", () => {
    expect(readFileSync(path.join(srcRoot, "server/ws.ts"), "utf8")).not.toContain("/mcp");
  });

  it("src/server/upgrade.ts does not import ws", () => {
    for (const imp of imports(path.join(srcRoot, "server/upgrade.ts"))) expect(imp).not.toMatch(/^ws(\/|$)/);
  });

  it("the relay does not reach the store, session.ts or better-sqlite3", () => {
    const seen = new Set<string>();
    const stack = [path.join(srcRoot, "link/relay.ts")];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const imp of imports(file)) {
        expect(imp, `${rel(file)} imports ${imp}`).not.toMatch(/better-sqlite3/);
        if (!imp.startsWith(".")) continue;
        const target = path.resolve(path.dirname(file), imp).replace(/\.js$/, ".ts");
        expect(rel(target), `${rel(file)} imports ${imp}`).not.toMatch(/^server\/(store|session)\.ts$/);
        if (existsSync(target)) stack.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
