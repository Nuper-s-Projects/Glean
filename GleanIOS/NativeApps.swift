import SwiftUI
import Combine

@MainActor
final class NativeAppsStore: ObservableObject {
    let auth: AuthStore
    let scopeKey: String
    @Published private(set) var session: Record?
    @Published private(set) var loading = false
    @Published private(set) var appID: String?
    @Published private(set) var joined = false
    @Published private(set) var snapshot: Record?
    @Published var gameState: Record?
    @Published var error: String?
    let boardEvents = PassthroughSubject<Record, Never>()
    private var subscription: AnyCancellable?

    init(auth: AuthStore, scopeKey: String) {
        self.auth = auth
        self.scopeKey = scopeKey
        subscription = auth.realtimeEvents.sink { [weak self] event in
            Task { @MainActor [weak self] in self?.receive(event) }
        }
    }

    var isHost: Bool { session?.number("hostId") == auth.account.number("id") }

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            let encoded = scopeKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            let result = try await auth.request("api/apps/session?scopeKey=\(encoded)")
            session = result["session"] as? Record
        } catch let failure { error = failure.localizedDescription }
    }

    func start(_ app: String) { send("app-start", ["appId": app]) }
    func join() { send("app-join", [:]) }
    func leave() { send("app-leave", [:]) }
    func end() { send("app-end", [:]) }
    func sendOp(_ operation: Record) { send("app-event", ["op": operation]) }

    private func send(_ event: String, _ payload: Record) {
        error = nil
        var packet = payload
        packet["scopeKey"] = scopeKey
        Task {
            do { try await auth.sendRealtime(event, payload: packet) }
            catch { self.error = error.localizedDescription }
        }
    }

    private func receive(_ event: NativeRealtimeEvent) {
        guard event.payload.text("scopeKey") == scopeKey else { return }
        switch event.event {
        case "app-session", "app-presence":
            session = event.payload["session"] as? Record
            if session == nil { clearJoinedState() }
        case "app-ready":
            appID = event.payload.text("appId")
            session = event.payload["session"] as? Record
            snapshot = event.payload["snapshot"] as? Record
            gameState = event.payload["state"] as? Record
            joined = true
            error = nil
        case "app-state":
            gameState = event.payload["state"] as? Record
        case "app-event":
            if let operation = event.payload["op"] as? Record { boardEvents.send(operation) }
        case "app-closed":
            clearJoinedState()
            if event.payload.text("reason") != "left" { session = nil }
        case "app-error":
            error = event.payload.text("error").isEmpty ? "That app could not start." : event.payload.text("error")
        default: break
        }
    }

    private func clearJoinedState() {
        joined = false
        appID = nil
        snapshot = nil
        gameState = nil
    }
}

