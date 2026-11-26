import {
  CASES, PUBLIC_PROMPT, PUBLIC_RULE, SCAN_CASES, compareReferenceEvidence, matchLetter, parseReference, preauthorizationFinding,
  reviewScanSuggestion, verifySuggestion,
} from "./evidence.mjs";
import { compareBenchmarkRuns, runOcrBenchmark, runScanBenchmark } from "./benchmark.mjs";
import { imageModelAvailability } from "./browser-readiness.mjs";
import { setupInference } from "./firebase-ai.mjs";
import { prepareScan, scanPart } from "./scan.mjs";

const el = id => document.getElementById(id);
const sample = el("sample");
const letter = el("letter");
const fileInput = el("scan-file");
const dropZone = el("scan-drop");
const preview = el("scan-preview");
const fullScan = el("full-scan");
const scanDialog = el("scan-dialog");
const straighten = el("straighten");
const locateEvidence = el("locate-evidence");
const detailFrame = el("detail-frame");
const marker = el("evidence-marker");
const extract = el("extract");
const extractOcr = el("extract-ocr");
const evaluate = el("evaluate");
const evaluateOcr = el("evaluate-ocr");
const exportEvaluation = el("export-evaluation");
const explain = el("explain");
const confirm = el("confirm");
const apply = el("apply");
const localStatus = el("local-status");
const manual = el("manual");
const manualForm = el("manual-form");
const steps = [...el("review-steps").children];

let mode = "scan";
let inference;
let inferenceUnavailable = false;
let busy = false;
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
let anchor;

