import SwiftUI
import UniformTypeIdentifiers

/// Held-out set B on iPhone: the same 50 synthetic documents the Web app uses, never seen during
/// development, read with the private layout read. Run it in airplane mode for the on-device route
/// (Apple Foundation Models through Firebase AI Logic) and online with "Cloud test" for Gemini, to
/// compare the two routes on the same documents.
struct HeldoutDocument: Decodable, Identifiable, Sendable {
    let file: String
    let category: String
    let expected: String?
    let note: String
    var id: String { file }

    static func all() -> [HeldoutDocument] {
        struct Set: Decodable { let documents: [HeldoutDocument] }
        guard let url = Bundle.main.url(forResource: "cases-b", withExtension: "json", subdirectory: "heldout"),
              let data = try? Data(contentsOf: url),
              let set = try? JSONDecoder().decode(Set.self, from: data) else { return [] }
        return set.documents
    }

    func data() throws -> Data {
        let name = (file as NSString).deletingPathExtension
        guard let url = Bundle.main.url(forResource: name, withExtension: "jpg", subdirectory: "heldout") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }
}

struct HeldoutRow: Identifiable, Encodable, Sendable {
    let file: String
    let note: String
    let expected: String?
    let pick: String?
    let shown: String?
    let outcome: String
    let route: String?
    let milliseconds: Int?
    let requestBytes: Int
    let identifiersInRequest: Int
    var id: String { file }
}

enum HeldoutRunner {
    /// Free-tier Gemini allows 15 requests per minute; cloud runs pace under it.
    static let cloudPaceSeconds = 4.2

    @MainActor
    static func run(_ document: HeldoutDocument, cloudOnly: Bool) async -> HeldoutRow {
        func failed(_ bytes: Int = 0, _ identifiers: Int = 0, _ outcome: String = BenchmarkOutcome.failed.rawValue) -> HeldoutRow {
            HeldoutRow(file: document.file, note: document.note, expected: document.expected, pick: nil, shown: nil,
                       outcome: outcome, route: nil, milliseconds: nil, requestBytes: bytes, identifiersInRequest: identifiers)
        }
        guard let data = try? document.data(), let read = try? await LocalVision.read(pages: [data]) else { return failed() }
        let page = LayoutRead.build(read.lines)
        let prompt = LayoutRead.prompt(page)
        let gate = LayoutRead.leakGate(prompt, page: page)
        guard gate.identifiers == 0 else { return failed(gate.bytes, gate.identifiers, "Blocked by leak gate") }
        guard let reply = try? await ClaimInference.readLayout(prompt, cloudOnly: cloudOnly) else { return failed(gate.bytes, 0) }
        let decision = LayoutRead.resolve(reply.text, page: page, ocr: read.evidence)
        var shown: String?
        if case let .ready(quote, _) = decision { shown = quote.reference }
        let outcome = BenchmarkOutcome.score(expected: document.expected, displayed: shown)
        return HeldoutRow(file: document.file, note: document.note, expected: document.expected,
                          pick: LayoutRead.pick(in: reply.text), shown: shown, outcome: outcome.rawValue,
                          route: reply.route.rawValue, milliseconds: read.milliseconds + reply.milliseconds,
                          requestBytes: gate.bytes, identifiersInRequest: 0)
    }

    static func summary(_ rows: [HeldoutRow]) -> String {
        let readable = rows.filter { $0.expected != nil }
        let hold = rows.filter { $0.expected == nil }
        let shown = { (row: HeldoutRow) in row.shown != nil }
        let correct = readable.filter { $0.outcome == BenchmarkOutcome.correctExtraction.rawValue }.count
        let wrong = readable.filter { $0.outcome == BenchmarkOutcome.wrongSuggestion.rawValue }.count
        let notMeasured = rows.filter { $0.outcome == BenchmarkOutcome.failed.rawValue }.count
        var text = "Of \(readable.count) readable documents, \(correct) extracted correctly, \(readable.filter { !shown($0) }.count) held, \(wrong) shown with a wrong value. "
            + "Of \(hold.count) that must be held, \(hold.filter { !shown($0) }.count) held and \(hold.filter(shown).count) wrongly offered."
        if notMeasured > 0 { text += " \(notMeasured) not measured." }
        return text
    }
}

