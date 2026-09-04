// Notebook pane (handoff "Notebooks"): tab strip, head, read/edit body, foot.
// Markdown lives on the server (Notebook.body); this module only parses it for
// display (core/notebooks.js parseNotebook) and resolves [[id]] refs to chips
// against the live push state — refs are never rewritten by anything here.
import { markCounts } from "../core/drafts.js";
import { nextNotebookId, parseNotebook, toggleTaskLine } from "../core/notebooks.js";
import { beginHold, clearNbHover, holdFired, nbHoverRef, roleHue, setNbHover, startPeek } from "./canvas.js";
import type { App } from "./app.js";
import { el, focusLayer } from "./app.js";
import { bindResizer, clampNbWidth, savePanelPrefs, toast } from "./panel.js";
import { DRAFT_ROLES } from "../shared/types.js";
import type { CanvasState, Draft, Notebook } from "../shared/types.js";

// Tracks the human's own last-sent edit, so a server push while typing can be
// told apart from the ordinary echo of that very edit (see the caret guard
// in renderNotebook below) — an unrelated body means someone else wrote to
// the same notebook while the human was mid-edit. Set only when a body is
// actually told to the server (sendNbBody, or a caller outside this module
// via noteOwnSend) — never on every keystroke, or an in-flight round trip
// makes a later keystroke's echo look like it changed under you.
let lastSentId: string | null = null;
let lastSentBody: string | null = null;
const notebookChangedNotice = new Set<string>();
let nbSendTimer: number | null = null;

/** Record a body we're telling (or about to tell) the server about, for the
 * "changed under you" guard and the caret-to-end guard below. Exported for
 * canvas.ts's T tool, which sends its own notebooks_update outside this
 * module's textarea. */
export function noteOwnSend(id: string, body: string): void {
  lastSentId = id;
  lastSentBody = body;
  notebookChangedNotice.delete(id); // a fresh send re-arms the notice
}

function sendNbBody(app: App, id: string, body: string): void {
  noteOwnSend(id, body);
  app.send({ type: "notebooks_update", notebook_id: id, body });
}

export function setupNotebook(app: App): void {
  el("btn-notebook").addEventListener("click", () => {
    app.notebook.open = !app.notebook.open;
    savePanelPrefs(app);
    app.render();
  });
  el("nb-rail").addEventListener("click", () => {
    app.notebook.open = true;
    savePanelPrefs(app);
    app.render();
  });
  el("btn-nb-new").addEventListener("click", () => {
    const id = app.push ? nextNotebookId(app.push.state.notebooks) : "N1";
    app.send({ type: "notebooks_create" });
    app.notebook.open = true;
    app.notebook.edit = true;
    savePanelPrefs(app);
    toast(`notebooks_create · ${id} · title it, then write`);
    app.render();
  });
  el<HTMLInputElement>("nb-title").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const id = input.dataset.id;
    if (!id) return;
    app.send({ type: "notebooks_update", notebook_id: id, title: input.value });
  });
  const textarea = el<HTMLTextAreaElement>("nb-textarea");
  textarea.addEventListener("input", (e) => {
    const ta = e.target as HTMLTextAreaElement;
    const id = ta.dataset.id;
    if (!id) return;
    // Every keystroke still commits (handoff: "the pane is the store") — just
    // not as its own request. Debounced 250ms so a run of typing doesn't
    // flush the activity log or broadcast the whole board once per
    // character; a pause this short is well under what reads as "saved
    // later" rather than "live".
    if (nbSendTimer !== null) window.clearTimeout(nbSendTimer);
    nbSendTimer = window.setTimeout(() => {
      nbSendTimer = null;
      sendNbBody(app, id, ta.value);
    }, 250);
  });
  textarea.addEventListener("blur", () => {
    if (nbSendTimer === null) return;
    window.clearTimeout(nbSendTimer);
    nbSendTimer = null;
    const id = textarea.dataset.id;
    if (id) sendNbBody(app, id, textarea.value); // flush so leaving the field never drops a tail edit
  });
  el<HTMLButtonElement>("btn-nb-edit").addEventListener("click", () => {
    app.notebook.edit = !app.notebook.edit;
    savePanelPrefs(app);
    app.render();
  });
  bindResizer(
    el("nb-resizer"),
    () => app.notebook.width,
    (w) => (app.notebook.width = w),
    clampNbWidth,
    // Just the CSS var while dragging — a full renderNotebook would rebuild
    // every chip and block on each pointermove tick, same idea as applyPanel.
    () => applyNotebookWidth(app),
    () => savePanelPrefs(app),
  );
  // A node/edge chip's mouseleave can't be trusted to clear the hover — the
  // mouseenter that set it just rebuilt every chip (see buildChip). Whatever
  // is actually under the pointer wins instead, checked on real movement.
  window.addEventListener("pointermove", (e) => {
    const ref = nbHoverRef();
    if (!ref) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    if (hit?.closest<HTMLElement>(".nb-chip")?.dataset.ref !== ref) {
      clearNbHover(ref);
      app.render();
    }
  });
  renderNotebook(app);
}

