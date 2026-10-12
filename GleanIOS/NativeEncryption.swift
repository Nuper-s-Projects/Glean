import CryptoKit
import CommonCrypto
import Foundation
import Security
import UniformTypeIdentifiers

struct NativeE2EEIdentity {
    let privateKey: P256.KeyAgreement.PrivateKey
    let publicKey: Record
    let fingerprint: String
    var serverKeyChanged = false
    var serverKeyMismatch = false
}

@MainActor enum NativeE2EE {
    static let maximumAttachmentBytes = 100 * 1024 * 1024
    private static var identities: [Int: NativeE2EEIdentity] = [:]
    private static var registered = Set<Int>()
    private static let service = "com.glean.ios.e2ee"
    private static let profileBackupIterations: UInt32 = 600_000
    private static var archived: [String: [String: NativeE2EEIdentity]] = [:]
    private static var checkedAt: [Int: Date] = [:]
    private static var syncing: [Int: Task<NativeE2EEIdentity, Error>] = [:]

    private static func existingIdentity(auth: AuthStore) throws -> NativeE2EEIdentity? {
        let accountID = auth.account.number("id")
        guard accountID > 0 else { throw URLError(.userAuthenticationRequired) }
        if let cached = identities[accountID] { return cached }
        guard let stored = readKey(accountID), let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: stored) else { return nil }
        let point = key.publicKey.x963Representation
        let x = base64URL(Data(point[1..<33]))
        let y = base64URL(Data(point[33..<65]))
        let publicKey: Record = ["kty": "EC", "crv": "P-256", "x": x, "y": y]
        let canonical = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
        let fingerprint = SHA256.hash(data: Data(canonical.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        let identity = NativeE2EEIdentity(privateKey: key, publicKey: publicKey, fingerprint: fingerprint)
        identities[accountID] = identity
        return identity
    }

    private static func localIdentity(auth: AuthStore) throws -> NativeE2EEIdentity {
        let accountID = auth.account.number("id")
        if let existing = try existingIdentity(auth: auth) { return existing }
        guard accountID > 0 else { throw URLError(.userAuthenticationRequired) }
        let key = P256.KeyAgreement.PrivateKey()
        saveKey(key.rawRepresentation, accountID: accountID)
        let point = key.publicKey.x963Representation
        let x = base64URL(Data(point[1..<33]))
        let y = base64URL(Data(point[33..<65]))
        let publicKey: Record = ["kty": "EC", "crv": "P-256", "x": x, "y": y]
        let canonical = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
        let fingerprint = SHA256.hash(data: Data(canonical.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        let identity = NativeE2EEIdentity(privateKey: key, publicKey: publicKey, fingerprint: fingerprint)
        identities[accountID] = identity
        return identity
    }

    static func ensure(auth: AuthStore) async throws -> NativeE2EEIdentity {
        let accountID = auth.account.number("id")
        if let task = syncing[accountID] { return try await task.value }
        var identity: NativeE2EEIdentity
        if let date = checkedAt[accountID], Date().timeIntervalSince(date) < 30 {
            identity = try localIdentity(auth: auth)
        } else {
            // A saved cross-device code must never silently replace the active key at startup.
            let task = Task { () throws -> NativeE2EEIdentity in
                let accountKey = auth.username?.lowercased() == "nuper" ? try await auth.request("api/e2ee/profile-key") : [:]
                let legacy = try await auth.request("api/e2ee/sync")
                let activePublicKey = accountKey.object("publicKey").isEmpty ? legacy.object("publicKey") : accountKey.object("publicKey")
                if !legacy.object("envelope").isEmpty, let code = savedSyncCode(accountID: accountID) {
                    return try await sync(auth: auth, code: code)
                }
                if !activePublicKey.isEmpty {
                    guard let local = try existingIdentity(auth: auth), samePublicKey(local.publicKey, activePublicKey) else {
                        throw syncError("Sign in again with your Glean password to restore your account DM key on this device.")
                    }
                    return local
                }
                return try localIdentity(auth: auth)
            }
            syncing[accountID] = task
            defer { syncing[accountID] = nil }
            identity = try await task.value
        }
        if !identity.serverKeyMismatch && !registered.contains(accountID) {
            let registration = try await auth.request("api/e2ee/key", body: ["publicKey": identity.publicKey, "fingerprint": identity.fingerprint], method: "PUT")
            identity.serverKeyChanged = registration.flag("changed")
            identities[accountID] = identity
            registered.insert(accountID)
        }
        return identity
    }

    static func createSyncCode() -> String { base64URL(randomBytes(32)) }
    static func savedSyncCode(accountID: Int) -> String? {
        readSecret("code:\(accountID)").flatMap { String(data: $0, encoding: .utf8) }
    }

    private static func profileBackupKey(password: String, salt: Data) async throws -> SymmetricKey {
        let passwordData = Data(password.utf8)
        let iterations = profileBackupIterations
        let derived = try await Task.detached(priority: .userInitiated) { () throws -> Data in
            let outputLength = 32
            var output = Data(count: outputLength)
            let status = passwordData.withUnsafeBytes { passwordBytes in
                salt.withUnsafeBytes { saltBytes in
                    output.withUnsafeMutableBytes { outputBytes in
                        CCKeyDerivationPBKDF(
                            CCPBKDFAlgorithm(kCCPBKDF2),
                            passwordBytes.bindMemory(to: Int8.self).baseAddress,
                            passwordData.count,
                            saltBytes.bindMemory(to: UInt8.self).baseAddress,
                            salt.count,
                            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                            iterations,
                            outputBytes.bindMemory(to: UInt8.self).baseAddress,
                            outputLength
                        )
                    }
                }
            }
            guard status == kCCSuccess else { throw URLError(.cannotDecodeContentData) }
            return output
        }.value
        return SymmetricKey(data: derived)
    }

    private static func accountKeyRecords(accountID: Int, active: NativeE2EEIdentity) throws -> [Record] {
        var records = readSecret("archive:\(accountID)").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [Record] } ?? []
        records += (archived[active.fingerprint] ?? [:]).values.map { item in
            var privateJwk = item.publicKey
            privateJwk["d"] = base64URL(item.privateKey.rawRepresentation)
            return ["fingerprint": item.fingerprint, "publicKey": item.publicKey, "privateJwk": privateJwk]
        }
        var privateJwk = active.publicKey
        privateJwk["d"] = base64URL(active.privateKey.rawRepresentation)
        records.append(["fingerprint": active.fingerprint, "publicKey": active.publicKey, "privateJwk": privateJwk])
        var unique: [String: Record] = [:]
        for record in records {
            let fingerprint = record.text("fingerprint")
            if !fingerprint.isEmpty { unique[fingerprint] = record }
        }
        guard unique.count <= 64 else { throw NSError(domain: "Glean", code: 400, userInfo: [NSLocalizedDescriptionKey: "Your DM key archive has reached its limit."]) }
        return Array(unique.values)
    }

    private static func encryptedProfileBackup(accountID: Int, password: String, active: NativeE2EEIdentity) async throws -> Record {
        let identities = try accountKeyRecords(accountID: accountID, active: active)
        let payload: Record = ["version": 1, "activeFingerprint": active.fingerprint, "identities": identities]
        let clear = try JSONSerialization.data(withJSONObject: payload)
        let salt = randomBytes(16)
        let nonce = randomBytes(12)
        let key = try await profileBackupKey(password: password, salt: salt)
        let aad = Data("glean-account-key-backup-v1:\(accountID)".utf8)
        let sealed = try AES.GCM.seal(clear, using: key, nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
        return [
            "version": 1,
            "kdf": "PBKDF2-SHA256",
            "iterations": Int(profileBackupIterations),
            "salt": base64URL(salt),
            "iv": base64URL(nonce),
            "ciphertext": base64URL(sealed.ciphertext + sealed.tag),
        ]
    }

    static func restoreProfileKeyBackup(auth: AuthStore, password: String) async throws {
        guard auth.username?.lowercased() == "nuper" else { return }
        let accountID = auth.account.number("id")
        guard accountID > 0, !password.isEmpty else { throw syncError("Sign in with your Glean password to restore your DM key.") }
        let remote = try await auth.request("api/e2ee/profile-key")
        let remotePublic = remote.object("publicKey")
        let local = try existingIdentity(auth: auth)
        let backup = remote.object("backup")
        var active: NativeE2EEIdentity?

        if !backup.isEmpty {
            do {
                guard backup.number("version") == 1, backup.text("kdf") == "PBKDF2-SHA256", backup.number("iterations") == Int(profileBackupIterations) else { throw syncError("Unsupported Glean DM key backup.") }
                let salt = try decode(backup.text("salt"))
                let nonce = try decode(backup.text("iv"))
                let combined = try decode(backup.text("ciphertext"))
                guard combined.count > 16 else { throw URLError(.cannotDecodeContentData) }
                let key = try await profileBackupKey(password: password, salt: salt)
                let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: combined.dropLast(16), tag: combined.suffix(16))
                let clear = try AES.GCM.open(box, using: key, authenticating: Data("glean-account-key-backup-v1:\(accountID)".utf8))
                guard let payload = try JSONSerialization.jsonObject(with: clear) as? Record else { throw URLError(.cannotDecodeContentData) }
                let records = payload.records("identities")
                guard !records.isEmpty, records.count <= 64 else { throw URLError(.cannotDecodeContentData) }
                let restored = restoreArchivedIdentities(records)
                let selected = restored[payload.text("activeFingerprint")]
                guard let selected, remotePublic.isEmpty || samePublicKey(selected.publicKey, remotePublic) else { throw syncError("The saved DM key does not match your account’s active key. Existing messages were not changed.") }
                active = selected
                archived[selected.fingerprint] = restored
                saveKey(selected.privateKey.rawRepresentation, accountID: accountID)
                try saveSecret(JSONSerialization.data(withJSONObject: records), name: "archive:\(accountID)")
            } catch {
                if let local, !remotePublic.isEmpty, samePublicKey(local.publicKey, remotePublic) {
                    active = local
                } else {
                    throw syncError("This device could not unlock the account DM key. Check the Glean password or sign in on a device that can still read your DMs.")
                }
            }
        } else if let local, remotePublic.isEmpty || samePublicKey(local.publicKey, remotePublic) {
            active = local
        } else if !remotePublic.isEmpty, let code = savedSyncCode(accountID: accountID) {
            let restored = try await sync(auth: auth, code: code)
            guard samePublicKey(restored.publicKey, remotePublic) else { throw syncError("This device is missing your active account DM key.") }
            active = restored
        } else if !remotePublic.isEmpty {
            throw syncError("This account already has a DM key. Sign in on a device that can still read your DMs before linking a new device.")
        } else {
            active = try local ?? localIdentity(auth: auth)
        }

        guard let active, !active.serverKeyMismatch else { throw syncError("This device is missing your active account DM key.") }
        let encrypted = try await encryptedProfileBackup(accountID: accountID, password: password, active: active)
        let result: Record = [
            "revision": remote.number("revision"),
            "publicKey": active.publicKey,
            "fingerprint": active.fingerprint,
            "backup": encrypted,
        ]
        _ = try await auth.request("api/e2ee/profile-key", body: result, method: "PUT")
        identities[accountID] = active
        checkedAt[accountID] = Date()
        registered.insert(accountID)
    }

    static func prepareProfileKeyBackupForPasswordChange(auth: AuthStore, currentPassword: String, newPassword: String) async throws -> Record? {
        guard auth.username?.lowercased() == "nuper" else { return nil }
        let remote = try await auth.request("api/e2ee/profile-key")
        guard let local = try existingIdentity(auth: auth), remote.object("publicKey").isEmpty || samePublicKey(local.publicKey, remote.object("publicKey")) else {
            throw syncError("This device does not have your active DM key. Restore it before changing your password.")
        }
        let encrypted = try await encryptedProfileBackup(accountID: auth.account.number("id"), password: newPassword, active: local)
        return ["revision": remote.number("revision"), "publicKey": local.publicKey, "fingerprint": local.fingerprint, "backup": encrypted]
    }

    static func deleteKeys(accountID: Int) {
        if let identity = identities.removeValue(forKey: accountID) { archived.removeValue(forKey: identity.fingerprint) }
        registered.remove(accountID)
        checkedAt.removeValue(forKey: accountID)
        syncing.removeValue(forKey: accountID)?.cancel()
        for name in ["code:\(accountID)", "archive:\(accountID)"] {
            SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ".sync", kSecAttrAccount as String: name] as CFDictionary)
        }
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: String(accountID)] as CFDictionary)
    }

    static func sync(auth: AuthStore, code supplied: String? = nil) async throws -> NativeE2EEIdentity {
        let id = auth.account.number("id")
        let remote = try await auth.request("api/e2ee/sync")
        let code = supplied?.trimmingCharacters(in: .whitespacesAndNewlines) ?? readSecret("code:\(id)").flatMap { String(data: $0, encoding: .utf8) }
        guard let code, !code.isEmpty else {
            let local = try localIdentity(auth: auth)
            if remote.object("envelope").isEmpty {
                checkedAt[id] = Date()
                return local
            }
            let activePublicKey = remote.object("publicKey")
            let archivedMatches = archived.values.flatMap { $0.values }.first { samePublicKey($0.publicKey, activePublicKey) }
            if let archivedMatches {
                if let records = readSecret("archive:\(id)").flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [Record] }) {
                    let restored = restoreArchivedIdentities(records)
                    if !restored.isEmpty { archived[archivedMatches.fingerprint] = restored }
                }
                checkedAt[id] = Date()
                return archivedMatches
            }
            if let saved = readSecret("archive:\(id)"),
               let records = try? JSONSerialization.jsonObject(with: saved) as? [Record] {
                let restored = restoreArchivedIdentities(records)
                if let active = restored.values.first(where: { samePublicKey($0.publicKey, activePublicKey) }) {
                    archived[active.fingerprint] = restored
                    checkedAt[id] = Date()
                    return active
                }
            }
            var readOnly = local
            readOnly.serverKeyMismatch = true
            checkedAt[id] = Date()
            return readOnly
        }
        guard code.count == 43, let rawKey = try? decode(code), rawKey.count == 32 else { throw syncError("Enter the 43-character sync code from your other device.") }
        let key = SymmetricKey(data: rawKey)
        let aad = Data("glean-key-sync-v1:\(id)".utf8)
        let local = try localIdentity(auth: auth)
        for attempt in 0..<3 {
            let vault = attempt == 0 ? remote : try await auth.request("api/e2ee/sync")
            var payload: Record = ["activeFingerprint": local.fingerprint, "identities": []]
            let envelope = vault.object("envelope")
            if !envelope.isEmpty {
                do {
                    let bytes = try decode(envelope.text("ciphertext"))
                    guard bytes.count >= 16 else { throw URLError(.cannotDecodeContentData) }
                    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: decode(envelope.text("iv"))), ciphertext: bytes.dropLast(16), tag: bytes.suffix(16))
                    let clear = try AES.GCM.open(box, using: key, authenticating: aad)
                    guard let parsed = try JSONSerialization.jsonObject(with: clear) as? Record else { throw URLError(.cannotDecodeContentData) }
                    payload = parsed
                } catch { throw syncError("That sync code cannot unlock your keys. Use the code from the first linked device.") }
            }
            var records = payload.records("identities")
            guard records.count <= 64 else { throw syncError("The encryption key vault is full.") }
            if let saved = readSecret("archive:\(id)"), let old = try JSONSerialization.jsonObject(with: saved) as? [Record] {
                for record in old where !records.contains(where: { $0.text("fingerprint") == record.text("fingerprint") }) { records.append(record) }
            }
            if !records.contains(where: { $0.text("fingerprint") == local.fingerprint }) {
                var privateJwk = local.publicKey
                privateJwk["d"] = base64URL(local.privateKey.rawRepresentation)
                records.append(["fingerprint": local.fingerprint, "publicKey": local.publicKey, "privateJwk": privateJwk])
            }
            guard records.count <= 64 else { throw syncError("The encryption key vault is full.") }
            var restored: [String: NativeE2EEIdentity] = [:]
            for record in records {
                let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: decode(record.object("privateJwk").text("d")))
                let point = privateKey.publicKey.x963Representation
                let publicJwk: Record = ["kty": "EC", "crv": "P-256", "x": base64URL(Data(point[1..<33])), "y": base64URL(Data(point[33..<65]))]
                guard samePublicKey(publicJwk, record.object("publicKey")) else { throw syncError("Invalid synced encryption key.") }
                let canonical = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(publicJwk.text("x"))\",\"y\":\"\(publicJwk.text("y"))\"}"
                let fingerprint = SHA256.hash(data: Data(canonical.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
                guard fingerprint == record.text("fingerprint") else { throw syncError("Invalid synced key fingerprint.") }
                restored[record.text("fingerprint")] = NativeE2EEIdentity(privateKey: privateKey, publicKey: publicJwk, fingerprint: record.text("fingerprint"))
            }
            guard let active = restored[payload.text("activeFingerprint")] else { throw syncError("Missing active encryption key.") }
            payload["identities"] = records
            let nonceBytes = randomBytes(12)
            let sealed = try AES.GCM.seal(JSONSerialization.data(withJSONObject: payload), using: key, nonce: AES.GCM.Nonce(data: nonceBytes), authenticating: aad)
            do {
                _ = try await auth.request("api/e2ee/sync", body: ["revision": vault.number("revision"), "publicKey": active.publicKey, "envelope": ["version": 1, "iv": base64URL(nonceBytes), "ciphertext": base64URL(sealed.ciphertext + sealed.tag)]], method: "PUT")
            } catch {
                if (error as NSError).code == 409 && attempt < 2 { continue }
                throw error
            }
            try saveSecret(Data(code.utf8), name: "code:\(id)")
            try saveSecret(JSONSerialization.data(withJSONObject: records), name: "archive:\(id)")
            saveKey(active.privateKey.rawRepresentation, accountID: id)
            archived[active.fingerprint] = restored
            identities[id] = active
            _ = try await auth.request("api/e2ee/key", body: ["publicKey": active.publicKey, "fingerprint": active.fingerprint], method: "PUT")
            registered.insert(id)
            checkedAt[id] = Date()
            return active
        }
        throw syncError("Keys changed on another device. Sync again.")
    }

    private static func syncError(_ message: String) -> NSError { NSError(domain: "Glean", code: 400, userInfo: [NSLocalizedDescriptionKey: message]) }
    private static func restoreArchivedIdentities(_ records: [Record]) -> [String: NativeE2EEIdentity] {
        var restored: [String: NativeE2EEIdentity] = [:]
        for record in records {
            guard let privateKey = try? P256.KeyAgreement.PrivateKey(rawRepresentation: decode(record.object("privateJwk").text("d"))) else { continue }
            let point = privateKey.publicKey.x963Representation
            let publicKey: Record = ["kty": "EC", "crv": "P-256", "x": base64URL(Data(point[1..<33])), "y": base64URL(Data(point[33..<65]))]
            let canonical = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(publicKey.text("x"))\",\"y\":\"\(publicKey.text("y"))\"}"
            let fingerprint = SHA256.hash(data: Data(canonical.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
            guard samePublicKey(publicKey, record.object("publicKey")), fingerprint == record.text("fingerprint") else { continue }
            restored[fingerprint] = NativeE2EEIdentity(privateKey: privateKey, publicKey: publicKey, fingerprint: fingerprint)
        }
        return restored
    }
    private static func readSecret(_ name: String) -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ".sync", kSecAttrAccount as String: name, kSecReturnData as String: true]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }
    private static func saveSecret(_ data: Data, name: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ".sync", kSecAttrAccount as String: name]
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw syncError("Could not securely save synced keys.") }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw syncError("Could not securely save synced keys.") }
    }

    private static func matchingIdentity(_ original: NativeE2EEIdentity, envelope: Record) -> NativeE2EEIdentity {
        ([original] + Array((archived[original.fingerprint] ?? [:]).values)).first {
            samePublicKey($0.publicKey, envelope.object("senderPublicKey")) || samePublicKey($0.publicKey, envelope.object("recipientPublicKey"))
        } ?? original
    }

    static func encrypt(text: String, conversationID: Int, identity: NativeE2EEIdentity, recipient: Record, files: [URL]) throws -> (envelope: Record, attachmentMeta: [Record], encryptedFiles: [URL]) {
        guard files.count <= 10 else { throw NSError(domain: "Glean", code: 400, userInfo: [NSLocalizedDescriptionKey: "You can attach up to 10 files."]) }
        let recipientKey = try publicKey(recipient)
        let shared = try identity.privateKey.sharedSecretFromKeyAgreement(with: recipientKey)
        let salt = randomBytes(32)
        let nonceBytes = randomBytes(12)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: Data("glean-message-v1".utf8), outputByteCount: 32)
        let clientMessageID = base64URL(randomBytes(24))
        var payloadAttachments: [Record] = []
        var attachmentMeta: [Record] = []
        var encryptedFiles: [URL] = []
        do {
            for source in files {
                let accessible = source.startAccessingSecurityScopedResource()
                defer { if accessible { source.stopAccessingSecurityScopedResource() } }
                let values = try source.resourceValues(forKeys: [.fileSizeKey])
                guard let fileSize = values.fileSize, fileSize <= maximumAttachmentBytes else {
                    throw NSError(domain: "Glean", code: 413, userInfo: [NSLocalizedDescriptionKey: "Encrypted iOS attachments are limited to 100 MB per file."])
                }
                let original = try Data(contentsOf: source, options: .mappedIfSafe)
                let fileSalt = randomBytes(32)
                let fileNonceBytes = randomBytes(12)
                let fileKey = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: fileSalt, sharedInfo: Data("glean-attachment-v1".utf8), outputByteCount: 32)
                let fileNonce = try AES.GCM.Nonce(data: fileNonceBytes)
                let sealedFile = try AES.GCM.seal(original, using: fileKey, nonce: fileNonce)
                let encryptedURL = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).glean")
                try (sealedFile.ciphertext + sealedFile.tag).write(to: encryptedURL, options: .atomic)
                encryptedFiles.append(encryptedURL)
                let mime = UTType(filenameExtension: source.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                payloadAttachments.append(["name": source.lastPathComponent, "type": mime, "size": fileSize])
                attachmentMeta.append(["size": fileSize, "iv": base64URL(fileNonceBytes), "salt": base64URL(fileSalt)])
            }
        } catch {
            encryptedFiles.forEach { try? FileManager.default.removeItem(at: $0) }
            throw error
        }
        let privatePayload: Record = ["text": text, "attachments": payloadAttachments]
        let clear = try JSONSerialization.data(withJSONObject: privatePayload)
        let nonce = try AES.GCM.Nonce(data: nonceBytes)
        let aad = Data("glean:\(conversationID):\(clientMessageID)".utf8)
        let sealed = try AES.GCM.seal(clear, using: key, nonce: nonce, authenticating: aad)
        let envelope: Record = [
            "version": 1,
            "clientMessageId": clientMessageID,
            "ciphertext": base64URL(sealed.ciphertext + sealed.tag),
            "iv": base64URL(nonceBytes),
            "salt": base64URL(salt),
            "senderPublicKey": identity.publicKey,
            "recipientPublicKey": recipient,
        ]
        return (envelope, attachmentMeta, encryptedFiles)
    }

    static func decryptAttachment(file: URL, fileName: String, identity: NativeE2EEIdentity, attachment: Record, messageCrypto: Record) throws -> URL {
        let identity = matchingIdentity(identity, envelope: messageCrypto)
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= maximumAttachmentBytes + 16 else {
            throw NSError(domain: "Glean", code: 413, userInfo: [NSLocalizedDescriptionKey: "This encrypted attachment is larger than the 100 MB iOS limit."])
        }
        let envelope = attachment.isEmpty ? messageCrypto : attachment
        let sender = envelope.object("senderPublicKey")
        let recipient = envelope.object("recipientPublicKey")
        let peerJWK = samePublicKey(identity.publicKey, sender) ? recipient : sender
        let peer = try publicKey(peerJWK)
        let shared = try identity.privateKey.sharedSecretFromKeyAgreement(with: peer)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: try decode(envelope.text("salt")), sharedInfo: Data("glean-attachment-v1".utf8), outputByteCount: 32)
        let nonce = try AES.GCM.Nonce(data: decode(envelope.text("iv")))
        let combined = try Data(contentsOf: file, options: .mappedIfSafe)
        guard combined.count >= 16 else { throw URLError(.cannotDecodeContentData) }
        let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: Data(combined.dropLast(16)), tag: Data(combined.suffix(16)))
        let clear = try AES.GCM.open(sealed, using: key)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeName = URL(fileURLWithPath: fileName).lastPathComponent
        let output = directory.appendingPathComponent(safeName.isEmpty ? "attachment" : safeName)
        try clear.write(to: output, options: .atomic)
        return output
    }

    static func decrypt(message: Record, conversationID: Int, identity: NativeE2EEIdentity) -> Record {
        var message = message
        let reply = message.object("replyTo")
        if reply.flag("encrypted") {
            let clear = decrypt(message: reply, conversationID: conversationID, identity: identity)
            var snippet = reply
            snippet["body"] = clear.text("body")
            message["replyTo"] = snippet
        }
        guard message.flag("encrypted"), let crypto = message["crypto"] as? Record else { return message }
        let identity = matchingIdentity(identity, envelope: crypto)
        do {
            let sender = crypto.object("senderPublicKey")
            let recipient = crypto.object("recipientPublicKey")
            let peerJWK = samePublicKey(identity.publicKey, sender) ? recipient : sender
            let peer = try publicKey(peerJWK)
            let shared = try identity.privateKey.sharedSecretFromKeyAgreement(with: peer)
            let salt = try decode(crypto.text("salt"))
            let nonceData = try decode(crypto.text("iv"))
            let combined = try decode(crypto.text("ciphertext"))
            guard combined.count >= 16 else { throw URLError(.cannotDecodeContentData) }
            let nonce = try AES.GCM.Nonce(data: nonceData)
            let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: Data("glean-message-v1".utf8), outputByteCount: 32)
            let clientID = message.text("clientMessageId")
            let aad = Data("glean:\(conversationID):\(clientID)".utf8)
            let boxes = [
                try AES.GCM.SealedBox(nonce: nonce, ciphertext: combined.dropLast(16), tag: combined.suffix(16)),
            ]
            for box in boxes {
                if let clear = try? AES.GCM.open(box, using: key, authenticating: aad),
                   let payload = (try? JSONSerialization.jsonObject(with: clear)) as? Record {
                    var result = message
                    result["body"] = payload.text("text")
                    if var attachments = message["attachments"] as? [Record] {
                        for index in attachments.indices where index < payload.records("attachments").count {
                            let privateAttachment = payload.records("attachments")[index]
                            attachments[index]["name"] = privateAttachment["name"]
                            attachments[index]["type"] = privateAttachment["type"]
                            attachments[index]["size"] = privateAttachment["size"]
                        }
                        result["attachments"] = attachments
                    }
                    result["decryptionFailed"] = false
                    return result
                }
                if let clear = try? AES.GCM.open(box, using: key),
                   let payload = (try? JSONSerialization.jsonObject(with: clear)) as? Record {
                    var result = message
                    result["body"] = payload.text("text")
                    result["decryptionFailed"] = false
                    return result
                }
            }
            throw URLError(.cannotDecodeContentData)
        } catch {
            var result = message
            result["body"] = "Unable to decrypt this message on this device."
            result["decryptionFailed"] = true
            return result
        }
    }

    private static func publicKey(_ jwk: Record) throws -> P256.KeyAgreement.PublicKey {
        guard jwk.text("kty") == "EC", jwk.text("crv") == "P-256" else { throw URLError(.cannotDecodeContentData) }
        let x = try decode(jwk.text("x")); let y = try decode(jwk.text("y"))
        guard x.count == 32, y.count == 32 else { throw URLError(.cannotDecodeContentData) }
        return try P256.KeyAgreement.PublicKey(x963Representation: Data([4]) + x + y)
    }

    private static func samePublicKey(_ lhs: Record, _ rhs: Record) -> Bool {
        lhs.text("kty") == rhs.text("kty") && lhs.text("crv") == rhs.text("crv") && lhs.text("x") == rhs.text("x") && lhs.text("y") == rhs.text("y")
    }

    private static func randomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        precondition(status == errSecSuccess, "Secure random generation failed.")
        return Data(bytes)
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private static func decode(_ text: String) throws -> Data {
        let value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let padded = value + String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let data = Data(base64Encoded: padded) else { throw URLError(.cannotDecodeContentData) }
        return data
    }

    private static func readKey(_ accountID: Int) -> Data? {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: String(accountID), kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private static func saveKey(_ data: Data, accountID: Int) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: String(accountID)]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { preconditionFailure("Could not save the private encryption key securely.") }
    }
}
