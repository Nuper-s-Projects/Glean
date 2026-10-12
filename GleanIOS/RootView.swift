import SwiftUI
import Security
import QuickLook
import AVKit
import ImageIO
import UniformTypeIdentifiers
import Combine
import PhotosUI
import CoreTransferable

private struct LibraryAttachment: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .data) { received in
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let destination = directory.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: destination)
            return LibraryAttachment(url: destination)
        }
    }
}

private extension View {
    @ViewBuilder func composerBar<Bar: View>(@ViewBuilder content: () -> Bar) -> some View {
        if #available(iOS 26.0, *) {
            self.safeAreaBar(edge: .bottom) {
                content().background { ComposerBackdrop() }
            }
                .scrollEdgeEffectStyle(.soft, for: .bottom)
        } else {
            self.safeAreaInset(edge: .bottom) {
                content().background { ComposerBackdrop() }
            }
        }
    }
}

private struct ComposerBackdrop: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        Rectangle()
            .fill(.thinMaterial)
            .overlay(Color(uiColor: .systemBackground).opacity(reduceTransparency ? 1 : 0.06))
            .mask(LinearGradient(stops: [
                .init(color: .clear, location: 0),
                .init(color: .black.opacity(0.2), location: 0.35),
                .init(color: .black, location: 0.85)
            ], startPoint: .top, endPoint: .bottom))
            .opacity(reduceTransparency ? 1 : 0.55)
            .padding(.top, -32)
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
    }
}

private struct DarkComposerGlass: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @ViewBuilder func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(white: 0.08), in: RoundedRectangle(cornerRadius: 28))
        } else if #available(iOS 26.0, *) {
            content.glassEffect(.regular.tint(.black.opacity(0.4)), in: .rect(cornerRadius: 28))
        } else {
            content.background {
                RoundedRectangle(cornerRadius: 28).fill(.ultraThinMaterial)
                    .overlay(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 28))
            }
        }
    }
}

private struct ChatBottomTracker: ViewModifier {
    @Binding var nearBottom: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 80
            } action: { _, value in nearBottom = value }
        } else {
            content.onAppear { nearBottom = false }
        }
    }
}

private struct ComposerAttachmentPreview: View {
    let file: URL
    let open: () -> Void
    let remove: () -> Void
    @State private var thumbnail: UIImage?
    private var isVideo: Bool { UTType(filenameExtension: file.pathExtension)?.conforms(to: .movie) == true }

    var body: some View {
        Button(action: open) {
            ZStack {
                RoundedRectangle(cornerRadius: 14).fill(.quaternary)
                if let thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    VStack(spacing: 4) {
                        Image(systemName: isVideo ? "video" : "doc")
                        Text(file.lastPathComponent).font(.caption2).lineLimit(2)
                    }.padding(8)
                }
                if isVideo {
                    Image(systemName: "play.fill").font(.caption.bold())
                        .foregroundStyle(.white).padding(10).background(.black.opacity(0.55), in: Circle())
                }
            }
            .frame(width: 88, height: 76).clipped()
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Preview \(file.lastPathComponent)")
        .overlay(alignment: .topTrailing) {
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.75)).font(.system(size: 20))
                    .frame(width: 44, height: 44)
            }.buttonStyle(.plain).accessibilityLabel("Remove \(file.lastPathComponent)")
        }
        .task(id: file) {
            let image = await Task.detached(priority: .utility) { () -> UIImage? in
                let scoped = file.startAccessingSecurityScopedResource()
                defer { if scoped { file.stopAccessingSecurityScopedResource() } }
                if UTType(filenameExtension: file.pathExtension)?.conforms(to: .movie) == true {
                    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
                    generator.appliesPreferredTrackTransform = true
                    generator.maximumSize = CGSize(width: 264, height: 228)
                    guard let result = try? await generator.image(at: .zero) else { return nil }
                    return UIImage(cgImage: result.image)
                }
                guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 264
                      ] as CFDictionary) else { return nil }
                return UIImage(cgImage: image)
            }.value
            guard !Task.isCancelled else { return }
            thumbnail = image
        }
    }
}

struct NativeRealtimeEvent: Identifiable {
    let id = UUID()
    let event: String
    let payload: Record
}

enum NativeAccessState: Equatable {
    case checking
    case available
    case blocked(nextOpenAt: Date?)
    case offline
}

enum GleanStyle {
    static let blue = Color(red: 0.03, green: 0.53, blue: 0.94)
    static let ink = Color(red: 0.035, green: 0.075, blue: 0.12)
    static let panel = Color(uiColor: .secondarySystemGroupedBackground)
}

struct GleanGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        // Lexend Regular “G” outline, normalized and centered in a 128 × 128 view box.
        var path = Path()
        path.move(to: CGPoint(x: 66.99, y: 106.00))
        path.addQuadCurve(to: CGPoint(x: 50.33, y: 102.77), control: CGPoint(x: 58.08, y: 106.00))
        path.addQuadCurve(to: CGPoint(x: 36.72, y: 93.80), control: CGPoint(x: 42.59, y: 99.55))
        path.addQuadCurve(to: CGPoint(x: 27.63, y: 80.37), control: CGPoint(x: 30.86, y: 88.05))
        path.addQuadCurve(to: CGPoint(x: 24.41, y: 63.77), control: CGPoint(x: 24.41, y: 72.68))
        path.addQuadCurve(to: CGPoint(x: 27.63, y: 47.34), control: CGPoint(x: 24.41, y: 54.97))
        path.addQuadCurve(to: CGPoint(x: 36.66, y: 34.03), control: CGPoint(x: 30.86, y: 39.72))
        path.addQuadCurve(to: CGPoint(x: 50.22, y: 25.17), control: CGPoint(x: 42.47, y: 28.34))
        path.addQuadCurve(to: CGPoint(x: 66.87, y: 22.00), control: CGPoint(x: 57.96, y: 22.00))
        path.addQuadCurve(to: CGPoint(x: 79.02, y: 23.76), control: CGPoint(x: 73.09, y: 22.00))
        path.addQuadCurve(to: CGPoint(x: 89.75, y: 28.69), control: CGPoint(x: 84.94, y: 25.52))
        path.addQuadCurve(to: CGPoint(x: 97.61, y: 35.96), control: CGPoint(x: 94.56, y: 31.85))
        path.addLine(to: CGPoint(x: 89.40, y: 44.53))
        path.addQuadCurve(to: CGPoint(x: 66.87, y: 34.32), control: CGPoint(x: 78.72, y: 34.32))
        path.addQuadCurve(to: CGPoint(x: 51.86, y: 38.19), control: CGPoint(x: 58.54, y: 34.32))
        path.addQuadCurve(to: CGPoint(x: 41.24, y: 48.75), control: CGPoint(x: 45.17, y: 42.06))
        path.addQuadCurve(to: CGPoint(x: 37.31, y: 63.77), control: CGPoint(x: 37.31, y: 55.44))
        path.addQuadCurve(to: CGPoint(x: 39.66, y: 75.32), control: CGPoint(x: 37.31, y: 69.87))
        path.addQuadCurve(to: CGPoint(x: 46.17, y: 84.88), control: CGPoint(x: 42.00, y: 80.78))
        path.addQuadCurve(to: CGPoint(x: 55.79, y: 91.34), control: CGPoint(x: 50.33, y: 88.99))
        path.addQuadCurve(to: CGPoint(x: 67.34, y: 93.68), control: CGPoint(x: 61.24, y: 93.68))
        path.addQuadCurve(to: CGPoint(x: 78.66, y: 91.34), control: CGPoint(x: 73.56, y: 93.68))
        path.addQuadCurve(to: CGPoint(x: 86.88, y: 84.94), control: CGPoint(x: 83.77, y: 88.99))
        path.addQuadCurve(to: CGPoint(x: 89.99, y: 75.97), control: CGPoint(x: 89.99, y: 80.89))
        path.addLine(to: CGPoint(x: 89.99, y: 75.26))
        path.addLine(to: CGPoint(x: 66.64, y: 75.26))
        path.addLine(to: CGPoint(x: 66.64, y: 62.71))
        path.addLine(to: CGPoint(x: 103.01, y: 62.71))
        path.addQuadCurve(to: CGPoint(x: 103.48, y: 66.41), control: CGPoint(x: 103.36, y: 64.70))
        path.addQuadCurve(to: CGPoint(x: 103.59, y: 69.75), control: CGPoint(x: 103.59, y: 68.11))
        path.addQuadCurve(to: CGPoint(x: 98.73, y: 88.70), control: CGPoint(x: 103.59, y: 80.54))
        path.addQuadCurve(to: CGPoint(x: 85.53, y: 101.42), control: CGPoint(x: 93.86, y: 96.85))
        path.addQuadCurve(to: CGPoint(x: 66.99, y: 106.00), control: CGPoint(x: 77.20, y: 106.00))
        path.closeSubpath()
        let scaled = path.applying(CGAffineTransform(scaleX: rect.width / 128, y: rect.height / 128))
        return scaled.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    }
}

struct GleanLogoIcon: View {
    let size: CGFloat
    let cornerRadius: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).fill(GleanStyle.blue)
            GleanGlyph().fill(.white)
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Glean")
        .accessibilityAddTraits(.isImage)
    }
}

@MainActor
final class AuthStore: ObservableObject {
    @Published var username: String?
    @Published var busy = false
    @Published var error: String?
    @Published var revision = 0
    @Published var avatarPath: String?
    @Published var account: [String: Any] = [:]
    @Published var developerModeEnabled = UserDefaults.standard.bool(forKey: "glean.ios.developerMode")
    @Published private(set) var accessState: NativeAccessState = .checking
    @Published private(set) var diagnosticRequests = 0
    @Published private(set) var diagnosticUploadBytes: Int64 = 0
    @Published private(set) var diagnosticDownloadBytes: Int64 = 0
    @Published private(set) var diagnosticLastRequestMilliseconds: Double?
    @Published private(set) var diagnosticSocketState = "Disconnected"
    @Published private(set) var diagnosticSocketReceived = 0
    @Published private(set) var diagnosticSocketSent = 0
    @Published private(set) var diagnosticLastSocketActivity: Date?
    let realtimeEvents = PassthroughSubject<NativeRealtimeEvent, Never>()
    private var liveTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private let base = URL(string: "https://d3bdx5il6w3di0.cloudfront.net")!
    private var token: String?
    private let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.glean.ios", kSecAttrAccount as String: "session"]

    init() {
        var query = key
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data {
            token = String(data: data, encoding: .utf8)
        }
    }

