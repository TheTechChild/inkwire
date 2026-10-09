// The relay between Claude Code (downstream, stdio) and the daemon (upstream,
// the link), with reconnect (ADR 0001, plan M4.7). Reconnect lives only here:
// send the hello again, replay the cached initialize with a string id and hide
// its response, answer in-flight calls with -32000, queue the calls of the gap,
// and keep the current board from the context line of each tool result.
// Both ends are SDK Transports, so tests use InMemoryTransport.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { LINK_CLOSE } from "./hello.js";

export interface Upstream {
  transport: Transport;
  /** The daemon's build id (from /healthz), to see a restart to a new build. */
  buildId?: string;
  /** The close code and reason of the link, once it closed (WsTransport has both). */
  link?: { readonly closeCode: number | null; readonly closeReason: string };
}

/** Connect one upstream link. A reconnect passes the kept current board for the hello. */
export type UpstreamFactory = (extra: { current_board?: string }) => Promise<Upstream>;

export interface RelayCoreOptions {
  /** The first reconnect delay. Default 250 ms; it doubles to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** After this long with no daemon, new requests get the error at once. Default 60 s. */
  giveUpMs?: number;
  /** The most requests the gap queue holds. Default 100. */
  queueMax?: number;
  /** The first connect retries a failure that is not fatal for this long. Default 10 s (the autostart limit). */
  firstConnectMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * A state that no retry can fix: a link closed with 4426 or 4400, or a fatal
   * DaemonUnavailable (an old inkwire server or another process on the port).
   * The relay has stopped; relay.ts exits 1.
   */
  onFatal?: (reason: string) => void;
}

/** A connect error that no retry can fix (DaemonUnavailable.fatal, src/link/autostart.ts). */
const isFatal = (err: unknown): boolean => (err as { fatal?: unknown } | null)?.fatal === true;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Link close codes that no retry can fix: the same hello gets the same answer. */
const FATAL_CLOSE = new Set<number>([LINK_CLOSE.version, LINK_CLOSE.badHello]);

/** Open question 11, answered. */
export const LOST_TEXT =
  "inkwire daemon connection lost; board authorship and any pending session_send were released. Your current board is kept. Retry the call.";
export const GAP_TEXT = "inkwire daemon is not reachable; the relay tries to connect again. Retry the call later.";
export const REINIT_PREFIX = "inkwire-relay-reinit-";
export const LINK_LOST_CODE = -32000;

type Id = string | number;
type Msg = JSONRPCMessage & { id?: Id; method?: string; result?: unknown; error?: unknown };

const isRequest = (m: Msg) => typeof m.method === "string" && m.id !== undefined;
const isNotification = (m: Msg) => typeof m.method === "string" && m.id === undefined;

const BOARD_LINE = /^board (b_[0-9a-f]+) /;

export class RelayCore {
  private up: Transport | null = null;
  private ready = false;
  private stopped = false;
  private connects = 0;
  private reinits = 0;
  private reinitId: string | null = null;
  private listChangedAfterReinit = false;
  private initReq: Msg | null = null;
  private initNote: Msg | null = null;
  private initForwarded = false;
  /** Forwarded requests with no response yet: id → method. */
  private inflight = new Map<Id, string>();
  private queue: Msg[] = [];
  private lostSince: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private backoff: number;
  private lastBuildId: string | undefined;
  /** The board of the last context line (M3.5); sent as current_board after a reconnect. */
  currentBoard: string | null = null;

  private readonly opts: Required<Omit<RelayCoreOptions, "now" | "log" | "onFatal">>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly onFatal: (reason: string) => void;
  private upLink: Upstream["link"] | undefined;

  constructor(
    private down: Transport,
    private connect: UpstreamFactory,
    opts: RelayCoreOptions = {},
  ) {
    this.opts = {
      backoffMs: opts.backoffMs ?? 250,
      maxBackoffMs: opts.maxBackoffMs ?? 5000,
      giveUpMs: opts.giveUpMs ?? 60_000,
      queueMax: opts.queueMax ?? 100,
      firstConnectMs: opts.firstConnectMs ?? 10_000,
    };
    this.backoff = this.opts.backoffMs;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.onFatal = opts.onFatal ?? (() => {});
  }

