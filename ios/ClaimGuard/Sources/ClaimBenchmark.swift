import Foundation

enum BenchmarkOutcome: String, CaseIterable, Sendable {
    case correctExtraction = "Correct extraction"
    case correctAbstention = "Correct abstention"
    case wrongSuggestion = "Wrong suggestion"
    case falseSuggestion = "False suggestion"
    case missedReference = "Missed reference"
    case failed = "Not measured"

    static func score(expected: String?, displayed: String?) -> Self {
        switch (expected, displayed) {
        case (nil, nil): .correctAbstention
        case (nil, .some): .falseSuggestion
        case (.some, nil): .missedReference
        case let (.some(expected), .some(displayed)): expected == displayed ? .correctExtraction : .wrongSuggestion
        }
    }
}

struct BenchmarkAttempt: Sendable {
    let proposed: String?
    let displayed: String?
    let outcome: BenchmarkOutcome
    let wrongProposalBlocked: Bool
    let durationMs: Int?

    static func measured(expected: String?, proposed: String?, displayed: String?, durationMs: Int) -> Self {
        Self(proposed: proposed, displayed: displayed, outcome: .score(expected: expected, displayed: displayed),
             wrongProposalBlocked: proposed != nil && proposed != expected && displayed == nil,
             durationMs: durationMs)
    }

    static let failed = Self(proposed: nil, displayed: nil, outcome: .failed,
                             wrongProposalBlocked: false, durationMs: nil)
}

struct BenchmarkRow: Identifiable, Sendable {
    let sample: ScanSample
    let ocr: BenchmarkAttempt
    let model: BenchmarkAttempt
    var id: String { sample.id }
}

struct BenchmarkTotals {
    let counts: [BenchmarkOutcome: Int]
    let blocked: Int
    let p50: Int?
    let p95: Int?

    init(_ results: [BenchmarkAttempt]) {
        counts = Dictionary(grouping: results, by: \.outcome).mapValues(\.count)
        blocked = results.filter(\.wrongProposalBlocked).count
        let durations = results.compactMap(\.durationMs).sorted()
        func percentile(_ ratio: Double) -> Int? {
            guard !durations.isEmpty else { return nil }
            let index = Int(ceil(Double(durations.count) * ratio)) - 1
            return durations[index]
        }
        p50 = percentile(0.50)
        p95 = percentile(0.95)
    }
}

@MainActor
enum ClaimBenchmark {
    static func run(_ sample: ScanSample) async -> BenchmarkRow {
        guard let data = try? sample.data(),
              let read = try? await LocalVision.read(pages: [data]) else {
            return BenchmarkRow(sample: sample, ocr: .failed, model: .failed)
        }
        let candidate = read.evidence.candidate?.value.reference
        let baseline = BenchmarkAttempt.measured(expected: sample.expected, proposed: candidate,
                                                   displayed: candidate, durationMs: read.milliseconds)
        guard !Task.isCancelled, let reply = try? await ClaimInference.extract(from: read.text) else {
            return BenchmarkRow(sample: sample, ocr: baseline, model: .failed)
        }
        let review = EvidenceParser.reviewScanSuggestion(reply.text, source: read.text)
        let decision = EvidenceParser.decide(review, against: read.evidence)
        let displayed: String?
        if case let .ready(quote, _) = decision { displayed = quote.reference } else { displayed = nil }
        let model = BenchmarkAttempt.measured(
            expected: sample.expected, proposed: EvidenceParser.proposedReference(in: reply.text),
            displayed: displayed, durationMs: read.milliseconds + reply.milliseconds
        )
        return BenchmarkRow(sample: sample, ocr: baseline, model: model)
    }
}
