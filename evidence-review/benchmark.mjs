import { decideScanReview, readSuggestion, reviewScanSuggestion, SCAN_CASES, scoreScanFixture } from "./evidence.mjs";
import { levenshtein, percentile } from "./vendor/medocr/metrics.mjs";

const expectedQuotes = new Map([
  ["referral.png", "Preauthorization reference: DEMO-PA-240817"],
  ["cover-sheet.png", "Preauthorization number: DEMO-PA-928331"],
]);
const addedCases = [
  ["faint-print", "Faint print", "Preauthorization reference", "PA-002650"],
  ["rotated-letter", "Rotated referral", "Preauthorization number", "DEMO-PA-480032"],
  ["lookalike-digits", "Look-alike O and 0", "Preauthorization reference", "DEM0-PA-001518"],
  ["leading-zero", "Low resolution and leading zeros", "Preauthorization number", "PA-000741"],
  ["placeholder", "Placeholder with tracking ID", null, null],
  ["blank-field", "Blank payer field", null, null],
  ["two-copies", "Combined pages with conflicting references", null, null],
  ["facility-only", "Facility identifiers only", null, null],
];

export const BENCHMARK_CASES = Object.freeze([
  ...SCAN_CASES.map(fixture => ({ ...fixture, quote: expectedQuotes.get(fixture.file) ?? null })),
  ...addedCases.map(([id, label, field, expected]) => ({
    file: `${id}.png`, label, expected, quote: field ? `${field}: ${expected}` : null,
  })),
].map(Object.freeze));

const normalizedCharacters = value => Array.from(value.normalize("NFC").trim().replace(/\s+/gu, " "));

function quoteScore(reference, hypothesis) {
  if (reference === null) return null;
  const expected = normalizedCharacters(reference);
  const found = normalizedCharacters(hypothesis ?? "");
  return { edits: levenshtein(found, expected), referenceCharacters: expected.length };
}

function baseRow(fixture) {
  return { sample: fixture.file, label: fixture.label, expectedReference: fixture.expected };
}

