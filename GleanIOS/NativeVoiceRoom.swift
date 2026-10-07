import AVFAudio
import AVFoundation
import Combine
import CoreMedia
import SwiftUI
@preconcurrency import WebRTC
#if canImport(ReplayKit)
import ReplayKit
#endif
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

private struct NativeVoiceParticipant: Identifiable {
    let id: Int
    var username: String
    var avatarUrl: String?
    var muted: Bool
    var deafened: Bool
    var camera: Bool
    var sharing: Bool
    var speaking: Bool
}

@MainActor
private final class NativeVoiceRoomModel: NSObject, ObservableObject, @preconcurrency RTCPeerConnectionDelegate {
    @Published private(set) var participants: [NativeVoiceParticipant] = [] { didSet { publishActivity() } }
    @Published private(set) var joined = false {
        didSet {
            if joined, voiceStartedAt == nil { voiceStartedAt = Date() }
            if !joined { voiceStartedAt = nil }
            publishActivity()
        }
    }
    @Published private(set) var connecting = false
    @Published private(set) var muted = false { didSet { publishActivity() } }
    @Published private(set) var deafened = false
    @Published private(set) var speaker = false
    @Published private(set) var cameraOn = false
    @Published private(set) var sharing = false
    @Published private(set) var screenShareStarting = false
    @Published private(set) var error: String?
    @Published private(set) var videoTracks: [Int: RTCVideoTrack] = [:]
    @Published private(set) var peerVolumes: [Int: Double]

    private let auth: AuthStore
    private let serverID: Int
    private let channelID: Int
    private let localID: Int
    private var voiceStartedAt: Date?
    private var voiceTitle = "Glean voice channel"

    func setActivityTitle(_ title: String) {
        voiceTitle = title
        publishActivity()
    }
    private func publishActivity() {
        let title = auth.account.flag("keepInformationSecret") ? "Glean voice channel" : voiceTitle
        GleanLiveCalls.shared.update(kind: "voice-\(serverID)-\(channelID)", state: joined ? .init(title: title, status: "Voice channel", startedAt: voiceStartedAt, muted: muted, participants: max(1, participants.count)) : nil)
    }
    private var subscription: AnyCancellable?
    private var audioTrack: RTCAudioTrack?
    private var videoSource: RTCVideoSource?
    private var videoCapturer: RTCCameraVideoCapturer?
    private var localVideoTrack: RTCVideoTrack?
    private var screenVideoSource: RTCVideoSource?
    private var screenVideoTrack: RTCVideoTrack?
    private var screenCapture: NativeScreenCaptureController?
    private var connections: [Int: RTCPeerConnection] = [:]
    private var videoSenders: [Int: RTCRtpSender] = [:]
    private var remoteAudioTracks: [Int: RTCAudioTrack] = [:]
    private var pendingICE: [Int: [RTCIceCandidate]] = [:]
    private var makingOffer: Set<Int> = []
    private var iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"])]

    init(auth: AuthStore, serverID: Int, channelID: Int) {
        self.auth = auth
        self.serverID = serverID
        self.channelID = channelID
        self.localID = auth.account.number("id")
        let saved = UserDefaults.standard.dictionary(forKey: "glean:voice-person-volumes") ?? [:]
        self.peerVolumes = Dictionary(uniqueKeysWithValues: saved.compactMap { key, value in
            guard let id = Int(key), let number = value as? NSNumber else { return nil }
            return (id, min(100, max(0, number.doubleValue)))
        })
    }

    func volume(for participantID: Int) -> Double { peerVolumes[participantID] ?? 100 }

    func setVolume(_ value: Double, for participantID: Int) {
        guard participantID != localID, value.isFinite else { return }
        let next = min(100, max(0, value))
        peerVolumes[participantID] = next
        remoteAudioTracks[participantID]?.source.volume = next / 100
        UserDefaults.standard.set(Dictionary(uniqueKeysWithValues: peerVolumes.map { (String($0.key), $0.value) }), forKey: "glean:voice-person-volumes")
    }