struct NativeAppsShelfView: View {
    @ObservedObject var apps: NativeAppsStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if apps.joined, apps.appID == "whiteboard" {
                    NativeWhiteboardView(apps: apps)
                } else if apps.joined, apps.appID == "gartic" {
                    NativeGarticView(apps: apps)
                } else {
                    appList
                }
            }
            .navigationTitle(apps.joined ? (apps.appID == "gartic" ? "Gartic Phone" : "Whiteboard") : "Apps")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
                if apps.joined {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("Leave app", systemImage: "rectangle.portrait.and.arrow.right") { apps.leave() }
                            if apps.isHost {
                                Button("End for everyone", systemImage: "xmark.circle", role: .destructive) { apps.end() }
                            }
                        } label: { Image(systemName: "ellipsis.circle") }
                    }
                }
            }
            .task { await apps.refresh() }
        }
    }

    private var appList: some View {
        List {
            if let error = apps.error {
                Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
            }
            if let session = apps.session {
                Section("Live now") {
                    HStack(spacing: 12) {
                        appIcon(session.text("appId"))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.text("appName")).font(.headline)
                            Text("\(session.number("participantCount")) in the app")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Join") { apps.join() }.buttonStyle(.borderedProminent)
                    }.padding(.vertical, 5)
                }
            }
            Section("Available apps") {
                if apps.loading {
                    HStack(spacing: 10) { ProgressView(); Text("Checking for an active app…").font(.subheadline).foregroundStyle(.secondary) }
                }
                appRow(id: "whiteboard", title: "Whiteboard", detail: "Draw and sketch together.", icon: "pencil.and.outline", color: GleanStyle.blue)
                appRow(id: "gartic", title: "Gartic Phone", detail: "Write, draw, and reveal a chain of surprises.", icon: "scribble.variable", color: Color(hex: "#E8A126"))
            }
            Section {
                Text("Apps are shared with people in this voice call. Leaving an app keeps you in voice.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private func appRow(id: String, title: String, detail: String, icon: String, color: Color) -> some View {
        HStack(spacing: 12) {
            appIcon(id, icon: icon, color: color)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
                Button("Start") { apps.start(id) }
                .buttonStyle(.bordered)
                .disabled(apps.session != nil || apps.loading)
        }.padding(.vertical, 5)
    }

    private func appIcon(_ id: String, icon: String? = nil, color: Color? = nil) -> some View {
        Image(systemName: icon ?? (id == "gartic" ? "scribble.variable" : "pencil.and.outline"))
            .font(.title3.weight(.semibold))
            .foregroundStyle(color ?? (id == "gartic" ? Color(hex: "#E8A126") : GleanStyle.blue))
            .frame(width: 46, height: 46)
            .background((color ?? (id == "gartic" ? Color(hex: "#E8A126") : GleanStyle.blue)).opacity(0.13), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct NativeBoardStroke: Identifiable {
    var id: String
    var color: String
    var width: Double
    var points: [Double]
}

private func boardStrokes(_ records: [Record]) -> [NativeBoardStroke] {
    records.compactMap { item in
        guard item.text("kind") == "stroke", !item.text("uid").isEmpty else { return nil }
        let points = (item["points"] as? [NSNumber])?.map(\.doubleValue) ?? (item["points"] as? [Double] ?? [])
        guard points.count >= 2 else { return nil }
        return NativeBoardStroke(id: item.text("uid"), color: item.text("color").isEmpty ? "#F7FBFF" : item.text("color"), width: Double(item.number("width") > 0 ? item.number("width") : 5), points: points)
    }
}

private struct NativeDrawingCanvas: View {
    let strokes: [NativeBoardStroke]
    var body: some View {
        Canvas { context, size in
            let sx = size.width / 1000
            let sy = size.height / 700
            for stroke in strokes {
                var path = Path()
                let points = stride(from: 0, to: stroke.points.count - 1, by: 2).map { index in
                    CGPoint(x: stroke.points[index] * sx, y: stroke.points[index + 1] * sy)
                }
                guard let first = points.first else { continue }
                if points.count == 1 {
                    let radius = max(1, stroke.width / 2)
                    context.fill(Path(ellipseIn: CGRect(x: first.x - radius, y: first.y - radius, width: radius * 2, height: radius * 2)), with: .color(Color(hex: stroke.color)))
                    continue
                }
                path.move(to: first)
                points.dropFirst().forEach { path.addLine(to: $0) }
                context.stroke(path, with: .color(Color(hex: stroke.color)), style: StrokeStyle(lineWidth: stroke.width, lineCap: .round, lineJoin: .round))
            }
        }
    }
}

private struct NativeSketchPad: View {
    @Binding var strokes: [NativeBoardStroke]
    @State private var activeStroke: String?
    @State private var color = "#249CFF"
    @State private var width = 6.0
    @State private var pendingPoints: [Double] = []
    var onStrokeChunk: ((String, [Double]) -> Void)?
    var onStrokeStart: ((NativeBoardStroke) -> Void)?
    var onClear: (() -> Void)?
    private let palette = ["#F7FBFF", "#249CFF", "#5CE1A6", "#F0A202", "#FF6B81", "#B388FF", "#0C1018"]

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                ForEach(palette, id: \.self) { item in
                    Button { color = item } label: {
                        Circle().fill(Color(hex: item)).frame(width: 26, height: 26)
                            .overlay(Circle().strokeBorder(color == item ? GleanStyle.blue : Color.primary.opacity(0.2), lineWidth: color == item ? 3 : 1))
                    }.buttonStyle(.plain).accessibilityLabel("Use \(item) pencil")
                }
                Spacer(minLength: 0)
                Button(role: .destructive) { strokes.removeAll(); onClear?() } label: { Image(systemName: "trash") }
                    .accessibilityLabel("Clear drawing")
            }
            HStack {
                Label("Brush", systemImage: "circle.lefthalf.filled").font(.caption)
                Slider(value: $width, in: 2...22, step: 1).accessibilityLabel("Brush size")
            }
            GeometryReader { geometry in
                NativeDrawingCanvas(strokes: strokes)
                    .background(Color(uiColor: .secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { value in addPoint(value.location, size: geometry.size) }
                        .onEnded { _ in finishStroke() })
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.primary.opacity(0.1)))
            }
            .frame(minHeight: 250)
            .accessibilityLabel("Shared drawing canvas")
        }
        .padding(14)
    }

    private func addPoint(_ location: CGPoint, size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        let x = min(1000, max(0, location.x / size.width * 1000))
        let y = min(700, max(0, location.y / size.height * 700))
        if activeStroke == nil {
            let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            let first = NativeBoardStroke(id: id, color: color, width: width, points: [x, y])
            activeStroke = id
            strokes.append(first)
            onStrokeStart?(first)
            return
        }
        guard let id = activeStroke, let index = strokes.firstIndex(where: { $0.id == id }) else { return }
        strokes[index].points.append(contentsOf: [x, y])
        pendingPoints.append(contentsOf: [x, y])
        if pendingPoints.count >= 96 { flushPending(id) }
    }

    private func finishStroke() {
        if let activeStroke { flushPending(activeStroke) }
        activeStroke = nil
    }

    private func flushPending(_ id: String) {
        guard !pendingPoints.isEmpty else { return }
        let points = pendingPoints
        pendingPoints.removeAll(keepingCapacity: true)
        onStrokeChunk?(id, points)
    }
}

