import AppKit
import Foundation
import WebKit

private enum CloseReason: String {
    case windowClose = "window-close"
    case appQuit = "app-quit"
}

private final class LocalOnlyRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let url = request.url, url.host == "127.0.0.1", url.port == 41735 else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}

private final class DiagnosticLogger {
    private let logURL: URL
    private let queue = DispatchQueue(label: "local.openmindmap.log")

    init() {
        let fm = FileManager.default
        let logs = fm.urls(for: .libraryDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Logs/OpenMindmap", isDirectory: true)
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/OpenMindmap", isDirectory: true)
        try? fm.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        logURL = logs.appendingPathComponent("launcher.log")
    }

    func log(_ event: String, detail: String = "") {
        queue.async { [logURL] in
            let ts = ISO8601DateFormatter().string(from: Date())
            let line = detail.isEmpty ? "[\(ts)] \(event)\n" : "[\(ts)] \(event): \(detail)\n"
            if let data = line.data(using: .utf8) {
                if FileManager.default.fileExists(atPath: logURL.path) {
                    if let attr = try? FileManager.default.attributesOfItem(atPath: logURL.path),
                       let size = attr[.size] as? NSNumber, size.intValue > 1_048_576 {
                        try? Data().write(to: logURL)
                    }
                    if let fh = try? FileHandle(forWritingTo: logURL) {
                        _ = try? fh.seekToEnd()
                        try? fh.write(contentsOf: data)
                        try? fh.close()
                    }
                } else {
                    try? data.write(to: logURL, options: [.atomic])
                }
            }
        }
    }

    var fileURL: URL { logURL }
}

final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

final class OpenMindmapLauncher: NSObject,
    NSApplicationDelegate,
    NSWindowDelegate,
    WKNavigationDelegate,
    WKUIDelegate,
    WKDownloadDelegate,
    WKScriptMessageHandler,
    MenuActionHandling {

    private let verifyInstall = CommandLine.arguments.contains("--verify-install")
    private let transferModeArg = CommandLine.arguments.contains("--workspace-transfer")
        || ProcessInfo.processInfo.environment["OPENMINDMAP_WORKSPACE_TRANSFER"] == "1"
    private let transferRole: String = {
        if let idx = CommandLine.arguments.firstIndex(of: "--transfer-role"), idx + 1 < CommandLine.arguments.count {
            return CommandLine.arguments[idx + 1] == "source" ? "source" : "target"
        }
        return ProcessInfo.processInfo.environment["OPENMINDMAP_TRANSFER_ROLE"] == "source" ? "source" : "target"
    }()
    private let customTransferDir: URL? = {
        if let idx = CommandLine.arguments.firstIndex(of: "--transfer-state-dir"), idx + 1 < CommandLine.arguments.count {
            return URL(fileURLWithPath: CommandLine.arguments[idx + 1], isDirectory: true)
        }
        if let env = ProcessInfo.processInfo.environment["OPENMINDMAP_TRANSFER_STATE_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        return nil
    }()

    private let localHost = "127.0.0.1"
    private let localPort = 41735
    private lazy var localURL = URL(string: "http://\(localHost):\(localPort)/")!
    private lazy var transferURL = URL(string: "http://\(localHost):\(localPort)/transfer?role=\(transferRole)")!

    private let server = Process()
    private let output = Pipe()
    private var lineBuffer = ""
    private var sawReadyLine = false
    private var probing = false
    private var ready = false
    private var stopping = false
    private var timedOut = false
    private var deadlineWorkItem: DispatchWorkItem?

    private let logger = DiagnosticLogger()
    private lazy var transferStore = WorkspaceTransferStore(customDirectory: customTransferDir)
    private lazy var menuController = MenuController(handler: self)
    private let sessionDelegate = LocalOnlyRedirectDelegate()
    private lazy var urlSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 4.0
        cfg.timeoutIntervalForResource = 5.0
        return URLSession(configuration: cfg, delegate: sessionDelegate, delegateQueue: nil)
    }()

    private var window: NSWindow?
    private var webView: WKWebView?
    private var activeDownloads: [ObjectIdentifier: (download: WKDownload, suggested: String)] = [:]
    private var bridgeReady = false
    private var hasLoadedMainURL = false
    private var approvedWindowClose = false
    private var closeCheckInFlight = false
    private var transferActive = false

    #if ENABLE_MAC_TEST_HARNESS
    private let testScriptPath: String? = {
        if let idx = CommandLine.arguments.firstIndex(of: "--mac-test-script"), idx + 1 < CommandLine.arguments.count {
            return CommandLine.arguments[idx + 1]
        }
        return nil
    }()
    private var testHarnessStarted = false
    private var nextTestAlertChoice: Int?
    private var lastTestAlertShown: [String: Any]?
    private var lastExternalOpenedURL: String?
    #endif

    var isTransferOnlyMode: Bool { transferActive }

    func isNativeAppKitTextResponder() -> Bool {
        guard let responder = NSApp.keyWindow?.firstResponder else { return false }
        if responder is NSTextView || responder is NSText {
            if let view = responder as? NSView, let webView, view.isDescendant(of: webView) {
                return false
            }
            return true
        }
        return false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        logger.log("app.launch", detail: "verifyInstall=\(verifyInstall) transferMode=\(transferModeArg)")
        transferActive = transferModeArg
        if !verifyInstall {
            menuController.installMainMenu()
        }

        guard let resources = Bundle.main.resourceURL else {
            fail("Không tìm thấy tài nguyên của OpenMindmap.")
            return
        }
        let helpers = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers", isDirectory: true)
        let nodeURL = helpers.appendingPathComponent("node")
        let web = resources.appendingPathComponent("web", isDirectory: true)
        let wrapper = web.appendingPathComponent("launch-local.cjs")
        guard FileManager.default.isExecutableFile(atPath: nodeURL.path),
              FileManager.default.fileExists(atPath: wrapper.path) else {
            fail("Không tìm thấy runtime Node hoặc payload web của OpenMindmap.")
            return
        }

        server.currentDirectoryURL = web
        server.executableURL = nodeURL
        server.arguments = [wrapper.path]
        server.environment = [
            "HOME": NSHomeDirectory(),
            "PATH": "/usr/bin:/bin",
            "NODE_ENV": "production",
            "NEXT_TELEMETRY_DISABLED": "1",
            "HOSTNAME": localHost,
            "PORT": String(localPort),
            "OPENMINDMAP_LAUNCHER_PID": String(ProcessInfo.processInfo.processIdentifier),
        ]
        server.standardOutput = output
        server.standardError = output
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            guard !bytes.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            let chunk = String(decoding: bytes, as: UTF8.self)
            DispatchQueue.main.async { self?.consume(chunk) }
        }
        server.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.stopping, !self.timedOut else { return }
                self.deadlineWorkItem?.cancel()
                self.logger.log("server.terminated", detail: "status=\(proc.terminationStatus)")
                self.fail(self.ready
                    ? "Máy chủ OpenMindmap đã dừng đột ngột."
                    : "Không khởi động được OpenMindmap tại cổng 41735. Hãy kiểm tra cổng có đang được dùng hay không.")
            }
        }

        do {
            try server.run()
            logger.log("server.spawned", detail: "pid=\(server.processIdentifier)")
            let timeoutItem = DispatchWorkItem { [weak self] in
                guard let self, !self.ready, !self.stopping else { return }
                self.timedOut = true
                self.logger.log("server.timeout", detail: "20s")
                self.terminateServerAndWait()
                self.fail("OpenMindmap mất quá nhiều thời gian để khởi động.")
            }
            deadlineWorkItem = timeoutItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeoutItem)
        } catch {
            fail("Không chạy được runtime đi kèm: \(error.localizedDescription)")
        }
    }

    private func consume(_ chunk: String) {
        guard !ready, !stopping, !timedOut else { return }
        lineBuffer += chunk
        while let range = lineBuffer.range(of: "\n") {
            let line = String(lineBuffer[..<range.lowerBound])
            lineBuffer = String(lineBuffer[range.upperBound...])
            checkReadyLine(line)
        }
        if !lineBuffer.isEmpty {
            checkReadyLine(lineBuffer)
        }
    }

    private func checkReadyLine(_ line: String) {
        guard !sawReadyLine, line.contains("Ready in "), server.isRunning else { return }
        sawReadyLine = true
        probeLocalHTTP()
    }

    private func probeLocalHTTP() {
        guard !ready, !stopping, !timedOut, server.isRunning, !probing else { return }
        probing = true
        var req = URLRequest(url: localURL)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        urlSession.dataTask(with: req) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.probing = false
                guard !self.ready, !self.stopping, !self.timedOut, self.server.isRunning else { return }
                if let http = response as? HTTPURLResponse,
                   http.statusCode == 200,
                   let finalURL = http.url,
                   finalURL.host == self.localHost,
                   finalURL.port == self.localPort,
                   let body = data.flatMap({ String(data: $0, encoding: .utf8) }),
                   body.contains("OpenMindmap") {
                    self.ready = true
                    self.deadlineWorkItem?.cancel()
                    self.lineBuffer = ""
                    self.logger.log("server.ready", detail: "http://\(self.localHost):\(self.localPort)/")
                    if self.verifyInstall {
                        FileHandle.standardOutput.write(Data("READY 127.0.0.1:41735\n".utf8))
                    } else {
                        self.openMainWindow()
                    }
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                        self?.probeLocalHTTP()
                    }
                }
            }
        }.resume()
    }

    // MARK: - Main Window + WKWebView

    private func openMainWindow() {
        guard ready, server.isRunning else { return }
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.preferences.isElementFullscreenEnabled = true

        let ucc = WKUserContentController()
        let meta: [String: Any] = [
            "platform": "macos",
            "appVersion": "0.2.2",
            "transferMode": transferActive,
            "transferRole": transferRole,
            "logPath": logger.fileURL.path,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: meta),
           let json = String(data: data, encoding: .utf8) {
            let script = WKUserScript(
                source: "window.__OMM_NATIVE_MACOS__ = \(json);",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            ucc.addUserScript(script)
        }

        let weakSelf = WeakScriptHandler(self)
        ucc.add(weakSelf, name: "ommMenuState")
        ucc.add(weakSelf, name: "ommDownload")
        ucc.add(weakSelf, name: "ommTransfer")
        ucc.add(weakSelf, name: "ommLog")
        #if ENABLE_MAC_TEST_HARNESS
        if testScriptPath != nil {
            ucc.add(weakSelf, name: "ommTest")
        }
        #endif
        cfg.userContentController = ucc

        let rect = NSRect(x: 0, y: 0, width: 1280, height: 800)
        let wv = WKWebView(frame: rect, configuration: cfg)
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) {
            #if ENABLE_MAC_TEST_HARNESS
            wv.isInspectable = true
            #endif
        }

        let win = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = transferActive ? "Chuyển dữ liệu — OpenMindmap" : "OpenMindmap"
        win.minSize = NSSize(width: 900, height: 600)
        win.isReleasedWhenClosed = false
        win.delegate = self
        win.contentView = wv
        win.center()
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = win
        self.webView = wv
        self.bridgeReady = false
        self.hasLoadedMainURL = false

        let targetURL = transferActive ? transferURL : localURL
        #if ENABLE_MAC_TEST_HARNESS
        if CommandLine.arguments.contains("--harness-clear-storage") {
            let types = WKWebsiteDataStore.allWebsiteDataTypes()
            WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self, weak wv] in
                guard let self, let wv else { return }
                DispatchQueue.main.async {
                    self.logger.log("window.open.cleared_store", detail: targetURL.absoluteString)
                    wv.load(URLRequest(url: targetURL, cachePolicy: .reloadIgnoringLocalCacheData))
                }
            }
            return
        }
        #endif
        logger.log("window.open", detail: targetURL.absoluteString)
        wv.load(URLRequest(url: targetURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !verifyInstall, ready, server.isRunning {
            openMainWindow()
        }
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    // MARK: - Menu Action Handling

    @objc func handleCommandMenuItem(_ sender: NSMenuItem) {
        guard let cmd = sender as? CommandMenuItem else { return }

        // 1. Native AppKit text responders (e.g., alerts, open/save panels)
        if cmd.supportsTextResponder && isNativeAppKitTextResponder() {
            performCocoaTextAction(for: cmd.commandId)
            return
        }

        guard let webView else { return }

        // 2. If a text input inside WKWebView is focused, let WebKit handle Copy/Cut/Paste/SelectAll/Undo/Redo natively.
        if cmd.supportsTextResponder, let snap = menuController.snapshot, snap.focusedField {
            performWebKitTextAction(for: cmd.commandId, in: webView)
            return
        }

        // 3. Mindmap command dispatch with live active-element check + generation guard
        let reqId = UUID().uuidString.lowercased()
        let generation = menuController.snapshot?.generation
        let viewSession = menuController.snapshot?.viewSession
        var payload: [String: Any] = [
            "commandId": cmd.commandId,
            "requestId": reqId,
            "supportsTextResponder": cmd.supportsTextResponder,
        ]
        if let generation { payload["expectedProjectGeneration"] = generation }
        if let viewSession { payload["viewSession"] = viewSession }

        dispatchBridgeCommand(payload, commandId: cmd.commandId, supportsTextResponder: cmd.supportsTextResponder)
    }

    @objc func handleRecentProjectMenuItem(_ sender: NSMenuItem) {
        guard let recent = sender as? RecentProjectMenuItem else { return }
        let reqId = UUID().uuidString.lowercased()
        var payload: [String: Any] = [
            "commandId": "A05_OPEN_RECENT",
            "targetId": recent.projectId,
            "requestId": reqId,
        ]
        if let generation = menuController.snapshot?.generation {
            payload["expectedProjectGeneration"] = generation
        }
        if let viewSession = menuController.snapshot?.viewSession {
            payload["viewSession"] = viewSession
        }
        dispatchBridgeCommand(payload, commandId: "A05_OPEN_RECENT", supportsTextResponder: false)
    }

    @objc func handleWindowCloseMenu(_ sender: Any?) {
        window?.performClose(sender)
    }

    @objc func handleShowMainWindowMenu(_ sender: Any?) {
        openMainWindow()
    }

    private func performCocoaTextAction(for commandId: String) {
        switch commandId {
        case "A12": NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)
        case "EDIT_CUT": NSApp.sendAction(#selector(NSText.cut(_:)), to: nil, from: nil)
        case "EDIT_PASTE": NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: nil)
        case "A14": NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil)
        case "A10": NSApp.sendAction(Selector(("undo:")), to: nil, from: nil)
        case "A11": NSApp.sendAction(Selector(("redo:")), to: nil, from: nil)
        default: break
        }
    }

    private func performWebKitTextAction(for commandId: String, in webView: WKWebView) {
        window?.makeFirstResponder(webView)
        switch commandId {
        case "A12":
            NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)
        case "EDIT_CUT":
            NSApp.sendAction(#selector(NSText.cut(_:)), to: nil, from: nil)
        case "EDIT_PASTE":
            NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: nil)
        case "A14":
            NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil)
        case "A10":
            webView.evaluateJavaScript("document.execCommand('undo')") { _, _ in }
        case "A11":
            webView.evaluateJavaScript("document.execCommand('redo')") { _, _ in }
        default:
            break
        }
    }

    private func dispatchBridgeCommand(_ payload: [String: Any], commandId: String, supportsTextResponder: Bool) {
        guard let webView,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }

        let js = """
        (() => {
          const ae = document.activeElement;
          const inField = !!(ae && ae.closest && ae.closest('input, textarea, select, [contenteditable="true"]'));
          if (\(supportsTextResponder ? "true" : "false") && inField) {
            return { routedToTextField: true };
          }
          if (!window.__ommBridge || typeof window.__ommBridge.executeCommand !== 'function') {
            return { ok: false, reason: 'bridge_unavailable' };
          }
          return window.__ommBridge.executeCommand(\(json));
        })()
        """
        webView.evaluateJavaScript(js) { [weak self, weak webView] result, error in
            guard let self else { return }
            if let error {
                self.logger.log("menu.cmd.error", detail: "\(commandId): \(error.localizedDescription)")
                return
            }
            if let dict = result as? [String: Any], dict["routedToTextField"] as? Bool == true, let webView {
                self.performWebKitTextAction(for: commandId, in: webView)
            }
        }
    }

    // MARK: - Safe Close (Cmd+W / Red Button) & Quit (Cmd+Q)

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if approvedWindowClose {
            approvedWindowClose = false
            return true
        }
        if transferActive || webView == nil || !hasLoadedMainURL {
            return true
        }
        guard !closeCheckInFlight else { return false }
        closeCheckInFlight = true
        confirmCloseOrQuit(reason: .windowClose, hostWindow: sender) { [weak self, weak sender] allow in
            guard let self else { return }
            self.closeCheckInFlight = false
            guard allow, let sender else { return }
            self.logger.log("window.closed")
            sender.orderOut(nil)
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === window {
            logger.log("window.closed")
            bridgeReady = false
            hasLoadedMainURL = false
            webView?.navigationDelegate = nil
            webView?.uiDelegate = nil
            webView = nil
            window?.delegate = nil
            window = nil
            menuController.applySnapshot(MenuSnapshot(
                version: 1, generation: 0, viewSession: "", hasDoc: false, projectId: nil, projectName: nil,
                saveStatus: "none", dirty: false, conflict: false, transitionBusy: false,
                leavePromptOpen: false, modalOpen: false, focusedField: false, editingNode: false,
                trashCount: 0, recentProjects: [], commands: [:]
            ))
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if verifyInstall || stopping {
            return .terminateNow
        }
        // If no open window (already cleanly closed with Cmd+W) or clean transfer view, terminate immediately.
        guard let window, let _ = webView, hasLoadedMainURL else {
            return .terminateNow
        }
        if transferActive {
            return .terminateNow
        }
        guard !closeCheckInFlight else { return .terminateCancel }
        closeCheckInFlight = true
        confirmCloseOrQuit(reason: .appQuit, hostWindow: window) { [weak self] allow in
            guard let self else {
                NSApp.reply(toApplicationShouldTerminate: false)
                return
            }
            self.closeCheckInFlight = false
            NSApp.reply(toApplicationShouldTerminate: allow)
        }
        return .terminateLater
    }

    private func confirmCloseOrQuit(reason: CloseReason, hostWindow: NSWindow, completion: @escaping (Bool) -> Void) {
        guard bridgeReady else {
            logger.log("close.blocked.bridge_disconnected", detail: reason.rawValue)
            showBlockingAlert(
                on: hostWindow,
                title: "Không thể xác minh trạng thái lưu",
                message: "Kết nối tới không gian làm việc đã ngắt. Đã hủy thao tác để bảo vệ dữ liệu chưa lưu.",
                style: .warning
            ) { completion(false) }
            return
        }

        let requestId = UUID().uuidString
        callBridgeAsync("window.__ommBridge.prepareNativeClose(\"\(requestId)\")", timeoutSeconds: 5.0) { [weak self, weak hostWindow] result in
            guard let self else { completion(false); return }
            switch result {
            case .failure(let message):
                self.cancelCloseAttempt(requestId)
                self.logger.log("close.blocked.bridge_timeout_or_err", detail: "\(reason.rawValue): \(message)")
                self.showBlockingAlert(
                    on: hostWindow,
                    title: "Không thể kiểm tra dữ liệu chưa lưu",
                    message: "Ứng dụng không nhận được phản hồi lưu trong 5 giây (\(message)). Đã hủy đóng để tránh mất dữ liệu.",
                    style: .warning
                ) { completion(false) }

            case .success(let dict):
                let decision = dict["decision"] as? String ?? "error"
                switch decision {
                case "allow-clean":
                    self.callBridgeAsync("window.__ommBridge.finalizeCleanClose(\"\(requestId)\")", timeoutSeconds: 6.0) { result in
                        switch result {
                        case .success(let dict) where (dict["ok"] as? Bool) == true:
                            self.logCloseSessionWarning(dict)
                            completion(true)
                        case .success(let dict):
                            self.showBlockingAlert(on: hostWindow, title: "Không thể hoàn tất đóng",
                                message: dict["error"] as? String ?? "Không nhận được xác nhận lưu phiên.",
                                style: .warning) { completion(false) }
                        case .failure(let error):
                            self.cancelCloseAttempt(requestId)
                            self.showBlockingAlert(on: hostWindow, title: "Không thể hoàn tất đóng",
                                message: error, style: .warning) { completion(false) }
                        }
                    }

                case "busy":
                    let msg = dict["message"] as? String ?? "Đang có thao tác lưu hoặc chuyển dự án khác. Hãy đợi hoàn tất."
                    self.showBlockingAlert(on: hostWindow, title: "Đang xử lý", message: msg, style: .informational) {
                        completion(false)
                    }

                case "conflict":
                    let msg = dict["message"] as? String ?? "Dự án đang có xung đột tệp. Hãy chọn Tải lại hoặc Lưu thành trước khi đóng."
                    self.showBlockingAlert(on: hostWindow, title: "Xung đột tệp", message: msg, style: .warning) {
                        completion(false)
                    }

                case "confirm-dirty":
                    let proj = dict["projectName"] as? String ?? "Dự án hiện tại"
                    self.presentDirtyClosePrompt(
                        on: hostWindow,
                        projectName: proj,
                        requestId: requestId,
                        reason: reason,
                        completion: completion
                    )

                default:
                    let msg = dict["message"] as? String ?? "Không xác định được trạng thái lưu."
                    self.showBlockingAlert(on: hostWindow, title: "Lỗi kiểm tra lưu", message: msg, style: .warning) {
                        completion(false)
                    }
                }
            }
        }
    }

    private func presentDirtyClosePrompt(
        on hostWindow: NSWindow?,
        projectName: String,
        requestId: String,
        reason: CloseReason,
        completion: @escaping (Bool) -> Void
    ) {
        let actionWord = reason == .appQuit ? "thoát OpenMindmap" : "đóng cửa sổ"
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "\"\(projectName)\" có thay đổi chưa lưu"
        alert.informativeText = "Bạn có muốn lưu thay đổi trước khi \(actionWord) không?"
        alert.addButton(withTitle: reason == .appQuit ? "Lưu và thoát" : "Lưu và đóng") // .alertFirstButtonReturn
        alert.addButton(withTitle: "Bỏ thay đổi") // .alertSecondButtonReturn
        alert.addButton(withTitle: "Hủy") // .alertThirdButtonReturn

        let handleChoice: (NSApplication.ModalResponse) -> Void = { [weak self, weak hostWindow] resp in
            guard let self else { completion(false); return }
            switch resp {
            case .alertFirstButtonReturn:
                self.callBridgeAsync("window.__ommBridge.commitAndFlushBeforeClose(\"\(requestId)\")", timeoutSeconds: 8.0) { saveRes in
                    switch saveRes {
                    case .success(let dict) where (dict["ok"] as? Bool) == true:
                        self.logger.log("close.dirty.saved", detail: reason.rawValue)
                        self.logCloseSessionWarning(dict)
                        completion(true)
                    case .success(let dict):
                        let errMsg = dict["error"] as? String ?? "Không thể lưu dự án trước khi đóng."
                        self.logger.log("close.dirty.save_failed", detail: errMsg)
                        self.showBlockingAlert(on: hostWindow, title: "Lưu thất bại", message: errMsg, style: .critical) {
                            completion(false)
                        }
                    case .failure(let err):
                        self.cancelCloseAttempt(requestId)
                        self.logger.log("close.dirty.save_timeout", detail: err)
                        self.showBlockingAlert(on: hostWindow, title: "Lưu thất bại", message: err, style: .critical) {
                            completion(false)
                        }
                    }
                }

            case .alertSecondButtonReturn:
                self.callBridgeAsync("window.__ommBridge.discardAndPrepareClose(\"\(requestId)\")", timeoutSeconds: 8.0) { discardRes in
                    switch discardRes {
                    case .success(let dict) where (dict["ok"] as? Bool) == true:
                        self.logger.log("close.dirty.discarded", detail: reason.rawValue)
                        self.logCloseSessionWarning(dict)
                        completion(true)
                    default:
                        self.cancelCloseAttempt(requestId)
                        self.showBlockingAlert(
                            on: hostWindow,
                            title: "Không thể hủy thay đổi an toàn",
                            message: "Đã giữ nguyên cửa sổ để tránh hỏng dữ liệu.",
                            style: .warning
                        ) { completion(false) }
                    }
                }

            default:
                self.callBridgeAsync("window.__ommBridge.cancelNativeClose(\"\(requestId)\")", timeoutSeconds: 2.0) { _ in
                    self.logger.log("close.dirty.cancelled", detail: reason.rawValue)
                    completion(false)
                }
            }
        }

        #if ENABLE_MAC_TEST_HARNESS
        if testScriptPath != nil, let choice = nextTestAlertChoice {
            nextTestAlertChoice = nil
            lastTestAlertShown = [
                "title": alert.messageText,
                "message": alert.informativeText,
                "buttons": alert.buttons.map { $0.title },
            ]
            let modalResp: NSApplication.ModalResponse =
                choice == 0 ? .alertFirstButtonReturn :
                choice == 1 ? .alertSecondButtonReturn : .alertThirdButtonReturn
            DispatchQueue.main.async { handleChoice(modalResp) }
            return
        }
        #endif

        if let hostWindow {
            NSApp.activate(ignoringOtherApps: true)
            alert.beginSheetModal(for: hostWindow, completionHandler: handleChoice)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            handleChoice(alert.runModal())
        }
    }

    private func logCloseSessionWarning(_ result: [String: Any]) {
        if let message = result["sessionWarning"] as? String {
            logger.log("close.session_warning", detail: message)
        }
    }

    private func cancelCloseAttempt(_ requestId: String) {
        callBridgeAsync("window.__ommBridge.cancelNativeClose(\"\(requestId)\")", timeoutSeconds: 2.0) { _ in }
    }

    private enum BridgeCallResult {
        case success([String: Any])
        case failure(String)
    }

    private func callBridgeAsync(_ expression: String, timeoutSeconds: TimeInterval, completion: @escaping (BridgeCallResult) -> Void) {
        guard let webView else {
            completion(.failure("WebView chưa sẵn sàng"))
            return
        }
        var done = false
        let timer = DispatchWorkItem {
            guard !done else { return }
            done = true
            completion(.failure("Quá thời gian phản hồi (\(Int(timeoutSeconds))s)"))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSeconds, execute: timer)

        webView.callAsyncJavaScript("return await (\(expression));", arguments: [:], in: nil, in: .page) { result in
            DispatchQueue.main.async {
                guard !done else { return }
                done = true
                timer.cancel()
                switch result {
                case .success(let value):
                    if let dict = value as? [String: Any] {
                        completion(.success(dict))
                    } else {
                        completion(.failure("Phản hồi bridge không hợp lệ"))
                    }
                case .failure(let error):
                    completion(.failure(error.localizedDescription))
                }
            }
        }
    }

    private func showBlockingAlert(
        on hostWindow: NSWindow?,
        title: String,
        message: String,
        style: NSAlert.Style,
        completion: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.alertStyle = style
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Đóng thông báo")
        #if ENABLE_MAC_TEST_HARNESS
        if testScriptPath != nil {
            lastTestAlertShown = [
                "title": title,
                "message": message,
                "buttons": alert.buttons.map { $0.title },
            ]
            DispatchQueue.main.async { completion() }
            return
        }
        #endif
        if let hostWindow {
            NSApp.activate(ignoringOtherApps: true)
            alert.beginSheetModal(for: hostWindow) { _ in completion() }
        } else {
            NSApp.activate(ignoringOtherApps: true)
            _ = alert.runModal()
            completion()
        }
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "ommMenuState":
            bridgeReady = true
            if let dict = message.body as? [String: Any],
               let data = try? JSONSerialization.data(withJSONObject: dict),
               let snap = try? JSONDecoder().decode(MenuSnapshot.self, from: data) {
                menuController.applySnapshot(snap)
                if let win = window, !transferActive {
                    win.isDocumentEdited = snap.dirty
                    if let name = snap.projectName, !name.isEmpty {
                        win.title = "\(name) — OpenMindmap"
                    } else {
                        win.title = "OpenMindmap"
                    }
                }
            }

        case "ommDownload":
            handleNativeDownloadMessage(message.body)

        case "ommTransfer":
            handleTransferMessage(message.body)

        case "ommLog":
            if let dict = message.body as? [String: Any],
               let event = dict["event"] as? String {
                let detail = dict["detail"] as? String ?? ""
                logger.log("web.\(event)", detail: detail)
            }

        #if ENABLE_MAC_TEST_HARNESS
        case "ommTest":
            handleTestHarnessMessage(message.body)
        #endif

        default:
            break
        }
    }

    // MARK: - Native Save Panel Download Bridge + WKDownloadDelegate

    private func handleNativeDownloadMessage(_ body: Any) {
        guard let dict = body as? [String: Any],
              let id = dict["id"] as? String,
              let fileName = dict["fileName"] as? String,
              let base64 = dict["base64"] as? String,
              let bytes = Data(base64Encoded: base64) else {
            return
        }

        #if ENABLE_MAC_TEST_HARNESS
        if let autoDir = ProcessInfo.processInfo.environment["OPENMINDMAP_AUTO_SAVE_DIR"], !autoDir.isEmpty {
            let dest = URL(fileURLWithPath: autoDir, isDirectory: true).appendingPathComponent(fileName)
            do {
                try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                try bytes.write(to: dest, options: [.atomic])
                logger.log("download.saved.auto", detail: "\(fileName) bytes=\(bytes.count)")
                resolveNativeDownload(id: id, ok: true, cancelled: false, path: dest.path, error: nil)
            } catch {
                resolveNativeDownload(id: id, ok: false, cancelled: false, path: nil, error: error.localizedDescription)
            }
            return
        }
        #endif

        let panel = NSSavePanel()
        panel.nameFieldStringValue = fileName
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false

        let finishSave: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
            guard let self else { return }
            guard resp == .OK, let dest = panel.url else {
                self.logger.log("download.cancelled", detail: fileName)
                self.resolveNativeDownload(id: id, ok: false, cancelled: true, path: nil, error: nil)
                return
            }
            do {
                try bytes.write(to: dest, options: [.atomic])
                self.logger.log("download.saved", detail: "\(dest.lastPathComponent) bytes=\(bytes.count)")
                self.resolveNativeDownload(id: id, ok: true, cancelled: false, path: dest.path, error: nil)
            } catch {
                self.logger.log("download.failed", detail: error.localizedDescription)
                self.resolveNativeDownload(id: id, ok: false, cancelled: false, path: nil, error: error.localizedDescription)
            }
        }

        if let window {
            panel.beginSheetModal(for: window, completionHandler: finishSave)
        } else {
            finishSave(panel.runModal())
        }
    }

    private func resolveNativeDownload(id: String, ok: Bool, cancelled: Bool, path: String?, error: String?) {
        let obj: [String: Any] = [
            "id": id,
            "ok": ok,
            "cancelled": cancelled,
            "path": path ?? NSNull(),
            "error": error ?? NSNull(),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__ommResolveNativeDownload && window.__ommResolveNativeDownload(\(json));") { _, _ in }
    }

    private func handleTransferMessage(_ body: Any) {
        guard let dict = body as? [String: Any],
              let reqId = dict["reqId"] as? String else { return }

        let action = dict["action"] as? String ?? ""
        if action == "exitTransferToApp" {
            guard transferActive, let journal = try? transferStore.loadJournal(), journal.status == "completed",
                  journal.transferId == dict["transferId"] as? String else {
                replyTransfer(reqId: reqId, result: ["ok": false, "error": "Chưa xác nhận hoàn tất phiên chuyển dữ liệu."])
                return
            }
            replyTransfer(reqId: reqId, result: ["ok": true])
            transferActive = false
            window?.title = "OpenMindmap"
            webView?.load(URLRequest(url: localURL, cachePolicy: .reloadIgnoringLocalCacheData))
            return
        }

        if action == "savePackageFile" {
            let fileName = (dict["fileName"] as? String) ?? "openmindmap-workspace-transfer.json"
            let jsonText = dict["json"] as? String ?? ""
            #if ENABLE_MAC_TEST_HARNESS
            if let autoDir = ProcessInfo.processInfo.environment["OPENMINDMAP_AUTO_SAVE_DIR"], !autoDir.isEmpty {
                let dest = URL(fileURLWithPath: autoDir, isDirectory: true).appendingPathComponent(fileName)
                do {
                    try transferStore.writePackageFile(at: dest, jsonString: jsonText)
                    replyTransfer(reqId: reqId, result: ["ok": true, "path": dest.path])
                } catch {
                    replyTransfer(reqId: reqId, result: ["ok": false, "error": error.localizedDescription])
                }
                return
            }
            #endif
            let panel = NSSavePanel()
            panel.nameFieldStringValue = fileName
            panel.canCreateDirectories = true
            let run: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
                guard let self else { return }
                guard resp == .OK, let url = panel.url else {
                    self.replyTransfer(reqId: reqId, result: ["ok": false, "cancelled": true])
                    return
                }
                do {
                    try self.transferStore.writePackageFile(at: url, jsonString: jsonText)
                    self.replyTransfer(reqId: reqId, result: ["ok": true, "path": url.path])
                } catch {
                    self.replyTransfer(reqId: reqId, result: ["ok": false, "error": error.localizedDescription])
                }
            }
            if let window { panel.beginSheetModal(for: window, completionHandler: run) } else { run(panel.runModal()) }
            return
        }

        let res = transferStore.handleBridgeAction(dict)
        replyTransfer(reqId: reqId, result: res)
    }

    private func replyTransfer(reqId: String, result: [String: Any]) {
        let envelope: [String: Any] = ["reqId": reqId, "result": result]
        guard let data = try? JSONSerialization.data(withJSONObject: envelope),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__ommResolveNativeTransfer && window.__ommResolveNativeTransfer(\(json));") { _, _ in }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let url = webView.url, url.host == localHost, url.port == localPort {
            hasLoadedMainURL = true
            logger.log("webview.didFinish", detail: url.path)
            #if ENABLE_MAC_TEST_HARNESS
            maybeStartTestHarness()
            #endif
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        logger.log("webview.didFail", detail: error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bridgeReady = false
        logger.log("webview.process_terminated")
        showBlockingAlert(
            on: window,
            title: "Tiến trình hiển thị đã khởi động lại",
            message: "OpenMindmap sẽ tải lại giao diện từ dữ liệu đã lưu gần nhất.",
            style: .warning
        ) { [weak self, weak webView] in
            guard let self, let webView else { return }
            let target = self.transferActive ? self.transferURL : self.localURL
            webView.load(URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData))
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let isAllowedExternalScheme = ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "")
        let isLocalLoopback = url.scheme == "http" && url.host == localHost && (url.port ?? 80) == localPort

        if navigationAction.targetFrame == nil {
            if isAllowedExternalScheme && !isLocalLoopback {
                openExternalSafely(url)
                logger.log("external.open", detail: url.scheme ?? "url")
            }
            decisionHandler(.cancel)
            return
        }

        if navigationAction.targetFrame?.isMainFrame == true {
            if isLocalLoopback {
                decisionHandler(.allow)
                return
            }
            if isAllowedExternalScheme && navigationAction.navigationType == .linkActivated {
                openExternalSafely(url)
                logger.log("external.open", detail: url.scheme ?? "url")
            } else {
                logger.log("navigation.blocked", detail: url.host ?? url.scheme ?? "unknown")
            }
            decisionHandler(.cancel)
            return
        }

        decisionHandler(isLocalLoopback ? .allow : .cancel)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let key = ObjectIdentifier(download)
        activeDownloads[key] = (download, suggestedFilename)
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        let handle: (NSApplication.ModalResponse) -> Void = { resp in
            completionHandler(resp == .OK ? panel.url : nil)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: handle)
        } else {
            handle(panel.runModal())
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download)
        let name = activeDownloads.removeValue(forKey: key)?.suggested ?? ""
        logger.log("wkdownload.finished", detail: name)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download)
        let name = activeDownloads.removeValue(forKey: key)?.suggested ?? ""
        logger.log("wkdownload.failed", detail: "\(name): \(error.localizedDescription)")
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url,
           ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
            logger.log("external.popup_open", detail: url.scheme ?? "url")
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        logger.log("ui.openPanel.requested", detail: "multi=\(parameters.allowsMultipleSelection)")
        #if ENABLE_MAC_TEST_HARNESS
        if testScriptPath != nil,
           let mockFile = ProcessInfo.processInfo.environment["OPENMINDMAP_AUTO_OPEN_FILE"],
           !mockFile.isEmpty,
           FileManager.default.fileExists(atPath: mockFile) {
            logger.log("ui.openPanel.harness_auto", detail: URL(fileURLWithPath: mockFile).lastPathComponent)
            DispatchQueue.main.async {
                completionHandler([URL(fileURLWithPath: mockFile)])
            }
            return
        }
        #endif
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        let done: (NSApplication.ModalResponse) -> Void = { resp in
            completionHandler(resp == .OK ? panel.urls : nil)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: done)
        } else {
            done(panel.runModal())
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        showBlockingAlert(on: window, title: "OpenMindmap", message: message, style: .informational, completion: completionHandler)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "OpenMindmap"
        alert.informativeText = message
        alert.addButton(withTitle: "Đồng ý")
        alert.addButton(withTitle: "Hủy")
        let done: (NSApplication.ModalResponse) -> Void = { resp in
            completionHandler(resp == .alertFirstButtonReturn)
        }
        if let window {
            alert.beginSheetModal(for: window, completionHandler: done)
        } else {
            done(alert.runModal())
        }
    }

    private func openExternalSafely(_ url: URL) {
        #if ENABLE_MAC_TEST_HARNESS
        if testScriptPath != nil {
            lastExternalOpenedURL = url.absoluteString
            return
        }
        #endif
        NSWorkspace.shared.open(url)
    }

    // MARK: - Shutdown & Failure

    func applicationWillTerminate(_ notification: Notification) {
        logger.log("app.willTerminate")
        stopping = true
        deadlineWorkItem?.cancel()
        output.fileHandleForReading.readabilityHandler = nil
        terminateServerAndWait()
    }

    private func terminateServerAndWait() {
        guard server.isRunning else { return }
        server.terminate()
        let limit = Date().addingTimeInterval(3.0)
        while server.isRunning && Date() < limit {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        if server.isRunning {
            kill(server.processIdentifier, SIGKILL)
        }
    }

    private func fail(_ message: String) {
        logger.log("app.fail", detail: message)
        stopping = true
        deadlineWorkItem?.cancel()
        output.fileHandleForReading.readabilityHandler = nil
        terminateServerAndWait()
        if verifyInstall {
            FileHandle.standardError.write(Data((message + "\n").utf8))
            exit(1)
        }
        let alert = NSAlert()
        alert.messageText = "OpenMindmap"
        alert.informativeText = message
        alert.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        NSApp.terminate(nil)
    }

    #if ENABLE_MAC_TEST_HARNESS
    private func maybeStartTestHarness() {
        guard !testHarnessStarted, let path = testScriptPath else { return }
        testHarnessStarted = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.runTestHarness(at: path)
        }
    }

    private func runTestHarness(at path: String) {
        guard let webView,
              let code = try? String(contentsOfFile: path, encoding: .utf8) else {
            NSApp.terminate(nil)
            return
        }
        let prelude = """
        window.__ommTestCall = (cmd, args = {}) => new Promise((resolve) => {
          const reqId = 't-' + Date.now() + '-' + Math.random().toString(36).slice(2);
          window.__ommTestPending = window.__ommTestPending || {};
          window.__ommTestPending[reqId] = resolve;
          window.webkit.messageHandlers.ommTest.postMessage({ reqId, cmd, ...args });
        });
        """
        webView.evaluateJavaScript(prelude + "\n" + code + "\n; true;") { _, error in
            if let error {
                FileHandle.standardError.write(Data("HARNESS_ERR \(error.localizedDescription)\n".utf8))
            }
        }
    }

    private func handleTestHarnessMessage(_ body: Any) {
        guard let dict = body as? [String: Any],
              let reqId = dict["reqId"] as? String,
              let cmd = dict["cmd"] as? String else { return }

        switch cmd {
        case "inspectMenu":
            let topTitles = NSApp.mainMenu?.items.compactMap { $0.submenu?.title ?? $0.title } ?? []
            func walk(_ menu: NSMenu, depth: Int) -> [[String: Any]] {
                var list: [[String: Any]] = []
                for item in menu.items {
                    if item.isSeparatorItem || item.isHidden { continue }
                    let valid = menuController.validateMenuItem(item)
                    var entry: [String: Any] = [
                        "title": item.title,
                        "enabled": valid,
                        "state": item.state == .on ? "on" : "off",
                        "depth": depth,
                        "key": item.keyEquivalent,
                    ]
                    if let c = item as? CommandMenuItem { entry["commandId"] = c.commandId }
                    if let r = item as? RecentProjectMenuItem { entry["recentProjectId"] = r.projectId }
                    if let sub = item.submenu { entry["submenu"] = walk(sub, depth: depth + 1) }
                    list.append(entry)
                }
                return list
            }
            let tree = (NSApp.mainMenu?.items ?? []).compactMap { $0.submenu }.map { ["title": $0.title, "items": walk($0, depth: 1)] }
            replyTestHarness(reqId, ["topMenus": topTitles, "tree": tree])

        case "invokeMenu":
            let commandId = dict["commandId"] as? String ?? ""
            let recentIndex = dict["recentIndex"] as? Int
            func findAndInvoke(in menu: NSMenu) -> [String: Any]? {
                for (idx, item) in menu.items.enumerated() {
                    if let rc = recentIndex, item.title == "Gần đây", let sub = item.submenu {
                        if rc >= 0 && rc < sub.items.count {
                            let target = sub.items[rc]
                            let valid = menuController.validateMenuItem(target)
                            if valid { sub.performActionForItem(at: rc) }
                            return ["invoked": valid, "title": target.title]
                        }
                    }
                    if let c = item as? CommandMenuItem, c.commandId == commandId {
                        let valid = menuController.validateMenuItem(item)
                        if valid { menu.performActionForItem(at: idx) }
                        return ["invoked": valid, "title": item.title]
                    }
                    if let sub = item.submenu, let hit = findAndInvoke(in: sub) {
                        return hit
                    }
                }
                return nil
            }
            let res = NSApp.mainMenu.flatMap { findAndInvoke(in: $0) } ?? ["invoked": false, "reason": "not_found"]
            replyTestHarness(reqId, res)

        case "performWindowClose":
            if let win = window {
                win.performClose(nil)
                replyTestHarness(reqId, ["triggered": true])
            } else {
                replyTestHarness(reqId, ["triggered": false])
            }

        case "performAppTerminate":
            NSApp.terminate(nil)
            replyTestHarness(reqId, ["triggered": true])

        case "reopenDock":
            _ = applicationShouldHandleReopen(NSApp, hasVisibleWindows: window?.isVisible ?? false)
            replyTestHarness(reqId, ["reopened": true])

        case "setNextAlertChoice":
            nextTestAlertChoice = dict["choice"] as? Int
            replyTestHarness(reqId, ["ok": true])

        case "popLastAlert":
            let a = lastTestAlertShown
            lastTestAlertShown = nil
            replyTestHarness(reqId, ["alert": a ?? NSNull()])

        case "inspectWindow":
            replyTestHarness(reqId, [
                "title": window?.title ?? "",
                "isVisible": window?.isVisible ?? false,
                "isDocumentEdited": window?.isDocumentEdited ?? false,
                "mainURL": webView?.url?.absoluteString ?? "",
                "bundleId": Bundle.main.bundleIdentifier ?? "",
                "lastExternalURL": lastExternalOpenedURL ?? NSNull(),
                "helperExists": FileManager.default.isExecutableFile(atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node").path),
            ])

        case "clearDefaultDataStore":
            let types = WKWebsiteDataStore.allWebsiteDataTypes()
            WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self] in
                try? self?.transferStore.clearJournal()
                self?.replyTestHarness(reqId, ["cleared": true])
            }

        case "navigate":
            if let path = dict["path"] as? String,
               let url = URL(string: "http://\(localHost):\(localPort)\(path)") {
                transferActive = path.hasPrefix("/transfer")
                webView?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
                replyTestHarness(reqId, ["ok": true])
            } else {
                replyTestHarness(reqId, ["ok": false])
            }

        case "clickPoint":
            if let x = dict["x"] as? Double, let y = dict["y"] as? Double,
               let win = window, let wv = webView {
                let flippedY = wv.isFlipped ? y : (Double(wv.bounds.height) - y)
                let ptInWin = wv.convert(NSPoint(x: x, y: flippedY), to: nil)
                let now = ProcessInfo.processInfo.systemUptime
                if let down = NSEvent.mouseEvent(with: .leftMouseDown, location: ptInWin, modifierFlags: [], timestamp: now, windowNumber: win.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1),
                   let up = NSEvent.mouseEvent(with: .leftMouseUp, location: ptInWin, modifierFlags: [], timestamp: now + 0.01, windowNumber: win.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 0) {
                    NSApp.activate(ignoringOtherApps: true)
                    win.makeKeyAndOrderFront(nil)
                    NSApp.sendEvent(down)
                    NSApp.sendEvent(up)
                    replyTestHarness(reqId, ["ok": true])
                } else {
                    replyTestHarness(reqId, ["ok": false])
                }
            } else {
                replyTestHarness(reqId, ["ok": false])
            }

        case "done":
            var payload = dict
            payload.removeValue(forKey: "reqId")
            payload.removeValue(forKey: "cmd")
            if let data = try? JSONSerialization.data(withJSONObject: payload),
               let json = String(data: data, encoding: .utf8) {
                FileHandle.standardOutput.write(Data("MAC_HARNESS_RESULT \(json)\n".utf8))
            }
            stopping = true
            terminateServerAndWait()
            exit(0)

        default:
            replyTestHarness(reqId, ["error": "unknown_cmd"])
        }
    }

    private func replyTestHarness(_ reqId: String, _ payload: [String: Any]) {
        let obj: [String: Any] = ["reqId": reqId, "result": payload]
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak webView] in
            webView?.evaluateJavaScript("window.__ommTestPending && window.__ommTestPending[\"\(reqId)\"] && (window.__ommTestPending[\"\(reqId)\"]((\(json)).result), delete window.__ommTestPending[\"\(reqId)\"]);") { _, _ in }
        }
    }
    #endif
}

@main
enum OpenMindmapMain {
    static func main() {
        let app = NSApplication.shared
        let launcher = OpenMindmapLauncher()
        app.setActivationPolicy(CommandLine.arguments.contains("--verify-install") ? .prohibited : .regular)
        app.delegate = launcher
        app.run()
    }
}
