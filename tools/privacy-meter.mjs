// Based on MedOCR Hybrid's browser.ts at 5b93ec52d3a2a70d0399fbe5ec43c227c323ef1b.
// Copyright 2026 Sumit Sharma. Apache-2.0, see ../evidence-review/vendor/medocr/LICENSE.
// Modified for ClaimGuard: output only aggregate counts and flags for synthetic inputs.
import { PUBLIC_PROMPT } from "../evidence-review/evidence.mjs";

const CANARY = "DEMO-PA-240817";
const inferenceHost = /^(?:firebasevertexai|firebaseailogic|generativelanguage|[a-z0-9-]*aiplatform)\.googleapis\.com$/i;
const imagePart = /(?:data:image\/|image\/(?:png|jpeg)|["=:]iVBORw0KGgo|["=:]\/9j\/)/i;

// Match the content sent by a single-turn generation request. A public prompt
// somewhere in a larger request is not evidence that the entire input was public.
function exactPublicPayload(body) {
  try {
    const request = JSON.parse(body);
    const supportedKeys = new Set(["contents", "generationConfig", "safetySettings"]);
    if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some(key => !supportedKeys.has(key))
      || !Array.isArray(request.contents) || request.contents.length !== 1) return false;
    const [content] = request.contents;
    if (!content || typeof content !== "object" || Object.keys(content).some(key => key !== "role" && key !== "parts")
      || (content.role !== undefined && content.role !== "user")
      || !Array.isArray(content.parts) || content.parts.length !== 1) return false;
    const [part] = content.parts;
    return part && typeof part === "object" && Object.keys(part).length === 1 && part.text === PUBLIC_PROMPT;
  } catch {
    return false;
  }
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
  if (isInference && exactPublicPayload(body)) phase.exactPublicPromptRequests++;
  else if (isInference) phase.unexpectedInferencePayloads++;
}

export function evaluateCapture(local, cloud) {
  const observedDocument = [local, cloud].some(phase => phase.imagesDetected || phase.referenceDetected);
  if (observedDocument || local.inferenceRequests || cloud.unexpectedInferencePayloads) return "unexpected_traffic";
  if (local.unknownBodies || cloud.unknownBodies || !cloud.exactPublicPromptRequests
    || !local.uiReportedInference || !cloud.uiReportedInference) return "inconclusive";
  return "expected_page_traffic_observed";
}
