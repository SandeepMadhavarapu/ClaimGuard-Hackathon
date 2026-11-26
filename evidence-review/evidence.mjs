export const PUBLIC_RULE = Object.freeze({
  id: "SHA-AUTH-001",
  citation: "Social Health Insurance Regulations, 2024, regulation 60(1)",
  summary: "A health facility or provider sends an online preauthorization request to SHA for specialized healthcare services designated by SHA.",
});

// Only these static, public fields can enter the cloud prompt.
export const PUBLIC_PROMPT = [
  "Explain this public regulation for a hospital billing clerk in two short sentences.",
  "Use only the supplied summary. Do not add requirements or decide whether a claim is approved.",
  `${PUBLIC_RULE.id} | ${PUBLIC_RULE.citation} | ${PUBLIC_RULE.summary}`,
].join("\n");

export const CASES = [
  { label: "Reference provided", text: "SYNTHETIC REFERRAL LETTER\nPlease review the planned specialist service.\nPreauthorization reference: DEMO-PA-240817\nConfirm the authorization status in the payer portal.", expected: "DEMO-PA-240817" },
  { label: "Request pending", text: "SYNTHETIC FACILITY NOTE\nHospital reference: DEMO-PA-427091\nPreauthorization is pending and no payer reference has been issued.", expected: null },
  { label: "Multiple identifiers", text: "SYNTHETIC SERVICE SUMMARY\nCase number: DRAFT-5071\nPre-authorization number: DEMO-PA-928331\nReferral reference: REF-1105", expected: "DEMO-PA-928331" },
  { label: "Multiple preauthorization references", text: "SYNTHETIC REVIEW NOTE\nPreauthorization number: DEMO-PA-134220\nPreauthorization number: DEMO-PA-134221\nAsk the clerk which reference applies.", expected: null },
];

export const SCAN_CASES = Object.freeze([
  { label: "Specialist referral", file: "referral.png", expected: "DEMO-PA-240817" },
  { label: "Request pending", file: "pending.png", expected: null },
  { label: "Busy cover sheet", file: "cover-sheet.png", expected: "DEMO-PA-928331" },
  { label: "Conflicting references", file: "conflicting.png", expected: null },
]);

export function labeledReferences(letter) {
  const matches = letter.matchAll(/\bpre[- ]?authorization\s+(?:reference|number)[ \t]*:[ \t]*([A-Za-z0-9][A-Za-z0-9-]{2,39})(?![A-Za-z0-9-])/gi);
  return [...matches].filter(match => /\d/.test(match[1]))
    .map(match => ({ reference: match[1], quote: match[0] }));
}

export function matchLetter(letter) {
  const matches = labeledReferences(letter);
  return matches.length === 1 ? matches[0] : null;
}

export function readSuggestion(output) {
  try {
    return JSON.parse(output.trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, ""));
  } catch {
    return null;
  }
}

export function verifySuggestion(letter, output) {
  const candidate = readSuggestion(output);
  if (candidate?.reference === null && candidate?.quote === null) {
    return { status: "empty", candidate: null };
  }
  const match = matchLetter(letter);
  if (match && candidate?.reference === match.reference && typeof candidate.quote === "string"
      && letter.includes(candidate.quote) && candidate.quote.includes(match.quote)) {
    return { status: "verified", candidate: { reference: match.reference, quote: candidate.quote } };
  }
  return { status: "unsupported", candidate: null };
}

export function parseReference(value) {
  const reference = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/.test(reference) && /\d/.test(reference)
    ? reference : null;
}

export function reviewScanSuggestion(output) {
  const candidate = readSuggestion(output);
  if (candidate?.reference === null && candidate?.quote === null) {
    return { status: "empty", candidate: null };
  }
  if (typeof candidate?.reference !== "string" || typeof candidate.quote !== "string"
      || candidate.quote.length > 240) {
    return { status: "unsupported", candidate: null };
  }
  const reference = parseReference(candidate.reference);
  const quoted = matchLetter(candidate.quote);
  if (!reference || quoted?.reference !== reference) {
    return { status: "unsupported", candidate: null };
  }
  // The quoted text is a transcription from the model. The clerk verifies it against the scan.
  return { status: "review", candidate: { reference, quote: candidate.quote.trim() } };
}

export function scoreScanFixture(fixture, result) {
  if (result.status === "unsupported") return "Unsupported output";
  if (!result.candidate) return fixture.expected ? "Missed reference" : "Correct abstention";
  return result.candidate.reference === fixture.expected ? "Correct extraction" : "Wrong suggestion";
}

export function compareReferenceEvidence(candidate, independent) {
  if (!independent) return "manual";
  return candidate.reference === independent.reference ? "matched" : "conflict";
}

export function preauthorizationFinding(confirmedReference) {
  // Mirrors the reference-presence check for a claim that requires preauthorization.
  return { rule: PUBLIC_RULE.id, pass: Boolean(confirmedReference), approval: "pending" };
}

export function scoreFixture(fixture, result) {
  if (result.status === "unsupported") return "Unsupported suggestion blocked";
  if ((result.candidate?.reference ?? null) === fixture.expected) return "Exact match";
  return result.candidate ? "Incorrect reference" : "Missed reference";
}
