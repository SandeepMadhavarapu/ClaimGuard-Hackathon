import SwiftUI
import VisionKit

struct DocumentCamera: UIViewControllerRepresentable {
    let onResult: (Result<[Data], Error>?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onResult: (Result<[Data], Error>?) -> Void

        init(onResult: @escaping (Result<[Data], Error>?) -> Void) { self.onResult = onResult }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            onResult(nil)
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFailWithError error: Error) {
            onResult(.failure(error))
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                          didFinishWith scan: VNDocumentCameraScan) {
            var pages: [Data] = []
            for index in 0..<scan.pageCount {
                let image = scan.imageOfPage(at: index)
                // Make the review preview and Vision use the same upright pixel orientation.
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                format.opaque = true
                let rendered = UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
                    image.draw(in: CGRect(origin: .zero, size: image.size))
                }
                guard let data = rendered.jpegData(compressionQuality: 0.95) else {
                    onResult(.failure(CocoaError(.fileWriteInapplicableStringEncoding)))
                    return
                }
                pages.append(data)
            }
            onResult(.success(pages))
        }
    }
}