    func join() async {
        guard !joined, !connecting else { return }
        connecting = true
        error = nil
        defer { connecting = false }
        do {
            if subscription == nil {
                subscription = auth.realtimeEvents
                    .filter { [serverID, channelID] event in
                        event.event == "connected" || (event.payload.number("serverId") == serverID && event.payload.number("channelId") == channelID && ["voice-presence", "voice-state", "voice-signal", "voice-error"].contains(event.event))
                    }
                    .sink { [weak self] event in Task { @MainActor [weak self] in await self?.receive(event) } }
            }

            switch AVAudioApplication.shared.recordPermission {
            case .granted: break
            case .denied: throw callError("Allow microphone access in Settings to join voice chat.")
            case .undetermined:
                let allowed = await withCheckedContinuation { continuation in
                    AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
                }
                guard allowed else { throw callError("Microphone access is required to join voice chat.") }
            @unknown default: throw callError("Microphone access is unavailable.")
            }

            let setup = try await auth.request("api/voice/ice-servers")
            let provided = setup.records("iceServers").compactMap { server -> RTCIceServer? in
                let urls = server["urls"] as? [String] ?? (server.text("urls").isEmpty ? [] : [server.text("urls")])
                guard !urls.isEmpty else { return nil }
                return RTCIceServer(urlStrings: urls, username: server.text("username"), credential: server.text("credential"))
            }
            if !provided.isEmpty { iceServers = provided }

            let rtcAudio = RTCAudioSession.sharedInstance()
            rtcAudio.lockForConfiguration()
            do {
                try rtcAudio.setCategory(.playAndRecord, with: [.allowBluetoothHFP, .defaultToSpeaker])
                try rtcAudio.setMode(.voiceChat)
                try rtcAudio.setActive(true)
            } catch {
                rtcAudio.unlockForConfiguration()
                throw callError("Could not configure voice audio.")
            }
            rtcAudio.unlockForConfiguration()
            rtcAudio.audioSessionDidActivate(AVAudioSession.sharedInstance())

            let source = NativeCallCoordinator.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
            audioTrack = NativeCallCoordinator.factory.audioTrack(with: source, trackId: "glean-voice-\(serverID)-\(channelID)")
            audioTrack?.isEnabled = !muted && !deafened
            try await joinRoom()
        } catch {
            self.error = error.localizedDescription
            cleanup()
        }
    }

    func leave() {
        if joined { Task { try? await auth.sendRealtime("voice-leave", payload: ["serverId": serverID, "channelId": channelID]) } }
        joined = false
        participants = []
        cleanup()
    }

    func toggleMute() {
        muted.toggle()
        audioTrack?.isEnabled = !muted && !deafened
        sendState()
    }

    func toggleDeafen() {
        deafened.toggle()
        if deafened { muted = true }
        audioTrack?.isEnabled = !muted && !deafened
        sendState()
    }

