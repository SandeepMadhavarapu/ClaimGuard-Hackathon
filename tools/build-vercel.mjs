import { cp, mkdir, rm, writeFile } from "node:fs/promises";

const source = new URL("../evidence-review/", import.meta.url);
const output = new URL("../dist/", import.meta.url);
const runtime = [
  "index.html", "style.css", "review.mjs", "benchmark.mjs", "browser-readiness.mjs",
  "evidence.mjs", "claim-check.mjs", "firebase-ai.mjs", "layout-read.mjs", "ocr-evidence.mjs", "scan-cleanup.mjs", "scan.mjs",
  "ocr-runtime", "samples", "vendor",
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
if (firebaseConfig) {
  await writeFile(new URL("firebase-config.local.json", output), JSON.stringify(firebaseConfig) + "\n");
}
