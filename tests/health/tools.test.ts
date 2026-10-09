// MCP health suite (plan M8): every MCP tool through the full link — SDK Client
// → stdio → relay → /mcp WebSocket → daemon — with two relays (two Claude Code
// sessions). Relay A is the Author; relay B is a reader. The tool list comes
// from the server's own WRITE_TOOLS, READ_TOOLS and OWN_RULE_TOOLS, and the
// first case checks it against tools/list: a new tool with no health case
// fails this suite (and the typecheck, because CASES is a Record of every name).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWN_RULE_TOOLS, READ_TOOLS, WRITE_TOOLS } from "../../src/server/mcp.js";
import { body, call, freePort, head, postHook, tempDir, type ToolResult } from "../integration/daemon-helpers.js";
import { startRelays, type Relay, type Relays } from "./harness.js";

const TOOLS = [...WRITE_TOOLS, ...READ_TOOLS, ...OWN_RULE_TOOLS] as const;
type ToolName = (typeof TOOLS)[number];
const WRITE = new Set<string>(WRITE_TOOLS);
const READ = new Set<string>(READ_TOOLS);

const validateState = new Ajv2020({ strict: false }).compile(
  JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/contract/canvas-state.schema.json", import.meta.url)), "utf8")),
);

let r: Relays;
let A: Relay;
let B: Relay;
/** A project root with a small source file in it. */
let projectRoot: string;

interface Seed {
  n1: string;
  n2: string;
  n3: string;
  e1: string;
  layer: string;
  path: string;
  draft: string;
  notebook: string;
}

interface Ctx {
  board: string;
  name: string;
  ids: Seed;
}

const json = (res: ToolResult) => JSON.parse(body(res));

async function ok(relay: Relay, tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const res = await call(relay.client, tool, args);
  if (res.isError) throw new Error(`${tool} failed: ${body(res)}`);
  return res;
}

/** Relay A creates a board in the temp root and seeds it: nodes (one bound to code), an edge, a layer, a path, a draft, a notebook. */
async function seeded(name: string): Promise<Ctx> {
  const board = json(await ok(A, "boards_create", { name, project_root: projectRoot })).board_id as string;
  const w = async (tool: string, args: Record<string, unknown>) => json(await ok(A, tool, { board_id: board, ...args }));
  const n1 = (await w("canvas_add_node", { label: "n1", kind: "entry", at: [0, 0], ref: "auth.ts:verifyToken" })).ids[0];
  const n2 = (await w("canvas_add_node", { label: "n2", kind: "service", at: [200, 0] })).ids[0];
  const n3 = (await w("canvas_add_node", { label: "n3", kind: "store", at: [400, 0] })).ids[0];
  const e1 = (await w("canvas_add_edge", { from: n1, to: n2 })).ids[0];
  const layer = (await w("layers_create", { node_ids: [n1, n2], title: "l" })).layer_id;
  const p = (await w("paths_create", { layer_id: layer, title: "p", nodes: [n1, n2], refs: ["auth.ts:verifyToken"] })).path_id;
  const draft = (await w("drafts_create", { title: "d", marks: [{ id: n1, role: "changed" }] })).draft_id;
  const notebook = (await w("notebooks_create", { title: "nb", body: `see [[${n1}]]` })).notebook_id;
  return { board, name, ids: { n1, n2, n3, e1, layer, path: p, draft, notebook } };
}

/** Arm pid for inkwire mode: a hook event as hooks/forward.sh sends it (auto mode, backgrounding 0). */
async function arm(relay: Relay): Promise<void> {
  const res = await postHook(r.port, relay.pid, { hook_event_name: "PreToolUse", permission_mode: "auto", session_id: `s-${relay.pid}` });
  expect(res.status).toBe(200);
}

interface Case {
  /** The arguments on a seeded board (write and read tools). */
  args?: (c: Ctx) => Record<string, unknown>;
  /** The shape of a successful result. */
  check?: (res: ToolResult, c: Ctx) => void | Promise<void>;
  /** A tool with its own rules runs its own steps. */
  run?: (c: Ctx) => Promise<void>;
}

const hasKeys = (...keys: string[]) => (res: ToolResult) => {
  const v = json(res);
  for (const k of keys) expect(v, k).toHaveProperty(k);
};

