// Local HTTP server: serves the panel bundle, stored bitmaps, the capture
// POST endpoint, the hook endpoint, the mod's routes (ADR 0004), and a health
// probe. 127.0.0.1 only.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Store } from "./store.ts";
import type { Screenshots } from "./screenshot.ts";
import type { Sessions } from "./session.ts";
import type { Client, Clients } from "./clients.ts";
import type { AuthorPush } from "../shared/protocol.ts";
import * as mutations from "./mutations.ts";
import { ImportError, exportBoard, exportFilename, importBoard } from "./board-file.ts";
import { hookEvent } from "./session-mode.ts";
import { listBoards } from "./project-root.ts";
import type { BuildInfo } from "./build-info.ts";
import { checkBrowserRequest, logRefused } from "./origin.ts";
import { uiFiles, type UiFiles } from "./ui-bundle.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export interface HttpDeps {
  store: Store;
  sessions: Sessions;
  clients: Clients;
  screenshots: () => Screenshots;
  /**
   * The daemon's build, read one time at boot (Decision 10). An old inkwire
   * server (a build from before the daemon) sends none, so a relay knows that
   * port holds an old server (M4.6). In-process tests can leave it out.
   */
  build?: BuildInfo;
  /** The panel files, made in memory at boot (ui-bundle.ts). Default: this copy's bundle. */
  ui?: () => Promise<UiFiles>;
  /** The pid that /healthz reports. Default process.pid. */
  pid?: number;
  /** The counts that /healthz and the restart route report. Default: every Client and every open board. */
  stats?: () => HealthStats;
  /**
   * The person-only restart (M4.9). Only the daemon sets it; with none,
   * POST /api/daemon/restart is not found.
   */
  restart?: () => void;
  /**
   * The panel hub, for the mod's routes (ADR 0004): the Author field of its
   * push. With none, /api/mod/* is not found. A getter, because the hub is
   * made after the handler.
   */
  hub?: () => ModHub;
}

/** What the mod's routes need from the panel hub (PanelHub). */
export interface ModHub {
  author(boardId: string): AuthorPush | null;
}

/** The longest wait of one GET /api/mod/view (ADR 0004). The mod polls again at once. */
export const MOD_VIEW_MAX_WAIT_MS = 25_000;

/** The methods that change state. Each one gets the Origin and Host check (M4.11). */
const STATE_CHANGING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export interface HealthStats {
  clients: number;
  boards: number;
}

/** The counts of a daemon: every Client record and every open board. */
export function defaultStats(deps: Pick<HttpDeps, "clients" | "sessions">): HealthStats {
  return { clients: deps.clients.all().length, boards: deps.sessions.all().filter((s) => !s.closed).length };
}