    func request(_ path: String, body: [String: Any]? = nil, method: String? = nil, headers: [String: String] = [:]) async throws -> [String: Any] {
        let started = Date()
        let sessionToken = token
        var request = URLRequest(url: try resourceURL(path))
        recordRequestStarted()
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(base.absoluteString, forHTTPHeaderField: "Origin")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        if let method { request.httpMethod = method }
        let (data, response) = try await URLSession.shared.data(for: request)
        recordHTTP(downloaded: Int64(data.count), uploaded: Int64(request.httpBody?.count ?? 0), elapsed: Date().timeIntervalSince(started))
        let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "Glean", code: (response as? HTTPURLResponse)?.statusCode ?? 0, userInfo: [NSLocalizedDescriptionKey: payload["error"] as? String ?? "Glean is unavailable. Please try again later."])
        }
        if path != "api/auth/signin", path != "api/auth/signup", let record = payload["account"] as? [String: Any] { applyAccount(record) }
        if sessionToken == token, let username {
            GleanWidgetStore.ingest(path: path, payload: payload, username: username)
        }
        return payload
    }

    func refreshAccess() async {
        do {
            let payload = try await request("api/access/status")
            guard let available = payload["available"] as? Bool else {
                throw URLError(.cannotParseResponse)
            }
            if available {
                accessState = .available
            } else {
                let epoch = (payload["nextOpenAt"] as? NSNumber)?.doubleValue
                accessState = .blocked(nextOpenAt: epoch.map(Date.init(timeIntervalSince1970:)))
            }
        } catch {
            let failure = error as NSError
            if failure.domain == "Glean", failure.code == 503 {
                accessState = .offline
                return
            }
            // Do not lock users out because a status probe failed. Keep a known
            // blocked/offline state until a successful probe changes it.
            if accessState == .checking { accessState = .available }
        }
    }

    func applySchoolAccessBlock(nextOpenAt value: Any?) {
        let epoch = (value as? NSNumber)?.doubleValue
        accessState = .blocked(nextOpenAt: epoch.map(Date.init(timeIntervalSince1970:)))
    }

    func applyAccount(_ record: [String: Any]) {
        account = record
        username = record["username"] as? String
        avatarPath = record["avatarUrl"] as? String
        GleanWidgetStore.account(username)
    }

    func clearSession() {
        GleanWidgetStore.account(nil)
        GleanLiveCalls.shared.endAll()
        SecItemDelete(key as CFDictionary)
        token = nil
        account = [:]
        username = nil
        avatarPath = nil
        liveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        diagnosticSocketState = "Disconnected"
        setDeveloperModeEnabled(false)
    }

    func setDeveloperModeEnabled(_ enabled: Bool) {
        developerModeEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "glean.ios.developerMode")
        if enabled, let socket {
            diagnosticSocketState = socket.state == .running ? "Connected" : "Connecting"
        } else if !enabled {
            diagnosticSocketState = socket == nil ? "Disconnected" : "Disabled"
        }
        resetDiagnostics()
    }

    func resetDiagnostics() {
        diagnosticRequests = 0
        diagnosticUploadBytes = 0
        diagnosticDownloadBytes = 0
        diagnosticLastRequestMilliseconds = nil
        diagnosticSocketReceived = 0
        diagnosticSocketSent = 0
        diagnosticLastSocketActivity = nil
    }

    private func recordHTTP(downloaded: Int64 = 0, uploaded: Int64 = 0, elapsed: TimeInterval? = nil) {
        guard developerModeEnabled else { return }
        diagnosticDownloadBytes += max(0, downloaded)
        diagnosticUploadBytes += max(0, uploaded)
        if let elapsed { diagnosticLastRequestMilliseconds = elapsed * 1000 }
    }

    private func recordRequestStarted() {
        guard developerModeEnabled else { return }
        diagnosticRequests += 1
    }

    func resourceURL(_ path: String) throws -> URL {
        guard let url = URL(string: path, relativeTo: base.appendingPathComponent("/"))?.absoluteURL,
              url.scheme == "https", url.host == base.host else { throw URLError(.badURL) }
        return url
    }

    func media(_ path: String) async throws -> URL {
        let started = Date()
        guard let token else { throw URLError(.userAuthenticationRequired) }
        var request = URLRequest(url: try resourceURL(path))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let result = try await NativeMediaCache.shared.media(request: request, account: mediaCacheNamespace)
        if result.usedNetwork {
            recordRequestStarted()
            recordHTTP(downloaded: result.downloadedBytes, elapsed: Date().timeIntervalSince(started))
        }
        return result.file
    }

    var mediaCacheNamespace: String { "\(base.host ?? "")|\(account.number("id"))|\(username ?? "")" }

    func mediaPlayer(for path: String) throws -> AVPlayer {
        let url = try resourceURL(path)
        let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
        let options: [String: Any]? = cookies.isEmpty ? nil : [AVURLAssetHTTPCookiesKey: cookies]
        let asset = AVURLAsset(url: url, options: options)
        return AVPlayer(playerItem: AVPlayerItem(asset: asset))
    }

    func sendRealtime(_ event: String, payload: Record) async throws {
        guard let socket else { throw URLError(.networkConnectionLost) }
        let data = try JSONSerialization.data(withJSONObject: ["event": event, "payload": payload])
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
        if developerModeEnabled {
            diagnosticSocketSent += 1
            diagnosticUploadBytes += Int64(data.count)
            diagnosticLastSocketActivity = Date()
        }
    }

    func sendTyping(conversationID: Int, typing: Bool) async {
        guard !account.flag("keepInformationSecret") else { return }
        let payload: Record = ["conversationId": conversationID, "typing": typing]
        do {
            try await sendRealtime("typing", payload: payload)
        } catch {
            _ = try? await request("api/conversations/\(conversationID)/typing", body: ["typing": typing])
        }
    }

    func send(_ path: String, text: String, files: [URL], reply: Int?, fileField: String = "files", poll: Record? = nil, formFields: Record? = nil) async throws {
        if files.isEmpty {
            var body: Record = formFields ?? [:]
            if formFields == nil || !text.isEmpty { body["body"] = text }
            if let reply { body["replyToMessageId"] = String(reply) }
            if let poll { body["poll"] = poll }
            _ = try await request(path, body: body)
            return
        }
        let staged = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        FileManager.default.createFile(atPath: staged.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: staged) }
        let writer = try FileHandle(forWritingTo: staged)
        defer { try? writer.close() }
        let boundary = UUID().uuidString
        func write(_ value: String) throws { try writer.write(contentsOf: Data(value.utf8)) }
        var multipartFields = formFields ?? [:]
        if formFields == nil || !text.isEmpty { multipartFields["body"] = text }
        if let reply { try write("--\(boundary)\r\nContent-Disposition: form-data; name=\"replyToMessageId\"\r\n\r\n\(reply)\r\n") }
        if let poll { multipartFields["poll"] = poll }
        for (name, value) in multipartFields.sorted(by: { $0.key < $1.key }) {
            let string: String
            if let value = value as? String { string = value }
            else { let data = try JSONSerialization.data(withJSONObject: value); string = String(decoding: data, as: UTF8.self) }
            try write("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(string)\r\n")
        }
        var total: Int64 = 0
        for file in files {
            let accessible = file.startAccessingSecurityScopedResource()
            defer { if accessible { file.stopAccessingSecurityScopedResource() } }
            let name = file.lastPathComponent.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
            let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            try write("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(name)\"\r\nContent-Type: \(mime)\r\n\r\n")
            let reader = try FileHandle(forReadingFrom: file)
            defer { try? reader.close() }
            while let chunk = try reader.read(upToCount: 1024 * 1024), !chunk.isEmpty {
                try Task.checkCancellation()
                total += Int64(chunk.count)
                guard total <= 2 * 1024 * 1024 * 1024 else { throw NSError(domain: "Glean", code: 1, userInfo: [NSLocalizedDescriptionKey: "Attachments must total 2 GB or less."]) }
                try writer.write(contentsOf: chunk)
                await Task.yield()
            }
            try write("\r\n")
        }
        try write("--\(boundary)--\r\n")
        try writer.synchronize()
        var request = URLRequest(url: try resourceURL(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 600
        request.setValue(base.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let started = Date()
        recordRequestStarted()
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: staged)
        recordHTTP(downloaded: Int64(data.count), uploaded: total, elapsed: Date().timeIntervalSince(started))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw NSError(domain: "Glean", code: 1, userInfo: [NSLocalizedDescriptionKey: payload?["error"] as? String ?? "Upload failed. Try again."])
        }
        if let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let account = payload["account"] as? [String: Any] { applyAccount(account) }
    }

    func startLive() {
        liveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        liveTask = Task {
            var delay: UInt64 = 1
            while !Task.isCancelled, let token {
                if developerModeEnabled { diagnosticSocketState = "Connecting" }
                var request = URLRequest(url: URL(string: "wss://d3bdx5il6w3di0.cloudfront.net/api/realtime")!)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                let connection = URLSession.shared.webSocketTask(with: request)
                socket = connection
                connection.resume()
                do {
                    while !Task.isCancelled {
                        let frame = try await connection.receive()
                        let data: Data
                        switch frame { case .string(let text): data = Data(text.utf8); case .data(let bytes): data = bytes; @unknown default: continue }
                        let event = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["event"] as? String
                        let packet = (try? JSONSerialization.jsonObject(with: data)) as? Record ?? [:]
                        let payload = packet["payload"] as? Record ?? [:]
                        if developerModeEnabled {
                            diagnosticSocketState = "Connected"
                            diagnosticSocketReceived += 1
                            diagnosticDownloadBytes += Int64(data.count)
                            diagnosticLastSocketActivity = Date()
                        }
                        if let event, ["message", "channel-message", "server-updated", "dm-call-invite", "dm-call-accepted", "dm-call-ended", "dm-call-error", "dm-call-signal", "voice-presence", "voice-state", "voice-signal", "voice-error", "typing", "channel-typing", "app-session", "app-ready", "app-presence", "app-state", "app-event", "app-closed", "app-error", "platform-announcement-updated", "connected"].contains(event) {
                            realtimeEvents.send(NativeRealtimeEvent(event: event, payload: payload))
                        }
                        if event == "school-access-blocked" {
                            applySchoolAccessBlock(nextOpenAt: payload["nextOpenAt"])
                        }
                        if event == "connected" { delay = 1; revision += 1 }
                        else if ["message", "channel-message", "conversations", "servers", "server-updated"].contains(event ?? "") { revision += 1 }
                    }
                } catch {
                    if developerModeEnabled { diagnosticSocketState = Task.isCancelled ? "Disconnected" : "Reconnecting" }
                }
                connection.cancel(with: .goingAway, reason: nil)
                if Task.isCancelled { diagnosticSocketState = "Disconnected"; return }
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 30)
            }
        }
    }

    func restore() async {
        guard token != nil else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await request("api/auth/me")
            username = (result["account"] as? [String: Any])?["username"] as? String
            avatarPath = (result["account"] as? [String: Any])?["avatarUrl"] as? String
            startLive()
        } catch {
            if (error as NSError).domain == "Glean", (error as NSError).code == 401 {
                SecItemDelete(key as CFDictionary)
                token = nil
            }
            self.error = error.localizedDescription
        }
    }

    func signIn(_ name: String, password: String) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let result = try await request("api/auth/signin", body: ["username": name.trimmingCharacters(in: .whitespacesAndNewlines), "password": password])
            guard let accessToken = result["accessToken"] as? String, let account = result["account"] as? [String: Any], account["username"] is String else { throw URLError(.cannotParseResponse) }
            try storeSession(accessToken, account: account)
            if (account["username"] as? String)?.lowercased() == "nuper" { try await NativeE2EE.restoreProfileKeyBackup(auth: self, password: password) }
        } catch { self.error = error.localizedDescription }
    }

    func signUp(_ name: String, password: String, grade: String, school: String) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            var body: [String: Any] = ["username": name.trimmingCharacters(in: .whitespacesAndNewlines), "password": password]
            if grade != "no_response" { body["grade"] = grade }
            if school != "no_response" { body["school"] = school }
            let result = try await request("api/auth/signup", body: body)
            guard let accessToken = result["accessToken"] as? String, let account = result["account"] as? [String: Any] else { throw URLError(.cannotParseResponse) }
            try storeSession(accessToken, account: account)
            if (account["username"] as? String)?.lowercased() == "nuper" { try await NativeE2EE.restoreProfileKeyBackup(auth: self, password: password) }
        } catch { self.error = error.localizedDescription }
    }

    private func storeSession(_ accessToken: String, account: [String: Any]) throws {
        SecItemDelete(key as CFDictionary)
        var item = key
        item[kSecValueData as String] = Data(accessToken.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw NSError(domain: "Glean", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not securely save your session."]) }
        token = accessToken
        applyAccount(account)
        startLive()
    }

    func signOut() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await request("api/auth/signout", body: [:])
            clearSession()
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct RootView: View {
    @State private var selection: AppSection = .messages
    @StateObject private var auth = AuthStore()
    @StateObject private var calls = NativeCallCoordinator()
    @State private var login = ""
    @State private var password = ""
    @FocusState private var focusedField: LoginField?
    @State private var agreement: Record?
    @State private var announcement: Record?
    @State private var showAnnouncementProfile = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if auth.accessState == .checking {
                ProgressView("Checking Glean availability…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(uiColor: .systemGroupedBackground))
            } else if case .blocked(let nextOpenAt) = auth.accessState {
                NativeAvailabilityView(auth: auth, nextOpenAt: nextOpenAt, onCheck: refreshAccess)
            } else if auth.accessState == .offline {
                NativeAvailabilityView(auth: auth, nextOpenAt: nil, offline: true, onCheck: refreshAccess)
            } else if auth.username == nil {
                signInView
            } else {
                TabView(selection: $selection) {
                    NavigationStack { RemoteListView(auth: auth, kind: .conversations) }
                        .tabItem { Label("Messages", systemImage: "bubble.left.and.bubble.right.fill") }
                        .tag(AppSection.messages)
                    NavigationStack { RemoteListView(auth: auth, kind: .servers) }
                        .tabItem { Label("Servers", systemImage: "person.3.fill") }
                        .tag(AppSection.servers)
                    NavigationStack { AccountSettingsView(auth: auth) }
                        .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                        .tag(AppSection.settings)
                }
                .environmentObject(calls)
                .toolbarBackground(.visible, for: .tabBar)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if let announcement, announcement.flag("enabled") {
                        NativePlatformAnnouncementBanner(auth: auth, announcement: announcement) {
                            showAnnouncementProfile = true
                        }
                    }
                }
                .overlay(alignment: .bottom) {
                    if calls.status != .idle || calls.error != nil {
                        NativeCallBanner(calls: calls).padding(.bottom, 64).zIndex(10)
                    }
                }
                .fullScreenCover(isPresented: Binding(get: { agreement != nil }, set: { if !$0 { agreement = nil } })) {
                    if let agreement { NativeAgreementView(auth: auth, agreement: agreement) { self.agreement = nil } }
                }
                .sheet(isPresented: $showAnnouncementProfile) {
                    NavigationStack {
                        NativeProfileView(auth: auth, username: announcementProfileName)
                    }
                }
                .onReceive(auth.realtimeEvents) { event in
                    if event.event == "platform-announcement-updated" {
                        withAnimation(.easeOut(duration: 0.2)) { announcement = event.payload }
                    } else if event.event == "connected" {
                        Task { await loadAnnouncement() }
                    }
                }
            }
        }
        .tint(GleanStyle.blue)
        .gleanAppAppearance()
        .onOpenURL { url in
            guard let route = GleanWidgetRoute.parse(url) else { return }
            switch route {
            case .messages: selection = .messages
            case .servers: selection = .servers
            case .settings: selection = .settings
            case .call: break // Preserve the current voice room or call screen.
            }
        }
        .preferredColorScheme(theme == "dark" ? .dark : theme == "light" ? .light : nil)
        .contrast(Double((auth.account["accessibility"] as? [String: Any])?["contrast"] as? Int ?? 100) / 100)
        .saturation(Double((auth.account["accessibility"] as? [String: Any])?["saturation"] as? Int ?? 100) / 100)
        .task {
            await refreshAccess()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                await refreshAccess()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            GleanLiveCalls.shared.refresh()
            Task { await refreshAccess(); await loadAnnouncement() }
        }
        .task(id: auth.username) {
            if auth.username != nil {
                calls.bind(auth: auth)
                await checkAgreement()
                await loadAnnouncement()
                _ = try? await auth.request("api/conversations")
                _ = try? await auth.request("api/servers")
            } else {
                announcement = nil
                calls.hangup()
            }
        }
    }
    private var theme: String { (auth.account["accessibility"] as? [String: Any])?["theme"] as? String ?? "system" }
    private var announcementProfileName: String {
        let name = announcement?.object("profile").text("username") ?? ""
        return name.isEmpty ? "Nuper" : name
    }

    private func refreshAccess() async {
        let wasAvailable = auth.accessState == .available
        await auth.refreshAccess()
        guard !wasAvailable, auth.accessState == .available else { return }
        if auth.username == nil { await auth.restore() }
        else { auth.startLive() }
    }

    private func loadAnnouncement() async {
        guard auth.username != nil else { return }
        do { announcement = try await auth.request("api/announcement") }
        catch { /* Keep the last live announcement if a refresh is temporarily unavailable. */ }
    }

    private var signInView: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 14) {
                        GleanLogoIcon(size: 64, cornerRadius: 19)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Welcome to Glean")
                                .font(.largeTitle.bold())
                                .minimumScaleFactor(0.8)
                                .lineLimit(1)
                            Text("Sign in to continue to your account.")
                                .font(.body)
                                .foregroundStyle(.secondary)
                        }
                    }
                    VStack(spacing: 16) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Username or email").font(.subheadline.weight(.semibold))
                            TextField("Enter your username or email", text: $login)
                                .textContentType(.username)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.emailAddress)
                                .submitLabel(.next)
                                .focused($focusedField, equals: .username)
                                .onSubmit { focusedField = .password }
                                .padding(.horizontal, 15)
                                .frame(minHeight: 54)
                                .gleanInputSurface()
                                .accessibilityIdentifier("login-username")
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Password").font(.subheadline.weight(.semibold))
                            SecureField("Enter your password", text: $password)
                                .textContentType(.password)
                                .submitLabel(.go)
                                .focused($focusedField, equals: .password)
                                .onSubmit { submitSignIn() }
                                .padding(.horizontal, 15)
                                .frame(minHeight: 54)
                                .gleanInputSurface()
                                .accessibilityIdentifier("login-password")
                        }
                    }
                    if let error = auth.error {
                        GleanFeedback(message: error, failed: true)
                    }
                    Button(action: submitSignIn) {
                        HStack(spacing: 10) {
                            if auth.busy { ProgressView().tint(.white) }
                            Text(auth.busy ? "Signing in…" : "Sign in")
                                .font(.headline)
                        }
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .foregroundStyle(.white)
                        .background(canSignIn ? GleanStyle.blue : GleanStyle.blue.opacity(0.45), in: RoundedRectangle(cornerRadius: 15))
                    }
                    .disabled(!canSignIn)
                    .accessibilityIdentifier("login-submit")
                    NavigationLink("Create an account") { NativeSignUpView(auth: auth) }
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                    Spacer(minLength: 10)
                }
                .padding(.horizontal, 24)
                .padding(.top, 28)
                .padding(.bottom, 24)
                .frame(maxWidth: 520, alignment: .leading)
                .frame(maxWidth: .infinity, minHeight: 500, alignment: .top)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var canSignIn: Bool {
        !auth.busy && !login.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
    }

    private func submitSignIn() {
        focusedField = nil
        Task {
            await auth.signIn(login, password: password)
            if auth.username != nil { password = "" }
        }
    }

    private func checkAgreement() async {
        guard auth.username != nil else { agreement = nil; return }
        do {
            let current = try await auth.request("api/account/agreements")
            if current.flag("accepted") { agreement = nil } else { agreement = current }
        } catch { auth.error = error.localizedDescription }
    }
}