/** The board as Author A reads it after a write: the follow-up check that the write landed. */
const stateOf = async (c: Ctx) => json(await ok(A, "canvas_get_state", { board_id: c.board }));
const layersOf = async (c: Ctx) => json(await ok(A, "layers_list", { board_id: c.board })).layers as { id: string; title: string }[];
/** A read that must fail: the item is gone. */
const gone = async (tool: string, args: Record<string, unknown>) => {
  const res = await call(A.client, tool, args);
  expect(res.isError, `${tool} after delete: ${body(res)}`).toBe(true);
};

const CASES: Record<ToolName, Case> = {
  // ---- write tools: reader B fails naming A, then Author A succeeds ----
  canvas_infer_structure: {
    args: () => ({}),
    // The seeded board has no ink: the heuristic runs and adds nothing.
    check: (res) => expect(json(res)).toMatchObject({ ids: [], nodes_added: 0, edges_added: 0, strokes_consumed: 0 }),
  },
  canvas_add_node: { args: () => ({ label: "z", kind: "service" }), check: (res) => expect(json(res).ids).toHaveLength(1) },
  canvas_update_node: {
    args: (c) => ({ node_id: c.ids.n2, label: "n2b" }),
    check: async (res, c) => {
      expect(json(res).ids).toEqual([c.ids.n2]);
      expect((await stateOf(c)).graph.nodes.find((n: { id: string }) => n.id === c.ids.n2).label).toBe("n2b");
    },
  },
  canvas_add_edge: { args: (c) => ({ from: c.ids.n2, to: c.ids.n3 }), check: (res) => expect(json(res).ids).toHaveLength(1) },
  canvas_update_edge: {
    args: (c) => ({ edge_id: c.ids.e1, label: "calls" }),
    check: async (res, c) => {
      expect(json(res).ids).toEqual([c.ids.e1]);
      expect((await stateOf(c)).graph.edges.find((e: { id: string }) => e.id === c.ids.e1).label).toBe("calls");
    },
  },
  canvas_delete: { args: (c) => ({ id: c.ids.n3 }), check: hasKeys("paths_affected", "drafts_affected", "notebooks_affected") },
  canvas_move: {
    args: (c) => ({ id: c.ids.n1, at: [5, 5] }),
    check: async (res, c) => {
      expect(json(res).ids).toEqual([c.ids.n1]);
      expect((await stateOf(c)).layout.boxes[c.ids.n1].slice(0, 2)).toEqual([5, 5]);
    },
  },
  canvas_bind_code: {
    args: (c) => ({ node_id: c.ids.n2, ref: "auth.ts:verifyToken" }),
    check: (res) => expect(path.basename(json(res).project_root)).toBe(path.basename(projectRoot)),
  },
  canvas_annotate: { args: (c) => ({ target_id: c.ids.n1, text: "a missing case" }), check: hasKeys("notebook_id", "target_id") },
  canvas_set_viewport: { args: () => ({ x: 10, y: 20, zoom: 1.5 }), check: (res) => expect(json(res)).toEqual({ ok: true }) },
  layers_create: { args: (c) => ({ node_ids: [c.ids.n3], title: "l2" }), check: hasKeys("layer_id") },
  layers_update: {
    args: (c) => ({ layer_id: c.ids.layer, title: "l3" }),
    check: async (res, c) => {
      expect(json(res)).toMatchObject({ layer_id: c.ids.layer, members: 2 });
      expect((await layersOf(c)).find((l) => l.id === c.ids.layer)?.title).toBe("l3");
    },
  },
  layers_focus: { args: (c) => ({ layer_id: c.ids.layer }), check: (res) => expect(json(res)).toEqual({ ok: true }) },
  layers_delete: {
    args: (c) => ({ layer_id: c.ids.layer }),
    check: async (res, c) => {
      expect(json(res)).toEqual({ ok: true });
      expect((await layersOf(c)).map((l) => l.id)).not.toContain(c.ids.layer);
    },
  },
  paths_create: { args: (c) => ({ layer_id: c.ids.layer, title: "p2", nodes: [c.ids.n1, c.ids.n2] }), check: hasKeys("path_id") },
  paths_update: {
    args: (c) => ({ path_id: c.ids.path, title: "p3" }),
    check: async (res, c) => {
      expect(json(res)).toEqual({ path_id: c.ids.path, hops: 1 });
      expect(json(await ok(A, "paths_get", { board_id: c.board, path_id: c.ids.path })).title).toBe("p3");
    },
  },
  paths_delete: {
    args: (c) => ({ path_id: c.ids.path }),
    check: async (res, c) => {
      expect(json(res)).toEqual({ ok: true });
      await gone("paths_get", { board_id: c.board, path_id: c.ids.path });
    },
  },
  paths_play: { args: (c) => ({ path_id: c.ids.path }), check: hasKeys("ok") },
  drafts_create: { args: (c) => ({ title: "d2", marks: [{ id: c.ids.n2, role: "removed" }] }), check: hasKeys("draft_id", "marks") },
  drafts_update: { args: (c) => ({ draft_id: c.ids.draft, title: "d3" }), check: hasKeys("draft_id", "marks") },
  drafts_delete: { args: (c) => ({ draft_id: c.ids.draft }), check: (res) => expect(json(res)).toEqual({ ok: true }) },
  drafts_activate: { args: (c) => ({ draft_id: c.ids.draft }), check: (res) => expect(json(res)).toEqual({ ok: true }) },
  notebooks_create: { args: () => ({ title: "nb2", body: "y" }), check: hasKeys("notebook_id") },
  notebooks_update: { args: (c) => ({ notebook_id: c.ids.notebook, append: "more" }), check: hasKeys("notebook_id") },
  notebooks_delete: {
    args: (c) => ({ notebook_id: c.ids.notebook }),
    check: async (res, c) => {
      expect(json(res)).toEqual({ ok: true });
      await gone("notebooks_get", { board_id: c.board, notebook_id: c.ids.notebook });
    },
  },
  notebooks_open: { args: (c) => ({ notebook_id: c.ids.notebook }), check: (res) => expect(json(res)).toEqual({ ok: true }) },
  boards_update: { args: () => ({ name: "renamed" }), check: (res) => expect(json(res).name).toBe("renamed") },
  boards_delete: {
    args: () => ({}),
    check: async (res, c) => {
      expect(json(res)).toEqual({ deleted: true, board_id: c.board });
      const listed = json(await ok(B, "boards_list", { all: true })).boards.map((b: { id: string }) => b.id);
      expect(listed).not.toContain(c.board);
    },
  },

  // ---- read tools: A and reader B both succeed ----
  boards_list: {
    args: () => ({ all: true }),
    check: (res, c) => {
      const entry = json(res).boards.find((b: { id: string }) => b.id === c.board);
      expect(entry).toMatchObject({ name: c.name });
      expect(entry).toHaveProperty("project_root");
    },
  },
  boards_open: {
    args: () => ({}),
    check: (res, c) => {
      const v = json(res);
      expect(v.panel_url).toContain(`http://127.0.0.1:${r.port}/`);
      expect(v.panel_url).toContain(c.board);
      expect(v.state.graph.nodes).toHaveLength(3);
    },
  },
  canvas_get_state: {
    args: () => ({}),
    check: (res) => {
      const state = json(res);
      const valid = validateState(state);
      expect(valid, JSON.stringify(validateState.errors)).toBe(true);
      expect(state.graph.nodes).toHaveLength(3);
    },
  },
  canvas_get_board: { args: () => ({}), check: (res) => expect(json(res).graph.nodes).toHaveLength(3) },
  canvas_screenshot: {
    args: () => ({}),
    check: (res, c) => {
      expect(body(res)).toContain(`board ${c.board}`);
      const image = res.content.find((x) => x.type === "image") as { mimeType?: string; data?: string } | undefined;
      expect(image?.mimeType).toBe("image/png");
      expect(Buffer.from(image!.data!, "base64").subarray(1, 4).toString()).toBe("PNG");
    },
  },
  canvas_export_mermaid: { args: () => ({}), check: (res) => expect(json(res).mermaid).toMatch(/n1/) },
  canvas_lint: {
    args: () => ({}),
    check: (res) => {
      const v = json(res);
      expect(path.basename(v.project_root)).toBe(path.basename(projectRoot));
      expect(v.errors).toBe(0);
      expect(Array.isArray(v.findings)).toBe(true);
    },
  },
  history_get: { args: () => ({}), check: (res) => expect(json(res).steps.length).toBeGreaterThan(0) },
  layers_list: { args: () => ({}), check: (res, c) => expect(json(res).layers.map((l: { id: string }) => l.id)).toEqual([c.ids.layer]) },
  paths_get: {
    args: (c) => ({ path_id: c.ids.path }),
    check: (res) => {
      const hops = json(res).hops;
      // The hop ref resolves against the board's project_root, through the daemon.
      expect(hops).toHaveLength(1);
      expect(hops[0]).toMatchObject({ ref: "auth.ts:verifyToken", ref_status: "ok", line: 1, end: 3 });
    },
  },
  drafts_get: { args: (c) => ({ draft_id: c.ids.draft }), check: (res, c) => expect(json(res)).toMatchObject({ draft_id: c.ids.draft, title: "d" }) },
  notebooks_get: {
    args: (c) => ({ notebook_id: c.ids.notebook }),
    check: (res, c) => {
      const v = json(res);
      expect(v.notebook_id).toBe(c.ids.notebook);
      expect(v.body).toContain("n1");
    },
  },

  // ---- tools with their own rules ----
  boards_create: {
    run: async () => {
      const res = await ok(A, "boards_create", { name: "health create", project_root: projectRoot });
      const v = json(res);
      expect(head(res)).toMatch(new RegExp(`^board ${v.board_id} "health create" · you: author · mode: pty`));
      expect(v.panel_url).toContain(`http://127.0.0.1:${r.port}/`);
      // A relative or missing root fails.
      const bad = await call(A.client, "boards_create", { name: "no root", project_root: "relative/dir" });
      expect(bad.isError).toBe(true);
    },
  },
  boards_import: {
    run: async (c) => {
      // The board file comes from the daemon's export route, as the panel downloads it.
      const res = await fetch(`http://127.0.0.1:${r.port}/api/boards/${c.board}/export`);
      expect(res.status).toBe(200);
      const file = path.join(tempDir("health-import"), "board.inkwire.json");
      writeFileSync(file, await res.text());
      const imported = await ok(A, "boards_import", { path: file, project_root: projectRoot });
      const v = json(imported);
      expect(v.nodes).toBe(3);
      expect(v.edges).toBe(1);
      expect(head(imported)).toMatch(new RegExp(`^board ${v.board_id} ".*" · you: author`));
    },
  },
  boards_clone: {
    run: async (c) => {
      // A reader can clone a board it can read; the clone is its own.
      const cloned = await ok(B, "boards_clone", { board_id: c.board });
      const v = json(cloned);
      expect(v.source).toBe(c.board);
      expect(v.name).toBe(`${c.name} copy`);
      expect(head(cloned)).toMatch(new RegExp(`^board ${v.board_id} ".*" · you: author`));
      const state = json(await ok(B, "canvas_get_state", { board_id: v.board_id }));
      expect(state.graph.nodes).toHaveLength(3);
      await ok(B, "boards_release");
    },
  },
  boards_release: {
    run: async (c) => {
      const refused = await call(B.client, "boards_release", { board_id: c.board });
      expect(refused.isError).toBe(true);
      expect(body(refused)).toContain(`you are not the author of ${c.board}`);
      expect(json(await ok(A, "boards_release"))).toEqual({ released: c.board });
      // The board is free: B's write claims it.
      const write = await ok(B, "canvas_add_node", { board_id: c.board, label: "from b", kind: "service" });
      expect(head(write)).toMatch(new RegExp(`^board ${c.board} ".*" · you: author`));
      await ok(B, "boards_release");
    },
  },
  session_mode: {
    run: async (c) => {
      await arm(A);
      await arm(B);
      try {
        const on = await ok(A, "session_mode", { on: true });
        expect(json(on)).toMatchObject({ mode: "inkwire", hook: "Stop" });
        expect(head(on)).toContain("mode: inkwire");
        // While A talks, the Stop hook is blocked.
        const stop = await postHook(r.port, A.pid, { hook_event_name: "Stop", permission_mode: "auto", session_id: `s-${A.pid}` });
        expect(stop.body.startsWith("block\n")).toBe(true);
        // A reader cannot turn the mode on for the board: it names the Author.
        await ok(B, "boards_open", { board_id: c.board });
        const refused = await call(B.client, "session_mode", { on: true });
        expect(refused.isError).toBe(true);
        expect(body(refused)).toContain(`pid ${A.pid}`);
      } finally {
        const off = await ok(A, "session_mode", { on: false });
        expect(json(off)).toMatchObject({ mode: "pty" });
      }
      // Open question 1: on a board with no Author, mode on claims it.
      await ok(A, "boards_release");
      try {
        const claimed = await ok(B, "session_mode", { on: true });
        expect(json(claimed)).toMatchObject({ mode: "inkwire" });
        expect(head(claimed)).toMatch(new RegExp(`^board ${c.board} ".*" · you: author · mode: inkwire`));
      } finally {
        await ok(B, "session_mode", { on: false });
        await ok(B, "boards_release");
      }
    },
  },
  session_send: {
    run: async (c) => {
      // A write with claim: false: reader B is refused with the Author message, and nothing pends.
      const refused = await call(B.client, "session_send", { board_id: c.board, text: "x" });
      expect(refused.isError, `reader B: ${body(refused)}`).toBe(true);
      expect(body(refused)).toContain(`pid ${A.pid}`);
      expect(body(refused)).toContain("release it in the panel");
      await arm(A);
      const panel = await r.panel(c.board);
      try {
        await ok(A, "session_mode", { on: true });
        const sending = call(A.client, "session_send", { text: "which store?", highlight: { nodes: [c.ids.n1], edges: [], label: "this one" } });
        // The panel sees the Author's pending send, then the person replies.
        await panel.waitFor((m) => m.type === "state" && m.session.author?.pid === A.pid && m.session.author.pending === true);
        panel.send({ type: "session_reply", text: "the cache", focus: null, selection: c.ids.n2, trace: null, draft: null, notebook: null });
        const res = await sending;
        expect(res.isError, body(res)).toBeFalsy();
        expect(json(res)).toMatchObject({ status: "reply", reply: "the cache" });
      } finally {
        await ok(A, "session_mode", { on: false });
        panel.close();
      }
    },
  },
};

