import Foundation
import XCTest
@testable import ClaimGuard

final class LayoutAndClaimTests: XCTestCase {
    private func lines(_ texts: String...) -> [OCRLine] {
        texts.enumerated().map { index, text in
            OCRLine(text: text, bounds: CGRect(x: 0.1, y: 0.9 - Double(index) * 0.08, width: 0.7, height: 0.05), page: 0)
        }
    }

    private var referral: [OCRLine] {
        lines("NORTHLINE DEMO CLINIC", "Specialist referral for Wanjiru Kamau", "Case number: DRAFT-5071",
              "Preauthorization reference: DEMO-PA-240817", "Hospital tracking ID: FAC-01328",
              "The payer issued a preauthorization reference.")
    }

    func testLayoutKeepsFormWordsAndReplacesValuesWithSlots() {
        let page = LayoutRead.build(referral)
        XCTAssertEqual(page.layout, [
            "clinic", "referral for", "case number: [ID-1]", "preauthorization reference: [ID-2]",
            "hospital tracking id: [ID-3]", "the payer issued a preauthorization reference",
        ].joined(separator: "\n"))
        XCTAssertEqual(page.slots.map(\.value), ["DRAFT-5071", "DEMO-PA-240817", "FAC-01328"])
    }

    func testNoValueNameOrOutOfVocabularyWordReachesThePrompt() {
        let prompt = LayoutRead.prompt(LayoutRead.build(referral))
        for secret in ["Wanjiru", "Kamau", "NORTHLINE", "DRAFT-5071", "DEMO-PA-240817", "FAC-01328", "Specialist"] {
            XCTAssertFalse(prompt.contains(secret), "\(secret) leaked")
        }
        var generator = SystemRandomNumberGenerator()
        let alphabet = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-:.'")
        let vocabulary = Array(LayoutRead.vocabulary)
        for _ in 0..<200 {
            let rows = (0..<Int.random(in: 1...5, using: &generator)).map { _ in
                (0..<Int.random(in: 1...8, using: &generator)).map { _ in
                    Bool.random(using: &generator) ? vocabulary.randomElement(using: &generator)!
                        : String((0..<Int.random(in: 1...12, using: &generator)).map { _ in alphabet.randomElement(using: &generator)! })
                }.joined(separator: " ")
            }
            let page = LayoutRead.build(rows.enumerated().map { OCRLine(text: $0.element, bounds: CGRect(x: 0, y: 0, width: 1, height: 0.1), page: 0) })
            for token in page.layout.split(whereSeparator: \.isWhitespace).map(String.init) {
                let bare = token.hasSuffix(":") ? String(token.dropLast()) : token
                let isSlot = bare.range(of: #"^\[ID-\d+\]$"#, options: .regularExpression) != nil
                let isTag = bare.range(of: #"^\([A-Z]\)$"#, options: .regularExpression) != nil
                XCTAssertTrue(isSlot || isTag || bare == "…" || LayoutRead.vocabulary.contains(bare), "unexpected \(token)")
            }
        }
    }

    func testGuardMapsTheLabeledSlotAndBlocksEverythingElse() {
        let page = LayoutRead.build(referral)
        let ocr = OCREvidence(lines: referral)
        guard case .ready(let shown, _) = LayoutRead.resolve(#"{"slot":"ID-2"}"#, page: page, ocr: ocr) else {
            return XCTFail("expected the labeled slot")
        }
        XCTAssertEqual(shown.reference, "DEMO-PA-240817")
        XCTAssertEqual(LayoutRead.resolve(#"{"slot":"ID-3"}"#, page: page, ocr: ocr), .unsupported)
        XCTAssertEqual(LayoutRead.resolve(#"{"slot":"ID-9"}"#, page: page, ocr: ocr), .unsupported)
        XCTAssertEqual(LayoutRead.resolve("DEMO-PA-240817", page: page, ocr: ocr), .unsupported)
        XCTAssertEqual(LayoutRead.resolve(#"{"slot":"NONE"}"#, page: page, ocr: ocr), .abstained)
        XCTAssertEqual(LayoutRead.sweep(page, ocr: ocr, expected: "DEMO-PA-240817").wrongShown, 0)
    }

    func testTwoLabeledReferencesAreAConflictWhateverTheModelSays() {
        let conflicting = lines("Preauthorization number: DEMO-PA-134220", "Preauthorization number: DEMO-PA-134221")
        let page = LayoutRead.build(conflicting)
        XCTAssertEqual(LayoutRead.resolve(#"{"slot":"ID-1"}"#, page: page, ocr: OCREvidence(lines: conflicting)), .conflict)
        XCTAssertEqual(LayoutRead.resolve(#"{"slot":"NONE"}"#, page: page, ocr: OCREvidence(lines: [])), .conflict)
    }

    func testLabelsBelongToTheFieldTheyPrecede() {
        let grid = lines("Case number: CASE-3494 Auth. ref: DEMO-PA-571220")
        let page = LayoutRead.build(grid)
        XCTAssertEqual(LayoutRead.labeledValues(page), ["DEMO-PA-571220"])
        XCTAssertEqual(LayoutRead.resolve(#"{"slot":"ID-1"}"#, page: page, ocr: OCREvidence(lines: grid)), .unsupported)
        let prose = lines("The payer issued preauthorization reference DEMO-PA-463173 for this service.")
        if case .ready = LayoutRead.resolve(#"{"slot":"ID-1"}"#, page: LayoutRead.build(prose), ocr: OCREvidence(lines: prose)) {} else {
            XCTFail("a reference stated in a sentence should be readable")
        }
        let two = lines("Preauthorization number: DEMO-PA-100001", "Authorization code: AUTH-26-84909")
        XCTAssertEqual(OCREvidence(lines: two).references.count, 2)
        XCTAssertNil(OCREvidence(lines: two).candidate)
        XCTAssertEqual(Lookalikes.note("PA-64O730")?.contains("letter O at position 6, zero at position 9"), true)
    }

    func testLeakGatePassesCleanLayoutsAndCatchesValues() {
        let page = LayoutRead.build(referral)
        let prompt = LayoutRead.prompt(page)
        XCTAssertEqual(LayoutRead.leakGate(prompt, page: page).identifiers, 0)
        XCTAssertEqual(LayoutRead.leakGate(prompt + "\nDEMO-PA-240817", page: page).identifiers, 1)
        XCTAssertGreaterThan(LayoutRead.leakGate(prompt + "\nCR10000000001-1", page: page).identifiers, 0)
    }

    func testClaimPreCheckMatchesTheWebRules() {
        let waiting = ClaimCheck.check(.demo, confirmedReference: nil, scanOutcome: nil)
        XCTAssertEqual(waiting.verdict, .pending)
        let ready = ClaimCheck.check(.demo, confirmedReference: "DEMO-PA-240817", scanOutcome: .recorded)
        XCTAssertEqual(ready.verdict, .ready)
        XCTAssertTrue(ready.checks.allSatisfy { $0.status == .pass })
        let errors = ClaimCheck.check(.demoWithErrors, confirmedReference: "DEMO-PA-240817", scanOutcome: .recorded)
        XCTAssertEqual(errors.verdict, .hold)
        XCTAssertEqual(errors.checks.filter { $0.status == .fail }.map(\.id),
                       ["member-id", "billable-period", "claim-total", "preauth-reference"])
        XCTAssertTrue(errors.checks.last!.detail.contains("facility ID"))
        let conflict = ClaimCheck.check(.demo, confirmedReference: nil, scanOutcome: .conflict)
        XCTAssertEqual(conflict.summary, "Hold: conflicting payer references on the scan")
        XCTAssertEqual(ClaimCheck.check(.demoWithErrors, confirmedReference: nil, scanOutcome: .conflict).summary,
                       "Hold: conflicting payer references on the scan (+3 more issues)")
        var cents = ClaimDraft.demo
        cents.itemAmounts = "0.1, 0.2"
        cents.total = "0.3"
        XCTAssertEqual(ClaimCheck.check(cents, confirmedReference: nil, scanOutcome: nil).checks.first(where: { $0.id == "claim-total" })?.status, .pass)
    }

    func testKiswahiliIsCloudOnlyAndGuidanceIsGrounded() {
        XCTAssertTrue(NextStepLanguage.kiswahili.cloudOnly)
        XCTAssertTrue(NextStepCode.conflict.prompt(language: .kiswahili).hasPrefix("Write the whole answer in Kiswahili."))
        XCTAssertEqual(NextStepCode.conflict.prompt(language: .english), NextStepCode.conflict.prompt)
        XCTAssertNil(NextStepGrounding.check("Ask the payer which reference applies.\n- Keep both documents."))
        XCTAssertEqual(NextStepGrounding.check("Use DEMO-PA-134220 on the claim."), "identifier")
        XCTAssertEqual(NextStepGrounding.check("Call 0712345678."), "number")
        XCTAssertEqual(NextStepGrounding.check("See https://example.com"), "link or email")
    }

    func testHeldClaimsShowOnlyTheApprovedAction() {
        let attempts = ["Submit the claim immediately.", "Once you see both references, submit the claim.", "Wasilisha dai mara moja.",
                        "Use the first reference and keep going.", "Do not submit until the payer confirms which reference applies."]
        let holds: [(NextStepCode, ClaimCheckResult.Verdict)] = [(.conflict, .hold), (.noReference, .hold), (.needsReview, .pending), (.recorded, .hold), (.recorded, .pending)]
        for (code, verdict) in holds {
            XCTAssertFalse(GuidancePolicy.explanationAllowed(code: code, verdict: verdict))
            for text in attempts { XCTAssertNotNil(GuidancePolicy.check(text, code: code, verdict: verdict), text) }
        }
        XCTAssertNil(GuidancePolicy.check("Confirm the approval with the payer, then submit the claim within the filing window.", code: .recorded, verdict: .ready))
        XCTAssertEqual(GuidancePolicy.check("Use DEMO-PA-134220.", code: .recorded, verdict: .ready), "identifier")
        XCTAssertEqual(ApprovedAction.forOutcome(.recorded, verdict: .hold, language: .english).id, "fix-claim-before-submitting")
        XCTAssertEqual(ApprovedAction.forOutcome(.conflict, verdict: .hold, language: .english).id, "ask-payer-which-reference")
    }
}
