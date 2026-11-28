import {
  CASES, NEXT_STEPS, groundNextStep, lookalikeNote, NEXT_STEP_LANGUAGES, PUBLIC_PROMPT, PUBLIC_RULE, SCAN_CASES, decideScanReview, matchLetter, nextStepCode, nextStepPrompt,
  parseReference, preauthorizationFinding,
  reviewScanSuggestion, verifySuggestion,
} from "./evidence.mjs";
import { compareBenchmarkRuns, rateLimitDelayMs, shareableBenchmark, runLayoutBenchmark, runOcrBenchmark, runScanBenchmark } from "./benchmark.mjs";
import { imageModelAvailability } from "./browser-readiness.mjs";
import { DEMO_CLAIM, DEMO_CLAIM_WITH_ERRORS, checkClaim, operationOutcome } from "./claim-check.mjs";
import { setupInference } from "./firebase-ai.mjs";
import { prepareScan, scanPart } from "./scan.mjs";

const el = id => document.getElementById(id);
const sample = el("sample");
const letter = el("letter");
const fileInput = el("scan-file");
const dropZone = el("scan-drop");
const preview = el("scan-preview");
const previewMarker = el("preview-evidence");
const fullScan = el("full-scan");
const scanDialog = el("scan-dialog");
const straighten = el("straighten");
const locateEvidence = el("locate-evidence");
const detailFrame = el("detail-frame");
const marker = el("evidence-marker");
const extract = el("extract");
const extractOcr = el("extract-ocr");
const extractLayout = el("extract-layout");
const evaluate = el("evaluate");
const evaluateOcr = el("evaluate-ocr");
const exportEvaluation = el("export-evaluation");
const explain = el("explain");
const explainHybrid = el("explain-hybrid");
const confirm = el("confirm");
const apply = el("apply");
const localStatus = el("local-status");
const manual = el("manual");
const manualForm = el("manual-form");
const steps = [...el("review-steps").children];
const scenarios = [...el("judge-panel").querySelectorAll("[data-scan]")];
const trace = [];
const routeNames = {
  LOCAL_OCR: "This device · OCR", LOCAL_TEXT: "This device · text match", LOCAL_RULES: "This device · claim rules", ON_DEVICE: "This device · Gemini Nano",
  IN_CLOUD: "Cloud · Firebase AI Logic", HUMAN: "Human review", UNCONFIRMED: "Route unconfirmed",
};

let mode = "scan";
let inference;
let inferenceUnavailable = false;
let busy = false;
let outcomeCode = null;
let confirmedReference = null;
let currentImage;
let originalImage;
let deviceAvailability;
let imageURL;
let pendingScan = 0;
let scanLoading = false;
let scanError = "";
let selection;
let latestBenchmark;
let latestOcrBenchmark;
let latestLayoutBenchmark;
let anchor;

function recordTrace(action, source, outcome, elapsedMs = null, policyOnly = false) {
  trace.push({ at: new Date().toISOString(), action, source, outcome, elapsedMs, inputScope: policyOnly ? "synthetic-policy" : "local-review" });
  if (trace.length > 16) trace.shift();
  const list = el("trace-entries");
  const row = document.createElement("li");
  const title = document.createElement("strong");
  const data = document.createElement("span");
  title.textContent = `${action} · ${outcome}`;
  data.textContent = elapsedMs === null ? routeNames[source] : `${routeNames[source]} · ${elapsedMs} ms`;
  row.append(title, data);
  list.append(row);
  if (list.children.length > 16) list.firstElementChild.remove();
  el("trace-empty").hidden = true;
  el("export-trace").disabled = false;
}

