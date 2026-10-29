// The panel's one icon set. A font glyph (▸ ❚❚ ↺ ◆ ✕) takes its size from the font, so
// glyphs side by side draw at different sizes; every icon here is drawn on the same
// 24×24 box with the same 2px line, square corners (the panel has no radii), and shown
// at the size of its context (--icon-size in styles.css: 14 header, 12 panel, 10 chip).
// Most line art is after Feather (MIT, feathericons.com), squared off.
//
// Rules for a new icon: draw inside 1..23 on both axes; no width, height, stroke or
// stroke-width attributes (the wrapper sets them); a solid shape says fill="currentColor".
// tests/ui/icons.test.ts checks these rules.

const SOLID = `fill="currentColor"`;

export const ICONS = {
  // — playback: a path walk —
  play: `<path d="M7 4l12 8-12 8z" ${SOLID}></path>`,
  pause: `<rect x="6" y="4" width="4" height="16" ${SOLID}></rect><rect x="14" y="4" width="4" height="16" ${SOLID}></rect>`,
  stop: `<rect x="5" y="5" width="14" height="14" ${SOLID}></rect>`,
  replay: `<path d="M2 4v6h6"></path><path d="M4.5 15a9 9 0 1 0 2.1-9.4L2 10"></path>`,
  loop: `<path d="M17 2l4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="M7 22l-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path>`,
  "step-back": `<path d="M19 20L9 12l10-8z" ${SOLID}></path><path d="M5 19V5"></path>`,
  "step-forward": `<path d="M5 4l10 8-10 8z" ${SOLID}></path><path d="M19 5v14"></path>`,

  // — direction and disclosure —
  "chevron-right": `<path d="M9 18l6-6-6-6"></path>`,
  "chevron-left": `<path d="M15 18l-6-6 6-6"></path>`,
  "chevron-down": `<path d="M6 9l6 6 6-6"></path>`,
  "chevron-up": `<path d="M18 15l-6-6-6 6"></path>`,
  "arrow-right": `<path d="M5 12h14"></path><path d="M12 5l7 7-7 7"></path>`,
  "arrow-left": `<path d="M19 12H5"></path><path d="M12 19l-7-7 7-7"></path>`,

  // — history —
  undo: `<path d="M9 14L4 9l5-5"></path><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>`,
  redo: `<path d="M15 14l5-5-5-5"></path><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path>`,

  // — marks and status —
  diamond: `<path d="M12 3l9 9-9 9-9-9z" ${SOLID}></path>`,
  "diamond-outline": `<path d="M12 3l9 9-9 9-9-9z"></path>`,
  dot: `<circle cx="12" cy="12" r="5" ${SOLID}></circle>`,
  "dot-outline": `<circle cx="12" cy="12" r="5"></circle>`,
  check: `<path d="M20 6L9 17l-5-5"></path>`,
  close: `<path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>`,
  info: `<circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path>`,
  warning: `<path d="M12 3L2 21h20z"></path><path d="M12 10v4"></path><path d="M12 17.5h.01"></path>`,
  error: `<circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>`,

  // — board objects —
  draft: `<rect x="3" y="3" width="18" height="18"></rect><rect x="8" y="8" width="8" height="8" ${SOLID}></rect>`,
  notebook: `<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"></path><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"></path>`,
  layers: `<path d="M12 2L2 7l10 5 10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path>`,
  session: `<path d="M21 3H3v14h4v4l4-4h10z"></path>`,
  history: `<circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path>`,
  state: `<path d="M8 3H6v6l-3 3 3 3v6h2"></path><path d="M16 3h2v6l3 3-3 3v6h-2"></path>`,
  tools: `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"></path>`,
  path: `<circle cx="5" cy="6" r="2"></circle><circle cx="19" cy="18" r="2"></circle><path d="M7 6h7a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h7"></path>`,
  focus: `<circle cx="12" cy="12" r="9"></circle><path d="M22 12h-4"></path><path d="M6 12H2"></path><path d="M12 6V2"></path><path d="M12 22v-4"></path>`,
  code: `<path d="M16 18l6-6-6-6"></path><path d="M8 6l-6 6 6 6"></path>`,
  link: `<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path>`,

  // — drawing tools —
  select: `<path d="M4 3l7 18 2.5-7.5L21 11z"></path>`,
  pen: `<path d="M17 3l4 4L7.5 20.5 2 22l1.5-5.5z"></path>`,
  node: `<rect x="3" y="6" width="18" height="12"></rect>`,
  edge: `<path d="M5 19L19 5"></path><path d="M9 5h10v10"></path>`,
  text: `<path d="M4 7V4h16v3"></path><path d="M9 20h6"></path><path d="M12 4v16"></path>`,
  erase: `<path d="M7 21h14"></path><path d="M14.5 3.5l6 6L11 19H7l-4-4z"></path><path d="M9 9l6 6"></path>`,

  // — board actions —
  plus: `<path d="M12 5v14"></path><path d="M5 12h14"></path>`,
  minus: `<path d="M5 12h14"></path>`,
  edit: `<path d="M12 20h9"></path><path d="M16.5 3.5l4 4L7 21H3v-4z"></path>`,
  trash: `<path d="M3 6h18"></path><path d="M19 6l-1 15H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V3h6v3"></path>`,
  copy: `<rect x="9" y="9" width="13" height="13"></rect><path d="M5 15H2V2h13v3"></path>`,
  download: `<path d="M21 15v6H3v-6"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path>`,
  upload: `<path d="M21 15v6H3v-6"></path><path d="M17 8l-5-5-5 5"></path><path d="M12 3v12"></path>`,
  camera: `<path d="M1 7h5l2-3h8l2 3h5v14H1z"></path><circle cx="12" cy="13" r="4"></circle>`,
  infer: `<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"></path><path d="M19 15v6"></path><path d="M16 18h6"></path>`,
  refresh: `<path d="M22 4v6h-6"></path><path d="M19.5 15a9 9 0 1 1-2.1-9.4L22 10"></path>`,
  "external-link": `<path d="M18 13v8H3V6h8"></path><path d="M15 3h6v6"></path><path d="M10 14L21 3"></path>`,

  // — view —
  "zoom-in": `<circle cx="11" cy="11" r="8"></circle><path d="M21 21l-4.4-4.4"></path><path d="M11 8v6"></path><path d="M8 11h6"></path>`,
  "zoom-out": `<circle cx="11" cy="11" r="8"></circle><path d="M21 21l-4.4-4.4"></path><path d="M8 11h6"></path>`,
  search: `<circle cx="11" cy="11" r="8"></circle><path d="M21 21l-4.4-4.4"></path>`,
  fit: `<path d="M8 3H3v5"></path><path d="M16 3h5v5"></path><path d="M21 16v5h-5"></path><path d="M3 16v5h5"></path>`,
  eye: `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"></path><circle cx="12" cy="12" r="3"></circle>`,
  "eye-off": `<path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.1-5.9"></path><path d="M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2"></path><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"></path><path d="M1 1l22 22"></path>`,
  "panel-right": `<rect x="3" y="3" width="18" height="18"></rect><path d="M15 3v18"></path>`,
  sun: `<circle cx="12" cy="12" r="5"></circle><path d="M12 1v2"></path><path d="M12 21v2"></path><path d="M4.2 4.2l1.4 1.4"></path><path d="M18.4 18.4l1.4 1.4"></path><path d="M1 12h2"></path><path d="M21 12h2"></path><path d="M4.2 19.8l1.4-1.4"></path><path d="M18.4 5.6l1.4-1.4"></path>`,
  moon: `<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path>`,

  // — controls —
  lock: `<rect x="4" y="11" width="16" height="11"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>`,
  unlock: `<rect x="4" y="11" width="16" height="11"></rect><path d="M8 11V7a4 4 0 0 1 7.7-1.5"></path>`,
  more: `<circle cx="5" cy="12" r="1.5" ${SOLID}></circle><circle cx="12" cy="12" r="1.5" ${SOLID}></circle><circle cx="19" cy="12" r="1.5" ${SOLID}></circle>`,
  grip: `<circle cx="9" cy="6" r="1.5" ${SOLID}></circle><circle cx="15" cy="6" r="1.5" ${SOLID}></circle><circle cx="9" cy="12" r="1.5" ${SOLID}></circle><circle cx="15" cy="12" r="1.5" ${SOLID}></circle><circle cx="9" cy="18" r="1.5" ${SOLID}></circle><circle cx="15" cy="18" r="1.5" ${SOLID}></circle>`,
  sliders: `<path d="M4 21v-7"></path><path d="M4 10V3"></path><path d="M12 21v-9"></path><path d="M12 8V3"></path><path d="M20 21v-5"></path><path d="M20 12V3"></path><path d="M1 14h6"></path><path d="M9 8h6"></path><path d="M17 16h6"></path>`,
} as const;

export type IconName = keyof typeof ICONS;

/** One icon as SVG markup, sized by the --icon-size of where it lands (the .icon class). */
export function icon(name: IconName): string {
  return `<svg class="icon" data-icon="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** Fill each `<span data-icon="name">` under root with its icon: for the static shell (index.html). */
export function hydrateIcons(root: ParentNode): void {
  for (const slot of root.querySelectorAll<HTMLElement>("[data-icon]:not(svg)")) {
    const name = slot.dataset.icon as IconName;
    if (name in ICONS) slot.outerHTML = icon(name);
  }
}
