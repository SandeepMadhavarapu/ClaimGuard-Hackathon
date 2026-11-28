import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, egressManifest, signReceipt, verifyReceipt } from "./receipts.mjs";

const steps = [
  { step: "clean scan", route: "ON_DEVICE", requestBytes: 884, requestSha256: "b5b6ee4b", identifiersInRequest: 0 },
  { step: "clerk confirmation", by: "person at the keyboard" },
  { step: "conflicting references", route: "ON_DEVICE", requestBytes: 849, requestSha256: "65c774fe", identifiersInRequest: 0 },
];

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } }), canonicalJson({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 }));
});

test("a signed receipt verifies, and any edit to a step, the manifest or the signature fails", async () => {
  const signed = await signReceipt({ kind: "claimguard-proof-run", steps, ...egressManifest(steps) });
  assert.equal(signed.egress.length, 2);
  assert.ok((await verifyReceipt(signed)).ok);
  const tampered = structuredClone(signed);
  tampered.steps[0].identifiersInRequest = 1;
  const result = await verifyReceipt(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(check => /chain/.test(check.name)).ok, false);
  const manifest = structuredClone(signed);
  manifest.stayedOnDevice.pop();
  assert.equal((await verifyReceipt(manifest)).checks.find(check => /Signature/.test(check.name)).ok, false);
  const leaked = structuredClone(signed);
  leaked.egress[0].identifiers = 2;
  assert.equal((await verifyReceipt(leaked)).ok, false);
  const resigned = { ...signed, signature: signed.signature.replace(/^./, c => (c === "A" ? "B" : "A")) };
  assert.equal((await verifyReceipt(resigned)).ok, false);
});