private struct NativePlatformAnnouncementBanner: View {
    @ObservedObject var auth: AuthStore
    let announcement: Record
    let onProfile: () -> Void

    private var profile: Record { announcement.object("profile") }
    private var username: String { profile.text("username").isEmpty ? "Nuper" : profile.text("username") }

    @ViewBuilder var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 12) { bannerContent }
        } else {
            bannerContent
        }
    }

    private var bannerContent: some View {
        HStack(spacing: 11) {
            Image(systemName: "megaphone.fill")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(GleanStyle.blue, in: Circle())
                .accessibilityHidden(true)
            Text(announcement.text("message"))
                .font(.subheadline.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("Glean announcement: \(announcement.text("message"))")
            Button(action: onProfile) {
                HStack(spacing: 6) {
                    ProfileAvatar(auth: auth, path: profile["avatarUrl"] as? String, name: username, size: 30)
                    Text(username).font(.caption.weight(.semibold)).lineLimit(1)
                }
                .padding(.leading, 4)
                .padding(.trailing, 9)
                .padding(.vertical, 4)
                .gleanGlassPill()
            }
            .buttonStyle(.plain)
            .accessibilityLabel("View \(username)’s profile")
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .gleanGlassCard(cornerRadius: 16)
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}

private struct NativeAvailabilityView: View {
    @ObservedObject var auth: AuthStore
    let nextOpenAt: Date?
    var offline = false
    let onCheck: () async -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 22) {
                GleanLogoIcon(size: 76, cornerRadius: 24)
                VStack(spacing: 8) {
                    Text("Blocked")
                        .font(.largeTitle.bold())
                    Text(offline ? "Glean is unavailable right now. Please check back later." : "Glean is unavailable during school hours. It will open in:")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !offline, let nextOpenAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let remaining = max(0, Int(nextOpenAt.timeIntervalSince(context.date)))
                        let units = [remaining / 3600, (remaining % 3600) / 60, remaining % 60]
                        HStack(spacing: 10) {
                            countdownTile(units[0], label: "hours")
                            countdownTile(units[1], label: "minutes")
                            countdownTile(units[2], label: "seconds")
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("blocked-countdown")
                    }
                } else if !offline {
                    ProgressView("Checking Glean availability…")
                        .font(.footnote)
                }
                Text(offline ? "Please check back later." : "Glean is available outside school hours.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button {
                    Task { await onCheck() }
                } label: {
                    Label("Check again", systemImage: "arrow.clockwise")
                        .frame(minHeight: 44)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .padding(24)
            .frame(maxWidth: 440)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(.primary.opacity(0.07)))
            .padding(.horizontal, 22)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
    }

    private func countdownTile(_ value: Int, label: String) -> some View {
        VStack(spacing: 4) {
            Text(String(format: "%02d", value))
                .font(.title2.monospacedDigit().bold())
                .contentTransition(.numericText())
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private enum LoginField: Hashable { case username, password }
private enum AppSection { case messages, servers, settings }

private enum RemoteListKind {
    case conversations, servers, channels(Int)
    var path: String {
        switch self {
        case .conversations: return "api/conversations"
        case .servers: return "api/servers"
        case .channels(let id): return "api/servers/\(id)"
        }
    }
    var title: String {
        switch self {
        case .conversations: return "Messages"
        case .servers: return "Servers"
        case .channels: return "Channels"
        }
    }
}

private struct RemoteRow: Identifiable {
    let id: Int
    let name: String
    let subtitle: String
    let voice: Bool
    let unread: Int
    var avatar: String? = nil
    var files: [MessageFile] = []
    var encrypted = false
    var poll: Record? = nil
    var reactions: [Record] = []
    var replyTo: Record? = nil
    var authorId = 0
    var isMine = false
    var createdAt = ""
    var sentAt: Date? = nil
    var startsGroup = true
    var dayLabel: String? = nil
    var edited = false
    var peerPublicKey: Record? = nil
    var peerUserID: Int? = nil
    var pinned = false
}

private struct RemoteProfileDestination: Identifiable, Hashable {
    let username: String
    var id: String { username }
}

private struct MessageFile: Identifiable {
    let id: Int
    let name: String
    let path: String
    let mimeType: String
    let size: Int
    let encrypted: Bool
    var crypto: Record? = nil
    var messageCrypto: Record? = nil
}

private enum MessageComposerSheet: String, Identifiable {
    case gif, poll
    var id: String { rawValue }
}

struct ProfileAvatar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let auth: AuthStore
    let path: String?
    let name: String
    var size: CGFloat = 42
    @State private var image: UIImage?
    @State private var animatedImage: UIImage?
    private var motionReduced: Bool { reduceMotion || auth.account.object("accessibility").flag("reduceMotion") }
    var body: some View {
        Group {
            if let image = animatedImage ?? image { Image(uiImage: image).resizable().scaledToFill() }
            else { Text(String(name.prefix(2)).uppercased()).font(.system(size: size * 0.3, weight: .semibold)).frame(maxWidth: .infinity, maxHeight: .infinity).background(GleanStyle.blue.opacity(0.2)) }
        }
        .frame(width: size, height: size).clipShape(Circle())
        .accessibilityLabel("\(name)’s profile picture")
        .task(id: "\(auth.mediaCacheNamespace)-\(path ?? "")-\(motionReduced)") {
            image = nil; animatedImage = nil
            guard let path else { return }
            let cachePrefix = "\(auth.mediaCacheNamespace)|\(path)"
            let cacheKey = "\(cachePrefix)#\(motionReduced ? "still" : "motion")" as NSString
            if let cached = NativeAvatarImageCache.images.object(forKey: cacheKey) {
                if motionReduced { image = cached } else { animatedImage = cached }
                return
            }
            do {
                let file = try await auth.media(path)
                defer { try? FileManager.default.removeItem(at: file) }
                let shouldReduceMotion = motionReduced
                let decoded = await Task.detached(priority: .utility) {
                    (shouldReduceMotion ? nil : Self.decodeAnimatedGIF(file), Self.decodeStaticAvatar(file))
                }.value
                guard !Task.isCancelled else { return }
                if let still = decoded.1 {
                    NativeAvatarImageCache.images.setObject(still, forKey: "\(cachePrefix)#still" as NSString, cost: NativeAvatarImageCache.cost(still))
                }
                let displayImage = motionReduced ? decoded.1 : (decoded.0 ?? decoded.1)
                if let displayImage {
                    NativeAvatarImageCache.images.setObject(displayImage, forKey: cacheKey, cost: NativeAvatarImageCache.cost(displayImage))
                }
                animatedImage = motionReduced ? nil : displayImage
                image = motionReduced ? displayImage : nil
            } catch { }
        }
    }

    nonisolated private static func decodeAnimatedGIF(_ url: URL) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetType(source) == UTType.gif.identifier as CFString else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1 else { return nil }
        let stride = max(1, (count + 79) / 80)
        var frames: [UIImage] = []
        var duration = 0.0
        var accumulatedDelay = 0.0
        for index in 0..<count {
            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let delay = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? NSNumber)?.doubleValue
                ?? (gif?[kCGImagePropertyGIFDelayTime] as? NSNumber)?.doubleValue
                ?? 0.1
            accumulatedDelay += max(0.02, delay)
            guard index % stride == 0 else { continue }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 256,
                kCGImageSourceShouldCacheImmediately: true
            ]
            guard let frame = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else { continue }
            frames.append(UIImage(cgImage: frame, scale: 1, orientation: .up))
            duration += accumulatedDelay
            accumulatedDelay = 0
        }
        guard frames.count > 1 else { return nil }
        duration += accumulatedDelay
        return UIImage.animatedImage(with: frames, duration: max(duration, Double(frames.count) * 0.02))
    }

    nonisolated private static func decodeStaticAvatar(_ url: URL) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 512,
            kCGImageSourceShouldCacheImmediately: true
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image, scale: 1, orientation: .up)
    }
}

