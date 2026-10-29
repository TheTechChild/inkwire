// The child process of rasterizeIsolated: reads { svg, fontFiles } as JSON on
// stdin, writes the PNG to stdout. A resvg panic aborts this process only.
import { rasterizeSvg } from "./rasterize.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const { svg, fontFiles } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { svg: string; fontFiles: string[] };
process.stdout.write(rasterizeSvg(svg, fontFiles));
