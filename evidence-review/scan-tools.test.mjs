import assert from "node:assert/strict";
import { test } from "node:test";
import { imageModelAvailability } from "./browser-readiness.mjs";
import { locateReference } from "./ocr-evidence.mjs";
import { straightenPixels } from "./scan-cleanup.mjs";

function line(...parts) {
  return parts.map((text, i) => ({
    text, confidence: 96, bbox: { x0: i * 60, y0: 10, x1: i * 60 + 55, y1: 22 },
  }));
}

test("OCR uses the labeled source line and returns the covering rectangle", () => {
  const expected = "DEMO-PA-240817";
  const words = line("Preauthorization", "reference:", expected);
  const distractor = line("Hospital", "ID:", expected);
  assert.deepEqual(locateReference([distractor, words], expected), { x0: 0, y0: 10, x1: 175, y1: 22 });
  assert.equal(locateReference([distractor], expected), null);
  assert.equal(locateReference([words], "DIFFERENT-444"), null);
});

test("OCR abstains on ambiguous or low-confidence labels", () => {
  const expected = "DEMO-PA-240817";
  const words = line("Preauthorization", "reference:", expected);
  assert.equal(locateReference([words, line("Preauthorization", "number:", "TWO-220")], expected), null);
  assert.equal(locateReference([line("Preauthorization", "number:", "TWO-220", "Preauthorization", "number:", "THREE-330"), words], expected), null);
  words[2].confidence = 30;
  assert.equal(locateReference([words], expected), null);
});

test("uniform scans are preserved when no document boundary is detected", () => {
  const pixels = { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4).fill(255) };
  assert.equal(straightenPixels(pixels), null);
});

test("Chrome readiness probes image capability and handles missing support", async () => {
  assert.equal(await imageModelAvailability({ availability: async options => {
    assert.deepEqual(options, { expectedInputs: [{ type: "image" }] });
    return "downloadable";
  } }), "downloadable");
  assert.equal(await imageModelAvailability({}), "unsupported");
  assert.equal(await imageModelAvailability({ availability: async () => { throw new Error(); } }), "unknown");
});
