import AVFAudio
import AVFoundation
import Combine
import SwiftUI
@preconcurrency import WebRTC

enum NativeCallStatus: Equatable {
    case idle, incoming, outgoing, connecting, active
}

@MainActor
final class NativeCallCoordinator: NSObject, ObservableObject, @preconcurrency RTCPeerConnectionDelegate {
    @Published private(set) var status: NativeCallStatus = .idle {
        didSet {
            if status == .active, callStartedAt == nil { callStartedAt = Date() }
            if status == .idle { callStartedAt = nil }
            publishActivity()
        }
    }
    @Published private(set) var peerName = "" { didSet { publishActivity() } }
    @Published private(set) var error: String?
    @Published private(set) var muted = false { didSet { publishActivity() } }
    @Published private(set) var speaker = false
    @Published private(set) var working = false
    @Published private(set) var videoCall = false
    @Published private(set) var localVideoTrack: RTCVideoTrack?
    @Published private(set) var localCameraOn = false
    @Published private(set) var screenSharing = false
    @Published private(set) var screenShareStarting = false
    @Published private(set) var remoteVideoTrack: RTCVideoTrack?
    @Published private(set) var remoteSharingOn = false
    @Published private(set) var appsStore: NativeAppsStore?
    @Published var showingApps = false

    private weak var auth: AuthStore?
    private var eventSubscription: AnyCancellable?
    private var eventTask: Task<Void, Never>?
    private var conversationID: Int?
    private var peerID: Int?
    private var localID = 0
    private var peerConnection: RTCPeerConnection?
    private var audioTrack: RTCAudioTrack?
    private var videoSource: RTCVideoSource?
    private var videoCapturer: RTCCameraVideoCapturer?
    private var videoSender: RTCRtpSender?
    private var screenVideoSource: RTCVideoSource?
    private var screenVideoTrack: RTCVideoTrack?
    private var screenCapture: NativeScreenCaptureController?
    private var pendingCandidates: [RTCIceCandidate] = []
    private var iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"])]
    private var makingOffer = false
    private var ignoreOffer = false
    private var initialOfferer = false
    private var polite = false
    private var callStartedAt: Date?

    private func publishActivity() {
        let label: String
        switch status {
        case .idle:
            GleanLiveCalls.shared.update(kind: "dm", state: nil)
            return
        case .incoming: label = "Incoming call"
        case .outgoing: label = "Calling…"
        case .connecting: label = "Connecting…"
        case .active: label = "Call in progress"
        }
        let privateTitle = auth?.account.flag("keepInformationSecret") == true
        GleanLiveCalls.shared.update(kind: "dm", state: .init(title: privateTitle || peerName.isEmpty ? "Glean call" : peerName, status: label, startedAt: callStartedAt, muted: muted, participants: nil))
    }
    static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    var canStart: Bool { status == .idle }
    var canUseApps: Bool { status == .active && conversationID != nil }

    func bind(auth: AuthStore) {
        guard self.auth !== auth else { return }
        eventSubscription?.cancel()
        eventTask?.cancel()
        self.auth = auth
        eventSubscription = auth.realtimeEvents.sink { [weak self] event in
            guard let self, event.event.hasPrefix("dm-call-") else { return }
            let previous = self.eventTask
            self.eventTask = Task { @MainActor [weak self] in
                await previous?.value
                guard !Task.isCancelled else { return }
                await self?.receive(event)
            }
        }
    }

    func placeCall(conversationID: Int, peerID: Int?, peerName: String, video: Bool = false) async {
        guard status == .idle, conversationID > 0, let auth else { return }
        self.conversationID = conversationID
        self.peerID = peerID
        self.localID = auth.account.number("id")
        self.peerName = peerName
        videoCall = video
        self.polite = self.localID > (peerID ?? 0)
        status = .outgoing
        error = nil
        do {
            try await requestMicrophone()
            try await auth.sendRealtime("dm-call-invite", payload: ["conversationId": conversationID, "video": video])
        } catch {
            self.error = error.localizedDescription
            reset(keepError: true)
        }
    }

    func accept() async {
        guard status == .incoming, !working, let conversationID, let auth else { return }
        working = true
        defer { working = false }
        do {
            try await requestMicrophone()
            try await auth.sendRealtime("dm-call-accept", payload: ["conversationId": conversationID])
        } catch {
            self.error = error.localizedDescription
            try? await auth.sendRealtime("dm-call-decline", payload: ["conversationId": conversationID])
            reset(keepError: true)
        }
    }

