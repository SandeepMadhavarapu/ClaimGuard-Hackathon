import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { BENCHMARK_CASES, compareBenchmarkRuns, runOcrBenchmark, runScanBenchmark, scoreBenchmarkCase, shareableBenchmark } from "./benchmark.mjs";
import { imageMimeType } from "./scan.mjs";

const [positive, negative] = BENCHMARK_CASES;
const onDevice = (reference, quote, duration = 73) => ({
  text: JSON.stringify({ reference, quote }), source: "ON_DEVICE", duration,
});

test("benchmark fixtures contain six payer references and six abstention cases", async () => {
  assert.equal(BENCHMARK_CASES.length, 12);
  assert.equal(new Set(BENCHMARK_CASES.map(fixture => fixture.file)).size, 12);
  assert.equal(BENCHMARK_CASES.filter(fixture => fixture.expected !== null).length, 6);
  for (const fixture of BENCHMARK_CASES) {
    assert.equal(fixture.expected === null, fixture.quote === null);
    if (fixture.quote) assert.ok(fixture.quote.endsWith(fixture.expected));
    const bytes = await readFile(new URL(`./samples/${fixture.file}`, import.meta.url));
    assert.equal(imageMimeType(bytes), "image/png");
  }
});

test("report counts unsafe held-back proposals separately from displayed false suggestions", () => {
  const wrong = "DEMO-PA-427091";
  const blocked = scoreBenchmarkCase(negative, onDevice(wrong, `Hospital tracking ID: ${wrong}`));
  assert.equal(blocked.outcome, "Unsupported output");
  assert.equal(blocked.wrongProposalBlocked, true);
  assert.equal(blocked.displayedCandidate, null);
  const shown = scoreBenchmarkCase(negative, onDevice(wrong, `Preauthorization reference: ${wrong}`));
  assert.equal(shown.outcome, "False suggestion");
  assert.equal(shown.wrongProposalBlocked, false);
  assert.equal(shown.displayedCandidate, wrong);
});

test("reference-line character score collapses spacing while preserving exact digits", () => {
  const extraSpace = positive.quote.replace(": ", ":  ");
  assert.equal(scoreBenchmarkCase(positive, onDevice(positive.expected, extraSpace)).quoteScore.edits, 0);
  const altered = positive.quote.replace("240817", "24081Z");
  assert.equal(scoreBenchmarkCase(positive, onDevice(positive.expected, altered)).quoteScore.edits, 1);
  const blank = scoreBenchmarkCase(positive, onDevice(null, null)).quoteScore;
  assert.equal(blank.edits, blank.referenceCharacters);
});

