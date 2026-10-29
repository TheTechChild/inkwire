// The panel's icon set (plugin/src/ui/icons.ts): every icon is drawn by the same
// rules, so icons side by side take the same size, and no font glyph stands in for one.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ICONS, icon } from "../../plugin/src/ui/icons.ts";

const UI = path.join(import.meta.dirname, "..", "..", "plugin", "src", "ui");

/** Every number in the icon's markup that is a coordinate or a length. */
function numbers(markup: string): number[] {
  const out: number[] = [];
  for (const [, attr, value] of markup.matchAll(/\s(d|x|y|cx|cy|r|width|height)="([^"]*)"/g)) {
    // A path's d mixes arc flags and relative moves with positions, so it is not checked here.
    if (attr === "d" || value === undefined) continue;
    out.push(...value.split(/[\s,]+/).map(Number));
  }
  return out;
}

describe("icons", () => {
  it.each(Object.keys(ICONS))("%s follows the drawing rules", (name) => {
    const markup = ICONS[name as keyof typeof ICONS];
    // The wrapper owns size, stroke and line width; an icon sets none of them.
    expect(markup).not.toMatch(/\s(stroke|stroke-width|stroke-linecap|stroke-linejoin|style|class)=/);
    // Only plain shapes, and a fill is only ever the current colour.
    for (const [, tag] of markup.matchAll(/<(\w+)/g)) expect(["path", "rect", "circle"]).toContain(tag);
    for (const [, fill] of markup.matchAll(/\sfill="([^"]*)"/g)) expect(fill).toBe("currentColor");
    // Shapes stay inside the 24×24 box.
    for (const n of numbers(markup)) {
      expect(Number.isNaN(n)).toBe(false);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(24);
    }
  });

  it("wraps each icon in the one 24×24 frame with the .icon class", () => {
    for (const name of Object.keys(ICONS) as (keyof typeof ICONS)[]) {
      const svg = icon(name);
      expect(svg).toMatch(/^<svg class="icon" data-icon="[\w-]+" viewBox="0 0 24 24" /);
      // No size on the frame: --icon-size sizes it.
      expect(svg.slice(0, svg.indexOf(">"))).not.toMatch(/\s(width|height)="/);
    }
  });

  it("the panel draws no icon with a font glyph", () => {
    // These glyphs were the panel's icons before icons.ts. Comments may still name them.
    const glyphs = /[▸▾◂▴❚↺↻◆◇▣▤✕✓↶↷●○]/;
    const offenders: string[] = [];
    for (const file of readdirSync(UI)) {
      if (!/\.(ts|html)$/.test(file) || file === "icons.ts") continue;
      readFileSync(path.join(UI, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("<!--")) return;
          if (glyphs.test(code.replace(/\/\/.*$/, ""))) offenders.push(`${file}:${i + 1}: ${code}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