function renderProgress() {
  const recorded = el("finding").dataset.pass === "true";
  const current = selection ? 1 : recorded ? 2 : 0;
  steps.forEach((step, index) => {
    step.classList.toggle("complete", index < current);
    if (index === current) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

function renderFinding(reference, method = "") {
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

function present(candidate, method = "", label = "", box = null) {
  selection = candidate && { ...candidate, method, box };
  el("candidate").hidden = !candidate;
  el("candidate-label").textContent = label;
  el("number").textContent = candidate?.reference ?? "";
  el("quote").textContent = candidate?.quote ?? "";
  locateEvidence.hidden = !candidate || mode !== "scan";
  anchor = null;
  confirm.checked = false;
  apply.disabled = true;
  renderProgress();
}

function resetReview() {
  present(null);
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
  for (const id of ["judge-referral", "judge-pending", "judge-benchmark"]) el(id).disabled = busy;
  evaluate.disabled = busy || !inference;
  evaluateOcr.disabled = busy;
  exportEvaluation.disabled = busy || !(latestBenchmark || latestOcrBenchmark);
  manual.inert = busy || !canReview;
  manual.hidden = !canReview;
  straighten.disabled = busy || scanLoading || !currentImage;
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
  const fixture = (mode === "scan" ? SCAN_CASES : CASES)[Number(sample.value)];
  if (!fixture || sample.value === "") return;
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

function setMode(nextMode, firstSample = 0) {
  mode = nextMode;
  pendingScan++;
  scanLoading = false;
  scanError = "";
  clearScan();
  el("scan-panel").hidden = mode !== "scan";
  el("text-panel").hidden = mode !== "text";
  extract.textContent = mode === "scan" ? "Read scan on-device" : "Read letter on-device";
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
el("judge-benchmark").addEventListener("click", () => {
  const benchmark = el("benchmark");
  benchmark.open = true;
  benchmark.querySelector("summary").focus();
});
function paintAnchor() {
  marker.hidden = !anchor;
  if (!anchor) return;
  for (const [key, value] of Object.entries(anchor)) marker.style[key] = `${value * 100}%`;
}

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
    const view = el("full-preview");
    if (!scanDialog.open || selection !== candidate || currentImage !== image) return;
    if (!box || !view.naturalWidth || box.x1 > view.naturalWidth || box.y1 > view.naturalHeight) {
      enableManualMarking();
      return;
    }
    anchor = {
      left: box.x0 / view.naturalWidth, top: box.y0 / view.naturalHeight,
      width: (box.x1 - box.x0) / view.naturalWidth, height: (box.y1 - box.y0) / view.naturalHeight,
    };
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
    const confirmedAnchor = anchor;
    present(null);
    anchor = confirmedAnchor;
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
  el("manual").querySelector("summary").focus();
});

el("match-text").addEventListener("click", () => {
  const result = matchLetter(letter.value);
  localStatus.textContent = result ? "Text matching found one labeled reference."
    : "Text matching found no single labeled reference.";
  present(result, "Confirmed from pasted text", "Text match");
});

extractOcr.addEventListener("click", async () => {
  const image = currentImage;
  present(null);
  busy = true;
  updateControls();
  localStatus.textContent = "Reading the scan with local OCR.";
  try {
    const { readScanReference } = await import("./ocr-evidence.mjs");
    const candidate = await readScanReference(image);
    localStatus.textContent = candidate
      ? "Local OCR · Compare the proposed reference with the scan."
      : "Local OCR · No single payer reference was found.";
    present(candidate, "Confirmed after local OCR", "Local OCR", candidate?.box);
  } catch {
    localStatus.textContent = "Local OCR is unavailable. Review the scan and enter the reference manually.";
  } finally {
    busy = false;
    updateControls();
  }
});

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
    let independent = null;
    if (scanning && result.candidate) {
      localStatus.textContent = "Cross-checking the proposed reference against local OCR.";
      try {
        const { readScanReference } = await import("./ocr-evidence.mjs");
        independent = await readScanReference(image);
      } catch {
        // The clerk can verify the source directly when the OCR worker is unavailable.
      }
      const check = compareReferenceEvidence(result.candidate, independent);
      if (check === "conflict") {
        localStatus.textContent = `${sourceAndTime(response)} · Nano and local OCR read different references. Review the scan and enter the reference manually.`;
        return;
      }
    }
    const message = {
      review: independent ? "Local OCR agrees. Confirm the reference against the scan."
        : "Local OCR could not confirm the number. Compare it directly with the scan.",
      verified: "The quote matches the pasted letter.",
      empty: "No single payer reference was suggested.",
      unsupported: "The output could not be used. Review the original document.",
    }[result.status];
    localStatus.textContent = `${sourceAndTime(response)} · ${message}`;
    present(result.candidate, "Confirmed after on-device review", scanning ? "Nano transcription" : "Matched quote",
      independent?.box);
  } catch {
    localStatus.textContent = "On-device inference unavailable. Review the original and enter the reference manually.";
  } finally {
    busy = false;
    updateControls();
  }
});

explain.addEventListener("click", async () => {
  const status = el("cloud-status");
  const explanation = el("explanation");
  explain.disabled = true;
  explanation.textContent = "";
  status.textContent = "Sending the public rule to Firebase AI Logic.";
  try {
    const response = await inference.explain();
    status.textContent = `${sourceAndTime(response)} · AI explanation`;
    explanation.textContent = response.text;
  } catch {
    status.textContent = "Cloud explanation unavailable. Review the synthetic policy above.";
  } finally {
    explain.disabled = false;
  }
});

function renderBenchmark(report) {
  const { status, summary, rows } = report;
  const { correctOutcomes, planned, counts, wrongProposalsBlocked, latencyMs, quoteCharacters } = summary;
  const prefix = { partial: "Partial run · ", failed: "Benchmark failed · " }[status] ?? "";
  el("eval-status").textContent = status === "not_run"
    ? "Benchmark did not run. Gemini Nano could not be prepared."
    : `${prefix}${correctOutcomes}/${planned} correct outcomes · ${Object.entries(counts).map(([name, count]) => `${count} ${name.toLowerCase()}`).join(" · ")}`;
  const notes = [];
  if (wrongProposalsBlocked) notes.push(`Wrong model proposals blocked: ${wrongProposalsBlocked}`);
  if (latencyMs.samples) notes.push(`Inference p50 ${latencyMs.p50} ms · p95 ${latencyMs.p95} ms (${latencyMs.samples} responses)`);
  if (quoteCharacters.quotesScored) notes.push(`Quote character error ${(quoteCharacters.errorRate * 100).toFixed(1)}% (${quoteCharacters.quotesScored} lines)`);
  el("eval-metrics").textContent = notes.join(" · ");
  el("eval-table").hidden = !rows.length;
  const body = el("eval-results");
  for (const row of rows) {
    const line = body.insertRow();
    const values = [
      row.label, row.expectedReference ?? "Abstain", row.modelSuggestion || "—", row.outcome,
      row.inferenceMs != null ? `${row.inferenceMs} ms · on-device` : "—",
    ];
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
  el("eval-results").replaceChildren();
  el("eval-metrics").textContent = "";
  el("eval-table").hidden = true;
  latestBenchmark = null;
  renderComparison();
  busy = true;
  updateControls();
  status.textContent = "Preparing Gemini Nano.";
  try {
    latestBenchmark = await runScanBenchmark({
      prepare: () => inference.prepareLocal(progressFor(status)),
      readSample: async fixture => scanPart(await bundledScan(fixture)),
      infer: data => inference.extractScan(data),
      onProgress: (current, total) => { status.textContent = `Reading scan ${current} of ${total} on-device.`; },
    });
    renderBenchmark(latestBenchmark);
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
    renderComparison();
  } catch {
    status.textContent = "The local OCR benchmark could not be loaded.";
  } finally {
    busy = false;
    updateControls();
  }
});

exportEvaluation.addEventListener("click", () => {
  if (!latestBenchmark && !latestOcrBenchmark) return;
  const report = latestBenchmark && latestOcrBenchmark
    ? { ...latestBenchmark, ocrBaseline: latestOcrBenchmark, comparison: compareBenchmarkRuns(latestBenchmark, latestOcrBenchmark) }
    : latestBenchmark ?? latestOcrBenchmark;
  const file = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "claimguard-scan-benchmark.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

setupInference().then(client => {
  inference = client;
  explain.disabled = false;
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