/** The request handler alone, so the daemon can attach it to a server that already listens (M4.4). */
export function requestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(req, res, deps).catch((err) => {
      console.error("http error:", err);
      if (!res.headersSent) res.writeHead(500);
      res.end("internal error");
    });
  };
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer(requestHandler(deps));
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: HttpDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;

  // M4.11: a web page in the person's browser must not change state here.
  // The mod's routes get the check on every method: the view holds the board.
  if (STATE_CHANGING.has(req.method ?? "") || p.startsWith("/api/mod/")) {
    const reason = checkBrowserRequest(req);
    if (reason !== null) {
      logRefused(p, req, reason);
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
  }

  if (req.method === "GET" && p === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    // Keep name "inkwire": probeHealth checks it. build is absent on an old inkwire server.
    const stats = (deps.stats ?? (() => defaultStats(deps)))();
    res.end(JSON.stringify({ ok: true, name: "inkwire", pid: deps.pid ?? process.pid, build: deps.build, ...stats }));
    return;
  }

  // Person-only restart (M4.9, Decision 3): `yarn daemon:restart` posts here.
  // Not an MCP tool. Agents must not call it (Decision 12).
  if (req.method === "POST" && p === "/api/daemon/restart" && deps.restart) {
    const stats = (deps.stats ?? (() => defaultStats(deps)))();
    const restart = deps.restart;
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify(stats), () => restart());
    return;
  }

  // Claude Code hook forwarder (hooks/forward.sh): the event JSON in, a
  // plain-text verdict out — "block\n<reason>", "context\n<text>", or "ok".
  if (req.method === "POST" && p === "/api/hook") {
    const body = await readBody(req);
    let input: unknown = {};
    try {
      input = JSON.parse(body.toString("utf8") || "{}");
    } catch {
      // not JSON — treat as an empty event; the verdict is still "ok"
    }
    // forward.sh adds ?pid=<Claude Code pid> when it finds a claude ancestor.
    // The mod adds ?via=mod and sends no pid; the body can carry prev_session_id (ADR 0004).
    const via = url.searchParams.get("via") === "mod" ? ("mod" as const) : undefined;
    const pid = Number.parseInt(url.searchParams.get("pid") ?? "", 10);
    const claude_pid = !via && Number.isInteger(pid) && pid > 0 ? pid : null;
    const event = (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const verdict = hookEvent(deps.clients, { ...event, claude_pid, via }, url.searchParams.get("bg") ?? "unset");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(verdict.block ? `block\n${verdict.block}` : verdict.context ? `context\n${verdict.context}` : "ok");
    return;
  }

  if (p.startsWith("/api/mod/") && deps.hub) {
    await handleMod(req, res, url, deps, deps.hub);
    return;
  }

  if (req.method === "GET" && p === "/api/boards") {
    res.writeHead(200, { "content-type": "application/json" });
    // The panel has no cwd, so it gets every board, each with its project_root, the unset mark and its Author.
    const boards = listBoards(deps.store.list(), "/", true).map((b) => {
      const pid = deps.clients.authorOf(b.id);
      return { ...b, author: pid === null ? null : { label: deps.clients.peek(pid)?.label ?? `pid ${pid}`, pid } };
    });
    res.end(JSON.stringify({ boards }));
    return;
  }

  const boardMatch = p.match(/^\/api\/boards\/([^/]+)$/);
  if (req.method === "DELETE" && boardMatch) {
    const id = decodeURIComponent(boardMatch[1]!);
    const deleted = deps.sessions.delete(id);
    res.writeHead(deleted ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(deleted ? { deleted: true, board_id: id } : { error: `board not found: ${id}` }));
    return;
  }

  // Board file export: the whole board, bitmaps embedded, as a download.
  const exportMatch = p.match(/^\/api\/boards\/([^/]+)\/export$/);
  if (req.method === "GET" && exportMatch) {
    const id = decodeURIComponent(exportMatch[1]!);
    if (!deps.store.load(id)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `board not found: ${id}` }));
      return;
    }
    const file = exportBoard(deps.sessions.open(id), deps.store, Date.now());
    res.writeHead(200, {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${exportFilename(file.name)}"`,
    });
    res.end(JSON.stringify(file, null, 2));
    return;
  }

  // Board file import: validate, create a new board with the content. ?project_root= wins over
  // the file's root; with neither (or a root missing here) the 400 asks for one.
  if (req.method === "POST" && p === "/api/boards/import") {
    const body = await readBody(req);
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "body is not JSON" }));
      return;
    }
    try {
      const projectRoot = url.searchParams.get("project_root") ?? undefined;
      const { session, ...check } = importBoard(deps.sessions, deps.store, raw, { projectRoot });
      session.persistNow();
      const c = session.collections();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          board_id: session.boardId,
          name: session.meta.name,
          nodes: c.nodes.length,
          edges: c.edges.length,
          strokes: c.strokes.length,
          images: c.images.length,
          project_root: session.meta.project_root,
          ...check,
        }),
      );
    } catch (err) {
      if (!(err instanceof ImportError)) throw err;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && p.startsWith("/api/capture/")) {
    const id = p.slice("/api/capture/".length);
    const body = await readBody(req);
    const accepted = deps.screenshots().complete(id, body.length > 0 ? body : null);
    res.writeHead(accepted ? 200 : 410, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: accepted }));
    return;
  }

  // Panel image upload: store the bitmap, then place it on the board.
  const imageMatch = p.match(/^\/api\/boards\/([^/]+)\/images$/);
  if (req.method === "POST" && imageMatch) {
    const session = deps.sessions.open(decodeURIComponent(imageMatch[1]!));
    const body = await readBody(req);
    const isJpeg = body[0] === 0xff && body[1] === 0xd8;
    const src = deps.store.saveImage(body, isJpeg ? "jpg" : "png");
    const natural = [
      Number(url.searchParams.get("w") ?? 400),
      Number(url.searchParams.get("h") ?? 300),
    ] as [number, number];
    const at = [
      Number(url.searchParams.get("x") ?? 80),
      Number(url.searchParams.get("y") ?? 80),
    ] as [number, number];
    const result = mutations.addImage(session, "human", {
      src,
      natural,
      at,
      size: natural,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ src, ...result }));
    return;
  }

  if (req.method === "GET" && p.startsWith("/images/")) {
    serveFile(res, path.join(deps.store.imagesDir, path.basename(p)));
    return;
  }

  if (req.method === "GET") {
    const file = p === "/" ? "index.html" : p.slice(1);
    // No traversal: only the flat files of the panel, made in memory (ui-bundle.ts).
    const content = (await (deps.ui ?? uiFiles)()).get(file);
    if (!content) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(content);
    return;
  }

  res.writeHead(404);
  res.end("not found");
}

