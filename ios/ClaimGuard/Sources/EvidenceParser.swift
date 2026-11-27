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
