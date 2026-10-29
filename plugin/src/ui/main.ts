// Boot: board id from the query string, WS connection, render loop.
import { connectWs } from "./ws-client.ts";
import { renderTrace, renderWorld, setupCanvas } from "./canvas.ts";
import { loadPanelPrefs, loadTabOrder, renderPanel, setupPanel } from "./panel.ts";
import { renderNotebook, setupNotebook } from "./notebook.ts";
import { clientLabel, setupSession } from "./session.ts";
import { el, type App } from "./app.ts";
import { hydrateIcons } from "./icons.ts";

const boardId = new URLSearchParams(location.search).get("board");

if (!boardId) {
  void showBoardPicker();
} else {
  boot(boardId);
}

function boot(id: string): void {
  hydrateIcons(document);
  const { rim, dim, notebook, tabsLocked, ...panel } = loadPanelPrefs();
  const app: App = {
    boardId: id,
    push: null,
    tool: "select",
    tab: "layers",
    scope: "all",
    theme: "dark",
    sel: null,
    pendingFrom: null,
    space: false,
    view: { x: 40, y: 20, zoom: 1 },
    drag: null,
    panel,
    notebook,
    tabs: { order: loadTabOrder(id), locked: tabsLocked },
    nbCaretToEnd: false,
    rim,
    dim,
    draft: "",
    dropped: {},
    open: {},
    stateView: "scoped",
    traceOverride: null,
    connected: false,
    send: () => {},
    render: () => {
      renderWorld(app);
      renderPanel(app);
      renderTrace(app);
      renderNotebook(app);
    },
    flash: () => {
      const flash = el("flash");
      flash.classList.remove("on");
      void flash.offsetWidth; // restart the animation
      flash.classList.add("on");
    },
  };

  setupCanvas(app);
  setupPanel(app);
  setupNotebook(app);
  setupSession(app);
  connectWs(app);
  app.render();
}

async function showBoardPicker(): Promise<void> {
  document.getElementById("app")!.style.display = "none";
  const wrap = document.createElement("div");
  wrap.style.cssText = "padding: 48px; max-width: 560px; margin: 0 auto; font-family: var(--font-body)";
  const title = document.createElement("h2");
  title.textContent = "Inkwire boards";
  title.style.fontFamily = "var(--font-heading)";
  wrap.appendChild(title);
  document.body.appendChild(wrap);
  try {
    const res = await fetch("/api/boards");
    // root and author are optional: an older daemon does not send them.
    const { boards } = (await res.json()) as {
      boards: {
        id: string;
        name: string;
        nodes: number;
        edges: number;
        updated_at: number;
        project_root?: string;
        root?: "unset";
        author?: { label: string; pid: number } | null;
      }[];
    };
    if (boards.length === 0) {
      const p = document.createElement("p");
      p.textContent = "No boards yet. Ask Claude to run boards_create, then reload.";
      wrap.appendChild(p);
      return;
    }
    for (const b of boards) {
      const a = document.createElement("a");
      a.href = `/?board=${encodeURIComponent(b.id)}`;
      a.style.cssText = "display:block;padding:10px 0;border-bottom:1px solid var(--color-divider)";
      a.textContent = `${b.name} — ${b.nodes} nodes · ${b.edges} edges (${b.id})`;
      const meta = document.createElement("div");
      meta.style.cssText = "font-family:var(--font-mono);font-size:11px;color:var(--color-neutral-600);margin-top:4px";
      const root = b.root === "unset" ? "root: unset" : (b.project_root ?? "");
      const author = b.author === undefined ? "" : b.author ? `author ${clientLabel(b.author)}` : "no author";
      meta.textContent = [root, author].filter(Boolean).join(" · ");
      if (meta.textContent) a.appendChild(meta);
      wrap.appendChild(a);
    }
  } catch {
    const p = document.createElement("p");
    p.textContent = "Could not reach the server.";
    wrap.appendChild(p);
  }
}
