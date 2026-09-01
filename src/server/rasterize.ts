// SVG → PNG via resvg (SPEC § 6: no headless Chromium). Fonts: any files in
// assets/fonts/ are loaded; system fonts fill the gaps. The parity test is
// structural, so exact font metrics are not load-bearing.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const fontsDir = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));

export function rasterizeSvg(svg: string): Buffer {
  const fontFiles = existsSync(fontsDir)
    ? readdirSync(fontsDir)
        .filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
        .map((f) => path.join(fontsDir, f))
    : [];
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: true,
      fontFiles,
      defaultFontFamily: "sans-serif",
    },
  });
  return Buffer.from(resvg.render().asPng());
}
