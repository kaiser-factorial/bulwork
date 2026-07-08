// Export learned decisions (clarify answers + honesty-lever corrections) as eval cases so
// `npm run eval` can score adjudication accuracy against your real corrections (Epic 0.6).
// Usage: node scripts/export-cases.mjs [outPath]   (default .data/corrections.cases.json)
import { writeFile } from "node:fs/promises";
import { decisionsToCases, loadDecisions } from "../dist/decisions-store.js";

const out = process.argv[2] || ".data/corrections.cases.json";
const cases = decisionsToCases(await loadDecisions());
await writeFile(out, JSON.stringify(cases, null, 2) + "\n", "utf8");
// Progress on stderr so stdout can be piped if desired.
process.stderr.write(`wrote ${cases.length} correction case(s) → ${out}\n`);
