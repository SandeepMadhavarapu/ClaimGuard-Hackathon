import SwiftUI
import UniformTypeIdentifiers

struct BenchmarkScreen: View {
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [BenchmarkRow] = []
    @State private var running = false
    @State private var runTask: Task<Void, Never>?
    @State private var export: BenchmarkJSONDocument?
    @State private var showingExport = false
    @State private var exportFailed = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button("Run all 12 samples", systemImage: "play.circle.fill", action: start)
                        .disabled(running)
                    if running {
                        ProgressView(value: Double(rows.count), total: Double(ScanSample.all.count)) {
                            Text("Completed \(rows.count) of \(ScanSample.all.count)")
                        }
                        Button("Cancel run", role: .cancel) { runTask?.cancel() }
                    }
                    Text("Vision OCR and Apple Intelligence + guard use the same synthetic PNGs. Model failures count as not measured. Latencies include OCR for both paths.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    NavigationLink {
                        HeldoutScreen()
                    } label: {
                        Label("Held-out set B · 50 new documents", systemImage: "checklist")
                    }
                }
                if !rows.isEmpty {
                    Button("Save synthetic benchmark report", systemImage: "square.and.arrow.up") {
                        do {
                            export = BenchmarkJSONDocument(bytes: try BenchmarkEvidence.encode(rows))
                            showingExport = true
                        } catch {
                            exportFailed = true
                        }
                    }
                    .disabled(running)
                    totals("Vision OCR", rows.map(\.ocr))
                    totals("Apple Intelligence + guard", rows.map(\.model))
                    Section("Per-scan results") {
                        ForEach(rows) { row in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(row.sample.title).font(.headline)
                                Text("Expected: \(row.sample.expected ?? "Abstain")")
                                attempt("Vision OCR", row.ocr)
                                attempt("Apple Intelligence + guard", row.model)
                            }
                            .padding(.vertical, 5)
                        }
                    }
                }
            }
            .navigationTitle("Benchmark")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .onDisappear { runTask?.cancel() }
        }
        .tint(.claimAccent)
        .fileExporter(isPresented: $showingExport, document: export, contentType: .json,
                      defaultFilename: "claimguard-ios-benchmark") { result in
            if case .failure = result { exportFailed = true }
        }
        .alert("Could not export the benchmark", isPresented: $exportFailed) {
            Button("OK", role: .cancel) {}
        }
    }

    private func totals(_ title: String, _ attempts: [BenchmarkAttempt]) -> some View {
        let summary = BenchmarkTotals(attempts)
        return Section(title) {
            ForEach(BenchmarkOutcome.allCases, id: \.self) { outcome in
                LabeledContent(outcome.rawValue, value: String(summary.counts[outcome, default: 0]))
            }
            LabeledContent("Wrong proposals blocked", value: String(summary.blocked))
            LabeledContent("p50 / p95 latency", value: "\(time(summary.p50)) / \(time(summary.p95))")
        }
    }

    private func attempt(_ path: String, _ result: BenchmarkAttempt) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(path).font(.subheadline.bold())
            if result.outcome != .failed {
                Text("Proposed: \(result.proposed ?? "None")")
                Text("Displayed: \(result.displayed ?? "None")")
            }
            Text("\(result.outcome.rawValue) · \(time(result.durationMs))")
            if result.wrongProposalBlocked { Text("Wrong proposal blocked") }
        }
        .font(.footnote)
    }

    private func time(_ value: Int?) -> String { value.map { "\($0) ms" } ?? "—" }

    private func start() {
        rows = []
        running = true
        runTask = Task { @MainActor in
            defer { running = false }
            for sample in ScanSample.all {
                guard !Task.isCancelled else { break }
                let row = await ClaimBenchmark.run(sample)
                guard !Task.isCancelled else { break }
                rows.append(row)
            }
        }
    }
}

struct BenchmarkJSONDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.json]
    let bytes: Data

    init(bytes: Data) { self.bytes = bytes }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        bytes = data
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: bytes)
    }
}
