import CryptoKit
import Foundation

struct TransferRollback: Codable {
    let keys: [String]
    let removeCleanShutdown: Bool
    let reason: String
}

struct TransferKeyIntent: Codable, Equatable {
    let transferId: String
    let key: String
    let sha256: String
}

struct TransferJournal: Codable {
    var version: Int = 2
    var transferId: String
    var packageSha256: String
    var status: String // "in_progress" | "completed" | "rolled_back"
    var startedAt: String
    var updatedAt: String
    var completedKeys: [String]
    var keyDigests: [String: String]
    var totalKeys: Int
    var lastError: String?
    var rollbackPending: TransferRollback? = nil
    var finalFlagOwned: Bool? = nil
    var pendingKey: TransferKeyIntent? = nil
    var blockedKey: String? = nil
}

final class WorkspaceTransferStore {
    let stateDirectory: URL
    private let fm = FileManager.default

    init(customDirectory: URL? = nil) {
        if let customDirectory {
            stateDirectory = customDirectory
        } else {
            let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support", isDirectory: true)
            stateDirectory = appSupport.appendingPathComponent("OpenMindmap/transfer", isDirectory: true)
        }
        ensureSecureDirectory()
    }

    var journalURL: URL {
        stateDirectory.appendingPathComponent("transfer-journal.json")
    }

    private func ensureSecureDirectory() {
        try? fm.createDirectory(at: stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stateDirectory.path)
    }

    func loadJournal() throws -> TransferJournal? {
        let data: Data
        do {
            data = try Data(contentsOf: journalURL)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return nil
        }
        let journal = try JSONDecoder().decode(TransferJournal.self, from: data)
        guard [1, 2].contains(journal.version),
              ["in_progress", "completed", "rolled_back"].contains(journal.status),
              !journal.transferId.isEmpty, isDigest(journal.packageSha256), journal.totalKeys >= 0,
              journal.completedKeys.count <= journal.totalKeys,
              Set(journal.completedKeys) == Set(journal.keyDigests.keys),
              Set(journal.completedKeys).count == journal.completedKeys.count,
              journal.keyDigests.allSatisfy({ isEntryKey($0.key) && isDigest($0.value) }) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return journal
    }

    private func isDigest(_ string: String) -> Bool {
        string.utf8.count == 64 && string.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private func isEntryKey(_ key: String) -> Bool {
        ["omm.registry.v3", "omm.settings.v3", "omm.trash.v3"].contains(key)
            || ["omm.project.", "omm.backup.", "omm.journal.", "omm.session."].contains { key.hasPrefix($0) && key.count > $0.count }
    }

    func saveJournal(_ journal: TransferJournal) throws {
        ensureSecureDirectory()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(journal)
        try data.write(to: journalURL, options: [.atomic])
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: journalURL.path)
    }

    func clearJournal() throws {
        if fm.fileExists(atPath: journalURL.path) {
            try fm.removeItem(at: journalURL)
        }
    }

