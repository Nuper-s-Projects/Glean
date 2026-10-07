import Foundation
#if os(iOS)
import ActivityKit
#endif

struct GleanWidgetSnapshot: Codable, Equatable {
    var username: String?
    var unreadMessages: Int?
    var unreadChats: Int?
    var servers: Int?
    var updatedAt: Date
    static let empty = Self(updatedAt: .distantPast)
    mutating func updateUnreadCounts(_ counts: [Int]) {
        let safe = counts.map { max(0, $0) }
        unreadMessages = safe.reduce(0, +)
        unreadChats = safe.filter { $0 > 0 }.count
    }
}

enum GleanWidgetData {
    static let group = "group.com.glean.ios"
    static let key = "glean.widget.snapshot.v1"
    static func read(defaults: UserDefaults? = UserDefaults(suiteName: group)) -> GleanWidgetSnapshot {
        guard let data = defaults?.data(forKey: key),
              let value = try? JSONDecoder().decode(GleanWidgetSnapshot.self, from: data) else { return .empty }
        return value
    }
}

#if os(iOS)
struct GleanCallAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var status: String
        var startedAt: Date?
        var muted: Bool
        var participants: Int?
    }
    var kind: String
}
#endif

enum GleanWidgetRoute: String {
    case messages, servers, settings, call
    static func parse(_ url: URL) -> Self? {
        guard url.scheme == "glean", url.path.isEmpty || url.path == "/", url.query == nil,
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil else { return nil }
        return url.host.flatMap(Self.init(rawValue:))
    }
    var url: URL { URL(string: "glean://\(rawValue)")! }
}
