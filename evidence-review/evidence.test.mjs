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
    rule: "CG-AUTH-001", pass: false, approval: "pending",
  });
  assert.deepEqual(preauthorizationFinding(CASES[0].expected), {
    rule: "CG-AUTH-001", pass: true, approval: "pending",
  });
});

test("the cloud prompt includes the public rule and excludes every fixture", () => {
  assert.match(PUBLIC_PROMPT, /CG-AUTH-001/);
  assert.match(PUBLIC_PROMPT, /Synthetic payer policy/);
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

test("explicit no-reference answers count as abstentions, not unsupported output", () => {
  for (const output of [
    '{"reference":null,"quote":"Preauthorization is pending and no payer reference has been issued."}',
    '{"reference":"NOT ISSUED","quote":"Preauthorization reference: NOT ISSUED"}',
    '{"reference":"PREAUTHORIZATION REFERENCE:","quote":"Preauthorization reference:"}',
    '{"reference":"","quote":null}',
  ]) {
    assert.equal(reviewScanSuggestion(output).status, "empty", output);
  }
  assert.equal(scoreScanFixture(SCAN_CASES[1], reviewScanSuggestion('{"reference":"NOT ISSUED","quote":"x"}')), "Correct abstention");
  assert.equal(reviewScanSuggestion('{"quote":"Preauthorization reference: DEMO-PA-240817"}').status, "unsupported");
});

test("a loosely transcribed payer label is accepted only with a single matching identifier", () => {
  const ok = reviewScanSuggestion('{"reference":"PA-000741","quote":"Pre-auth no. PA-000741"}');
  assert.deepEqual(ok, { status: "review", candidate: { reference: "PA-000741", quote: "Pre-auth no. PA-000741" } });
  for (const quote of [
    "Pre-auth no. PA-000741 Hospital tracking ID: FAC-01328",
    "Pre-auth no. PA-000742",
    "Hospital tracking ID PA-000741",
    "Preauthorization number: PA-000741 Preauthorization number: PA-000742",
  ]) {
    assert.equal(reviewScanSuggestion(JSON.stringify({ reference: "PA-000741", quote })).status, "unsupported", quote);
  }
});

test("next-step prompts are fixed public text for known outcome codes only", async () => {
  const { NEXT_STEP_CODES, nextStepCode, nextStepPrompt } = await import("./evidence.mjs");
  assert.deepEqual(NEXT_STEP_CODES, ["RECORDED", "NO_REFERENCE", "CONFLICT", "NEEDS_REVIEW"]);
  const fixtureValues = [...CASES.map(c => c.text), ...SCAN_CASES.map(c => c.expected)].filter(Boolean);
  for (const code of NEXT_STEP_CODES) {
    const prompt = nextStepPrompt(code);
    assert.equal(prompt, nextStepPrompt(code));
    assert.match(prompt, new RegExp(`Outcome: ${code} \\|`));
    assert.match(prompt, /synthetic, not official payer guidance/);
    assert.doesNotMatch(prompt, /DEMO-PA|DRAFT-|FAC-|REF-\d|PA-\d/);
    for (const value of fixtureValues) assert.ok(!prompt.includes(value), value);
  }
  for (const bad of ["DEMO-PA-240817", "", "constructor", "__proto__", "recorded", undefined]) {
    assert.throws(() => nextStepPrompt(bad), /Unknown outcome code/);
  }
  assert.equal(nextStepCode("review"), null);
  assert.equal(nextStepCode("verified"), null);
  assert.equal(nextStepCode("empty"), "NO_REFERENCE");
  assert.equal(nextStepCode("conflict"), "CONFLICT");
  for (const status of ["unsupported", "uncorroborated", "disagreement"]) assert.equal(nextStepCode(status), "NEEDS_REVIEW");
});

test("Kiswahili next-step prompts add only a fixed language instruction", async () => {
  const { NEXT_STEP_CODES, NEXT_STEP_LANGUAGES, nextStepPrompt } = await import("./evidence.mjs");
  assert.deepEqual(Object.keys(NEXT_STEP_LANGUAGES), ["en", "sw"]);
  assert.equal(NEXT_STEP_LANGUAGES.sw.route, "cloud");
  for (const code of NEXT_STEP_CODES) {
    assert.equal(nextStepPrompt(code, "sw"), `Write the whole answer in Kiswahili.\n${nextStepPrompt(code, "en")}`);
    assert.equal(nextStepPrompt(code), nextStepPrompt(code, "en"));
  }
  for (const bad of ["fr", "", "constructor", "__proto__", "SW"]) {
    assert.throws(() => nextStepPrompt("CONFLICT", bad), /Unknown language/);
  }
});

test("generated next-step guidance is discarded if it adds identifiers, numbers or links", async () => {
  const { groundNextStep } = await import("./evidence.mjs");
  assert.equal(groundNextStep("Ask the payer which reference applies.\n- Enter the confirmed reference manually.\n- Keep both documents.").ok, true);
  assert.equal(groundNextStep("Uliza mlipaji ni rejea ipi inayotumika.\n1. Usichague bila uthibitisho.").ok, true);
  assert.equal(groundNextStep("Use DEMO-PA-134220 on the claim.").reason, "identifier");
  assert.equal(groundNextStep("Call the payer on 0712345678.").reason, "number");
  assert.equal(groundNextStep("See https://example.com for help.").reason, "link or email");
  assert.equal(groundNextStep("").ok, false);
});
