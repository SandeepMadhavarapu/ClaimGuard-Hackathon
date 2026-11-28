import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL("../evidence-review/", import.meta.url);
const output = new URL("../dist/", import.meta.url);
const runtime = [
  "index.html", "evaluation.html", "verify.html", "receipts.mjs", "style.css", "review.mjs", "benchmark.mjs", "browser-readiness.mjs",
  "evidence.mjs", "claim-check.mjs", "firebase-ai.mjs", "layout-read.mjs", "ocr-evidence.mjs", "scan-cleanup.mjs", "scan.mjs",
  "ocr-runtime", "samples", "heldout", "vendor",
];

let firebaseConfig;
if (process.env.CLAIMGUARD_FIREBASE_CONFIG) {
  try {
    const { firebase: { appId, projectId, apiKey }, recaptchaSiteKey } = JSON.parse(process.env.CLAIMGUARD_FIREBASE_CONFIG);
    if (![appId, projectId, apiKey, recaptchaSiteKey].every(value => typeof value === "string" && /^[A-Za-z0-9:_-]+$/.test(value))) {
      throw new Error("Missing or invalid public config fields");
    }
    firebaseConfig = { firebase: { appId, projectId, apiKey }, recaptchaSiteKey, recaptchaProvider: "enterprise", localDebug: false };
  } catch {
    throw new Error("CLAIMGUARD_FIREBASE_CONFIG must contain the public Firebase web app config and reCAPTCHA site key.");
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output);
await Promise.all(runtime.map(name => cp(new URL(name, source), new URL(name, output), { recursive: true })));
const commit = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || "local";
await writeFile(new URL("build.json", output), JSON.stringify({ commit, builtAt: new Date().toISOString() }) + "\n");
if (firebaseConfig) {
  await writeFile(new URL("firebase-config.local.json", output), JSON.stringify(firebaseConfig) + "\n");
}

// Offline support: precache the app shell, samples and OCR language data. The OCR core variant the
// browser picks and the Firebase SDK are cached the first time they load.
const files = (await readdir(output, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile())
  .map(entry => relative(fileURLToPath(output), join(entry.parentPath ?? entry.path, entry.name)).split(sep).join("/"))
  .filter(name => !/^ocr-runtime\/core\/|LICENSE|licenses\/|package-sources|firebase-config|build\.json|^sw\.js$|^heldout\//.test(name))
  .sort();
const worker = await readFile(new URL("../evidence-review/sw.template.js", import.meta.url), "utf8");
await writeFile(new URL("sw.js", output), worker
  .replace("__VERSION__", JSON.stringify(`${commit}-${Date.now()}`))
  .replace("__PRECACHE__", JSON.stringify(["./", ...files.map(name => `./${name}`)])));