  /**
   * Start downstream, then connect the first upstream. A failure that is not
   * fatal is tried again with the backoff for up to firstConnectMs: a daemon
   * that stops (idle, restart) between the probe and the connect is replaced on
   * the next try. Throws on a fatal error or after the limit.
   */
  async start(): Promise<void> {
    this.down.onmessage = (m) => this.fromDown(m as Msg);
    this.down.onclose = () => void this.stop();
    this.down.onerror = (err) => this.log(`inkwire relay: downstream error: ${err.message}`);
    await this.down.start();
    const deadline = this.now() + this.opts.firstConnectMs;
    for (;;) {
      try {
        await this.attach();
        return;
      } catch (err) {
        if (this.stopped) return;
        if (isFatal(err) || this.now() >= deadline) {
          await this.stop();
          throw err;
        }
        this.log(`inkwire relay: connect failed: ${messageOf(err)}; the relay tries again`);
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
        await new Promise((r) => setTimeout(r, delay));
        if (this.stopped) return;
      }
    }
  }

  /** Downstream closed (Claude Code went away): close upstream at once, and stop reconnecting. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const up = this.up;
    this.up = null;
    this.ready = false;
    if (up) {
      try {
        await up.close();
      } catch {
        // already gone
      }
    }
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private async attach(): Promise<void> {
    const reconnect = this.connects > 0;
    const extra = reconnect && this.currentBoard ? { current_board: this.currentBoard } : {};
    const { transport, buildId, link } = await this.connect(extra);
    if (this.stopped) {
      await transport.close().catch(() => {});
      return;
    }
    this.connects++;
    this.up = transport;
    this.upLink = link;
    transport.onmessage = (m) => this.fromUp(transport, m as Msg);
    transport.onclose = () => this.upClosed(transport);
    transport.onerror = (err) => this.log(`inkwire relay: link error: ${err.message}`);
    await transport.start();
    const buildChanged = reconnect && this.lastBuildId !== undefined && buildId !== undefined && buildId !== this.lastBuildId;
    if (buildId !== undefined) this.lastBuildId = buildId;
    // The backoff is reset only when the link sends a message (fromUp): a daemon
    // that accepts the link and closes it at once must not cause a fast loop.
    if (reconnect) this.log(`inkwire relay: link restored (connect ${this.connects})`);
    if (reconnect && this.initForwarded && this.initReq) {
      // The new McpServer needs an initialize. Claude Code must not see its response.
      this.reinitId = `${REINIT_PREFIX}${++this.reinits}`;
      this.listChangedAfterReinit = buildChanged;
      await this.sendUp(transport, { ...this.initReq, id: this.reinitId } as Msg);
    } else {
      this.becomeReady(false, buildChanged);
    }
  }

  private becomeReady(afterReinit: boolean, listChanged: boolean): void {
    const up = this.up;
    if (!up) return;
    this.ready = true;
    this.lostSince = null;
    if (afterReinit && this.initNote) void this.sendUp(up, this.initNote);
    for (const msg of this.queue.splice(0)) this.forwardUp(up, msg);
    if (listChanged) this.sendDown({ jsonrpc: "2.0", method: "notifications/tools/list_changed" } as Msg);
  }

  private fromDown(msg: Msg): void {
    if (isRequest(msg)) {
      if (msg.method === "initialize" && !this.initReq) this.initReq = msg;
      if (this.up && this.ready) return this.forwardUp(this.up, msg);
      if (this.lostSince !== null && this.now() - this.lostSince >= this.opts.giveUpMs) return void this.fail(msg.id!, GAP_TEXT);
      if (this.queue.length >= this.opts.queueMax) return void this.fail(msg.id!, GAP_TEXT);
      this.queue.push(msg);
      return;
    }
    if (isNotification(msg)) {
      if (msg.method === "notifications/initialized" && !this.initNote) this.initNote = msg;
      if (this.up && this.ready) return this.forwardUp(this.up, msg);
      if (this.queue.length < this.opts.queueMax) this.queue.push(msg);
      return;
    }
    // A response to a request of the daemon: it belongs to the current link only.
    if (this.up && this.ready) void this.sendUp(this.up, msg);
  }

  private forwardUp(up: Transport, msg: Msg): void {
    if (isRequest(msg)) {
      this.inflight.set(msg.id!, msg.method!);
      if (msg.method === "initialize") this.initForwarded = true;
    }
    void this.sendUp(up, msg);
  }

  private fromUp(t: Transport, msg: Msg): void {
    if (t !== this.up) return;
    // The link works: the next drop starts the backoff again from the start.
    this.backoff = this.opts.backoffMs;
    if (!isRequest(msg) && !isNotification(msg) && msg.id !== undefined) {
      if (msg.id === this.reinitId) {
        this.reinitId = null;
        this.becomeReady(true, this.listChangedAfterReinit);
        return;
      }
      const method = this.inflight.get(msg.id);
      this.inflight.delete(msg.id);
      if (method === "tools/call" && msg.result) this.track(msg.result);
    }
    this.sendDown(msg);
  }

  /** M4.7: only the first line of a tool result. Any other first line keeps the kept id. */
  private track(result: unknown): void {
    const first = (result as { content?: { type?: string; text?: string }[] }).content?.[0];
    if (first?.type !== "text" || typeof first.text !== "string") return;
    const line = first.text.split("\n", 1)[0] ?? "";
    const m = BOARD_LINE.exec(line);
    if (m) this.currentBoard = m[1]!;
    else if (line.startsWith("board: none")) this.currentBoard = null;
  }

