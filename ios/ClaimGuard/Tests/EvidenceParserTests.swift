import Foundation
import XCTest
@testable import ClaimGuard

final class EvidenceParserTests: XCTestCase {
    private let id = "DEMO-PA-240817"
    private let quote = "Preauthorization reference: DEMO-PA-240817"

    private func evidence(_ lines: String...) -> OCREvidence {
        OCREvidence(lines: lines.enumerated().map { index, text in
            OCRLine(text: text, bounds: CGRect(x: 0.10, y: 0.25, width: 0.70, height: 0.08), page: index)
        })
    }

    private func json(_ reference: String, _ quote: String) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["reference": reference, "quote": quote])
        return String(decoding: data, as: UTF8.self)
    }

    func testFourWebTextFixtures() {
        XCTAssertEqual(evidence("Please review the planned specialist service.", quote,
                                "Confirm the authorization status in the payer portal.").candidate?.value.reference, id)
        XCTAssertNil(evidence("Hospital reference: DEMO-PA-427091",
                              "Preauthorization is pending and no payer reference has been issued.").candidate)
        XCTAssertEqual(evidence("Case number: DRAFT-5071", "Pre-authorization number: DEMO-PA-928331",
                                "Referral reference: REF-1105").candidate?.value.reference, "DEMO-PA-928331")
        let two = evidence("Preauthorization number: DEMO-PA-134220", "Preauthorization number: DEMO-PA-134221")
        XCTAssertEqual(two.references.count, 2)
        XCTAssertNil(two.candidate)
    }

    func testLabelGrammarPreservesLeadingZerosAndLookalikes() {
        XCTAssertEqual(evidence("Pre authorization number: PA-000741").candidate?.value.reference, "PA-000741")
        XCTAssertEqual(evidence("PREAUTHORIZATION REFERENCE: DEM0-PA-001518").candidate?.value.reference, "DEM0-PA-001518")
        XCTAssertEqual(evidence(quote, quote).references, Set([id]))
        XCTAssertNil(evidence("Preauthorization reference: pending").candidate)
        XCTAssertNil(evidence("Preauthorization reference:", "Hospital tracking ID: FAC-01328").candidate)
        XCTAssertNil(evidence("Preauthorization reference: NO-" + String(repeating: "1", count: 40)).candidate)
        XCTAssertEqual(EvidenceParser.parseReference(" PA-000741 "), "PA-000741")
        for invalid in ["Pending", "A1", "DEMO/1", "D" + String(repeating: "0", count: 40)] {
            XCTAssertNil(EvidenceParser.parseReference(invalid), invalid)
        }
    }

    func testStrictAndLoosePayerQuotes() throws {
        let expected = SuggestionReview.review(ReferenceQuote(reference: id, quote: quote))
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion(try json(id, quote)), expected)
        let fence = String(repeating: "\u{60}", count: 3)
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion(fence + "json\n" + (try json(id, quote)) + "\n" + fence), expected)
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion(try json("PA-000741", "Pre-auth no. PA-000741")),
                       .review(ReferenceQuote(reference: "PA-000741", quote: "Pre-auth no. PA-000741")))
        for invalid in [
            id, "Hospital tracking ID: \(id)", "Pre-auth no. \(id) Hospital tracking ID: FAC-01328",
            "Pre-auth no. FAKE-999", quote + "\nPreauthorization number: DEMO-PA-9",
            quote + String(repeating: " ", count: 241),
        ] {
            XCTAssertEqual(EvidenceParser.reviewScanSuggestion(try json(id, invalid)), .unsupported, invalid)
        }
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion(try json("FAKE-999", quote)), .unsupported)
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion("{"), .unsupported)
    }

    func testWrappedJSONAndSourceGrounding() throws {
        let expected = SuggestionReview.review(ReferenceQuote(reference: id, quote: quote))
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion("Here is the result: " + (try json(id, quote)) + " Done."), expected)
        let source = "Case number: DRAFT-5071\n\(quote)\nHospital tracking ID: FAC-01328"
        // The model's own quote is unusable, but the reference is the single labeled payer line.
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion(try json(id, "DEMO PA 240817"), source: source), expected)
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion(try json(id, "DEMO PA 240817")), .unsupported)
        // Grounding never adopts a value the source does not label, or a page with two references.
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion(try json("FAC-01328", "x"), source: source), .unsupported)
        let conflicting = source + "\nPreauthorization number: DEMO-PA-134221"
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion(try json(id, "x"), source: conflicting), .unsupported)
    }

    func testExplicitAndNonIdentifierAbstentions() {
        for output in [
            #"{"reference":null,"quote":null}"#,
            #"{"reference":null,"quote":"Preauthorization pending"}"#,
            #"{"reference":"NOT ISSUED","quote":"Preauthorization reference: NOT ISSUED"}"#,
            #"{"reference":"PREAUTHORIZATION REFERENCE:","quote":"Preauthorization reference:"}"#,
            #"{"reference":"","quote":null}"#,
        ] {
            XCTAssertEqual(EvidenceParser.reviewScanSuggestion(output), .abstained, output)
        }
        XCTAssertEqual(EvidenceParser.reviewScanSuggestion(#"{"quote":"Preauthorization reference: DEMO-PA-240817"}"#), .unsupported)
    }

    func testCrossCheckWithholdsConflictsDisagreementsAndMissingOCR() {
        let candidate = ReferenceQuote(reference: "DEM0-PA-001518", quote: "Preauthorization reference: DEM0-PA-001518")
        let review = SuggestionReview.review(candidate)
        let supported = evidence("Case number: DRAFT-5071", candidate.quote)
        guard case let .ready(result, position) = EvidenceParser.decide(review, against: supported) else {
            return XCTFail("Expected a candidate with its OCR location")
        }
        XCTAssertEqual(result, candidate)
        XCTAssertEqual(position.page, 1)
        XCTAssertEqual(position.bounds.width, 0.70, accuracy: 0.0001)
        XCTAssertEqual(EvidenceParser.decide(review, against: evidence("Preauthorization reference: DEMO-PA-001518")), .disagreement)
        XCTAssertEqual(EvidenceParser.decide(review, against: evidence(candidate.quote, quote)), .conflict)
        XCTAssertEqual(EvidenceParser.decide(.abstained, against: evidence(candidate.quote, quote)), .conflict)
        XCTAssertEqual(EvidenceParser.decide(review, against: evidence("HOSPITAL TRACKING ID: FAC-1")), .corroborationMissing)
    }

    func testRoutesAreVerifiedFromModelVersion() {
        let apple = InferenceRoute.appleModelVersion
        let gemini = "gemini-3.5-flash-lite"
        XCTAssertEqual(InferenceRoute.verifiedFirebaseRoute(modelVersion: apple), .onDevice)
        XCTAssertNil(InferenceRoute.verifiedFirebaseRoute(modelVersion: gemini))
        XCTAssertEqual(InferenceRoute.verifiedFirebaseRoute(modelVersion: gemini, expectedCloud: gemini), .cloud)
        XCTAssertNil(InferenceRoute.verifiedFirebaseRoute(modelVersion: "unrecognized", expectedCloud: gemini))
        XCTAssertNil(InferenceRoute.verifiedFirebaseRoute(modelVersion: nil, expectedCloud: gemini))
    }

    func testBundledFixtureManifestAndBenchmark() throws {
        XCTAssertEqual(ScanSample.all.count, 12)
        XCTAssertEqual(Set(ScanSample.all.map(\.id)).count, 12)
        XCTAssertEqual(ScanSample.all.filter { $0.expected == nil }.count, 6)
        XCTAssertEqual(ScanSample.all.first { $0.id == "lookalike-digits" }?.expected, "DEM0-PA-001518")
        let pngHeader: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]
        for sample in ScanSample.all { XCTAssertEqual(Array(try sample.data().prefix(8)), pngHeader, sample.id) }

        let blocked = BenchmarkAttempt.measured(expected: nil, proposed: "WRONG-1", displayed: nil, durationMs: 25)
        let correct = BenchmarkAttempt.measured(expected: id, proposed: id, displayed: id, durationMs: 100)
        let result = BenchmarkTotals([blocked, correct, .failed])
        XCTAssertEqual(blocked.outcome, .correctAbstention)
        XCTAssertEqual(result.counts[.failed], 1)
        XCTAssertEqual(result.blocked, 1)
        XCTAssertEqual(result.p50, 25)
        XCTAssertEqual(result.p95, 100)
        XCTAssertEqual(BenchmarkOutcome.score(expected: nil, displayed: id), .falseSuggestion)
        XCTAssertEqual(BenchmarkOutcome.score(expected: id, displayed: "WRONG-1"), .wrongSuggestion)
    }

    func testPublicPromptMatchesWebAndContainsNoFixture() async {
        let prompt = await MainActor.run { ClaimInference.publicPrompt }
        XCTAssertEqual(prompt, [
            "Explain this synthetic payer policy for a hospital billing clerk in two short sentences.",
            "Use only the supplied summary. Do not add requirements or decide whether a claim is approved.",
            "CG-AUTH-001 | Synthetic payer policy | In this demo, claims flagged for preauthorization require one clearly labeled payer reference. Approval must be verified separately with the payer.",
        ].joined(separator: "\n"))
        XCTAssertFalse(prompt.contains(id))
    }
    func testSyntheticBenchmarkExportHasFingerprintsAndOmitsModelText() throws {
        let sample = try XCTUnwrap(ScanSample.all.first)
        let hash = BenchmarkEvidence.fingerprint(try sample.data())
        XCTAssertEqual(hash.count, 64)
        let measured = BenchmarkAttempt.measured(expected: sample.expected, proposed: "PRIVATE-CANARY-17",
                                                 displayed: nil, durationMs: 22)
        let row = BenchmarkRow(sample: sample, sampleSha256: hash, ocr: measured, model: .failed)
        let json = try BenchmarkEvidence.encode([row])
        let text = String(decoding: json, as: UTF8.self)
        XCTAssertTrue(text.contains(hash))
        XCTAssertTrue(text.contains("LOCAL_OCR"))
        XCTAssertFalse(text.contains("ON_DEVICE"))
        XCTAssertFalse(text.contains("PRIVATE-CANARY"))
        XCTAssertFalse(text.contains("proposed"))
    }


    func testNextStepPromptsAreFixedPublicText() {
        XCTAssertEqual(NextStepCode.allCases.map(\.rawValue), ["RECORDED", "NO_REFERENCE", "CONFLICT", "NEEDS_REVIEW"])
        for code in NextStepCode.allCases {
            XCTAssertTrue(code.prompt.contains("Outcome: \(code.rawValue) |"))
            XCTAssertTrue(code.prompt.contains("synthetic, not official payer guidance"))
            for leaked in ["DEMO-PA", "DRAFT-", "FAC-", "PA-0"] { XCTAssertFalse(code.prompt.contains(leaked), leaked) }
        }
        XCTAssertNil(NextStepCode(code: "DEMO-PA-240817"))
        XCTAssertEqual(NextStepCode(.conflict), .conflict)
        XCTAssertEqual(NextStepCode(.abstained), .noReference)
        XCTAssertEqual(NextStepCode(.disagreement), .needsReview)
        XCTAssertEqual(NextStepCode(.corroborationMissing), .needsReview)
        XCTAssertEqual(NextStepCode(.unsupported), .needsReview)
        XCTAssertNil(NextStepCode(.ready(ReferenceQuote(reference: "X-1", quote: "x"), EvidenceLocation(page: 0, bounds: .zero))))
    }
}
