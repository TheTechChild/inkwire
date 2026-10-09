// The build of this checkout: dist/build.json, which `yarn build` writes
// (scripts/write-build-id.mjs, ADR 0001). The daemon reads it one time, at
// boot, and keeps the value (plan Decision 10); the relay reads it one time,
// at its start. No store or session import: the relay uses this file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  /** The first 16 hex of the hash of the built server and panel, or "unbuilt". */
  id: string;
  /** ISO time of the build; null when there is no dist/build.json. */
  built_at: string | null;
}

/** Resolves to <repo>/dist/build.json from both src/server/ and dist/server/. */
const BUILD_FILE = fileURLToPath(new URL("../../dist/build.json", import.meta.url));

export function readBuildInfo(file: string = BUILD_FILE): BuildInfo {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<BuildInfo>;
    if (typeof raw.id !== "string") return { id: "unbuilt", built_at: null };
    return { id: raw.id, built_at: typeof raw.built_at === "string" ? raw.built_at : null };
  } catch {
    return { id: "unbuilt", built_at: null };
  }
}

/**
 * Decision 7: a daemon is stale when the relay's build id differs and the
 * relay's build is later. A daemon with no built_at is older than any build.
 */
export function isNewerBuild(relay: BuildInfo, daemon: BuildInfo): boolean {
  if (relay.id === daemon.id || relay.built_at === null) return false;
  if (daemon.built_at === null) return true;
  return Date.parse(relay.built_at) > Date.parse(daemon.built_at);
}
