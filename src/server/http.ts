// Local HTTP server: serves the panel bundle, stored bitmaps, the capture
// POST endpoint, and a health probe. 127.0.0.1 only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Store } from "./store.js";
import type { Screenshots } from "./screenshot.js";
import type { Sessions } from "./session.js";
import * as mutations from "./mutations.js";
import { ImportError, exportBoard, exportFilename, importBoard } from "./board-file.js";
import { hookEvent } from "./session-mode.js";

const uiDir = fileURLToPath(new URL("../../dist/ui/", import.meta.url));

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
  screenshots: () => Screenshots;
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      console.error("http error:", err);
      if (!res.headersSent) res.writeHead(500);
      res.end("internal error");
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: HttpDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;

  if (req.method === "GET" && p === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "inkwire" }));
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
    const verdict = hookEvent(deps.sessions, (input ?? {}) as Record<string, unknown>, url.searchParams.get("bg") ?? "unset");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(verdict.block ? `block\n${verdict.block}` : verdict.context ? `context\n${verdict.context}` : "ok");
    return;
  }

  if (req.method === "GET" && p === "/api/boards") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ boards: deps.store.list() }));
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

  // Board file import: validate, create a new board with the content.
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
      const session = importBoard(deps.sessions, deps.store, raw);
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
    // No traversal: only flat files from the UI bundle.
    serveFile(res, path.join(uiDir, path.basename(file)));
    return;
  }

  res.writeHead(404);
  res.end("not found");
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