    func handleBridgeAction(_ payload: [String: Any]) -> [String: Any] {
        guard let action = payload["action"] as? String else {
            return ["ok": false, "error": "Thiếu action cho journal."]
        }
        let existing: TransferJournal?
        do {
            existing = try loadJournal()
        } catch {
            return ["ok": false, "error": "Không đọc được journal: " + error.localizedDescription]
        }

        if action == "getState" {
            return ["ok": true, "journal": existing.map(encodeObj) ?? NSNull(), "stateDir": stateDirectory.path]
        }

        let now = ISO8601DateFormatter().string(from: Date())
        func commit(_ journal: TransferJournal) -> [String: Any] {
            var updated = journal
            updated.updatedAt = now
            do {
                try saveJournal(updated)
                return ["ok": true, "journal": encodeObj(updated)]
            } catch {
                return ["ok": false, "error": "Không lưu được journal: " + error.localizedDescription]
            }
        }

        if action == "beginOrResume" {
            guard let digest = payload["packageSha256"] as? String, isDigest(digest),
                  let totalKeys = payload["totalKeys"] as? Int, totalKeys >= 0 else {
                return ["ok": false, "error": "Thiếu thông tin gói chuyển dữ liệu."]
            }
            if let existing {
                if existing.status == "completed" {
                    return ["ok": false, "code": "already_completed", "error": "Gói chuyển dữ liệu đã hoàn tất trước đó."]
                }
                if existing.status == "in_progress" {
                    guard existing.packageSha256 == digest, existing.totalKeys == totalKeys else {
                        return ["ok": false, "code": "mismatch_in_progress", "error": "Đang có tiến trình chuyển dữ liệu khác chưa hoàn tất."]
                    }
                    if existing.version == 2 {
                        return ["ok": true, "journal": encodeObj(existing)]
                    }
                    guard existing.transferId == payload["replaceLegacyId"] as? String,
                          existing.completedKeys.isEmpty, existing.pendingKey == nil,
                          existing.rollbackPending == nil, existing.finalFlagOwned != true, existing.blockedKey == nil else {
                        return ["ok": false, "error": "Journal cũ không đủ điều kiện để khởi động lại."]
                    }
                }
            }
            return commit(TransferJournal(
                transferId: UUID().uuidString.lowercased(), packageSha256: digest, status: "in_progress",
                startedAt: now, updatedAt: now, completedKeys: [], keyDigests: [:], totalKeys: totalKeys
            ))
        }

        guard var journal = existing, journal.version == 2, journal.status == "in_progress", journal.blockedKey == nil,
              journal.transferId == payload["transferId"] as? String,
              journal.packageSha256 == payload["packageSha256"] as? String else {
            return ["ok": false, "error": "Journal không khớp với phiên chuyển đang hoạt động."]
        }
        switch action {
        case "blockIntent":
            guard journal.rollbackPending == nil, let key = payload["key"] as? String,
                  journal.pendingKey?.key == key || (key == "omm.cleanShutdown" && journal.finalFlagOwned == true) else {
                return ["ok": false, "error": "Không xác minh được vị trí dữ liệu có sẵn."]
            }
            journal.blockedKey = key

        case "prepareKey", "markKey":
            guard journal.rollbackPending == nil,
                  let key = payload["key"] as? String, isEntryKey(key),
                  let sha256 = payload["sha256"] as? String, isDigest(sha256) else {
                return ["ok": false, "error": "Không xác minh được khóa chuyển dữ liệu."]
            }
            let intent = TransferKeyIntent(transferId: journal.transferId, key: key, sha256: sha256)
            if action == "prepareKey" {
                guard journal.completedKeys.count < journal.totalKeys, journal.keyDigests[key] == nil,
                      journal.pendingKey == nil || journal.pendingKey == intent else {
                    return ["ok": false, "error": "Có ý định ghi khác hoặc khóa đã được xác nhận."]
                }
                journal.pendingKey = intent
            } else {
                if journal.pendingKey == nil, journal.completedKeys.last == key, journal.keyDigests[key] == sha256 {
                    return ["ok": true, "journal": encodeObj(journal)]
                }
                guard journal.pendingKey == intent, journal.completedKeys.count < journal.totalKeys,
                      journal.keyDigests[key] == nil else {
                    return ["ok": false, "error": "Khóa chưa có ý định ghi hợp lệ."]
                }
                journal.completedKeys.append(key)
                journal.keyDigests[key] = sha256
                journal.pendingKey = nil
            }

        case "prepareRollback":
            var ownedKeys = journal.completedKeys
            if let pending = journal.pendingKey { ownedKeys.append(pending.key) }
            guard let keys = payload["keys"] as? [String], keys == ownedKeys,
                  let removeFlag = payload["removeCleanShutdown"] as? Bool, removeFlag == (journal.finalFlagOwned == true),
                  let reason = payload["reason"] as? String else {
                return ["ok": false, "error": "Không xác thực được phạm vi hoàn tác."]
            }
            if let pending = journal.rollbackPending,
               pending.keys != keys || pending.removeCleanShutdown != removeFlag || pending.reason != reason {
                return ["ok": false, "error": "Đã có yêu cầu hoàn tác khác chờ xử lý."]
            }
            journal.rollbackPending = TransferRollback(keys: keys, removeCleanShutdown: removeFlag, reason: reason)

        case "prepareFinalFlag", "complete":
            guard journal.rollbackPending == nil, journal.pendingKey == nil,
                  journal.completedKeys.count == journal.totalKeys else {
                return ["ok": false, "error": "Chưa xác nhận đủ dữ liệu để hoàn tất."]
            }
            if action == "prepareFinalFlag" {
                journal.finalFlagOwned = true
            } else {
                journal.status = "completed"
                journal.lastError = nil
            }

        case "rollback":
            guard let pending = journal.rollbackPending, pending.reason == payload["reason"] as? String else {
                return ["ok": false, "error": "Journal không có yêu cầu hoàn tác tương ứng."]
            }
            journal.status = "rolled_back"
            journal.rollbackPending = nil
            journal.finalFlagOwned = nil
            journal.pendingKey = nil
            journal.lastError = pending.reason

        default:
            return ["ok": false, "error": "Action không hợp lệ: " + action]
        }
        return commit(journal)
    }

    func writePackageFile(at url: URL, jsonString: String) throws {
        guard let data = jsonString.data(using: .utf8) else {
            throw NSError(domain: "OpenMindmapTransfer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Dữ liệu UTF-8 không hợp lệ."])
        }
        try data.write(to: url, options: [.atomic])
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    static func sha256Hex(_ string: String) -> String {
        let digest = SHA256.hash(data: Data(string.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func encodeObj(_ journal: TransferJournal) -> Any {
        guard let data = try? JSONEncoder().encode(journal),
              let obj = try? JSONSerialization.jsonObject(with: data) else {
            return [:]
        }
        return obj
    }
}