struct HeldoutReport: Encodable {
    let kind = "claimguard-ios-heldout-b"
    let route: String
    let generatedAt: String
    let summary: String
    let rows: [HeldoutRow]
}

struct HeldoutScreen: View {
    @State private var cloudOnly = false
    @State private var rows: [HeldoutRow] = []
    @State private var running = false
    @State private var task: Task<Void, Never>?
    @State private var export: BenchmarkJSONDocument?
    @State private var showingExport = false
    private let documents = HeldoutDocument.all()

    var body: some View {
        List {
            Section {
                Picker("Route", selection: $cloudOnly) {
                    Text("On-device first").tag(false)
                    Text("Cloud test").tag(true)
                }
                .pickerStyle(.segmented)
                .disabled(running)
                Button(running ? "Running…" : "Run all \(documents.count) documents", systemImage: "play.circle.fill", action: start)
                    .disabled(running || documents.isEmpty || !FirebaseSetup.configured)
                if running {
                    ProgressView(value: Double(rows.count), total: Double(max(documents.count, 1))) {
                        Text("Completed \(rows.count) of \(documents.count)")
                    }
                    Button("Cancel run", role: .cancel) { task?.cancel() }
                }
                Text("50 synthetic documents never seen during development, the same files as the Web app's set B. For the on-device route, turn on airplane mode first. The cloud test paces itself under Gemini's free-tier limit of 15 requests per minute.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if !rows.isEmpty {
                Section("Result") {
                    Text(HeldoutRunner.summary(rows)).font(.subheadline.weight(.semibold))
                    let routes = Dictionary(grouping: rows.compactMap(\.route), by: { $0 }).mapValues(\.count)
                    LabeledContent("Routes", value: routes.sorted { $0.key < $1.key }.map { "\($0.value) \($0.key.lowercased())" }.joined(separator: " · "))
                    let times = rows.compactMap(\.milliseconds).sorted()
                    if !times.isEmpty { LabeledContent("Median read", value: "\(times[times.count / 2]) ms") }
                    LabeledContent("Identifiers in requests", value: String(rows.map(\.identifiersInRequest).reduce(0, +)))
                    Button("Save report", systemImage: "square.and.arrow.up") {
                        let report = HeldoutReport(route: cloudOnly ? "cloud test" : "on-device first",
                                                   generatedAt: ISO8601DateFormatter().string(from: .now),
                                                   summary: HeldoutRunner.summary(rows), rows: rows)
                        let encoder = JSONEncoder()
                        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                        if let bytes = try? encoder.encode(report) {
                            export = BenchmarkJSONDocument(bytes: bytes)
                            showingExport = true
                        }
                    }
                    .disabled(running)
                }
                Section("Per document") {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(row.file) · \(row.note)").font(.subheadline.weight(.medium))
                            Text("Expected \(row.expected ?? "hold") · picked \(row.pick ?? "—") · \(row.outcome)")
                                .font(.footnote)
                            if let route = row.route, let ms = row.milliseconds {
                                Text("\(route) · \(ms) ms · \(row.requestBytes) bytes sent").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Held-out set B")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { task?.cancel() }
        .fileExporter(isPresented: $showingExport, document: export, contentType: .json,
                      defaultFilename: "claimguard-ios-heldout-b") { _ in }
    }

    private func start() {
        rows = []
        running = true
        let cloud = cloudOnly
        task = Task { @MainActor in
            var last = Date.distantPast
            for document in documents {
                if Task.isCancelled { break }
                if cloud {
                    let wait = HeldoutRunner.cloudPaceSeconds - Date().timeIntervalSince(last)
                    if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                    last = Date()
                }
                rows.append(await HeldoutRunner.run(document, cloudOnly: cloud))
            }
            running = false
        }
    }
}
