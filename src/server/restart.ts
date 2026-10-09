// The one shutdown function of a person-only restart (Decision 3, plan M4.9):
// persist every board, close every link, exit 0. The relays reconnect (M4.7)
// and autostart the current build from their own plugin dir. Two callers: the
// panel intent (M5) and POST /api/daemon/restart (`yarn daemon:restart`).
// There is no MCP tool for it.

export interface RestartDeps {
  persistAll: () => void;
  /** Stop new connections first, so a fast relay does not link to this daemon again. */
  stopListening: () => void;
  /** Close every relay link. */
  closeLinks: () => void;
  /** The open link count, to wait for the close frames. */
  linkCount: () => number;
  /** Close the store and the http server. */
  close: () => void;
  exit: (code: number) => void;
  /** The most time to wait for the links to close. */
  waitMs?: number;
}

export function createRestart(deps: RestartDeps): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    console.error("inkwire daemon restart: the person asked for it");
    try {
      deps.persistAll();
    } catch (err) {
      console.error("flush failed:", err);
    }
    deps.stopListening();
    deps.closeLinks();
    const deadline = Date.now() + (deps.waitMs ?? 500);
    const finish = () => {
      if (deps.linkCount() > 0 && Date.now() < deadline) {
        setTimeout(finish, 20);
        return;
      }
      try {
        deps.close();
      } catch (err) {
        console.error("close failed:", err);
      }
      deps.exit(0);
    };
    finish();
  };
}