private struct NativeWhiteboardView: View {
    @ObservedObject var apps: NativeAppsStore
    @State private var strokes: [NativeBoardStroke] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = apps.error { Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal, 14) }
            NativeSketchPad(strokes: $strokes, onStrokeChunk: { uid, points in
                apps.sendOp(["type": "stroke", "uid": uid, "points": points])
            }, onStrokeStart: { stroke in
                apps.sendOp(["type": "add", "object": ["uid": stroke.id, "kind": "stroke", "color": stroke.color, "width": Int(stroke.width), "points": stroke.points]])
            }, onClear: { apps.sendOp(["type": "clear"]) })
        }
        .onReceive(apps.boardEvents) { apply($0) }
        .onChange(of: apps.snapshot != nil) { _, ready in if ready { strokes = boardStrokes(apps.snapshot?.records("objects") ?? []) } }
        .onAppear { strokes = boardStrokes(apps.snapshot?.records("objects") ?? []) }
    }

    private func apply(_ operation: Record) {
        switch operation.text("type") {
        case "add":
            guard let object = operation["object"] as? Record else { return }
            let new = boardStrokes([object])
            if let stroke = new.first, !strokes.contains(where: { $0.id == stroke.id }) { strokes.append(stroke) }
        case "stroke":
            let id = operation.text("uid")
            let chunk = (operation["points"] as? [NSNumber])?.map(\.doubleValue) ?? (operation["points"] as? [Double] ?? [])
            if let index = strokes.firstIndex(where: { $0.id == id }) { strokes[index].points.append(contentsOf: chunk) }
        case "delete": strokes.removeAll { $0.id == operation.text("uid") }
        case "clear": strokes.removeAll()
        default: break
        }
    }
}

private struct NativeGarticView: View {
    @ObservedObject var apps: NativeAppsStore
    @State private var mode = "normal"
    @State private var seconds = 60
    @State private var answer = ""
    @State private var strokes: [NativeBoardStroke] = []
    @State private var sending = false

    private var game: Record { apps.gameState ?? [:] }
    private var task: Record { game.object("task") }
    private let modes = ["normal", "secret", "knockoff", "complement"]
    private let timers = [30, 45, 60, 90, 120]

    var body: some View {
        Group {
            if game.text("phase") == "reveal" {
                revealView
            } else if ["write", "draw", "guess"].contains(game.text("phase")), !task.isEmpty {
                roundView
            } else {
                lobbyView
            }
        }
        .padding(.horizontal, 14)
        .overlay(alignment: .top) {
            if let error = apps.error { Text(error).font(.footnote).foregroundStyle(.red).padding(8).frame(maxWidth: .infinity, alignment: .leading) }
        }
        .onChange(of: game.text("phase") + game.text("round")) { _, _ in answer = ""; strokes = [] }
    }