function applyNotebookWidth(app: App): void {
  // --nb-col is read on #body's grid-template-columns (styles.css), not on
  // #notebook — #notebook is a CHILD of #body, so a property inherits
  // downward and setting it here would never reach the ancestor that reads
  // it. Same target applyPanel uses for --panel-w (panel.ts).
  el("body").style.setProperty("--nb-col", app.notebook.open ? `${app.notebook.width}px` : "28px");
}

function openNotebook(app: App, id: string): void {
  app.send({ type: "notebooks_open", notebook_id: id });
  app.notebook.open = true;
  app.notebook.edit = false;
  savePanelPrefs(app);
  app.render();
}

export function renderNotebook(app: App): void {
  const state = app.push?.state;
  if (!state) return;
  const pane = el("nb-pane");
  const rail = el("nb-rail");
  const active = state.notebooks.find((n) => n.id === state.active_notebook) ?? null;

  applyNotebookWidth(app);
  pane.hidden = !app.notebook.open;
  rail.hidden = app.notebook.open;
  if (!app.notebook.open) {
    el("nb-rail-title").textContent = active ? `${active.id} · ${active.title || "untitled"}` : "notebook";
    return;
  }

  // Caret guard (the drafts flavour, panel.ts renderDrafts): never rebuild under
  // the user's caret in the title or the body — unless its notebook is already
  // gone, in which case it's wired to a dead id and must be rebuilt anyway.
  const focused = document.activeElement;
  if ((focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && pane.contains(focused)) {
    const id = focused.dataset.id;
    if (id !== undefined && state.notebooks.some((n) => n.id === id)) {
      // notebooks_update (e.g. an append) landing under a mid-edit human doesn't
      // lock — it doesn't touch their buffer either, just says so once. Compared
      // against the body we last sent, not the live textarea (which is already
      // further ahead than any keystroke's echo, even with no one else editing).
      if (focused instanceof HTMLTextAreaElement && id === lastSentId && active?.body !== lastSentBody && !notebookChangedNotice.has(id)) {
        notebookChangedNotice.add(id);
        toast(`notebooks_update · ${id} changed under you`);
      }
      return;
    }
  }

  renderTabs(app, state);
  renderHead(active);
  renderBody(app, state, active);
  renderFoot(app, state, active);
}

function renderTabs(app: App, state: CanvasState): void {
  const list = el("nb-tablist");
  list.replaceChildren();
  for (const nb of state.notebooks) {
    const btn = document.createElement("button");
    btn.className = nb.id === state.active_notebook ? "nb-tab on" : "nb-tab";
    btn.title = `${nb.id} · ${nb.title || "untitled"}`;
    btn.innerHTML = `<span class="id"></span><span class="title"></span>`;
    (btn.children[0] as HTMLElement).textContent = nb.id;
    (btn.children[1] as HTMLElement).textContent = nb.title || "untitled";
    btn.addEventListener("click", () => openNotebook(app, nb.id));
    list.appendChild(btn);
  }
}

function renderHead(active: Notebook | null): void {
  el("nb-id").textContent = active?.id ?? "";
  el("nb-by").textContent = active?.author ?? "";
  const title = el<HTMLInputElement>("nb-title");
  title.value = active?.title ?? "";
  title.disabled = !active;
  title.dataset.id = active?.id ?? "";
}

function renderBody(app: App, state: CanvasState, active: Notebook | null): void {
  const empty = el("nb-empty");
  const read = el("nb-read");
  const textarea = el<HTMLTextAreaElement>("nb-textarea");
  if (!active) {
    empty.hidden = false;
    read.hidden = true;
    textarea.hidden = true;
    return;
  }
  empty.hidden = true;
  const edit = app.notebook.edit;
  read.hidden = edit;
  textarea.hidden = !edit;
  if (edit) {
    textarea.value = active.body;
    textarea.dataset.id = active.id;
    if (app.nbCaretToEnd) {
      // A just-sent body (the T tool's [[ref]] append, or a fresh
      // notebooks_create — see noteOwnSend) may not have echoed back into
      // `active` yet. Focusing on this stale render would park the caret in
      // the textarea, and the caret guard above then refuses to apply the
      // real echo once it lands — the ref would never show up. Wait for the
      // render where the body actually matches what was sent.
      const pending = active.id === lastSentId && active.body !== lastSentBody;
      if (!pending) {
        app.nbCaretToEnd = false;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    }
  } else {
    renderBlocks(app, state, active);
  }
}

function renderBlocks(app: App, state: CanvasState, nb: Notebook): void {
  const host = el("nb-read");
  host.replaceChildren();
  for (const b of parseNotebook(nb.body)) {
    const row = document.createElement("div");
    row.className = "nb-block";
    row.dataset.type = b.type;
    if (b.type === "task") {
      const check = document.createElement("button");
      check.className = b.done ? "nb-check done" : "nb-check";
      check.title = "toggle — written back into the markdown";
      check.textContent = b.done ? "✓" : "";
      check.addEventListener("click", () => {
        // Look up the body fresh, not the `nb` closed over at render time —
        // an append landing between render and click (the agent, or the
        // human's own debounced textarea send) would otherwise be clobbered
        // by this whole-body replace.
        const body = app.push?.state.notebooks.find((x) => x.id === nb.id)?.body ?? nb.body;
        app.send({ type: "notebooks_update", notebook_id: nb.id, body: toggleTaskLine(body, b.line) });
      });
      row.appendChild(check);
    } else if (b.type === "bullet") {
      const mark = document.createElement("span");
      mark.className = "nb-bullet-mark";
      mark.textContent = "—";
      row.appendChild(mark);
    }
    const text = document.createElement("div");
    text.className = b.type === "task" && b.done ? "nb-text done" : "nb-text";
    text.dataset.type = b.type;
    for (const part of b.parts) {
      if (part.kind === "text") {
        const span = document.createElement("span");
        span.textContent = part.text;
        text.appendChild(span);
      } else {
        text.appendChild(buildChip(app, state, part.id));
      }
    }
    row.appendChild(text);
    host.appendChild(row);
  }
}

function renderFoot(app: App, state: CanvasState, active: Notebook | null): void {
  const note = el("nb-footnote");
  const btn = el<HTMLButtonElement>("btn-nb-edit");
  if (!active) {
    note.textContent = "";
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = app.notebook.edit ? "read · ⌘E" : "edit · ⌘E";
  const refs = [...active.body.matchAll(/\[\[([A-Za-z]\w*)\]\]/g)].map((m) => m[1]!);
  const gone = refs.filter((id) => !resolveRef(state, id)).length;
  const totalTasks = (active.body.match(/- \[( |x)\]/g) ?? []).length;
  const doneTasks = (active.body.match(/- \[x\]/g) ?? []).length;
  note.textContent =
    `${refs.length} refs` +
    (gone ? ` · ${gone} gone` : "") +
    (totalTasks ? ` · ${doneTasks}/${totalTasks} tasks` : "");
}

// ---------------------------------------------------------------------------
// [[id]] ref resolution + chips (handoff "Notebooks" § 2). Never rewrites the
// body — a dangling ref just resolves to null and draws as "gone".

interface RefResolution {
  kind: "layer" | "path" | "draft" | "node" | "edge";
  label: string;
  layerId?: string;
  hops?: number;
  draft?: Draft;
}

function resolveRef(state: CanvasState, ref: string): RefResolution | null {
  if (ref[0] === "L") {
    const l = state.layers.find((x) => x.id === ref);
    return l ? { kind: "layer", label: `${l.letter} · ${l.title}` } : null;
  }
  if (ref[0] === "P") {
    for (const l of state.layers) {
      const p = l.paths.find((x) => x.id === ref);
      if (p) return { kind: "path", label: p.title, layerId: l.id, hops: p.steps.length };
    }
    return null;
  }
  if (ref[0] === "D") {
    const d = state.drafts.find((x) => x.id === ref);
    return d ? { kind: "draft", label: d.title || "untitled", draft: d } : null;
  }
  if (ref[0] === "e") {
    const e = state.graph.edges.find((x) => x.id === ref);
    return e ? { kind: "edge", label: e.label || "edge" } : null;
  }
  const n = state.graph.nodes.find((x) => x.id === ref);
  // ponytail: a legacy note node's label can run long — same 26-char clip the
  // reference implementation uses, since a note was never meant to be a chip label.
  return n ? { kind: "node", label: n.kind === "note" ? `${n.label.slice(0, 26)}…` : n.label } : null;
}

function buildChip(app: App, state: CanvasState, ref: string): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.className = "nb-chip";
  chip.innerHTML = `<span class="id"></span><span class="label"></span>`;
  (chip.children[0] as HTMLElement).textContent = ref;
  const labelEl = chip.children[1] as HTMLElement;

  const res = resolveRef(state, ref);
  if (!res) {
    chip.dataset.kind = "gone";
    labelEl.textContent = "gone";
    chip.title = `${ref} is not on the board any more · the body is unchanged — canvas_lint reports it`;
    chip.disabled = true;
    return chip;
  }
  labelEl.textContent = res.label;
  chip.dataset.kind = res.kind;
  chip.dataset.ref = ref;

  if (res.kind === "layer") {
    chip.title = `focus ${ref} · ${res.label}`;
    chip.addEventListener("click", () => focusLayer(app, ref));
  } else if (res.kind === "path") {
    chip.title = `hold to peek · click to play ${ref} · ${res.hops} hops`;
    // Hold releases on window (canvas.ts's beginHold/holdFired), same as the
    // layer chip bar — startPeek's render rebuilds this very chip, so a
    // pointerup/pointerleave bound to it would never fire (finding: peek
    // never ends). A quick tap (hold never fires) reaches here as a native
    // click instead, and plays the path.
    chip.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      beginHold(() => startPeek(app, res.layerId!, ref));
    });
    chip.addEventListener("click", () => {
      if (holdFired()) return;
      app.send({ type: "trace_set", path_id: ref });
    });
  } else if (res.kind === "draft") {
    const on = state.active_draft === ref;
    const counts = markCounts(res.draft!, state.graph.nodes, state.graph.edges);
    chip.classList.toggle("on", on);
    chip.title = `${on ? "deactivate" : "activate"} ${ref} · ${res.label}`;
    const countsEl = document.createElement("span");
    countsEl.className = "counts";
    for (const role of DRAFT_ROLES) {
      const n = counts[role];
      const span = document.createElement("span");
      span.textContent = String(n);
      span.style.color = on ? "var(--color-bg)" : n === 0 ? "var(--color-neutral-500)" : roleHue(role);
      countsEl.appendChild(span);
    }
    chip.appendChild(countsEl);
    chip.addEventListener("click", () => app.send({ type: "drafts_activate", draft_id: on ? null : ref }));
  } else {
    // node or edge: click selects, hover lifts it on the canvas — the same
    // dim/lift treatment a session_send highlight gets (canvas.ts's nbHover).
    chip.title = `click to select ${ref} · hover lifts it on the canvas`;
    chip.addEventListener("click", () => {
      app.sel = { type: res.kind as "node" | "edge", id: ref };
      clearNbHover(ref);
      app.render();
    });
    // Entering still works via mouseenter — that fires on genuine hover
    // regardless of what render did before it. Leaving doesn't: the render
    // this triggers rebuilds the chip mouseleave would need to fire on, so
    // it's released on window instead (setupNotebook's pointermove) — same
    // constraint as the path chip's hold, above.
    chip.addEventListener("mouseenter", () => {
      const isNode = res.kind === "node";
      setNbHover(ref, { label: `${ref} · ${res.label}`, nodes: isNode ? [ref] : [], edges: isNode ? [] : [ref] });
      app.render();
    });
  }
  return chip;
}
