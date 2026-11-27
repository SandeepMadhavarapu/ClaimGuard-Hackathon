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
