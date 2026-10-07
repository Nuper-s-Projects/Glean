import SwiftUI
import UniformTypeIdentifiers

@MainActor final class NativeServerStore: ObservableObject {
    let auth: AuthStore
    let id: Int
    @Published var server: Record = [:]
    @Published var loading = true
    let action = NativeAction()
    init(auth: AuthStore, id: Int) { self.auth = auth; self.id = id }
    var path: String { "api/servers/\(id)" }
    var channels: [Record] { server.records("channels") }
    var roles: [Record] { server.records("roles") }
    var owner: Bool { server.object("membership").text("permissions") == "owner" || auth.account.flag("platformAdmin") }
    func can(_ flag: String) -> Bool { owner || (server.object("membership").text("permissions") == "moderator" && (server.object("membership")["permissionFlags"] as? [String] ?? []).contains(flag)) }
    func load() async {
        defer { loading = false }
        await action.run(success: nil) { server = try await auth.request(path).object("server") }
    }
    func mutate(_ suffix: String = "", body: Record? = nil, method: String = "POST") async {
        await action.run { _ = try await auth.request(path + suffix, body: body, method: method); server = try await auth.request(path).object("server"); auth.revision += 1 }
    }
}

private struct ChannelDestination: Identifiable, Hashable { let id: Int; let name: String }
private struct VoiceChannelDestination: Identifiable, Hashable { let id: Int; let name: String }
struct NativeServerView: View {
    @StateObject private var store: NativeServerStore
    @State private var selected: ChannelDestination?
    @State private var selectedVoice: VoiceChannelDestination?
    @State private var restored = false
    init(auth: AuthStore, serverID: Int) { _store = StateObject(wrappedValue: NativeServerStore(auth: auth, id: serverID)) }
    var body: some View {
        List {
            Section {
                HStack(spacing: 16) {
                    ProfileAvatar(auth: store.auth, path: store.server["iconUrl"] as? String, name: store.server.text("name"), size: 64)
                    VStack(alignment: .leading, spacing: 6) { Text(store.server.text("name")).font(.title2.bold()); Text(store.server.text("description")).foregroundStyle(.secondary).font(.subheadline) }
                }.padding(.vertical, 8)
            }
            Section("Text channels") {
                ForEach(store.channels.filter { !$0.flag("voice") }, id: \.channelID) { channel in
                    Button { select(channel) } label: {
                        HStack {
                            GleanSymbolTile(symbol: channel.text("kind") == "announcement" ? "megaphone" : channel.flag("locked") ? "lock" : "number")
                            VStack(alignment: .leading, spacing: 4) { Text(channel.text("name")).font(.body.weight(.medium)).foregroundStyle(.primary); if !channel.text("topic").isEmpty { Text(channel.text("topic")).font(.caption).foregroundStyle(.secondary) } }
                            Spacer()
                            if channel.number("unreadCount") > 0 { GleanUnreadBadge(count: channel.number("unreadCount")) }
                        }.padding(.vertical, 5)
                    }
                }
            }
            if store.channels.contains(where: { $0.flag("voice") }) {
                Section("Voice channels") {
                    ForEach(store.channels.filter { $0.flag("voice") }, id: \.channelID) { channel in
                        Button { selectedVoice = VoiceChannelDestination(id: channel.number("id"), name: channel.text("name")) } label: {
                            HStack { Label(channel.text("name"), systemImage: "speaker.wave.2"); Spacer(); Text("\(store.server.object("voiceOccupancy").records(String(channel.number("id"))).count)").font(.caption).foregroundStyle(.secondary) }
                        }
                        .foregroundStyle(.primary)
                    }
                }
            }
            Section {
                NavigationLink { ServerMembersView(store: store) } label: { Label("Members · \(store.server.records("members").count)", systemImage: "person.2") }
                NavigationLink { ServerSettingsView(store: store) } label: { Label("Server settings", systemImage: "gearshape") }
                ActionFeedback(action: store.action)
            }
        }
        .navigationTitle(store.server.text("name").isEmpty ? "Server" : store.server.text("name"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .scrollContentBackground(.hidden)
        .listRowSeparator(.hidden)
        .listRowBackground(GleanStyle.panel.opacity(0.72))
        .overlay {
            if store.loading { GleanLoadingState(title: "server") }
            else if store.server.isEmpty && store.action.failed {
                ContentUnavailableView {
                    Label("Couldn’t load server", systemImage: "wifi.exclamationmark")
                } description: { Text(store.action.message ?? "Please try again.") }
                actions: { Button("Try again") { Task { await store.load() } } }
            }
        }
        .refreshable { await store.load() }
        .task(id: store.auth.revision) {
            await store.load()
            if !restored {
                restored = true
                let id = UserDefaults.standard.integer(forKey: lastChannelKey)
                if let channel = store.channels.first(where: { $0.number("id") == id && !$0.flag("voice") }) { selected = ChannelDestination(id: id, name: channel.text("name")) }
            }
        }
        .navigationDestination(item: $selected) { channel in MessageHistoryView(auth: store.auth, path: "api/channels/\(channel.id)/messages", title: channel.name, readOnly: store.server.flag("officialAnnouncements") && store.channels.first(where: { $0.number("id") == channel.id })?.text("kind") == "announcement" && store.server.number("ownerId") != store.auth.account.number("id")) }
        .navigationDestination(item: $selectedVoice) { channel in
            if let record = store.channels.first(where: { $0.number("id") == channel.id }) { NativeVoiceRoomView(auth: store.auth, serverID: store.id, channel: record) }
        }
    }
    private var lastChannelKey: String { "glean.ios.channel.\(store.auth.account.number("id")).\(store.id)" }
    private func select(_ channel: Record) { UserDefaults.standard.set(channel.number("id"), forKey: lastChannelKey); selected = ChannelDestination(id: channel.number("id"), name: channel.text("name")) }
}
extension Dictionary where Key == String, Value == Any { var channelID: Int { number("id") } }

struct ServerSettingsView: View {
    @ObservedObject var store: NativeServerStore
    @Environment(\.dismiss) private var dismiss
    @State private var destructive = false
    var body: some View {
        List {
            Section("Server") {
                if store.owner { NavigationLink { ServerOverviewView(store: store) } label: { GleanNavigationRow(title: "Overview", symbol: "square.grid.2x2", subtitle: "Server profile, discovery, and moderation") } }
                if store.can("manageChannels") || store.can("manageMessages") { NavigationLink { ServerChannelsSettingsView(store: store) } label: { GleanNavigationRow(title: "Channels", symbol: "number") } }
                if store.can("manageRoles") { NavigationLink { ServerRolesView(store: store) } label: { GleanNavigationRow(title: "Roles", symbol: "person.badge.shield.checkmark") } }
                NavigationLink { ServerMembersView(store: store) } label: { GleanNavigationRow(title: "Members", symbol: "person.2") }
                if store.can("manageInvites") { NavigationLink { ServerRecordsView(store: store, category: "invites") } label: { GleanNavigationRow(title: "Invites", symbol: "link") } }
                if store.can("manageMembers") { NavigationLink { ServerRecordsView(store: store, category: "bans") } label: { GleanNavigationRow(title: "Bans", symbol: "hand.raised") } }
                if store.can("viewAuditLog") { NavigationLink { ServerRecordsView(store: store, category: "audit-log") } label: { GleanNavigationRow(title: "Audit log", symbol: "clock.arrow.circlepath") } }
            }
            Section {
                ActionFeedback(action: store.action)
                if !store.server.flag("officialAnnouncements") {
                    Button(store.owner ? "Delete server" : "Leave server", role: .destructive) { destructive = true }
                }
            }
        }.navigationTitle("Server settings")
        .alert(store.owner ? "Delete server permanently?" : "Leave this server?", isPresented: $destructive) {
            Button(store.owner ? "Delete" : "Leave", role: .destructive) { Task {
                await store.action.run { _ = try await store.auth.request(store.path + (store.owner ? "" : "/leave"), body: store.owner ? nil : [:], method: store.owner ? "DELETE" : "POST"); store.auth.revision += 1; dismiss() }
            } }
            Button("Cancel", role: .cancel) { }
        } message: { Text(store.owner ? "All channels and messages in this server will be deleted. This cannot be undone." : "You will need an invite to rejoin a private server.") }
    }
}

struct ServerOverviewView: View {
    @ObservedObject var store: NativeServerStore
    @State private var name = ""
    @State private var description = ""
    @State private var publicServer = false
    @State private var moderation = false
    @State private var importer = false
    @State private var field = "icon"
    var body: some View {
        Form {
            Section("Server profile") {
                ProfileAvatar(auth: store.auth, path: store.server["iconUrl"] as? String, name: name, size: 72)
                Button("Change server icon") { field = "icon"; importer = true }
                Button("Change server banner") { field = "banner"; importer = true }
                TextField("Server name", text: $name)
                TextField("Description", text: $description, axis: .vertical).lineLimit(3...6)
            }
            Section("Discovery") { Toggle("Public server", isOn: $publicServer); Text("Public servers appear in Discover.").font(.caption).foregroundStyle(.secondary) }
            Section("Moderation") { Toggle("Automatic moderation", isOn: $moderation); Text("Those pesky users saying profanity? Turn this on to have automatic moderation. Note, I spend WAYYYY to much time training the model, if any reports come in, tell me PERSONALLY (if you know me) so I can train the model more!").font(.caption).foregroundStyle(.secondary) }
            Section { ActionFeedback(action: store.action); Button("Save server") { Task { await store.mutate(body: ["name": name, "description": description, "isPublic": publicServer, "moderationEnabled": moderation], method: "PATCH") } }.buttonStyle(GleanPrimaryButtonStyle()).disabled(store.action.busy) }
        }.navigationTitle("Overview")
        .task { name = store.server.text("name"); description = store.server.text("description"); publicServer = store.server.flag("isPublic"); moderation = store.server.flag("moderationEnabled") }
        .fileImporter(isPresented: $importer, allowedContentTypes: [.image]) { result in Task { await store.action.run { try await store.auth.send(store.path + "/\(field)", text: "", files: [try result.get()], reply: nil, fileField: field); store.server = try await store.auth.request(store.path).object("server") } } }
    }
}

struct ServerChannelsSettingsView: View {
    @ObservedObject var store: NativeServerStore
    @State private var createChannel = false
    var body: some View {
        List {
            Section("Channels") {
                ForEach(store.channels, id: \.channelID) { channel in NavigationLink(channel.text("name")) { ChannelSettingsView(store: store, channel: channel) } }
                .onMove { from, to in
                    var channels = store.channels; channels.move(fromOffsets: from, toOffset: to)
                    Task { await store.mutate("/channels/order", body: ["channelIds": channels.map { $0.number("id") }], method: "PATCH") }
                }.moveDisabled(!store.can("manageChannels"))
            }
            ActionFeedback(action: store.action)
        }
        .navigationTitle("Channels")
        .toolbar {
            if store.can("manageChannels") {
                ToolbarItemGroup {
                    EditButton()
                    Button { createChannel = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Create channel")
                }
            }
        }
        .sheet(isPresented: $createChannel) {
            NavigationStack { NativeCreateChannelView(store: store) }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }
}

private struct NativeChannelType: Identifiable {
    let id: String
    let title: String
    let description: String
    let icon: String

    static let options = [
        NativeChannelType(id: "text", title: "Text", description: "Send messages, images, GIFs, emoji, and polls.", icon: "number"),
        NativeChannelType(id: "voice", title: "Voice", description: "Hang out together with voice, video, and screen share.", icon: "waveform"),
        NativeChannelType(id: "announcement", title: "Announcement", description: "Share important updates with the server.", icon: "megaphone.fill"),
        NativeChannelType(id: "rules", title: "Rules", description: "Create a read-only space for server rules.", icon: "book.closed.fill")
    ]
}

private struct NativeCreateChannelView: View {
    @ObservedObject var store: NativeServerStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var type = "text"

    var body: some View {
        Form {
            Section("Channel type") {
                ForEach(NativeChannelType.options) { option in
                    Button { type = option.id } label: {
                        HStack(spacing: 12) {
                            Image(systemName: type == option.id ? "largecircle.fill.circle" : "circle")
                                .foregroundStyle(type == option.id ? GleanStyle.blue : Color.secondary)
                                .font(.title3)
                            Image(systemName: option.icon)
                                .frame(width: 22)
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(option.title).font(.body.weight(.semibold)).foregroundStyle(.primary)
                                Text(option.description).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(type == option.id ? .isSelected : [])
                }
            }
            Section("Channel name") {
                TextField("new-channel", text: $name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("create-channel-name")
                    .onChange(of: name) { _, value in
                        if value.count > 32 { name = String(value.prefix(32)) }
                    }
            }
            ActionFeedback(action: store.action)
        }
        .navigationTitle("Create Channel")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") { Task { await create() } }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.action.busy)
            }
        }
    }

    private func create() async {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty, cleanName.count <= 32, !store.action.busy else { return }
        await store.mutate("/channels", body: ["name": cleanName, "type": type])
        if !store.action.failed { dismiss() }
    }
}

struct ChannelSettingsView: View {
    @ObservedObject var store: NativeServerStore
    let channel: Record
    @State private var name = ""
    @State private var topic = ""
    @State private var kind = "text"
    @State private var locked = false
    @State private var slowmode = 0
    @State private var cleanup = 0
    @State private var danger = ""
    @State private var confirm = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        Form {
            Section("Channel") {
                TextField("Name", text: $name)
                if !channel.flag("voice") {
                    TextField("Topic", text: $topic)
                    Picker("Type", selection: $kind) { Text("Text").tag("text"); Text("Announcements").tag("announcement"); Text("Rules").tag("rules") }
                    Toggle("Moderators only", isOn: $locked)
                    Picker("Slowmode", selection: $slowmode) { Text("Off").tag(0); ForEach([5,10,15,30,60,120,300,600,900,1800,3600], id: \.self) { Text("\($0) seconds").tag($0) } }
                }
                Button("Save channel") { Task { await store.mutate("/channels/\(channel.number("id"))", body: ["name": name, "topic": topic, "channelKind": kind, "locked": locked, "slowmode": slowmode], method: "PATCH") } }
            }.disabled(!store.can("manageChannels"))
            if !channel.flag("voice"), store.can("manageMessages") {
                Section("Message cleanup") {
                    Picker("Automatically delete messages", selection: $cleanup) { Text("Off").tag(0); Text("Every 30 minutes").tag(1800); Text("Every hour").tag(3600); Text("Every 6 hours").tag(21600); Text("Every 12 hours").tag(43200); Text("Every day").tag(86400); Text("Every week").tag(604800) }
                    Button("Save cleanup schedule") { danger = "message-cleanup"; confirm = true }
                    Button("Delete every message", role: .destructive) { danger = "clear-messages"; confirm = true }
                }
            }
            ActionFeedback(action: store.action)
            if store.can("manageChannels") { Button("Delete channel", role: .destructive) { danger = "delete"; confirm = true } }
        }.navigationTitle("Channel settings")
        .task { name = channel.text("name"); topic = channel.text("topic"); kind = ["announcement", "rules"].contains(channel.text("kind")) ? channel.text("kind") : "text"; locked = channel.flag("locked"); slowmode = channel.number("slowmode"); cleanup = channel.number("messageCleanupIntervalSeconds") }
        .alert("Confirm change", isPresented: $confirm) {
            Button("Confirm", role: .destructive) { Task {
                let prefix = "/channels/\(channel.number("id"))"
                await store.mutate(prefix + (danger == "delete" ? "" : "/\(danger)"), body: danger == "message-cleanup" ? ["intervalSeconds": cleanup] : [:], method: danger == "delete" ? "DELETE" : "POST")
                if danger == "delete" && !store.action.failed { dismiss() }
            } }
            Button("Cancel", role: .cancel) { }
        } message: { Text(danger == "message-cleanup" && cleanup == 0 ? "Disable automatic deletion?" : "This action permanently deletes messages and attachments. It cannot be undone.") }
    }
}

let nativeRoleFlags = ["manageChannels", "manageMessages", "manageMembers", "manageInvites", "postStaff", "manageApps", "manageVoice", "manageRoles", "manageServer", "viewAuditLog"]
struct ServerRolesView: View {
    @ObservedObject var store: NativeServerStore
    var body: some View {
        List {
            NavigationLink("Create role") { RoleSettingsView(store: store, role: [:]) }
            ForEach(store.roles, id: \.channelID) { role in
                if role.text("name") == "Member" { Text("Member · Default role") }
                else { NavigationLink { RoleSettingsView(store: store, role: role) } label: { HStack { Circle().fill(Color(hex: role.text("color"))).frame(width: 12, height: 12); Text(role.text("name")); Spacer(); Text(role.text("permissions")).font(.caption).foregroundStyle(.secondary) } } }
            }
            Section("Reorder custom roles") {
                ForEach(custom, id: \.channelID) { Text($0.text("name")) }
                    .onMove { from, to in var roles = custom; roles.move(fromOffsets: from, toOffset: to); Task { await store.mutate("/roles/order", body: ["roleIds": roles.map { $0.number("id") }], method: "PATCH") } }
            }
            ActionFeedback(action: store.action)
        }.navigationTitle("Roles").toolbar { EditButton() }
    }
    private var custom: [Record] { store.roles.filter { $0.text("permissions") != "owner" && $0.text("name") != "Member" } }
}
struct RoleSettingsView: View {
    @ObservedObject var store: NativeServerStore
    let role: Record
    @State private var name = ""
    @State private var color = Color.blue
    @State private var permissions = "member"
    @State private var flags: Set<String> = []
    @State private var delete = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        Form {
            TextField("Role name", text: $name)
            if role.text("permissions") != "owner" {
                ColorPicker("Color", selection: $color)
                Picker("Permissions", selection: $permissions) { Text("Member").tag("member"); Text("Moderator").tag("moderator") }
                if permissions == "moderator" { Section("Moderator permissions") { ForEach(nativeRoleFlags, id: \.self) { flag in Toggle(flag, isOn: Binding(get: { flags.contains(flag) }, set: { if $0 { flags.insert(flag) } else { flags.remove(flag) } })) } } }
            }
            ActionFeedback(action: store.action)
            Button("Save role") { Task {
                var values: Record = ["name": name]
                if role.text("permissions") != "owner" { values["color"] = color.hex; values["permissions"] = permissions; values["permissionFlags"] = Array(flags) }
                await store.mutate(role.isEmpty ? "/roles" : "/roles/\(role.number("id"))", body: values, method: role.isEmpty ? "POST" : "PATCH")
                if !store.action.failed { dismiss() }
            } }.disabled(name.isEmpty || store.action.busy)
            if !role.isEmpty && role.text("permissions") != "owner" && role.text("name") != "Member" { Button("Delete role", role: .destructive) { delete = true } }
        }.navigationTitle(role.isEmpty ? "Create role" : "Edit role")
        .task { name = role.text("name"); color = Color(hex: role.text("color")); permissions = role.text("permissions").isEmpty ? "member" : role.text("permissions"); flags = Set(role["permissionFlags"] as? [String] ?? []) }
        .alert("Delete role?", isPresented: $delete) { Button("Delete", role: .destructive) { Task { await store.mutate("/roles/\(role.number("id"))", method: "DELETE"); if !store.action.failed { dismiss() } } }; Button("Cancel", role: .cancel) {} }
    }
}

struct ServerMembersView: View {
    @ObservedObject var store: NativeServerStore
    var body: some View {
        List {
            ForEach(store.roles, id: \.channelID) { role in
                Section(role.text("name")) {
                    ForEach(store.server.records("members").filter { $0.number("roleId") == role.number("id") }, id: \.channelID) { member in
                        HStack(spacing: 12) {
                            ProfileAvatarLink(auth: store.auth, path: member["avatarUrl"] as? String, username: member.text("username"))
                            NavigationLink { ServerMemberView(store: store, member: member) } label: {
                                VStack(alignment: .leading) { Text(member.text("username")); Text(member.text("presence")).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
            }
            ActionFeedback(action: store.action)
        }.navigationTitle("Members")
    }
}
struct ServerMemberView: View {
    @ObservedObject var store: NativeServerStore
    let member: Record
    @State private var roleID = 0
    @State private var reason = ""
    @State private var seconds = 600
    @State private var pending = ""
    @State private var confirm = false
    var body: some View {
        Form {
            NavigationLink("View profile") { NativeProfileView(auth: store.auth, username: member.text("username")) }
            if store.can("manageMembers"), member.text("permissions") != "owner", (store.owner || member.text("permissions") != "moderator"), member.number("id") != store.auth.account.number("id") {
                Section("Role") {
                    Picker("Role", selection: $roleID) { ForEach(store.roles.filter { $0.text("permissions") != "owner" && (store.owner || $0.text("permissions") != "moderator") }, id: \.channelID) { Text($0.text("name")).tag($0.number("id")) } }
                    Button("Assign role") { Task { await store.mutate("/members/\(member.number("id"))/role", body: ["roleId": roleID]) } }
                }
                Section("Moderation") {
                    TextField("Reason (optional)", text: $reason)
                    Picker("Timeout", selection: $seconds) { Text("Remove timeout").tag(0); Text("1 minute").tag(60); Text("5 minutes").tag(300); Text("10 minutes").tag(600); Text("1 hour").tag(3600); Text("1 day").tag(86400); Text("1 week").tag(604800) }
                    Button("Apply timeout") { pending = "timeout"; confirm = true }
                    Button("Kick", role: .destructive) { pending = "kick"; confirm = true }
                    Button("Ban", role: .destructive) { pending = "ban"; confirm = true }
                }
            }
            if store.can("manageVoice"), member.text("permissions") != "owner", member.number("id") != store.auth.account.number("id") { Button("Disconnect") { pending = "disconnect"; confirm = true } }
            ActionFeedback(action: store.action)
        }.navigationTitle(member.text("username")).task { roleID = member.number("roleId") }
        .alert("\(pending.capitalized) \(member.text("username"))?", isPresented: $confirm) {
            Button("Confirm", role: .destructive) { Task { await store.mutate("/\(pending == "disconnect" ? "voice-members" : "members")/\(member.number("id"))/\(pending)", body: ["reason": reason, "seconds": seconds]) } }
            Button("Cancel", role: .cancel) { }
        }
    }
}

struct ServerRecordsView: View {
    @ObservedObject var store: NativeServerStore
    let category: String
    @State private var records: [Record] = []
    @State private var cursor: String?
    @State private var invite: String?
    @State private var pending: Record?
    @State private var confirm = false
    @StateObject private var action = NativeAction()
    var body: some View {
        List {
            if category == "invites" {
                Button("Create invite (7 days)") { Task { await action.run { let result = try await store.auth.request(store.path + "/invites", body: ["expiresInHours": 168, "maxUses": 0]); invite = result.object("invite").text("code") }; if !action.failed { await load() } } }
                if let invite, !invite.isEmpty { ShareLink(item: URL(string: "https://d3bdx5il6w3di0.cloudfront.net/invite/\(invite)")!) { Label("Share invite", systemImage: "square.and.arrow.up") } }
            }
            ForEach(Array(records.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 6) {
                    Text(category == "invites" ? row.text("code") : category == "bans" ? row.text("username") : row.text("action")).font(.headline)
                    Text(category == "audit-log" ? "\(row.text("actorName")) · \(row.text("targetName"))" : row.text("reason")).font(.subheadline)
                    Text(row.text("createdAt")).font(.caption).foregroundStyle(.secondary)
                    if category == "invites" { ShareLink(item: URL(string: "https://d3bdx5il6w3di0.cloudfront.net/invite/\(row.text("code"))")!) { Text("Share") } }
                    if category != "audit-log" { Button(category == "bans" ? "Unban" : "Revoke", role: .destructive) { pending = row; confirm = true } }
                }
            }
            if cursor != nil { Button("Load older entries") { Task { await load(older: true) } } }
            ActionFeedback(action: action)
        }.navigationTitle(category == "audit-log" ? "Audit log" : category.capitalized)
        .task { await load() }.refreshable { await load() }
        .alert(category == "bans" ? "Unban user?" : "Revoke invite?", isPresented: $confirm) {
            Button("Confirm", role: .destructive) { Task { await action.run {
                guard let pending else { return }
                let identifier = category == "bans" ? String(pending.number("userId")) : pending.text("code")
                _ = try await store.auth.request(store.path + "/\(category)/\(identifier)", method: "DELETE")
            }; if !action.failed { await load() } } }
            Button("Cancel", role: .cancel) { }
        }
    }
    private func load(older: Bool = false) async {
        await action.run(success: nil) {
            let result = try await store.auth.request(store.path + "/\(category)" + (older ? "?before=\(cursor ?? "")" : ""))
            let next = result.records(category == "audit-log" ? "entries" : category)
            if older { records += next } else { records = next }
            cursor = result["nextCursor"] as? String
        }
    }
}
