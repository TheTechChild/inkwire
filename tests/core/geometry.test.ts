import { describe, expect, it } from "vitest";
import { resizeBox } from "../../src/core/geometry.js";
import type { Box } from "../../src/shared/types.js";

const origin: Box = [100, 100, 200, 100];
const min = [80, 44] as const;

describe("resizeBox", () => {
  it("br grows toward the pointer, top-left fixed", () => {
    expect(resizeBox(origin, "br", [350, 260], [...min])).toEqual([100, 100, 250, 160]);
  });
  it("tl moves the origin, bottom-right fixed", () => {
    expect(resizeBox(origin, "tl", [50, 60], [...min])).toEqual([50, 60, 250, 140]);
  });
  it("tr keeps left and bottom", () => {
    expect(resizeBox(origin, "tr", [400, 50], [...min])).toEqual([100, 50, 300, 150]);
  });
  it("bl keeps right and top", () => {
    expect(resizeBox(origin, "bl", [50, 250], [...min])).toEqual([50, 100, 250, 150]);
  });
  it("clamps to min and stays pinned to the anchor", () => {
    expect(resizeBox(origin, "tl", [290, 190], [...min])).toEqual([220, 156, 80, 44]);
    expect(resizeBox(origin, "br", [0, 0], [...min])).toEqual([100, 100, 80, 44]);
  });
});