function downloadJson(value, filename) {
  const file = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let build = { commit: "local", builtAt: null };
fetch("./build.json", { cache: "no-store" }).then(response => response.ok ? response.json() : null).then(value => {
  if (value?.commit) build = value;
  const stamp = el("build-stamp");
  if (stamp) stamp.textContent = `Build ${build.commit}${build.builtAt ? ` · ${build.builtAt.slice(0, 10)}` : ""}`;
}).catch(() => {});

el("export-trace").addEventListener("click", () => {
  if (trace.length) {
    downloadJson({
      schemaVersion: 2,
      kind: "claimguard-run-receipt",
      scope: "In-app actions and SDK-reported inference routes. Synthetic documents only; no scan, reference or document text.",
      build,
      exportedAt: new Date().toISOString(),
      events: trace,
    }, "claimguard-run-receipt.json");
  }
});

function renderProgress() {
  const recorded = el("finding").dataset.pass === "true";
  const current = selection ? 1 : recorded ? 2 : 0;
  steps.forEach((step, index) => {
    step.classList.toggle("complete", index < current);
    if (index === current) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

const claimForm = el("claim-form");

function readClaim() {
  const data = Object.fromEntries(new FormData(claimForm));
  return { ...data, requiresPreauth: claimForm.elements.requiresPreauth.checked };
}

function fillClaim(claim) {
  for (const [name, value] of Object.entries(claim)) {
    const field = claimForm.elements[name];
    if (field?.type === "checkbox") field.checked = Boolean(value);
    else if (field) field.value = value;
  }
  renderClaimCheck();
}

function renderClaimCheck() {
  const result = checkClaim(readClaim(), confirmedReference, outcomeCode);
  const verdict = el("claim-verdict");
  verdict.dataset.verdict = result.verdict;
  verdict.textContent = result.summary;
  el("claim-checks").replaceChildren(...result.checks.map(check => {
    const row = document.createElement("li");
    row.dataset.status = check.status;
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = { pass: "✓", fail: "✗", pending: "…" }[check.status];
    const body = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = check.title;
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = check.detail;
    const status = document.createElement("span");
    status.className = "sr-only";
    status.textContent = { pass: "Passed. ", fail: "Failed. ", pending: "Waiting. " }[check.status];
    body.append(status, title, detail);
    row.append(mark, body);
    return row;
  }));
  return result;
}

function renderFinding(reference, method = "") {
  confirmedReference = reference || null;
  if (claimForm) renderClaimCheck();
  const finding = preauthorizationFinding(reference);
  const status = el("finding");
  status.dataset.pass = String(finding.pass);
  status.textContent = finding.pass ? "Preauthorization reference recorded" : "Missing preauthorization reference";
  if (finding.pass) {
    const details = document.createElement("span");
    details.textContent = `${reference} · ${method}`;
    status.append(details);
  }
  renderProgress();
}

function nextStepLanguage() {
  return document.querySelector('input[name="next-step-language"]:checked')?.value ?? "en";
}

function renderNextStepLanguage() {
  const language = nextStepLanguage();
  el("next-step-run").textContent = NEXT_STEP_LANGUAGES[language].route === "cloud"
    ? "Suggest next step in Kiswahili · cloud" : "Suggest next step · on-device first";
  if (outcomeCode) el("next-step-payload").textContent = nextStepPrompt(outcomeCode, language);
}

function setOutcome(code) {
  outcomeCode = code;
  if (claimForm) renderClaimCheck();
  el("next-step").hidden = !code;
  el("next-step-status").textContent = "";
  el("next-step-text").textContent = "";
  if (!code) return;
  const step = NEXT_STEPS[code];
  el("next-step-code").textContent = step.label;
  const list = el("next-step-checklist");
  list.replaceChildren(...step.checklist.map(item => {
    const entry = document.createElement("li");
    entry.textContent = item;
    return entry;
  }));
  renderNextStepLanguage();
  updateControls();
}

function present(candidate, method = "", label = "", box = null) {
  selection = candidate && { ...candidate, method, box };
  el("candidate").hidden = !candidate;
  el("candidate-label").textContent = label;
  el("number").textContent = candidate?.reference ?? "";
  el("quote").textContent = candidate?.quote ?? "";
  const lookalikes = lookalikeNote(candidate?.reference);
  el("character-check").hidden = !lookalikes;
  el("character-check").textContent = lookalikes;
  locateEvidence.hidden = !candidate || mode !== "scan";
  anchor = mode === "scan" ? boxAnchor(box, preview.naturalWidth, preview.naturalHeight) : null;
  paintAnchor();
  confirm.checked = false;
  apply.disabled = true;
  renderProgress();
}

function resetReview() {
  present(null);
  setOutcome(null);
  renderFinding(null);
  manualForm.reset();
  manual.open = false;
  el("manual-status").textContent = "";
}

function updateControls() {
  const canReview = mode === "scan" ? Boolean(currentImage) : Boolean(letter.value.trim());
  el("document-controls").disabled = busy;
  extract.disabled = busy || !inference || !canReview;
  extract.hidden = !inference;
  extractOcr.hidden = mode !== "scan";
  extractOcr.disabled = busy || !currentImage;
  extractLayout.hidden = mode !== "scan" || !inference;
  extractLayout.disabled = busy || !inference || !currentImage;
  for (const id of ["judge-referral", "judge-pending", "judge-conflicting", "judge-benchmark"]) el(id).disabled = busy;
  evaluate.disabled = busy || !inference;
  evaluateOcr.disabled = busy;
  el("evaluate-layout").disabled = busy || !inference;
  el("evaluate-heldout").disabled = busy || !inference;
  el("proof-run").disabled = busy || !inference;
  exportEvaluation.disabled = busy || !(latestBenchmark || latestOcrBenchmark || latestLayoutBenchmark);
  manual.inert = busy || !canReview;
  manual.hidden = !canReview;
  straighten.disabled = busy || scanLoading || !currentImage;
  el("next-step-run").disabled = busy || !inference || !outcomeCode;
}

function showIdleStatus() {
  if (busy) return;
  if (mode === "scan" && (scanLoading || scanError)) {
    localStatus.textContent = scanError || "Opening the supporting image.";
    return;
  }
  if (inferenceUnavailable) {
    localStatus.textContent = mode === "scan"
      ? "Local OCR reads the scan on this device."
      : "Use text matching to check the pasted letter.";
  } else {
    const availabilityNote = {
      available: "Gemini Nano image input is ready in this Chrome.",
      downloadable: "Gemini Nano is available to download when you start.",
      downloading: "Chrome is downloading Gemini Nano.",
      unavailable: "This Chrome profile reports Gemini Nano image input is unavailable.",
    }[deviceAvailability];
    localStatus.textContent = inference
      ? availabilityNote ?? "Chrome checks for Gemini Nano when you start."
      : "Checking Firebase configuration.";
  }
}

function clearScan() {
  if (scanDialog.open) scanDialog.close();
  if (imageURL) URL.revokeObjectURL(imageURL);
  imageURL = null;
  currentImage = null;
  originalImage = null;
  preview.hidden = true;
  fullScan.hidden = true;
  straighten.hidden = true;
  el("scan-view-status").textContent = "";
  preview.removeAttribute("src");
  preview.alt = "";
}

function showScan(image, label) {
  if (imageURL) URL.revokeObjectURL(imageURL);
  currentImage = image;
  imageURL = URL.createObjectURL(image);
  preview.alt = label;
  preview.src = imageURL;
  preview.hidden = false;
  fullScan.hidden = false;
  straighten.hidden = false;
  straighten.textContent = image === originalImage ? "Straighten scan" : "Show original scan";
}

async function bundledScan(fixture) {
  const response = await fetch(`./samples/${fixture.file}`);
  if (!response.ok) throw new Error("The bundled scan could not be loaded.");
  const image = await response.blob();
  return new Blob([image], { type: "image/png" });
}

async function loadScan(getImage, label) {
  const generation = ++pendingScan;
  clearScan();
  resetReview();
  scanLoading = true;
  scanError = "";
  updateControls();
  showIdleStatus();
  try {
    const image = await getImage();
    if (generation !== pendingScan) return;
    originalImage = image;
    showScan(image, label);
  } catch (error) {
    if (generation === pendingScan) scanError = error.message || "The scan could not be opened.";
  } finally {
    if (generation === pendingScan) {
      scanLoading = false;
      updateControls();
      showIdleStatus();
    }
  }
}

function loadSample() {
  const fixture = sample.value === "" ? null : (mode === "scan" ? SCAN_CASES : CASES)[Number(sample.value)];
  showSelectedScenario(mode === "scan" ? fixture?.file : null);
  if (!fixture) return;
  resetReview();
  if (mode === "scan") {
    fileInput.value = "";
    sample.querySelector('option[value=""]')?.remove();
    void loadScan(() => bundledScan(fixture), `Synthetic scan: ${fixture.label}`);
  } else {
    letter.value = fixture.text;
    updateControls();
    showIdleStatus();
  }
}

function showSelectedScenario(file) {
  for (const scenario of scenarios) scenario.setAttribute("aria-pressed", String(scenario.dataset.scan === file));
}

function setMode(nextMode, firstSample = 0) {
  mode = nextMode;
  pendingScan++;
  scanLoading = false;
  scanError = "";
  clearScan();
  el("scan-panel").hidden = mode !== "scan";
  el("text-panel").hidden = mode !== "text";
  const fixtures = mode === "scan" ? SCAN_CASES : CASES;
  sample.replaceChildren(...fixtures.map((fixture, index) => new Option(fixture.label, String(index))));
  sample.value = String(firstSample);
  loadSample();
}

function progressFor(status) {
  return ratio => {
    if (Number.isFinite(ratio)) {
      const percentage = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
      status.textContent = `Preparing Gemini Nano · ${percentage}%`;
    }
  };
}

function sourceAndTime({ source, duration }) {
  const location = source === "ON_DEVICE" ? "On-device" : "Cloud";
  return `${location} · ${duration} ms`;
}

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => setMode(radio.value));
}
el("payload").textContent = PUBLIC_PROMPT;
el("rule-id").textContent = PUBLIC_RULE.id;
el("policy-summary").textContent = PUBLIC_RULE.summary;
setMode(document.querySelector('input[name="mode"]:checked').value);

sample.addEventListener("change", loadSample);
el("judge-panel").hidden = new URLSearchParams(location.search).get("judge") !== "1";

function openJudgeSample(file) {
  const index = SCAN_CASES.findIndex(fixture => fixture.file === file);
  if (mode !== "scan") {
    document.querySelector('input[name="mode"][value="scan"]').checked = true;
    setMode("scan", index);
  } else {
    sample.value = String(index);
    loadSample();
  }
  sample.focus();
}

el("judge-referral").addEventListener("click", () => openJudgeSample("referral.png"));
el("judge-pending").addEventListener("click", () => openJudgeSample("pending.png"));
el("judge-conflicting").addEventListener("click", () => openJudgeSample("conflicting.png"));
el("judge-benchmark").addEventListener("click", () => {
  const benchmark = el("benchmark");
  benchmark.open = true;
  benchmark.querySelector("summary").focus();
});
function boxAnchor(box, width, height) {
  if (!box || !width || !height || box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height) return null;
  return {
    left: box.x0 / width, top: box.y0 / height,
    width: (box.x1 - box.x0) / width, height: (box.y1 - box.y0) / height,
  };
}

function paintAnchor() {
  marker.hidden = !anchor;
  previewMarker.hidden = !anchor || preview.hidden || !preview.naturalWidth;
  el("preview-evidence-status").hidden = previewMarker.hidden;
  if (!anchor) return;
  for (const [key, value] of Object.entries(anchor)) marker.style[key] = `${value * 100}%`;
  if (previewMarker.hidden) return;
  const scale = Math.min(preview.clientWidth / preview.naturalWidth, preview.clientHeight / preview.naturalHeight);
  const imageWidth = preview.naturalWidth * scale;
  const imageHeight = preview.naturalHeight * scale;
  const left = preview.offsetLeft + (preview.clientWidth - imageWidth) / 2;
  const top = preview.offsetTop + (preview.clientHeight - imageHeight) / 2;
  Object.assign(previewMarker.style, {
    left: `${left + anchor.left * imageWidth}px`, top: `${top + anchor.top * imageHeight}px`,
    width: `${anchor.width * imageWidth}px`, height: `${anchor.height * imageHeight}px`,
  });
}

preview.addEventListener("load", paintAnchor);
new ResizeObserver(paintAnchor).observe(dropZone);

function openScan(marking = false) {
  const fullPreview = el("full-preview");
  fullPreview.src = imageURL;
  fullPreview.alt = preview.alt;
  detailFrame.dataset.marking = String(marking);
  el("evidence-location").textContent = anchor ? "Evidence marked on scan." : "";
  paintAnchor();
  scanDialog.showModal();
}

fullScan.addEventListener("click", () => openScan());
scanDialog.addEventListener("close", () => {
  if (!scanDialog.open) el("full-preview").removeAttribute("src");
});

function enableManualMarking() {
  detailFrame.dataset.marking = "true";
  el("evidence-location").textContent = "Click the reference line to mark it for review.";
}

locateEvidence.addEventListener("click", async () => {
  if (!selection || !currentImage) return;
  const candidate = selection;
  const image = currentImage;
  openScan();
  if (anchor) return;
  const location = el("evidence-location");
  location.textContent = "Looking for the exact reference with local OCR.";
  try {
    const { locateOnScan } = await import("./ocr-evidence.mjs");
    const box = candidate.box ?? await locateOnScan(image, candidate.reference);
    if (!scanDialog.open || selection !== candidate || currentImage !== image) return;
    anchor = boxAnchor(box, preview.naturalWidth, preview.naturalHeight);
    if (!anchor) {
      enableManualMarking();
      return;
    }
    paintAnchor();
    location.textContent = "Local OCR matched the labeled reference. Compare it with the scan.";
  } catch {
    if (scanDialog.open && selection === candidate) enableManualMarking();
  }
});

detailFrame.addEventListener("click", event => {
  if (detailFrame.dataset.marking !== "true") return;
  const rect = detailFrame.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  anchor = { left: Math.max(0, Math.min(0.78, x - 0.11)), top: Math.max(0, Math.min(0.965, y - 0.0175)),
    width: 0.22, height: 0.035 };
  paintAnchor();
  el("evidence-location").textContent = "Reference line marked manually.";
});

straighten.addEventListener("click", async () => {
  const status = el("scan-view-status");
  const label = preview.alt;
  if (currentImage !== originalImage) {
    showScan(originalImage, label);
    resetReview();
    status.textContent = "Original scan shown.";
    return;
  }
  busy = true;
  updateControls();
  status.textContent = "Finding the page edges on this device.";
  try {
    const { straightenScan } = await import("./scan-cleanup.mjs");
    const corrected = await straightenScan(originalImage);
    if (corrected) {
      showScan(corrected, label);
      resetReview();
      status.textContent = "Straightened view shown. Use the original to check anything near the edges.";
    } else {
      status.textContent = "The page edges were uncertain. Original scan kept.";
    }
  } catch {
    status.textContent = "The scan could not be straightened. Original scan kept.";
  } finally {
    busy = false;
    updateControls();
  }
});
letter.addEventListener("input", () => {
  resetReview();
  updateControls();
  showIdleStatus();
});
function selectFile(file) {
  if (!file) return;
  showSelectedScenario(null);
  sample.querySelector('option[value=""]')?.remove();
  const selected = new Option("Selected scan", "", false, true);
  selected.disabled = true;
  sample.append(selected);
  sample.value = "";
  void loadScan(() => prepareScan(file), "Selected supporting document");
}
fileInput.addEventListener("change", () => selectFile(fileInput.files[0]));
dropZone.addEventListener("dragover", event => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = busy ? "none" : "copy";
  dropZone.classList.toggle("drag-active", !busy);
});
dropZone.addEventListener("dragleave", event => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("drag-active");
});
dropZone.addEventListener("drop", event => {
  event.preventDefault();
  dropZone.classList.remove("drag-active");
  if (busy || !event.dataTransfer.files.length) return;
  fileInput.value = "";
  selectFile(event.dataTransfer.files[0]);
});
confirm.addEventListener("change", () => { apply.disabled = !confirm.checked; });
apply.addEventListener("click", () => {
  if (confirm.checked && selection) {
    renderFinding(selection.reference, selection.method);
    recordTrace("Record reference", "HUMAN", "Confirmed against source");
    setOutcome("RECORDED");
    const confirmedAnchor = anchor;
    present(null);
    anchor = confirmedAnchor;
    paintAnchor();
    const finding = el("finding");
    finding.tabIndex = -1;
    finding.focus();
  }
});
manualForm.addEventListener("submit", event => {
  event.preventDefault();
  const reference = parseReference(el("manual-reference").value);
  if (!reference || !el("manual-confirm").checked) {
    el("manual-status").textContent = "Enter a 3–40 character reference with a digit. Use letters, numbers, or hyphens.";
    return;
  }
  resetReview();
  renderFinding(reference, "Manually confirmed");
  recordTrace("Record reference", "HUMAN", "Entered and confirmed manually");
  setOutcome("RECORDED");
  el("manual").querySelector("summary").focus();
});