    func toggleCamera() async {
        guard joined, !sharing, !screenShareStarting else { return }
        if localVideoTrack != nil {
            stopCamera()
            sendState()
            return
        }
        do {
            try await requestCameraPermission()
            let devices = RTCCameraVideoCapturer.captureDevices()
            guard let device = devices.first(where: { $0.position == .front }) ?? devices.first else {
                throw callError("No camera was found on this device.")
            }
            let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
            guard let format = formats.min(by: { formatSizeDistance($0) < formatSizeDistance($1) }) else {
                throw callError("This camera has no supported video format.")
            }

            let source = NativeCallCoordinator.factory.videoSource()
            source.adaptOutputFormat(toWidth: 640, height: 480, fps: 24)
            let track = NativeCallCoordinator.factory.videoTrack(with: source, trackId: "glean-camera-\(serverID)-\(channelID)")
            let capturer = RTCCameraVideoCapturer(delegate: source)
            videoSource = source
            videoCapturer = capturer
            localVideoTrack = track
            cameraOn = true
            videoTracks[localID] = track
            setLocalVideoTrack(track)
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                capturer.startCapture(with: device, format: format, fps: 24) { captureError in
                    if let captureError { continuation.resume(throwing: captureError) }
                    else { continuation.resume() }
                }
            }
            sendState()
        } catch {
            stopCamera()
            self.error = error.localizedDescription
        }
    }

    func switchCamera() async {
        guard joined, let capturer = videoCapturer, let source = videoSource,
              let currentInput = capturer.captureSession.inputs.compactMap({ $0 as? AVCaptureDeviceInput }).first else { return }
        let devices = RTCCameraVideoCapturer.captureDevices()
        guard let device = devices.first(where: { $0.position != currentInput.device.position }) else {
            error = "No other camera is available on this device."
            return
        }
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        guard let format = formats.min(by: { formatSizeDistance($0) < formatSizeDistance($1) }) else {
            error = "This camera has no supported video format."
            return
        }
        do {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                capturer.stopCapture { continuation.resume() }
            }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                capturer.startCapture(with: device, format: format, fps: 24) { captureError in
                    if let captureError { continuation.resume(throwing: captureError) }
                    else { continuation.resume() }
                }
            }
            source.adaptOutputFormat(toWidth: 640, height: 480, fps: 24)
            error = nil
        } catch {
            self.error = "Could not switch cameras. Try turning the camera off and on."
        }
    }

    func toggleSpeaker() {
        speaker.toggle()
        let rtcAudio = RTCAudioSession.sharedInstance()
        rtcAudio.lockForConfiguration()
        defer { rtcAudio.unlockForConfiguration() }
        do { try rtcAudio.overrideOutputAudioPort(speaker ? .speaker : .none) }
        catch { self.error = "Could not change the audio output."; speaker.toggle() }
    }

    func toggleScreenShare() {
        guard joined else { return }
        if sharing || screenShareStarting {
            stopScreenShare()
            return
        }

        error = nil
        if cameraOn { stopCamera() }
        screenShareStarting = true
        let source = NativeCallCoordinator.factory.videoSource()
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
        guard joined, screenShareStarting, let source = screenVideoSource else {
            stopScreenShare()
            return
        }
        let track = NativeCallCoordinator.factory.videoTrack(with: source, trackId: "glean-screen-\(serverID)-\(channelID)")
        screenVideoTrack = track
        videoTracks[localID] = track
        setLocalVideoTrack(track)
        screenShareStarting = false
        sharing = true
        sendState()
    }

    private func stopScreenShare() {
        guard screenShareStarting || sharing || screenCapture != nil else { return }
        let capture = screenCapture
        screenCapture = nil
        capture?.stop()
        finishScreenShare()
    }

    private func finishScreenShare(error captureError: Error? = nil) {
        guard screenShareStarting || sharing || screenCapture != nil else { return }
        screenCapture = nil
        screenVideoTrack?.isEnabled = false
        screenVideoTrack = nil
        screenVideoSource = nil
        screenShareStarting = false
        sharing = false
        videoTracks.removeValue(forKey: localID)
        setLocalVideoTrack(nil)
        if let captureError { error = captureError.localizedDescription }
        sendState()
    }

    private func joinRoom() async throws {
        try await auth.sendRealtime("voice-join", payload: ["serverId": serverID, "channelId": channelID])
        joined = true
        sendState()
    }

    private func sendState() {
        guard joined else { return }
        Task {
            try? await auth.sendRealtime("voice-state", payload: [
                "serverId": serverID, "channelId": channelID,
                "muted": muted, "deafened": deafened,
                "camera": cameraOn, "sharing": sharing, "speaking": false
            ])
        }
    }

    private func receive(_ event: NativeRealtimeEvent) async {
        if event.event == "connected" {
            guard joined else { return }
            closeConnections()
            joined = false
            do { try await joinRoom() }
            catch { self.error = "Reconnecting to voice failed. Leave and rejoin." }
            return
        }
        switch event.event {
        case "voice-error":
            error = event.payload.text("error").isEmpty ? "Unable to join this voice channel." : event.payload.text("error")
            joined = false
            cleanup()
        case "voice-presence":
            let next = event.payload.records("participants").compactMap { row -> NativeVoiceParticipant? in
                let id = row.number("id")
                guard id > 0 else { return nil }
                return NativeVoiceParticipant(id: id, username: row.text("username"), avatarUrl: row["avatarUrl"] as? String, muted: row.flag("muted"), deafened: row.flag("deafened"), camera: row.flag("camera"), sharing: row.flag("sharing"), speaking: row.flag("speaking"))
            }
            participants = next.sorted { $0.id == localID ? true : ($1.id == localID ? false : $0.username.localizedCaseInsensitiveCompare($1.username) == .orderedAscending) }
            let ids = Set(next.map(\.id).filter { $0 != localID })
            let removedIDs = connections.keys.filter { !ids.contains($0) }
            for id in removedIDs { connections[id]?.close(); connections.removeValue(forKey: id); videoSenders.removeValue(forKey: id); videoTracks.removeValue(forKey: id); remoteAudioTracks.removeValue(forKey: id); pendingICE.removeValue(forKey: id); makingOffer.remove(id) }
            for member in next where member.id != localID { _ = peerConnection(for: member.id) }
        case "voice-state":
            let memberID = event.payload.number("userId")
            guard let index = participants.firstIndex(where: { $0.id == memberID }) else { return }
            participants[index].muted = event.payload.flag("muted")
            participants[index].deafened = event.payload.flag("deafened")
            participants[index].camera = event.payload.flag("camera")
            participants[index].sharing = event.payload.flag("sharing")
            participants[index].speaking = event.payload.flag("speaking")
        case "voice-signal":
            await receiveSignal(event.payload)
        default: break
        }
    }

    private func peerConnection(for id: Int) -> RTCPeerConnection? {
        guard id > 0, id != localID else { return nil }
        if let existing = connections[id] { return existing }
        let configuration = RTCConfiguration()
        configuration.iceServers = iceServers
        configuration.iceCandidatePoolSize = 4
        configuration.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["DtlsSrtpKeyAgreement": kRTCMediaConstraintsValueTrue])
        guard let connection = NativeCallCoordinator.factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            error = "Could not create a voice connection."
            return nil
        }
        connections[id] = connection
        if let audioTrack { connection.add(audioTrack, streamIds: ["glean-voice-\(serverID)-\(channelID)"]) }
        if let outgoingVideoTrack = screenVideoTrack ?? localVideoTrack,
           let sender = connection.add(outgoingVideoTrack, streamIds: ["glean-video-\(serverID)-\(channelID)"]) {
            videoSenders[id] = sender
        }
        return connection
    }

    private func receiveSignal(_ payload: Record) async {
        let fromID = payload.number("fromId")
        guard fromID > 0, fromID != localID, let signal = payload["signal"] as? Record, let connection = peerConnection(for: fromID) else { return }
        if let descriptionValue = signal["description"] as? Record,
           let sdp = descriptionValue["sdp"] as? String, sdp.utf8.count <= 32_000 {
            let type = descriptionValue["type"] as? String == "offer" ? RTCSdpType.offer : RTCSdpType.answer
            let collision = type == .offer && (makingOffer.contains(fromID) || connection.signalingState != .stable)
            let polite = localID > fromID
            if collision && !polite { return }
            let description = RTCSessionDescription(type: type, sdp: sdp)
            let applyRemote = { [weak self, weak connection] in
                guard let self, let connection else { return }
                connection.setRemoteDescription(description) { error in
                    Task { @MainActor in
                        guard error == nil else { self.error = "Voice negotiation failed."; return }
                        self.flushCandidates(fromID)
                        if type == .offer { self.makeAnswer(connection, peerID: fromID) }
                    }
                }
            }
            if collision && polite { connection.setLocalDescription(RTCSessionDescription(type: .rollback, sdp: "")) { _ in applyRemote() } }
            else { applyRemote() }
        } else if let candidateValue = signal["candidate"] as? Record,
                  let sdp = candidateValue["candidate"] as? String, !sdp.isEmpty, sdp.utf8.count <= 16_000,
                  let index = candidateValue["sdpMLineIndex"] as? Int, (0...16).contains(index) {
            let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32(index), sdpMid: candidateValue["sdpMid"] as? String)
            if connection.remoteDescription != nil { connection.add(candidate) { _ in } }
            else if (pendingICE[fromID]?.count ?? 0) < 128 { pendingICE[fromID, default: []].append(candidate) }
        }
    }

    private func makeOffer(_ connection: RTCPeerConnection, peerID: Int) {
        guard connections[peerID] === connection, !makingOffer.contains(peerID) else { return }
        makingOffer.insert(peerID)
        let constraints = RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)
        connection.offer(for: constraints) { [weak self, weak connection] description, error in
            guard let self, let connection, let description, error == nil else {
                Task { @MainActor in self?.makingOffer.remove(peerID); self?.error = "Could not start the voice connection." }
                return
            }
            connection.setLocalDescription(description) { error in
                Task { @MainActor in
                    self.makingOffer.remove(peerID)
                    guard error == nil else { self.error = "Could not negotiate voice audio."; return }
                    self.sendSignal(peerID, ["description": ["type": "offer", "sdp": description.sdp]])
                }
            }
        }
    }

    private func makeAnswer(_ connection: RTCPeerConnection, peerID: Int) {
        let constraints = RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)
        connection.answer(for: constraints) { [weak self, weak connection] description, error in
            guard let self, let connection, let description, error == nil else {
                Task { @MainActor in self?.error = "Could not answer the voice connection." }
                return
            }
            connection.setLocalDescription(description) { error in
                Task { @MainActor in
                    guard error == nil else { self.error = "Could not negotiate voice audio."; return }
                    self.sendSignal(peerID, ["description": ["type": "answer", "sdp": description.sdp]])
                }
            }
        }
    }

    private func flushCandidates(_ peerID: Int) {
        guard let connection = connections[peerID] else { return }
        let candidates = pendingICE.removeValue(forKey: peerID) ?? []
        candidates.forEach { connection.add($0) { _ in } }
    }

    private func sendSignal(_ peerID: Int, _ signal: Record) {
        Task { try? await auth.sendRealtime("voice-signal", payload: ["serverId": serverID, "channelId": channelID, "targetId": peerID, "signal": signal]) }
    }

    private func cleanup() {
        joined = false
        subscription?.cancel()
        subscription = nil
        stopScreenShare()
        stopCamera()
        audioTrack?.isEnabled = false
        audioTrack = nil
        closeConnections()
        let rtcAudio = RTCAudioSession.sharedInstance()
        rtcAudio.lockForConfiguration()
        try? rtcAudio.setActive(false)
        rtcAudio.unlockForConfiguration()
        rtcAudio.audioSessionDidDeactivate(AVAudioSession.sharedInstance())
        muted = false
        deafened = false
        speaker = false
        cameraOn = false
    }

    private func closeConnections() {
        connections.values.forEach { $0.close() }
        connections.removeAll()
        videoSenders.removeAll()
        remoteAudioTracks.removeAll()
        videoTracks = videoTracks.filter { $0.key == localID }
        pendingICE.removeAll()
        makingOffer.removeAll()
    }

    private func callError(_ message: String) -> NSError { NSError(domain: "GleanVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }

    private func requestCameraPermission() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return
        case .notDetermined:
            let allowed = await AVCaptureDevice.requestAccess(for: .video)
            guard allowed else { throw callError("Allow camera access in Settings to turn on video.") }
        default: throw callError("Allow camera access in Settings to turn on video.")
        }
    }

    private func formatSizeDistance(_ format: AVCaptureDevice.Format) -> Int {
        let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        return abs(Int(dimensions.width) * Int(dimensions.height) - 640 * 480)
    }

    private func stopCamera() {
        videoCapturer?.stopCapture()
        videoCapturer = nil
        videoSource = nil
        localVideoTrack?.isEnabled = false
        localVideoTrack = nil
        cameraOn = false
        if screenVideoTrack == nil { videoTracks.removeValue(forKey: localID) }
        setLocalVideoTrack(screenVideoTrack)
    }

    private func setLocalVideoTrack(_ track: RTCVideoTrack?) {
        for (peerID, connection) in connections {
            if let sender = videoSenders[peerID] {
                sender.track = track
            } else if let track,
                      let sender = connection.add(track, streamIds: ["glean-video-\(serverID)-\(channelID)"]) {
                videoSenders[peerID] = sender
            }
        }
    }

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        Task { @MainActor [weak self] in
            guard let self, let id = self.connections.first(where: { $0.value === peerConnection })?.key else { return }
            self.makeOffer(peerConnection, peerID: id)
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        var value: Record = ["candidate": candidate.sdp, "sdpMLineIndex": Int(candidate.sdpMLineIndex)]
        value["sdpMid"] = candidate.sdpMid
        Task { @MainActor [weak self] in
            guard let self, let peerID = self.connections.first(where: { $0.value === peerConnection })?.key else { return }
            self.sendSignal(peerID, ["candidate": value])
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        if newState == .failed { Task { @MainActor [weak self] in self?.error = "Voice connection failed. Leave and rejoin, or check the network." } }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) { }
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd receiver: RTCRtpReceiver, streams: [RTCMediaStream]) {
        guard let peerID = connections.first(where: { $0.value === peerConnection })?.key else { return }
        if let audio = receiver.track as? RTCAudioTrack {
            Task { @MainActor [weak self] in
                guard let self, self.connections[peerID] === peerConnection else { return }
                self.remoteAudioTracks[peerID] = audio
                audio.source.volume = self.volume(for: peerID) / 100
            }
            return
        }
        guard let track = receiver.track as? RTCVideoTrack else { return }
        Task { @MainActor [weak self] in
            guard let self, let peerID = self.connections.first(where: { $0.value === peerConnection })?.key else { return }
            self.videoTracks[peerID] = track
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove receiver: RTCRtpReceiver) {
        guard let peerID = connections.first(where: { $0.value === peerConnection })?.key else { return }
        if receiver.track is RTCAudioTrack {
            Task { @MainActor [weak self] in self?.remoteAudioTracks.removeValue(forKey: peerID) }
        } else if receiver.track is RTCVideoTrack {
            Task { @MainActor [weak self] in self?.videoTracks.removeValue(forKey: peerID) }
        }
    }
}

