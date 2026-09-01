// MCP tool surface (SPEC § 9, schema/tools.json). Tool-driven mutations are
// recorded with author "ai" — the server assigns authorship, never a tool
// argument. Wire names use underscores (MCP tool-name charset); the dotted
// names from the spec appear in descriptions.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exportMermaid } from "../core/mermaid.js";
import { toolArgs } from "../shared/schemas.js";
import type { Sessions } from "./session.js";
import type { Screenshots } from "./screenshot.js";
import * as mutations from "./mutations.js";
import { validateRef } from "./bindcode.js";
import type { Store } from "./store.js";

export interface McpDeps {
  sessions: Sessions;
  store: Store;
  screenshots: () => Screenshots;
  projectRoot: string;
  panelUrl: (boardId: string) => string;
}

const AUTHOR = "ai" as const;

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "inkwire", version: "0.1.0" });
  const { sessions } = deps;

  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });

  // The zod shapes vary per tool; the SDK's generics fight a generic shim,
  // so the registration goes through one deliberately untyped seam. Each
  // handler below is still typed on its own args.
  const register = (
    name: keyof typeof toolArgs,
    description: string,
    handler: (args: any) => Promise<unknown> | unknown,
  ) => {
    server.registerTool(
      name.replace(/\./g, "_"),
      { description, inputSchema: toolArgs[name].shape as any },
      (async (args: any) => {
        try {
          const result = await handler(args);
          return result ?? text({ ok: true });
        } catch (err) {
          return {
            content: [
              { type: "text" as const, text: `error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      }) as any,
    );
  };

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

  register("boards.create", "Create an empty board and make it current.", (args: { name: string }) => {
    const session = sessions.create(args.name);
    sessions.currentBoardId = session.boardId;
    return text({ board_id: session.boardId, panel_url: deps.panelUrl(session.boardId) });
  });

  register(
    "canvas.get_state",
    "The board as data: graph (nodes, edges, code bindings), layout in its own field, unresolved ink, images, history summary, viewport. Check graph.revision against what you last read — if only layout.revision moved, the human just tidied the board and the meaning is unchanged.",
    (args: { board_id?: string; include_ink_geometry?: boolean; include_layout?: boolean }) => {
      const session = sessions.resolve(args.board_id);
      return text(
        session.state({
          includeInkGeometry: args.include_ink_geometry,
          includeLayout: args.include_layout,
        }),
      );
    },
  );

  register(
    "canvas.screenshot",
    "PNG of the board as the human sees it. Use this to read handwriting, judge spatial intent, or check what an ambiguous stroke actually looks like. Structure comes from get_state; pixels come from here.",
    async (args: { board_id?: string; viewport?: { x: number; y: number; zoom: number }; fit?: boolean }) => {
      const session = sessions.resolve(args.board_id);
      const shot = await deps.screenshots().capture(session, args.viewport, args.fit ?? false);
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
    "Remove an element by id. Deleting a node also removes its edges — the result reports every id that went.",
    (args: { board_id?: string; id: string }) => {
      const session = sessions.resolve(args.board_id);
      return text(mutations.deleteElement(session, AUTHOR, args.id));
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
    "Attach a source location or endpoint to a node. The ref is resolved against the project root and the call fails if the file does not exist; a missing symbol is a warning, not a failure.",
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
      return text({ ...result, ...bind });
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

  return server;
}