el("match-text").addEventListener("click", () => {
  const result = matchLetter(letter.value);
  localStatus.textContent = result ? "Text matching found one labeled reference."
    : "Text matching found no single labeled reference.";
  recordTrace("Read pasted text", "LOCAL_TEXT", result ? "Candidate for review" : "No single reference");
  present(result, "Confirmed from pasted text", "Text match");
  setOutcome(result ? null : "NO_REFERENCE");
});

extractOcr.addEventListener("click", async () => {
  const image = currentImage;
  present(null);
  setOutcome(null);
  busy = true;
  updateControls();
  localStatus.textContent = "Reading the scan with local OCR.";
  const start = performance.now();
  try {
    const { readScanEvidence } = await import("./ocr-evidence.mjs");
    const { candidate, references } = await readScanEvidence(image);
    const conflict = references > 1;
    localStatus.textContent = conflict ? "Local OCR · More than one payer reference was found. Resolve the conflict manually."
      : candidate ? "Local OCR · Compare the proposed reference with the scan."
        : "Local OCR · No single payer reference was found.";
    present(conflict ? null : candidate, "Confirmed after local OCR", "Local OCR", candidate?.box);
    setOutcome(conflict ? "CONFLICT" : candidate ? null : "NO_REFERENCE");
    recordTrace("Read scan", "LOCAL_OCR", conflict ? "Conflict blocked" : candidate ? "Candidate for review" : "No single reference",
      Math.round(performance.now() - start));
  } catch {
    recordTrace("Read scan", "LOCAL_OCR", "OCR unavailable");
    localStatus.textContent = "Local OCR is unavailable. Review the scan and enter the reference manually.";
  } finally {
    busy = false;
    updateControls();
  }
});