beforeAll(async () => {
  projectRoot = tempDir("health-root");
  writeFileSync(path.join(projectRoot, "auth.ts"), "export function verifyToken(token: string) {\n  return token.length > 0;\n}\n");
  r = await startRelays(2, { port: await freePort(), dataDir: tempDir("health-tools"), graceMs: 300 });
  [A, B] = r.relays as [Relay, Relay];
}, 30_000);

afterAll(async () => {
  // beforeAll failed: its error is the one result; nothing more to report here.
  if (!r) return;
  // The idle grace (300 ms) stops the daemon after the last relay closes; stop() kills it if not.
  const clean = await r.stop();
  expect(clean).toBe(true);
}, 15_000);

describe("health: the link", () => {
  it("two relays are two Clients of one daemon", async () => {
    expect(A.pid).not.toBe(B.pid);
    const h = await r.health();
    expect(h).toMatchObject({ ok: true, name: "inkwire", pid: r.daemonPid, clients: 2 });
  });

  it("every tool that tools/list returns has a health case, and every case is a listed tool", async () => {
    const listed = (await A.client.listTools()).tools.map((t) => t.name);
    const listedB = (await B.client.listTools()).tools.map((t) => t.name);
    expect(listedB.sort()).toEqual([...listed].sort());
    expect(listed.filter((t) => !(t in CASES)), "tools with no health case").toEqual([]);
    expect(Object.keys(CASES).filter((t) => !listed.includes(t)), "health cases with no tool").toEqual([]);
    expect(new Set(TOOLS).size).toBe(TOOLS.length);
  });
});

