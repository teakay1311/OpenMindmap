import AppKit
import Foundation

struct MenuCommandState: Codable {
    let label: String
    let enabled: Bool
    let checked: Bool?
}

struct RecentProjectItem: Codable {
    let id: String
    let name: String
    let updatedAt: String
    let active: Bool
}

struct MenuSnapshot: Codable {
    let version: Int
    let generation: Int
    let viewSession: String
    let hasDoc: Bool
    let projectId: String?
    let projectName: String?
    let saveStatus: String
    let dirty: Bool
    let conflict: Bool
    let transitionBusy: Bool
    let leavePromptOpen: Bool
    let modalOpen: Bool
    let focusedField: Bool
    let editingNode: Bool
    let trashCount: Int
    let recentProjects: [RecentProjectItem]
    let commands: [String: MenuCommandState]
}

final class CommandMenuItem: NSMenuItem {
    let commandId: String
    var targetId: String?
    var supportsTextResponder: Bool = false

    init(
        commandId: String,
        title: String,
        action: Selector?,
        keyEquivalent: String = "",
        modifiers: NSEvent.ModifierFlags = [.command],
        supportsTextResponder: Bool = false
    ) {
        self.commandId = commandId
        self.supportsTextResponder = supportsTextResponder
        super.init(title: title, action: action, keyEquivalent: keyEquivalent)
        self.keyEquivalentModifierMask = keyEquivalent.isEmpty ? [] : modifiers
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

final class RecentProjectMenuItem: NSMenuItem {
    let projectId: String

    init(projectId: String, title: String, active: Bool, target: AnyObject, action: Selector) {
        self.projectId = projectId
        super.init(title: title, action: action, keyEquivalent: "")
        self.target = target
        self.state = active ? .on : .off
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

final class MenuController: NSObject, NSMenuItemValidation {
    private weak var handler: MenuActionHandling?
    private(set) var snapshot: MenuSnapshot?
    private var commandItems: [String: CommandMenuItem] = [:]
    private var recentSubmenu: NSMenu?

    init(handler: MenuActionHandling) {
        self.handler = handler
        super.init()
    }

    func installMainMenu() {
        commandItems.removeAll()
        let bar = NSMenu()

        // 1. OpenMindmap (Application menu)
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "OpenMindmap")
        appMenu.addItem(makeCmd("A42", "Giới thiệu về OpenMindmap"))
        appMenu.addItem(.separator())
        appMenu.addItem(makeCmd("A21", "Cài đặt…", key: ","))
        appMenu.addItem(.separator())
        let hideItem = NSMenuItem(title: "Ẩn OpenMindmap", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(hideItem)
        let hideOthers = NSMenuItem(title: "Ẩn các ứng dụng khác", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(NSMenuItem(title: "Hiện tất cả", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Thoát OpenMindmap", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu
        bar.addItem(appItem)

        // 2. Tệp
        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "Tệp")
        fileMenu.addItem(makeCmd("A01", "Dự án mới", key: "n"))
        fileMenu.addItem(makeCmd("A02", "Mở…", key: "o"))

        let recentMenu = NSMenu(title: "Gần đây")
        self.recentSubmenu = recentMenu
        let recentHolder = makeCmd("A05", "Gần đây")
        recentHolder.action = nil
        recentHolder.target = nil
        recentHolder.submenu = recentMenu
        fileMenu.addItem(recentHolder)
        rebuildRecentSubmenu([])

        fileMenu.addItem(.separator())
        fileMenu.addItem(makeCmd("A03", "Lưu", key: "s"))
        fileMenu.addItem(makeCmd("A04", "Lưu thành (bản sao độc lập)…", key: "s", modifiers: [.command, .shift]))
        fileMenu.addItem(makeCmd("A07", "Đóng dự án"))
        let closeWindow = NSMenuItem(title: "Đóng cửa sổ", action: #selector(MenuActionHandling.handleWindowCloseMenu(_:)), keyEquivalent: "w")
        closeWindow.target = handler
        fileMenu.addItem(closeWindow)
        fileMenu.addItem(.separator())
        fileMenu.addItem(makeCmd("A08", "Nhập…", key: "i"))
        fileMenu.addItem(makeCmd("A09", "Xuất…", key: "e"))
        fileMenu.addItem(.separator())
        fileMenu.addItem(makeCmd("A06", "Thùng rác (0)…"))
        fileItem.submenu = fileMenu
        bar.addItem(fileItem)

        // 3. Chỉnh sửa
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Chỉnh sửa")
        editMenu.addItem(makeCmd("A10", "Hoàn tác", key: "z", supportsTextResponder: true))
        editMenu.addItem(makeCmd("A11", "Làm lại", key: "z", modifiers: [.command, .shift], supportsTextResponder: true))
        let redoY = makeCmd("A11", "Làm lại (⌘Y)", key: "y", supportsTextResponder: true)
        redoY.isHidden = true
        redoY.allowsKeyEquivalentWhenHidden = true
        editMenu.addItem(redoY)
        editMenu.addItem(.separator())
        editMenu.addItem(makeCmd("EDIT_CUT", "Cắt", key: "x", supportsTextResponder: true))
        editMenu.addItem(makeCmd("A12", "Sao chép nhánh", key: "c", supportsTextResponder: true))
        editMenu.addItem(makeCmd("EDIT_PASTE", "Dán nhánh", key: "v", supportsTextResponder: true))
        editMenu.addItem(makeCmd("A13", "Nhân bản nhánh", key: "d"))
        editMenu.addItem(.separator())
        editMenu.addItem(makeCmd("A14", "Chọn tất cả", key: "a", supportsTextResponder: true))
        editMenu.addItem(makeCmd("A15", "Chọn cả nhánh"))
        editMenu.addItem(.separator())
        editMenu.addItem(makeCmd("A16", "Tìm / Thay thế…", key: "f"))
        editItem.submenu = editMenu
        bar.addItem(editItem)

        // 4. Chủ đề
        let topicItem = NSMenuItem()
        let topicMenu = NSMenu(title: "Chủ đề")

        let addTopicHolder = NSMenuItem(title: "Thêm chủ đề", action: nil, keyEquivalent: "")
        let addTopicSub = NSMenu(title: "Thêm chủ đề")
        addTopicSub.addItem(makeCmd("A17", "Chủ đề con"))
        addTopicSub.addItem(makeCmd("A18", "Chủ đề ngang hàng"))
        addTopicSub.addItem(makeCmd("A19", "Chèn cha"))
        addTopicSub.addItem(makeCmd("A20", "Chủ đề nổi (Floating)"))
        addTopicHolder.submenu = addTopicSub
        topicMenu.addItem(addTopicHolder)

        let propsHolder = NSMenuItem(title: "Thuộc tính node", action: nil, keyEquivalent: "")
        let propsSub = NSMenu(title: "Thuộc tính node")
        propsSub.addItem(makeCmd("A29", "Ghi chú…"))
        propsSub.addItem(makeCmd("A30", "Checkbox"))
        propsSub.addItem(makeCmd("A31", "Ngày…"))
        propsSub.addItem(makeCmd("A32", "Liên kết URL…"))
        propsSub.addItem(makeCmd("A33", "Ảnh và biểu tượng…"))
        propsHolder.submenu = propsSub
        topicMenu.addItem(propsHolder)

        let arrangeHolder = NSMenuItem(title: "Sắp xếp nhánh", action: nil, keyEquivalent: "")
        let arrangeSub = NSMenu(title: "Sắp xếp nhánh")
        arrangeSub.addItem(makeCmd("A34", "Lên thứ tự"))
        arrangeSub.addItem(makeCmd("A35", "Xuống thứ tự"))
        arrangeSub.addItem(makeCmd("A36", "Lên cấp (Promote)"))
        arrangeSub.addItem(makeCmd("A37", "Xuống cấp (Demote)"))
        arrangeSub.addItem(makeCmd("A38", "Tách thành Floating"))
        arrangeSub.addItem(.separator())
        arrangeSub.addItem(makeCmd("A39", "Thu gọn / Mở rộng"))
        arrangeHolder.submenu = arrangeSub
        topicMenu.addItem(arrangeHolder)

        topicItem.submenu = topicMenu
        bar.addItem(topicItem)

        // 5. Xem
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "Xem")
        viewMenu.addItem(makeCmd("A22", "Sidebar (thu gọn/ẩn)"))
        viewMenu.addItem(makeCmd("A23", "Inspector"))
        viewMenu.addItem(.separator())
        viewMenu.addItem(makeCmd("A24", "Lưới"))
        viewMenu.addItem(makeCmd("A25", "Snap"))
        viewMenu.addItem(makeCmd("A26", "Mini map"))
        viewMenu.addItem(.separator())
        viewMenu.addItem(makeCmd("A27", "Vừa khít toàn sơ đồ", key: "0"))
        viewMenu.addItem(makeCmd("VIEW_ZOOM_IN", "Phóng to", key: "="))
        viewMenu.addItem(makeCmd("VIEW_ZOOM_OUT", "Thu nhỏ", key: "-"))
        viewMenu.addItem(makeCmd("A28", "Tập trung vào nhánh đã chọn"))
        viewItem.submenu = viewMenu
        bar.addItem(viewItem)

        // 6. Cửa sổ
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Cửa sổ")
        windowMenu.addItem(NSMenuItem(title: "Thu nhỏ", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Thu phóng", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        windowMenu.addItem(.separator())
        let showMain = NSMenuItem(title: "OpenMindmap", action: #selector(MenuActionHandling.handleShowMainWindowMenu(_:)), keyEquivalent: "")
        showMain.target = handler
        windowMenu.addItem(showMain)
        windowMenu.addItem(.separator())
        windowMenu.addItem(NSMenuItem(title: "Đưa tất cả ra trước", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: ""))
        windowItem.submenu = windowMenu
        bar.addItem(windowItem)

        // 7. Trợ giúp
        let helpItem = NSMenuItem()
        let helpMenu = NSMenu(title: "Trợ giúp")
        helpMenu.addItem(makeCmd("A40", "Hướng dẫn sử dụng"))
        helpMenu.addItem(makeCmd("A41", "Phím tắt"))
        helpMenu.addItem(.separator())
        helpMenu.addItem(makeCmd("A43", "Báo lỗi (xuất log đã loại dữ liệu)"))
        helpItem.submenu = helpMenu
        bar.addItem(helpItem)

        NSApp.mainMenu = bar
        NSApp.windowsMenu = windowMenu
        NSApp.helpMenu = helpMenu
    }

    private func makeCmd(
        _ id: String,
        _ title: String,
        key: String = "",
        modifiers: NSEvent.ModifierFlags = [.command],
        supportsTextResponder: Bool = false
    ) -> CommandMenuItem {
        let item = CommandMenuItem(
            commandId: id,
            title: title,
            action: #selector(MenuActionHandling.handleCommandMenuItem(_:)),
            keyEquivalent: key,
            modifiers: modifiers,
            supportsTextResponder: supportsTextResponder
        )
        item.target = handler
        if !commandItems.keys.contains(id) {
            commandItems[id] = item
        }
        return item
    }

    func applySnapshot(_ snap: MenuSnapshot) {
        snapshot = snap
        for (id, cmd) in snap.commands {
            if let item = commandItems[id] {
                item.title = cmd.label
                if let checked = cmd.checked {
                    item.state = checked ? .on : .off
                } else {
                    item.state = .off
                }
            }
        }
        rebuildRecentSubmenu(snap.recentProjects)
    }

    private func rebuildRecentSubmenu(_ recent: [RecentProjectItem]) {
        guard let recentSubmenu else { return }
        recentSubmenu.removeAllItems()
        let clipped = Array(recent.prefix(8))
        if clipped.isEmpty {
            let empty = NSMenuItem(title: "Chưa có dự án nào", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            recentSubmenu.addItem(empty)
            return
        }
        for item in clipped {
            let menuItem = RecentProjectMenuItem(
                projectId: item.id,
                title: item.name,
                active: item.active,
                target: handler as AnyObject,
                action: #selector(MenuActionHandling.handleRecentProjectMenuItem(_:))
            )
            recentSubmenu.addItem(menuItem)
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let handler else { return false }
        if handler.isTransferOnlyMode {
            if let cmd = menuItem as? CommandMenuItem {
                return ["A40", "A41", "A42", "A43", "EDIT_CUT", "A12", "EDIT_PASTE", "A14", "A10", "A11"].contains(cmd.commandId)
                    && cmd.supportsTextResponder
            }
            if menuItem is RecentProjectMenuItem { return false }
            return true
        }

        if let recent = menuItem as? RecentProjectMenuItem {
            guard let snap = snapshot else { return false }
            return !snap.transitionBusy && !snap.leavePromptOpen && !snap.modalOpen && !recent.projectId.isEmpty
        }

        guard let cmd = menuItem as? CommandMenuItem else {
            return true
        }

        // If native AppKit NSText / NSTextView (not WKWebView) is first responder, enable standard text edits.
        if cmd.supportsTextResponder && handler.isNativeAppKitTextResponder() {
            return true
        }

        guard let snap = snapshot else {
            return cmd.commandId == "A40" || cmd.commandId == "A41" || cmd.commandId == "A42" || cmd.commandId == "A43"
        }

        // Inside an HTML text field / inline editor, allow text edit menu shortcuts (Cmd+C/X/V/A/Z/Shift+Z).
        if cmd.supportsTextResponder && snap.focusedField {
            return true
        }

        if snap.transitionBusy || snap.leavePromptOpen {
            return false
        }
        if snap.modalOpen {
            return false
        }
        return snap.commands[cmd.commandId]?.enabled ?? false
    }

    func menuItem(forCommand id: String) -> CommandMenuItem? {
        commandItems[id]
    }
}

@objc protocol MenuActionHandling: AnyObject {
    var isTransferOnlyMode: Bool { get }
    func isNativeAppKitTextResponder() -> Bool
    @objc func handleCommandMenuItem(_ sender: NSMenuItem)
    @objc func handleRecentProjectMenuItem(_ sender: NSMenuItem)
    @objc func handleWindowCloseMenu(_ sender: Any?)
    @objc func handleShowMainWindowMenu(_ sender: Any?)
}