const layoutMessages = {
  review: ["The OCR value in that slot is shown for confirmation.", "Candidate for review"],
  empty: ["Gemini found no payer reference slot.", "Abstained"],
  unsupported: ["That slot is not labeled as a payer reference, so it was blocked.", "Suggestion blocked"],
  conflict: ["More than one payer reference is labeled on this page. Resolve the conflict manually.", "Conflict blocked"],
  disagreement: ["Gemini's slot and the OCR rule disagree. Review the scan before manual entry.", "Disagreement blocked"],
  uncorroborated: ["OCR is not confident in that value. Review the scan before manual entry.", "Uncorroborated proposal blocked"],
};

// The private layout read, shared by the button and the judge proof run. Returns what happened.
async function readPrivateLayout() {
  const image = currentImage;
  const step = { at: new Date().toISOString() };
  present(null);
  setOutcome(null);
  busy = true;
  updateControls();
  el("layout-request").hidden = true;
  localStatus.textContent = "Reading the scan with local OCR, then removing identifier values.";
  try {
    const [{ readScanLayoutEvidence }, { buildLayout, layoutPrompt, resolveLayoutSlot, leakGate, sha256Hex }] = await Promise.all([
      import("./ocr-evidence.mjs"), import("./layout-read.mjs"),
    ]);
    const evidence = await readScanLayoutEvidence(image);
    const layout = buildLayout(evidence.lines);
    const prompt = layoutPrompt(layout.layout);
    el("layout-request-text").textContent = prompt;
    el("layout-request").hidden = false;
    const gate = leakGate(prompt, layout);
    const hash = await sha256Hex(prompt);
    Object.assign(step, { requestBytes: gate.bytes, requestSha256: hash, identifiersInRequest: gate.identifiers, slots: layout.slots.length });
    el("layout-receipt").textContent = gate.ok
      ? `Leak gate passed: 0 identifiers in ${gate.bytes} outbound bytes · SHA-256 ${hash.slice(0, 16)}…`
      : `Leak gate blocked the call: ${gate.identifiers} identifier(s) found in the outbound text.`;
    el("layout-receipt").dataset.ok = String(gate.ok);
    if (!gate.ok) {
      recordTrace("Read private layout", "UNCONFIRMED", "Blocked by leak gate");
      localStatus.textContent = "The leak gate found an identifier in the outbound text, so nothing was sent. Use local OCR or enter the reference manually.";
      setOutcome("NEEDS_REVIEW");
      return { ...step, blocked: "leak gate" };
    }
    localStatus.textContent = "Asking Gemini for the slot · on-device first, cloud fallback.";
    const response = await inference.readLayout(prompt);
    const decision = resolveLayoutSlot(response.text, layout, evidence);
    const [message, outcome] = layoutMessages[decision.status];
    const route = response.source === "ON_DEVICE" ? "Gemini Nano on this device" : "Cloud fallback · values stayed on this device";
    localStatus.textContent = `${sourceAndTime(response)} · ${route} · Picked ${decision.pick ?? "nothing usable"} · ${message}`;
    recordTrace("Read private layout", response.source, outcome, response.duration);
    present(decision.candidate, "Confirmed after private layout read", `Gemini slot ${decision.pick} + local OCR`, decision.box);
    setOutcome(nextStepCode(decision.status));
    return { ...step, route: response.source, ms: response.duration, modelPick: decision.pick ?? null,
      guard: decision.status, shownForConfirmation: decision.candidate?.reference ?? null, outcomeCode: nextStepCode(decision.status) };
  } catch (error) {
    recordTrace("Read private layout", "UNCONFIRMED", "Inference unavailable");
    const limited = rateLimitDelayMs(error) !== null;
    localStatus.textContent = limited
      ? "The demo's free Gemini quota (15 requests per minute) is busy. Wait a few seconds and try again, or use local OCR."
      : "The private layout read is unavailable. Use local OCR or enter the reference manually.";
    return { ...step, error: limited ? "rate limited" : "unavailable" };
  } finally {
    busy = false;
    updateControls();
  }
}

