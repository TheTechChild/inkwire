// Boot: board id from the query string, WS connection, render loop.
import { connectWs } from "./ws-client.js";
import { renderWorld, setupCanvas } from "./canvas.js";
import { loadPanelPrefs, renderPanel, setupPanel } from "./panel.js";
import { renderNotebook, setupNotebook } from "./notebook.js";
import { setupSession } from "./session.js";
import { el, type App } from "./app.js";

const boardId = new URLSearchParams(location.search).get("board");

if (!boardId) {
  void showBoardPicker();
} else {
  boot(boardId);
}

function boot(id: string): void {
  const { rim, dim, notebook, ...panel } = loadPanelPrefs();
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
    const { boards } = (await res.json()) as {
      boards: { id: string; name: string; nodes: number; edges: number; updated_at: number }[];
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
      wrap.appendChild(a);
    }
  } catch {
    const p = document.createElement("p");
    p.textContent = "Could not reach the server.";
    wrap.appendChild(p);
  }
}