struct ProfileAvatarLink: View {
    let auth: AuthStore
    let path: String?
    let username: String
    var size: CGFloat = 42

    var body: some View {
        NavigationLink {
            NativeProfileView(auth: auth, username: username)
        } label: {
            ProfileAvatar(auth: auth, path: path, name: username, size: size)
                .accessibilityHidden(true)
        }
        .frame(width: size, height: size)
        .contentShape(Circle())
        .buttonStyle(.plain)
        .accessibilityLabel("View \(username)’s profile")
        .accessibilityHint("Opens profile")
    }
}

private enum NativeAvatarImageCache {
    static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 48 * 1024 * 1024
        return cache
    }()
    static func cost(_ image: UIImage) -> Int {
        let frameCount = image.images?.count ?? 1
        let bytesPerFrame = (image.cgImage?.bytesPerRow ?? Int(image.size.width * 4)) * (image.cgImage?.height ?? Int(image.size.height))
        return max(1, bytesPerFrame * frameCount)
    }
}

private struct RemoteListView: View {
    @ObservedObject var auth: AuthStore
    let kind: RemoteListKind
    @State private var rows: [RemoteRow] = []
    @State private var searchText = ""
    @State private var loading = true
    @State private var error: String?
    @State private var newChat = false
    @State private var friendName = ""
    @State private var createServer = false
    @State private var joinServer = false
    @State private var selectedConversation: NativeConversationDestination?
    @State private var selectedProfile: RemoteProfileDestination?

