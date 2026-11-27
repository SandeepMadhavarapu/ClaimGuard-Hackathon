// Claim pre-check against published SHA eClaims rules. Runs entirely on this device.
// Rule sources: Digital Health Agency, "Claims Submission Guide" (afyalink.dha.go.ke/claim-integration)
// and the Kenya eClaims FHIR Implementation Guide (CC0). Formats are checked, not looked up:
// a real submission still needs the registry lookups and payer verification.

export const RULE_SOURCE = "https://afyalink.dha.go.ke/claim-integration";

const FORMATS = Object.freeze({
  member: { pattern: /^CR\d{11}-\d$/, example: "CRxxxxxxxxxxx-x", name: "client registry ID" },
  facility: { pattern: /^FID-21-\d{6}-\d$/, example: "FID-21-xxxxxx-x", name: "facility ID (FID)" },
  practitioner: { pattern: /^PUID-\d{7}-\d$/, example: "PUID-xxxxxxx-x", name: "practitioner ID (PUID)" },
  service: { pattern: /^SHA-\d{2}-\d{3}$/, example: "SHA-08-004", name: "SHA intervention code" },
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = value => String(value ?? "").trim();

function amounts(value) {
  const parts = clean(value).split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return null;
  const numbers = parts.map(Number);
  return numbers.every(number => Number.isFinite(number) && number >= 0) ? numbers : null;
}

const cents = value => Math.round(Number(value) * 100);

function formatCheck(id, field, value, expression) {
  const format = FORMATS[field];
  const ok = format.pattern.test(clean(value));
  return {
    id, expression, status: ok ? "pass" : "fail",
    title: `${format.name[0].toUpperCase()}${format.name.slice(1)} format`,
    detail: ok ? `${clean(value)} matches ${format.example}.`
      : `Expected ${format.example}. Correct it before submitting.`,
  };
}

/**
 * claim: { memberId, facilityId, practitionerId, serviceCode, requiresPreauth,
 *          billableStart, billableEnd, serviceStart, serviceEnd, itemAmounts, total, preauthReference }
 * confirmedReference: the reference the clerk recorded after comparing it with the scan, or null.
 */
export function checkClaim(claim, confirmedReference = null) {
  const checks = [
    formatCheck("member-id", "member", claim.memberId, "Claim.patient"),
    formatCheck("facility-id", "facility", claim.facilityId, "Claim.provider"),
    formatCheck("practitioner-id", "practitioner", claim.practitionerId, "Claim.careTeam.provider"),
    formatCheck("service-code", "service", claim.serviceCode, "Claim.item.productOrService"),
  ];

  const dates = [claim.billableStart, claim.billableEnd, claim.serviceStart, claim.serviceEnd].map(clean);
  const [billStart, billEnd, serveStart, serveEnd] = dates;
  const datesValid = dates.every(date => DATE.test(date) && !Number.isNaN(Date.parse(date)));
  checks.push({
    id: "service-period", expression: "Claim.item.servicedPeriod",
    title: "Service start and end dates",
    status: datesValid && serveStart <= serveEnd && billStart <= billEnd ? "pass" : "fail",
    detail: !datesValid ? "Each intervention needs a start and an end date (YYYY-MM-DD)."
      : serveStart > serveEnd || billStart > billEnd ? "A period ends before it starts."
        : `Service ${serveStart} to ${serveEnd}.`,
  });
  // Only the date is compared, not the time, as the published rule states.
  const within = datesValid && serveStart >= billStart && serveEnd <= billEnd;
  checks.push({
    id: "billable-period", expression: "Claim.billablePeriod",
    title: "Service dates within the billable period",
    status: within ? "pass" : "fail",
    detail: within ? `${serveStart} to ${serveEnd} is inside ${billStart} to ${billEnd}.`
      : datesValid ? `Service ${serveStart} to ${serveEnd} falls outside the billable period ${billStart} to ${billEnd}.`
        : "Service dates must fall within the claim's billable period.",
  });

  const items = amounts(claim.itemAmounts);
  const total = Number(clean(claim.total));
  const totalOk = items !== null && clean(claim.total) !== "" && Number.isFinite(total)
    && cents(total) === items.reduce((sum, amount) => sum + cents(amount), 0);
  checks.push({
    id: "claim-total", expression: "Claim.total",
    title: "Claim total equals the sum of item amounts",
    status: totalOk ? "pass" : "fail",
    detail: items === null ? "Enter each item's net amount, separated by commas."
      : totalOk ? `${items.length} item(s) add up to ${total.toFixed(2)}.`
        : `Items add up to ${(items.reduce((sum, amount) => sum + cents(amount), 0) / 100).toFixed(2)}, not ${clean(claim.total) || "an empty total"}.`,
  });

  if (claim.requiresPreauth) {
    const onClaim = clean(claim.preauthReference);
    const wrongKind = Object.entries(FORMATS)
      .find(([, format]) => format.pattern.test(onClaim))?.[1];
    let status = "fail";
    let detail;
    if (!onClaim) detail = "This service requires preauthorization, but the claim has no reference.";
    else if (wrongKind) detail = `${onClaim} looks like a ${wrongKind.name}, not a payer preauthorization reference.`;
    else if (!confirmedReference) {
      status = "pending";
      detail = "Confirm the reference on the supporting scan first.";
    } else if (onClaim !== confirmedReference) {
      detail = `The claim says ${onClaim}, but the scan shows ${confirmedReference}. Check every O, 0, I and 1.`;
    } else {
      status = "pass";
      detail = `${onClaim} matches the reference confirmed on the scan.`;
    }
    checks.push({
      id: "preauth-reference", expression: "Claim.extension:preauth-token",
      title: "Preauthorization reference matches the scan", status, detail,
    });
  }

  const failed = checks.filter(check => check.status === "fail").length;
  const pending = checks.filter(check => check.status === "pending").length;
  return {
    checks,
    verdict: failed ? "hold" : pending ? "pending" : "ready",
    summary: failed ? `Hold: ${failed} issue${failed === 1 ? "" : "s"} to fix before submitting`
      : pending ? "Almost ready: confirm the preauthorization reference on the scan"
        : "Ready to submit. Payer approval still needs verification.",
  };
}

// FHIR R4 OperationOutcome for the failed and pending checks. Contains no scan content.
export function operationOutcome(result) {
  const issues = result.checks.filter(check => check.status !== "pass").map(check => ({
    severity: check.status === "fail" ? "error" : "warning",
    code: check.status === "fail" ? "invalid" : "incomplete",
    diagnostics: `${check.title}: ${check.detail}`,
    expression: [check.expression],
  }));
  return {
    resourceType: "OperationOutcome",
    issue: issues.length ? issues
      : [{ severity: "information", code: "informational", diagnostics: result.summary }],
  };
}

// Synthetic demo claims. Identifiers follow the published formats but belong to no one.
export const DEMO_CLAIM = Object.freeze({
  memberId: "CR10000000001-1", facilityId: "FID-21-100001-1", practitionerId: "PUID-1000001-1",
  serviceCode: "SHA-08-004", requiresPreauth: true,
  billableStart: "2026-11-02", billableEnd: "2026-11-06", serviceStart: "2026-11-03", serviceEnd: "2026-11-04",
  itemAmounts: "12000, 3500.50", total: "15500.50", preauthReference: "DEMO-PA-240817",
});

export const DEMO_CLAIM_WITH_ERRORS = Object.freeze({
  ...DEMO_CLAIM,
  memberId: "CR1000000001-1", serviceEnd: "2026-11-08", total: "15000", preauthReference: "FID-21-100001-1",
});
