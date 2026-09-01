// Generate JSON Schema from the zod contract (zod 4 native toJSONSchema).
// Output goes to schema/ at the repo root; a test compares a sample state
// against BOTH this and the handoff schema to catch drift.
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { canvasStateSchema, toolArgs } from "../shared/schemas.js";

const outDir = new URL("../../schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const stateJson = z.toJSONSchema(canvasStateSchema, { io: "output" });
writeFileSync(
  new URL("canvas-state.generated.json", outDir),
  JSON.stringify(stateJson, null, 2) + "\n",
);

const tools: Record<string, unknown> = {};
for (const [name, schema] of Object.entries(toolArgs)) {
  tools[name] = z.toJSONSchema(schema, { io: "input" });
}
writeFileSync(
  new URL("tools.generated.json", outDir),
  JSON.stringify(tools, null, 2) + "\n",
);

console.error("wrote schema/canvas-state.generated.json and schema/tools.generated.json");
