// The Node version check of the relay (ADR 0005). Node runs the TypeScript
// source, and Node 26 is the version that the plugin supports. The plugin
// starts the relay through relay.sh, which finds a Node 26. A project
// .mcp.json can start relay.ts with an older node: then this module, which
// relay.ts imports first, stops the relay with a clear message. Node before
// 22.18 cannot read a .ts file at all; relay.sh covers that case.
export const NODE_MAJOR = 26;

const major = Number(process.versions.node.split(".")[0]);
if (major < NODE_MAJOR) {
  console.error(
    `inkwire relay: Node ${NODE_MAJOR} or later is necessary, but this is Node ${process.versions.node} (${process.execPath}). Start the relay with plugin/src/link/relay.sh, or set a Node ${NODE_MAJOR} in the command.`,
  );
  process.exit(1);
}
