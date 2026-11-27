import Foundation

struct ReferenceQuote: Equatable, Sendable {
    let reference: String
    let quote: String
}

struct OCRLine: Sendable {
    let text: String
    let bounds: CGRect
    let page: Int
}

struct EvidenceLocation: Equatable, Sendable {
    let page: Int
    let bounds: CGRect
}

struct OCRCandidate: Equatable, Sendable {
    let value: ReferenceQuote
    let location: EvidenceLocation
}

struct OCREvidence: Equatable, Sendable {
    let references: Set<String>
    let candidate: OCRCandidate?

    init(lines: [OCRLine]) {
        let matches = lines.flatMap { line in
            EvidenceParser.labeledReferences(in: line.text).map { match in
                OCRCandidate(value: match, location: EvidenceLocation(page: line.page, bounds: line.bounds))
            }
        }
        references = Set(matches.map(\.value.reference))
        candidate = references.count == 1 ? matches.first : nil
    }
}

enum SuggestionReview: Equatable, Sendable {
    case abstained
    case unsupported
    case review(ReferenceQuote)
}

enum ScanDecision: Equatable, Sendable {
    case conflict
    case disagreement
    case corroborationMissing
    case abstained
    case unsupported
    case ready(ReferenceQuote, EvidenceLocation)
}

