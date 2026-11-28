import Foundation
import Observation
import VisionKit

struct TraceEntry: Identifiable {
    let id = UUID()
    let action: String
    let route: InferenceRoute
    let milliseconds: Int
}

@MainActor
@Observable
final class ClaimReview {
    var document: ScanDocument?
    var page = 0
    var location: EvidenceLocation?
    var suggestion: ReferenceQuote?
    var recordedReference: String?
    var isCompared = false
    var manualReference = ""
    var manualCompared = false
    var status = "Choose a sample or scan a document."
    var busy = false
    var showingCamera = false
    var traces: [TraceEntry] = []
    var policy: VerifiedReply?
    var policyWasCloudTest = false
    var policyError: String?
    var outcome: NextStepCode?
    var nextStep: VerifiedReply?
    var nextStepError: String?
    var language: NextStepLanguage = .english
    var layoutPrompt: String?
    var claim = ClaimDraft.demo

    var claimResult: ClaimCheckResult {
        ClaimCheck.check(claim, confirmedReference: recordedReference, scanOutcome: outcome)
    }

    func select(_ sample: ScanSample) {
        do {
            load(try ScanDocument(title: sample.title, pages: [sample.data()]))
        } catch {
            clear()
            status = "Could not open the bundled sample."
        }
    }

    func startCamera() {
        if VNDocumentCameraViewController.isSupported {
            showingCamera = true
        } else {
            status = "The document camera is unavailable. Choose a bundled sample."
        }
    }

    func finishCamera(_ result: Result<[Data], Error>?) {
        showingCamera = false
        guard let result else { return }
        do {
            load(try ScanDocument(title: "Captured document", pages: result.get()))
        } catch {
            clear()
            status = "Could not read the camera scan."
        }
    }

    func clear() {
        document = nil
        page = 0
        resetFinding()
        status = "Choose a sample or scan a document."
    }

    private func load(_ document: ScanDocument) {
        clear()
        self.document = document
        status = "Ready to read \(document.title)."
    }

    private func setOutcome(_ code: NextStepCode?) {
        outcome = code
        nextStep = nil
        nextStepError = nil
    }

    private func resetFinding() {
        setOutcome(nil)
        layoutPrompt = nil
        location = nil
        suggestion = nil
        recordedReference = nil
        isCompared = false
        manualReference = ""
        manualCompared = false
    }

    private func show(_ candidate: ReferenceQuote, at location: EvidenceLocation) {
        self.suggestion = candidate
        self.location = location
        page = location.page
    }

    func read(useModel: Bool) async {
        guard let document, !busy else { return }
        busy = true
        defer { busy = false }
        resetFinding()
        status = "Reading the scan on this device."
        let read: OCRRead
        do {
            read = try await LocalVision.read(pages: document.pages)
        } catch {
            status = "Local OCR could not read this scan. You can review it manually."
            return
        }
        trace("Read scan", .localOCR, read.milliseconds)

        if !useModel {
            if read.evidence.references.count > 1 {
                status = "Conflict: resolve manually."
                setOutcome(.conflict)
            } else if let candidate = read.evidence.candidate {
                show(candidate.value, at: candidate.location)
                status = "Local OCR found a labeled reference. Compare it with the scan."
            } else {
                status = "Local OCR found no clearly labeled payer reference."
                setOutcome(.noReference)
            }
            return
        }

        do {
            let reply = try await ClaimInference.extract(from: read.text)
            trace("Check payer reference", reply.route, reply.milliseconds)
            let decision = EvidenceParser.decide(EvidenceParser.reviewScanSuggestion(reply.text, source: read.text), against: read.evidence)
            setOutcome(NextStepCode(decision))
            switch decision {
            case .conflict:
                status = "Conflict: resolve manually."
            case .disagreement:
                status = "Disagreement. The model and local OCR read different references."
            case .corroborationMissing:
                status = "The model’s suggestion was withheld. Local OCR could not confirm it."
            case .abstained:
                status = "No clearly labeled payer reference was suggested."
            case .unsupported:
                status = "The model’s quote did not support a payer reference. The suggestion was withheld."
            case .ready(let candidate, let evidence):
                show(candidate, at: evidence)
                status = "On-device model and local OCR agree. Compare the highlighted line with the original."
            }
        } catch {
            if read.evidence.references.count > 1 {
                status = "Conflict: resolve manually."
                setOutcome(.conflict)
            } else if let modelError = error as? LocalModelError {
                status = modelError.localizedDescription
            } else {
                status = "The on-device model could not finish. Try local OCR or review the original."
            }
        }
    }