final class NativeScreenCaptureController {
    private let capturer: RTCVideoCapturer
    private let source: RTCVideoSource
    private let onStarted: () -> Void
    private let onStopped: () -> Void
    private let onError: (Error) -> Void
    #if canImport(ScreenCaptureKit)
    private var screenCaptureKit: AnyObject?
    #endif
    #if canImport(ReplayKit)
    private var replayKit: NativeReplayKitScreenCapture?
    #endif

    init(capturer: RTCVideoCapturer, source: RTCVideoSource, onStarted: @escaping () -> Void, onStopped: @escaping () -> Void, onError: @escaping (Error) -> Void) {
        self.capturer = capturer
        self.source = source
        self.onStarted = onStarted
        self.onStopped = onStopped
        self.onError = onError
    }

    func start() {
        #if canImport(ScreenCaptureKit)
        if #available(iOS 27.0, *) {
            let capture = NativeScreenCaptureKitCapture(capturer: capturer, source: source, onStarted: onStarted, onStopped: onStopped, onError: onError)
            screenCaptureKit = capture
            capture.start()
            return
        }
        #endif
        #if canImport(ReplayKit)
        let capture = NativeReplayKitScreenCapture(capturer: capturer, source: source, onStarted: onStarted, onStopped: onStopped, onError: onError)
        replayKit = capture
        capture.start()
        #else
        onError(NSError(domain: "GleanVoice", code: 2, userInfo: [NSLocalizedDescriptionKey: "Screen sharing is unavailable on this device."]))
        #endif
    }

    func stop() {
        #if canImport(ScreenCaptureKit)
        if #available(iOS 27.0, *) {
            (screenCaptureKit as? NativeScreenCaptureKitCapture)?.stop()
            screenCaptureKit = nil
        }
        #endif
        #if canImport(ReplayKit)
        replayKit?.stop()
        replayKit = nil
        #endif
    }
}

