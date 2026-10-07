import SwiftUI
import UniformTypeIdentifiers

typealias Record = [String: Any]
extension Dictionary where Key == String, Value == Any {
    func text(_ key: String) -> String { self[key] as? String ?? "" }
    func number(_ key: String) -> Int { self[key] as? Int ?? 0 }
    func flag(_ key: String) -> Bool { self[key] as? Bool ?? false }
    func object(_ key: String) -> Record { self[key] as? Record ?? [:] }
    func records(_ key: String) -> [Record] { self[key] as? [Record] ?? [] }
}

@MainActor final class NativeAction: ObservableObject {
    @Published var busy = false
    @Published var message: String?
    @Published var failed = false
    func run(success: String? = "Saved.", _ operation: () async throws -> Void) async {
        guard !busy else { return }
        busy = true; message = nil
        defer { busy = false }
        do { try await operation(); failed = false; message = success }
        catch { failed = true; message = error.localizedDescription }
    }
}

struct ActionFeedback: View {
    @ObservedObject var action: NativeAction
    var body: some View {
        if action.busy { ProgressView().frame(maxWidth: .infinity).padding(.vertical, 6) }
        if let message = action.message { GleanFeedback(message: message, failed: action.failed) }
    }
}

struct AccountSettingsView: View {
    @ObservedObject var auth: AuthStore
    var body: some View {
        List {
            Section {
                NavigationLink { NativeProfileView(auth: auth, username: auth.username ?? "") } label: {
                    HStack(spacing: 14) {
                        ProfileAvatar(auth: auth, path: auth.avatarPath, name: auth.username ?? "", size: 56)
                        VStack(alignment: .leading) { Text(auth.username ?? "").font(.headline); Text("View your profile").foregroundStyle(.secondary).font(.subheadline) }
                    }.padding(.vertical, 8)
                }
            }
            Section("Your account") {
                NavigationLink { ProfileSettingsView(auth: auth).toolbar(.hidden, for: .tabBar) } label: { GleanNavigationRow(title: "Edit profile", symbol: "person.crop.circle", subtitle: "Photo, banner, bio, and badges") }
                NavigationLink { AppearanceSettingsView(auth: auth).toolbar(.hidden, for: .tabBar) } label: { GleanNavigationRow(title: "Accessibility & appearance", symbol: "figure", subtitle: "Theme, readability, and Liquid Glass") }
                NavigationLink { PrivacySettingsView(auth: auth).toolbar(.hidden, for: .tabBar) } label: { GleanNavigationRow(title: "Privacy & security", symbol: "lock.shield", subtitle: "Control your privacy and account protection") }
                NavigationLink { SessionsView(auth: auth).toolbar(.hidden, for: .tabBar) } label: { GleanNavigationRow(title: "Devices & sessions", symbol: "iphone", subtitle: "Review where you’re signed in") }
            }
            Section {
                NavigationLink { NativeInfoView(auth: auth) } label: { GleanNavigationRow(title: "Info", symbol: "info.circle") }
                Button("Sign out", role: .destructive) { Task { await auth.signOut() } }.disabled(auth.busy)
                if let error = auth.error { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Settings")
        .scrollContentBackground(.hidden)
        .listRowSeparator(.hidden)
        .listRowBackground(GleanStyle.panel.opacity(0.72))
    }
}

private struct NativeInfoView: View {
    @ObservedObject var auth: AuthStore

    private var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "Unknown"
        let build = info["CFBundleVersion"] as? String
        return build.map { "\(short) (\($0))" } ?? short
    }
    private var developerMode: Binding<Bool> {
        Binding(get: { auth.developerModeEnabled }, set: { auth.setDeveloperModeEnabled($0) })
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    GleanGlyph().fill(GleanStyle.blue).frame(width: 64, height: 64).accessibilityLabel("Glean")
                    Text("Glean").font(.largeTitle.bold())
                    Text("BETA").font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 4)
                        .background(GleanStyle.blue.opacity(0.18), in: Capsule())
                    LabeledContent("Version", value: version).font(.footnote).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity).padding(.vertical, 18)
            }
            Section("Developer Mode") {
                Toggle(isOn: developerMode) {
                    Label("Enable Developer Mode", systemImage: "wrench.and.screwdriver")
                }
                Text("Shows local app performance and network diagnostics. Counters clear when Developer Mode is disabled or you sign out.")
                    .font(.footnote).foregroundStyle(.secondary)
                if auth.developerModeEnabled {
                    NavigationLink { NativeDiagnosticsView(auth: auth) } label: {
                        Label("Open diagnostics", systemImage: "chart.xyaxis.line")
                    }
                }
            }
        }
        .navigationTitle("Info")
        .toolbar(.hidden, for: .tabBar)
    }
}

private struct NativeDiagnosticsView: View {
    @ObservedObject var auth: AuthStore
    private let openedAt = Date()

    private func bytes(_ value: Int64) -> String {
        guard value > 0 else { return "0 bytes" }
        return ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
    }

