// Based on MedOCR Hybrid's browser.ts at 5b93ec52d3a2a70d0399fbe5ec43c227c323ef1b.
// Copyright 2026 Sumit Sharma. Apache-2.0, see ../evidence-review/vendor/medocr/LICENSE.
// Modified for ClaimGuard: output only aggregate counts and flags for synthetic inputs.
import { PUBLIC_PROMPT } from "../evidence-review/evidence.mjs";

const CANARY = "DEMO-PA-240817";
const inferenceHost = /^(?:firebasevertexai|firebaseailogic|generativelanguage|[a-z0-9-]*aiplatform)\.googleapis\.com$/i;
const imagePart = /(?:data:image\/|image\/(?:png|jpeg)|["=:]iVBORw0KGgo|["=:]\/9j\/)/i;

function promptPresent(body) {
  try {
    const data = JSON.parse(body);
    const pending = [data];
    while (pending.length) {
      const item = pending.pop();
      if (item === PUBLIC_PROMPT) return true;
      if (item && typeof item === "object") for (const value of Object.values(item)) pending.push(value);
    }
  } catch {
    return false;
  }
  return false;
}

export function startPhase(name) {
  return {
    name, externalRequests: 0, bodyBytesObserved: 0, unknownBodies: 0,
    inferenceRequests: 0, imagesDetected: 0, referenceDetected: 0,
    exactPublicPromptRequests: 0, unexpectedInferencePayloads: 0,
    uiReportedInference: false, hosts: Object.create(null),
  };
}

export async function recordPageRequest(phase, request, getPostData) {
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!["https:", "http:"].includes(url.protocol)
    || /^(localhost|127(?:\.\d+){3}|\[::1\])$/i.test(url.hostname)) return;
  phase.externalRequests++;
  phase.hosts[url.hostname] = (phase.hosts[url.hostname] ?? 0) + 1;
  const isInference = request.method !== "OPTIONS" && inferenceHost.test(url.hostname);
  if (isInference) phase.inferenceRequests++;

  let body = "";
  let unknown = false;
  if (request.hasPostData || typeof request.postData === "string") {
    const entries = request.postDataEntries;
    if (entries?.length && entries.every(part => typeof part.bytes === "string")) {
      body = Buffer.concat(entries.map(part => Buffer.from(part.bytes, "base64"))).toString("utf8");
    } else if (typeof request.postData === "string") {
      body = request.postData;
    } else {
      try { ({ postData: body } = await getPostData()); } catch { unknown = true; }
    }
    if (typeof body !== "string" || (request.hasPostData && !body)) unknown = true;
  }
  if (unknown) phase.unknownBodies++;
  if (typeof body !== "string") body = "";
  phase.bodyBytesObserved += Buffer.byteLength(body);
  if (body.includes(CANARY) || url.href.includes(CANARY)) phase.referenceDetected++;
  if (imagePart.test(body)) phase.imagesDetected++;
  if (isInference && promptPresent(body)) phase.exactPublicPromptRequests++;
  else if (isInference) phase.unexpectedInferencePayloads++;
}

export function evaluateCapture(local, cloud) {
  const observedDocument = [local, cloud].some(phase => phase.imagesDetected || phase.referenceDetected);
  if (observedDocument || local.inferenceRequests || cloud.unexpectedInferencePayloads) return "unexpected_traffic";
  if (local.unknownBodies || cloud.unknownBodies || !cloud.exactPublicPromptRequests
    || !local.uiReportedInference || !cloud.uiReportedInference) return "inconclusive";
  return "expected_page_traffic_observed";
}
