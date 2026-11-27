import SwiftUI
import UIKit

@main
struct ClaimGuardApp: App {
    init() { FirebaseSetup.configure() }

    var body: some Scene {
        WindowGroup { ClaimReviewScreen() }
    }
}

extension Color {
    static var claimPurple: Color {
        Color(uiColor: UIColor { traits in
            if traits.userInterfaceStyle == .dark {
                return UIColor(red: 0.34, green: 0.25, blue: 0.72, alpha: 1)
            }
            return UIColor(red: 0.29, green: 0.20, blue: 0.65, alpha: 1)
        })
    }

    static var privacyGreen: Color {
        Color(uiColor: UIColor { traits in
            if traits.userInterfaceStyle == .dark {
                return UIColor(red: 0.50, green: 0.87, blue: 0.65, alpha: 1)
            }
            return UIColor(red: 0.11, green: 0.36, blue: 0.25, alpha: 1)
        })
    }
}

struct ClaimCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }
}