extractLayout.addEventListener("click", () => { readPrivateLayout(); });

// Judge proof run: one pass through a clean scan and a conflict, with the evidence, the exact
// sanitized request, the SDK-reported route, the guard's decision, a human confirmation and the
// claim verdict, then a downloadable receipt. Two model calls, well inside the free quota.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function openScanAndWait(file) {
  const before = currentImage;
  openJudgeSample(file);
  for (let i = 0; i < 100 && (currentImage === before || !currentImage || busy); i += 1) await sleep(100);
  await sleep(300);
}

function proofStep(index, state, text) {
  const item = el("proof-steps").children[index];
  item.dataset.state = state;
  item.querySelector(".proof-detail").textContent = text;
}

let proofReceipt = null;
el("proof-run").addEventListener("click", async () => {
  if (busy || !inference) return;
  const runButton = el("proof-run");
  runButton.disabled = true;
  el("proof-download").hidden = true;
  el("proof").hidden = false;
  for (const item of el("proof-steps").children) { item.dataset.state = "waiting"; item.querySelector(".proof-detail").textContent = ""; }
  fillClaim(DEMO_CLAIM);
  proofReceipt = { kind: "claimguard-proof-run", build, startedAt: new Date().toISOString(), scope: "Synthetic documents only. No reference values or document text below; values shown are synthetic demo references.", steps: [] };
  const guardWords = { review: "passed, shown for your confirmation", conflict: "held, two payer references", empty: "held, no payer reference",
    unsupported: "blocked, not labeled as a payer reference", disagreement: "held, OCR disagrees", uncorroborated: "held, OCR not confident" };
  const describe = read => read.error ? `Not completed: ${read.error}. Try again in a few seconds.`
    : `${routeNames[read.route] ?? read.route} · ${read.ms ?? "?"} ms · request ${read.requestBytes} bytes, ${read.identifiersInRequest} identifiers, SHA-256 ${read.requestSha256.slice(0, 12)}… · Gemini picked ${read.modelPick} · guard ${guardWords[read.guard] ?? read.guard}`;
  try {
    // 1. Clean scan
    proofStep(0, "running", "Reading the specialist referral: OCR on this device, slots only to Gemini.");
    await openScanAndWait("referral.png");
    const clean = await readPrivateLayout();
    proofReceipt.steps.push({ step: "clean scan", ...clean });
    proofStep(0, clean.shownForConfirmation ? "done" : "failed", `${describe(clean)}${clean.shownForConfirmation ? ` · highlighted ${clean.shownForConfirmation} on the scan` : ""}`);
    if (!clean.shownForConfirmation) throw new Error("clean");
    // 2. Human confirmation
    proofStep(1, "running", "Your turn: compare the highlighted line with the scan, tick the box, then click Record reference.");
    el("candidate").scrollIntoView({ behavior: "smooth", block: "center" });
    await new Promise(resolve => apply.addEventListener("click", resolve, { once: true }));
    await sleep(200);
    const ready = el("claim-verdict").textContent;
    proofReceipt.steps.push({ step: "clerk confirmation", at: new Date().toISOString(), by: "person at the keyboard", claimVerdict: ready });
    proofStep(1, "done", `Recorded by you · claim pre-check: ${ready}`);
    // 3. Conflict
    proofStep(2, "running", "Reading a page with two payer references.");
    el("judge-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    await openScanAndWait("conflicting.png");
    const conflict = await readPrivateLayout();
    const held = el("claim-verdict").textContent;
    proofReceipt.steps.push({ step: "conflicting references", ...conflict, claimVerdict: held });
    proofStep(2, conflict.error ? "failed" : "done", `${describe(conflict)} · nothing offered · claim pre-check: ${held}`);
    // 4. Next step, without sending anything
    const request = nextStepPrompt("CONFLICT");
    proofReceipt.steps.push({ step: "next-step request (not sent)", outcomeCode: "CONFLICT", requestBytes: new TextEncoder().encode(request).length });
    proofStep(3, "done", `Only the outcome code reaches the model for guidance: a fixed ${new TextEncoder().encode(request).length}-byte public checklist request. Open "Next step" below to send it, or to see it in Kiswahili.`);
    proofReceipt.finishedAt = new Date().toISOString();
    el("proof-download").hidden = false;
  } catch {
    proofReceipt.finishedAt = new Date().toISOString();
    el("proof-download").hidden = false;
  } finally {
    runButton.disabled = false;
  }
});
el("proof-download").addEventListener("click", () => { if (proofReceipt) downloadJson(proofReceipt, "claimguard-proof-receipt.json"); });

extract.addEventListener("click", async () => {
  const scanning = mode === "scan";
  const image = currentImage;
  const text = letter.value;
  present(null);
  busy = true;
  updateControls();
  localStatus.textContent = "Preparing Gemini Nano.";
  try {
    await inference.prepareLocal(progressFor(localStatus));
    localStatus.textContent = "Reading the supporting document on this device.";
    const response = scanning
      ? await inference.extractScan(await scanPart(image))
      : await inference.extract(text);
    const result = scanning ? reviewScanSuggestion(response.text) : verifySuggestion(text, response.text);
    let decision = result;
    if (scanning) {
      localStatus.textContent = "Cross-checking with local OCR.";
      let evidence = { references: 0, candidate: null };
      try {
        const { readScanEvidence } = await import("./ocr-evidence.mjs");
        evidence = await readScanEvidence(image);
      } catch {
        // With no independent read, a model proposal cannot enter confirmation.
      }
      decision = decideScanReview(result, evidence);
    }
    const messages = {
      review: ["Local OCR agrees. Confirm the highlighted reference against the scan.", "Candidate for review"],
      verified: ["The quote matches the pasted letter.", "Quote matched"],
      empty: ["No single payer reference was suggested.", "Abstained"],
      unsupported: ["The output could not be used. Review the original document.", "Suggestion blocked"],
      conflict: ["OCR found multiple payer references. Resolve the conflict and enter the verified reference manually.", "Conflict blocked"],
      disagreement: ["Nano and OCR read different references. Review the scan before manual entry.", "Disagreement blocked"],
      uncorroborated: ["OCR could not confirm the reference. Review the scan before manual entry.", "Uncorroborated proposal blocked"],
    };
    const [message, outcome] = messages[decision.status];
    localStatus.textContent = `${sourceAndTime(response)} · ${message}`;
    recordTrace("Read with Nano", response.source, outcome, response.duration);
    present(decision.candidate, "Confirmed after on-device review", scanning ? "Nano + local OCR" : "Matched quote",
      decision.box);
    setOutcome(nextStepCode(decision.status));
  } catch {
    recordTrace("Read with Nano", "UNCONFIRMED", "Inference unavailable");
    localStatus.textContent = "On-device inference unavailable. Review the original and enter the reference manually.";
  } finally {
    busy = false;
    updateControls();
  }
});

async function explainPolicy(hybrid) {
  const status = el("cloud-status");
  const explanation = el("explanation");
  explain.disabled = true;
  explainHybrid.disabled = true;
  explanation.textContent = "";
  status.textContent = "Explaining the synthetic policy with Firebase AI Logic.";
  try {
    const response = await (hybrid ? inference.explainHybrid() : inference.explain());
    const route = !hybrid ? "Cloud-only request"
      : response.source === "ON_DEVICE" ? "Answered by Gemini Nano on this device"
        : "Gemini Nano was not ready, so Firebase AI Logic fell back to the cloud";
    status.textContent = `${sourceAndTime(response)} · ${route}`;
    explanation.textContent = response.text;
    recordTrace(hybrid ? "Explain policy (hybrid)" : "Explain policy (cloud only)", response.source,
      hybrid && response.source === "IN_CLOUD" ? "Cloud fallback" : "Explanation returned", response.duration, true);
  } catch {
    recordTrace("Explain policy", "UNCONFIRMED", "Explanation unavailable", null, true);
    status.textContent = "AI explanation unavailable. Review the synthetic policy above.";
  } finally {
    explain.disabled = false;
    explainHybrid.disabled = false;
  }
}

claimForm.addEventListener("input", renderClaimCheck);
claimForm.addEventListener("change", renderClaimCheck);
el("claim-errors").addEventListener("click", () => {
  fillClaim(DEMO_CLAIM_WITH_ERRORS);
  recordTrace("Claim pre-check", "LOCAL_RULES", "Loaded claim with errors");
});
el("claim-reset").addEventListener("click", () => fillClaim(DEMO_CLAIM));
el("claim-export").addEventListener("click", () => {
  const result = renderClaimCheck();
  downloadJson(operationOutcome(result), "claimguard-claim-check.json");
  recordTrace("Claim pre-check", "LOCAL_RULES", result.verdict === "ready" ? "Ready to submit" : "Hold exported");
});
fillClaim(DEMO_CLAIM);

for (const radio of document.querySelectorAll('input[name="next-step-language"]')) {
  radio.addEventListener("change", () => {
    el("next-step-status").textContent = "";
    el("next-step-text").textContent = "";
    renderNextStepLanguage();
  });
}

el("next-step-run").addEventListener("click", async () => {
  const code = outcomeCode;
  const language = nextStepLanguage();
  if (!code || !inference) return;
  const status = el("next-step-status");
  const text = el("next-step-text");
  busy = true;
  updateControls();
  text.textContent = "";
  status.textContent = "Asking Firebase AI Logic for the next step.";
  try {
    const response = await inference.nextStep(code, language);
    const route = response.source === "ON_DEVICE" ? "Answered by Gemini Nano on this device"
      : language === "sw" ? "Kiswahili is not a Gemini Nano output language, so this public request ran in the cloud"
        : "Gemini Nano was not ready, so Firebase AI Logic fell back to the cloud";
    const grounded = groundNextStep(response.text);
    status.textContent = grounded.ok ? `${sourceAndTime(response)} · ${route}`
      : `${sourceAndTime(response)} · ${route} · Answer discarded (${grounded.reason} not in the checklist). Follow the checklist above.`;
    text.textContent = grounded.ok ? response.text : "";
    recordTrace(`Next step (${NEXT_STEPS[code].label}, ${NEXT_STEP_LANGUAGES[language].name})`, response.source,
      language === "sw" ? "Cloud by language" : response.source === "IN_CLOUD" ? "Cloud fallback" : "Guidance returned", response.duration, true);
  } catch {
    recordTrace("Next step", "UNCONFIRMED", "Guidance unavailable", null, true);
    status.textContent = "AI guidance unavailable. Follow the checklist above.";
  } finally {
    busy = false;
    updateControls();
  }
});

explain.addEventListener("click", () => explainPolicy(false));
explainHybrid.addEventListener("click", () => explainPolicy(true));

function renderBenchmark(report) {
  const { status, summary } = report;
  const { correctOutcomes, planned, counts, wrongProposalsBlocked, latencyMs, quoteCharacters } = summary;
  const prefix = { partial: "Partial run · ", failed: "Benchmark failed · " }[status] ?? "";
  el("eval-status").textContent = status === "not_run"
    ? "Benchmark did not run. Gemini Nano could not be prepared."
    : `${prefix}${correctOutcomes}/${planned} correct outcomes · ${Object.entries(counts).map(([name, count]) => `${count} ${name.toLowerCase()}`).join(" · ")}`;
  const notes = [];
  if (wrongProposalsBlocked) notes.push(`Wrong model proposals blocked: ${wrongProposalsBlocked}`);
  if (summary.guarded) notes.push(`Nano + OCR gate: ${summary.guarded.correct}/${planned} correct · ${summary.guarded.wrongProposalsBlocked} wrong proposals blocked · ${summary.guarded.measured} measured`);
  if (latencyMs.samples) notes.push(`Inference p50 ${latencyMs.p50} ms · p95 ${latencyMs.p95} ms (${latencyMs.samples} responses)`);
  if (quoteCharacters.quotesScored) notes.push(`Quote character error ${(quoteCharacters.errorRate * 100).toFixed(1)}% (${quoteCharacters.quotesScored} lines)`);
  el("eval-metrics").textContent = notes.join(" · ");
}

function renderBenchmarkRows() {
  const nanoRows = latestBenchmark?.rows ?? [];
  const ocrRows = latestOcrBenchmark?.rows ?? [];
  const rows = nanoRows.length ? nanoRows : ocrRows;
  const paired = nanoRows.length > 0 && ocrRows.length > 0;
  const baseline = new Map(ocrRows.map(row => [row.sample, row]));
  el("eval-table").hidden = !rows.length;
  el("eval-ocr-column").hidden = !paired;
  const body = el("eval-results");
  body.replaceChildren();
  for (const row of rows) {
    const line = body.insertRow();
    const method = routeNames[row.inferenceSource];
    const values = [
      row.label, row.expectedReference ?? "Abstain", row.modelSuggestion || "—",
      row.guarded ? `${row.outcome} · Gate: ${row.guarded.outcome}` : row.outcome,
      row.inferenceMs != null ? `${method} · ${row.inferenceMs} ms` : method ?? "-",
    ];
    if (paired) {
      const result = baseline.get(row.sample);
      const sameScan = result && row.sampleSha256 && row.sampleSha256 === result.sampleSha256;
      values.push(sameScan ? `${result.outcome}${result.modelSuggestion ? ` · ${result.modelSuggestion}` : ""}` : "No matching scan");
    }
    for (const value of values) line.insertCell().textContent = value;
  }
}

function renderComparison() {
  const comparison = compareBenchmarkRuns(latestBenchmark, latestOcrBenchmark);
  el("eval-comparison").textContent = comparison
    ? `${comparison.paired} jointly scored · both correct ${comparison.bothCorrect} · Nano only ${comparison.onlyNanoCorrect} · OCR only ${comparison.onlyOcrCorrect} · neither correct ${comparison.neitherCorrect}`
    : "";
}

evaluate.addEventListener("click", async () => {
  const status = el("eval-status");
  el("eval-metrics").textContent = "";
  latestBenchmark = null;
  renderComparison();
  renderBenchmarkRows();
  busy = true;
  updateControls();
  status.textContent = "Preparing Gemini Nano.";
  try {
    latestBenchmark = await runScanBenchmark({
      prepare: () => inference.prepareLocal(progressFor(status)),
      readSample: bundledScan,
      infer: async image => inference.extractScan(await scanPart(image)),
      readEvidence: async image => (await import("./ocr-evidence.mjs")).readScanEvidence(image),
      onProgress: (current, total) => { status.textContent = `Reading scan ${current} of ${total} on-device.`; },
    });
    renderBenchmark(latestBenchmark);
    renderBenchmarkRows();
    renderComparison();
  } finally {
    busy = false;
    updateControls();
    showIdleStatus();
  }
});

evaluateOcr.addEventListener("click", async () => {
  const status = el("eval-ocr-status");
  latestOcrBenchmark = null;
  renderComparison();
  renderBenchmarkRows();
  busy = true;
  updateControls();
  status.textContent = "Preparing the local OCR engine.";
  try {
    const { prepareOcr, readScanReference } = await import("./ocr-evidence.mjs");
    latestOcrBenchmark = await runOcrBenchmark({
      prepare: prepareOcr,
      readSample: bundledScan,
      readReference: readScanReference,
      onProgress: (current, total) => { status.textContent = `Reading scan ${current} of ${total} with local OCR.`; },
    });
    if (latestOcrBenchmark.status === "not_run") {
      status.textContent = "The local OCR engine could not be prepared.";
    } else {
      const { summary } = latestOcrBenchmark;
      const timings = summary.latencyMs.samples ? ` · p50 ${summary.latencyMs.p50} ms · p95 ${summary.latencyMs.p95} ms` : "";
      status.textContent = `OCR baseline · ${summary.correctOutcomes}/${summary.planned} correct outcomes${timings}`;
    }
    renderBenchmarkRows();
    renderComparison();
  } catch {
    status.textContent = "The local OCR benchmark could not be loaded.";
  } finally {
    busy = false;
    updateControls();
  }
});

exportEvaluation.addEventListener("click", () => {
  if (!latestBenchmark && !latestOcrBenchmark && !latestLayoutBenchmark) return;
  downloadJson({ ...shareableBenchmark(latestBenchmark, latestOcrBenchmark, latestLayoutBenchmark), build }, "claimguard-web-benchmark.json");
});

async function runLayout(fixtures, readSample, label) {
  const status = el("eval-layout-status");
  latestLayoutBenchmark = null;
  el("eval-layout-table").hidden = true;
  el("eval-layout-metrics").textContent = "";
  busy = true;
  updateControls();
  status.textContent = "Preparing local OCR for the private layout run.";
  try {
    const [ocr, layoutRead] = await Promise.all([import("./ocr-evidence.mjs"), import("./layout-read.mjs")]);
    await ocr.prepareOcr();
    latestLayoutBenchmark = await runLayoutBenchmark({
      fixtures, readSample,
      readLayoutEvidence: ocr.readScanLayoutEvidence,
      readLayout: prompt => inference.readLayout(prompt),
      ...layoutRead,
      paceMs: 4200,
      onProgress: (current, total) => { status.textContent = `${label} · document ${current} of ${total} · paced under the free-tier limit of 15 requests per minute.`; },
    });
    const { summary, rows } = latestLayoutBenchmark;
    const readable = rows.filter(row => row.expectedReference !== null);
    const hold = rows.filter(row => row.expectedReference === null);
    const shown = row => ["Correct extraction", "Wrong suggestion", "False suggestion"].includes(row.outcome);
    const routes = Object.entries(summary.routes).map(([route, n]) => `${n} ${route === "ON_DEVICE" ? "on-device" : "cloud"}`).join(" · ");
    status.textContent = `${label} · Of ${readable.length} readable documents, ${readable.filter(row => row.outcome === "Correct extraction").length} extracted correctly, `
      + `${readable.filter(row => !shown(row)).length} held, ${readable.filter(row => row.outcome === "Wrong suggestion").length} shown with a wrong value. `
      + `Of ${hold.length} that must be held, ${hold.filter(row => !shown(row)).length} held and ${hold.filter(shown).length} wrongly offered. Routes: ${routes || "none"}.`;
    const sweep = summary.guardSweep;
    const lost = Object.entries(summary.lostAt).map(([stage, n]) => `${n} at ${stage}`).join(" · ");
    el("eval-layout-metrics").textContent = [
      `Guard sweep: ${sweep.picksTried} possible picks · ${sweep.wrongShown} would show a wrong value`,
      lost ? `Misses: ${lost}` : "No misses",
      summary.latencyMs.samples ? `p50 ${summary.latencyMs.p50} ms · p95 ${summary.latencyMs.p95} ms` : "",
    ].filter(Boolean).join(" · ");
    const body = el("eval-layout-results");
    body.replaceChildren();
    for (const row of rows) {
      const line = body.insertRow();
      for (const value of [
        row.label, row.expectedReference ?? "Hold", row.pick ?? "—", row.outcome, row.lostAt ?? "—",
        row.inferenceSource ? `${routeNames[row.inferenceSource]}${row.inferenceMs != null ? ` · ${row.inferenceMs} ms` : ""}` : "-",
      ]) line.insertCell().textContent = value;
    }
    el("eval-layout-table").hidden = false;
  } catch {
    status.textContent = `${label} could not run.`;
  } finally {
    busy = false;
    updateControls();
  }
}

el("evaluate-heldout").addEventListener("click", async () => {
  const response = await fetch("./heldout/cases-b.json");
  if (!response.ok) { el("eval-layout-status").textContent = "The held-out set could not be loaded."; return; }
  const { documents } = await response.json();
  const fixtures = documents.map(doc => ({ file: doc.file, label: `${doc.file} · ${doc.note}`, expected: doc.expected }));
  await runLayout(fixtures, async fixture => {
    const image = await fetch(`./heldout/${fixture.file}`);
    if (!image.ok) throw new Error("missing");
    return image.blob();
  }, "Held-out set B");
});

el("evaluate-layout").addEventListener("click", async () => {
  const status = el("eval-layout-status");
  latestLayoutBenchmark = null;
  el("eval-layout-table").hidden = true;
  el("eval-layout-metrics").textContent = "";
  busy = true;
  updateControls();
  status.textContent = "Preparing local OCR for the private layout run.";
  try {
    const [ocr, layoutRead] = await Promise.all([import("./ocr-evidence.mjs"), import("./layout-read.mjs")]);
    await ocr.prepareOcr();
    latestLayoutBenchmark = await runLayoutBenchmark({
      readSample: bundledScan,
      readLayoutEvidence: ocr.readScanLayoutEvidence,
      readLayout: prompt => inference.readLayout(prompt),
      ...layoutRead,
      paceMs: 4200,
      onProgress: (current, total) => { status.textContent = `Private layout · scan ${current} of ${total}.`; },
    });
    const { summary } = latestLayoutBenchmark;
    const routes = Object.entries(summary.routes).map(([route, n]) => `${n} ${route === "ON_DEVICE" ? "on-device" : "cloud"}`).join(" · ");
    const lost = Object.entries(summary.lostAt).map(([stage, n]) => `${n} at ${stage}`).join(" · ");
    status.textContent = `Private layout · ${summary.correctOutcomes}/${summary.planned} correct · routes: ${routes || "none"}`;
    const sweep = summary.guardSweep;
    el("eval-layout-metrics").textContent = [
      sweep.scans ? `Guard sweep: every slot tried on ${sweep.scans} scans (${sweep.picksTried} picks) · ${sweep.wrongShown} wrong values shown` : "",
      summary.wrongProposalsBlocked ? `Wrong slot picks blocked: ${summary.wrongProposalsBlocked}` : "",
      lost ? `Misses: ${lost}` : "No misses",
      summary.latencyMs.samples ? `p50 ${summary.latencyMs.p50} ms · p95 ${summary.latencyMs.p95} ms` : "",
    ].filter(Boolean).join(" · ");
    const body = el("eval-layout-results");
    body.replaceChildren();
    for (const row of latestLayoutBenchmark.rows) {
      const line = body.insertRow();
      for (const value of [
        row.label, row.expectedReference ?? "Abstain", row.pick ?? "—", row.outcome, row.lostAt ?? "—",
        row.inferenceSource ? `${routeNames[row.inferenceSource]}${row.inferenceMs != null ? ` · ${row.inferenceMs} ms` : ""}` : "-",
      ]) line.insertCell().textContent = value;
    }
    el("eval-layout-table").hidden = false;
  } catch {
    status.textContent = "The private layout benchmark could not run.";
  } finally {
    busy = false;
    updateControls();
  }
});

setupInference().then(client => {
  inference = client;
  explain.disabled = false;
  explainHybrid.disabled = false;
  void imageModelAvailability().then(availability => {
    deviceAvailability = availability;
    if (!busy && localStatus.textContent.startsWith("Chrome checks")) showIdleStatus();
  });
}).catch(() => {
  inferenceUnavailable = true;
  el("cloud-status").textContent = "Cloud explanation requires a configured Firebase project.";
}).finally(() => {
  updateControls();
  showIdleStatus();
});

// Offline support (HTTPS only): the worker caches the app, samples and OCR data for airplane mode.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
