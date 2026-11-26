import { cp, mkdir, rm } from "node:fs/promises";

const source = new URL("../evidence-review/", import.meta.url);
const output = new URL("../dist/", import.meta.url);
const runtime = [
  "index.html", "style.css", "review.mjs", "benchmark.mjs", "browser-readiness.mjs",
  "evidence.mjs", "firebase-ai.mjs", "ocr-evidence.mjs", "scan-cleanup.mjs", "scan.mjs",
  "ocr-runtime", "samples", "vendor",
];

await rm(output, { recursive: true, force: true });
await mkdir(output);
await Promise.all(runtime.map(name => cp(new URL(name, source), new URL(name, output), { recursive: true })));
