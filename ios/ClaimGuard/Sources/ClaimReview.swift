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
    var policyError: String?

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

    private func resetFinding() {
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
            } else if let candidate = read.evidence.candidate {
                show(candidate.value, at: candidate.location)
                status = "Local OCR found a labeled reference. Compare it with the scan."
            } else {
                status = "Local OCR found no clearly labeled payer reference."
            }
            return
        }

        do {
            let reply = try await ClaimInference.extract(from: read.text)
            trace("Check payer reference", reply.route, reply.milliseconds)
            switch EvidenceParser.decide(EvidenceParser.reviewScanSuggestion(reply.text), against: read.evidence) {
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
            } else if let modelError = error as? LocalModelError {
                status = modelError.localizedDescription
            } else {
                status = "The on-device model could not finish. Try local OCR or review the original."
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
    }

    func explain(cloudOnly: Bool = false) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        policy = nil
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
