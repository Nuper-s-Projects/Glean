import Foundation

private actor MediaFixture {
    var calls = 0
    var status = 200
    var body = Data("abc".utf8)
    func configure(status: Int, body: String = "abc") {
        self.status = status
        self.body = Data(body.utf8)
    }
    func load(_ request: URLRequest) async throws -> (URL, HTTPURLResponse) {
        calls += 1
        let responseStatus = status
        let content = body
        try await Task.sleep(for: .milliseconds(25))
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("glean-fixture-\(UUID().uuidString)")
        try content.write(to: file)
        let headers = ["Content-Type": "image/gif", "ETag": "v1", "Cache-Control": request.url!.path.contains("refresh") ? "max-age=0" : "max-age=3600"]
        if responseStatus == 304 {
            precondition(request.value(forHTTPHeaderField: "If-None-Match") == "v1")
        }
        return (file, HTTPURLResponse(url: request.url!, statusCode: responseStatus, httpVersion: nil, headerFields: headers)!)
    }
}

@main struct NativeMediaCacheChecks {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("glean-cache-check-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = MediaFixture()
        let cache = NativeMediaCache(root: root, byteLimit: 12, loader: { try await fixture.load($0) })
        @Sendable func request(_ path: String) -> URLRequest { URLRequest(url: URL(string: "https://glean.example/\(path)")!) }
        func consume(_ result: NativeMediaCache.Result) throws -> Data {
            defer { try? FileManager.default.removeItem(at: result.file) }
            return try Data(contentsOf: result.file)
        }
        let first = try await cache.media(request: request("avatar-v1"), account: "alice")
        precondition(first.usedNetwork)
        let firstBytes = try consume(first)
        precondition(firstBytes == Data("abc".utf8))
        let hit = try await cache.media(request: request("avatar-v1"), account: "alice")
        precondition(!hit.usedNetwork)
        _ = try consume(hit)
        let restarted = NativeMediaCache(root: root, byteLimit: 12, loader: { try await fixture.load($0) })
        let persisted = try await restarted.media(request: request("avatar-v1"), account: "alice")
        precondition(!persisted.usedNetwork)
        _ = try consume(persisted)
        let changed = try await cache.media(request: request("avatar-v2"), account: "alice")
        precondition(changed.usedNetwork)
        _ = try consume(changed)
        let otherAccount = try await cache.media(request: request("avatar-v2"), account: "bob")
        precondition(otherAccount.usedNetwork)
        _ = try consume(otherAccount)
        let before = await fixture.calls
        async let a = cache.media(request: request("shared"), account: "alice")
        async let b = cache.media(request: request("shared"), account: "alice")
        let (one, two) = try await (a, b)
        let after = await fixture.calls
        precondition(after == before + 1)
        _ = try consume(one); _ = try consume(two)
        _ = try consume(await cache.media(request: request("refresh"), account: "alice"))
        await fixture.configure(status: 304)
        let validated = try await cache.media(request: request("refresh"), account: "alice")
        precondition(validated.usedNetwork && validated.downloadedBytes == 0)
        _ = try consume(validated)
        await fixture.configure(status: 200, body: "xyz")
        let replaced = try await cache.media(request: request("refresh"), account: "alice")
        let replacedBytes = try consume(replaced)
        precondition(replacedBytes == Data("xyz".utf8))
        await fixture.configure(status: 403)
        do {
            _ = try await cache.media(request: request("refresh"), account: "alice")
            fatalError("Revoked media was returned")
        } catch let error as NSError { precondition(error.code == 403) }
        let cachedFiles = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey]).filter { $0.pathExtension == "media" }
        let bytes = try cachedFiles.reduce(0) { try $0 + ($1.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) }
        precondition(bytes <= 12)
        print("PASS: disk reuse, restart, new URLs, account isolation, coalescing, lease safety, 304 validation, replacement, revocation, disk limit")
    }
}