private final class NativeCapturedVideoFrames {
    private let capturer: RTCVideoCapturer
    private let source: RTCVideoSource
    private let formatLock = NSLock()
    private var configuredSize = CGSize.zero

    init(capturer: RTCVideoCapturer, source: RTCVideoSource) {
        self.capturer = capturer
        self.source = source
    }

    func push(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer), let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        formatLock.lock()
        if configuredSize != CGSize(width: width, height: height) {
            let scale = min(1, min(1280 / CGFloat(width), 720 / CGFloat(height)))
            source.adaptOutputFormat(toWidth: Int32(max(2, Int(CGFloat(width) * scale))), height: Int32(max(2, Int(CGFloat(height) * scale))), fps: 15)
            configuredSize = CGSize(width: width, height: height)
        }
        formatLock.unlock()
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timestamp: Int64
        if presentationTime.isValid && !presentationTime.isIndefinite {
            timestamp = CMTimeConvertScale(presentationTime, timescale: 1_000_000_000, method: .default).value
        } else {
            timestamp = Int64(DispatchTime.now().uptimeNanoseconds)
        }
        let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixelBuffer), rotation: ._0, timeStampNs: timestamp)
        capturer.delegate?.capturer(capturer, didCapture: frame)
    }
}

#if canImport(ScreenCaptureKit)
@available(iOS 27.0, *)
private final class NativeScreenCaptureKitCapture: NSObject, SCContentSharingPickerObserver, SCStreamDelegate, SCStreamOutput {
    private let output: NativeCapturedVideoFrames
    private let onStarted: () -> Void
    private let onStopped: () -> Void
    private let onError: (Error) -> Void
    private let frameQueue = DispatchQueue(label: "com.glean.voice.screen-frames", qos: .userInteractive)
    private var stream: SCStream?
    private var finished = false

