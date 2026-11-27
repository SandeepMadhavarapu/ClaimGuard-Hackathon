import Foundation
import CryptoKit

enum BenchmarkOutcome: String, CaseIterable, Codable, Sendable {
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
    let sampleSha256: String?
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

enum BenchmarkEvidence {
    struct Attempt: Encodable {
        let outcome: BenchmarkOutcome
        let source: String?
        let milliseconds: Int?
        let wrongProposalBlocked: Bool

        init(_ result: BenchmarkAttempt, verifiedSource: String) {
            outcome = result.outcome
            source = result.outcome == .failed ? nil : verifiedSource
            milliseconds = result.durationMs
            wrongProposalBlocked = result.wrongProposalBlocked
        }
    }

    struct Row: Encodable {
        let sample: String
        let sampleSha256: String?
        let ocr: Attempt
        let model: Attempt
    }

    struct Report: Encodable {
        let schemaVersion = 2
        let platform = "ios"
        let dataset = "claimguard-synthetic-v3"
        let operatingSystem: String
        let completedRows: Int
        let plannedRows: Int
        let rows: [Row]
    }

    static func fingerprint(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func encode(_ results: [BenchmarkRow]) throws -> Data {
        let bundled = Set(ScanSample.all.map(\.id))
        let rows = results.filter { bundled.contains($0.sample.id) }.map { result in
            Row(sample: result.sample.id + ".png", sampleSha256: result.sampleSha256,
                ocr: Attempt(result.ocr, verifiedSource: "LOCAL_OCR"),
                model: Attempt(result.model, verifiedSource: "ON_DEVICE"))
        }
        let report = Report(operatingSystem: ProcessInfo.processInfo.operatingSystemVersionString,
                            completedRows: rows.count, plannedRows: ScanSample.all.count, rows: rows)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(report)
    }
}

@MainActor
enum ClaimBenchmark {
    static func run(_ sample: ScanSample) async -> BenchmarkRow {
        guard let data = try? sample.data() else {
            return BenchmarkRow(sample: sample, sampleSha256: nil, ocr: .failed, model: .failed)
        }
        let fingerprint = BenchmarkEvidence.fingerprint(data)
        guard let read = try? await LocalVision.read(pages: [data]) else {
            return BenchmarkRow(sample: sample, sampleSha256: fingerprint, ocr: .failed, model: .failed)
        }
        let candidate = read.evidence.candidate?.value.reference
        let baseline = BenchmarkAttempt.measured(expected: sample.expected, proposed: candidate,
                                                   displayed: candidate, durationMs: read.milliseconds)
        guard !Task.isCancelled, let reply = try? await ClaimInference.extract(from: read.text) else {
            return BenchmarkRow(sample: sample, sampleSha256: fingerprint, ocr: baseline, model: .failed)
        }
        let review = EvidenceParser.reviewScanSuggestion(reply.text, source: read.text)
        let decision = EvidenceParser.decide(review, against: read.evidence)
        let displayed: String?
        if case let .ready(quote, _) = decision { displayed = quote.reference } else { displayed = nil }
        let model = BenchmarkAttempt.measured(
            expected: sample.expected, proposed: EvidenceParser.proposedReference(in: reply.text),
            displayed: displayed, durationMs: read.milliseconds + reply.milliseconds
        )
        return BenchmarkRow(sample: sample, sampleSha256: fingerprint, ocr: baseline, model: model)
    }
}