    var body: some View {
        List {
            Section("Live connection") {
                LabeledContent("WebSocket", value: auth.diagnosticSocketState)
                LabeledContent("Messages received", value: "\(auth.diagnosticSocketReceived)")
                LabeledContent("Messages sent", value: "\(auth.diagnosticSocketSent)")
                if let activity = auth.diagnosticLastSocketActivity {
                    LabeledContent("Last activity", value: activity.formatted(date: .omitted, time: .standard))
                }
            }
            Section {
                LabeledContent("API requests", value: "\(auth.diagnosticRequests)")
                LabeledContent("Downloaded", value: bytes(auth.diagnosticDownloadBytes))
                LabeledContent("Uploaded", value: bytes(auth.diagnosticUploadBytes))
                if let milliseconds = auth.diagnosticLastRequestMilliseconds {
                    LabeledContent("Last request", value: "\(Int(milliseconds.rounded())) ms")
                }
                LabeledContent("API host", value: "d3bdx5il6w3di0.cloudfront.net")
            } header: {
                Text("Network · since enabled")
            } footer: {
                Text("Counts include requests through Glean’s API client. They exclude OS-managed traffic and media playback handled directly by AVPlayer.")
            }
            Section("Performance") {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    LabeledContent("Diagnostics open", value: context.date.timeIntervalSince(openedAt).formatted(.number.precision(.fractionLength(0))) + " sec")
                }
                LabeledContent("Thermal state", value: ProcessInfo.processInfo.thermalState.description)
            }
            Section("Extensions & trackers") {
                LabeledContent("Browser extensions", value: "Not applicable")
                Text("This native app does not inspect device-wide trackers or other apps’ network traffic. These diagnostics show only Glean API activity recorded by the app.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                Button("Reset diagnostic counters", systemImage: "arrow.counterclockwise") { auth.resetDiagnostics() }
            }
        }
        .navigationTitle("Developer diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
    }
}

private extension ProcessInfo.ThermalState {
    var description: String {
        switch self {
        case .nominal: "Normal"
        case .fair: "Warm"
        case .serious: "Hot"
        case .critical: "Critical"
        @unknown default: "Unknown"
        }
    }
}

struct ProfileSettingsView: View {
    @ObservedObject var auth: AuthStore
    @StateObject private var action = NativeAction()
    @State private var name = ""
    @State private var bio = ""
    @State private var grade = "no_response"
    @State private var school = "no_response"
    @State private var magnet = false
    @State private var college = false
    @State private var discord = ""
    @State private var instagram = ""
    @State private var instagramURL = ""
    @State private var tiktok = ""
    @State private var tiktokURL = ""
    @State private var badges: [EditableBadge] = []
    @State private var importer = false
    @State private var imageField = "avatar"
    @State private var background = "none"
    @State private var color = Color.blue
    @State private var endColor = Color.orange
    var body: some View {
        Form {
            Section("Profile") {
                ProfileAvatar(auth: auth, path: auth.avatarPath, name: name, size: 72)
                Button("Change profile picture") { imageField = "avatar"; importer = true }
                Button("Change banner image") { imageField = "banner"; importer = true }
                TextField("Username", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("About me", text: $bio, axis: .vertical).lineLimit(4...8)
            }
            Section("School & programs") {
                Picker("Grade", selection: $grade) { ForEach(NativeCatalog.grades, id: \.id) { Text($0.name).tag($0.id) } }
                Picker("School", selection: $school) { ForEach(NativeCatalog.schools, id: \.id) { Text($0.name).tag($0.id) } }
                Toggle("MAGNET", isOn: $magnet)
                Toggle("Laredo College", isOn: $college)
            }
            Section("Social accounts") {
                TextField("Discord username", text: $discord)
                TextField("Instagram username", text: $instagram)
                TextField("Instagram link", text: $instagramURL).keyboardType(.URL)
                TextField("TikTok username", text: $tiktok)
                TextField("TikTok link", text: $tiktokURL).keyboardType(.URL)
            }.textInputAutocapitalization(.never).autocorrectionDisabled()
            Section("Custom badges") {
                ForEach($badges) { $badge in
                    HStack {
                        TextField("Badge text", text: $badge.text)
                        ColorPicker("Color", selection: $badge.color).labelsHidden()
                        Button { badges.removeAll { $0.id == badge.id } } label: { Image(systemName: "minus.circle").foregroundStyle(.red) }
                    }
                }
                Button("Add badge") { badges.append(EditableBadge()) }.disabled(badges.count >= 8)
            }
            Section("Profile background") {
                Picker("Style", selection: $background) { Text("Default").tag("none"); Text("Solid color").tag("solid"); Text("Gradient").tag("gradient") }
                if background != "none" { ColorPicker("Color", selection: $color) }
                if background == "gradient" { ColorPicker("End color", selection: $endColor) }
            }
            Section("Name style") {
                NavigationLink {
                    NativeNameStyleSettings(auth: auth)
                } label: {
                    HStack {
                        Text("Preview")
                        Spacer()
                        NativeStyledName(name: name.isEmpty ? (auth.username ?? "Your name") : name,
                                         style: auth.account.object("nameStyle"), foreground: .primary)
                    }
                }
                Text("Customize the color and font shown with your username.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                ActionFeedback(action: action)
                Button("Save profile") { Task { await save() } }.buttonStyle(GleanPrimaryButtonStyle()).disabled(action.busy || name.isEmpty || bio.count > 500)
            }
        }.navigationTitle("Edit profile")
        .task { populate() }
        .fileImporter(isPresented: $importer, allowedContentTypes: [.image]) { result in
            Task { await action.run {
                let url = try result.get()
                try await auth.send("api/account/\(imageField)", text: "", files: [url], reply: nil, fileField: imageField)
                _ = try await auth.request("api/auth/me")
            } }
        }
    }
    private func populate() {
        let record = auth.account
        name = record.text("username"); bio = record.text("bio")
        grade = record.text("grade").isEmpty ? "no_response" : record.text("grade")
        school = record.text("school").isEmpty ? "no_response" : record.text("school")
        let programs = record.records("programs").map { $0.text("id") }
        magnet = programs.contains("magnet"); college = programs.contains("laredo-college")
        discord = record.text("discordUsername")
        let social = record.object("socialLinks")
        instagram = social.text("instagramUsername"); instagramURL = social.text("instagram")
        tiktok = social.text("tiktokUsername"); tiktokURL = social.text("tiktok")
        badges = record.records("customBadges").map { EditableBadge(text: $0.text("label"), color: Color(hex: $0.text("color"))) }
        let bg = record.object("profileBackground")
        background = bg.text("kind").isEmpty ? "none" : bg.text("kind")
        color = Color(hex: background == "gradient" ? bg.text("from") : bg.text("color")); endColor = Color(hex: bg.text("to"))
    }
    private func save() async {
        await action.run {
            if name != auth.username { _ = try await auth.request("api/auth/username", body: ["username": name]) }
            _ = try await auth.request("api/account/bio", body: ["bio": bio])
            _ = try await auth.request("api/account/grade", body: ["grade": grade])
            _ = try await auth.request("api/account/school", body: ["school": school])
            let programs = (magnet ? ["magnet"] : []) + (college ? ["laredo-college"] : [])
            _ = try await auth.request("api/account/program", body: ["programs": programs.isEmpty ? ["no_response"] : programs])
            _ = try await auth.request("api/account/discord", body: ["discordUsername": discord])
            _ = try await auth.request("api/account/social-links", body: ["instagramUsername": instagram, "instagram": instagramURL, "tiktokUsername": tiktok, "tiktok": tiktokURL])
            _ = try await auth.request("api/account/custom-badges", body: ["customBadges": badges.map { ["label": $0.text, "color": $0.color.hex] }])
            _ = try await auth.request("api/account/profile-background", body: ["kind": background, "color": color.hex, "from": color.hex, "to": endColor.hex, "angle": 90])
        }
    }
}

private struct EditableBadge: Identifiable { let id = UUID(); var text = ""; var color = Color.blue }

private struct NativeNameStyleSettings: View {
    @ObservedObject var auth: AuthStore
    @StateObject private var action = NativeAction()
    @State private var kind = "none"
    @State private var color = Color(hex: "#249CFF")
    @State private var from = Color(hex: "#249CFF")
    @State private var to = Color(hex: "#7C5CFF")
    @State private var angle = 135.0
    @State private var glow = 0.0
    @State private var font = "lexend"

    private let fontChoices: [(String, String)] = [
        ("Lexend", "lexend"), ("Rounded", "nunito"),
        ("Serif", "playfair-display"), ("Monospaced", "jetbrains-mono")
    ]
    private var availableFontChoices: [(String, String)] {
        guard !fontChoices.contains(where: { $0.1 == font }) else { return fontChoices }
        return [("Keep current (\(font))", font)] + fontChoices
    }

    var body: some View {
        Form {
            Section("Live preview") {
                NativeStyledName(name: auth.username ?? "Your name", style: previewStyle, foreground: .primary)
                    .font(.title2.weight(.bold))
                    .frame(maxWidth: .infinity, minHeight: 64, alignment: .center)
                    .listRowBackground(Color(uiColor: .secondarySystemGroupedBackground))
            }
            Section("Color") {
                Picker("Style", selection: $kind) {
                    Text("Default").tag("none")
                    Text("Solid").tag("solid")
                    Text("Gradient").tag("gradient")
                }.pickerStyle(.segmented)
                if kind == "solid" {
                    ColorPicker("Name color", selection: $color)
                } else if kind == "gradient" {
                    ColorPicker("Start color", selection: $from)
                    ColorPicker("End color", selection: $to)
                    LabeledContent("Direction", value: "\(Int(angle))°")
                    Slider(value: $angle, in: 0...360, step: 1).accessibilityLabel("Gradient direction")
                }
            }
            Section("Font & glow") {
                Picker("Font", selection: $font) {
                    ForEach(availableFontChoices, id: \.1) { Text($0.0).tag($0.1) }
                }
                LabeledContent("Glow", value: "\(Int(glow))%")
                Slider(value: $glow, in: 0...100, step: 1).accessibilityLabel("Name glow")
            }
            Section {
                ActionFeedback(action: action)
                Button("Save name style") { Task { await save() } }.disabled(action.busy)
                Button("Reset name style", role: .destructive) { Task { await reset() } }.disabled(action.busy)
            }
        }
        .navigationTitle("Name style")
        .task { populate() }
    }

    private var previewStyle: Record {
        var style: Record = ["font": font, "glow": Int(glow)]
        if kind == "solid" {
            style["kind"] = "solid"; style["color"] = color.hex
        } else if kind == "gradient" {
            style["kind"] = "gradient"; style["from"] = from.hex
            style["to"] = to.hex; style["angle"] = Int(angle)
        }
        return style
    }

    private func populate() {
        let style = auth.account.object("nameStyle")
        kind = ["solid", "gradient"].contains(style.text("kind")) ? style.text("kind") : "none"
        color = Color(hex: style.text("color").isEmpty ? "#249CFF" : style.text("color"))
        from = Color(hex: style.text("from").isEmpty ? "#249CFF" : style.text("from"))
        to = Color(hex: style.text("to").isEmpty ? "#7C5CFF" : style.text("to"))
        angle = Double(style.number("angle") == 0 ? 135 : style.number("angle"))
        glow = Double(style.number("glow"))
        let savedFont = style.text("font")
        font = savedFont.isEmpty ? "lexend" : savedFont
    }

    private func save() async {
        await action.run {
            _ = try await auth.request("api/account/name-style", body: previewStyle)
            auth.revision += 1
        }
    }

    private func reset() async {
        await action.run {
            _ = try await auth.request("api/account/name-style", body: ["kind": "none"])
            auth.revision += 1
            kind = "none"; color = Color(hex: "#249CFF")
            from = Color(hex: "#249CFF"); to = Color(hex: "#7C5CFF")
            angle = 135; glow = 0; font = "lexend"
        }
    }
}

extension Color {
    init(hex: String) {
        let value = UInt64(hex.replacingOccurrences(of: "#", with: ""), radix: 16) ?? 0x2299ee
        self.init(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }
    var hex: String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(self).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return String(format: "#%02X%02X%02X", Int(red * 255), Int(green * 255), Int(blue * 255))
    }
}

struct AppearanceSettingsView: View {
    @ObservedObject var auth: AuthStore
    @StateObject private var action = NativeAction()
    @State private var preferences = NativeAccessibilityPreferences()
    @State private var preferencesLoaded = false
    @State private var observedPreferences: NativeAccessibilityPreferences?
    @State private var editRevision = 0
    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Theme", selection: $preferences.theme) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                .pickerStyle(.segmented)
            }
            Section("Accessibility") {
                LabeledContent("Contrast", value: "\(Int(preferences.contrast))%")
                Slider(value: $preferences.contrast, in: 50...150, step: 1)
                    .accessibilityLabel("Contrast")
                LabeledContent("Saturation", value: "\(Int(preferences.saturation))%")
                Slider(value: $preferences.saturation, in: 0...200, step: 1)
                    .accessibilityLabel("Saturation")
                Toggle("Reduce motion", isOn: $preferences.reduceMotion)
            }
            Section {
                if action.busy { Label("Saving to your profile…", systemImage: "arrow.triangle.2.circlepath").font(.footnote).foregroundStyle(.secondary) }
                else if let message = action.message {
                    Label(message, systemImage: action.failed ? "exclamationmark.circle" : "checkmark.circle")
                        .font(.footnote)
                        .foregroundStyle(action.failed ? Color.red : Color.secondary)
                } else {
                    Label("Changes save automatically.", systemImage: "checkmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }.navigationTitle("Accessibility")
        .task {
            let record = auth.account.object("accessibility")
            preferences = NativeAccessibilityPreferences(
                theme: ["system", "light", "dark"].contains(record.text("theme")) ? record.text("theme") : "system",
                contrast: Double(record["contrast"] as? Int ?? 100),
                saturation: Double(record["saturation"] as? Int ?? 100),
                reduceMotion: record.flag("reduceMotion"),
                glassFrost: record["glassFrost"] as? Int ?? 50,
                glassDepth: record["glassDepth"] as? Int ?? 20,
                glassRefraction: record["glassRefraction"] as? Int ?? 100
            )
            observedPreferences = preferences
            preferencesLoaded = true
        }
        .onChange(of: preferences) { _, updated in
            guard preferencesLoaded, updated != observedPreferences else { return }
            observedPreferences = updated
            editRevision += 1
        }
        .task(id: editRevision) {
            guard preferencesLoaded, editRevision > 0 else { return }
            do { try await Task.sleep(for: .milliseconds(300)) }
            catch { return }
            guard !Task.isCancelled else { return }
            while action.busy {
                do { try await Task.sleep(for: .milliseconds(50)) }
                catch { return }
                guard !Task.isCancelled else { return }
            }
            action.message = nil
            let values = preferences.payload
            await action.run(success: "Saved to your profile.") {
                _ = try await auth.request("api/account/accessibility", body: values)
            }
        }
    }
}

private struct NativeAccessibilityPreferences: Equatable {
    var theme = "system"
    var contrast = 100.0
    var saturation = 100.0
    var reduceMotion = false
    var glassFrost = 50
    var glassDepth = 20
    var glassRefraction = 100

    var payload: Record {
        [
            "theme": theme,
            "contrast": Int(contrast),
            "saturation": Int(saturation),
            "reduceMotion": reduceMotion,
            "glassFrost": glassFrost,
            "glassDepth": glassDepth,
            "glassRefraction": glassRefraction
        ]
    }
}

struct PrivacySettingsView: View {
    @ObservedObject var auth: AuthStore
    @StateObject private var action = NativeAction()
    @State private var hidden = false
    @State private var secret = false
    @State private var notes = true
    @State private var presence = "auto"
    @State private var oldPassword = ""
    @State private var password = ""
    @State private var firstWarning = false
    @State private var finalWarning = false
    @State private var deletePassword = ""
    var body: some View {
        Form {
            Section("Privacy") {
                Toggle("Hide online presence", isOn: $hidden)
                Toggle("KeepMyInformationSecret", isOn: $secret)
                Toggle("Private notes", isOn: $notes)
                Picker("Status", selection: $presence) { ForEach(["auto", "online", "idle", "dnd", "offline"], id: \.self) { Text($0 == "dnd" ? "Do not disturb" : $0.capitalized).tag($0) } }
                NavigationLink { NativeBlockedUsersView(auth: auth) } label: { Label("Blocked users", systemImage: "hand.raised") }
                Button("Save privacy settings") { Task { await action.run {
                    _ = try await auth.request("api/account/presence", body: ["hidden": hidden])
                    _ = try await auth.request("api/account/keep-information-secret", body: ["enabled": secret])
                    _ = try await auth.request("api/account/private-notes", body: ["enabled": notes])
                    _ = try await auth.request("api/account/presence-status", body: ["status": presence])
                } } }.buttonStyle(GleanPrimaryButtonStyle()).disabled(action.busy)
            }
            Section("Change password") {
                SecureField("Current password", text: $oldPassword).textContentType(.password)
                SecureField("New password", text: $password).textContentType(.newPassword)
                Button("Change password") { Task { await action.run {
                    _ = try await auth.request("api/account/password", body: ["currentPassword": oldPassword, "newPassword": password]); oldPassword = ""; password = ""
                } } }.disabled(password.count < 10 || oldPassword.isEmpty)
            }
            Section { ActionFeedback(action: action) }
            Section { Button("Delete my account", role: .destructive) { firstWarning = true } }
        }.disabled(action.busy).navigationTitle("Privacy & security")
        .task { hidden = auth.account.flag("presenceHidden"); secret = auth.account.flag("keepInformationSecret"); notes = auth.account.flag("privateNotesEnabled"); presence = auth.account.text("presenceStatus") }
        .alert("Warning 1", isPresented: $firstWarning) {
            Button("Proceed", role: .destructive) { finalWarning = true }
            Button("Cancel", role: .cancel) { }
        } message: { Text("Are you sure you want to delete your account on Glean? You cannot get your information back when you delete your account.") }
        .alert("Warning 2", isPresented: $finalWarning) {
            SecureField("Enter your password", text: $deletePassword)
            Button("I understand, let me delete my account now.", role: .destructive) { Task { await action.run {
                _ = try await auth.request("api/account", body: ["password": deletePassword], method: "DELETE")
                NativeE2EE.deleteKeys(accountID: auth.account.number("id"))
                auth.clearSession()
            }; deletePassword = "" } }
            Button("Cancel", role: .cancel) { deletePassword = "" }
        } message: { Text("This action is not reversible!") }
    }
}

struct SessionsView: View {
    @ObservedObject var auth: AuthStore
    @StateObject private var action = NativeAction()
    @State private var sessions: [Record] = []
    @State private var confirmOthers = false
    @State private var sessionToRevoke: Record?
    var body: some View {
        List {
            Section("Signed-in devices") {
                ForEach(Array(sessions.enumerated()), id: \.offset) { _, record in
                    HStack(spacing: 12) {
                        Image(systemName: record.flag("current") ? "iphone.gen3" : "laptopcomputer.and.iphone")
                            .font(.title3).foregroundStyle(record.flag("current") ? GleanStyle.blue : .secondary)
                            .frame(width: 34)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(record.flag("current") ? "This device" : record.text("device")).font(.subheadline.weight(.semibold))
                        }
                        Spacer()
                        Button(record.flag("current") ? "Sign out" : "Revoke", role: .destructive) {
                            sessionToRevoke = record
                        }
                        .font(.subheadline.weight(.medium))
                        .accessibilityLabel(record.flag("current") ? "Sign out of this device" : "Revoke this session")
                        .disabled(action.busy)
                    }
                    .padding(.vertical, 4)
                }
            }
            ActionFeedback(action: action)
            if sessions.filter({ !$0.flag("current") }).count > 0 {
                Section {
                    Button("Revoke other devices", role: .destructive) { confirmOthers = true }
                } footer: {
                    Text("This signs out every other device without affecting this one.")
                }
            }
        }.navigationTitle("Devices & sessions").task { await load() }.refreshable { await load() }
        .confirmationDialog("Confirm sign-out", isPresented: Binding(get: { sessionToRevoke != nil || confirmOthers }, set: { if !$0 { sessionToRevoke = nil; confirmOthers = false } })) {
            if let sessionToRevoke {
                Button(sessionToRevoke.flag("current") ? "Sign out" : "Revoke session", role: .destructive) { Task { await revokeSession(sessionToRevoke) } }
            }
            if confirmOthers {
                Button("Revoke other devices", role: .destructive) { Task { await revokeOtherSessions() } }
            }
            Button("Cancel", role: .cancel) { sessionToRevoke = nil; confirmOthers = false }
        } message: {
            if let sessionToRevoke, sessionToRevoke.flag("current") {
                Text("You’ll be signed out of Glean on this device.")
            } else if sessionToRevoke != nil {
                Text("This device will be signed out of your Glean account.")
            } else {
                Text("All other devices will be signed out. This device will stay signed in.")
            }
        }
    }
    private func load() async { await action.run(success: nil) { sessions = try await auth.request("api/account/sessions").records("sessions") } }
    private func revokeSession(_ session: Record) async {
        guard !session.text("id").isEmpty else { return }
        var signedOut = false
        await action.run(success: nil) {
            let identifier = session.text("id").addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            let result = try await auth.request("api/account/sessions/\(identifier)", method: "DELETE")
            signedOut = result.flag("signedOut")
        }
        sessionToRevoke = nil
        if !action.failed { if signedOut { auth.clearSession() } else { await load() } }
    }
    private func revokeOtherSessions() async {
        confirmOthers = false
        await action.run { _ = try await auth.request("api/account/sessions/others", method: "DELETE") }
        if !action.failed { await load() }
    }
}

private struct NativeGlassSurface: ViewModifier {
    let cornerRadius: CGFloat
    let capsule: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @ViewBuilder func body(content: Content) -> some View {
        if reduceTransparency {
            if capsule { content.background(GleanStyle.panel, in: Capsule()) }
            else { content.background(GleanStyle.panel, in: RoundedRectangle(cornerRadius: cornerRadius)) }
        } else if #available(iOS 26.0, *) {
            if capsule {
                content.glassEffect(.regular.interactive(), in: .capsule)
            } else {
                content.glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
            }
        } else if capsule {
            content.background(.ultraThinMaterial, in: Capsule())
        } else {
            content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }
}

extension View {
    func gleanGlassCard(cornerRadius: CGFloat = 18) -> some View {
        modifier(NativeGlassSurface(cornerRadius: cornerRadius, capsule: false))
    }

    func gleanGlassPill() -> some View {
        modifier(NativeGlassSurface(cornerRadius: 999, capsule: true))
    }
}

struct NativeProfileView: View {
    @ObservedObject var auth: AuthStore
    let username: String
    @State private var profile: Record = [:]
    @State private var note = ""
    @State private var showBlockConfirmation = false
    @State private var showRemoveConfirmation = false
    @State private var selectedConversation: NativeConversationDestination?
    @StateObject private var action = NativeAction()
    private var profileBackground: Record { profile.object("profileBackground") }
    private var profileForeground: Color {
        let hex = profileBackground.text(profileBackground.text("kind") == "gradient" ? "from" : "color")
        let value = UInt64(hex.replacingOccurrences(of: "#", with: ""), radix: 16) ?? 0x18232e
        let red = Double((value >> 16) & 255) / 255
        let green = Double((value >> 8) & 255) / 255
        let blue = Double(value & 255) / 255
        return red * 0.299 + green * 0.587 + blue * 0.114 > 0.58 ? Color.black : Color.white
    }
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                profileCard
            if profile.text("relation") != "self" {
                profileSection("Connection", icon: "person.2") {
                    FlowLayout(spacing: 10) {
                    switch profile.text("relation") {
                    case "friend":
                        Button { Task { await openDM() } } label: { Label("Message", systemImage: "bubble.left") }
                        Button("Remove friend", role: .destructive) { showRemoveConfirmation = true }
                    case "incoming":
                        Button("Accept friend request") { Task { await connectionAction("api/friends/requests/\(profile.number("requestId"))/accept", body: [:]) } }
                        Button("Decline request", role: .destructive) { Task { await connectionAction("api/friends/requests/\(profile.number("requestId"))/decline", body: [:]) } }
                    case "outgoing":
                        Button("Cancel friend request", role: .destructive) { Task { await connectionAction("api/friends/requests/\(profile.number("requestId"))", method: "DELETE") } }
                    case "blocked":
                        Button("Unblock user") { Task { await connectionAction("api/blocks/\(encodedUsername)", method: "DELETE") } }
                    default:
                        Button("Add friend") { Task { await connectionAction("api/friends/requests", body: ["username": username]) } }
                    }
                    if profile.text("relation") != "blocked" { Button("Block user", role: .destructive) { showBlockConfirmation = true } }
                    }.disabled(action.busy)
                }
                if auth.account.flag("privateNotesEnabled") {
                    profileSection("Private note", icon: "note.text") {
                        TextField("Only you can see this note", text: $note, axis: .vertical).lineLimit(2...5)
                        Button("Save note") { Task { await action.run { _ = try await auth.request("api/users/\(encodedUsername)/note", body: ["note": note], method: "PATCH") } } }
                    }
                }
            }
            if let joinedDate { profileSection("Member since", icon: "calendar") { Text(joinedDate).foregroundStyle(.secondary) } }
            ActionFeedback(action: action)
            }.padding(16).frame(maxWidth: 680).frame(maxWidth: .infinity)
                .disabled(profile.isEmpty)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .overlay {
            if profile.isEmpty && action.busy { GleanLoadingState(title: "profile") }
            else if profile.isEmpty && action.failed {
                ContentUnavailableView {
                    Label("Couldn’t load profile", systemImage: "wifi.exclamationmark")
                } description: { Text(action.message ?? "Please try again.") }
                actions: { Button("Try again") { Task { await loadProfile() } } }
            }
        }
        .navigationTitle(username)
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $selectedConversation) { conversation in MessageHistoryView(auth: auth, path: "api/conversations/\(conversation.id)/messages", title: conversation.title, peerPublicKey: conversation.peerPublicKey) }
        .confirmationDialog("Block \(username)?", isPresented: $showBlockConfirmation, titleVisibility: .visible) {
            Button("Block user", role: .destructive) { Task { await connectionAction("api/blocks", body: ["username": username]) } }
            Button("Cancel", role: .cancel) { }
        } message: { Text("They will no longer be able to contact you or interact with you.") }
        .confirmationDialog("Remove \(username) from your friends?", isPresented: $showRemoveConfirmation, titleVisibility: .visible) {
            Button("Remove friend", role: .destructive) { Task { await connectionAction("api/friends/\(encodedUsername)", method: "DELETE") } }
            Button("Cancel", role: .cancel) { }
        }
        .task { await loadProfile() }
    }
    private func loadProfile() async {
        await action.run(success: nil) {
            guard let name = username.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return }
            profile = try await auth.request("api/users/\(name)").object("user")
            note = profile.text("note")
        }
    }
    private var profileCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            NativeProfileBanner(auth: auth, banner: profile.object("banner"))
                .frame(height: 150)
                .overlay(alignment: .bottomLeading) {
                    ProfileAvatar(auth: auth, path: profile["avatarUrl"] as? String, name: username, size: 88)
                        .padding(.leading, 18).offset(y: 38)
                }
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 4) {
                        NativeStyledName(name: profile.text("username").isEmpty ? username : profile.text("username"), style: profile.object("nameStyle"), foreground: profileForeground)
                            .font(.title2.bold())
                        Label(presenceLabel, systemImage: "circle.fill")
                            .font(.caption.weight(.medium)).foregroundStyle(presenceColor)
                    }
                    Spacer(minLength: 0)
                }.padding(.top, 34)
                let officialBadges = profile.records("badges")
                let programs = profile.records("programs").filter { ["magnet", "laredo-college"].contains($0.text("id")) }
                if !officialBadges.isEmpty || !profile.records("customBadges").isEmpty || !profile.text("schoolLabel").isEmpty || !programs.isEmpty {
                    FlowLayout(spacing: 8) {
                        ForEach(Array(officialBadges.enumerated()), id: \.offset) { _, badge in
                            Text(badge.text("label")).font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 6)
                                .background(officialBadgeColor(badge.text("id")), in: Capsule()).foregroundStyle(.white)
                        }
                        ForEach(Array(profile.records("customBadges").filter { !$0.text("label").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.enumerated()), id: \.offset) { _, badge in
                            let color = Color(hex: badge.text("color"))
                            Text(badge.text("label")).font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 6)
                                .background(color, in: Capsule()).foregroundStyle(contrastingText(for: color))
                        }
                        if !profile.text("schoolLabel").isEmpty {
                            profileChip(profile.text("schoolLabel"), color: Color(hex: (profile["schoolHex"] as? [String])?.first ?? profile.text("schoolHex")))
                        }
                        ForEach(Array(programs.enumerated()), id: \.offset) { _, program in
                            let colors = program["hex"] as? [String] ?? []
                            let color = colors.first(where: { $0.lowercased() != "#ffffff" && $0.lowercased() != "#f5e6a3" }) ?? colors.first ?? "#2299EE"
                            profileChip(program.text("id") == "laredo-college" ? "Early College" : program.text("label"), color: Color(hex: color))
                        }
                    }
                }
                if !profile.text("gradeLabel").isEmpty { Label(profile.text("gradeLabel"), systemImage: "graduationcap").font(.subheadline).foregroundStyle(.secondary) }
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    Text("ABOUT ME").font(.caption.weight(.bold)).tracking(0.8).foregroundStyle(.secondary)
                    Text(profile.text("bio").isEmpty ? "No bio yet." : profile.text("bio"))
                        .font(.body).textSelection(.enabled)
                }
                socialLinks
            }
            .padding(18)
            .foregroundStyle(profileForeground)
        }
        .background(profileBackgroundView)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(.primary.opacity(0.08)))
    }
    @ViewBuilder private var profileBackgroundView: some View {
        switch profileBackground.text("kind") {
        case "solid": Color(hex: profileBackground.text("color"))
        case "gradient": LinearGradient(colors: [Color(hex: profileBackground.text("from")), Color(hex: profileBackground.text("to"))], startPoint: .topLeading, endPoint: .bottomTrailing)
        default: Color(uiColor: .secondarySystemGroupedBackground)
        }
    }
    @ViewBuilder private var socialLinks: some View {
        let socials = profile.object("socialLinks")
        let instagram = safeSocialURL(socials.text("instagram"), fallback: socials.text("instagramUsername").isEmpty ? nil : "https://instagram.com/\(socials.text("instagramUsername"))")
        let tiktok = safeSocialURL(socials.text("tiktok"), fallback: socials.text("tiktokUsername").isEmpty ? nil : "https://www.tiktok.com/@\(socials.text("tiktokUsername"))")
        if !profile.text("discordUsername").isEmpty || instagram != nil || tiktok != nil {
            Divider()
            FlowLayout(spacing: 8) {
                if !profile.text("discordUsername").isEmpty { Label(profile.text("discordUsername"), systemImage: "bubble.left.and.bubble.right").font(.caption.weight(.semibold)).padding(9).background(.primary.opacity(0.08), in: Capsule()) }
                if let instagram { Link(destination: instagram) { Label("Instagram", systemImage: "camera").font(.caption.weight(.semibold)).padding(9).background(.primary.opacity(0.08), in: Capsule()) } }
                if let tiktok { Link(destination: tiktok) { Label("TikTok", systemImage: "music.note").font(.caption.weight(.semibold)).padding(9).background(.primary.opacity(0.08), in: Capsule()) } }
            }
        }
    }
    private func profileSection<Content: View>(_ title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: icon).font(.headline)
            content().buttonStyle(.bordered).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .gleanGlassCard(cornerRadius: GleanStyle.cardRadius)
    }
    private func profileChip(_ title: String, color: Color) -> some View {
        Text(title).font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 6).background(color, in: Capsule()).foregroundStyle(contrastingText(for: color))
    }
    private func officialBadgeColor(_ id: String) -> Color { id == "owner" ? Color(hex: "#8C4A16") : Color(hex: "#1D5C3B") }
    private func contrastingText(for color: Color) -> Color {
        let ui = UIColor(color); var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0
        ui.getRed(&red, green: &green, blue: &blue, alpha: nil)
        return Double(red) * 0.299 + Double(green) * 0.587 + Double(blue) * 0.114 > 0.58 ? .black : .white
    }
    private func safeSocialURL(_ value: String, fallback: String?) -> URL? {
        guard let url = URL(string: value.isEmpty ? (fallback ?? "") : value), url.scheme == "https", url.host != nil else { return nil }
        return url
    }
    private var presenceLabel: String { profile.text("presence").isEmpty ? "Offline" : profile.text("presence").capitalized }
    private var presenceColor: Color {
        switch profile.text("presence").lowercased() { case "online": .green; case "idle": .orange; case "dnd": .red; default: .secondary }
    }
    private var joinedDate: String? {
        let raw = profile.text("createdAt")
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let standard = ISO8601DateFormatter()
        guard let date = fractional.date(from: raw) ?? standard.date(from: raw) else { return raw.isEmpty ? nil : raw }
        return date.formatted(date: .long, time: .omitted)
    }
    private var encodedUsername: String { username.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
    private func openDM() async {
        await action.run(success: nil) {
            let result = try await auth.request("api/conversations/direct/\(encodedUsername)", body: [:])
            let conversation = result.object("conversation")
            let peer = conversation.object("user")
            selectedConversation = NativeConversationDestination(id: conversation.number("id"), title: username, peerPublicKey: peer["publicKey"] as? Record, peerUserID: peer.number("id"))
        }
    }
    private func connectionAction(_ path: String, body: Record? = nil, method: String? = nil) async {
        await action.run { _ = try await auth.request(path, body: body, method: method); profile = try await auth.request("api/users/\(encodedUsername)").object("user"); auth.revision += 1 }
    }
}

