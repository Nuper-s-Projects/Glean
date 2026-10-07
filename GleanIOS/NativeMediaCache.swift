import Foundation
import CryptoKit
import UniformTypeIdentifiers

/// Stores authenticated media bytes, never decrypted DM attachments.
actor NativeMediaCache {
    static let shared = NativeMediaCache()
    struct Result: Sendable {
        let file: URL
        let downloadedBytes: Int64
        let usedNetwork: Bool
    }
    private struct Entry: Codable {
        var validatedAt: Date
        var accessedAt: Date
        let bytes: Int64
        let maxAge: TimeInterval
        let etag: String?
        let modified: String?
        let contentType: String
    }
    private struct Asset: Sendable {
        let url: URL
        let contentType: String
        let downloadedBytes: Int64
        let usedNetwork: Bool
    }
    typealias Loader = @Sendable (URLRequest) async throws -> (URL, HTTPURLResponse)
    private let root: URL
    private let byteLimit: Int64
    private let loader: Loader
    private var pending: [String: Task<Asset, Error>] = [:]
    private var readers: [String: Int] = [:]
    private var needsPrune = false

    init(root: URL? = nil, byteLimit: Int64 = 2_147_483_648, loader: Loader? = nil) {
        self.root = root ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("GleanMedia", isDirectory: true)
        self.byteLimit = byteLimit
        self.loader = loader ?? { request in
            let (file, response) = try await URLSession.shared.download(for: request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            return (file, http)
        }
    }

    func media(request: URLRequest, account: String) async throws -> Result {
        guard let url = request.url else { throw URLError(.badURL) }
        let key = Self.digest(account + "|" + url.absoluteString)
        readers[key, default: 0] += 1
        defer {
            readers[key, default: 1] -= 1
            if readers[key] == 0 {
                readers[key] = nil
                pending[key] = nil
                if needsPrune {
                    try? prune(protecting: key)
                    needsPrune = !pending.isEmpty
                }
            }
        }
        let asset: Asset
        if let task = pending[key] {
            let shared = try await task.value
            asset = Asset(url: shared.url, contentType: shared.contentType, downloadedBytes: 0, usedNetwork: false)
        } else {
            let task = Task { try await retrieve(request: request, key: key) }
            pending[key] = task
            asset = try await task.value
        }
        try Task.checkCancellation()
        // Callers own this lease and can remove or move it without destroying the cache.
        let ext = UTType(mimeType: asset.contentType)?.preferredFilenameExtension ?? "bin"
        let lease = FileManager.default.temporaryDirectory.appendingPathComponent("glean-media-\(UUID().uuidString).\(ext)")
        do { try FileManager.default.linkItem(at: asset.url, to: lease) }
        catch { try FileManager.default.copyItem(at: asset.url, to: lease) }
        protect(lease)
        return Result(file: lease, downloadedBytes: asset.downloadedBytes, usedNetwork: asset.usedNetwork)
    }

    private func retrieve(request: URLRequest, key: String) async throws -> Asset {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var directory = root
        var resources = URLResourceValues()
        resources.isExcludedFromBackup = true
        try directory.setResourceValues(resources)
        let file = root.appendingPathComponent(key + ".media")
        let metadata = root.appendingPathComponent(key + ".json")
        let cached = (try? Data(contentsOf: metadata)).flatMap { try? JSONDecoder().decode(Entry.self, from: $0) }
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init)
        let entry = cached.flatMap { size == $0.bytes ? $0 : nil }
        if var entry, Date().timeIntervalSince(entry.validatedAt) < entry.maxAge {
            if Date().timeIntervalSince(entry.accessedAt) > 30 {
                entry.accessedAt = Date()
                try save(entry, at: metadata)
            }
            return Asset(url: file, contentType: entry.contentType, downloadedBytes: 0, usedNetwork: false)
        }
        var conditional = request
        conditional.cachePolicy = .reloadIgnoringLocalCacheData
        if let entry {
            if let etag = entry.etag { conditional.setValue(etag, forHTTPHeaderField: "If-None-Match") }
            if let modified = entry.modified { conditional.setValue(modified, forHTTPHeaderField: "If-Modified-Since") }
        }
        let (download, response) = try await loader(conditional)
        defer { try? FileManager.default.removeItem(at: download) }
        guard response.url?.host == request.url?.host, response.url?.scheme == request.url?.scheme else { throw URLError(.badURL) }
        if response.statusCode == 304, var entry {
            entry.validatedAt = Date(); entry.accessedAt = Date()
            try save(entry, at: metadata)
            return Asset(url: file, contentType: entry.contentType, downloadedBytes: 0, usedNetwork: true)
        }
        guard response.statusCode == 200 else {
            if [401, 403, 404, 410].contains(response.statusCode) {
                try? FileManager.default.removeItem(at: file)
                try? FileManager.default.removeItem(at: metadata)
            }
            throw NSError(domain: "Glean", code: response.statusCode, userInfo: [NSLocalizedDescriptionKey: "This media is no longer available."])
        }
        let bytes = Int64(try download.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
        let controls = (response.value(forHTTPHeaderField: "Cache-Control") ?? "").lowercased()
        let contentType = response.mimeType ?? "application/octet-stream"
        if bytes > byteLimit || controls.contains("no-store") {
            let uncached = FileManager.default.temporaryDirectory.appendingPathComponent("glean-media-source-\(UUID().uuidString)")
            try FileManager.default.moveItem(at: download, to: uncached)
            protect(uncached)
            // The temporary source lives only long enough for coalesced callers to obtain leases.
            Task {
                try? await Task.sleep(for: .seconds(60))
                try? FileManager.default.removeItem(at: uncached)
            }
            return Asset(url: uncached, contentType: contentType, downloadedBytes: bytes, usedNetwork: true)
        }
        let staging = root.appendingPathComponent(UUID().uuidString + ".part")
        try FileManager.default.moveItem(at: download, to: staging)
        protect(staging)
        if FileManager.default.fileExists(atPath: file.path) {
            _ = try FileManager.default.replaceItemAt(file, withItemAt: staging)
        } else { try FileManager.default.moveItem(at: staging, to: file) }
        let maxAgePart = controls.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.first { $0.hasPrefix("max-age=") }
        let seconds = maxAgePart.flatMap { TimeInterval($0.dropFirst(8)) } ?? 3600
        let maxAge = controls.contains("no-cache") ? 0 : min(3600, max(0, seconds))
        let fresh = Entry(validatedAt: Date(), accessedAt: Date(), bytes: bytes, maxAge: maxAge,
                          etag: response.value(forHTTPHeaderField: "ETag"), modified: response.value(forHTTPHeaderField: "Last-Modified"), contentType: contentType)
        try save(fresh, at: metadata)
        needsPrune = true
        return Asset(url: file, contentType: contentType, downloadedBytes: bytes, usedNetwork: true)
    }

    private func save(_ entry: Entry, at url: URL) throws {
        try JSONEncoder().encode(entry).write(to: url, options: .atomic)
        protect(url)
    }
    private func protect(_ url: URL) {
        #if os(iOS)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
    }
    private func prune(protecting key: String) throws {
        let urls = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        let entries = urls.compactMap { url -> (URL, Entry)? in
            guard let data = try? Data(contentsOf: url), let entry = try? JSONDecoder().decode(Entry.self, from: data) else { return nil }
            return (url, entry)
        }.sorted { $0.1.accessedAt < $1.1.accessedAt }
        var total = entries.reduce(Int64(0)) { $0 + $1.1.bytes }
        for (metadata, entry) in entries {
            let cachedKey = metadata.deletingPathExtension().lastPathComponent
            guard cachedKey != key, pending[cachedKey] == nil else { continue }
            if total > byteLimit || Date().timeIntervalSince(entry.accessedAt) > 30 * 86400 {
                try? FileManager.default.removeItem(at: root.appendingPathComponent(cachedKey + ".media"))
                try? FileManager.default.removeItem(at: metadata)
                total -= entry.bytes
            }
        }
    }
    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