async function fingerprint(image) {
  if (typeof image?.arrayBuffer !== "function" || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", await image.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function scoreBenchmarkCase(fixture, response, evidence) {
  const raw = readSuggestion(response.text);
  const reviewed = reviewScanSuggestion(response.text);
  const suggestion = typeof raw?.reference === "string" && raw.reference.length <= 80 ? raw.reference.trim() : null;
  const quote = typeof raw?.quote === "string" && raw.quote.length <= 240 ? raw.quote : null;
  const candidate = reviewed.candidate?.reference ?? null;
  const outcome = scoreScanFixture(fixture, reviewed);
  const guarded = evidence ? decideScanReview(reviewed, evidence) : null;
  const guardedReference = guarded?.candidate?.reference ?? null;
  return {
    ...baseRow(fixture),
    ...(evidence === null ? { guarded: { decision: "ocr-unavailable", outcome: "OCR unavailable" } } : guarded ? {
      guarded: {
        decision: guarded.status,
        reference: guardedReference,
        outcome: guardedReference === fixture.expected
          ? guardedReference ? "Correct extraction" : "Correct abstention"
          : guardedReference ? fixture.expected ? "Wrong suggestion" : "False suggestion" : "Missed reference",
        wrongProposalBlocked: Boolean(suggestion && suggestion !== fixture.expected && !guardedReference),
      },
    } : {}),
    outcome: outcome === "Wrong suggestion" && fixture.expected === null ? "False suggestion" : outcome,
    modelSuggestion: suggestion,
    displayedCandidate: candidate,
    wrongProposalBlocked: Boolean(suggestion && suggestion !== fixture.expected && !candidate),
    quoteScore: quoteScore(fixture.quote, quote),
    inferenceSource: response.source,
    inferenceMs: Number.isFinite(response.duration) ? response.duration : null,
  };
}

function summarize(rows, total) {
  const counts = {};
  const times = [];
  const guarded = { measured: 0, correct: 0, wrongProposalsBlocked: 0 };
  const guardTimes = [];
  let edits = 0;
  let referenceCharacters = 0;
  let quotesScored = 0;
  let wrongProposalsBlocked = 0;
  for (const row of rows) {
    counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
    if (row.inferenceMs !== null && row.inferenceMs !== undefined) times.push(row.inferenceMs);
    if (row.wrongProposalBlocked) wrongProposalsBlocked++;
    if (row.guarded && row.guarded.decision !== "ocr-unavailable") {
      guarded.measured++;
      if (Number.isFinite(row.guarded.milliseconds)) guardTimes.push(row.guarded.milliseconds);
      if (["Correct extraction", "Correct abstention"].includes(row.guarded.outcome)) guarded.correct++;
      if (row.guarded.wrongProposalBlocked) guarded.wrongProposalsBlocked++;
    }
    if (row.quoteScore) {
      quotesScored++;
      edits += row.quoteScore.edits;
      referenceCharacters += row.quoteScore.referenceCharacters;
    }
  }
  return {
    planned: total,
    attempted: rows.length,
    correctOutcomes: (counts["Correct extraction"] ?? 0) + (counts["Correct abstention"] ?? 0),
    counts,
    wrongProposalsBlocked,
    ...(rows.some(row => row.guarded) ? {
      guarded: { ...guarded, latencyMs: { samples: guardTimes.length, p50: percentile(guardTimes, 50), p95: percentile(guardTimes, 95) } },
    } : {}),
    quoteCharacters: { quotesScored, edits, referenceCharacters, errorRate: referenceCharacters ? edits / referenceCharacters : null },
    latencyMs: { samples: times.length, p50: percentile(times, 50), p95: percentile(times, 95) },
  };
}

async function runBenchmark({
  prepare, readSample, infer, readEvidence, onProgress, fixtures = BENCHMARK_CASES,
}, mode, source) {
  const startedAt = new Date().toISOString();
  const rows = [];
  const report = status => ({
    schemaVersion: 1,
    dataset: "claimguard-synthetic-v3",
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    summary: summarize(rows, fixtures.length),
    rows,
  });

  try {
    await prepare();
  } catch {
    return report("not_run");
  }
  let responses = 0;
  for (const fixture of fixtures) {
    onProgress?.(rows.length + 1, fixtures.length);
    let image;
    try {
      image = await readSample(fixture);
    } catch {
      rows.push({ ...baseRow(fixture), outcome: "Sample unavailable" });
      continue;
    }
    const sampleSha256 = await fingerprint(image).catch(() => null);
    try {
      const started = performance.now();
      const response = await infer(image);
      if (response.source !== source) throw new Error("Unverified inference source");
      let evidence;
      if (readEvidence) {
        try { evidence = await readEvidence(image); }
        catch { evidence = null; }
      }
      const scored = scoreBenchmarkCase(fixture, response, evidence);
      if (evidence && scored.guarded) scored.guarded.milliseconds = Math.round(performance.now() - started);
      rows.push({ ...scored, sampleSha256 });
      responses++;
    } catch {
      rows.push({ ...baseRow(fixture), outcome: "Inference error", sampleSha256 });
    }
  }
  return report(!responses ? "failed" : responses < fixtures.length ? "partial" : "complete");
}

export function runScanBenchmark(options) {
  return runBenchmark(options, "ONLY_ON_DEVICE", "ON_DEVICE");
}

export function runOcrBenchmark({ readReference, ...options }) {
  return runBenchmark({
    ...options,
    infer: async image => {
      const start = performance.now();
      const candidate = await readReference(image);
      return {
        text: JSON.stringify({ reference: candidate?.reference ?? null, quote: candidate?.quote ?? null }),
        source: "LOCAL_OCR",
        duration: Math.round(performance.now() - start),
      };
    },
  }, "OCR_ONLY", "LOCAL_OCR");
}

export function compareBenchmarkRuns(nano, ocr) {
  if (!nano || !ocr || nano.dataset !== ocr.dataset) return null;
  const cases = new Map(ocr.rows.map(row => [row.sample, row]));
  const isCorrect = row => ["Correct extraction", "Correct abstention"].includes(row.outcome);
  const counts = { paired: 0, bothCorrect: 0, onlyNanoCorrect: 0, onlyOcrCorrect: 0, neitherCorrect: 0 };
  for (const row of nano.rows) {
    const baseline = cases.get(row.sample);
    if (row.inferenceSource !== "ON_DEVICE" || baseline?.inferenceSource !== "LOCAL_OCR"
      || row.expectedReference !== baseline.expectedReference || !/^[a-f0-9]{64}$/.test(row.sampleSha256)
      || row.sampleSha256 !== baseline.sampleSha256) continue;
    const nanoCorrect = isCorrect(row);
    const ocrCorrect = isCorrect(baseline);
    counts.paired++;
    if (nanoCorrect && ocrCorrect) counts.bothCorrect++;
    else if (nanoCorrect) counts.onlyNanoCorrect++;
    else if (ocrCorrect) counts.onlyOcrCorrect++;
    else counts.neitherCorrect++;
  }
  return counts.paired ? counts : null;
}

// This is the only shareable benchmark representation. Do not include model
// prose, candidate text, images, or the current document from the review UI.
export function shareableBenchmark(...runs) {
  const layoutRun = runs.find(run => run?.mode === "PRIVATE_LAYOUT_PREFER_ON_DEVICE");
  runs = runs.filter(run => run?.mode !== "PRIVATE_LAYOUT_PREFER_ON_DEVICE");
  const fixtureNames = new Set(BENCHMARK_CASES.map(fixture => fixture.file));
  return {
    schemaVersion: 2,
    platform: "web",
    dataset: "claimguard-synthetic-v3",
    runs: runs.filter(Boolean).map(run => ({
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      summary: run.summary,
      rows: run.rows.filter(row => fixtureNames.has(row.sample)).map(row => ({
        sample: row.sample,
        sampleSha256: row.sampleSha256 ?? null,
        inferenceSource: row.inferenceSource ?? null,
        milliseconds: row.inferenceMs ?? null,
        outcome: row.outcome,
        wrongProposalBlocked: row.wrongProposalBlocked ?? false,
        guarded: row.guarded ? {
          decision: row.guarded.decision,
          milliseconds: row.guarded.milliseconds ?? null,
          outcome: row.guarded.outcome,
          wrongProposalBlocked: row.guarded.wrongProposalBlocked ?? false,
        } : null,
      })),
    })),
    comparison: compareBenchmarkRuns(...runs),
    // Slot names, routes and outcomes only. Layout text and identifier values are not exported.
    privateLayout: layoutRun ? {
      mode: layoutRun.mode, status: layoutRun.status, startedAt: layoutRun.startedAt, finishedAt: layoutRun.finishedAt,
      summary: layoutRun.summary,
      rows: layoutRun.rows.map(row => ({
        sample: row.sample, sampleSha256: row.sampleSha256 ?? null, inferenceSource: row.inferenceSource ?? null,
        milliseconds: row.inferenceMs ?? null, pick: row.pick ?? null, decision: row.decision ?? null,
        outcome: row.outcome, lostAt: row.lostAt ?? null, wrongProposalBlocked: row.wrongProposalBlocked ?? false,
        sweep: row.sweep ?? null,
      })),
    } : null,
  };
}

// Private layout route: OCR on the device, slots to Gemini (on-device first, cloud fallback),
// deterministic guard. Each row says where a miss happened, so judges can see which stage lost it.
export function scoreLayoutCase(fixture, { evidence, layout, pick, decision, response }) {
  const expected = fixture.expected;
  const slot = layout.slots.find(entry => entry.id === pick);
  const picked = slot?.value ?? null;
  const shown = decision.candidate?.reference ?? null;
  const ocrHasValue = expected === null || layout.slots.some(entry => entry.value === expected);
  const outcome = shown === expected
    ? shown ? "Correct extraction" : "Correct abstention"
    : shown ? expected ? "Wrong suggestion" : "False suggestion" : "Missed reference";
  let lostAt = null;
  if (!["Correct extraction", "Correct abstention"].includes(outcome)) {
    if (!ocrHasValue) lostAt = "OCR";
    else if (picked !== expected) lostAt = shown ? "Model + guard" : "Model";
    else lostAt = "Guard";
  }
  return {
    ...baseRow(fixture),
    outcome,
    lostAt,
    pick: pick ?? null,
    pickedValueMatches: expected === null ? picked === null : picked === expected,
    decision: decision.status,
    wrongProposalBlocked: Boolean(picked && picked !== expected && !shown),
    slots: layout.slots.length,
    ocrReferences: evidence.references,
    inferenceSource: response.source,
    inferenceMs: Number.isFinite(response.duration) ? response.duration : null,
  };
}

export async function runLayoutBenchmark({
  readSample, readLayoutEvidence, readLayout, buildLayout, layoutPrompt, resolveLayoutSlot, guardSweep, onProgress,
  fixtures = BENCHMARK_CASES,
}) {
  const startedAt = new Date().toISOString();
  const rows = [];
  for (const fixture of fixtures) {
    onProgress?.(rows.length + 1, fixtures.length);
    let image;
    try { image = await readSample(fixture); }
    catch { rows.push({ ...baseRow(fixture), outcome: "Sample unavailable", lostAt: "Sample" }); continue; }
    const sampleSha256 = await fingerprint(image).catch(() => null);
    let sweep = null;
    try {
      const evidence = await readLayoutEvidence(image);
      const layout = buildLayout(evidence.lines);
      sweep = guardSweep ? guardSweep(layout, evidence, fixture.expected) : null;
      const response = await readLayout(layoutPrompt(layout.layout));
      if (!["ON_DEVICE", "IN_CLOUD"].includes(response.source)) throw new Error("Unverified inference source");
      const decision = resolveLayoutSlot(response.text, layout, evidence);
      rows.push({ ...scoreLayoutCase(fixture, { evidence, layout, pick: decision.pick, decision, response }), sweep, sampleSha256 });
    } catch {
      rows.push({ ...baseRow(fixture), outcome: "Inference error", lostAt: "Inference", sweep, sampleSha256 });
    }
  }
  const times = rows.map(row => row.inferenceMs).filter(Number.isFinite);
  const count = key => rows.reduce((totals, row) => {
    if (row[key]) totals[row[key]] = (totals[row[key]] ?? 0) + 1;
    return totals;
  }, {});
  const correct = rows.filter(row => ["Correct extraction", "Correct abstention"].includes(row.outcome)).length;
  return {
    schemaVersion: 1,
    dataset: "claimguard-synthetic-v3",
    mode: "PRIVATE_LAYOUT_PREFER_ON_DEVICE",
    startedAt,
    finishedAt: new Date().toISOString(),
    status: rows.every(row => row.inferenceSource) ? "complete" : rows.some(row => row.inferenceSource) ? "partial" : "failed",
    summary: {
      planned: fixtures.length,
      correctOutcomes: correct,
      counts: count("outcome"),
      lostAt: count("lostAt"),
      routes: count("inferenceSource"),
      wrongProposalsBlocked: rows.filter(row => row.wrongProposalBlocked).length,
      guardSweep: {
        scans: rows.filter(row => row.sweep).length,
        picksTried: rows.reduce((sum, row) => sum + (row.sweep?.tried ?? 0), 0),
        wrongShown: rows.reduce((sum, row) => sum + (row.sweep?.wrongShown ?? 0), 0),
      },
      latencyMs: { samples: times.length, p50: percentile(times, 50), p95: percentile(times, 95) },
    },
    rows,
  };
}
