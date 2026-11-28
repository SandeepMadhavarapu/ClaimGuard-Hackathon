import assert from "node:assert/strict";
import { test } from "node:test";
import { LAYOUT_VOCABULARY, buildLayout, layoutPrompt, resolveLayoutSlot } from "./layout-read.mjs";

let x = 0;
const line = (text, confidence = 92) => text.split(/\s+/).map(word => {
  const bbox = { x0: x, y0: 10, x1: x + 40, y1: 30 };
  x += 50;
  return { text: word, bbox, confidence };
});
const page = (...rows) => rows.map(row => line(row));

const referral = page(
  "NORTHLINE DEMO CLINIC",
  "Specialist referral for Wanjiru Kamau",
  "Case number: DRAFT-5071",
  "Preauthorization reference: DEMO-PA-240817",
  "Hospital tracking ID: FAC-01328",
  "The payer issued a preauthorization reference.",
);

test("the layout keeps form words, replaces values with slots, and drops everything else", () => {
  const result = buildLayout(referral);
  assert.equal(result.layout, [
    "clinic",
    "referral for",
    "case number: [ID-1]",
    "preauthorization reference: [ID-2]",
    "hospital tracking id: [ID-3]",
    "the payer issued a preauthorization reference",
  ].join("\n"));
  assert.deepEqual(result.slots.map(slot => [slot.id, slot.value]),
    [["ID-1", "DRAFT-5071"], ["ID-2", "DEMO-PA-240817"], ["ID-3", "FAC-01328"]]);
});

test("no identifier value, name or out-of-vocabulary word can reach the prompt", () => {
  const secrets = ["Wanjiru", "Kamau", "NORTHLINE", "DEMO", "DRAFT-5071", "DEMO-PA-240817", "FAC-01328", "0712345678", "Specialist"];
  const prompt = layoutPrompt(buildLayout(referral).layout);
  for (const secret of secrets) assert.ok(!prompt.includes(secret), `${secret} leaked`);
  // Randomized pages: every word in the layout is a slot, an ellipsis, a letter tag, or vocabulary.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-:.'";
  let seed = 7;
  const rand = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let round = 0; round < 300; round += 1) {
    const rows = Array.from({ length: 1 + rand(5) }, () => Array.from({ length: 1 + rand(8) }, () =>
      rand(3) === 0 ? [...LAYOUT_VOCABULARY][rand(LAYOUT_VOCABULARY.size)]
        : Array.from({ length: 1 + rand(12) }, () => alphabet[rand(alphabet.length)]).join("")).join(" "));
    const { layout, slots } = buildLayout(page(...rows));
    for (const token of layout.split(/\s+/).filter(Boolean)) {
      const bare = token.replace(/:$/, "");
      assert.ok(/^\[ID-\d+\]$/.test(bare) || bare === "…" || /^\([A-Z]\)$/.test(bare) || LAYOUT_VOCABULARY.has(bare),
        `unexpected token ${token}`);
    }
    for (const slot of slots) assert.ok(!layout.includes(slot.value) || LAYOUT_VOCABULARY.has(slot.value.toLowerCase()));
  }
});

test("a labeled slot is mapped back on the device and highlighted", () => {
  const layout = buildLayout(referral);
  const result = resolveLayoutSlot('{"slot":"ID-2"}', layout);
  assert.equal(result.status, "review");
  assert.equal(result.candidate.reference, "DEMO-PA-240817");
  assert.match(result.candidate.quote, /preauthorization reference: \[ID-2\]/);
  assert.ok(result.box.x1 > result.box.x0);
});

test("the guard rejects tracking IDs, unknown slots, bad output and low confidence", () => {
  const layout = buildLayout(referral);
  assert.equal(resolveLayoutSlot('{"slot":"ID-3"}', layout).status, "unsupported");
  assert.equal(resolveLayoutSlot('{"slot":"ID-1"}', layout).status, "unsupported");
  assert.equal(resolveLayoutSlot('{"slot":"ID-9"}', layout).status, "unsupported");
  assert.equal(resolveLayoutSlot("DEMO-PA-240817", layout).status, "unsupported");
  assert.equal(resolveLayoutSlot('{"slot":"NONE"}', layout).status, "empty");
  const faint = buildLayout([line("Preauthorization reference: DEMO-PA-002650", 40)]);
  assert.equal(resolveLayoutSlot('{"slot":"ID-1"}', faint).status, "uncorroborated");
});

test("two labeled payer references hold the page as a conflict, whatever the model says", () => {
  const layout = buildLayout(page("Preauthorization number: DEMO-PA-134220", "Preauthorization number: DEMO-PA-134221"));
  assert.equal(resolveLayoutSlot('{"slot":"ID-1"}', layout).status, "conflict");
  assert.equal(resolveLayoutSlot('{"slot":"NONE"}', layout).status, "conflict");
  assert.equal(resolveLayoutSlot('{"slot":"ID-1"}', buildLayout(referral), { references: 2, candidate: null }).status, "conflict");
});