    init(capturer: RTCVideoCapturer, source: RTCVideoSource, onStarted: @escaping () -> Void, onStopped: @escaping () -> Void, onError: @escaping (Error) -> Void) {
        self.output = NativeCapturedVideoFrames(capturer: capturer, source: source)
        self.onStarted = onStarted
        self.onStopped = onStopped
        self.onError = onError
    }

    func start() {
        let picker = SCContentSharingPicker.shared
        guard picker.isAvailable else {
            onError(NSError(domain: "GleanVoice", code: 3, userInfo: [NSLocalizedDescriptionKey: "Screen sharing is unavailable right now."]))
            return
        }
        var configuration = picker.defaultConfiguration
        configuration.showsMicrophoneControl = false
        configuration.showsCameraControl = false
        picker.defaultConfiguration = configuration
        picker.add(self)
        picker.isActive = true
        picker.present()
    }

    func stop() {
        finish()
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        DispatchQueue.main.async { [weak self] in self?.finish() }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        DispatchQueue.main.async { [weak self] in self?.startStream(using: filter) }
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        DispatchQueue.main.async { [weak self] in self?.finish(error: error) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in self?.finish(error: error) }
    }

    private func startStream(using filter: SCContentFilter) {
        guard !finished else { return }
        let configuration = SCStreamConfiguration()
        let sourceWidth = max(2, Int(filter.contentRect.width * CGFloat(filter.pointPixelScale)))
        let sourceHeight = max(2, Int(filter.contentRect.height * CGFloat(filter.pointPixelScale)))
        let scale = min(1, min(1280 / CGFloat(sourceWidth), 720 / CGFloat(sourceHeight)))
        configuration.width = max(2, Int(CGFloat(sourceWidth) * scale))
        configuration.height = max(2, Int(CGFloat(sourceHeight) * scale))
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: frameQueue)
        } catch {
            finish(error: error)
            return
        }
        self.stream = stream
        stream.startCapture { [weak self] error in
            DispatchQueue.main.async {
                guard let self, !self.finished else { return }
                if let error { self.finish(error: error) }
                else { self.onStarted() }
            }
        }
    }

    private func finish(error: Error? = nil) {
        guard !finished else { return }
        finished = true
        let picker = SCContentSharingPicker.shared
        picker.remove(self)
        picker.isActive = false
        let stream = self.stream
        self.stream = nil
        stream?.stopCapture { _ in }
        if let error { onError(error) }
        else { onStopped() }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        output.push(sampleBuffer)
    }
}
#endif

#if canImport(ReplayKit)
@available(iOS, deprecated: 27.0, message: "ScreenCaptureKit is used on iOS 27 and later.")
private final class NativeReplayKitScreenCapture {
    private let recorder = RPScreenRecorder.shared()
    private let output: NativeCapturedVideoFrames
    private let onStarted: () -> Void
    private let onStopped: () -> Void
    private let onError: (Error) -> Void
    private var finished = false
    private var isCapturing = false