enum EvidenceParser {
    // This mirrors the Web label grammar, including the end-of-token check.
    private static let label = regex(#"\bpre[- ]?authorization\s+(?:reference|number)[ \t]*:[ \t]*([A-Za-z0-9][A-Za-z0-9-]{2,39})(?![A-Za-z0-9-])"#, [.caseInsensitive])
    private static let identifier = regex(#"^[A-Za-z0-9][A-Za-z0-9-]{2,39}$"#)
    private static let token = regex(#"[A-Za-z0-9][A-Za-z0-9-]{2,39}"#)
    private static let looseLabel = regex(#"\bpre[- ]?auth"#, [.caseInsensitive])
    private static let otherLabel = regex(#"\b(?:hospital|tracking|referral|claim|case|facility|member|patient)\b"#, [.caseInsensitive])
    private static let digit = regex("[0-9]")
    private static let fences = regex(#"^\x60{3}(?:json)?\s*|\s*\x60{3}$"#, [.caseInsensitive])

    private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        // All patterns are compile-time constants.
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    private static func range(_ text: String) -> NSRange {
        NSRange(text.startIndex..<text.endIndex, in: text)
    }

    private static func contains(_ expression: NSRegularExpression, in text: String) -> Bool {
        expression.firstMatch(in: text, range: range(text)) != nil
    }

    static func parseReference(_ input: String) -> String? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard contains(identifier, in: value), contains(digit, in: value) else { return nil }
        return value
    }

    static func labeledReferences(in text: String) -> [ReferenceQuote] {
        label.matches(in: text, range: range(text)).compactMap { match in
            guard let valueRange = Range(match.range(at: 1), in: text),
                  let quoteRange = Range(match.range, in: text),
                  let reference = parseReference(String(text[valueRange])) else { return nil }
            return ReferenceQuote(reference: reference, quote: String(text[quoteRange]))
        }
    }

    private static func jsonObject(_ output: String) -> [String: Any]? {
        let text = output.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\u{201C}", with: "\"")
            .replacingOccurrences(of: "\u{201D}", with: "\"")
        let unwrapped = fences.stringByReplacingMatches(in: text, range: range(text), withTemplate: "")
        if let object = (try? JSONSerialization.jsonObject(with: Data(unwrapped.utf8))) as? [String: Any] {
            return object
        }
        // Some on-device replies wrap the object in a sentence. Use the outermost braces only.
        guard let open = unwrapped.firstIndex(of: "{"), let close = unwrapped.lastIndex(of: "}"), open < close else {
            return nil
        }
        let inner = String(unwrapped[open...close])
        return (try? JSONSerialization.jsonObject(with: Data(inner.utf8))) as? [String: Any]
    }

    static func proposedReference(in output: String) -> String? {
        guard let raw = jsonObject(output)?["reference"] as? String, raw.utf16.count <= 80 else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    /// `source` is the OCR text the model read. When the model's own quote is unusable, the
    /// reference is still supported if it is the value of exactly one labeled payer line in that
    /// text, and that line becomes the quote. The OCR cross-check in `decide` still applies.
    static func reviewScanSuggestion(_ output: String, source: String? = nil) -> SuggestionReview {
        let direct = reviewModelQuote(output)
        guard direct == .unsupported, let source,
              let raw = jsonObject(output)?["reference"] as? String,
              let reference = parseReference(raw) else { return direct }
        let grounded = labeledReferences(in: source)
        guard Set(grounded.map(\.reference)).count == 1, let line = grounded.first,
              line.reference == reference else { return direct }
        return .review(line)
    }

    private static func reviewModelQuote(_ output: String) -> SuggestionReview {
        guard let candidate = jsonObject(output), let rawReference = candidate["reference"] else {
            return .unsupported
        }
        if rawReference is NSNull { return .abstained }
        guard let stringReference = rawReference as? String else { return .unsupported }
        guard let reference = parseReference(stringReference) else { return .abstained }
        guard let quote = candidate["quote"] as? String, quote.utf16.count <= 240 else { return .unsupported }

        let labels = labeledReferences(in: quote)
        let supported = labels.count == 1
            ? labels[0].reference == reference
            : labels.isEmpty && looselyLabeled(quote, reference: reference)
        guard supported else { return .unsupported }
        return .review(ReferenceQuote(reference: reference, quote: quote.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    private static func looselyLabeled(_ quote: String, reference: String) -> Bool {
        guard contains(looseLabel, in: quote), !contains(otherLabel, in: quote) else { return false }
        let ids = token.matches(in: quote, range: range(quote)).compactMap { result -> String? in
            guard let match = Range(result.range, in: quote) else { return nil }
            let value = String(quote[match])
            return contains(digit, in: value) ? value : nil
        }
        return ids == [reference]
    }

    static func decide(_ review: SuggestionReview, against ocr: OCREvidence) -> ScanDecision {
        if ocr.references.count > 1 { return .conflict }
        switch review {
        case .abstained:
            return .abstained
        case .unsupported:
            return .unsupported
        case .review(let suggestion):
            guard let independent = ocr.candidate else { return .corroborationMissing }
            guard independent.value.reference == suggestion.reference else { return .disagreement }
            return .ready(suggestion, independent.location)
        }
    }
}


/// Next-step guidance. Only one of these fixed outcome codes and its public demo checklist can
/// reach a model. The prompt text matches the Web app exactly. No document data is ever included.
enum NextStepCode: String, CaseIterable, Sendable {
    case recorded = "RECORDED"
    case noReference = "NO_REFERENCE"
    case conflict = "CONFLICT"
    case needsReview = "NEEDS_REVIEW"

    var label: String {
        switch self {
        case .recorded: "Reference recorded"
        case .noReference: "No payer reference"
        case .conflict: "Conflicting references"
        case .needsReview: "Needs manual review"
        }
    }

    var meaning: String {
        switch self {
        case .recorded: "A clearly labeled payer preauthorization reference was found, compared with the original, and recorded by the clerk."
        case .noReference: "No clearly labeled payer preauthorization reference was found. The field may be missing, blank, or pending."
        case .conflict: "More than one different payer preauthorization reference appears on the document."
        case .needsReview: "The automated reads could not confirm a single reference, so the suggestion was withheld."
        }
    }

    var checklist: [String] {
        switch self {
        case .recorded: [
            "Enter the recorded reference in the claim's preauthorization field.",
            "Attach the supporting document to the claim.",
            "Confirm the approval status with the payer before submitting.",
            "Submit the claim within the payer's filing window.",
        ]
        case .noReference: [
            "Do not use a hospital, referral, case, or tracking number in its place.",
            "Check the payer portal or payer correspondence for an issued preauthorization.",
            "If the request is still pending, hold the claim and set a follow-up date.",
            "If no request exists, submit a preauthorization request before claiming the service.",
        ]
        case .conflict: [
            "Do not choose between the references without confirmation.",
            "Ask the payer which reference applies to this service and date.",
            "Enter the confirmed reference manually and note where it came from.",
            "Keep both documents with the claim file.",
        ]
        case .needsReview: [
            "Compare the original scan line by line.",
            "If the payer label and value are clear, enter the reference manually.",
            "If the scan is unreadable, request a clearer copy.",
            "Escalate to a supervisor if the reference still cannot be confirmed.",
        ]
        }
    }

    var prompt: String {
        ([
            "You help a hospital billing clerk decide what to do next on a claim.",
            "Use only the demo checklist below. In the first sentence, state the single most important next action.",
            "Then list the remaining steps in short bullets. Do not add steps, numbers, names, or approval decisions.",
            "Outcome: \(rawValue) | \(meaning)",
            "Demo checklist (synthetic, not official payer guidance):",
        ] + checklist.enumerated().map { "\($0.offset + 1). \($0.element)" }).joined(separator: "\n")
    }

    /// A candidate still awaiting the clerk has no outcome yet.
    init?(_ decision: ScanDecision) {
        switch decision {
        case .conflict: self = .conflict
        case .disagreement, .corroborationMissing, .unsupported: self = .needsReview
        case .abstained: self = .noReference
        case .ready: return nil
        }
    }

    init?(code: String) { self.init(rawValue: code) }
}
