import SwiftUI
import WidgetKit
import ActivityKit

struct InboxEntry: TimelineEntry {
    let date: Date
    let snapshot: GleanWidgetSnapshot
}

struct InboxProvider: TimelineProvider {
    func placeholder(in context: Context) -> InboxEntry {
        InboxEntry(date: Date(), snapshot: .init(username: "Glean", unreadMessages: 3, unreadChats: 2, servers: 4, updatedAt: Date()))
    }
    func getSnapshot(in context: Context, completion: @escaping (InboxEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : InboxEntry(date: Date(), snapshot: GleanWidgetData.read()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<InboxEntry>) -> Void) {
        completion(Timeline(entries: [InboxEntry(date: Date(), snapshot: GleanWidgetData.read())], policy: .after(Date().addingTimeInterval(900))))
    }
}

private let gleanBlue = Color(red: 0, green: 0.65, blue: 1)

struct InboxWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: InboxEntry
    var body: some View {
        Group {
            if family == .accessoryCircular {
                VStack(spacing: 2) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                    Text(entry.snapshot.unreadMessages.map(String.init) ?? "–").font(.headline)
                }.privacySensitive()
            } else if family == .accessoryRectangular {
                VStack(alignment: .leading) {
                    Label("Glean", systemImage: "bubble.left.and.bubble.right.fill").font(.headline)
                    Text(summary).privacySensitive()
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: "bubble.left.and.bubble.right.fill").foregroundStyle(gleanBlue)
                        Text("Glean").font(.headline)
                        Spacer()
                    }
                    if entry.snapshot.username == nil {
                        Text("Open Glean to sign in").font(.subheadline)
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(entry.snapshot.unreadMessages.map(String.init) ?? "–").font(.system(size: 34, weight: .bold, design: .rounded))
                            Text("unread").font(.subheadline).foregroundStyle(.secondary)
                        }.privacySensitive()
                        Text(summary).font(.caption).foregroundStyle(.secondary).privacySensitive()
                        if family == .systemMedium {
                            HStack(spacing: 16) {
                                Link(destination: GleanWidgetRoute.messages.url) { Label("Messages", systemImage: "bubble.left.fill") }
                                Link(destination: GleanWidgetRoute.servers.url) { Label("Servers", systemImage: "person.3.fill") }
                            }.font(.caption.bold()).foregroundStyle(gleanBlue)
                        }
                        if entry.snapshot.updatedAt != .distantPast {
                            Text("Updated \(entry.snapshot.updatedAt, style: .time)").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .containerBackground(for: .widget) { Color(uiColor: .secondarySystemGroupedBackground) }
        .widgetURL(GleanWidgetRoute.messages.url)
    }
    private var summary: String {
        guard entry.snapshot.username != nil else { return "Open Glean to sign in" }
        guard let chats = entry.snapshot.unreadChats else { return "Open Glean to update" }
        return chats == 0 ? "You’re all caught up" : "\(chats) unread \(chats == 1 ? "chat" : "chats")"
    }
}

struct GleanInboxWidget: Widget {
    let kind = "GleanInbox"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: InboxProvider()) { InboxWidgetView(entry: $0) }
            .configurationDisplayName("Glean Inbox")
            .description("See your last synced unread counts and open your messages. Private message text is never shown.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

struct GleanShortcutsWidget: Widget {
    let kind = "GleanShortcuts"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: InboxProvider()) { _ in
            VStack(alignment: .leading, spacing: 12) {
                Text("Glean").font(.headline)
                HStack(spacing: 12) {
                    shortcut("Messages", symbol: "bubble.left.and.bubble.right.fill", route: .messages)
                    shortcut("Servers", symbol: "person.3.fill", route: .servers)
                    shortcut("Settings", symbol: "gearshape.fill", route: .settings)
                }
            }.containerBackground(for: .widget) { Color(uiColor: .secondarySystemGroupedBackground) }
        }
        .configurationDisplayName("Glean Shortcuts")
        .description("Jump straight into messages, servers, or settings.")
        .supportedFamilies([.systemMedium])
    }
    private func shortcut(_ title: String, symbol: String, route: GleanWidgetRoute) -> some View {
        Link(destination: route.url) {
            VStack(spacing: 8) {
                Image(systemName: symbol).font(.title2).foregroundStyle(gleanBlue)
                Text(title).font(.caption.bold())
            }.frame(maxWidth: .infinity, minHeight: 66).background(gleanBlue.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
        }.accessibilityLabel("Open Glean \(title)")
    }
}

struct GleanCallActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: GleanCallAttributes.self) { context in
            HStack(spacing: 12) {
                Image(systemName: context.attributes.kind == "dm" ? "phone.fill" : "waveform").font(.title2).foregroundStyle(gleanBlue)
                VStack(alignment: .leading, spacing: 4) {
                    Text(context.state.title).font(.headline).lineLimit(1).privacySensitive()
                    Text(context.state.status).font(.caption).foregroundStyle(.secondary)
                    if let count = context.state.participants { Text("\(count) in voice").font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    timer(context.state)
                    Image(systemName: context.state.muted ? "mic.slash.fill" : "mic.fill").foregroundStyle(context.state.muted ? .orange : gleanBlue)
                        .accessibilityLabel(context.state.muted ? "Microphone muted" : "Microphone on")
                }
            }
            .padding(16)
            .activityBackgroundTint(Color(uiColor: .secondarySystemGroupedBackground))
            .activitySystemActionForegroundColor(gleanBlue)
            .widgetURL(GleanWidgetRoute.call.url)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text("GLEAN")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .tracking(1.5)
                        .foregroundStyle(.white.opacity(0.55))
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.startedAt != nil {
                        timer(context.state)
                            .foregroundStyle(gleanBlue)
                            .frame(width: 76, alignment: .trailing)
                    } else {
                        Text(connectionLabel(context.state))
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(gleanBlue)
                            .padding(.horizontal, 9).padding(.vertical, 4)
                            .background(gleanBlue.opacity(0.15), in: Capsule())
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 12) {
                        Image(systemName: context.attributes.kind == "dm" ? "phone.fill" : "waveform")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(gleanBlue)
                            .frame(width: 44, height: 44)
                            .background(gleanBlue.opacity(0.14), in: RoundedRectangle(cornerRadius: 14))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(context.state.title)
                                .font(.system(size: 19, weight: .semibold))
                                .foregroundStyle(.white)
                                .lineLimit(1).minimumScaleFactor(0.8)
                                .privacySensitive()
                            HStack(spacing: 5) {
                                Circle().fill(context.state.startedAt == nil ? gleanBlue : Color.green)
                                    .frame(width: 5, height: 5).accessibilityHidden(true)
                                Text(context.state.status)
                                if let count = context.state.participants {
                                    Text("· \(count) in voice")
                                }
                            }
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.white.opacity(0.65))
                            .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if context.state.muted {
                            Image(systemName: "mic.slash.fill")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.orange)
                                .frame(width: 32, height: 32)
                                .background(Color.orange.opacity(0.14), in: Circle())
                                .accessibilityLabel("Microphone muted")
                        }
                    }
                    .padding(.top, 8).padding(.bottom, 4).padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: context.state.muted ? "mic.slash.fill" : context.attributes.kind == "dm" ? "phone.fill" : "waveform")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(context.state.muted ? .orange : gleanBlue)
                    .accessibilityLabel(context.state.muted ? "Glean call, microphone muted" : "Glean call")
            } compactTrailing: {
                if context.state.startedAt != nil {
                    timer(context.state).foregroundStyle(gleanBlue).frame(width: 52)
                } else {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(gleanBlue)
                        .accessibilityLabel(context.state.status)
                }
            } minimal: {
                Image(systemName: context.state.muted ? "mic.slash.fill" : context.attributes.kind == "dm" ? "phone.fill" : "waveform")
                    .foregroundStyle(context.state.muted ? .orange : gleanBlue)
                    .accessibilityLabel("Glean: \(context.state.status)")
            }
            .widgetURL(GleanWidgetRoute.call.url)
            .keylineTint(gleanBlue.opacity(0.3))
        }
    }
    private func connectionLabel(_ state: GleanCallAttributes.ContentState) -> String {
        switch state.status {
        case "Incoming call": return "Incoming"
        case "Calling…": return "Dialing"
        default: return "Connecting"
        }
    }
    @ViewBuilder private func timer(_ state: GleanCallAttributes.ContentState) -> some View {
        if let started = state.startedAt {
            Text(timerInterval: started...Date.distantFuture, countsDown: false).monospacedDigit().font(.caption.bold())
        } else { Image(systemName: "phone.connection.fill").foregroundStyle(gleanBlue) }
    }
}

@main struct GleanWidgets: WidgetBundle {
    var body: some Widget {
        GleanInboxWidget()
        GleanShortcutsWidget()
        GleanCallActivity()
    }
}
