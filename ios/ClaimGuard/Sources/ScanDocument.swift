import Foundation
import UIKit

struct ScanSample: Identifiable, Sendable {
    let id: String
    let title: String
    let expected: String?

    func data() throws -> Data {
        guard let url = Bundle.main.url(forResource: id, withExtension: "png", subdirectory: "samples") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }

    static let all = [
        Self(id: "referral", title: "Specialist referral", expected: "DEMO-PA-240817"),
        Self(id: "pending", title: "Request pending", expected: nil),
        Self(id: "cover-sheet", title: "Busy cover sheet", expected: "DEMO-PA-928331"),
        Self(id: "conflicting", title: "Conflicting references", expected: nil),
        Self(id: "faint-print", title: "Faint print", expected: "PA-002650"),
        Self(id: "rotated-letter", title: "Rotated referral", expected: "DEMO-PA-480032"),
        Self(id: "lookalike-digits", title: "Look-alike O and 0", expected: "DEM0-PA-001518"),
        Self(id: "leading-zero", title: "Low resolution and leading zeros", expected: "PA-000741"),
        Self(id: "placeholder", title: "Placeholder with tracking ID", expected: nil),
        Self(id: "blank-field", title: "Blank payer field", expected: nil),
        Self(id: "two-copies", title: "Combined pages with conflicting references", expected: nil),
        Self(id: "facility-only", title: "Facility identifiers only", expected: nil),
    ]
}

struct ScanDocument: Identifiable {
    let id = UUID()
    let title: String
    let pages: [Data]
    let images: [UIImage]

    init(title: String, pages: [Data]) throws {
        let images = pages.compactMap { UIImage(data: $0) }
        guard !pages.isEmpty, images.count == pages.count else { throw CocoaError(.fileReadCorruptFile) }
        self.title = title
        self.pages = pages
        self.images = images
    }
}
