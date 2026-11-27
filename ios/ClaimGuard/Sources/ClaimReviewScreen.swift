import SwiftUI
import UIKit

struct ClaimReviewScreen: View {
    @State private var review = ClaimReview()
    @State private var showTrace = false
    @State private var showPrompt = false
    @State private var showBenchmark = false
    @Environment(\.scenePhase) private var scenePhase
    @State private var modelStatus = ClaimInference.availability

    var body: some View {
        @Bindable var state = review
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    captureCard
                    if let document = review.document { scanCard(document) }
                    verificationCard
                    if let code = review.outcome { nextStepCard(code) }
                    policyCard
                }
                .frame(maxWidth: 660)
                .padding()
                .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("ClaimGuard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu("Tools", systemImage: "ellipsis.circle") {
                        Button("Benchmark", systemImage: "chart.bar") { showBenchmark = true }
                        Button("Runtime trace", systemImage: "list.bullet.rectangle") { showTrace = true }
                    }
                    .disabled(review.busy)
                }
            }
            .sheet(isPresented: $showTrace) { traceSheet }
            .sheet(isPresented: $showPrompt) { promptSheet }
            .sheet(isPresented: $showBenchmark) { BenchmarkScreen() }
            .fullScreenCover(isPresented: $state.showingCamera) {
                DocumentCamera(onResult: review.finishCamera)
                    .ignoresSafeArea()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { modelStatus = ClaimInference.availability }
            }
        }
        .tint(.claimAccent)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Claim review")
                .font(.largeTitle.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Text("Find the payer’s reference and compare it with the original scan before recording it.")
                .foregroundStyle(.white.opacity(0.86))
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { stepLabels }
                VStack(alignment: .leading, spacing: 8) { stepLabels }
            }
        }
        .foregroundStyle(.white)
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [Color(red: 0.10, green: 0.10, blue: 0.18),
                                    Color(red: 0.30, green: 0.25, blue: 0.49)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 22)
        )
    }

    @ViewBuilder
    private var stepLabels: some View {
        step("Read", icon: "doc.viewfinder", active: review.suggestion == nil && review.recordedReference == nil)
        step("Verify", icon: "magnifyingglass", active: review.suggestion != nil && review.recordedReference == nil)
        step("Record", icon: "checkmark.circle", active: review.recordedReference != nil)
    }

    private func step(_ title: String, icon: String, active: Bool) -> some View {
        Label(title, systemImage: icon)
            .font(.footnote.weight(active ? .bold : .medium))
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(.white.opacity(active ? 0.24 : 0.10), in: Capsule())
            .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var captureCard: some View {
        ClaimCard {
            Text("Supporting document").font(.title3.bold()).accessibilityAddTraits(.isHeader)
            Label("Read on this device", systemImage: "lock.shield")
                .font(.subheadline.weight(.semibold)).foregroundStyle(Color.privacyGreen)
                .accessibilityLabel("Privacy: document reading stays on this device")
            Text(modelStatus).font(.footnote).foregroundStyle(.secondary)
            ViewThatFits(in: .horizontal) {
                HStack { captureButtons }
                VStack(alignment: .leading) { captureButtons }
            }
            .disabled(review.busy)
            Text("Contest demo. Use the bundled synthetic scans or print a synthetic scan for camera capture.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var captureButtons: some View {
        Button("Scan document", systemImage: "camera.viewfinder", action: review.startCamera)
            .buttonStyle(.bordered)
        Menu("Use sample", systemImage: "doc.on.doc") {
            ForEach(ScanSample.all) { sample in
                Button(sample.title) { review.select(sample) }
            }
        }
        .buttonStyle(.bordered)
    }

    private func scanCard(_ scan: ScanDocument) -> some View {
        ClaimCard {
            Text(scan.title).font(.headline).accessibilityAddTraits(.isHeader)
            scanPreview(scan.images[review.page], bounds: review.location?.page == review.page ? review.location?.bounds : nil)
            if scan.pages.count > 1 {
                ViewThatFits(in: .horizontal) {
                    HStack { pageControls(scan) }
                    VStack(alignment: .leading) { pageControls(scan) }
                }
            }
            Button("Clear document", systemImage: "xmark.circle", action: review.clear)
                .disabled(review.busy)
        }
    }

    @ViewBuilder
    private func pageControls(_ scan: ScanDocument) -> some View {
        Button("Previous", systemImage: "chevron.left") { review.page -= 1 }
            .disabled(review.page == 0 || review.busy)
        Text("Page \(review.page + 1) of \(scan.pages.count)").font(.subheadline)
        Button("Next", systemImage: "chevron.right") { review.page += 1 }
            .disabled(review.page + 1 == scan.pages.count || review.busy)
    }

    private func scanPreview(_ image: UIImage, bounds: CGRect?) -> some View {
        Image(uiImage: image)
            .resizable()
            .aspectRatio(image.size.width / max(1, image.size.height), contentMode: .fit)
            .overlay {
                if let bounds {
                    GeometryReader { geo in
                        let rect = CGRect(
                            x: bounds.minX * geo.size.width,
                            y: (1 - bounds.maxY) * geo.size.height,
                            width: bounds.width * geo.size.width,
                            height: bounds.height * geo.size.height
                        )
                        RoundedRectangle(cornerRadius: 3)
                            .fill(.green.opacity(0.19))
                            .overlay { RoundedRectangle(cornerRadius: 3).strokeBorder(Color.privacyGreen, lineWidth: 2) }
                            .frame(width: rect.width, height: rect.height)
                            .position(x: rect.midX, y: rect.midY)
                    }
                }
            }
            .accessibilityLabel(bounds == nil ? "Original document page" :
                                "Original document page. The matched payer reference line is highlighted.")
    }

    private var verificationCard: some View {
        @Bindable var state = review
        return ClaimCard {
            Text("Preauthorization check").font(.title3.bold()).accessibilityAddTraits(.isHeader)
            Text(review.status)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Payer approval pending verification")
                .font(.subheadline.weight(.semibold))
            if review.busy { ProgressView().accessibilityLabel("Processing") }
            if let recordedReference = review.recordedReference {
                Label(recordedReference, systemImage: "checkmark.circle.fill")
                    .font(.headline.monospaced()).foregroundStyle(Color.privacyGreen)
            }
            if review.document != nil && review.recordedReference == nil {
                Button("Read with Apple Intelligence", systemImage: "sparkles") {
                    Task { await review.read(useModel: true) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.claimPurple)
                .disabled(review.busy || !FirebaseSetup.configured)
                Button("Read with local OCR", systemImage: "text.viewfinder") {
                    Task { await review.read(useModel: false) }
                }
                .buttonStyle(.bordered)
                .disabled(review.busy)
                if !FirebaseSetup.configured {
                    Text("Add the iOS Firebase configuration to enable the model.").font(.footnote)
                }
                if let suggestion = review.suggestion {
                    Divider()
                    Text(suggestion.reference).font(.headline.monospaced()).textSelection(.enabled)
                    Text(suggestion.quote).font(.subheadline).foregroundStyle(.secondary)
                    checkWarning
                    Toggle("I compared the reference and label with the original", isOn: $state.isCompared)
                    Button("Record reference", action: review.recordSuggestion)
                        .buttonStyle(.borderedProminent)
                        .tint(.claimPurple)
                        .disabled(!review.isCompared || review.busy)
                } else if !review.busy {
                    DisclosureGroup("Enter reference manually") {
                        VStack(alignment: .leading, spacing: 12) {
                            TextField("Reference printed on the document", text: $state.manualReference)
                                .font(.body.monospaced())
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .textFieldStyle(.roundedBorder)
                            checkWarning
                            Toggle("I compared the reference and label with the original", isOn: $state.manualCompared)
                            Button("Record reference", action: review.recordManual)
                                .buttonStyle(.borderedProminent)
                                .tint(.claimPurple)
                                .disabled(!review.manualCompared || EvidenceParser.parseReference(review.manualReference) == nil)
                        }.padding(.top, 8)
                    }
                }
            }
        }
    }

    private var checkWarning: some View {
        Label("Check O versus 0, I versus 1, and every leading zero.", systemImage: "exclamationmark.circle")
            .font(.footnote.weight(.medium)).foregroundStyle(.secondary)
    }

    private func nextStepCard(_ code: NextStepCode) -> some View {
        ClaimCard {
            HStack {
                Text("Next step").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                Text(code.label).font(.caption.weight(.semibold))
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(Color.claimPurple.opacity(0.15), in: Capsule())
            }
            Text("Only this outcome type and a public demo checklist are sent. On-device first, cloud if needed. No scan, reference, or document text.")
                .font(.footnote).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(code.checklist.enumerated()), id: \.offset) { item in
                    Text("\(item.offset + 1). \(item.element)").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            Button("Suggest next step", systemImage: "arrow.forward.circle") { Task { await review.suggestNextStep() } }
                .buttonStyle(.bordered)
                .disabled(review.busy || !FirebaseSetup.configured)
            DisclosureGroup("View the exact request") {
                Text(code.prompt).font(.footnote.monospaced()).textSelection(.enabled)
            }
            if let reply = review.nextStep {
                Label(reply.route == .onDevice ? "On-device" : "Cloud fallback",
                      systemImage: reply.route == .onDevice ? "iphone" : "cloud")
                    .font(.subheadline.weight(.semibold))
                Text(reply.text)
            }
            if let error = review.nextStepError { Text(error).font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private var policyCard: some View {
        ClaimCard {
            Text("Public policy").font(.title3.bold()).accessibilityAddTraits(.isHeader)
            Text("Synthetic payer rule CG-AUTH-001").font(.subheadline).foregroundStyle(.secondary)
            Button("Explain policy", systemImage: "text.bubble") { Task { await review.explain() } }
                .buttonStyle(.bordered)
                .disabled(review.busy || !FirebaseSetup.configured)
            Button("View exact cloud request", systemImage: "doc.text") { showPrompt = true }
            if let reply = review.policy {
                Label(reply.route == .onDevice ? "On-device" : review.policyWasCloudTest ? "Cloud test" : "Cloud fallback",
                      systemImage: reply.route == .onDevice ? "iphone" : "cloud")
                    .font(.subheadline.weight(.semibold))
                Text(reply.text)
            }
            if let error = review.policyError { Text(error).font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private var promptSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(ClaimInference.publicPrompt).font(.body.monospaced()).textSelection(.enabled)
                    Text("This is the public policy message. No scan, OCR text, or recorded reference is included.")
                        .foregroundStyle(.secondary)
                    if let reply = review.policy, reply.route == .cloud { Label("Cloud · verified by Firebase", systemImage: "cloud") }
                    if let error = review.policyError { Text(error).foregroundStyle(.secondary) }
                    Button("Test App Check cloud route", systemImage: "cloud") {
                        Task { await review.explain(cloudOnly: true) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(review.busy || !FirebaseSetup.configured)
                    #if DEBUG
                    if let token = FirebaseSetup.debugToken() {
                        Button("Copy App Check debug token", systemImage: "key") {
                            UIPasteboard.general.string = token
                        }
                        .buttonStyle(.bordered)
                        Text("Debug build: register this token in Firebase App Check under Manage debug tokens. Keep it private.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    #endif
                }.padding()
            }
            .navigationTitle("Exact cloud request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { showPrompt = false } }
        }
    }

    private var traceSheet: some View {
        NavigationStack {
            List(review.traces) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.action).font(.headline)
                    Text("\(entry.route.rawValue) · \(entry.milliseconds) ms").foregroundStyle(.secondary)
                }
            }
            .overlay {
                if review.traces.isEmpty {
                    ContentUnavailableView("No actions yet", systemImage: "list.bullet.rectangle")
                }
            }
            .navigationTitle("Runtime trace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { showTrace = false } }
        }
    }
}
