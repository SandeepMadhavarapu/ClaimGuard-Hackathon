import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_CLAIM, DEMO_CLAIM_WITH_ERRORS, checkClaim, operationOutcome } from "./claim-check.mjs";

const byId = result => Object.fromEntries(result.checks.map(check => [check.id, check.status]));

test("a correct claim waits for the scan, then becomes ready", () => {
  const claim = { ...DEMO_CLAIM, preauthReference: "DEMO-PA-240817" };
  const waiting = checkClaim(claim, null);
  assert.equal(waiting.verdict, "pending");
  assert.equal(byId(waiting)["preauth-reference"], "pending");
  const ready = checkClaim(claim, "DEMO-PA-240817");
  assert.equal(ready.verdict, "ready");
  assert.ok(ready.checks.every(check => check.status === "pass"));
  assert.equal(operationOutcome(ready).issue[0].severity, "information");
});

test("published ID formats are enforced", () => {
  const result = byId(checkClaim({ ...DEMO_CLAIM, memberId: "CR123", facilityId: "FID-22-100001-1",
    practitionerId: "PUID-100001-1", serviceCode: "SHA-8-004" }, null));
  assert.equal(result["member-id"], "fail");
  assert.equal(result["facility-id"], "fail");
  assert.equal(result["practitioner-id"], "fail");
  assert.equal(result["service-code"], "fail");
});

test("service dates must sit inside the billable period, by date only", () => {
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, serviceStart: "2026-11-02", serviceEnd: "2026-11-06" }))["billable-period"], "pass");
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, serviceEnd: "2026-11-07" }))["billable-period"], "fail");
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, serviceStart: "2026-11-01" }))["billable-period"], "fail");
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, serviceEnd: "" }))["service-period"], "fail");
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, serviceStart: "2026-11-05", serviceEnd: "2026-11-04" }))["service-period"], "fail");
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, serviceEnd: "2026-13-40" }))["service-period"], "fail");
});

test("the claim total must equal the item amounts to the cent", () => {
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, itemAmounts: "0.1, 0.2", total: "0.3" }))["claim-total"], "pass");
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, total: "15500.49" }))["claim-total"], "fail");
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, itemAmounts: "12000, abc" }))["claim-total"], "fail");
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, total: "" }))["claim-total"], "fail");
});

test("the preauthorization reference must match the scan and not be another ID", () => {
  const confirmed = "DEM0-PA-001518";
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, preauthReference: "DEMO-PA-001518" }, confirmed))["preauth-reference"], "fail");
  assert.equal(byId(checkClaim({ ...DEMO_CLAIM, preauthReference: "" }, confirmed))["preauth-reference"], "fail");
  const facility = checkClaim({ ...DEMO_CLAIM, preauthReference: "FID-21-100001-1" }, confirmed);
  assert.equal(byId(facility)["preauth-reference"], "fail");
  assert.match(facility.checks.at(-1).detail, /facility ID/);
  assert.equal(checkClaim({ ...DEMO_CLAIM, requiresPreauth: false }).checks.some(check => check.id === "preauth-reference"), false);
});

test("the error demo fails four checks and exports a FHIR OperationOutcome without scan content", () => {
  const result = checkClaim(DEMO_CLAIM_WITH_ERRORS, "DEMO-PA-240817");
  assert.equal(result.verdict, "hold");
  assert.deepEqual(result.checks.filter(check => check.status === "fail").map(check => check.id),
    ["member-id", "billable-period", "claim-total", "preauth-reference"]);
  const outcome = operationOutcome(result);
  assert.equal(outcome.resourceType, "OperationOutcome");
  assert.equal(outcome.issue.length, 4);
  assert.ok(outcome.issue.every(issue => issue.severity === "error" && issue.expression[0].startsWith("Claim.")));
});