describe("health: every MCP tool", () => {
  for (const tool of TOOLS) {
    it(`tool: ${tool}`, async () => {
      const k = CASES[tool];
      const c = await seeded(`health ${tool}`);
      if (k.run) {
        await k.run(c);
      } else if (WRITE.has(tool)) {
        const args = { board_id: c.board, ...k.args!(c) };
        const refused = await call(B.client, tool, args);
        expect(refused.isError, `reader B: ${body(refused)}`).toBe(true);
        expect(body(refused)).toContain(`pid ${A.pid}`);
        expect(body(refused)).toContain("release it in the panel");
        const res = await call(A.client, tool, args);
        expect(res.isError, body(res)).toBeFalsy();
        if (tool !== "boards_delete") expect(head(res)).toMatch(new RegExp(`^board ${c.board} ".*" · you: author`));
        await k.check?.(res, c);
      } else if (READ.has(tool)) {
        const args = { board_id: c.board, ...k.args!(c) };
        // The context line names the Client's current board: B opens A's board (a read) so
        // that line is about this board. B reads first; A is still the Author after it,
        // so a read never claims (ADR 0002).
        await ok(B, "boards_open", { board_id: c.board });
        for (const [who, relay, role] of [["B", B, "reader"], ["A", A, "author"]] as const) {
          const res = await call(relay.client, tool, args);
          expect(res.isError, `${who}: ${body(res)}`).toBeFalsy();
          expect(head(res), `${who} context line`).toMatch(new RegExp(`^board ${c.board} ".*" · you: ${role}`));
          await k.check?.(res, c);
        }
      } else {
        throw new Error(`${tool} has its own rules but no run step`);
      }
      // No stray stdout line and no lost response on either relay.
      expect([...A.errors, ...B.errors].map((e) => e.message)).toEqual([]);
    }, 20_000);
  }
});