  private upClosed(t: Transport): void {
    if (t !== this.up) return;
    this.up = null;
    this.ready = false;
    this.reinitId = null;
    if (this.stopped) return;
    const code = this.upLink?.closeCode ?? null;
    if (code !== null && FATAL_CLOSE.has(code)) {
      const why = this.upLink?.closeReason || `close code ${code}`;
      this.fatal(`the daemon refused the link (${code}): ${why}`);
      return;
    }
    this.lostSince = this.now();
    this.log("inkwire relay: link to the daemon closed; the relay connects again");
    for (const id of this.inflight.keys()) this.fail(id, LOST_TEXT);
    this.inflight.clear();
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.attach().catch((err) => {
        if (this.stopped) return;
        if (isFatal(err)) {
          this.fatal(messageOf(err));
          return;
        }
        this.log(`inkwire relay: connect failed: ${messageOf(err)}`);
        if (this.lostSince !== null && this.now() - this.lostSince >= this.opts.giveUpMs) {
          // The gap is too long: the queued calls get the error now; later calls get it at once.
          for (const msg of this.queue.splice(0)) if (isRequest(msg)) this.fail(msg.id!, GAP_TEXT);
        }
        this.schedule();
      });
    }, delay);
  }

  /** No retry can fix this: answer every open request with the reason, stop, and tell relay.ts. */
  private fatal(reason: string): void {
    this.log(`inkwire relay: ${reason}`);
    const text = `inkwire relay stops: ${reason}`;
    const sent: Promise<void>[] = [];
    for (const id of this.inflight.keys()) sent.push(this.fail(id, text));
    this.inflight.clear();
    for (const msg of this.queue.splice(0)) if (isRequest(msg)) sent.push(this.fail(msg.id!, text));
    // The answers go out before stop() sets stopped; then relay.ts exits.
    void Promise.all(sent)
      .then(() => this.stop())
      .then(() => this.onFatal(reason));
  }

  private fail(id: Id, message: string): Promise<void> {
    return this.sendDown({ jsonrpc: "2.0", id, error: { code: LINK_LOST_CODE, message } } as Msg);
  }

  private sendUp(up: Transport, msg: Msg): Promise<void> {
    // A failed send means the link is closing: upClosed answers the in-flight requests.
    return up.send(msg).catch(() => {});
  }

  private sendDown(msg: Msg): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.down.send(msg).catch((err) => this.log(`inkwire relay: downstream send failed: ${err.message}`));
  }
}
