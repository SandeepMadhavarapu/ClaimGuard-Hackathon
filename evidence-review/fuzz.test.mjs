import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzz } from "./fuzz.mjs";

test("fuzz: 5,000 generated pages, every possible model answer, no wrong value and no identifier in a prompt", () => {
  const result = fuzz({ seed: 20261202, count: 5000 });
  assert.deepEqual(result.failures, []);
  assert.equal(result.wrongShown, 0);
  assert.equal(result.leaks, 0);
  assert.ok(result.readableShown / result.readable > 0.9, `readable rate ${result.readableShown}/${result.readable}`);
});
