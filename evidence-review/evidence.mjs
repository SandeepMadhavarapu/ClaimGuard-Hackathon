export const PUBLIC_RULE = Object.freeze({
  id: "CG-AUTH-001",
  citation: "Synthetic payer policy",
  summary: "In this demo, claims flagged for preauthorization require one clearly labeled payer reference. Approval must be verified separately with the payer.",
});

// Only these static, public fields can enter the cloud prompt.
export const PUBLIC_PROMPT = [
  "Explain this synthetic payer policy for a hospital billing clerk in two short sentences.",
  "Use only the supplied summary. Do not add requirements or decide whether a claim is approved.",
  `${PUBLIC_RULE.id} | ${PUBLIC_RULE.citation} | ${PUBLIC_RULE.summary}`,
].join("\n");

// Next-step guidance. Only one of these fixed outcome codes and its public demo checklist can
// reach a model. No document text, reference, OCR output, or image is ever part of the prompt.
export const NEXT_STEPS = Object.freeze({
  RECORDED: Object.freeze({
    label: "Reference recorded",
    meaning: "A clearly labeled payer preauthorization reference was found, compared with the original, and recorded by the clerk.",
    checklist: [
      "Enter the recorded reference in the claim's preauthorization field.",
      "Attach the supporting document to the claim.",
      "Confirm the approval status with the payer before submitting.",
      "Submit the claim within the payer's filing window.",
    ],
  }),
  NO_REFERENCE: Object.freeze({
    label: "No payer reference",
    meaning: "No clearly labeled payer preauthorization reference was found. The field may be missing, blank, or pending.",
    checklist: [
      "Do not use a hospital, referral, case, or tracking number in its place.",
      "Check the payer portal or payer correspondence for an issued preauthorization.",
      "If the request is still pending, hold the claim and set a follow-up date.",
      "If no request exists, submit a preauthorization request before claiming the service.",
    ],
  }),
  CONFLICT: Object.freeze({
    label: "Conflicting references",
    meaning: "More than one different payer preauthorization reference appears on the document.",
    checklist: [
      "Do not choose between the references without confirmation.",
      "Ask the payer which reference applies to this service and date.",
      "Enter the confirmed reference manually and note where it came from.",
      "Keep both documents with the claim file.",
    ],
  }),
  NEEDS_REVIEW: Object.freeze({
    label: "Needs manual review",
    meaning: "The automated reads could not confirm a single reference, so the suggestion was withheld.",
    checklist: [
      "Compare the original scan line by line.",
      "If the payer label and value are clear, enter the reference manually.",
      "If the scan is unreadable, request a clearer copy.",
      "Escalate to a supervisor if the reference still cannot be confirmed.",
    ],
  }),
});

export const NEXT_STEP_CODES = Object.freeze(Object.keys(NEXT_STEPS));

// Gemini Nano's supported output languages exclude Kiswahili, so Kiswahili guidance is routed to the cloud.
export const NEXT_STEP_LANGUAGES = Object.freeze({
  en: Object.freeze({ name: "English", instruction: null, route: "hybrid" }),
  sw: Object.freeze({ name: "Kiswahili", instruction: "Write the whole answer in Kiswahili.", route: "cloud" }),
});

export function nextStepPrompt(code, language = "en") {
  const step = NEXT_STEPS[code];
  if (!Object.hasOwn(NEXT_STEPS, code) || !step) throw new Error("Unknown outcome code");
  const lang = Object.hasOwn(NEXT_STEP_LANGUAGES, language) ? NEXT_STEP_LANGUAGES[language] : null;
  if (!lang) throw new Error("Unknown language");
  return [
    ...(lang.instruction ? [lang.instruction] : []),
    "You help a hospital billing clerk decide what to do next on a claim.",
    "Use only the demo checklist below. In the first sentence, state the single most important next action.",
    "Then list the remaining steps in short bullets. Do not add steps, numbers, names, or approval decisions.",
    `Outcome: ${code} | ${step.meaning}`,
    "Demo checklist (synthetic, not official payer guidance):",
    ...step.checklist.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

// Maps a review decision to an outcome code. A candidate still awaiting the clerk has no code yet.
export function nextStepCode(status) {
  return {
    empty: "NO_REFERENCE", conflict: "CONFLICT", unsupported: "NEEDS_REVIEW",
    uncorroborated: "NEEDS_REVIEW", disagreement: "NEEDS_REVIEW", recorded: "RECORDED",
  }[status] ?? null;
}

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

const ID_TOKEN = /[A-Za-z0-9][A-Za-z0-9-]{2,39}/g;
const OTHER_ID_LABEL = /\b(?:hospital|tracking|referral|claim|case|facility|member|patient)\b/i;

// A quote whose payer label was transcribed loosely ("Pre-auth no.") still has to contain the
// reference as its only ID-shaped token and must not carry another kind of identifier label.
function looselyLabeled(quote, reference) {
  if (!/\bpre[- ]?auth/i.test(quote) || OTHER_ID_LABEL.test(quote)) return false;
  const ids = (quote.match(ID_TOKEN) ?? []).filter(token => /\d/.test(token));
  return ids.length === 1 && ids[0] === reference;
}

export function reviewScanSuggestion(output) {
  const candidate = readSuggestion(output);
  // An explicit "no reference" answer is an abstention, even when the model adds a quote
  // or writes a non-identifier such as "NOT ISSUED" in the reference field.
  if (candidate && "reference" in candidate
      && (candidate.reference === null
        || (typeof candidate.reference === "string" && !parseReference(candidate.reference)))) {
    return { status: "empty", candidate: null };
  }
  if (typeof candidate?.reference !== "string" || typeof candidate.quote !== "string"
      || candidate.quote.length > 240) {
    return { status: "unsupported", candidate: null };
  }
  const reference = parseReference(candidate.reference);
  const labeled = labeledReferences(candidate.quote);
  const supported = labeled.length === 1 ? labeled[0].reference === reference
    : labeled.length === 0 && looselyLabeled(candidate.quote, reference);
  if (!reference || !supported) {
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

export function decideScanReview(review, evidence) {
  if (evidence.references > 1) return { status: "conflict", candidate: null };
  if (!review.candidate) return review;
  const decision = compareReferenceEvidence(review.candidate, evidence.candidate);
  if (decision === "manual") return { status: "uncorroborated", candidate: null };
  if (decision === "conflict") return { status: "disagreement", candidate: null };
  return { status: "review", candidate: review.candidate, box: evidence.candidate.box };
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
