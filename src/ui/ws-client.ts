// WebSocket client: connect, reconnect, apply pushes, answer capture RPCs.
import { captureBoard } from "./capture.js";
import type { App, StatePush } from "./app.js";
import { isServerMessage } from "./app.js";
import type { ClientIntent } from "../shared/protocol.js";

export function connectWs(app: App): void {
  let socket: WebSocket | null = null;
  let queue: ClientIntent[] = [];
  let sentViewport = "";
  let lastFocus: string | null = null;
  let lastHighlight: string | null = null;
  let lastTrace: string | null = null;

  app.send = (intent) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (intent.type === "set_viewport") sentViewport = JSON.stringify(intent.viewport);
      socket.send(JSON.stringify(intent));
    } else {
      queue.push(intent);
    }
  };

  const open = () => {
    socket = new WebSocket(`ws://${location.host}/ws?board=${encodeURIComponent(app.boardId)}`);

    socket.onopen = () => {
      app.connected = true;
      for (const intent of queue) app.send(intent);
      queue = [];
      app.render();
    };

    socket.onclose = (event) => {
      // 4010: board deleted under us. 4004: board not found on reconnect
      // (deleted while we were disconnected). Either way, stop retrying.
      if (event.code === 4010 || event.code === 4004) {
        location.href = "/";
        return;
      }
      app.connected = false;
      app.render();
      setTimeout(open, 1000);
    };

    socket.onmessage = (event) => {
      const msg: unknown = JSON.parse(String(event.data));
      if (!isServerMessage(msg)) return;
      if (msg.type === "state") {
        app.push = msg as unknown as StatePush & { type: "state" };
        // Focus moved (a chip, a digit, or the AI's layers_focus): never keep
        // an element selected that the human can no longer see.
        if (msg.state.focus !== lastFocus) {
          lastFocus = msg.state.focus;
          app.sel = null;
        }
        // A highlight set (by the agent or a chip) tells the eye to look past
        // the selection: the inspector must not keep showing it.
        const hl = msg.session.highlight?.msg_id ?? null;
        if (hl !== lastHighlight) {
          lastHighlight = hl;
          if (hl) app.sel = null;
        }
        // A trace opened or closed (a chip, paths_play, a session_send): it is a
        // stronger pointer than the selection, and any local seek is stale.
        const tr = msg.session.trace;
        if ((tr?.path_id ?? null) !== lastTrace) {
          lastTrace = tr?.path_id ?? null;
          app.sel = null;
          app.traceOverride = null;
        }
        // The push echoes this panel's seek: the override has done its job.
        const ov = app.traceOverride;
        if (ov && (!tr || (tr.t === ov.t && tr.running === ov.running))) app.traceOverride = null;
        // Adopt the server viewport when someone else moved it (the AI's
        // set_viewport, or another panel) — never mid-gesture, and never
        // when it just echoes what this panel sent.
        const incoming = JSON.stringify(msg.state.viewport);
        if (!app.drag && incoming !== sentViewport) {
          const current = JSON.stringify({ x: app.view.x, y: app.view.y, zoom: app.view.zoom });
          if (incoming !== current) {
            app.view = { ...msg.state.viewport };
          }
          sentViewport = incoming;
        }
        app.render();
      } else if (msg.type === "error") {
        console.error("intent rejected:", msg.text);
        app.render();
      } else if (msg.type === "capture_request") {
        void answerCapture(app, msg.capture_id, msg.viewport, msg.fit);
      }
    };
  };

  open();
}

async function answerCapture(
  app: App,
  captureId: string,
  viewport: { x: number; y: number; zoom: number } | null,
  fit: boolean,
): Promise<void> {
  app.flash();
  let body: Blob | null = null;
  try {
    body = await captureBoard(app, viewport, fit);
  } catch (err) {
    console.error("capture failed:", err);
  }
  await fetch(`/api/capture/${captureId}`, { method: "POST", body: body ?? new Blob() });
}
