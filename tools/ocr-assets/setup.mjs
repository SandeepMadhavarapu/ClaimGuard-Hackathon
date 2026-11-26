// Based on LabLens scripts/setup-ocr.mjs at 45bbc846e4a286bd9a5e7b93aa5a15b53e304ace.
// Copyright 2026 Bayu Trisnapati. MIT, see LICENSE.LabLens.
// Modified for ClaimGuard's static browser app with English-only OCR.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "../../evidence-review/ocr-runtime");
const require = createRequire(import.meta.url);
const tess = dirname(require.resolve("tesseract.js/package.json"));
const core = dirname(createRequire(join(tess, "package.json")).resolve("tesseract.js-core/package.json"));
const lang = dirname(require.resolve("@tesseract.js-data/eng/package.json"));

await mkdir(join(out, "core"), { recursive: true });
await mkdir(join(out, "lang"), { recursive: true });
await mkdir(join(out, "licenses"), { recursive: true });

for (const name of ["tesseract.min.js", "worker.min.js"]) {
  await copyFile(join(tess, "dist", name), join(out, name));
}
const coreFiles = (await readdir(core)).filter(name => /-lstm\.wasm(?:\.js)?$/.test(name));
if (!coreFiles.includes("tesseract-core-lstm.wasm.js")) throw new Error("Missing the Tesseract core asset.");
for (const name of coreFiles) await copyFile(join(core, name), join(out, "core", name));
await copyFile(join(lang, "4.0.0_best_int", "eng.traineddata.gz"), join(out, "lang", "eng.traineddata.gz"));

for (const [label, folder] of [["tesseract.js", tess], ["tesseract.js-core", core], ["eng", lang]]) {
  for (const name of await readdir(folder)) {
    if (/^(license|notice)(\.|$)/i.test(name)) await copyFile(join(folder, name), join(out, "licenses", `${label}-${name}`));
  }
}
console.log("Same-origin OCR assets are ready.");
