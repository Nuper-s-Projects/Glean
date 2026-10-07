import Foundation
import WidgetKit
import ActivityKit
import OSLog

@MainActor enum GleanWidgetStore {
    static func account(_ username: String?) {
        var value = GleanWidgetData.read()
        guard value.username != username else { return }
        value = GleanWidgetSnapshot(username: username, updatedAt: Date())
        save(value)
    }
    static func ingest(path: String, payload: [String: Any], username: String) {
        var value = GleanWidgetData.read()
        if value.username != username { value = GleanWidgetSnapshot(username: username, updatedAt: Date()) }
        if path == "api/conversations", let rows = payload["conversations"] as? [[String: Any]] {
            let counts = rows.map { max(0, ($0["unreadCount"] as? NSNumber)?.intValue ?? 0) }
            value.updateUnreadCounts(counts)
        } else if path == "api/servers", let rows = payload["servers"] as? [[String: Any]] {
            value.servers = rows.count
        } else { return }
        let previous = GleanWidgetData.read()
        guard previous.username != value.username || previous.unreadMessages != value.unreadMessages || previous.unreadChats != value.unreadChats || previous.servers != value.servers || Date().timeIntervalSince(previous.updatedAt) > 300 else { return }
        value.updatedAt = Date()
        save(value)
    }
    private static func save(_ value: GleanWidgetSnapshot) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        UserDefaults(suiteName: GleanWidgetData.group)?.set(data, forKey: GleanWidgetData.key)
        WidgetCenter.shared.reloadTimelines(ofKind: "GleanInbox")
    }
}

/// Serializes changes so fast connect/disconnect events cannot leave orphaned activities.
@MainActor final class GleanLiveCalls {
    static let shared = GleanLiveCalls()
    private var desired: [String: GleanCallAttributes.ContentState] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    private let logger = Logger(subsystem: "com.glean.ios", category: "LiveActivities")

    func update(kind: String, state: GleanCallAttributes.ContentState?) {
        if let state { desired[kind] = state } else { desired[kind] = nil }
        guard tasks[kind] == nil else { return }
        tasks[kind] = Task { await reconcile(kind: kind) }
    }
    func endAll() {
        let kinds = Set(desired.keys).union(Activity<GleanCallAttributes>.activities.map { $0.attributes.kind })
        for kind in kinds { update(kind: kind, state: nil) }
    }
    func refresh() {
        for (kind, state) in desired { update(kind: kind, state: state) }
    }
    private func reconcile(kind: String) async {
        defer { tasks[kind] = nil }
        while true {
            let target = desired[kind]
            let activities = Activity<GleanCallAttributes>.activities.filter { $0.attributes.kind == kind }
            if let target {
                let content = ActivityContent(state: target, staleDate: Date().addingTimeInterval(8 * 3600))
                if let activity = activities.first {
                    await activity.update(content)
                    for duplicate in activities.dropFirst() { await duplicate.end(nil, dismissalPolicy: .immediate) }
                } else if ActivityAuthorizationInfo().areActivitiesEnabled {
                    do { _ = try Activity.request(attributes: GleanCallAttributes(kind: kind), content: content, pushType: nil) }
                    catch { logger.error("Could not start call activity: \(error.localizedDescription, privacy: .public)") }
                }
            } else {
                for activity in activities { await activity.end(nil, dismissalPolicy: .immediate) }
            }
            if target == desired[kind] { return }
        }
    }
}
