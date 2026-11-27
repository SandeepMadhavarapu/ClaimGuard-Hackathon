import { readSuggestion, reviewScanSuggestion, SCAN_CASES, scoreScanFixture } from "./evidence.mjs";
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

export function scoreBenchmarkCase(fixture, response) {
  const raw = readSuggestion(response.text);
  const reviewed = reviewScanSuggestion(response.text);
  const suggestion = typeof raw?.reference === "string" && raw.reference.length <= 80 ? raw.reference.trim() : null;
  const quote = typeof raw?.quote === "string" && raw.quote.length <= 240 ? raw.quote : null;
  const candidate = reviewed.candidate?.reference ?? null;
  const outcome = scoreScanFixture(fixture, reviewed);
  return {
    ...baseRow(fixture),
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
  let edits = 0;
  let referenceCharacters = 0;
  let quotesScored = 0;
  let wrongProposalsBlocked = 0;
  for (const row of rows) {
    counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
    if (row.inferenceMs !== null && row.inferenceMs !== undefined) times.push(row.inferenceMs);
    if (row.wrongProposalBlocked) wrongProposalsBlocked++;
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
    quoteCharacters: { quotesScored, edits, referenceCharacters, errorRate: referenceCharacters ? edits / referenceCharacters : null },
    latencyMs: { samples: times.length, p50: percentile(times, 50), p95: percentile(times, 95) },
  };
}

async function runBenchmark({
  prepare, readSample, infer, onProgress, fixtures = BENCHMARK_CASES,
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
      const response = await infer(image);
      if (response.source !== source) throw new Error("Unverified inference source");
      rows.push({ ...scoreBenchmarkCase(fixture, response), sampleSha256 });
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
      || row.expectedReference !== baseline.expectedReference || row.sampleSha256 === null
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
