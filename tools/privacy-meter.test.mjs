import assert from "node:assert/strict";
import { test } from "node:test";
import { PUBLIC_PROMPT } from "../evidence-review/evidence.mjs";
import { evaluateCapture, recordPageRequest, startPhase } from "./privacy-meter.mjs";

const endpoint = "https://firebasevertexai.googleapis.com/example";
const prompts = text => JSON.stringify({ contents: [{ parts: [{ text }] }] });

test("capture requires a successful UI result and an observed public-rule request", async () => {
  const local = { ...startPhase("local"), uiReportedInference: true };
  const cloud = { ...startPhase("cloud"), uiReportedInference: true };
  await recordPageRequest(local, { url: "http://127.0.0.1:8000/samples/referral.png" });
  await recordPageRequest(cloud, { url: endpoint, method: "OPTIONS" });
  await recordPageRequest(cloud, { url: endpoint, method: "POST", postData: prompts(PUBLIC_PROMPT) });
  assert.equal(local.externalRequests, 0);
  assert.equal(cloud.inferenceRequests, 1);
  assert.equal(evaluateCapture(local, cloud), "expected_page_traffic_observed");
  assert.equal(evaluateCapture({ ...local, uiReportedInference: false }, cloud), "inconclusive");
});

test("capture flags unexpected device traffic and never retains request payloads", async () => {
  const local = startPhase("local");
  const privateBody = '{"value":"DEMO-PA-240817","mimeType":"image/png"}';
  await recordPageRequest(local, { url: endpoint, method: "POST", hasPostData: true },
    async () => ({ postData: privateBody }));
  assert.equal(local.referenceDetected, 1);
  assert.equal(local.imagesDetected, 1);
  assert.equal(evaluateCapture(local, startPhase("cloud")), "unexpected_traffic");
  assert.ok(!JSON.stringify(local).includes("DEMO-PA-240817"));
});

test("an unreadable body makes the result inconclusive", async () => {
  const local = startPhase("local");
  await recordPageRequest(local, { url: "https://example.com/", hasPostData: true },
    async () => { throw new Error("Unavailable"); });
  assert.equal(local.unknownBodies, 1);
  assert.equal(evaluateCapture(local, startPhase("cloud")), "inconclusive");
});

test("a public prompt mixed with a second input or system instruction is not public-only", async () => {
  const publicPart = { text: PUBLIC_PROMPT };
  const unrelated = "A second text value, unrelated to the fixture canary";
  for (const body of [
    { contents: [{ parts: [publicPart, { text: unrelated }] }] },
    { contents: [{ parts: [{ ...publicPart, inlineData: { data: "example" } }] }] },
    { contents: [{ parts: [publicPart] }, { parts: [{ text: unrelated }] }] },
    { contents: [{ parts: [publicPart] }], systemInstruction: { parts: [{ text: unrelated }] } },
  ]) {
    const phase = startPhase("cloud");
    await recordPageRequest(phase, { url: endpoint, method: "POST", postData: JSON.stringify(body) });
    assert.equal(phase.exactPublicPromptRequests, 0);
    assert.equal(phase.unexpectedInferencePayloads, 1);
  }
});