    init(capturer: RTCVideoCapturer, source: RTCVideoSource, onStarted: @escaping () -> Void, onStopped: @escaping () -> Void, onError: @escaping (Error) -> Void) {
        self.output = NativeCapturedVideoFrames(capturer: capturer, source: source)
        self.onStarted = onStarted
        self.onStopped = onStopped
        self.onError = onError
    }

    func start() {
        guard recorder.isAvailable else {
            finish(error: NSError(domain: "GleanVoice", code: 5, userInfo: [NSLocalizedDescriptionKey: "Screen sharing is not available on this device."]))
            return
        }
        recorder.isMicrophoneEnabled = false
        recorder.startCapture(handler: { [weak self] sampleBuffer, type, error in
            if let error {
                DispatchQueue.main.async { [weak self] in self?.finish(error: error) }
                return
            }
            guard type == .video else { return }
            self?.output.push(sampleBuffer)
        }, completionHandler: { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if self.finished {
                    if error == nil { self.recorder.stopCapture(handler: { _ in }) }
                    return
                }
                if let error { self.finish(error: error) }
                else {
                    self.isCapturing = true
                    self.onStarted()
                }
            }
        })
    }

    func stop() {
        guard !finished else { return }
        if !isCapturing {
            finish()
            return
        }
        finished = true
        isCapturing = false
        recorder.stopCapture { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error { self.onError(error) }
                else { self.onStopped() }
            }
        }
    }

    private func finish(error: Error? = nil) {
        guard !finished else { return }
        finished = true
        guard let error else { onStopped(); return }
        guard isCapturing else { onError(error); return }
        isCapturing = false
        recorder.stopCapture { [weak self] _ in
            DispatchQueue.main.async { self?.onError(error) }
        }
    }
}
#endif

struct NativeVoiceRoomView: View {
    @StateObject private var model: NativeVoiceRoomModel
    @StateObject private var apps: NativeAppsStore
    @State private var showVolumeFor: Int?
    @State private var showApps = false
    @Environment(\.dismiss) private var dismiss
    let auth: AuthStore
    let serverID: Int
    let channel: Record