private struct NativeStyledName: View {
    let name: String
    let style: Record
    let foreground: Color
    var body: some View {
        Group {
            if style.text("kind") == "gradient" {
                Text(name).foregroundStyle(LinearGradient(colors: [Color(hex: style.text("from")), Color(hex: style.text("to"))], startPoint: gradientStart, endPoint: gradientEnd))
            } else if style.text("kind") == "solid" {
                Text(name).foregroundStyle(Color(hex: style.text("color")))
            } else { Text(name).foregroundStyle(foreground) }
        }
        .fontDesign(nativeNameFontDesign(style.text("font")))
        .lineLimit(1).minimumScaleFactor(0.75)
        .shadow(color: glowColor.opacity(Double(style.number("glow")) / 180), radius: CGFloat(style.number("glow")) * 0.08)
    }

    private var glowColor: Color {
        if style.text("kind") == "gradient" { return Color(hex: style.text("from")) }
        if style.text("kind") == "solid" { return Color(hex: style.text("color")) }
        return GleanStyle.blue
    }
    private var gradientStart: UnitPoint {
        let radians = Double(style.number("angle") == 0 ? 135 : style.number("angle")) * .pi / 180
        return UnitPoint(x: 0.5 - sin(radians) * 0.5, y: 0.5 + cos(radians) * 0.5)
    }
    private var gradientEnd: UnitPoint {
        let radians = Double(style.number("angle") == 0 ? 135 : style.number("angle")) * .pi / 180
        return UnitPoint(x: 0.5 + sin(radians) * 0.5, y: 0.5 - cos(radians) * 0.5)
    }
}

