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
        // Count every value whose own label says payer authorization, in any wording, so a second
        // reference under an unfamiliar label still makes the page a conflict.
        references = Set(matches.map(\.value.reference)).union(LayoutRead.labeledValues(LayoutRead.build(lines)))
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

    var prompt: String { prompt(language: .english) }

    func prompt(language: NextStepLanguage) -> String {
        ((language.instruction.map { [$0] } ?? []) + [
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

/// Gemini Nano and Apple's on-device model don't output Kiswahili, so Kiswahili guidance is a
/// cloud-only request. It is still only the fixed public checklist plus one instruction.
enum NextStepLanguage: String, CaseIterable, Identifiable, Sendable {
    case english = "en"
    case kiswahili = "sw"

    var id: String { rawValue }
    var name: String { self == .english ? "English" : "Kiswahili" }
    var instruction: String? { self == .english ? nil : "Write the whole answer in Kiswahili." }
    var cloudOnly: Bool { self == .kiswahili }
}

/// Generated guidance that adds an identifier, a long number, a link or an email is discarded and
/// the fixed checklist is shown instead. Matches groundNextStep in the Web app.
enum NextStepGrounding {
    static func check(_ text: String) -> String? {
        let answer = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if answer.isEmpty { return "empty" }
        if answer.count > 1500 { return "too long" }
        func has(_ pattern: String, _ options: String.CompareOptions = [.regularExpression]) -> Bool {
            answer.range(of: pattern, options: options) != nil
        }
        if has(#"https?://|www\.|@[A-Za-z0-9-]+\."#, [.regularExpression, .caseInsensitive]) { return "link or email" }
        if has(#"\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b"#) { return "identifier" }
        if has(#"\d{3,}|\+\d"#) { return "number" }
        return nil
    }
}


/// The app, not the model, decides which action is allowed: a vetted first action per outcome and
/// claim verdict. Model text is only an explanation, and a deny rule overrides it when it recommends
/// something the verdict forbids. Matches APPROVED_ACTIONS and guidancePolicy in the Web app.
struct ApprovedAction: Equatable, Sendable {
    let id: String
    let text: String

    static func forOutcome(_ code: NextStepCode, verdict: ClaimCheckResult.Verdict, language: NextStepLanguage) -> ApprovedAction {
        let sw = language == .kiswahili
        switch code {
        case .conflict:
            return ApprovedAction(id: "ask-payer-which-reference", text: sw
                ? "Uliza mlipaji ni rejea ipi inayohusu huduma hii na tarehe hii. Usichague rejea wewe mwenyewe."
                : "Ask the payer which reference applies to this service and date. Do not choose one yourself.")
        case .noReference:
            return ApprovedAction(id: "get-preauthorization-first", text: sw
                ? "Simamisha dai na upate rejea ya uidhinishaji kutoka kwa mlipaji kabla ya kuwasilisha."
                : "Hold the claim and get the preauthorization reference from the payer before submitting.")
        case .needsReview:
            return ApprovedAction(id: "compare-with-original", text: sw
                ? "Linganisha rejea na nakala asili herufi kwa herufi kabla ya kuiandika."
                : "Compare the reference with the original scan character by character before recording it.")
        case .recorded where verdict == .ready:
            return ApprovedAction(id: "confirm-approval-then-submit", text: sw
                ? "Thibitisha idhini na mlipaji, kisha wasilisha dai ndani ya muda wa kuwasilisha."
                : "Confirm the approval with the payer, then submit the claim within the filing window.")
        case .recorded:
            return ApprovedAction(id: "fix-claim-before-submitting", text: sw
                ? "Rekebisha makosa ya ukaguzi wa dai kabla ya kuwasilisha. Rejea imeandikwa, lakini dai limesimamishwa."
                : "Fix the claim pre-check issues before submitting. The reference is recorded, but the claim is on hold.")
        }
    }
}

enum GuidancePolicy {
    private static let submit = #"\b(submit\w*|send(?:ing)? (?:the|this) claim|file (?:the|this) claim|lodge\w*|wasilish\w*|tuma dai|peleka dai)\b"#
    private static let choose = #"\b(use|choose|pick|select|go with|tumia|chagua)\b[^.]{0,40}\b(first|second|newer|newest|latest|older|higher|lower|either|one of|ya kwanza|ya pili|mojawapo)\b"#
    private static let negated = #"\b(do not|don't|never|not|no|avoid|before|until|unless|only after|once|after the payer|hold|usi\w+|kabla ya|hadi|mpaka|baada ya)\b"#
    private static let splitter = #"[.;!?\n]+|\bbut\b|\bhowever\b|\blakini\b"#

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func affirmativeClauses(_ text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: splitter, options: [.caseInsensitive]) else { return [text] }
        let marked = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "\u{1F}")
        return marked.split(separator: "\u{1F}").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !matches($0, negated) }
    }

    /// Returns nil when the text may be shown, otherwise the reason it was discarded.
    static func check(_ text: String, code: NextStepCode, verdict: ClaimCheckResult.Verdict) -> String? {
        if let reason = NextStepGrounding.check(text) { return reason }
        let clauses = affirmativeClauses(text)
        let submitAllowed = code == .recorded && verdict == .ready
        if !submitAllowed && clauses.contains(where: { matches($0, submit) }) { return "recommends submitting while the claim is not ready" }
        if code != .recorded && clauses.contains(where: { matches($0, choose) }) { return "picks a reference without payer confirmation" }
        return nil
    }
}

/// Characters OCR and people confuse, named with 1-based positions. Matches lookalikeNote on Web.
enum Lookalikes {
    private static let names: [Character: String] = ["0": "zero", "O": "letter O", "o": "letter o", "1": "one", "I": "letter I", "l": "letter l"]

    static func note(_ value: String) -> String? {
        let found = value.enumerated().compactMap { index, character in names[character].map { "\($0) at position \(index + 1)" } }
        guard !found.isEmpty else { return nil }
        let listed = found.prefix(6).joined(separator: ", ") + (found.count > 6 ? ", and \(found.count - 6) more" : "")
        return "Check these characters against the scan: \(listed). OCR cannot reliably tell O from 0 or I from 1."
    }
}