    init(auth: AuthStore, serverID: Int, channel: Record) {
        self.auth = auth
        self.serverID = serverID
        self.channel = channel
        _model = StateObject(wrappedValue: NativeVoiceRoomModel(auth: auth, serverID: serverID, channelID: channel.number("id")))
        _apps = StateObject(wrappedValue: NativeAppsStore(auth: auth, scopeKey: "c:\(serverID):\(channel.number("id"))"))
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Image(systemName: model.joined ? "waveform" : "waveform.circle.fill")
                        .font(.system(size: 42, weight: .medium)).foregroundStyle(GleanStyle.blue)
                    Text(model.sharing ? "You’re sharing your screen" : model.screenShareStarting ? "Choose what to share" : model.joined ? "You’re connected" : model.connecting ? "Joining voice…" : "Voice channel")
                        .font(.title3.bold())
                    Text("Join with audio, then turn on your camera when you’re ready.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            }
            if let error = model.error {
                Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
            }
            Section("People · \(model.participants.count)") {
                if model.participants.isEmpty && model.joined {
                    Text("Waiting for people to join…").foregroundStyle(.secondary)
                }
                ForEach(model.participants) { participant in
                    VStack(alignment: .leading, spacing: 10) {
                        if let track = model.videoTracks[participant.id] {
                            NativeRTCVideoPreview(track: track)
                                .frame(maxWidth: .infinity).frame(height: 190)
                                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        HStack(spacing: 12) {
                            ProfileAvatarLink(auth: auth, path: participant.avatarUrl, username: participant.username, size: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(participant.username + (participant.id == auth.account.number("id") ? " (you)" : ""))
                                Text(participant.speaking ? "Speaking" : participant.sharing ? "Sharing screen" : participant.id == auth.account.number("id") ? "You" : "In voice")
                                    .font(.caption).foregroundStyle(participant.speaking ? GleanStyle.blue : Color.secondary)
                            }
                            Spacer()
                            if participant.deafened { Image(systemName: "headphones").foregroundStyle(.secondary).accessibilityLabel("Deafened") }
                            else if participant.muted { Image(systemName: "mic.slash.fill").foregroundStyle(.secondary).accessibilityLabel("Muted") }
                            if participant.camera { Image(systemName: "video.fill").foregroundStyle(GleanStyle.blue).accessibilityLabel("Camera on") }
                            if participant.sharing { Image(systemName: "rectangle.on.rectangle").foregroundStyle(.purple).accessibilityLabel("Sharing screen") }
                        }
                        if participant.id != auth.account.number("id") {
                            HStack(spacing: 10) {
                                Button {
                                    withAnimation(.snappy(duration: 0.18)) {
                                        showVolumeFor = showVolumeFor == participant.id ? nil : participant.id
                                    }
                                } label: {
                                    Label("Volume", systemImage: model.volume(for: participant.id) == 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
                                        .font(.caption.weight(.medium))
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("Adjust \(participant.username) volume")
                                if showVolumeFor == participant.id {
                                    Slider(value: Binding(get: { model.volume(for: participant.id) }, set: { model.setVolume($0, for: participant.id) }), in: 0...100, step: 1)
                                        .accessibilityLabel("\(participant.username) volume")
                                    Text("\(Int(model.volume(for: participant.id)))%")
                                        .font(.caption.monospacedDigit()).frame(width: 38, alignment: .trailing)
                                }
                            }
                        }
                    }
                    .listRowBackground(participant.speaking ? GleanStyle.blue.opacity(0.1) : nil)
                }
            }
        }
        .navigationTitle(channel.text("name"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .bottom) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    roomControls(size: 40, spacing: 8)
                    Spacer(minLength: 4)
                    joinButton(compact: false)
                }
                HStack(spacing: 4) {
                    roomControls(size: 34, spacing: 4)
                    Spacer(minLength: 2)
                    joinButton(compact: true)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(.regularMaterial)
        }
        .onAppear { model.setActivityTitle(channel.text("name").isEmpty ? "Glean voice channel" : channel.text("name")) }
        .onDisappear { model.leave() }
        .sheet(isPresented: $showApps) {
            NativeAppsShelfView(apps: apps)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private func roomControls(size: CGFloat, spacing: CGFloat) -> some View {
        HStack(spacing: spacing) {
            control("speaker.wave.2.fill", title: model.speaker ? "Use receiver" : "Use speaker", active: model.speaker, disabled: !model.joined, size: size) { model.toggleSpeaker() }
            control(model.muted ? "mic.slash.fill" : "mic.fill", title: model.muted ? "Unmute" : "Mute", active: model.muted, disabled: !model.joined, size: size) { model.toggleMute() }
            control(model.deafened ? "headphones.slash" : "headphones", title: model.deafened ? "Undeafen" : "Deafen", active: model.deafened, disabled: !model.joined, size: size) { model.toggleDeafen() }
            control(model.cameraOn ? "video.fill" : "video", title: model.cameraOn ? "Turn camera off" : "Turn camera on", active: model.cameraOn, disabled: !model.joined || model.sharing || model.screenShareStarting, size: size) { Task { await model.toggleCamera() } }
            control(model.sharing ? "stop.fill" : "rectangle.on.rectangle", title: model.sharing ? "Stop sharing screen" : model.screenShareStarting ? "Cancel screen share" : "Share screen", active: model.sharing || model.screenShareStarting, disabled: !model.joined, size: size) { model.toggleScreenShare() }
            control("square.grid.2x2.fill", title: "Apps", active: apps.joined, disabled: !model.joined, size: size) { showApps = true }
            if model.cameraOn {
                control("arrow.triangle.2.circlepath.camera", title: "Switch camera", active: false, disabled: !model.joined, size: size) { Task { await model.switchCamera() } }
            }
        }
    }

    private func joinButton(compact: Bool) -> some View {
        Button {
            if model.joined { model.leave(); dismiss() }
            else { Task { await model.join() } }
        } label: {
            Group {
                if compact {
                    Image(systemName: model.joined ? "phone.down.fill" : "phone.fill")
                        .frame(width: 38, height: 38)
                } else {
                    Label(model.joined ? "Leave" : model.connecting ? "Joining…" : "Join voice", systemImage: model.joined ? "phone.down.fill" : "phone.fill")
                        .font(.subheadline.bold()).padding(.horizontal, 12).frame(minHeight: 42)
                }
            }
            .background(model.joined ? Color.red : GleanStyle.blue, in: Capsule()).foregroundStyle(.white)
        }
        .disabled(model.connecting)
        .accessibilityLabel(model.joined ? "Leave voice" : model.connecting ? "Joining voice" : "Join voice")
    }

    private func control(_ icon: String, title: String, active: Bool, disabled: Bool, size: CGFloat, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).frame(width: size, height: size)
                .background(active ? GleanStyle.blue.opacity(0.18) : Color(uiColor: .tertiarySystemGroupedBackground), in: Circle())
        }
        .disabled(disabled).foregroundStyle(active ? GleanStyle.blue : Color.primary)
        .accessibilityLabel(title)
    }
}

struct NativeRTCVideoPreview: UIViewRepresentable {
    let track: RTCVideoTrack

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView(frame: .zero)
        view.videoContentMode = .scaleAspectFill
        context.coordinator.track = track
        track.add(view)
        return view
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        guard context.coordinator.track !== track else { return }
        context.coordinator.track.remove(view)
        context.coordinator.track = track
        track.add(view)
    }

    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.track.remove(view)
    }

    func makeCoordinator() -> Coordinator { Coordinator(track: track) }

    final class Coordinator {
        var track: RTCVideoTrack
        init(track: RTCVideoTrack) { self.track = track }
    }
}
