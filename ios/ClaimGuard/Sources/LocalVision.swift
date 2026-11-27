import Foundation
import Vision
import ImageIO

struct OCRRead: Sendable {
    let lines: [OCRLine]
    let evidence: OCREvidence
    let milliseconds: Int

    var text: String { lines.map(\.text).joined(separator: "\n") }
}

enum LocalVision {
    static func read(pages: [Data]) async throws -> OCRRead {
        let worker = Task.detached(priority: .userInitiated) {
            let clock = ContinuousClock()
            let started = clock.now
            var lines: [OCRLine] = []
            for (index, data) in pages.enumerated() {
                try Task.checkCancellation()
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                // Preserve identifier spelling, leading zeros, and O/0.
                request.usesLanguageCorrection = false
                request.recognitionLanguages = ["en-US"]
                try VNImageRequestHandler(data: data, options: [:]).perform([request])
                let pageLines = (request.results ?? []).compactMap { observation -> OCRLine? in
                    guard let match = observation.topCandidates(1).first else { return nil }
                    let bounds = observation.boundingBox.standardized
                    guard !bounds.isEmpty, !bounds.isInfinite, !bounds.isNull else { return nil }
                    return OCRLine(text: match.string, bounds: bounds, page: index)
                }
                // Vision uses a normalized bottom-left origin. Sort top-to-bottom.
                lines.append(contentsOf: pageLines.sorted { a, b in
                    if a.bounds.midY != b.bounds.midY { return a.bounds.midY > b.bounds.midY }
                    return a.bounds.minX < b.bounds.minX
                })
            }
            return OCRRead(lines: lines, evidence: OCREvidence(lines: lines),
                           milliseconds: milliseconds(started.duration(to: clock.now)))
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: {
            worker.cancel()
        }
    }
}

func milliseconds(_ duration: Duration) -> Int {
    let parts = duration.components
    return Int(parts.seconds) * 1_000 + Int(parts.attoseconds / 1_000_000_000_000_000)
}
