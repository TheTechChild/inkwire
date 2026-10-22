// Screenshot pipeline (SPEC § 6). Primary: ask a connected client to capture
// itself; the panel POSTs the PNG back. Fallback: server-side SVG render.
import { randomBytes } from "node:crypto";
import { renderBoardSvg } from "./render-svg.ts";
import { rasterizeSvg } from "./rasterize.ts";
import type { BoardSession } from "./session.ts";
import type { Viewport } from "../shared/types.ts";

export interface CaptureBroker {
  /** Send a capture request to one client of this board; null if none. */
  requestCapture: (
    boardId: string,
    captureId: string,
    viewport: Viewport | null,
    fit: boolean,
  ) => boolean;
}

interface Pending {
  resolve: (png: Buffer | null) => void;
  timer: NodeJS.Timeout;
}

const CLIENT_TIMEOUT_MS = 3000;

export class Screenshots {
  private pending = new Map<string, Pending>();

  private broker: CaptureBroker;
  private imagesDir: string;
  /** The font files of the server render (installFonts). Empty: system fonts only. */
  private fontFiles: string[];

  constructor(broker: CaptureBroker, imagesDir: string, fontFiles: string[] = []) {
    this.broker = broker;
    this.imagesDir = imagesDir;
    this.fontFiles = fontFiles;
  }

  /** Called by the HTTP layer when the panel POSTs a captured PNG. */
  complete(captureId: string, png: Buffer | null): boolean {
    const p = this.pending.get(captureId);
    if (!p) return false;
    this.pending.delete(captureId);
    clearTimeout(p.timer);
    p.resolve(png);
    return true;
  }

  async capture(
    session: BoardSession,
    viewport: Viewport | undefined,
    fit: boolean,
  ): Promise<{ png: Buffer; source: "client" | "server"; viewport: Viewport }> {
    const vp = viewport ?? session.viewport;
    const captureId = randomBytes(6).toString("hex");

    const clientPng = await new Promise<Buffer | null>((resolve) => {
      const sent = this.broker.requestCapture(session.boardId, captureId, viewport ?? null, fit);
      if (!sent) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(captureId);
        resolve(null);
      }, CLIENT_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(captureId, { resolve, timer });
    });

    if (clientPng) return { png: clientPng, source: "client", viewport: vp };

    const svg = renderBoardSvg({
      collections: session.collections(),
      viewport: vp,
      fit,
      imagesDir: this.imagesDir,
    });
    return { png: rasterizeSvg(svg, this.fontFiles), source: "server", viewport: vp };
  }
}