    private var visibleRows: [RemoteRow] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return rows }
        return rows.filter {
            $0.name.localizedStandardContains(query) || $0.subtitle.localizedStandardContains(query)
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                listHeader
                if !loading && error == nil && !rows.isEmpty && visibleRows.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 36)
                } else if !loading && error == nil && rows.isEmpty {
                    ContentUnavailableView("No \(kind.title.lowercased()) yet", systemImage: icon)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 36)
                } else {
                    ForEach(visibleRows) { row in
                        remoteRowCard(row)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollIndicators(.hidden)
        .background(GleanStyle.background.ignoresSafeArea())
        .overlay {
            if loading { GleanLoadingState(title: kind.title.lowercased()) }
            else if let error {
                ContentUnavailableView {
                    Label("Couldn’t load \(kind.title.lowercased())", systemImage: "wifi.exclamationmark")
                } description: { Text(error) } actions: { Button("Try again") { Task { await load() } } }
            }
        }
        .navigationTitle(kind.title)
        .searchable(text: $searchText, prompt: searchPrompt)
        .navigationDestination(item: $selectedConversation) { conversation in
            MessageHistoryView(auth: auth, path: "api/conversations/\(conversation.id)/messages", title: conversation.title, peerPublicKey: conversation.peerPublicKey, peerUserID: conversation.peerUserID)
        }
        .navigationDestination(item: $selectedProfile) { destination in
            NativeProfileView(auth: auth, username: destination.username)
        }
        .toolbar {
            if case .conversations = kind {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack {
                        NavigationLink { NativeFriendsView(auth: auth) } label: { Image(systemName: "person.2") }.accessibilityLabel("Friends")
                        Button { newChat = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New message")
                    }
                }
            }
            if case .servers = kind {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    NavigationLink { NativeDiscoverView(auth: auth) } label: { Image(systemName: "safari") }.accessibilityLabel("Discover public servers")
                    Button { joinServer = true } label: { Image(systemName: "person.crop.circle.badge.plus") }.accessibilityLabel("Join with invite")
                    Button { createServer = true } label: { Image(systemName: "plus") }.accessibilityLabel("Create server")
                }
            }
        }
        .sheet(isPresented: $createServer) { NativeCreateServerView(auth: auth) }
        .sheet(isPresented: $joinServer) { NativeInviteJoinView(auth: auth) }
        .alert("New message", isPresented: $newChat) {
            TextField("Friend’s username", text: $friendName)
            Button("Open conversation") { Task { await createConversation() } }
            Button("Cancel", role: .cancel) { }
        } message: { Text("Enter the username of an accepted Glean friend.") }
        .refreshable { await load() }
        .task(id: auth.revision) { await load() }
    }

    private var listHeader: some View {
        HStack(spacing: 14) {
            GleanLogoIcon(size: 46, cornerRadius: 14)
            VStack(alignment: .leading, spacing: 4) {
                Text(kind.title).font(.title3.bold())
                Text(headerSubtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            if !rows.isEmpty {
                Text("\(rows.count)")
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(GleanStyle.blue)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(GleanStyle.blue.opacity(0.12), in: Capsule())
                    .accessibilityLabel("\(rows.count) total")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .gleanGlassCard(cornerRadius: 22)
        .accessibilityElement(children: .combine)
    }

    private var headerSubtitle: String {
        switch kind {
        case .conversations: return "Private conversations, friends, and unread messages"
        case .servers: return "Your communities and announcements"
        case .channels: return "Choose a channel to continue"
        }
    }

    @ViewBuilder
    private func remoteRowCard(_ row: RemoteRow) -> some View {
        if row.voice {
            Label(row.name, systemImage: "speaker.wave.2")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .gleanGlassCard(cornerRadius: 18)
        } else if case .conversations = kind {
            HStack(spacing: 12) {
                Button {
                    selectedProfile = RemoteProfileDestination(username: row.name)
                } label: {
                    ProfileAvatar(auth: auth, path: row.avatar, name: row.name, size: 48)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("View \(row.name)’s profile")
                .accessibilityHint("Opens profile")

                Button {
                    selectedConversation = NativeConversationDestination(
                        id: row.id,
                        title: row.name,
                        peerPublicKey: row.peerPublicKey,
                        peerUserID: row.peerUserID
                    )
                } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(row.name).font(.headline)
                            if !row.subtitle.isEmpty {
                                Text(row.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        Spacer(minLength: 8)
                        if row.pinned {
                            Image(systemName: "pin.fill").font(.caption).foregroundStyle(GleanStyle.blue).accessibilityLabel("Pinned conversation")
                        }
                        if row.unread > 0 { GleanUnreadBadge(count: row.unread) }
                        Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Messages with \(row.name)")
            }
            .padding(14)
            .gleanGlassCard(cornerRadius: 18)
            .contextMenu {
                Button(row.pinned ? "Unpin conversation" : "Pin conversation", systemImage: row.pinned ? "pin.slash" : "pin") {
                    Task { await setPinned(row) }
                }
            }
        } else {
            NavigationLink {
                switch kind {
                case .servers: NativeServerView(auth: auth, serverID: row.id)
                case .conversations: MessageHistoryView(auth: auth, path: "api/conversations/\(row.id)/messages", title: row.name, peerPublicKey: row.peerPublicKey, peerUserID: row.peerUserID)
                case .channels: MessageHistoryView(auth: auth, path: "api/channels/\(row.id)/messages", title: row.name)
                }
            } label: {
                HStack(spacing: 12) {
                    ProfileAvatar(auth: auth, path: row.avatar, name: row.name, size: 48)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(row.name).font(.headline)
                        if !row.subtitle.isEmpty {
                            Text(row.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    Spacer(minLength: 8)
                    if row.unread > 0 { GleanUnreadBadge(count: row.unread) }
                    Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .gleanGlassCard(cornerRadius: 18)
            .contextMenu {
                if case .conversations = kind {
                    Button(row.pinned ? "Unpin conversation" : "Pin conversation", systemImage: row.pinned ? "pin.slash" : "pin") {
                        Task { await setPinned(row) }
                    }
                }
            }
        }
    }

    private var icon: String {
        switch kind { case .servers: return "person.3.fill"; case .channels: return "number"; case .conversations: return "bubble.left.and.bubble.right.fill" }
    }

    private var searchPrompt: String {
        switch kind {
        case .conversations: return "Search messages"
        case .servers: return "Search servers"
        case .channels: return "Search channels"
        }
    }

    private func createConversation() async {
        let name = friendName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let escaped = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return }
        do {
            _ = try await auth.request("api/conversations/direct/\(escaped)", body: [:])
            friendName = ""
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func setPinned(_ row: RemoteRow) async {
        do {
            _ = try await auth.request("api/conversations/\(row.id)/pin", body: ["pinned": !row.pinned], method: "PATCH")
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func load() async {
        loading = rows.isEmpty
        error = nil
        defer { loading = false }
        do {
            let payload = try await auth.request(kind.path)
            let items: [[String: Any]]
            switch kind {
            case .conversations: items = payload["conversations"] as? [[String: Any]] ?? []
            case .servers: items = payload["servers"] as? [[String: Any]] ?? []
            case .channels: items = (payload["server"] as? [String: Any])?["channels"] as? [[String: Any]] ?? []
            }
            let previewIdentity: NativeE2EEIdentity? = kind.path == "api/conversations" ? try? await NativeE2EE.ensure(auth: auth) : nil
            rows = items.compactMap { item in
                guard let id = item["id"] as? Int else { return nil }
                let user = item["user"] as? [String: Any]
                var subtitle = item["lastMessage"] as? String ?? item["description"] as? String ?? item["topic"] as? String ?? ""
                if let previewIdentity, let encrypted = item["lastEncryptedMessage"] as? Record {
                    let clear = NativeE2EE.decrypt(message: encrypted, conversationID: id, identity: previewIdentity)
                    subtitle = clear.flag("decryptionFailed") ? "Message" : (clear.text("body").isEmpty ? "Attachment" : clear.text("body"))
                }
                return RemoteRow(id: id, name: user?["username"] as? String ?? item["name"] as? String ?? "Unknown", subtitle: subtitle, voice: item["voice"] as? Bool ?? false, unread: item["unreadCount"] as? Int ?? 0, avatar: user?["avatarUrl"] as? String ?? item["iconUrl"] as? String, peerPublicKey: user?["publicKey"] as? Record, peerUserID: user?["id"] as? Int, pinned: item["pinned"] as? Bool ?? false)
            }
        } catch { self.error = error.localizedDescription }
    }
}

struct MessageHistoryView: View {
    @ObservedObject var auth: AuthStore
    let path: String
    let title: String
    var readOnly = false
    var peerPublicKey: Record? = nil
    var peerUserID: Int? = nil
    @EnvironmentObject private var calls: NativeCallCoordinator
    @State private var messages: [RemoteRow] = []
    @State private var loading = true
    @State private var error: String?
    @State private var draft = ""
    @FocusState private var composerFocused: Bool
    @State private var sending = false
    @State private var choosingFiles = false
    @State private var choosingPhotos = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var importingPhotos = false
    @State private var uploads: [URL] = []
    @State private var temporaryUploads = Set<URL>()
    @State private var preview: URL?
    @State private var reply: RemoteRow?
    @State private var nextBefore: Int?
    @State private var loadingOlder = false
    @State private var editing: RemoteRow?
    @State private var editText = ""
    @State private var showEdit = false
    @State private var deleting: RemoteRow?
    @State private var showDelete = false
    @State private var composerSheet: MessageComposerSheet?
    @State private var encryptionIdentity: NativeE2EEIdentity?
    @State private var refreshedPeerPublicKey: Record?
    @State private var didRefreshPeerPublicKey = false
    @State private var encryptionLoading = false
    @State private var encryptionWarning: String?
    @State private var incomingTyping: String?
    @State private var typingStopTask: Task<Void, Never>?
    @State private var typingExpiryTask: Task<Void, Never>?
    @State private var hasAnnouncedTyping = false
    @State private var readWarning: String?
    @State private var visibleMessageID: Int?
    @State private var nearBottom = true
    @State private var scrollToLatest = 0
    @State private var fetchingMessages = false
    @State private var refreshQueued = false
    @State private var viewActive = false
    @State private var followAfterSend = false
    private var directConversationID: Int? { path.hasPrefix("api/conversations/") ? Int(path.split(separator: "/").dropFirst(2).first ?? "") : nil }
    private var activePeerPublicKey: Record? { didRefreshPeerPublicKey ? refreshedPeerPublicKey : peerPublicKey }

    var body: some View {
        ScrollViewReader { scroll in
        ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
        if let encryptionWarning {
            Label(encryptionWarning, systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
                .listRowBackground(Color.orange.opacity(0.10))
        }
        if nextBefore != nil {
            Button(loadingOlder ? "Loading…" : "Load older messages") { Task { await load(older: true) } }.disabled(loadingOlder)
        }
        ForEach(messages) { message in
            VStack(alignment: .leading, spacing: 0) {
            if let day = message.dayLabel {
                HStack(spacing: 12) {
                    Rectangle().fill(Color(uiColor: .separator)).frame(height: 0.5)
                    Text(day).font(.caption.weight(.medium)).foregroundStyle(.secondary).fixedSize()
                    Rectangle().fill(Color(uiColor: .separator)).frame(height: 0.5)
                }.padding(.vertical, 20).accessibilityAddTraits(.isHeader)
            }
            HStack(alignment: .top, spacing: 12) {
                if !message.startsGroup {
                    Color.clear.frame(width: 36, height: 1).accessibilityHidden(true)
                } else if message.authorId > 0 {
                    ProfileAvatarLink(auth: auth, path: message.avatar, username: message.name, size: 36)
                } else {
                    ProfileAvatar(auth: auth, path: message.avatar, name: message.name, size: 36)
                }
                VStack(alignment: .leading, spacing: 6) {
                    if message.startsGroup {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            NavigationLink { NativeProfileView(auth: auth, username: message.name) } label: {
                                Text(message.name).font(.subheadline.weight(.semibold)).foregroundStyle(GleanStyle.blue)
                            }.buttonStyle(.plain)
                            if !message.createdAt.isEmpty { Text(message.createdAt).font(.caption2).foregroundStyle(.secondary).fixedSize() }
                        }
                    }
                    if let replyTo = message.replyTo {
                        HStack(spacing: 10) {
                            RoundedRectangle(cornerRadius: 2).fill(GleanStyle.blue.opacity(0.7)).frame(width: 3)
                            VStack(alignment: .leading, spacing: 3) {
                                Label(replyTo.text("username"), systemImage: "arrowshape.turn.up.left.fill").font(.caption.weight(.semibold)).foregroundStyle(GleanStyle.blue)
                                Text(replyTo.flag("deleted") ? "Message deleted" : replyTo.text("body")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(10).fixedSize(horizontal: false, vertical: true)
                            .background(GleanStyle.blue.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                    }
                    if !message.subtitle.isEmpty {
                        Text(message.subtitle).font(.body).lineSpacing(2).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                    if message.edited { Text("Edited").font(.caption2).foregroundStyle(.tertiary) }
                    if let poll = message.poll { NativePollCard(poll: poll, canClose: message.isMine, onVote: { index in Task { await vote(message, index: index) } }, onClose: { Task { await closePoll(message) } }) }
                    ForEach(message.files) { file in
                        NativeMessageAttachment(auth: auth, file: file, encryptionIdentity: encryptionIdentity) {
                            Task { await open(file) }
                        }
                    }
                    if channelID != nil && !message.reactions.isEmpty { reactionsView(message) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.top, message.startsGroup && message.dayLabel == nil ? 18 : 3).padding(.bottom, 3)
            .contentShape(Rectangle())
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Message by \(message.name), \(message.createdAt)")
            .contextMenu {
                if !readOnly {
                Button("Reply", systemImage: "arrowshape.turn.up.left") { reply = message; composerFocused = true }
                if channelID != nil { Menu("React", systemImage: "face.smiling") { ForEach(["👍", "❤️", "😂", "🎉", "👀"], id: \.self) { emoji in Button(emoji) { Task { await react(message, emoji: emoji) } } } } }
                }
                if message.isMine {
                    if !message.encrypted {
                        Button("Edit", systemImage: "pencil") { editing = message; editText = message.subtitle; showEdit = true }
                    }
                    Button("Delete", systemImage: "trash", role: .destructive) { deleting = message; showDelete = true }
                }
            }
            }.id(message.id)
        }
        }.scrollTargetLayout().padding(.horizontal, 16).padding(.vertical, 12)
        }
        .scrollPosition(id: $visibleMessageID, anchor: .top)
        .modifier(ChatBottomTracker(nearBottom: $nearBottom))
        .onChange(of: scrollToLatest) { _, _ in
            if let id = messages.last?.id { scroll.scrollTo(id, anchor: .bottom) }
        }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            if composerFocused {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composerFocused = false } label: {
                        Image(systemName: "keyboard.chevron.compact.down")
                    }.accessibilityLabel("Hide keyboard")
                }
            }
            if let directConversationID {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Menu {
                        Label(activePeerPublicKey == nil ? "Encryption unavailable" : "End-to-end encrypted", systemImage: activePeerPublicKey == nil ? "lock.slash" : "lock.fill")
                        if let encryptionWarning {
                            Label(encryptionWarning, systemImage: "exclamationmark.triangle.fill")
                        }
                        Text("Direct messages and attachments are encrypted between your devices.")
                    } label: {
                        Image(systemName: activePeerPublicKey == nil ? "lock.slash" : "lock.fill")
                    }
                    .accessibilityLabel("Encryption information")
                    Menu {
                        Button("Voice call", systemImage: "phone.fill") {
                            Task { await calls.placeCall(conversationID: directConversationID, peerID: peerUserID, peerName: title) }
                        }
                        Button("Video call", systemImage: "video.fill") {
                            Task { await calls.placeCall(conversationID: directConversationID, peerID: peerUserID, peerName: title, video: true) }
                        }
                    } label: { Image(systemName: "phone.fill") }
                    .disabled(!calls.canStart)
                    .accessibilityLabel("Call \(title)")
                }
            }
        }
        .overlay {
            if messages.isEmpty {
                if loading { ProgressView("Loading messages…") }
                else if let error {
                    ContentUnavailableView { Label("Couldn’t load messages", systemImage: "wifi.exclamationmark") } description: { Text(error) } actions: { Button("Try again") { Task { await load() } } }
                } else {
                    ContentUnavailableView("No messages yet", systemImage: "bubble.left")
                }
            }
        }
        .refreshable { await load() }
        .onAppear { viewActive = true }
        .task { await load() }
        .onChange(of: draft) { _, updated in updateTyping(updated) }
        .onReceive(auth.realtimeEvents) { event in
            receiveTyping(event)
            let relevant = (event.event == "message" && event.payload.number("conversationId") == directConversationID)
                || (event.event == "channel-message" && event.payload.number("channelId") == channelID)
                || (event.event == "server-updated" && event.payload.number("channelId") == channelID)
                || event.event == "connected"
            if relevant { Task { await load() } }
        }
        .onDisappear {
            viewActive = false
            refreshQueued = false
            typingStopTask?.cancel()
            typingExpiryTask?.cancel()
            setTypingState(false)
            cleanupTemporaryUploads()
        }
        .composerBar {
            if readOnly {
                Label("Official announcements from Glean", systemImage: "megaphone.fill")
                    .font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(16)
            } else {
            VStack(alignment: .leading, spacing: 8) {
                if let incomingTyping {
                    Text("\(incomingTyping) is typing…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                if let readWarning {
                    Label(readWarning, systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                if let reply {
                    HStack(spacing: 10) {
                        Image(systemName: "arrowshape.turn.up.left.fill").foregroundStyle(GleanStyle.blue)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Replying to \(reply.name)").font(.caption.weight(.semibold))
                            Text(reply.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Button { self.reply = nil } label: {
                            Image(systemName: "xmark").frame(width: 44, height: 44)
                        }.accessibilityLabel("Cancel reply").disabled(sending)
                    }
                    .padding(.horizontal, 8)
                }
                if !uploads.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(uploads, id: \.self) { file in
                                ComposerAttachmentPreview(file: file, open: { preview = file }, remove: { removeUpload(file) })
                                    .disabled(sending)
                            }
                        }.padding(.horizontal, 6).padding(.top, 4)
                    }
                }
                if importingPhotos { ProgressView("Preparing attachments…").font(.caption).padding(.horizontal, 8) }
                if let error, !messages.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
                HStack(alignment: .bottom, spacing: 4) {
                    Menu {
                        Button { choosingPhotos = true } label: { Label("Photo Library", systemImage: "photo") }
                            .disabled(sending || importingPhotos || uploads.count >= 10 || (directConversationID != nil && activePeerPublicKey == nil))
                        Button { choosingFiles = true } label: { Label("Browse Files", systemImage: "folder") }
                            .disabled(sending || importingPhotos || (directConversationID != nil && activePeerPublicKey == nil))
                        Button { composerSheet = .gif } label: { Label("Choose a GIF", systemImage: "gift") }
                            .disabled(sending || uploads.count >= 10 || (directConversationID != nil && activePeerPublicKey == nil))
                        if channelID != nil {
                            Button { composerSheet = .poll } label: { Label("Create a poll", systemImage: "chart.bar.xaxis") }
                                .disabled(sending || !uploads.isEmpty)
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 20, weight: .medium))
                            .frame(width: 44, height: 44)
                            .contentShape(Circle())
                    }
                    .disabled(sending)
                    .accessibilityLabel("Add to message")
                    TextField("Message \(title)", text: $draft, axis: .vertical)
                        .font(.body)
                        .lineLimit(1...6)
                        .textInputAutocapitalization(.sentences)
                        .focused($composerFocused)
                        .padding(.vertical, 12)
                        .padding(.horizontal, 4)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .accessibilityLabel("Message \(title)")
                        .accessibilityIdentifier("messageComposerInput")
                    Button { Task { await send() } } label: {
                        ZStack {
                            Circle().fill(GleanStyle.blue.opacity(canSend ? 1 : 0.16))
                            if sending { ProgressView().tint(.white) }
                            else { Image(systemName: "arrow.up").font(.system(size: 19, weight: .bold)).foregroundStyle(canSend ? .white : .secondary) }
                        }.frame(width: 40, height: 40).frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityLabel(sending ? "Sending message" : "Send message")
                    .accessibilityIdentifier("messageComposerSend")
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity)
            .modifier(DarkComposerGlass())
            .environment(\.colorScheme, .dark)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            }
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let files):
                acceptFiles(files)
            case .failure(let failure):
                if (failure as NSError).code != NSUserCancelledError { error = failure.localizedDescription }
            }
        }
        .photosPicker(isPresented: $choosingPhotos, selection: $selectedPhotoItems, maxSelectionCount: max(1, 10 - uploads.count), matching: .any(of: [.images, .videos]), preferredItemEncoding: .current)
        .onChange(of: selectedPhotoItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await importPhotos(items) }
        }
        .sheet(item: $composerSheet) { sheet in
            switch sheet {
            case .gif:
                NativeGifPicker(auth: auth) { file in
                    uploads.append(file)
                    temporaryUploads.insert(file)
                }
            case .poll:
                NativePollComposer { question, options, multiple in
                    Task { await sendPoll(question: question, options: options, multiple: multiple) }
                }
            }
        }
        .quickLookPreview($preview)
        .alert("Edit message", isPresented: $showEdit) {
            TextField("Message", text: $editText)
            Button("Save") { Task { await edit() } }
            Button("Cancel", role: .cancel) { editing = nil }
        }
        .alert("Delete message?", isPresented: $showDelete) {
            Button("Delete", role: .destructive) { Task { await delete() } }
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: { Text("This cannot be undone.") }
    }

    private var canSend: Bool {
        !sending && !importingPhotos && draft.count <= 4000
            && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !uploads.isEmpty)
    }

    private func load(older: Bool = false) async {
        guard viewActive else { return }
        guard !fetchingMessages else {
            if !older { refreshQueued = true }
            return
        }
        if older && nextBefore == nil { return }
        fetchingMessages = true
        if older { loadingOlder = true }
        error = nil
        defer {
            loading = false; loadingOlder = false; fetchingMessages = false
            if refreshQueued && viewActive {
                refreshQueued = false
                Task { await load() }
            }
        }
        do {
            if directConversationID != nil {
                while encryptionLoading { try? await Task.sleep(for: .milliseconds(50)) }
                if !encryptionLoading {
                    encryptionLoading = true
                    do {
                        let identity = try await NativeE2EE.ensure(auth: auth)
                        encryptionIdentity = identity
                        if identity.serverKeyChanged {
                            encryptionWarning = "Your encryption key changed. Older encrypted messages may need the device that created them."
                        }
                    }
                    catch { encryptionLoading = false; throw error }
                    encryptionLoading = false
                }
            }
            if directConversationID != nil { _ = try? await refreshConversationPeerKey() }
            let cursor = older ? nextBefore : nil
            var payload = try await auth.request(path + "?limit=100" + (cursor.map { "&before=\($0)" } ?? ""))
            var sourceMessages = payload.records("messages")
            let oldestLoaded = older ? nil : messages.first?.id
            var pageCursor = payload.object("page").flag("hasMore") ? payload.object("page")["nextBefore"] as? Int : nil
            // Refresh the loaded window rather than replacing it with only the newest page.
            while let oldestLoaded, let before = pageCursor, let first = sourceMessages.first,
                  first.number("id") > oldestLoaded {
                try Task.checkCancellation()
                payload = try await auth.request(path + "?limit=100&before=\(before)")
                let batch = payload.records("messages")
                guard !batch.isEmpty else { pageCursor = nil; break }
                sourceMessages = batch + sourceMessages
                let next = payload.object("page").flag("hasMore") ? payload.object("page")["nextBefore"] as? Int : nil
                guard next == nil || next! < before else { throw URLError(.cannotParseResponse) }
                pageCursor = next
            }
            if let oldestLoaded, sourceMessages.contains(where: { $0.number("id") < oldestLoaded }) {
                sourceMessages = sourceMessages.filter { $0.number("id") >= oldestLoaded }
                pageCursor = oldestLoaded
            }
            try Task.checkCancellation()
            guard viewActive else { return }
            let decryptedMessages = sourceMessages.map { item in
                guard let directConversationID, let encryptionIdentity, item.flag("encrypted") else { return item }
                return NativeE2EE.decrypt(message: item, conversationID: directConversationID, identity: encryptionIdentity)
            }
            encryptionWarning = decryptedMessages.contains { $0.flag("decryptionFailed") } ? "Some encrypted messages could not be decrypted on this device." : nil
            let fetched = decryptedMessages.compactMap { item -> RemoteRow? in
                guard let id = item["id"] as? Int else { return nil }
                let author = item["author"] as? [String: Any] ?? item["sender"] as? [String: Any]
                let body = item["body"] as? String ?? (item.flag("encrypted") ? "Unable to decrypt this message on this device." : "")
                let attachments = item["attachments"] as? [[String: Any]] ?? []
                let files = attachments.compactMap { file -> MessageFile? in
                    guard let id = file["id"] as? Int, let url = file["url"] as? String else { return nil }
                    return MessageFile(id: id, name: file["name"] as? String ?? "Attachment", path: url, mimeType: file["type"] as? String ?? "application/octet-stream", size: file["size"] as? Int ?? 0, encrypted: file["encrypted"] as? Bool ?? false, crypto: file["crypto"] as? Record, messageCrypto: item["crypto"] as? Record)
                }
                return RemoteRow(id: id, name: author?["username"] as? String ?? "Unknown", subtitle: body, voice: false, unread: 0, avatar: author?["avatarUrl"] as? String, files: files, encrypted: item["encrypted"] as? Bool ?? false, poll: item["poll"] as? Record, reactions: item["reactions"] as? [Record] ?? [], replyTo: item["replyTo"] as? Record, authorId: author?["id"] as? Int ?? 0, isMine: author?["id"] as? Int == auth.account["id"] as? Int, createdAt: Self.messageTime(item["createdAt"] as? String), sentAt: Self.messageDate(item["createdAt"] as? String), edited: !item.text("editedAt").isEmpty)
            }
            let followBottom = !older && (messages.isEmpty || nearBottom || followAfterSend)
            if older {
                let existing = Set(messages.map(\.id))
                messages = fetched.filter { !existing.contains($0.id) } + messages
            } else { messages = fetched }
            messages = Self.layoutMessages(messages)
            nextBefore = pageCursor
            if followBottom { scrollToLatest += 1; followAfterSend = false }
            if !older {
                let readPath: String?
                if let directConversationID { readPath = "api/conversations/\(directConversationID)/read" }
                else if let channelID { readPath = "api/channels/\(channelID)/read" }
                else { readPath = nil }
                if let readPath {
                    do {
                        var readBody: Record = [:]
                        if let lastMessageID = fetched.last?.id { readBody["lastReadMessageId"] = lastMessageID }
                        _ = try await auth.request(readPath, body: readBody)
                        readWarning = nil
                    } catch {
                        readWarning = "Read status couldn’t sync."
                    }
                }
            }
        } catch {
            if !Task.isCancelled && viewActive { self.error = error.localizedDescription }
        }
    }

    private func updateTyping(_ value: String) {
        guard directConversationID != nil || channelID != nil else { return }
        typingStopTask?.cancel()
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            setTypingState(false)
            return
        }
        setTypingState(true)
        typingStopTask = Task {
            do { try await Task.sleep(for: .seconds(2)) }
            catch { return }
            guard !Task.isCancelled else { return }
            setTypingState(false)
        }
    }

    private func setTypingState(_ active: Bool) {
        guard active != hasAnnouncedTyping else { return }
        if active && auth.account.flag("keepInformationSecret") { return }
        hasAnnouncedTyping = active
        if let directConversationID {
            Task { await auth.sendTyping(conversationID: directConversationID, typing: active) }
        } else if let channelID {
            Task {
                try? await auth.sendRealtime("channel-typing", payload: ["channelId": channelID, "typing": active])
            }
        }
    }

    private func receiveTyping(_ event: NativeRealtimeEvent) {
        let expectedEvent: String
        let expectedID: Int?
        let eventID: Int
        if let directConversationID {
            expectedEvent = "typing"
            expectedID = directConversationID
            eventID = event.payload.number("conversationId")
        } else if let channelID {
            expectedEvent = "channel-typing"
            expectedID = channelID
            eventID = event.payload.number("channelId")
        } else { return }
        guard event.event == expectedEvent, eventID == expectedID else { return }
        let name = event.payload.text("username").isEmpty ? "Someone" : event.payload.text("username")
        typingExpiryTask?.cancel()
        if event.payload.flag("typing") {
            incomingTyping = name
            typingExpiryTask = Task {
                do { try await Task.sleep(for: .seconds(6)) }
                catch { return }
                guard !Task.isCancelled, incomingTyping == name else { return }
                incomingTyping = nil
            }
        } else if incomingTyping == name {
            incomingTyping = nil
        }
    }

    private func send() async {
        guard !sending else { return }
        guard draft.count <= 4000 else { error = "Messages can contain up to 4,000 characters."; return }
        guard canSend else { return }
        let sentDraft = draft
        let sentUploads = uploads
        let sentReply = reply?.id
        sending = true
        error = nil
        defer { sending = false }
        do {
            if let directConversationID {
                guard let peerPublicKey = activePeerPublicKey else { throw NSError(domain: "Glean", code: 409, userInfo: [NSLocalizedDescriptionKey: "This friend needs to open updated Glean once before you can start an encrypted conversation."]) }
                let identity: NativeE2EEIdentity
                if let encryptionIdentity { identity = encryptionIdentity }
                else { identity = try await NativeE2EE.ensure(auth: auth); encryptionIdentity = identity }
                let prepared = try NativeE2EE.encrypt(text: sentDraft, conversationID: directConversationID, identity: identity, recipient: peerPublicKey, files: sentUploads)
                defer { prepared.encryptedFiles.forEach { try? FileManager.default.removeItem(at: $0) } }
                try await auth.send(path, text: "", files: prepared.encryptedFiles, reply: sentReply, formFields: ["envelope": prepared.envelope, "attachmentMeta": prepared.attachmentMeta])
            } else {
                try await auth.send(path, text: sentDraft, files: sentUploads, reply: sentReply)
            }
            if draft == sentDraft { draft = "" }
            uploads = []
            temporaryUploads.forEach { try? FileManager.default.removeItem(at: $0) }
            temporaryUploads.removeAll()
            reply = nil
            followAfterSend = true
            await load()
        } catch {
            if error.localizedDescription.contains("Encryption keys changed.") {
                do {
                    let peerKeyChanged = try await refreshConversationPeerKey()
                    self.error = peerKeyChanged
                        ? "Your friend’s encryption key changed. It’s refreshed; tap Send again. Older encrypted messages may need the device that created them."
                        : "This device’s encryption key may be out of date. Your message wasn’t sent. Use the device that last updated your Glean encryption key."
                } catch {
                    self.error = "Encryption keys changed. Couldn’t refresh the conversation key: \(error.localizedDescription)"
                }
            } else {
                self.error = error.localizedDescription
            }
        }
    }

    private func removeUpload(_ file: URL) {
        uploads.removeAll { $0 == file }
        if temporaryUploads.remove(file) != nil { try? FileManager.default.removeItem(at: file) }
    }

    private func acceptFiles(_ files: [URL]) {
        guard uploads.count + files.count <= 10 else { error = "You can attach up to 10 files."; return }
        if directConversationID != nil && activePeerPublicKey == nil {
            error = "Encrypted messaging must be enabled before you can attach files to this DM."
            return
        }
        for file in files where directConversationID != nil {
            let accessible = file.startAccessingSecurityScopedResource()
            defer { if accessible { file.stopAccessingSecurityScopedResource() } }
            guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize else {
                error = "Couldn’t read the size of \(file.lastPathComponent)."
                return
            }
            guard size <= NativeE2EE.maximumAttachmentBytes else {
                error = "Encrypted DM attachments are limited to 100 MB per file."
                return
            }
        }
        uploads.append(contentsOf: files)
        error = nil
    }

    @discardableResult
    private func refreshConversationPeerKey() async throws -> Bool {
        guard let directConversationID else { return false }
        let previousKey = activePeerPublicKey
        let payload = try await auth.request("api/conversations")
        guard let conversation = payload.records("conversations").first(where: { $0.number("id") == directConversationID }) else {
            throw NSError(domain: "Glean", code: 404, userInfo: [NSLocalizedDescriptionKey: "Conversation not found."])
        }
        let latestKey = conversation.object("user")["publicKey"] as? Record
        let changed = publicKeySignature(previousKey) != publicKeySignature(latestKey)
        refreshedPeerPublicKey = latestKey
        didRefreshPeerPublicKey = true
        return changed
    }

    private func publicKeySignature(_ key: Record?) -> String? {
        guard let key else { return nil }
        return ["kty", "crv", "x", "y"].map { key[$0] as? String ?? "" }.joined(separator: ":")
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        guard !sending, !importingPhotos else { return }
        guard uploads.count + items.count <= 10 else {
            error = "You can attach up to 10 files."
            selectedPhotoItems = []
            return
        }
        if directConversationID != nil && activePeerPublicKey == nil {
            error = "Encrypted messaging must be enabled before you can attach files to this DM."
            selectedPhotoItems = []
            return
        }

        importingPhotos = true
        defer {
            importingPhotos = false
            selectedPhotoItems = []
        }

        var stagedPhotos: [URL] = []
        do {
            for item in items {
                guard let attachment = try await item.loadTransferable(type: LibraryAttachment.self) else {
                    throw NSError(domain: "Glean", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn’t read one of the selected photos or videos."])
                }
                stagedPhotos.append(attachment.url)
            }

            let previousCount = uploads.count
            acceptFiles(stagedPhotos)
            guard uploads.count == previousCount + stagedPhotos.count else {
                stagedPhotos.forEach { try? FileManager.default.removeItem(at: $0) }
                return
            }
            temporaryUploads.formUnion(stagedPhotos)
        } catch {
            stagedPhotos.forEach { try? FileManager.default.removeItem(at: $0) }
            self.error = error.localizedDescription
        }
    }

    private func open(_ file: MessageFile) async {
        do {
            let downloaded = try await auth.media(file.path)
            let safeName = URL(fileURLWithPath: file.name).lastPathComponent
            let destination: URL
            if file.encrypted {
                guard let encryptionIdentity else { throw URLError(.userAuthenticationRequired) }
                destination = try NativeE2EE.decryptAttachment(file: downloaded, fileName: safeName, identity: encryptionIdentity, attachment: file.crypto ?? [:], messageCrypto: file.messageCrypto ?? [:])
                try? FileManager.default.removeItem(at: downloaded)
            } else {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                destination = directory.appendingPathComponent(safeName)
                try FileManager.default.moveItem(at: downloaded, to: destination)
            }
            preview = destination
        } catch { self.error = error.localizedDescription }
    }

    private func cleanupTemporaryUploads() {
        temporaryUploads.forEach { try? FileManager.default.removeItem(at: $0) }
        temporaryUploads.removeAll()
    }

    private func edit() async {
        guard let editing else { return }
        do {
            _ = try await auth.request("\(path)/\(editing.id)", body: ["body": editText], method: "PATCH")
            self.editing = nil
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func delete() async {
        guard let deleting else { return }
        do {
            _ = try await auth.request("\(path)/\(deleting.id)", method: "DELETE")
            self.deleting = nil
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private var channelID: Int? {
        guard path.hasPrefix("api/channels/"), let raw = path.split(separator: "/").dropFirst(2).first else { return nil }
        return Int(raw)
    }
    private func reactionsView(_ message: RemoteRow) -> some View {
        FlowLayout(spacing: 6) {
            ForEach(Array(message.reactions.enumerated()), id: \.offset) { _, reaction in
                Button { Task { await react(message, emoji: reaction.text("emoji")) } } label: { Text("\(reaction.text("emoji")) \(reaction.number("count"))").font(.caption).padding(.horizontal, 9).padding(.vertical, 5).background(reaction.flag("reacted") ? GleanStyle.blue.opacity(0.22) : GleanStyle.panel, in: Capsule()) }
                    .buttonStyle(.plain)
            }
            Menu { ForEach(["👍", "❤️", "😂", "🎉", "👀"], id: \.self) { emoji in Button(emoji) { Task { await react(message, emoji: emoji) } } } } label: { Image(systemName: "face.smiling").font(.caption).padding(6).background(GleanStyle.panel, in: Circle()) }.accessibilityLabel("Add reaction")
        }
    }
    private func react(_ message: RemoteRow, emoji: String) async {
        guard let channelID else { return }
        do { _ = try await auth.request("api/channels/\(channelID)/messages/\(message.id)/reactions", body: ["emoji": emoji]); await load() }
        catch { self.error = error.localizedDescription }
    }
    private func vote(_ message: RemoteRow, index: Int) async {
        guard let channelID else { return }
        do { _ = try await auth.request("api/channels/\(channelID)/messages/\(message.id)/poll/vote", body: ["optionIndex": index]); await load() }
        catch { self.error = error.localizedDescription }
    }
    private func closePoll(_ message: RemoteRow) async {
        guard let channelID else { return }
        do { _ = try await auth.request("api/channels/\(channelID)/messages/\(message.id)/poll/close", body: [:]); await load() }
        catch { self.error = error.localizedDescription }
    }
    private func sendPoll(question: String, options: [String], multiple: Bool) async {
        guard !sending else { return }
        sending = true; error = nil; defer { sending = false }
        do { try await auth.send(path, text: "", files: [], reply: reply?.id, poll: ["question": question, "options": options, "allowMultiple": multiple]); reply = nil; await load() }
        catch { self.error = error.localizedDescription }
    }
    private static func messageTime(_ raw: String?) -> String {
        guard let date = messageDate(raw) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }
    private static let preciseMessageDates: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let standardMessageDates = ISO8601DateFormatter()
    private static func messageDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        return preciseMessageDates.date(from: raw) ?? standardMessageDates.date(from: raw)
    }
    private static func layoutMessages(_ rows: [RemoteRow]) -> [RemoteRow] {
        let calendar = Calendar.current
        return rows.enumerated().map { index, row in
            var row = row
            let previous = index > 0 ? rows[index - 1] : nil
            row.startsGroup = true
            row.dayLabel = nil
            if let date = row.sentAt {
                let sameDay = previous?.sentAt.map { calendar.isDate($0, inSameDayAs: date) } ?? false
                if !sameDay {
                    row.dayLabel = calendar.isDateInToday(date) ? "Today" : calendar.isDateInYesterday(date) ? "Yesterday" : date.formatted(date: .abbreviated, time: .omitted)
                }
                if let previous, let previousDate = previous.sentAt {
                    let gap = date.timeIntervalSince(previousDate)
                    row.startsGroup = !(sameDay && row.authorId > 0 && row.authorId == previous.authorId && gap >= 0 && gap < 300 && row.replyTo == nil && row.poll == nil && previous.poll == nil)
                }
            }
            return row
        }
    }
}

private struct NativeMessageAttachment: View {
    @ObservedObject var auth: AuthStore
    let file: MessageFile
    let encryptionIdentity: NativeE2EEIdentity?
    let onOpen: () -> Void
    @State private var image: UIImage?
    @State private var player: AVPlayer?
    @State private var temporaryPlaybackURL: URL?
    @State private var loading = false
    @State private var error: String?

    private var kind: Kind {
        let mime = file.mimeType.lowercased().split(separator: ";", maxSplits: 1).first.map(String.init) ?? ""
        let ext = URL(fileURLWithPath: file.name).pathExtension.lowercased()
        if mime.hasPrefix("image/") || ["jpg", "jpeg", "png", "gif", "webp"].contains(ext) { return .image }
        if mime.hasPrefix("video/") || ["mp4", "webm", "mov", "ogv", "m4v"].contains(ext) { return .video }
        if file.name.lowercased().hasPrefix("voice-message.") || mime.hasPrefix("audio/") || ["mp3", "wav", "ogg", "m4a", "aac", "flac", "oga"].contains(ext) { return .audio }
        return .file
    }

    var body: some View {
        Group {
            switch kind {
            case .image:
                if canPreviewImage { imageAttachment.frame(maxWidth: 280).frame(height: 220, alignment: .leading) }
                else { imageAttachment }
            case .video, .audio: playerAttachment.frame(height: kind == .audio ? 76 : 230)
            case .file:
                Button(action: onOpen) { attachmentLabel(symbol: file.encrypted ? "lock.fill" : "paperclip", title: file.name, detail: "Open attachment") }
                    .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: file.id) { if kind == .image && canPreviewImage { await loadImage() } }
        .onDisappear {
            player?.pause()
            player = nil
            if let temporaryPlaybackURL {
                let disposable = file.encrypted ? temporaryPlaybackURL.deletingLastPathComponent() : temporaryPlaybackURL
                try? FileManager.default.removeItem(at: disposable)
                self.temporaryPlaybackURL = nil
            }
        }
    }

    @ViewBuilder private var imageAttachment: some View {
        if let image {
            Button(action: onOpen) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 280, maxHeight: 280)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.caption.bold())
                            .padding(8)
                            .background(.black.opacity(0.65), in: Circle())
                            .foregroundStyle(.white)
                            .padding(8)
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open image \(file.name)")
        } else if canPreviewImage {
            Button { Task { await loadImage() } } label: {
                attachmentLabel(symbol: loading ? "hourglass" : "photo", title: file.name, detail: error ?? (loading ? "Loading image…" : "Load image preview"))
            }
            .buttonStyle(.plain)
            .disabled(loading)
        } else {
            Button(action: onOpen) { attachmentLabel(symbol: "photo", title: file.name, detail: "Open full-size image") }
                .buttonStyle(.plain)
        }
    }

    @ViewBuilder private var playerAttachment: some View {
        if let player {
            VideoPlayer(player: player)
                .frame(maxWidth: 420)
                .frame(height: kind == .audio ? 76 : 230)
                .clipShape(RoundedRectangle(cornerRadius: 12))
        } else {
            Button { Task { await startPlayback() } } label: {
                attachmentLabel(symbol: loading ? "hourglass" : kind == .audio ? "waveform" : "play.rectangle", title: file.name, detail: error ?? (loading ? "Preparing media…" : kind == .audio ? "Play audio" : "Play video"))
            }
            .buttonStyle(.plain)
            .disabled(loading || (file.encrypted && encryptionIdentity == nil))
        }
    }

    private var canPreviewImage: Bool {
        let limit = file.encrypted ? 8 * 1024 * 1024 : 24 * 1024 * 1024
        return file.size <= 0 || file.size <= limit
    }

    private func attachmentLabel(symbol: String, title: String, detail: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).font(.title3).foregroundStyle(GleanStyle.blue).frame(width: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.medium)).lineLimit(2)
                Text(detail).font(.caption).foregroundStyle(error == nil ? Color.secondary : Color.red).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: 360, alignment: .leading)
        .background(GleanStyle.panel.opacity(0.75), in: RoundedRectangle(cornerRadius: 12))
        .contentShape(RoundedRectangle(cornerRadius: 12))
    }

    @MainActor private func loadImage() async {
        guard image == nil, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let downloaded = try await auth.media(file.path)
            defer { try? FileManager.default.removeItem(at: downloaded) }
            var temporaryClearURL: URL?
            defer {
                if let temporaryClearURL { try? FileManager.default.removeItem(at: temporaryClearURL.deletingLastPathComponent()) }
            }
            let source: URL
            if file.encrypted {
                guard let encryptionIdentity else { throw URLError(.userAuthenticationRequired) }
                source = try NativeE2EE.decryptAttachment(file: downloaded, fileName: file.name, identity: encryptionIdentity, attachment: file.crypto ?? [:], messageCrypto: file.messageCrypto ?? [:])
                temporaryClearURL = source
            } else {
                source = downloaded
            }
            let data = try Data(contentsOf: source, options: .mappedIfSafe)
            guard let decoded = UIImage(data: data) else { throw URLError(.cannotDecodeContentData) }
            image = decoded
            error = nil
        } catch { self.error = "Couldn’t load preview. Tap to retry." }
    }

    @MainActor private func startPlayback() async {
        guard player == nil, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let nextPlayer: AVPlayer
            if file.encrypted {
                guard let encryptionIdentity else { throw URLError(.userAuthenticationRequired) }
                let downloaded = try await auth.media(file.path)
                defer { try? FileManager.default.removeItem(at: downloaded) }
                let clear = try NativeE2EE.decryptAttachment(file: downloaded, fileName: file.name, identity: encryptionIdentity, attachment: file.crypto ?? [:], messageCrypto: file.messageCrypto ?? [:])
                temporaryPlaybackURL = clear
                nextPlayer = AVPlayer(url: clear)
            } else {
                let downloaded = try await auth.media(file.path)
                guard !Task.isCancelled else {
                    try? FileManager.default.removeItem(at: downloaded)
                    return
                }
                temporaryPlaybackURL = downloaded
                nextPlayer = AVPlayer(url: downloaded)
            }
            player = nextPlayer
            nextPlayer.play()
            error = nil
        } catch { self.error = "Couldn’t play this file. Tap to retry." }
    }

    private enum Kind { case image, video, audio, file }
}