    private var lobbyView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Label("Gartic Phone", systemImage: "scribble.variable").font(.title2.bold())
                Text("Write, draw, and watch each chain change as it passes around the call.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Text("Players · \(apps.session?.number("participantCount") ?? 0)").font(.headline)
                ForEach(apps.session?.records("participants") ?? [], id: \.channelID) { player in
                    HStack(spacing: 10) {
                        ProfileAvatarLink(auth: apps.auth, path: player["avatarUrl"] as? String, username: player.text("username"), size: 34)
                        Text(player.text("username"))
                        Spacer()
                    }
                }
                if apps.isHost {
                    Picker("Mode", selection: $mode) {
                        Text("Normal").tag("normal"); Text("Secret").tag("secret")
                        Text("Knock-Off").tag("knockoff"); Text("Complement").tag("complement")
                    }
                    Picker("Round time", selection: $seconds) { ForEach(timers, id: \.self) { Text("\($0) seconds").tag($0) } }
                    Button { apps.sendOp(["type": "start", "mode": mode, "seconds": seconds]) } label: {
                        Label("Start game", systemImage: "play.fill").frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled((apps.session?.number("participantCount") ?? 0) < 2)
                    if (apps.session?.number("participantCount") ?? 0) < 2 { Text("At least two players are needed.").font(.caption).foregroundStyle(.secondary) }
                } else {
                    Text("Waiting for the host to start a game.").font(.subheadline).foregroundStyle(.secondary)
                }
            }.padding(.vertical, 18)
        }
    }

    private var roundView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.text("kind") == "write" ? "Write a prompt" : task.text("kind") == "guess" ? "What is this?" : "Draw").font(.headline)
                    Text("Round \(game.number("round") + 1) of \(game.number("totalRounds")) · \(game.text("modeLabel"))").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let deadline = game["deadline"] as? NSNumber {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let left = max(0, Int((deadline.doubleValue / 1000 - context.date.timeIntervalSince1970).rounded(.up)))
                        Text("\(left)s").font(.title3.monospacedDigit().bold()).foregroundStyle(left <= 5 ? .red : GleanStyle.blue)
                    }
                }
            }
            referenceDrawing
            if task.flag("submitted") {
                ContentUnavailableView("Answer sent", systemImage: "checkmark.circle", description: Text("Waiting for everyone else to finish this round."))
            } else if task.text("kind") == "draw" {
                NativeSketchPad(strokes: $strokes)
                submitButton(content: drawingPayload)
            } else {
                TextField(task.text("kind") == "write" ? "Write your prompt" : "Describe what you see", text: $answer, axis: .vertical)
                    .lineLimit(3...7).textFieldStyle(.roundedBorder)
                submitButton(content: answer.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }.padding(.vertical, 12)
    }

    @ViewBuilder private var referenceDrawing: some View {
        let raw = task.text("reference").isEmpty ? task.text("seed") : task.text("reference")
        if !raw.isEmpty, let data = raw.data(using: .utf8),
           let records = (try? JSONSerialization.jsonObject(with: data)) as? [Record] {
            NativeDrawingCanvas(strokes: boardStrokes(records)).frame(height: 190)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        } else if !task.text("prompt").isEmpty {
            Text(task.text("prompt")).font(.title3.weight(.semibold)).padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var drawingPayload: [[String: Any]] {
        strokes.map { ["color": $0.color, "width": Int($0.width), "points": $0.points] }
    }

    private func submitButton(content: Any) -> some View {
        Button { Task { await submit(content) } } label: {
            Group { if sending { ProgressView() } else { Label("Submit", systemImage: "paperplane.fill") } }
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .disabled(sending || ((content as? String)?.isEmpty == true) || (content as? [[String: Any]])?.isEmpty == true)
    }

    private func submit(_ content: Any) async {
        guard !sending else { return }
        sending = true
        defer { sending = false }
        do {
            let result = try await apps.auth.request("api/apps/gartic/submit", body: ["scopeKey": apps.scopeKey, "round": game.number("round"), "content": content])
            apps.gameState = result["state"] as? Record
            apps.error = nil
        } catch { apps.error = error.localizedDescription }
    }

    private var revealView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text("Reveal").font(.title2.bold()); Spacer(); Text("Chain \(game.number("revealIndex") + 1) of \(game.number("revealTotal"))").font(.caption).foregroundStyle(.secondary) }
                let books = game.records("books")
                let index = min(max(0, game.number("revealIndex")), max(0, books.count - 1))
                let pages = books.indices.contains(index) ? books[index].records("pages") : []
                ForEach(Array(pages.enumerated()), id: \.offset) { _, page in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(page.text("kind") == "draw" ? "Drawing" : "Prompt / guess").font(.caption.bold()).foregroundStyle(.secondary)
                        if page.text("kind") == "draw", let data = page.text("content").data(using: .utf8), let records = (try? JSONSerialization.jsonObject(with: data)) as? [Record] {
                            NativeDrawingCanvas(strokes: boardStrokes(records)).frame(height: 220)
                                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                        } else { Text(page.text("content")).font(.body).frame(maxWidth: .infinity, alignment: .leading) }
                        Text("By \(page.object("author").text("username"))").font(.caption).foregroundStyle(.secondary)
                    }.padding(12).background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
                }
                if apps.isHost {
                    if index < books.count - 1 {
                        Button("Next drawing") { apps.sendOp(["type": "reveal-next"]) }.buttonStyle(.borderedProminent)
                    } else {
                        Button("Back to lobby") { apps.sendOp(["type": "reset"]) }.buttonStyle(.borderedProminent)
                    }
                }
            }.padding(.vertical, 16)
        }
    }
}
