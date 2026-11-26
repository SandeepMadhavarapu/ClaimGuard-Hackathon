import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { BENCHMARK_CASES, compareBenchmarkRuns, runOcrBenchmark, runScanBenchmark, scoreBenchmarkCase } from "./benchmark.mjs";
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
  const rows = ["a", "b", "c", "d", "e"].map(sample => ({ sample, expectedReference: "PA-123" }));
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