test("one sample failure and one cloud response stay in the denominator without leaking into timings", async () => {
  const fixtures = BENCHMARK_CASES.slice(0, 4);
  const result = await runScanBenchmark({
    fixtures,
    prepare: async () => {},
    readSample: async (fixture) => {
      if (fixture === fixtures[2]) throw new Error("Bad scan");
      return fixture;
    },
    infer: async (fixture) => {
      const response = onDevice(fixture.expected, fixture.quote, fixture.expected ? 40 : 120);
      if (fixture === fixtures[3]) response.source = "IN_CLOUD";
      return response;
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.summary.correctOutcomes, 2);
  assert.equal(result.summary.planned, 4);
  assert.equal(result.summary.attempted, 4);
  assert.equal(result.summary.counts["Sample unavailable"], 1);
  assert.equal(result.summary.counts["Inference error"], 1);
  assert.deepEqual(result.summary.latencyMs, { samples: 2, p50: 40, p95: 120 });
  assert.equal(result.summary.quoteCharacters.errorRate, 0);
});

test("a device initialization failure produces a not-run report with empty metrics", async () => {
  const result = await runScanBenchmark({
    prepare: async () => { throw new Error("Nano unavailable"); },
    readSample: async () => assert.fail("sample should not be read"),
    infer: async () => assert.fail("inference should not start"),
  });
  assert.equal(result.status, "not_run");
  assert.deepEqual(result.rows, []);
  assert.equal(result.summary.planned, 12);
  assert.equal(result.summary.quoteCharacters.errorRate, null);
  assert.deepEqual(result.summary.latencyMs, { samples: 0, p50: null, p95: null });
});

test("the OCR baseline records real execution independently of Firebase", async () => {
  const fixtures = [positive, negative];
  const result = await runOcrBenchmark({
    fixtures,
    prepare: async () => {},
    readSample: async fixture => fixture,
    readReference: async fixture => fixture.expected ? { reference: fixture.expected, quote: fixture.quote } : null,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.mode, "OCR_ONLY");
  assert.equal(result.summary.correctOutcomes, 2);
  assert.deepEqual(result.rows.map(row => row.inferenceSource), ["LOCAL_OCR", "LOCAL_OCR"]);
});

test("paired comparison uses shared scored cases and does not favor either method", () => {
  const correct = "Correct extraction";
  const wrong = "Missed reference";
  const rows = ["a", "b", "c", "d", "e"].map(sample => ({ sample, expectedReference: "PA-123", sampleSha256: "a".repeat(64) }));
  const dataset = "fixture-set";
  const nano = { dataset, rows: rows.map((row, index) => ({
    ...row, inferenceSource: "ON_DEVICE", outcome: index < 2 ? correct : wrong,
  })) };
  const ocr = { dataset, rows: rows.map((row, index) => ({
    ...row, inferenceSource: index === 4 ? undefined : "LOCAL_OCR",
    outcome: index === 0 || index === 2 ? correct : wrong,
  })) };
  assert.deepEqual(compareBenchmarkRuns(nano, ocr),
    { paired: 4, bothCorrect: 1, onlyNanoCorrect: 1, onlyOcrCorrect: 1, neitherCorrect: 1 });
  assert.equal(compareBenchmarkRuns(nano, { ...ocr, dataset: "other" }), null);
  assert.equal(compareBenchmarkRuns(nano, { ...ocr, rows: [] }), null);
});

test("different scan bytes cannot be paired as the same benchmark input", async () => {
  const fixtures = [positive];
  const common = { fixtures, prepare: async () => {} };
  const nano = await runScanBenchmark({ ...common, readSample: async () => new Blob(["scan a"]),
    infer: async () => onDevice(positive.expected, positive.quote, 5) });
  const runOcr = bytes => runOcrBenchmark({ ...common, readSample: async () => new Blob([bytes]),
    readReference: async () => ({ reference: positive.expected, quote: positive.quote }) });
  const matching = await runOcr("scan a");
  const different = await runOcr("scan b");
  assert.match(nano.rows[0].sampleSha256, /^[0-9a-f]{64}$/);
  assert.equal(nano.rows[0].sampleSha256, matching.rows[0].sampleSha256);
  assert.equal(compareBenchmarkRuns(nano, matching)?.bothCorrect, 1);
  assert.equal(compareBenchmarkRuns(nano, different), null);
});

test("live gate withholds uncorroborated, conflicting, and disagreeing model IDs", () => {
  const infer = onDevice(positive.expected, positive.quote);
  const box = { x0: 1, y0: 2, x1: 7, y1: 10 };
  const matched = scoreBenchmarkCase(positive, infer, { references: 1, candidate: { reference: positive.expected, box } });
  assert.equal(matched.guarded.outcome, "Correct extraction");
  assert.equal(matched.guarded.reference, positive.expected);
  for (const [evidence, status] of [
    [{ references: 0, candidate: null }, "uncorroborated"],
    [{ references: 2, candidate: null }, "conflict"],
    [{ references: 1, candidate: { reference: "PA-000", box } }, "disagreement"],
  ]) {
    const result = scoreBenchmarkCase(positive, infer, evidence);
    assert.equal(result.guarded.reference, null);
    assert.equal(result.guarded.decision, status);
    assert.equal(result.guarded.outcome, "Missed reference");
  }
  assert.equal(scoreBenchmarkCase(negative, onDevice(null, null), null).guarded.outcome, "OCR unavailable");
});

test("the benchmark export excludes model output and hashes only the actual fixture bytes", async () => {
  const run = await runScanBenchmark({
    fixtures: [positive, negative],
    prepare: async () => {},
    readSample: async fixture => new Blob([fixture.file]),
    infer: async () => onDevice("CANARY-123", "Preauthorization reference: CANARY-123", 12),
    readEvidence: async () => { throw new Error("OCR unavailable"); },
  });
  assert.equal(run.summary.guarded.measured, 0);
  assert.equal(run.summary.guarded.correct, 0);
  const report = shareableBenchmark(run);
  assert.match(report.runs[0].rows[0].sampleSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.runs[0].rows[0].guarded.outcome, "OCR unavailable");
  assert.doesNotMatch(JSON.stringify(report), /CANARY|quote":|modelSuggestion/);
});

test("a paired report requires case fingerprints on both sides", () => {
  const row = { sample: "referral.png", expectedReference: "PA-123", outcome: "Correct extraction" };
  assert.equal(compareBenchmarkRuns(
    { dataset: "fixture", rows: [{ ...row, inferenceSource: "ON_DEVICE" }] },
    { dataset: "fixture", rows: [{ ...row, inferenceSource: "LOCAL_OCR" }] },
  ), null);
});

test("the private layout benchmark attributes each miss to a stage and keeps failures in the denominator", async () => {
  const { runLayoutBenchmark, BENCHMARK_CASES } = await import("./benchmark.mjs");
  const layoutRead = await import("./layout-read.mjs");
  const word = text => ({ text, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, confidence: 90 });
  const pages = {
    "referral.png": [["Preauthorization", "reference:", "DEMO-PA-240817"], ["Hospital", "tracking", "ID:", "FAC-01328"]],
    "pending.png": [["Hospital", "tracking", "ID:", "DEMO-PA-427091"]],
    "cover-sheet.png": [["Preauthorization", "number:", "DEMO-PA-928331"]],
  };
  const fixtures = BENCHMARK_CASES.slice(0, 4);
  const report = await runLayoutBenchmark({
    fixtures,
    readSample: async fixture => fixture.file,
    readLayoutEvidence: async file => {
      if (!pages[file]) throw new Error("no OCR");
      return { lines: pages[file].map(row => row.map(word)), candidate: null, references: 1 };
    },
    // Picks the first slot every time: right for referral, wrong (and blocked) for pending.
    readLayout: async prompt => ({ text: /\[ID-1\]/.test(prompt) ? '{"slot":"ID-1"}' : '{"slot":"NONE"}', source: "IN_CLOUD", duration: 5 }),
    ...layoutRead,
  });
  const rows = Object.fromEntries(report.rows.map(row => [row.sample, row]));
  assert.equal(rows["referral.png"].outcome, "Correct extraction");
  assert.equal(rows["pending.png"].outcome, "Correct abstention");
  assert.equal(rows["pending.png"].wrongProposalBlocked, true);
  assert.equal(rows["cover-sheet.png"].outcome, "Correct extraction");
  assert.equal(rows["conflicting.png"].outcome, "Inference error");
  assert.equal(rows["conflicting.png"].lostAt, "Inference");
  assert.equal(report.summary.planned, 4);
  assert.equal(report.summary.correctOutcomes, 3);
  assert.equal(report.summary.routes.IN_CLOUD, 3);
  assert.equal(report.summary.guardSweep.wrongShown, 0);
  assert.equal(report.status, "partial");
});

test("rate-limited model calls are retried after the delay the API asks for", async () => {
  const { rateLimitDelayMs, withRateLimitRetry } = await import("./benchmark.mjs");
  const quota = new Error("[429 ] You exceeded your current quota ... Please retry in 3.09s.");
  assert.equal(rateLimitDelayMs(quota), 3590);
  assert.equal(rateLimitDelayMs(new Error("Nano is unavailable")), null);
  const waits = [];
  let calls = 0;
  const value = await withRateLimitRetry(async () => { calls += 1; if (calls < 3) throw quota; return "ok"; }, { wait: async ms => waits.push(ms) });
  assert.equal(value, "ok");
  assert.deepEqual(waits, [3590, 3590]);
  await assert.rejects(withRateLimitRetry(async () => { throw new Error("other"); }, { wait: async () => {} }), /other/);
  await assert.rejects(withRateLimitRetry(async () => { throw quota; }, { retries: 1, wait: async () => {} }), /429/);
});

test("benchmark CSV has one row per document and neutralizes spreadsheet formulas", async () => {
  const { benchmarkCsv } = await import("./benchmark.mjs");
  const csv = benchmarkCsv({ mode: "PRIVATE_LAYOUT_PREFER_ON_DEVICE", rows: [
    { sample: "b01.jpg", label: 'b01.jpg · "look-alike", O/0', expectedReference: "AUTH-26-95I82", outcome: "Wrong suggestion", lostAt: "OCR", pick: "ID-1", inferenceSource: "ON_DEVICE", milliseconds: 1451 },
    { sample: "=HYPERLINK(1)", outcome: "Correct abstention", expectedReference: null },
  ] }, null);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /"b01.jpg · ""look-alike"", O\/0"/);
  assert.match(lines[2], /^PRIVATE_LAYOUT_PREFER_ON_DEVICE,"'=HYPERLINK\(1\)"/);
});
