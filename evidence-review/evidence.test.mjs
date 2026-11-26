import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  CASES, PUBLIC_PROMPT, SCAN_CASES, compareReferenceEvidence, matchLetter, parseReference, preauthorizationFinding,
  reviewScanSuggestion, scoreFixture, scoreScanFixture, verifySuggestion,
} from "./evidence.mjs";
import { imageMimeType } from "./scan.mjs";

test("scan cross-check distinguishes exact agreement, conflicting evidence, and independent unreadability", () => {
  const proposal = { reference: "DEM0-PA-001518" };
  assert.equal(compareReferenceEvidence(proposal, { reference: "DEM0-PA-001518" }), "matched");
  assert.equal(compareReferenceEvidence(proposal, { reference: "DEMO-PA-001518" }), "conflict");
  assert.equal(compareReferenceEvidence(proposal, null), "manual");
});

test("text matching selects only a single labeled reference", () => {
  for (const fixture of CASES) {
    assert.equal(matchLetter(fixture.text)?.reference ?? null, fixture.expected, fixture.label);
  }
  assert.equal(matchLetter("Preauthorization reference: pending"), null);
  assert.equal(matchLetter("Preauthorization reference: NO-" + "1".repeat(40)), null);
});

test("AI evidence must be verbatim and include the unique reference label", () => {
  const { text, expected } = CASES[0];
  const quote = "Preauthorization reference: DEMO-PA-240817";
  const valid = verifySuggestion(text, JSON.stringify({ reference: expected, quote }));
  assert.equal(valid.status, "verified");
  assert.equal(scoreFixture(CASES[0], valid), "Exact match");
  for (const value of [
    "{",
    JSON.stringify({ reference: expected, quote: expected }),
    JSON.stringify({ reference: expected, quote: "Approved. " + quote }),
    JSON.stringify({ reference: "FAKE-999", quote }),
  ]) assert.equal(verifySuggestion(text, value).status, "unsupported");
});

test("wrong-document and ambiguous suggestions are blocked", () => {
  assert.equal(verifySuggestion(CASES[1].text, JSON.stringify({
    reference: "DEMO-PA-427091", quote: "Hospital reference: DEMO-PA-427091",
  })).status, "unsupported");
  assert.equal(verifySuggestion(CASES[3].text, JSON.stringify({
    reference: "DEMO-PA-134220", quote: "Preauthorization number: DEMO-PA-134220",
  })).status, "unsupported");
});

test("an empty model result is scored against the expected reference", () => {
  const blank = '{"reference":null,"quote":null}';
  assert.equal(scoreFixture(CASES[0], verifySuggestion(CASES[0].text, blank)), "Missed reference");
  assert.equal(scoreFixture(CASES[1], verifySuggestion(CASES[1].text, blank)), "Exact match");
});

test("adding a reference clears only the presence finding", () => {
  assert.deepEqual(preauthorizationFinding(null), {
    rule: "SHA-AUTH-001", pass: false, approval: "pending",
  });
  assert.deepEqual(preauthorizationFinding(CASES[0].expected), {
    rule: "SHA-AUTH-001", pass: true, approval: "pending",
  });
});

test("the cloud prompt includes the public rule and excludes every fixture", () => {
  assert.match(PUBLIC_PROMPT, /SHA-AUTH-001/);
  assert.match(PUBLIC_PROMPT, /regulation 60/);
  assert.doesNotMatch(PUBLIC_PROMPT, /DEMO-PA|SYNTHETIC|DRAFT-5071/);
});

test("a scan suggestion needs a matching payer label and stays pending human review", () => {
  const quote = "Preauthorization reference: DEMO-PA-240817";
  assert.deepEqual(reviewScanSuggestion(JSON.stringify({ reference: "DEMO-PA-240817", quote })), {
    status: "review",
    candidate: { reference: "DEMO-PA-240817", quote },
  });
  assert.deepEqual(reviewScanSuggestion(JSON.stringify({
    reference: "DEMO-PA-240817", quote: "Hospital tracking ID: DEMO-PA-240817",
  })), { status: "unsupported", candidate: null });
  assert.equal(reviewScanSuggestion(JSON.stringify({ reference: "DEMO-PA-1", quote })).status, "unsupported");
  assert.equal(reviewScanSuggestion(JSON.stringify({
    reference: "DEMO-PA-240817", quote: quote + "\nPreauthorization reference: DEMO-PA-9",
  })).status, "unsupported");
  assert.equal(reviewScanSuggestion("{").status, "unsupported");
});

test("scan scoring separates model misses, incorrect suggestions, and abstentions", () => {
  const noReference = reviewScanSuggestion('{"reference":null,"quote":null}');
  const reference = reviewScanSuggestion('{"reference":"DEMO-PA-240817","quote":"Preauthorization reference: DEMO-PA-240817"}');
  assert.equal(scoreScanFixture(SCAN_CASES[0], reference), "Correct extraction");
  assert.equal(scoreScanFixture(SCAN_CASES[0], noReference), "Missed reference");
  assert.equal(scoreScanFixture(SCAN_CASES[1], noReference), "Correct abstention");
  assert.equal(scoreScanFixture(SCAN_CASES[3], reference), "Wrong suggestion");
  assert.equal(scoreScanFixture(SCAN_CASES[3], reviewScanSuggestion("{}")), "Unsupported output");
});

test("manual entry accepts well-formed references", () => {
  assert.equal(parseReference(" DEMO-PA-928331 "), "DEMO-PA-928331");
  for (const invalid of ["Pending", "A1", "DEMO/1", "D" + "0".repeat(40)]) {
    assert.equal(parseReference(invalid), null);
  }
});

test("all labeled scans are bundled PNGs and image detection rejects unrelated file types", async () => {
  for (const { file } of SCAN_CASES) {
    const bytes = await readFile(new URL(`./samples/${file}`, import.meta.url));
    assert.equal(imageMimeType(bytes), "image/png");
  }
  assert.equal(imageMimeType([255, 216, 255, 224]), "image/jpeg");
  assert.equal(imageMimeType(Buffer.from("%PDF-1.6")), null);
});