    func decline() {
        guard let conversationID else { return }
        Task { try? await auth?.sendRealtime("dm-call-decline", payload: ["conversationId": conversationID]) }
        reset()
    }

    func hangup() {
        if let conversationID { Task { try? await auth?.sendRealtime("dm-call-hangup", payload: ["conversationId": conversationID]) } }
        reset()
    }

    func dismissError() { error = nil }

    func toggleMute() {
        muted.toggle()
        audioTrack?.isEnabled = !muted
    }

    func toggleCamera() async {
        guard status == .active, !screenSharing, !screenShareStarting, let peerConnection else { return }
        if localCameraOn {
            stopCamera()
            sendCallState(["camera": false])
            return
        }
        do {
            try await requestCamera()
            let devices = RTCCameraVideoCapturer.captureDevices()
            guard let device = devices.first(where: { $0.position == .front }) ?? devices.first else {
                throw callError("No camera was found on this device.")
            }
            let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
            guard let format = formats.min(by: { videoFormatDistance($0) < videoFormatDistance($1) }) else {
                throw callError("This camera has no supported video format.")
            }
            let source = Self.factory.videoSource()
            source.adaptOutputFormat(toWidth: 640, height: 480, fps: 24)
            let track = Self.factory.videoTrack(with: source, trackId: "glean-dm-video-\(conversationID ?? 0)")
            let capturer = RTCCameraVideoCapturer(delegate: source)
            videoSource = source
            videoCapturer = capturer
            localVideoTrack = track
            localCameraOn = true
            videoSender = peerConnection.add(track, streamIds: ["glean-dm-call"])
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                capturer.startCapture(with: device, format: format, fps: 24) { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume() }
                }
            }
            videoCall = true
            sendCallState(["camera": true])
        } catch {
            stopCamera()
            self.error = error.localizedDescription
        }
    }

    func toggleScreenShare() {
        guard status == .active else { return }
        if screenSharing || screenShareStarting {
            stopScreenShare()
            return
        }

        error = nil
        if localCameraOn {
            stopCamera()
            sendCallState(["camera": false])
        }
        screenShareStarting = true
        let source = Self.factory.videoSource()
        screenVideoSource = source
        let capturer = RTCVideoCapturer(delegate: source)
        let capture = NativeScreenCaptureController(
            capturer: capturer,
            source: source,
            onStarted: { [weak self] in
                Task { @MainActor [weak self] in self?.screenShareDidStart() }
            },
            onStopped: { [weak self] in
                Task { @MainActor [weak self] in self?.finishScreenShare() }
            },
            onError: { [weak self] captureError in
                Task { @MainActor [weak self] in self?.finishScreenShare(error: captureError) }
            }
        )
        screenCapture = capture
        capture.start()
    }

    private func screenShareDidStart() {
        guard status == .active, screenShareStarting, let source = screenVideoSource, let peerConnection else {
            stopScreenShare(announce: false)
            return
        }
        let track = Self.factory.videoTrack(with: source, trackId: "glean-dm-screen-\(conversationID ?? 0)")
        guard let sender = peerConnection.add(track, streamIds: ["glean-dm-call"]) else {
            finishScreenShare(error: callError("Could not start screen sharing."))
            return
        }
        screenVideoTrack = track
        localVideoTrack = track
        videoSender = sender
        videoCall = true
        screenShareStarting = false
        screenSharing = true
        sendCallState(["camera": false, "sharing": true])
    }

    private func stopScreenShare(announce: Bool = true) {
        guard screenSharing || screenShareStarting || screenCapture != nil else { return }
        let capture = screenCapture
        screenCapture = nil
        capture?.stop()
        finishScreenShare(announce: announce)
    }

    private func finishScreenShare(error captureError: Error? = nil, announce: Bool = true) {
        guard screenSharing || screenShareStarting || screenCapture != nil else { return }
        screenCapture = nil
        screenVideoTrack?.isEnabled = false
        screenVideoTrack = nil
        screenVideoSource = nil
        screenShareStarting = false
        screenSharing = false
        localVideoTrack = nil
        videoSender?.track = nil
        videoSender = nil
        if announce { sendCallState(["camera": localCameraOn, "sharing": false]) }
        if let captureError { error = captureError.localizedDescription }
    }

    func toggleSpeaker() {
        speaker.toggle()
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        do {
            try session.overrideOutputAudioPort(speaker ? .speaker : .none)
            if speaker { try session.setActive(true) }
        } catch { self.error = "Could not change the audio output." }
    }

    private func requestMicrophone() async throws {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return
        case .denied:
            throw NSError(domain: "Glean", code: 403, userInfo: [NSLocalizedDescriptionKey: "Allow microphone access in Settings to make calls."])
        case .undetermined:
            let granted = await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            }
            guard granted else { throw NSError(domain: "Glean", code: 403, userInfo: [NSLocalizedDescriptionKey: "Microphone access is required for calls."]) }
        @unknown default:
            throw NSError(domain: "Glean", code: 403, userInfo: [NSLocalizedDescriptionKey: "Microphone access is unavailable."])
        }
    }

    private func receive(_ event: NativeRealtimeEvent) async {
        switch event.event {
        case "dm-call-invite":
            let id = event.payload.number("conversationId")
            guard id > 0 else { return }
            if event.payload.text("role") == "caller" {
                peerName = event.payload.object("peer").text("username").isEmpty ? peerName : event.payload.object("peer").text("username")
                videoCall = event.payload.flag("video")
                return
            }
            guard status == .idle else { return }
            conversationID = id
            let peer = event.payload.object("peer")
            peerID = peer.number("id")
            peerName = peer.text("username").isEmpty ? "Glean user" : peer.text("username")
            localID = auth?.account.number("id") ?? 0
            polite = localID > (peerID ?? 0)
            videoCall = event.payload.flag("video")
            status = .incoming
            error = nil
        case "dm-call-accepted":
            guard event.payload.number("conversationId") == conversationID else { return }
            guard peerConnection == nil, status != .connecting else { return }
            let acceptedConversationID = conversationID
            initialOfferer = event.payload.text("role") == "caller"
            let peer = event.payload.object("peer")
            if peer.number("id") > 0 { peerID = peer.number("id") }
            polite = localID > (peerID ?? 0)
            if !peer.text("username").isEmpty { peerName = peer.text("username") }
            status = .connecting
            do {
                try await refreshIceServers()
            } catch {
                if conversationID == acceptedConversationID { failCall("Could not load voice network settings. Please try the call again.") }
                return
            }
            guard conversationID == acceptedConversationID, status == .connecting else { return }
            await createPeerConnection()
        case "dm-call-signal":
            guard event.payload.number("conversationId") == conversationID else { return }
            await handleSignal(event.payload.object("signal"))
        case "dm-call-ended":
            guard event.payload.number("conversationId") == conversationID else { return }
            let reason = event.payload.text("reason")
            if reason == "timeout" { error = "No answer." }
            else if reason == "declined" { error = "Call declined." }
            else if reason == "busy" { error = "They’re already in a call." }
            else { error = nil }
            reset(keepError: true)
        case "dm-call-error":
            guard event.payload.number("conversationId") == conversationID else { return }
            error = event.payload.text("error")
            reset(keepError: true)
        default: break
        }
    }

    private func createPeerConnection() async {
        guard peerConnection == nil else { return }
        let rtcAudio = RTCAudioSession.sharedInstance()
        rtcAudio.lockForConfiguration()
        do {
            try rtcAudio.setCategory(.playAndRecord, with: [.allowBluetoothHFP, .defaultToSpeaker])
            try rtcAudio.setMode(.voiceChat)
        } catch {
            rtcAudio.unlockForConfiguration()
            failCall("Could not configure call audio.")
            return
        }
        rtcAudio.unlockForConfiguration()

        let configuration = RTCConfiguration()
        configuration.iceServers = iceServers
        configuration.iceCandidatePoolSize = 4
        configuration.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["DtlsSrtpKeyAgreement": kRTCMediaConstraintsValueTrue])
        guard let connection = Self.factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            failCall("Could not start the secure call connection.")
            return
        }
        peerConnection = connection
        let source = Self.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = Self.factory.audioTrack(with: source, trackId: "glean-audio")
        track.isEnabled = !muted
        audioTrack = track
        connection.add(track, streamIds: ["glean-call"])
        if let localVideoTrack { videoSender = connection.add(localVideoTrack, streamIds: ["glean-dm-call"]) }
    }

    private func refreshIceServers() async throws {
        guard let auth else { throw callError("Your Glean session ended. Sign in and try again.") }
        let setup = try await auth.request("api/voice/ice-servers")
        let provided = setup.records("iceServers").compactMap { server -> RTCIceServer? in
            let urls = server["urls"] as? [String] ?? (server.text("urls").isEmpty ? [] : [server.text("urls")])
            guard !urls.isEmpty else { return nil }
            return RTCIceServer(urlStrings: urls, username: server.text("username"), credential: server.text("credential"))
        }
        guard !provided.isEmpty else { throw callError("The voice network settings were empty.") }
        iceServers = provided
    }

    private func handleSignal(_ signal: Record) async {
        if let description = signal["description"] as? Record {
            await receiveDescription(description)
        } else if let value = signal["candidate"] as? Record,
                  let sdp = value["candidate"] as? String,
                  sdp.utf8.count <= 16_000,
                  let index = value["sdpMLineIndex"] as? Int, (0...16).contains(index) {
            guard !ignoreOffer else { return }
            let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32(index), sdpMid: value["sdpMid"] as? String)
            if let peerConnection, peerConnection.remoteDescription != nil { peerConnection.add(candidate) { _ in } }
            else { pendingCandidates.append(candidate) }
        } else if let state = signal["state"] as? Record {
            remoteSharingOn = state.flag("sharing")
        }
    }

    private func receiveDescription(_ value: Record) async {
        guard let peerConnection, let sdp = value["sdp"] as? String, sdp.utf8.count <= 32_000 else { return }
        guard ["offer", "answer"].contains(value.text("type")) else { return }
        let type = value["type"] as? String == "offer" ? RTCSdpType.offer : RTCSdpType.answer
        let offerCollision = type == .offer && (makingOffer || peerConnection.signalingState != .stable)
        ignoreOffer = offerCollision && !polite
        if ignoreOffer { return }
        let description = RTCSessionDescription(type: type, sdp: sdp)
        if offerCollision && polite {
            let rollbackError: Error? = await withCheckedContinuation { continuation in
                peerConnection.setLocalDescription(RTCSessionDescription(type: .rollback, sdp: "")) { continuation.resume(returning: $0) }
            }
            guard self.peerConnection === peerConnection else { return }
            guard rollbackError == nil else { failCall("Could not negotiate the call. Please try again."); return }
        }
        let remoteError: Error? = await withCheckedContinuation { continuation in
            peerConnection.setRemoteDescription(description) { continuation.resume(returning: $0) }
        }
        guard self.peerConnection === peerConnection else { return }
        guard remoteError == nil else { failCall("Call negotiation failed."); return }
        flushCandidates()
        if type == .offer { await makeAnswer() }
    }

    private func makeAnswer() async {
        guard let peerConnection else { return }
        let constraints = RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)
        let result: (RTCSessionDescription?, Error?) = await withCheckedContinuation { continuation in
            peerConnection.answer(for: constraints) { continuation.resume(returning: ($0, $1)) }
        }
        guard self.peerConnection === peerConnection else { return }
        guard let description = result.0, result.1 == nil else { failCall("Could not answer the call."); return }
        let localError: Error? = await withCheckedContinuation { continuation in
            peerConnection.setLocalDescription(description) { continuation.resume(returning: $0) }
        }
        guard self.peerConnection === peerConnection else { return }
        guard localError == nil else { failCall("Could not connect the call."); return }
        sendSignal(["description": ["type": "answer", "sdp": description.sdp]])
    }

    private func flushCandidates() {
        guard let peerConnection else { return }
        let candidates = pendingCandidates
        pendingCandidates.removeAll()
        candidates.forEach { peerConnection.add($0) { _ in } }
    }

    private func sendSignal(_ signal: Record) {
        guard let conversationID else { return }
        Task { try? await auth?.sendRealtime("dm-call-signal", payload: ["conversationId": conversationID, "signal": signal]) }
    }

    private func sendCallState(_ state: Record) {
        sendSignal(["state": state])
    }

    private func requestCamera() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else { throw callError("Allow camera access in Settings to turn on video.") }
        default: throw callError("Allow camera access in Settings to turn on video.")
        }
    }

    private func videoFormatDistance(_ format: AVCaptureDevice.Format) -> Int {
        let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        return abs(Int(dimensions.width) * Int(dimensions.height) - 640 * 480)
    }

    private func callError(_ message: String) -> NSError {
        NSError(domain: "GleanCall", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func stopCamera() {
        videoCapturer?.stopCapture()
        videoCapturer = nil
        videoSource = nil
        localVideoTrack?.isEnabled = false
        localVideoTrack = nil
        localCameraOn = false
        videoSender?.track = nil
        videoSender = nil
    }

    private func reset(keepError: Bool = false) {
        stopScreenShare(announce: false)
        peerConnection?.close()
        peerConnection = nil
        audioTrack?.isEnabled = false
        audioTrack = nil
        stopCamera()
        remoteVideoTrack = nil
        remoteSharingOn = false
        videoCall = false
        pendingCandidates.removeAll()
        makingOffer = false
        ignoreOffer = false
        initialOfferer = false
        conversationID = nil
        peerID = nil
        appsStore = nil
        showingApps = false
        peerName = ""
        muted = false
        speaker = false
        localCameraOn = false
        status = .idle
        if !keepError { error = nil }
        RTCAudioSession.sharedInstance().audioSessionDidDeactivate(AVAudioSession.sharedInstance())
    }

    private func failCall(_ message: String) {
        error = message
        if let conversationID { Task { try? await auth?.sendRealtime("dm-call-hangup", payload: ["conversationId": conversationID]) } }
        reset(keepError: true)
    }

    private func prepareAppsStore() {
        guard let auth, let conversationID else { return }
        appsStore = NativeAppsStore(auth: auth, scopeKey: "d:\(conversationID)")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) { }
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        Task { @MainActor [weak self] in self?.createOffer(for: peerConnection) }
    }

    private func createOffer(for peerConnection: RTCPeerConnection) {
        guard self.peerConnection === peerConnection, !makingOffer, peerConnection.signalingState == .stable else { return }
        guard initialOfferer || peerConnection.remoteDescription != nil else { return }
        makingOffer = true
        let constraints = RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)
        peerConnection.offer(for: constraints) { [weak self, weak peerConnection] description, error in
            guard let self, let peerConnection, let description, error == nil else {
                Task { @MainActor in self?.makingOffer = false; self?.failCall("Could not start the call.") }
                return
            }
            peerConnection.setLocalDescription(description) { error in
                Task { @MainActor in
                    self.makingOffer = false
                    guard error == nil else { self.failCall("Could not connect the call."); return }
                    self.sendSignal(["description": ["type": "offer", "sdp": description.sdp]])
                }
            }
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Task { @MainActor in
            guard self.peerConnection === peerConnection else { return }
            switch newState {
            case .connected, .completed:
                status = .active
                if appsStore == nil { prepareAppsStore() }
            case .failed: failCall("The call connection failed.")
            default: break
            }
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        var json: Record = ["candidate": candidate.sdp, "sdpMLineIndex": Int(candidate.sdpMLineIndex)]
        json["sdpMid"] = candidate.sdpMid
        Task { @MainActor [weak self] in self?.sendSignal(["candidate": json]) }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd receiver: RTCRtpReceiver, streams: [RTCMediaStream]) {
        guard let track = receiver.track as? RTCVideoTrack else { return }
        Task { @MainActor [weak self] in
            guard let self, self.peerConnection === peerConnection else { return }
            self.remoteVideoTrack = track
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove receiver: RTCRtpReceiver) {
        guard receiver.track is RTCVideoTrack else { return }
        Task { @MainActor [weak self] in
            guard let self, self.peerConnection === peerConnection else { return }
            self.remoteVideoTrack = nil
            self.remoteSharingOn = false
        }
    }
}

struct NativeCallBanner: View {
    @ObservedObject var calls: NativeCallCoordinator

    var body: some View {
        VStack(spacing: 12) {
            if calls.status == .active && (calls.videoCall || calls.localVideoTrack != nil || calls.remoteVideoTrack != nil) {
                ZStack(alignment: .bottomTrailing) {
                    if let remote = calls.remoteVideoTrack {
                        NativeRTCVideoPreview(track: remote).frame(maxWidth: .infinity).frame(height: 190)
                            .overlay(alignment: .topLeading) {
                                if calls.remoteSharingOn {
                                    Label("Sharing screen", systemImage: "rectangle.on.rectangle")
                                        .font(.caption.weight(.semibold)).padding(8)
                                        .background(.black.opacity(0.58), in: Capsule()).foregroundStyle(.white)
                                        .padding(10)
                                }
                            }
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: calls.remoteSharingOn ? "rectangle.on.rectangle" : "video.slash.fill").font(.title2)
                            Text(calls.remoteSharingOn ? "Waiting for their screen…" : "Turn on your camera to share video")
                                .font(.caption).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).frame(height: 190)
                        .background(GleanStyle.ink, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                    if calls.localCameraOn, let local = calls.localVideoTrack {
                        NativeRTCVideoPreview(track: local).frame(width: 76, height: 104)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.7), lineWidth: 1) }
                            .padding(10)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            HStack(spacing: 12) {
                Image(systemName: calls.status == .incoming ? "phone.arrow.down.left.fill" : "phone.fill")
                    .font(.title3).foregroundStyle(GleanStyle.blue).frame(width: 42, height: 42)
                    .background(GleanStyle.blue.opacity(0.13), in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(calls.status == .idle ? "Call" : calls.status == .incoming ? "Incoming call" : calls.status == .outgoing ? "Calling…" : calls.status == .connecting ? "Connecting…" : "In call")
                        .font(.subheadline.weight(.semibold))
                    Text(calls.error ?? calls.peerName).font(.caption).foregroundStyle(calls.error == nil ? Color.secondary : Color.red).lineLimit(2)
                }
                Spacer(minLength: 4)
                if calls.status == .idle {
                    Button { calls.dismissError() } label: { Image(systemName: "xmark").frame(width: 40, height: 40) }.accessibilityLabel("Dismiss call message")
                } else if calls.status == .incoming {
                    Button { Task { await calls.accept() } } label: { if calls.working { ProgressView().frame(width: 42, height: 42) } else { Image(systemName: "phone.fill").frame(width: 42, height: 42).background(.green, in: Circle()).foregroundStyle(.white) } }.disabled(calls.working).accessibilityLabel("Accept call")
                    Button { calls.decline() } label: { Image(systemName: "phone.down.fill").frame(width: 42, height: 42).background(.red, in: Circle()).foregroundStyle(.white) }.accessibilityLabel("Decline call")
                } else {
                    Button { calls.toggleSpeaker() } label: { Image(systemName: calls.speaker ? "speaker.wave.3.fill" : "speaker.fill").frame(width: 36, height: 40) }.accessibilityLabel(calls.speaker ? "Use receiver" : "Use speaker")
                    Button { calls.toggleMute() } label: { Image(systemName: calls.muted ? "mic.slash.fill" : "mic.fill").frame(width: 36, height: 40) }.accessibilityLabel(calls.muted ? "Unmute microphone" : "Mute microphone")
                    Button { Task { await calls.toggleCamera() } } label: { Image(systemName: calls.localCameraOn ? "video.fill" : "video").frame(width: 36, height: 40) }
                        .disabled(calls.status != .active || calls.screenSharing || calls.screenShareStarting).accessibilityLabel(calls.localCameraOn ? "Turn camera off" : "Turn camera on")
                    Button { calls.toggleScreenShare() } label: {
                        Group {
                            if calls.screenShareStarting { ProgressView().frame(width: 36, height: 40) }
                            else { Image(systemName: calls.screenSharing ? "stop.fill" : "rectangle.on.rectangle").frame(width: 36, height: 40) }
                        }
                    }
                    .foregroundStyle(calls.screenSharing ? GleanStyle.blue : Color.primary)
                    .disabled(calls.status != .active).accessibilityLabel(calls.screenSharing ? "Stop sharing screen" : calls.screenShareStarting ? "Cancel screen share" : "Share screen")
                    Button { calls.hangup() } label: { Image(systemName: "phone.down.fill").frame(width: 42, height: 42).background(.red, in: Circle()).foregroundStyle(.white) }.accessibilityLabel("End call")
                }
            }
            if calls.canUseApps {
                Button { calls.showingApps = true } label: {
                    Label("Apps", systemImage: "square.grid.2x2.fill")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(GleanStyle.blue.opacity(0.13), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .accessibilityHint("Open shared apps for this call")
            }
        }
        .padding(12)
        .gleanGlassCard(cornerRadius: 20)
        .shadow(color: .black.opacity(0.14), radius: 14, y: 4)
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .sheet(isPresented: $calls.showingApps) {
            if let apps = calls.appsStore {
                NativeAppsShelfView(apps: apps)
            }
        }
    }
}