// The mod's routes (ADR 0004). The mod is person-side UI. Agents must not
// call these routes.
async function handleMod(req: IncomingMessage, res: ServerResponse, url: URL, deps: HttpDeps, hub: () => ModHub): Promise<void> {
  const p = url.pathname;
  const { clients } = deps;

  if (req.method === "GET" && p === "/api/mod/view") {
    const sessionId = url.searchParams.get("session");
    const since = url.searchParams.get("since");
    const waitRaw = url.searchParams.get("wait");
    const wait = waitRaw === null ? MOD_VIEW_MAX_WAIT_MS : Number(waitRaw);
    if (!sessionId) return sendJson(res, 400, { error: "session query parameter required" });
    if (!Number.isFinite(wait) || wait < 0) return sendJson(res, 400, { error: "wait must be a number of ms, 0 or more" });
    // `alias`: the session id that the mod saw first (the launch id). A Client
    // that a hello made after /clear holds it: the relay's env does not change.
    const alias = url.searchParams.get("alias");
    let mark = clients.bySessionId(sessionId);
    if (!mark && alias && alias !== sessionId) {
      mark = clients.bySessionId(alias);
      if (mark) clients.rekey(mark.pid, sessionId);
    }
    // Only the view loop marks liveness: a mod whose loop stopped must fall back to the blocking model.
    if (mark) clients.markMod(mark);
    const first = modView(deps, hub(), sessionId);
    if (first.key !== since || wait === 0) return sendJson(res, 200, first);
    await waitForChange(res, deps, sessionId, since, Math.min(wait, MOD_VIEW_MAX_WAIT_MS), () => modView(deps, hub(), sessionId));
    return;
  }

  if (req.method === "POST" && p === "/api/mod/take") {
    const body = await readJson(req);
    if (!body.ok) return sendJson(res, 400, { error: body.error });
    const sessionId = (body.value as { session?: unknown }).session;
    if (typeof sessionId !== "string" || !sessionId) return sendJson(res, 400, { error: "session must be a string" });
    const client = clients.bySessionId(sessionId);
    if (!client) return sendJson(res, 404, { error: `no Claude Code session ${sessionId}` });
    const replies = client.inbox;
    client.inbox = [];
    if (replies.length) clients.notify();
    return sendJson(res, 200, { replies });
  }

  sendJson(res, 404, { error: "not found" });
}

interface ModViewBody {
  key: string;
  client: { pid: number; label: string; mode: Client["mode"]; awaiting: boolean; inbox: number; current_board: string | null } | null;
  /** The current board: only what the mod's status line shows. A change elsewhere on the board does not change the key. */
  board: { id: string; name: string; author: AuthorPush | null } | null;
}

/** The mod's view of one Claude Code session; the key is a hash of the rest. */
function modView(deps: HttpDeps, hub: ModHub, sessionId: string): ModViewBody {
  const c = deps.clients.bySessionId(sessionId);
  let board: ModViewBody["board"] = null;
  if (c?.currentBoardId) {
    try {
      const s = deps.sessions.open(c.currentBoardId);
      if (!s.closed) board = { id: s.boardId, name: s.meta.name, author: hub.author(s.boardId) };
    } catch {
      // board deleted under us: no board
    }
  }
  const client = c
    ? { pid: c.pid, label: c.label, mode: c.mode, awaiting: c.awaiting, inbox: c.inbox.length, current_board: c.currentBoardId }
    : null;
  const key = createHash("sha1").update(JSON.stringify({ client, board })).digest("hex").slice(0, 16);
  return { key, client, board };
}

/**
 * The long poll: answer when the view's key is not `since` any more, else
 * after `wait` ms with the same key. Any change of Clients or of an open
 * board can change the view. Listeners and the timer go when the request closes.
 */
function waitForChange(
  res: ServerResponse,
  deps: HttpDeps,
  sessionId: string,
  since: string | null,
  wait: number,
  view: () => ModViewBody,
): Promise<void> {
  return new Promise((resolve) => {
    const offs: (() => void)[] = [];
    let queued = false;
    let done = false;
    const finish = (body: ModViewBody | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const off of offs) off();
      if (body && !res.writableEnded && !res.destroyed) sendJson(res, 200, body);
      resolve();
    };
    // One check for a burst of changes (a mutation notifies more than once).
    const check = () => {
      if (queued || done) return;
      queued = true;
      setImmediate(() => {
        queued = false;
        if (done) return;
        const next = view();
        if (next.key !== since) finish(next);
      });
    };
    const timer = setTimeout(() => finish(view()), wait);
    // Clients.notify runs Sessions.notify: a mode, a send, a reply, a claim, a current-board change.
    offs.push(deps.sessions.onChange(check));
    const c = deps.clients.bySessionId(sessionId);
    if (c?.currentBoardId) {
      try {
        offs.push(deps.sessions.open(c.currentBoardId).onChange(check));
      } catch {
        // board deleted under us: the Clients change wakes the poll
      }
    }
    res.on("close", () => finish(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; value: object } | { ok: false; error: string }> {
  const body = await readBody(req);
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "body must be a JSON object" };
    return { ok: true, value };
  } catch {
    return { ok: false, error: "body is not JSON" };
  }
}

function serveFile(res: ServerResponse, file: string): void {
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
