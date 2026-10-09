// The first frame on the link (ADR 0001): who the relay speaks for. The hello
// has no project root: each board owns its root (ADR 0003). The cwd is only
// for the boards_list overlap filter, relative import paths and the Author label.
import { z } from "zod";

/** Bump when the link frames change. A daemon closes a link of another version with 4426. */
export const LINK_VERSION = 1;

export const buildSchema = z.object({
  id: z.string(),
  built_at: z.string().nullable(),
});

export const helloSchema = z.object({
  type: z.literal("hello"),
  v: z.literal(LINK_VERSION),
  /** The Claude Code pid: the relay's ppid. */
  pid: z.number().int().positive(),
  /** CLAUDE_CODE_SESSION_ID, when Claude Code set it. */
  session_id: z.string().nullable(),
  cwd: z.string().refine((p) => p.startsWith("/"), "cwd must be an absolute path"),
  build: buildSchema,
  /** TERM_PROGRAM of the Claude Code session, for focusTerminal (Open question 3). */
  term_program: z.string().optional(),
  /** After a reconnect: the board id from the last context line (Open question 11). */
  current_board: z.string().optional(),
});

export type Hello = z.infer<typeof helloSchema>;

/** Close codes of the link. */
export const LINK_CLOSE = {
  /** No valid hello within the time limit, or the first frame was not a hello. */
  badHello: 4400,
  /** The hello has another link version. */
  version: 4426,
  /** The daemon restarts or stops. */
  restart: 1012,
} as const;