private func nativeNameFontDesign(_ id: String) -> Font.Design {
    switch id {
    case "playfair-display", "merriweather", "fraunces", "literata", "source-serif-4", "dm-serif", "lora", "crimson-pro", "bitter", "spectral", "instrument-serif", "eb-garamond", "libre-baskerville", "newsreader", "cormorant", "young-serif", "noto-serif", "pt-serif":
        .serif
    case "jetbrains-mono", "ibm-plex-mono", "source-code-pro", "fira-code", "space-mono", "roboto-mono":
        .monospaced
    case "nunito":
        .rounded
    default:
        .default
    }
}

private struct NativeProfileBanner: View {
    let auth: AuthStore
    let banner: Record
    @State private var image: UIImage?
    @State private var loadingImage = false
    @State private var imageFailed = false

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottomLeading) {
                background
                if banner.text("kind") == "image" {
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .clipped()
                            .transition(.opacity)
                    } else if loadingImage {
                        ProgressView().tint(.white).padding(14)
                    } else if imageFailed {
                        Image(systemName: "photo")
                            .font(.title2)
                            .foregroundStyle(.white.opacity(0.78))
                            .padding(14)
                            .accessibilityLabel("Profile banner could not be loaded")
                    }
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        .task(id: "\(banner.text("kind"))-\(banner.text("imageUrl"))") {
            image = nil
            imageFailed = false
            guard banner.text("kind") == "image", let path = banner["imageUrl"] as? String, !path.isEmpty else { return }
            loadingImage = true
            defer { loadingImage = false }
            do {
                let file = try await auth.media(path)
                defer { try? FileManager.default.removeItem(at: file) }
                let decoded = try await Task.detached(priority: .utility) {
                    UIImage(data: try Data(contentsOf: file, options: .mappedIfSafe))
                }.value
                guard !Task.isCancelled else { return }
                image = decoded
                imageFailed = image == nil
            } catch { imageFailed = true }
        }
    }

    @ViewBuilder private var background: some View {
        switch banner.text("kind") {
        case "solid": Color(hex: banner.text("color"))
        case "gradient": LinearGradient(colors: [Color(hex: banner.text("from")), Color(hex: banner.text("to"))], startPoint: .topLeading, endPoint: .bottomTrailing)
        default: LinearGradient(colors: [GleanStyle.blue.opacity(0.85), Color(uiColor: .tertiarySystemGroupedBackground)], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += size.width + spacing; rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + rowHeight)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing; rowHeight = max(rowHeight, size.height)
        }
    }
}

struct NativeBlockedUsersView: View {
    @ObservedObject var auth: AuthStore
    @State private var blocked: [Record] = []
    @State private var errorMessage: String?
    @State private var loading = true
    var body: some View {
        List {
            ForEach(blocked, id: \.channelID) { person in
                HStack {
                    ProfileAvatarLink(auth: auth, path: person["avatarUrl"] as? String, username: person.text("username"), size: 42)
                    NavigationLink(person.text("username")) { NativeProfileView(auth: auth, username: person.text("username")) }
                    Spacer()
                    Button("Unblock", role: .destructive) { Task { await unblock(person.text("username")) } }
                }
            }
            if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            if blocked.isEmpty && !loading { ContentUnavailableView("No blocked users", systemImage: "hand.raised") }
        }
        .overlay { if loading { ProgressView("Loading blocked users…") } }
        .navigationTitle("Blocked users")
        .task { await load() }.refreshable { await load() }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do { blocked = try await auth.request("api/blocks").records("blocked"); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
    }
    private func unblock(_ username: String) async {
        guard let encoded = username.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return }
        do { _ = try await auth.request("api/blocks/\(encoded)", method: "DELETE"); await load() }
        catch { errorMessage = error.localizedDescription }
    }
}
