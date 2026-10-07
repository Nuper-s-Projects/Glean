import Foundation

@main struct WidgetChecks {
    static func main() throws {
        let suite = "glean-widget-check-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        precondition(GleanWidgetData.read(defaults: defaults) == .empty)
        var snapshot = GleanWidgetSnapshot(username: "Alice", servers: 4, updatedAt: Date())
        snapshot.updateUnreadCounts([3, 0, -5, 2])
        precondition(snapshot.unreadMessages == 5 && snapshot.unreadChats == 2)
        let encoded = try JSONEncoder().encode(snapshot)
        defaults.set(encoded, forKey: GleanWidgetData.key)
        precondition(GleanWidgetData.read(defaults: defaults) == snapshot)
        let stored = String(decoding: encoded, as: UTF8.self)
        precondition(!stored.contains("accessToken") && !stored.contains("body") && !stored.contains("publicKey"))
        snapshot.updateUnreadCounts([])
        precondition(snapshot.unreadChats == 0 && snapshot.unreadMessages == 0)
        defaults.set(try JSONEncoder().encode(GleanWidgetSnapshot.empty), forKey: GleanWidgetData.key)
        precondition(GleanWidgetData.read(defaults: defaults).username == nil)
        defaults.set(Data("broken".utf8), forKey: GleanWidgetData.key)
        precondition(GleanWidgetData.read(defaults: defaults) == .empty)
        for route in [GleanWidgetRoute.messages, .servers, .settings, .call] {
            precondition(GleanWidgetRoute.parse(route.url) == route)
        }
        for invalid in ["https://messages", "glean://admin", "glean://messages/unknown", "glean://user@messages", "glean://messages?token=x", "glean://messages#foo"] {
            precondition(GleanWidgetRoute.parse(URL(string: invalid)!) == nil)
        }
        print("PASS: widget counts, disk snapshot, privacy fields, empty/sign-out states, corrupt data, shortcut routes")
    }
}
