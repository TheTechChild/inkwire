// MCP tool surface (SPEC § 9). Tool-driven mutations are
// recorded with author "ai" — the server assigns authorship, never a tool
// argument. Wire names use underscores (MCP tool-name charset); the dotted
// names from the spec appear in descriptions.
import { readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathsAffected, scopeState } from "../core/layers.js";
import { draftsAffectedBy } from "../core/drafts.js";
import { exportMermaid } from "../core/mermaid.js";
import { toolArgs } from "../shared/schemas.js";
import { importBoard } from "./board-file.js";
import type { Sessions } from "./session.js";
import type { Screenshots } from "./screenshot.js";
import * as mutations from "./mutations.js";
import { validateRef } from "./bindcode.js";
import { lintBoard } from "./lint.js";
import { createLayer, createPath, deleteLayer, deletePath, getPath, memberCount, openTrace, updateLayer, updatePath } from "./layers.js";
import { createDraft, deleteDraft, getDraft, updateDraft } from "./drafts.js";
import { sessionMode, sessionSend } from "./session-mode.js";
import type { Store } from "./store.js";

export interface McpDeps {
  sessions: Sessions;
  store: Store;
  screenshots: () => Screenshots;
  projectRoot: string;
  panelUrl: (boardId: string) => string;
  /** Repo root, for the plugin relaunch hint. */
  pluginRoot?: string;
  focusTerminal?: () => void;
}

