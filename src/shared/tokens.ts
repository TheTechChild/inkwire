// Canvas render tokens read by BOTH renderers — the browser panel and the
// server-side SVG fallback. resvg cannot resolve CSS custom properties, so
// these live in TS; the UI stylesheet mirrors the same values (Industry
// design system + the dark override from the prototype, lines 22–42).

export interface ThemeTokens {
  bg: string;
  surface: string;
  text: string;
  accent: string; // AI elements
  accent700: string; // human edges/arrows
  divider: string;
  grid: string;
}

export const LIGHT: ThemeTokens = {
  bg: "#f2f2f3",
  surface: "#e9e9ea",
  text: "#1d1f20",
  accent: "#5980a6",
  accent700: "#41638a",
  divider: "rgba(29,31,32,0.16)",
  grid: "rgba(29,31,32,0.13)",
};

export const DARK: ThemeTokens = {
  bg: "#15181c",
  surface: "#1c2026",
  text: "#e8ebee",
  accent: "#8db4d8",
  accent700: "#b6d2ea",
  divider: "rgba(232,235,238,0.16)",
  grid: "rgba(232,235,238,0.10)",
};

export const RENDER = {
  // TYPOGRAPHY_LOD.md § 2 option A. Files in assets/fonts/ (resvg) and the
  // @import in ui/styles.css (panel) must carry the same faces and weights.
  fontHeading: "IBM Plex Sans",
  fontHeadingWeight: 600,
  fontBody: "Barlow",
  fontMono: "IBM Plex Mono",
  fontMonoWeight: 500,
  nodeDefaultSize: [176, 74] as [number, number],
  nodeMinHeight: 66,
  edgeGap: 6, // px outside the node border where edges are clipped
  inkWidth: 1.8,
  gridStep: 28,
} as const;
