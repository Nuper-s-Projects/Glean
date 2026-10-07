import SwiftUI

@main
struct GleanIOSApp: App {
    init() { GleanLiveCalls.shared.endAll() }
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
