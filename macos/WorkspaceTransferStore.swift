import CryptoKit
import Foundation

struct TransferJournal: Codable {
    var version: Int = 1
    var transferId: String
    var packageSha256: String
    var status: String // "in_progress" | "completed" | "rolled_back"
    var startedAt: String
    var updatedAt: String
    var completedKeys: [String]
    var keyDigests: [String: String]
    var totalKeys: Int
    var lastError: String?
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

    func loadJournal() -> TransferJournal? {
        guard let data = try? Data(contentsOf: journalURL) else { return nil }
        return try? JSONDecoder().decode(TransferJournal.self, from: data)
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
        switch action {
        case "getState":
            if let j = loadJournal(), let raw = try? JSONEncoder().encode(j),
               let obj = try? JSONSerialization.jsonObject(with: raw) {
                return ["ok": true, "journal": obj, "stateDir": stateDirectory.path]
            }
            return ["ok": true, "journal": NSNull(), "stateDir": stateDirectory.path]

        case "beginOrResume":
            guard let packageSha256 = payload["packageSha256"] as? String,
                  let totalKeys = payload["totalKeys"] as? Int else {
                return ["ok": false, "error": "Thiếu thông tin gói chuyển dữ liệu."]
            }
            let now = ISO8601DateFormatter().string(from: Date())
            if let existing = loadJournal() {
                if existing.status == "completed" {
                    return ["ok": false, "code": "already_completed", "error": "Gói chuyển dữ liệu đã hoàn tất trước đó.", "journal": encodeObj(existing)]
                }
                if existing.status == "in_progress" {
                    if existing.packageSha256 != packageSha256 {
                        return ["ok": false, "code": "mismatch_in_progress", "error": "Đang có tiến trình chuyển dữ liệu khác chưa hoàn tất. Hãy hoàn tất hoặc hoàn tác trước."]
                    }
                    return ["ok": true, "mode": "resume", "journal": encodeObj(existing)]
                }
            }
            let journal = TransferJournal(
                transferId: UUID().uuidString.lowercased(),
                packageSha256: packageSha256,
                status: "in_progress",
                startedAt: now,
                updatedAt: now,
                completedKeys: [],
                keyDigests: [:],
                totalKeys: totalKeys,
                lastError: nil
            )
            do {
                try saveJournal(journal)
                return ["ok": true, "mode": "start", "journal": encodeObj(journal)]
            } catch {
                return ["ok": false, "error": "Không ghi được journal: \(error.localizedDescription)"]
            }

        case "markKey":
            guard let key = payload["key"] as? String,
                  let sha256 = payload["sha256"] as? String,
                  var journal = loadJournal(), journal.status == "in_progress" else {
                return ["ok": false, "error": "Journal không ở trạng thái in_progress."]
            }
            if !journal.completedKeys.contains(key) {
                journal.completedKeys.append(key)
            }
            journal.keyDigests[key] = sha256
            journal.updatedAt = ISO8601DateFormatter().string(from: Date())
            do {
                try saveJournal(journal)
                return ["ok": true, "journal": encodeObj(journal)]
            } catch {
                return ["ok": false, "error": "Không cập nhật được journal: \(error.localizedDescription)"]
            }

        case "complete":
            guard var journal = loadJournal(), journal.status == "in_progress" else {
                return ["ok": false, "error": "Không có phiên chuyển dữ liệu đang chạy."]
            }
            journal.status = "completed"
            journal.updatedAt = ISO8601DateFormatter().string(from: Date())
            journal.lastError = nil
            do {
                try saveJournal(journal)
                return ["ok": true, "journal": encodeObj(journal)]
            } catch {
                return ["ok": false, "error": "Không hoàn tất được journal: \(error.localizedDescription)"]
            }

        case "rollback":
            let reason = payload["reason"] as? String
            guard var journal = loadJournal() else {
                return ["ok": true, "journal": NSNull()]
            }
            journal.status = "rolled_back"
            journal.updatedAt = ISO8601DateFormatter().string(from: Date())
            journal.lastError = reason
            do {
                try saveJournal(journal)
                return ["ok": true, "journal": encodeObj(journal)]
            } catch {
                return ["ok": false, "error": "Không lưu được trạng thái rollback: \(error.localizedDescription)"]
            }

        case "resetForRetry":
            do {
                try clearJournal()
                return ["ok": true]
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }

        default:
            return ["ok": false, "error": "Action không hợp lệ: \(action)"]
        }
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