const AUTHOR = "ai" as const;

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "inkwire", version: "0.1.0" });
  const { sessions } = deps;

  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });

  // Every call lands in the current board's thread as a folded "call" row.
  // Caption: the mutation labels the call produced, else its arguments.
  // session_send writes its own message and session_mode its own row.
  const SELF_RECORDING = new Set<string>(["session.send", "session.mode"]);
  const BIG_RESULTS = new Set<string>(["canvas.get_state", "canvas.get_board", "canvas.screenshot", "boards.open"]);
  const current = () => (sessions.currentBoardId ? sessions.open(sessions.currentBoardId) : null);
  const recordCall = (name: string, args: Record<string, unknown>, s0: ReturnType<typeof current>, seq0: number, result: any) => {
    const s1 = current();
    if (!s1 || s1.closed) return;
    const labels = s1 === s0 ? s1.log.filter((l) => l.seq > seq0).map((l) => l.text) : [];
    const summary = Object.entries(args ?? {})
      .filter(([k, v]) => v !== undefined && k !== "board_id")
      .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 48)}`)
      .join(" · ");
    const body: string = result?.content?.find((c: any) => c.type === "text")?.text ?? "";
    const json = BIG_RESULTS.has(name) && !result?.isError ? undefined : body.slice(0, 600);
    s1.addThread({
      type: "call",
      name: name.replace(/\./g, "_"),
      text: labels.join(" · ") || summary || "no arguments",
      ...(json ? { json } : {}),
    });
  };

  // The zod shapes vary per tool; the SDK's generics fight a generic shim,
  // so the registration goes through one deliberately untyped seam. Each
  // handler below is still typed on its own args.
  const register = (
    name: keyof typeof toolArgs,
    description: string,
    handler: (args: any, extra: any) => Promise<unknown> | unknown,
  ) => {
    server.registerTool(
      name.replace(/\./g, "_"),
      { description, inputSchema: toolArgs[name].shape as any },
      (async (args: any, extra: any) => {
        const s0 = current();
        const seq0 = s0?.logSeq ?? 0;
        let result: any;
        try {
          result = (await handler(args, extra)) ?? text({ ok: true });
        } catch (err) {
          result = {
            content: [
              { type: "text" as const, text: `error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
        if (!SELF_RECORDING.has(name)) recordCall(name, args, s0, seq0, result);
        return result;
      }) as any,
    );
  };

  register(
    "session.mode",
    "Flip the mode flag the server holds. On: fails unless permission mode is auto; arms the Stop hook that redirects replies into session_send. Off: releases any pending session_send with mode_off.",
    (args: { on: boolean }) =>
      text(sessionMode(sessions, args.on, { pluginRoot: deps.pluginRoot, focusTerminal: deps.focusTerminal })),
  );

  register(
    "session.send",
    "Deliver a reply to the Session tab, optionally pointing at elements, at a path (or a hop on it), or at a draft. Blocks until the human replies (20 min timeout) and returns their message with focus, selection, scrubber position, active draft and revision as ids.",
    async (
      args: {
        board_id?: string;
        text: string;
        highlight?: { nodes: string[]; edges: string[]; label: string };
        path?: { layer_id: string; path_id: string; hop?: number };
        draft?: string;
      },
      extra: any,
    ) => {
      const session = sessions.resolve(args.board_id);
      // Progress keeps Claude Code's idle timer from cutting the wait short.
      const token = extra?._meta?.progressToken;
      let ticks = 0;
      const tick = token !== undefined
        ? setInterval(() => {
            void extra.sendNotification?.({
              method: "notifications/progress",
              params: { progressToken: token, progress: ++ticks, message: "waiting on the human in the inkwire panel" },
            });
          }, 30_000)
        : null;
      try {
        return text(await sessionSend(sessions, session, args, extra?.signal));
      } finally {
        if (tick) clearInterval(tick);
      }
    },
  );

  register("boards.list", "List boards on this server: id, name, node and edge counts, last touched. Call this first in a session.", () =>
    text({ boards: deps.store.list() }),
  );

  register(
    "boards.open",
    "Make a board current for this session and return its state. Starts a fresh in-memory history with the stored board as step 0, and resets the revision counters — do not cache revisions across opens. The result names the local panel URL for the human.",
    (args: { board_id: string }) => {
      const session = sessions.open(args.board_id);
      sessions.currentBoardId = session.boardId;
      return text({ panel_url: deps.panelUrl(session.boardId), state: session.state() });
    },
  );

  register(
    "boards.delete",
    "Delete a board permanently: its row leaves the database, open panels are disconnected, and the current-board pointer is cleared if it pointed here. Fails if the id does not exist.",
    (args: { board_id: string }) => {
      if (!sessions.delete(args.board_id)) throw new Error(`board not found: ${args.board_id}`);
      return text({ deleted: true, board_id: args.board_id });
    },
  );

  register("boards.create", "Create an empty board and make it current.", (args: { name: string }) => {
    const session = sessions.create(args.name);
    sessions.currentBoardId = session.boardId;
    return text({ board_id: session.boardId, panel_url: deps.panelUrl(session.boardId) });
  });

  register(
    "boards.import",
    `Load a downloaded inkwire board file (…​.inkwire.json) from disk into a new board and make it current. path is resolved against the project root (${deps.projectRoot}) when relative, or given absolute. The result names the local panel URL for the human to open in the browser.`,
    (args: { path: string }) => {
      const file = path.isAbsolute(args.path) ? args.path : path.join(deps.projectRoot, args.path);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        throw new Error(`cannot read board file at ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const session = importBoard(sessions, deps.store, raw);
      session.persistNow();
      sessions.currentBoardId = session.boardId;
      const c = session.collections();
      return text({
        board_id: session.boardId,
        panel_url: deps.panelUrl(session.boardId),
        name: session.meta.name,
        nodes: c.nodes.length,
        edges: c.edges.length,
        strokes: c.strokes.length,
        images: c.images.length,
      });
    },
  );

  register(
    "canvas.get_state",
    "What the human is looking at right now. While a layer is focused this returns only that layer — members, internal edges, and the seams: boundary_edges marked out_of_scope with crosses_to, and boundary_nodes as stubs — and scope.omitted says what it left out. For the whole board regardless of focus call canvas_get_board. graph.revision / layout.revision are board-level and never move on a focus change.",
    (args: { board_id?: string; include_ink_geometry?: boolean; include_layout?: boolean }) => {
      const session = sessions.resolve(args.board_id);
      const state = session.state({
        includeInkGeometry: args.include_ink_geometry,
        includeLayout: args.include_layout,
      });
      const layer = session.focusedLayer();
      return text(layer ? scopeState(state, layer) : state);
    },
  );

  register(
    "canvas.get_board",
    "The whole board regardless of focus, plus layers[] and focus so you know what the human is looking at. Use when a scoped read is not enough.",
    (args: { board_id?: string; include_layout?: boolean }) => {
      const session = sessions.resolve(args.board_id);
      return text(session.state({ includeLayout: args.include_layout }));
    },
  );

  register(
    "canvas.screenshot",
    "PNG of the board as the human sees it. Use this to read handwriting, judge spatial intent, or check what an ambiguous stroke actually looks like. Structure comes from get_state; pixels come from here.",
    async (args: { board_id?: string; viewport?: { x: number; y: number; zoom: number }; fit?: boolean }) => {
      const session = sessions.resolve(args.board_id);
      const shot = await deps.screenshots().capture(session, args.viewport, args.fit ?? false);
      if (session.closed) throw new Error(`board deleted during capture: ${session.boardId}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `board ${session.boardId} · zoom ${shot.viewport.zoom} · source: ${shot.source}`,
          },
          { type: "image" as const, data: shot.png.toString("base64"), mimeType: "image/png" },
        ],
      };
    },
  );

  register(
    "canvas.infer_structure",
    'Run the built-in geometric heuristic over unresolved ink: closed strokes become nodes, open strokes become edges snapped to nearby nodes. Nodes come out labelled "untitled" — read a screenshot and rename them with canvas_update_node. Consumed strokes are deleted; created elements carry from_ink provenance.',
    (args: { board_id?: string; stroke_ids?: string[] }) => {
      const session = sessions.resolve(args.board_id);
      return text(mutations.inferFromInk(session, AUTHOR, args.stroke_ids));
    },
  );

  register("canvas.add_node", "Place a node on the board.", (args: Parameters<typeof mutations.addNode>[2] & { board_id?: string }) => {
    const session = sessions.resolve(args.board_id);
    return text(mutations.addNode(session, AUTHOR, args));
  });

  register(
    "canvas.update_node",
    "Change a node's label, kind, or bindings. Omitted fields are left alone.",
    (args: Parameters<typeof mutations.updateNode>[2] & { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(mutations.updateNode(session, AUTHOR, args));
    },
  );

  register(
    "canvas.add_edge",
    "Connect two nodes. label is the short name of the transition, schema is the payload type crossing it, condition is the branch predicate. Fails if either endpoint does not exist.",
    (args: Parameters<typeof mutations.addEdge>[2] & { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(mutations.addEdge(session, AUTHOR, args));
    },
  );

  register(
    "canvas.update_edge",
    "Change an edge's label, schema, kind, or condition.",
    (args: Parameters<typeof mutations.updateEdge>[2] & { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(mutations.updateEdge(session, AUTHOR, args));
    },
  );

  register(
    "canvas.delete",
    "Remove an element by id. Deleting a node also removes its edges — the result reports every id that went, paths_affected names the paths whose walk it broke, and drafts_affected names the draft marks it left gone.",
    (args: { board_id?: string; id: string }) => {
      const session = sessions.resolve(args.board_id);
      const before = new Set(pathsAffected(session.layers, session.collections().edges).map((b) => `${b.path_id}:${b.hop}`));
      const result = mutations.deleteElement(session, AUTHOR, args.id);
      const paths_affected = pathsAffected(session.layers, session.collections().edges).filter((b) => !before.has(`${b.path_id}:${b.hop}`));
      const drafts_affected = draftsAffectedBy(session.drafts, result.ids);
      return text({ ...result, paths_affected, drafts_affected });
    },
  );

  register(
    "canvas.move",
    "Set an element's position and size. Bumps layout.revision only — a move is not a change of meaning.",
    (args: { board_id?: string; id: string; at: [number, number]; size?: [number, number] }) => {
      const session = sessions.resolve(args.board_id);
      return text(mutations.moveElement(session, AUTHOR, args));
    },
  );

  register(
    "canvas.bind_code",
    `Attach a source location or endpoint to a node. Refs are resolved against the project root (${deps.projectRoot}); write them relative to it as path/to/file.ts, path/to/file.ts:symbol, or path/to/file.ts#symbol. The call fails if the file does not exist; a missing symbol is a warning, not a failure.`,
    (args: { board_id?: string; node_id: string; ref?: string; endpoint?: string }) => {
      const session = sessions.resolve(args.board_id);
      let bind = { resolved_path: null as string | null, symbol_found: null as boolean | null };
      if (args.ref) {
        const r = validateRef(deps.projectRoot, args.ref);
        bind = { resolved_path: r.resolved_path, symbol_found: r.symbol_found };
      }
      const result = mutations.updateNode(session, AUTHOR, {
        node_id: args.node_id,
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
        ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),
      });
      return text({ ...result, ...bind, project_root: deps.projectRoot });
    },
  );

  register(
    "canvas.annotate",
    "Pin a comment to an element. For observations that belong on the board rather than in the transcript — a missing case, an unhandled error path.",
    (args: { board_id?: string; target_id: string; text: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(mutations.annotate(session, AUTHOR, args));
    },
  );

  register(
    "canvas.set_viewport",
    "Pan and zoom the human's view. Use it to direct attention to what you are talking about, sparingly — it moves someone else's screen.",
    (args: { board_id?: string; x: number; y: number; zoom: number }) => {
      const session = sessions.resolve(args.board_id);
      session.setViewport({ x: args.x, y: args.y, zoom: args.zoom });
      session.addLog(AUTHOR, `set_viewport · zoom ${args.zoom}`);
      return text({ ok: true });
    },
  );

  register(
    "canvas.export_mermaid",
    "Serialize the graph as Mermaid flowchart text, for quoting the diagram in the conversation.",
    (args: { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      const c = session.collections();
      return text({ mermaid: exportMermaid(c.nodes, c.edges) });
    },
  );

  register(
    "canvas.lint",
    `Static checks against the project root (${deps.projectRoot}), no model: refs to missing files (error), refs whose symbol is gone (warn), nodes with neither ref nor endpoint (warn), error edges with no condition (warn), conditions on a node with a single outgoing edge (warn), paths with a broken hop or a hop ref that no longer resolves, drafts marking an element that no longer exists (warn). Run after a refactor to find board rot. For a semantic audit — does the edge really call what it says — read get_state and check the code yourself.`,
    (args: { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      const c = session.collections();
      const findings = lintBoard(deps.projectRoot, c.nodes, c.edges, session.layers, session.drafts);
      return text({
        project_root: deps.projectRoot,
        errors: findings.filter((f) => f.level === "error").length,
        warnings: findings.filter((f) => f.level === "warn").length,
        findings,
      });
    },
  );

  register(
    "history.get",
    "Read the timeline: every step with its label, author, skipped flag, and conflict flag. Read-only by design — rewind, skip, and drop belong to the human.",
    (args: { board_id?: string; limit?: number }) => {
      const session = sessions.resolve(args.board_id);
      return text({
        head: session.history.head,
        steps: session.historyRows(args.limit).map(({ ahead, index, ...row }) => ({ index, ...row })),
      });
    },
  );

  register(
    "layers.list",
    "Every layer with its letter, title, member count, paths — and which one the human is looking at.",
    (args: { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      return text({
        focus: session.focus,
        layers: session.layers.map((l) => ({
          id: l.id,
          letter: l.letter,
          title: l.title,
          members: memberCount(session, l),
          paths: l.paths.map((p) => ({ id: p.id, title: p.title, hops: p.steps.length })),
        })),
      });
    },
  );

  register(
    "layers.create",
    "Cut a named subset out of the board. node_ids are the members (notes are nodes; ink and images cannot be members); downstream: true also adds everything reachable from them along edges. Letters auto-assign A–Z; titles cap at 24 chars. Does not change focus.",
    (args: Parameters<typeof createLayer>[2] & { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(createLayer(session, AUTHOR, args));
    },
  );

  register(
    "layers.update",
    "Add or remove members, retitle, or rewrite the note. Elements themselves are untouched.",
    (args: Parameters<typeof updateLayer>[2] & { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(updateLayer(session, AUTHOR, args));
    },
  );

  register(
    "layers.focus",
    "Focus a layer in the human's viewport, or pass null to release. Use sparingly — it moves someone else's screen.",
    (args: { board_id?: string; layer_id: string | null }) => {
      const session = sessions.resolve(args.board_id);
      session.setFocus(args.layer_id, AUTHOR);
      return text({ ok: true });
    },
  );

  register(
    "layers.delete",
    "Remove a layer. A layer is a view over the board, so nothing on the board is deleted.",
    (args: { board_id?: string; layer_id: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(deleteLayer(session, AUTHOR, args));
    },
  );

  // Step refs are validated like bind_code: a missing file fails, a missing symbol warns.
  const refWarnings = (steps: { ref?: string | null }[] | undefined): string[] =>
    (steps ?? []).flatMap((s, i) =>
      s.ref && validateRef(deps.projectRoot, s.ref).symbol_found === false ? [`hop ${i + 1}: symbol not found in ${s.ref}`] : [],
    );
  const withWarnings = <T extends object>(result: T, warnings: string[]) => text(warnings.length ? { ...result, warnings } : result);

  register(
    "paths.create",
    "Write an ordered walk on a layer: one hop per edge, each hop's `to` is the next hop's `from`, every edge inside the layer. Pass nodes and the server resolves the edges, naming both when a pair is joined twice. A caption per hop is what the human reads while it plays; a ref per hop is its citation. Fails naming the first hop that breaks the chain.",
    (args: Parameters<typeof createPath>[2] & { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      const warnings = refWarnings(args.steps ?? args.refs?.map((ref) => ({ ref })));
      return withWarnings(createPath(session, AUTHOR, args), warnings);
    },
  );

  register(
    "paths.update",
    "Retitle, or replace the steps whole. Steps are set as a list, never patched by index.",
    (args: Parameters<typeof updatePath>[2] & { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      const warnings = refWarnings(args.steps);
      return withWarnings(updatePath(session, AUTHOR, args), warnings);
    },
  );

  register("paths.delete", "Remove a path. The layer and the board are untouched.", (args: { board_id?: string; path_id: string }) => {
    const session = sessions.resolve(args.board_id);
    return text(deletePath(session, AUTHOR, args));
  });

  register(
    "paths.get",
    "One path with its hops resolved: node labels, refs, edge labels, captions. Small — use it to answer about a hop instead of reading the board.",
    (args: { board_id?: string; path_id: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(getPath(session, args));
    },
  );

  register(
    "paths.play",
    "Open the scrubber on a path in the human's panel: play it once, or pause at a hop. Moves someone else's screen — use when the reply is about the order.",
    (args: { board_id?: string; path_id: string; hop?: number }) => {
      const session = sessions.resolve(args.board_id);
      openTrace(session, args.path_id, { t: args.hop, running: args.hop === undefined });
      session.addLog(AUTHOR, `paths_play · ${args.path_id}`);
      return text({ ok: true });
    },
  );

  register(
    "drafts.create",
    "Propose a change: a title, a note saying what and why, and marks — element ids with one of removed, changed, added. A draft changes nothing on the board; it says what would. Marks are explicit: mark the edges you mean, the server infers none.",
    (args: Parameters<typeof createDraft>[2] & { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(createDraft(session, AUTHOR, args));
    },
  );

  register(
    "drafts.update",
    "Retitle, rewrite the note, mark or unmark elements. Marking again replaces the role.",
    (args: Parameters<typeof updateDraft>[2] & { board_id?: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(updateDraft(session, AUTHOR, args));
    },
  );

  register(
    "drafts.delete",
    "Remove a draft. The board is untouched.",
    (args: { board_id?: string; draft_id: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(deleteDraft(session, AUTHOR, args));
    },
  );

  register(
    "drafts.get",
    "One draft with its marks resolved to labels. Small — use it to answer about a mark instead of reading the board.",
    (args: { board_id?: string; draft_id: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(getDraft(session, args));
    },
  );

  register(
    "drafts.activate",
    "Show a draft on the human's canvas, or pass null to clear. Shared by every panel; it changes what someone else is looking at.",
    (args: { board_id?: string; draft_id: string | null }) => {
      const session = sessions.resolve(args.board_id);
      session.setActiveDraft(args.draft_id, AUTHOR);
      return text({ ok: true });
    },
  );

  return server;
}
