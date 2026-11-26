import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { evaluateCapture, recordPageRequest, startPhase } from "./privacy-meter.mjs";

const [chromePath, profilePath, app = "http://127.0.0.1:8000", output = "claimguard-privacy-capture.json"] = process.argv.slice(2);
if (!chromePath || !profilePath) {
  console.error("Usage: node tools/capture-privacy.mjs CHROME_PATH DEDICATED_PROFILE [APP_URL] [OUTPUT]");
  process.exit(2);
}
const appURL = new URL(app);
if (appURL.protocol !== "https:" && !(appURL.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(appURL.hostname))) {
  throw new Error("Use the local ClaimGuard URL or an HTTPS deployment you control.");
}

const profile = resolve(profilePath);
await mkdir(profile, { recursive: true });
const chrome = spawn(chromePath, [
  "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const input = createInterface({ input: process.stdin, output: process.stdout });
let nextId = 0;
let buffer = "";
let sessionId;
let active;
const replies = new Map();
const pending = new Set();

function send(method, params = {}, session = sessionId) {
  const id = ++nextId;
  return new Promise((resolveReply, reject) => {
    const timeout = setTimeout(() => {
      replies.delete(id);
      reject(new Error(`Chrome did not reply to ${method}`));
    }, 8000);
    replies.set(id, { resolveReply, reject, timeout });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId: session }) + "\0");
  });
}

function stopReceiver(error) {
  for (const r of replies.values()) {
    clearTimeout(r.timeout);
    r.reject(error);
  }
  replies.clear();
}

chrome.on("error", stopReceiver);
chrome.on("exit", () => stopReceiver(new Error("Chrome closed.")));
chrome.stdio[3].on("error", stopReceiver);
chrome.stdio[4].setEncoding("utf8");
chrome.stdio[4].on("data", chunk => {
  const messages = (buffer + chunk).split("\0");
  buffer = messages.pop();
  for (const json of messages) {
    const message = JSON.parse(json);
    if (message.method === "Network.requestWillBeSent" && active) {
      const { requestId, request } = message.params;
      const task = recordPageRequest(active, request, () => send("Network.getRequestPostData", { requestId }));
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
    const reply = replies.get(message.id);
    if (reply) {
      replies.delete(message.id);
      clearTimeout(reply.timeout);
      if (message.error) reply.reject(new Error(message.error.message));
      else reply.resolveReply(message.result);
    }
  }
});

async function capture(name, instructions, statusSelector, prefix) {
  const phase = startPhase(name);
  active = phase;
  await input.question(`${instructions} Wait for the result, then press Enter here. `);
  active = null;
  await Promise.allSettled([...pending]);
  const expression = `document.querySelector(${JSON.stringify(statusSelector)})?.textContent?.startsWith(${JSON.stringify(prefix)})`;
  const { result } = await send("Runtime.evaluate", { expression, returnByValue: true });
  phase.uiReportedInference = result.value === true;
  return phase;
}

try {
  const browser = await send("Browser.getVersion");
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find(target => target.type === "page" && target.url === "about:blank");
  if (!page) throw new Error("Chrome did not open a blank tab.");
  ({ sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }));
  await send("Network.enable", { maxPostDataSize: 1048576 });
  await send("Page.navigate", { url: appURL.href });
  await input.question("In the opened page, wait for readiness and select Specialist referral. Warm up Nano if needed, then press Enter. ");
  const local = await capture("device_only_scan", "Click Read scan on-device for Specialist referral.", "#local-status", "On-device ·");
  const cloud = await capture("public_rule_explanation", "Click Explain rule with cloud AI.", "#cloud-status", "Cloud ·");
  const report = {
    schemaVersion: 1, scope: "Chrome page-target HTTP(S) requests, excluding loopback",
    browser: browser.product, capturedAt: new Date().toISOString(),
    status: evaluateCapture(local, cloud), local, cloud,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status} · ${output}`);
} finally {
  input.close();
  chrome.kill();
}