test("an OCR rule that read a different reference blocks the pick", () => {
  const layout = buildLayout(referral);
  const ocr = { references: 1, candidate: { reference: "DEMO-PA-240811", box: null } };
  assert.equal(resolveLayoutSlot('{"slot":"ID-2"}', layout, ocr).status, "disagreement");
});

test("pending and hospital-only pages give the model nothing it can return", () => {
  const pending = buildLayout(page("Hospital reference: DEMO-PA-427091", "Preauthorization is pending and no payer reference has been issued."));
  assert.equal(resolveLayoutSlot('{"slot":"ID-1"}', pending).status, "unsupported");
  assert.match(pending.layout, /preauthorization is pending and no payer reference has been issued/);
});

test("the guard sweep tries every slot and counts wrong values that would be shown", async () => {
  const { guardSweep } = await import("./layout-read.mjs");
  const layout = buildLayout(referral);
  assert.deepEqual(guardSweep(layout, { references: 1, candidate: null }, "DEMO-PA-240817"), { tried: 4, wrongShown: 0 });
  // If the expected value were the tracking ID, the labeled payer slot would count as wrong.
  assert.equal(guardSweep(layout, { references: 1, candidate: null }, "FAC-01328").wrongShown, 1);
});

test("the leak gate passes a clean layout and blocks any identifier value or ID-shaped token", async () => {
  const { leakGate, sha256Hex } = await import("./layout-read.mjs");
  const layout = buildLayout(referral);
  const prompt = layoutPrompt(layout.layout);
  const clean = leakGate(prompt, layout);
  assert.deepEqual([clean.ok, clean.identifiers], [true, 0]);
  assert.ok(clean.bytes > 500);
  assert.equal(leakGate(prompt + "\nDEMO-PA-240817", layout).ok, false);
  assert.equal(leakGate(prompt + "\ndemo-pa-240817", layout).ok, false);
  assert.equal(leakGate(prompt + "\nCR10000000001-1", layout).identifiers, 1);
  assert.match(await sha256Hex(prompt), /^[a-f0-9]{64}$/);
});

test("labels belong to the field they precede, so grid rows and prose work and other fields stay out", async () => {
  const { labeledValues } = await import("./layout-read.mjs");
  const grid = buildLayout(page("Case number: CASE-3494 Auth. ref: DEMO-PA-571220", "Member number: CR63655673325-4 Facility: FID-21-100001-1"));
  assert.deepEqual(labeledValues(grid), ["DEMO-PA-571220"]);
  assert.equal(resolveLayoutSlot('{"slot":"ID-2"}', grid).status, "review");
  assert.equal(resolveLayoutSlot('{"slot":"ID-1"}', grid).status, "unsupported");
  const prose = buildLayout(page("The payer issued preauthorization reference DEMO-PA-463173 for this service."));
  assert.equal(resolveLayoutSlot('{"slot":"ID-1"}', prose).status, "review");
  const pa = buildLayout(page("PA number: AUTH-26-06198", "Case number: CASE-1"));
  assert.deepEqual(labeledValues(pa), ["AUTH-26-06198"]);
  // A blank payer field followed by another ID on the same line is not a payer reference.
  const blank = buildLayout(page("Preauthorization reference: Hospital tracking ID: FAC-01328"));
  assert.deepEqual(labeledValues(blank), []);
  // Two differently worded payer labels are still a conflict.
  const two = buildLayout(page("Preauthorization number: DEMO-PA-1", "Authorization code: AUTH-26-84909"));
  assert.equal(resolveLayoutSlot('{"slot":"ID-1"}', two).status, "conflict");
});

test("a reference wrapped across lines is one identifier, so an amended second reference is a conflict (set C, c21)", async () => {
  const { joinWrappedIdentifiers, labeledValues } = await import("./layout-read.mjs");
  const card = page(
    "Referral ID: REF-8616 Original preauthorization: DEMO-PA-",
    "459714",
    "Amended preauthorization: PA-261090",
  );
  assert.equal(joinWrappedIdentifiers(card)[0].at(-1).text, "DEMO-PA-459714");
  const layout = buildLayout(card);
  assert.deepEqual(labeledValues(layout).sort(), ["DEMO-PA-459714", "PA-261090"]);
  for (const slot of [...layout.slots.map(entry => entry.id), "NONE"]) {
    assert.equal(resolveLayoutSlot(JSON.stringify({ slot }), layout).candidate, null, `${slot} must not be shown`);
  }
});

test("a payer label followed by an unreadable identifier fragment holds instead of offering another slot", () => {
  const layout = buildLayout(page(
    "Preauthorization number: DEMO-PA-",
    "Amended preauthorization: PA-261090",
  ));
  assert.equal(layout.authFragments, 1);
  const pick = layout.slots.find(slot => slot.value === "PA-261090").id;
  assert.equal(resolveLayoutSlot(JSON.stringify({ slot: pick }), layout).status, "uncorroborated");
});
