import SwiftUI

struct NativeConversationDestination: Identifiable, Hashable {
    let id: Int
    let title: String
    var peerPublicKey: Record? = nil
    var peerUserID: Int? = nil
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id && lhs.title == rhs.title }
    func hash(into hasher: inout Hasher) { hasher.combine(id); hasher.combine(title) }
}

struct NativeFriendsView: View {
    @ObservedObject var auth: AuthStore
    @State private var friends: [Record] = []
    @State private var incoming: [Record] = []
    @State private var outgoing: [Record] = []
    @State private var people: [Record] = []
    @State private var username = ""
    @State private var errorMessage: String?
    @State private var loading = true
    @State private var sending = false
    @State private var selectedConversation: NativeConversationDestination?
    var body: some View {
        List {
            Section("Add a friend") {
                HStack {
                    TextField("Username", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Send") { Task { await sendRequest() } }.disabled(username.trimmingCharacters(in: .whitespaces).isEmpty || sending)
                }
                if let errorMessage { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
            }
            if !incoming.isEmpty {
                Section("Requests · \(incoming.count)") {
                    ForEach(incoming, id: \.channelID) { request in
                        let user = request.object("user")
                        HStack {
                            ProfileAvatarLink(auth: auth, path: user["avatarUrl"] as? String, username: user.text("username"), size: 42)
                            NavigationLink(user.text("username")) { NativeProfileView(auth: auth, username: user.text("username")) }
                            Spacer()
                            Button { Task { await changeRequest(request.number("id"), action: "accept") } } label: { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }.accessibilityLabel("Accept request from \(user.text("username"))")
                            Button { Task { await changeRequest(request.number("id"), action: "decline") } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.red) }.accessibilityLabel("Decline request from \(user.text("username"))")
                        }
                    }
                }
            }
            if !outgoing.isEmpty {
                Section("Sent requests") {
                    ForEach(outgoing, id: \.channelID) { request in
                        let user = request.object("user")
                        HStack { ProfileAvatarLink(auth: auth, path: user["avatarUrl"] as? String, username: user.text("username"), size: 38); Text(user.text("username")); Spacer(); Button("Cancel") { Task { await cancel(request.number("id")) } } }
                    }
                }
            }
            Section("Friends · \(friends.count)") {
                ForEach(friends, id: \.channelID) { friend in
                    HStack {
                        ProfileAvatarLink(auth: auth, path: friend["avatarUrl"] as? String, username: friend.text("username"), size: 42)
                        NavigationLink { NativeProfileView(auth: auth, username: friend.text("username")) } label: { VStack(alignment: .leading) { Text(friend.text("username")); Text(friend.text("presence")).font(.caption).foregroundStyle(.secondary) } }
                        Spacer()
                        Button { Task { await openDM(friend.text("username")) } } label: { Image(systemName: "bubble.left").padding(8) }.accessibilityLabel("Message \(friend.text("username"))")
                    }
                }
                if friends.isEmpty && !loading { ContentUnavailableView("No friends yet", systemImage: "person.2") }
            }
            Section("People on Glean") {
                ForEach(people, id: \.channelID) { person in
                    HStack {
                        ProfileAvatarLink(auth: auth, path: person["avatarUrl"] as? String, username: person.text("username"), size: 40)
                        NavigationLink { NativeProfileView(auth: auth, username: person.text("username")) } label: { VStack(alignment: .leading) { Text(person.text("username")); Text(person.text("schoolLabel").isEmpty ? person.text("bio") : person.text("schoolLabel")).font(.caption).foregroundStyle(.secondary).lineLimit(1) } }
                        Spacer()
                        if person.text("relation") == "none" {
                            Button { Task { await sendTo(person.text("username")) } } label: { Image(systemName: "person.badge.plus") }.accessibilityLabel("Add \(person.text("username"))")
                        }
                    }
                }
            }
        }
        .overlay { if loading && friends.isEmpty && people.isEmpty { GleanLoadingState(title: "friends") } }
        .navigationTitle("Friends")
        .toolbar(.hidden, for: .tabBar)
        .navigationDestination(item: $selectedConversation) { conversation in MessageHistoryView(auth: auth, path: "api/conversations/\(conversation.id)/messages", title: conversation.title, peerPublicKey: conversation.peerPublicKey) }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") } } }
        .refreshable { await load() }
        .task { await load() }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do {
            async let friendResult = auth.request("api/friends")
            async let peopleResult = auth.request("api/people")
            let (f, p) = try await (friendResult, peopleResult)
            friends = f.records("friends"); incoming = f.records("requests"); outgoing = f.records("sent"); people = p.records("people")
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
    private func sendRequest() async { await sendTo(username) }
    private func sendTo(_ name: String) async {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        sending = true; defer { sending = false }
        do { _ = try await auth.request("api/friends/requests", body: ["username": value]); username = ""; await load(); auth.revision += 1 }
        catch { errorMessage = error.localizedDescription }
    }
    private func changeRequest(_ id: Int, action: String) async {
        do { _ = try await auth.request("api/friends/requests/\(id)/\(action)", body: [:]); await load(); auth.revision += 1 }
        catch { errorMessage = error.localizedDescription }
    }
    private func cancel(_ id: Int) async {
        do { _ = try await auth.request("api/friends/requests/\(id)", method: "DELETE"); await load() }
        catch { errorMessage = error.localizedDescription }
    }
    private func openDM(_ name: String) async {
        guard let escaped = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return }
        do { let result = try await auth.request("api/conversations/direct/\(escaped)", body: [:]); let conversation = result.object("conversation"); let peer = conversation.object("user"); selectedConversation = NativeConversationDestination(id: conversation.number("id"), title: name, peerPublicKey: peer["publicKey"] as? Record, peerUserID: peer.number("id")); auth.revision += 1 }
        catch { errorMessage = error.localizedDescription }
    }
}

struct NativeDiscoverView: View {
    @ObservedObject var auth: AuthStore
    @State private var mode = "people"
    @State private var people: [Record] = []
    @State private var peopleQuery = ""
    @State private var selectedSchool = ""
    @State private var selectedProgram = ""
    @State private var selectedGrade = ""
    @State private var peopleCursor: Int?
    @State private var matchingPeopleCount = 0
    @State private var totalUsers: Int?
    @State private var peopleLoading = true
    @State private var loadingMorePeople = false
    @State private var servers: [Record] = []
    @State private var serverQuery = ""
    @State private var nextCursor: Int?
    @State private var errorMessage: String?
    @State private var serversLoading = true
    @State private var joining = Set<Int>()
    private var peopleRequestKey: String {
        [mode, peopleQuery, selectedSchool, selectedProgram, selectedGrade].joined(separator: "\u{1f}")
    }
    private var selectedSchoolName: String {
        NativeCatalog.schools.first(where: { $0.id == selectedSchool })?.name ?? "Any school"
    }
    private var selectedProgramName: String {
        NativeCatalog.programs.first(where: { $0.id == selectedProgram })?.name ?? "Any program"
    }
    private var selectedGradeName: String {
        NativeCatalog.grades.first(where: { $0.id == selectedGrade })?.name ?? "Any grade"
    }
    private var hasPeopleFilters: Bool { !selectedSchool.isEmpty || !selectedProgram.isEmpty || !selectedGrade.isEmpty }

    var body: some View {
        List {
            Section {
                Picker("Discover", selection: $mode) {
                    Text("People").tag("people")
                    Text("Servers").tag("servers")
                }
                .pickerStyle(.segmented)
                if mode == "people" {
                    HStack(spacing: 10) {
                        Image(systemName: "person.3.fill").foregroundStyle(GleanStyle.blue)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("On Glean").font(.caption).foregroundStyle(.secondary)
                            Text(totalUsers.map { "\($0.formatted()) users" } ?? "User count unavailable")
                                .font(.headline)
                        }
                        Spacer()
                        Text("\(matchingPeopleCount.formatted()) found")
                            .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            }

            if mode == "people" {
                Section("Find people") {
                    TextField("Search usernames or bios", text: $peopleQuery)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                    HStack(spacing: 8) {
                        schoolFilter
                        programFilter
                    }
                    gradeFilter
                    if hasPeopleFilters {
                        Button("Clear filters", systemImage: "xmark.circle") {
                            selectedSchool = ""
                            selectedProgram = ""
                            selectedGrade = ""
                        }
                        .font(.subheadline)
                    }
                }

                if peopleLoading && people.isEmpty {
                    Section { ProgressView("Finding people…").frame(maxWidth: .infinity, alignment: .center) }
                }
                ForEach(people, id: \.channelID) { person in
                    NavigationLink {
                        NativeProfileView(auth: auth, username: person.text("username"))
                    } label: {
                        personRow(person)
                    }
                }
                if !peopleLoading && people.isEmpty {
                    ContentUnavailableView.search(text: peopleQuery)
                }
                if let peopleCursor {
                    Section {
                        Button {
                            Task { await loadPeople(append: true, cursor: peopleCursor, requestKey: peopleRequestKey) }
                        } label: {
                            HStack {
                                Spacer()
                                if loadingMorePeople { ProgressView().padding(.trailing, 6) }
                                Text(loadingMorePeople ? "Loading…" : "Load more people")
                                Spacer()
                            }
                        }
                        .disabled(loadingMorePeople || peopleLoading)
                    }
                }
            } else {
                Section {
                    TextField("Search public servers", text: $serverQuery)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await loadServers() } }
                }
                ForEach(servers, id: \.channelID) { server in
                    HStack(spacing: 12) {
                        ProfileAvatar(auth: auth, path: server["iconUrl"] as? String, name: server.text("name"), size: 52)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(server.text("name")).font(.headline)
                            Text(server.text("description")).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                            Text("\(server.number("memberCount")) members").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Button(server.flag("isMember") ? "Joined" : joining.contains(server.number("id")) ? "Joining…" : "Join") { Task { await join(server.number("id")) } }
                            .buttonStyle(.borderedProminent).disabled(server.flag("isMember") || joining.contains(server.number("id")))
                    }
                    .padding(.vertical, 6)
                }
                if serversLoading && servers.isEmpty {
                    Section { ProgressView("Finding public servers…").frame(maxWidth: .infinity, alignment: .center) }
                }
                if let nextCursor {
                    Button("Load more servers") { Task { await loadServers(append: true, cursor: nextCursor) } }
                        .frame(maxWidth: .infinity)
                }
                if servers.isEmpty && !serversLoading {
                    ContentUnavailableView("No public servers found", systemImage: "magnifyingglass")
                }
            }
            if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
        }
        .navigationTitle("Discover")
        .toolbar(.hidden, for: .tabBar)
        .refreshable {
            if mode == "people" {
                await loadStats()
                await loadPeople(requestKey: peopleRequestKey)
            } else {
                await loadServers()
            }
        }
        .task {
            await loadStats()
            await loadServers()
        }
        .task(id: peopleRequestKey) {
            let requestKey = peopleRequestKey
            guard mode == "people" else { return }
            if !peopleQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard !Task.isCancelled else { return }
            await loadPeople(requestKey: requestKey)
        }
    }

    private var schoolFilter: some View {
        Menu {
            Button("Any school") { selectedSchool = "" }
            Divider()
            ForEach(NativeCatalog.schools.filter { $0.id != "no_response" }) { school in
                Button {
                    selectedSchool = school.id
                } label: {
                    HStack {
                        Text(school.name)
                        if selectedSchool == school.id { Image(systemName: "checkmark") }
                    }
                }
            }
        } label: {
            Label(selectedSchool.isEmpty ? "School" : selectedSchoolName, systemImage: "building.2")
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .buttonStyle(.bordered)
        .frame(maxWidth: .infinity)
    }

    private var programFilter: some View {
        Menu {
            Button("Any program") { selectedProgram = "" }
            Divider()
            ForEach(NativeCatalog.programs) { program in
                Button {
                    selectedProgram = program.id
                } label: {
                    HStack {
                        Text(program.name)
                        if selectedProgram == program.id { Image(systemName: "checkmark") }
                    }
                }
            }
        } label: {
            Label(selectedProgram.isEmpty ? "Program" : selectedProgramName, systemImage: "graduationcap")
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .buttonStyle(.bordered)
        .frame(maxWidth: .infinity)
    }

    private var gradeFilter: some View {
        Menu {
            Button("Any grade") { selectedGrade = "" }
            Divider()
            ForEach(NativeCatalog.grades.filter { $0.id != "no_response" }) { grade in
                Button {
                    selectedGrade = grade.id
                } label: {
                    HStack {
                        Text(grade.name)
                        if selectedGrade == grade.id { Image(systemName: "checkmark") }
                    }
                }
            }
        } label: {
            Label(selectedGrade.isEmpty ? "Grade" : selectedGradeName, systemImage: "person.text.rectangle")
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .buttonStyle(.bordered)
    }

    private func personRow(_ person: Record) -> some View {
        HStack(spacing: 12) {
            ProfileAvatar(auth: auth, path: person["avatarUrl"] as? String, name: person.text("username"), size: 46)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(person.text("username")).font(.headline)
                    if person.text("relation") == "friend" {
                        Text("Friend").font(.caption2.weight(.semibold)).foregroundStyle(GleanStyle.blue)
                    } else if ["incoming", "outgoing"].contains(person.text("relation")) {
                        Text("Request").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                let details = ([person.text("schoolLabel"), person.text("gradeLabel")] + person.records("programs").map { $0.text("label") })
                    .filter { !$0.isEmpty }
                if !details.isEmpty {
                    Text(details.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if !person.text("bio").isEmpty {
                    Text(person.text("bio")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .contentShape(Rectangle())
    }

    private func loadStats() async {
        do {
            let result = try await auth.request("api/auth/stats")
            totalUsers = result.number("total")
        } catch {
            if totalUsers == nil { errorMessage = error.localizedDescription }
        }
    }

    private func loadPeople(append: Bool = false, cursor: Int = 0, requestKey: String) async {
        if append { loadingMorePeople = true }
        else { peopleLoading = true; loadingMorePeople = false }
        defer {
            if !Task.isCancelled && requestKey == peopleRequestKey {
                peopleLoading = false
                loadingMorePeople = false
            }
        }
        do {
            var components = URLComponents()
            components.queryItems = [
                URLQueryItem(name: "query", value: peopleQuery),
                URLQueryItem(name: "school", value: selectedSchool),
                URLQueryItem(name: "program", value: selectedProgram),
                URLQueryItem(name: "grade", value: selectedGrade),
                URLQueryItem(name: "cursor", value: String(cursor)),
                URLQueryItem(name: "limit", value: "50"),
            ]
            let result = try await auth.request("api/people\(components.percentEncodedQuery.map { "?\($0)" } ?? "")")
            guard !Task.isCancelled, requestKey == peopleRequestKey else { return }
            let page = result.records("people")
            if append {
                let knownIDs = Set(people.map { $0.channelID })
                people += page.filter { !knownIDs.contains($0.channelID) }
            } else {
                people = page
            }
            matchingPeopleCount = result.number("total")
            peopleCursor = result["nextCursor"] as? Int
            errorMessage = nil
        } catch {
            guard !Task.isCancelled, requestKey == peopleRequestKey else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func loadServers(append: Bool = false, cursor: Int = 0) async {
        serversLoading = true
        defer { serversLoading = false }
        do {
            var components = URLComponents()
            components.queryItems = [URLQueryItem(name: "query", value: serverQuery), URLQueryItem(name: "cursor", value: String(cursor)), URLQueryItem(name: "limit", value: "24")]
            let result = try await auth.request("api/public-servers\(components.percentEncodedQuery.map { "?\($0)" } ?? "")")
            if append { servers += result.records("servers") } else { servers = result.records("servers") }
            nextCursor = result["nextCursor"] as? Int
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func join(_ id: Int) async {
        joining.insert(id); defer { joining.remove(id) }
        do { _ = try await auth.request("api/public-servers/\(id)/join", body: [:]); if let i = servers.firstIndex(where: { $0.number("id") == id }) { servers[i]["isMember"] = true }; auth.revision += 1 }
        catch { errorMessage = error.localizedDescription }
    }
}

struct NativeCreateServerView: View {
    @ObservedObject var auth: AuthStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var busy = false
    @State private var errorMessage: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("New server") { TextField("Server name", text: $name).textInputAutocapitalization(.words); Text("A #general channel and Owner, Moderator, and Member roles will be created.").font(.footnote).foregroundStyle(.secondary) }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
                Button { Task { await create() } } label: { if busy { ProgressView() } else { Text("Create server").frame(maxWidth: .infinity) } }.disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
            }.navigationTitle("Create server").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
    private func create() async {
        busy = true; defer { busy = false }
        do { _ = try await auth.request("api/servers", body: ["name": name.trimmingCharacters(in: .whitespacesAndNewlines)]); auth.revision += 1; dismiss() }
        catch { errorMessage = error.localizedDescription }
    }
}

struct NativePollCard: View {
    let poll: Record
    let canClose: Bool
    let onVote: (Int) -> Void
    let onClose: () -> Void
    private var options: [Record] { poll.records("options") }
    private var total: Int { poll.number("voterCount") }
    private var showResults: Bool { poll.flag("closed") || options.contains(where: { $0.flag("voted") }) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(poll.text("question")).font(.headline)
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Button { onVote(option.number("index")) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack { Text(option.text("text")); Spacer(); if showResults { Text("\(option.number("votes"))").font(.caption.bold()) } }
                        if showResults {
                            GeometryReader { geo in ZStack(alignment: .leading) { Capsule().fill(Color.secondary.opacity(0.12)); Capsule().fill(GleanStyle.blue.opacity(0.7)).frame(width: geo.size.width * min(1, CGFloat(option.number("votes")) / CGFloat(max(1, total)))) } }
                                .frame(height: 4)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(option.flag("voted") ? GleanStyle.blue.opacity(0.14) : GleanStyle.panel, in: RoundedRectangle(cornerRadius: 10))
                    .contentShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .disabled(poll.flag("closed"))
            }
            HStack {
                Text("\(total) vote\(total == 1 ? "" : "s")\(poll.flag("allowMultiple") ? " · Multiple selections" : "")\(poll.flag("closed") ? " · Closed" : "")").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if canClose && !poll.flag("closed") { Button("Close poll", action: onClose).font(.caption) }
            }
        }
        .padding(12)
        .background(GleanStyle.panel.opacity(0.7), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct NativePollComposer: View {
    @Environment(\.dismiss) private var dismiss
    @State private var question = ""
    @State private var options = ["", ""]
    @State private var multiple = false
    let onSend: (String, [String], Bool) -> Void
    private var cleanOptions: [String] { options.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    private var valid: Bool { !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && cleanOptions.count >= 2 && cleanOptions.count <= 10 && question.count <= 300 && cleanOptions.allSatisfy { $0.count <= 100 } }
    var body: some View {
        NavigationStack {
            Form {
                Section("Question") { TextField("Ask a question", text: $question, axis: .vertical).lineLimit(2...4) }
                Section("Options") {
                    ForEach(options.indices, id: \.self) { index in
                        HStack { TextField("Option \(index + 1)", text: $options[index]); if options.count > 2 { Button(role: .destructive) { options.remove(at: index) } label: { Image(systemName: "minus.circle") } } }
                    }
                    if options.count < 10 { Button("Add option", systemImage: "plus") { options.append("") } }
                }
                Section { Toggle("Allow multiple selections", isOn: $multiple) }
                Section { Button("Post poll") { onSend(question.trimmingCharacters(in: .whitespacesAndNewlines), cleanOptions, multiple); dismiss() }.disabled(!valid) }
            }
            .navigationTitle("Create poll")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() } } }
        }
    }
}

struct NativeInviteJoinView: View {
    @ObservedObject var auth: AuthStore
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var preview: Record?
    @State private var errorMessage: String?
    @State private var busy = false
    private var code: String {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URLComponents(string: value), let invite = url.path.split(separator: "/").last, url.path.contains("/invite/") { return String(invite) }
        if value.hasPrefix("/invite/") { return String(value.dropFirst("/invite/".count)).split(separator: "?").first.map(String.init) ?? "" }
        return value
    }
    private var mayJoin: Bool { preview != nil && !preview!.flag("expired") && !preview!.flag("banned") && !busy }
    var body: some View {
        NavigationStack {
            Form {
                Section("Invite") {
                    TextField("Invite code or link", text: $input).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).onChange(of: input) { _, _ in preview = nil; errorMessage = nil }
                    Button("Preview server") { Task { await loadPreview() } }.disabled(busy || code.isEmpty)
                }
                if let preview {
                    let server = preview.object("server")
                    Section("Server preview") {
                        HStack(spacing: 12) {
                            ProfileAvatar(auth: auth, path: server["iconUrl"] as? String, name: server.text("name"), size: 56)
                            VStack(alignment: .leading, spacing: 4) { Text(server.text("name")).font(.headline); Text(server.text("description")).font(.subheadline).foregroundStyle(.secondary) }
                        }
                        LabeledContent("Members", value: "\(server.number("memberCount"))")
                        LabeledContent("Online now", value: "\(server.number("onlineCount"))")
                        if preview.flag("alreadyMember") { Label("You’re already a member", systemImage: "checkmark.circle").foregroundStyle(.green) }
                        if preview.flag("expired") { Label("This invite has expired or reached its use limit", systemImage: "clock.badge.exclamationmark").foregroundStyle(.red) }
                        if preview.flag("banned") { Label("You can’t join this server", systemImage: "hand.raised.fill").foregroundStyle(.red) }
                        if mayJoin { Button("Join server") { Task { await join() } }.frame(maxWidth: .infinity) }
                    }
                }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
            }
            .navigationTitle("Join a server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
    private func loadPreview() async {
        guard (6...32).contains(code.count), code.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else { errorMessage = "Enter a valid Glean invite code or link."; return }
        busy = true; defer { busy = false }
        do { preview = try await auth.request("api/invites/\(code)"); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
    }
    private func join() async {
        busy = true; defer { busy = false }
        do { _ = try await auth.request("api/invites/\(code)/join", body: [:]); auth.revision += 1; dismiss() }
        catch { errorMessage = error.localizedDescription }
    }
}

private struct NativeGif: Identifiable {
    let id: String
    let title: String
    let previewURL: URL
}

struct NativeGifPicker: View {
    @ObservedObject var auth: AuthStore
    let onPick: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var gifs: [NativeGif] = []
    @State private var nextOffset = 0
    @State private var hasMore = false
    @State private var loading = false
    @State private var downloadingID: String?
    @State private var downloadTask: Task<Void, Never>?
    @State private var error: String?
    private let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

    var body: some View {
        NavigationStack {
            ScrollView {
                if loading && gifs.isEmpty {
                    ProgressView("Searching GIFs…").padding(.top, 40)
                } else if gifs.isEmpty, let error {
                    ContentUnavailableView {
                        Label("GIF search unavailable", systemImage: "wifi.exclamationmark")
                    } description: { Text(error) } actions: { Button("Try again") { Task { await search(query, offset: 0) } } }
                } else if gifs.isEmpty {
                    ContentUnavailableView("Search GIPHY", systemImage: "sparkles", description: Text("Find an animated GIF to attach."))
                } else {
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(gifs) { gif in
                            Button { beginDownload(gif) } label: {
                                ZStack(alignment: .bottom) {
                                    AsyncImage(url: gif.previewURL) { phase in
                                        if let image = phase.image { image.resizable().scaledToFill() }
                                        else if phase.error != nil { Image(systemName: "photo").foregroundStyle(.secondary) }
                                        else { ProgressView() }
                                    }
                                    .frame(maxWidth: .infinity).frame(height: 150).clipped()
                                    LinearGradient(colors: [.clear, .black.opacity(0.65)], startPoint: .center, endPoint: .bottom)
                                    Text(gif.title).font(.caption.weight(.medium)).foregroundStyle(.white)
                                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading).padding(8)
                                    if downloadingID == gif.id { ProgressView().tint(.white).padding(10).frame(maxWidth: .infinity, maxHeight: .infinity).background(.black.opacity(0.35)) }
                                }
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .disabled(downloadingID != nil)
                            .accessibilityLabel("Attach GIF: \(gif.title)")
                        }
                    }
                    .padding(12)
                    if loading { ProgressView().padding() }
                    if hasMore {
                        Button("Load more GIFs") { Task { await search(query, offset: nextOffset) } }
                            .buttonStyle(.bordered).padding(.bottom, 16)
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal, 16) }
                }
            }
            .searchable(text: $query, prompt: "Search GIPHY")
            .navigationTitle("Choose a GIF")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() }.disabled(downloadTask != nil) } }
            .task(id: query) {
                gifs = []; nextOffset = 0; hasMore = false; error = nil
                let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !term.isEmpty else { return }
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await search(term, offset: 0)
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(downloadTask != nil)
        .onDisappear { downloadTask?.cancel() }
    }

    private func search(_ term: String, offset: Int) async {
        guard !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            var components = URLComponents()
            components.queryItems = [URLQueryItem(name: "q", value: term), URLQueryItem(name: "offset", value: String(offset))]
            let path = "api/gifs/search?\(components.percentEncodedQuery ?? "")"
            let result = try await auth.request(path)
            guard !Task.isCancelled else { return }
            let found = result.records("gifs").compactMap { item -> NativeGif? in
                guard let id = item["id"] as? String, !id.isEmpty,
                      let preview = URL(string: item.text("previewUrl")), preview.scheme == "https" else { return nil }
                return NativeGif(id: id, title: item.text("title").isEmpty ? "GIF" : item.text("title"), previewURL: preview)
            }
            if offset == 0 { gifs = found }
            else {
                let existing = Set(gifs.map(\.id))
                gifs += found.filter { !existing.contains($0.id) }
            }
            nextOffset = result.number("nextOffset")
            hasMore = result.flag("hasMore")
        } catch is CancellationError {
            return
        } catch {
            if offset == 0 { gifs = [] }
            hasMore = false
            self.error = error.localizedDescription
        }
    }

    private func beginDownload(_ gif: NativeGif) {
        guard downloadTask == nil else { return }
        downloadingID = gif.id
        downloadTask = Task { await download(gif) }
    }

    private func download(_ gif: NativeGif) async {
        defer { downloadingID = nil; downloadTask = nil }
        do {
            var components = URLComponents()
            components.queryItems = [URLQueryItem(name: "id", value: gif.id)]
            let source = try await auth.media("api/gifs/download?\(components.percentEncodedQuery ?? "")")
            guard !Task.isCancelled else { try? FileManager.default.removeItem(at: source); return }
            let destination = FileManager.default.temporaryDirectory.appendingPathComponent("giphy-\(UUID().uuidString).gif")
            try FileManager.default.moveItem(at: source, to: destination)
            guard !Task.isCancelled else { try? FileManager.default.removeItem(at: destination); return }
            onPick(destination)
            dismiss()
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
}