    /// Private layout read: Vision on this device, then only form words and slot names go to the
    /// model (Apple Foundation Models first, Gemini fallback). The slot maps back here.
    func readPrivateLayout(cloudOnly: Bool = false) async {
        guard let document, !busy else { return }
        busy = true
        defer { busy = false }
        resetFinding()
        status = "Reading the scan on this device, then removing identifier values."
        let read: OCRRead
        do {
            read = try await LocalVision.read(pages: document.pages)
        } catch {
            status = "Local OCR could not read this scan. You can review it manually."
            return
        }
        trace("Read scan", .localOCR, read.milliseconds)
        let page = LayoutRead.build(read.lines)
        let prompt = LayoutRead.prompt(page)
        layoutPrompt = prompt
        do {
            let reply = try await ClaimInference.readLayout(prompt, cloudOnly: cloudOnly)
            trace("Read private layout", reply.route, reply.milliseconds)
            let decision = LayoutRead.resolve(reply.text, page: page, ocr: read.evidence)
            let pick = LayoutRead.pick(in: reply.text) ?? "nothing usable"
            let route = reply.route == .onDevice ? "On-device" : cloudOnly ? "Cloud test" : "Cloud fallback"
            setOutcome(NextStepCode(decision))
            switch decision {
            case .ready(let candidate, let evidence):
                show(candidate, at: evidence)
                status = "\(route) · \(reply.milliseconds) ms · Picked \(pick). Values stayed on this device. Compare the highlighted line with the original."
            case .conflict:
                status = "\(route) · Picked \(pick). Conflict: more than one payer reference is labeled. Resolve manually."
            case .abstained:
                status = "\(route) · No payer reference slot was found."
            case .disagreement:
                status = "\(route) · The model's slot and the OCR rule disagree. Review the scan."
            case .corroborationMissing, .unsupported:
                status = "\(route) · Picked \(pick), which is not labeled as a payer reference. Blocked."
            }
        } catch {
            if read.evidence.references.count > 1 {
                status = "Conflict: resolve manually."
                setOutcome(.conflict)
            } else if let modelError = error as? LocalModelError {
                status = modelError.localizedDescription
            } else {
                status = "The private layout read is unavailable. Use local OCR or review the original."
            }
        }
    }

    func recordSuggestion() {
        guard isCompared, let suggestion else { return }
        record(suggestion.reference)
    }

    func recordManual() {
        guard manualCompared, let reference = EvidenceParser.parseReference(manualReference) else { return }
        record(reference)
    }

    private func record(_ reference: String) {
        recordedReference = reference
        status = "Reference recorded. Payer approval is pending verification."
        trace("Record reference", .human, 0)
        setOutcome(.recorded)
    }

    func suggestNextStep() async {
        guard let code = outcome, !busy else { return }
        busy = true
        defer { busy = false }
        nextStep = nil
        nextStepError = nil
        do {
            let result = try await ClaimInference.nextStep(code, language: language)
            trace("Next step (\(code.label), \(language.name))", result.route, result.milliseconds)
            if let reason = GuidancePolicy.check(result.text, code: code, verdict: claimResult.verdict) {
                nextStepError = "Explanation discarded (\(reason)). Follow the approved action."
            } else {
                nextStep = result
            }
        } catch let error as LocalModelError {
            nextStepError = error.localizedDescription
        } catch {
            nextStepError = "AI guidance unavailable. Follow the checklist."
        }
    }

    func explain(cloudOnly: Bool = false) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        policy = nil
        policyWasCloudTest = cloudOnly
        policyError = nil
        do {
            let result = try await ClaimInference.explainPublicPolicy(cloudOnly: cloudOnly)
            policy = result
            trace("Explain public policy", result.route, result.milliseconds)
        } catch let error as LocalModelError {
            policyError = error.localizedDescription
        } catch {
            policyError = "Policy explanation unavailable. Check Apple Intelligence, network, and App Check."
        }
    }

    private func trace(_ action: String, _ route: InferenceRoute, _ duration: Int) {
        traces.insert(TraceEntry(action: action, route: route, milliseconds: duration), at: 0)
        if traces.count > 100 { traces.removeLast() }
    }
}
