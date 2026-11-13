import { useApp, type AppState, type SaveStatus } from '../store'
import { getTopic, descendantsOf } from './tree'
import { uuid } from './types'
import { BranchClipboard, copyBranch, pasteBranch } from './clipboard'
import { cmdBuilders } from './commands'
import { trashList } from '../storage/projects'
import { download } from '../io/exporters'

export type MenuCommandId =
  | 'A01' | 'A02' | 'A03' | 'A04' | 'A05' | 'A06' | 'A07' | 'A08' | 'A09'
  | 'A10' | 'A11' | 'A12' | 'A13' | 'A14' | 'A15' | 'A16'
  | 'A17' | 'A18' | 'A19' | 'A20'
  | 'A21' | 'A22' | 'A23' | 'A24' | 'A25' | 'A26' | 'A27' | 'A28'
  | 'A29' | 'A30' | 'A31' | 'A32' | 'A33'
  | 'A34' | 'A35' | 'A36' | 'A37' | 'A38' | 'A39'
  | 'A40' | 'A41' | 'A42' | 'A43'
  | 'EDIT_CUT' | 'EDIT_PASTE' | 'VIEW_ZOOM_IN' | 'VIEW_ZOOM_OUT' | 'A05_OPEN_RECENT'

export interface CatalogItem {
  id: MenuCommandId
  group: 'Dự án' | 'Nhập và xuất' | 'Chỉnh sửa' | 'Thêm chủ đề' | 'Ứng dụng' | 'Hiển thị' | 'Thuộc tính node' | 'Sắp xếp nhánh' | 'Trợ giúp' | 'Khác'
  column?: 'left' | 'right'
  label: string
  hint?: string
  disabled?: boolean
  active?: boolean
  recentToggle?: boolean
  run: (targetId?: string) => void
}

export interface MenuCommandSnapshotItem {
  label: string
  enabled: boolean
  checked?: boolean
}

export interface MenuStateSnapshot {
  version: 1
  generation: number
  viewSession: string
  hasDoc: boolean
  projectId: string | null
  projectName: string | null
  saveStatus: SaveStatus
  dirty: boolean
  conflict: boolean
  transitionBusy: boolean
  leavePromptOpen: boolean
  modalOpen: boolean
  focusedField: boolean
  editingNode: boolean
  trashCount: number
  recentProjects: Array<{ id: string; name: string; updatedAt: string; active: boolean }>
  commands: Record<string, MenuCommandSnapshotItem>
}

export interface MenuUiActions {
  openGuide: () => void
  openAbout: () => void
  openTrash: () => void
}

let uiActions: MenuUiActions | null = null

export function registerMenuUiActions(actions: MenuUiActions): () => void {
  uiActions = actions
  return () => {
    if (uiActions === actions) uiActions = null
  }
}

export function getBranchClipboard(): BranchClipboard | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { __ommClipboard?: BranchClipboard }).__ommClipboard
}

export function copySelection(cut = false) {
  const st = useApp.getState()
  if (!st.doc || !st.selection[0] || st.selection[0].startsWith('drawing:') || st.selection[0].startsWith('crosslink:')) return
  const source = st.doc
  const roots = [...new Set(st.selection)].filter(
    (id) => getTopic(source, id) && !st.selection.some((parent) => parent !== id && descendantsOf(source, parent).some((t) => t.id === id))
  )
  if (!cut && roots.length !== 1) {
    st.toast('warn', 'Hãy chọn một nhánh để sao chép')
    return
  }
  if (cut && (roots.length !== 1 || roots[0] === source.central_topic_id || !getTopic(source, roots[0]))) {
    st.toast('warn', 'Hãy chọn một nhánh để cắt')
    return
  }
  const clip = copyBranch(source, roots[0])
  if (!clip) return
  if (cut && clip.topics.some((t) => t.image && !clip.assets.some((a) => a.id === t.image?.asset_id))) {
    st.toast('error', 'Không thể cắt nhánh', 'Nhánh thiếu dữ liệu ảnh.')
    return
  }
  const commit = () => {
    const current = useApp.getState()
    if (cut) {
      if (current.generation !== st.generation || current.doc !== source) {
        current.toast('warn', 'Dự án đã thay đổi. Hãy chọn lại nhánh.')
        return false
      }
      if (!current.dispatch({ type: 'deleteTopics', ids: roots }, 'Cắt nhánh')) return false
      current.setSelection([])
    }
    ;(window as unknown as { __ommClipboard?: BranchClipboard }).__ommClipboard = clip
    current.toast('info', cut ? 'Đã cắt nhánh' : 'Đã sao chép nhánh', `${clip.topics.length} node`)
    return true
  }
  const ids = new Set(clip.topics.map((t) => t.id))
  const external = source.crosslinks.filter((c) => ids.has(c.source) !== ids.has(c.target)).length
  if (cut && (external || ids.size > 20)) {
    st.setConfirm({
      message: `Cắt nhánh ${ids.size} node?`,
      detail: external ? `${external} đường nối ra ngoài nhánh sẽ bị gỡ.` : 'Thao tác có thể hoàn tác bằng Ctrl+Z.',
      danger: true,
      onOk: commit,
    })
  } else commit()
}

export function pasteFromClipboard() {
  const st = useApp.getState()
  if (!st.doc) return
  const clip = getBranchClipboard()
  if (!clip) {
    st.toast('warn', 'Clipboard trống')
    return
  }
  const parent = st.selection.find((id) => !!getTopic(st.doc!, id)) ?? st.doc.central_topic_id
  try {
    st.dispatch(pasteBranch(st.doc, clip, parent), 'Dán nhánh')
  } catch (e) {
    st.toast('error', 'Dán thất bại', String(e))
  }
}

export function isFocusedTextField(): boolean {
  if (typeof document === 'undefined') return false
  const ae = document.activeElement as HTMLElement | null
  return !!(ae && ae.closest && ae.closest('input, textarea, select, [contenteditable="true"]'))
}

export function hasBlockingDialogOpen(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

export function buildCatalogItems(st: AppState = useApp.getState()): CatalogItem[] {
  const doc = st.doc
  const sel0 = st.selection[0]
  const topicSel = doc && sel0 && !sel0.startsWith('drawing:') && !sel0.startsWith('crosslink:') ? getTopic(doc, sel0) : undefined
  const selectedRoots = doc
    ? [...new Set(st.selection)].filter(
        (id) => getTopic(doc, id) && !st.selection.some((p) => p !== id && descendantsOf(doc, p).some((t) => t.id === id))
      )
    : []
  const singleSelTopic = st.selection.length === 1 ? topicSel : undefined
  const isCentralSelected = !!topicSel && (topicSel.id === doc?.central_topic_id || topicSel.role === 'central')
  const cur = () => useApp.getState()
  const trashCount = typeof localStorage !== 'undefined' ? trashList().length : 0

  return [
    // Left column — Dự án
    { id: 'A01', group: 'Dự án', column: 'left', label: 'Dự án mới', hint: 'Ctrl+N', run: () => void cur().createProject() },
    { id: 'A02', group: 'Dự án', column: 'left', label: 'Mở…', hint: 'Ctrl+O', run: () => cur().setSidebar('open') },
    { id: 'A03', group: 'Dự án', column: 'left', label: 'Lưu', hint: 'Ctrl+S', disabled: !doc, run: () => void cur().saveNow() },
    { id: 'A04', group: 'Dự án', column: 'left', label: 'Lưu thành (bản sao độc lập)', hint: 'Ctrl+Shift+S', disabled: !doc, run: () => void cur().resolveConflictSaveAs() },
    { id: 'A05', group: 'Dự án', column: 'left', label: 'Gần đây', recentToggle: true, run: () => {} },
    { id: 'A06', group: 'Dự án', column: 'left', label: `Thùng rác (${trashCount})`, run: () => uiActions?.openTrash() },
    { id: 'A07', group: 'Dự án', column: 'left', label: 'Đóng dự án', disabled: !doc, run: () => void cur().closeProject() },

    // Nhập và xuất
    { id: 'A08', group: 'Nhập và xuất', column: 'left', label: 'Nhập…', hint: 'Ctrl+I', run: () => cur().setImportOpen(true) },
    { id: 'A09', group: 'Nhập và xuất', column: 'left', label: 'Xuất…', hint: 'Ctrl+E', disabled: !doc, run: () => cur().openExport() },

    // Chỉnh sửa
    { id: 'A10', group: 'Chỉnh sửa', column: 'left', label: 'Hoàn tác', hint: 'Ctrl+Z', disabled: !st.past.length, run: () => cur().undo() },
    { id: 'A11', group: 'Chỉnh sửa', column: 'left', label: 'Làm lại', hint: 'Ctrl+Y', disabled: !st.future.length, run: () => cur().redo() },
    { id: 'A12', group: 'Chỉnh sửa', column: 'left', label: 'Sao chép nhánh', hint: 'Ctrl+C', disabled: selectedRoots.length !== 1, run: () => copySelection(false) },
    { id: 'A13', group: 'Chỉnh sửa', column: 'left', label: 'Nhân bản nhánh', hint: 'Ctrl+D', disabled: !topicSel || isCentralSelected, run: () => cur().duplicateSelection() },
    { id: 'A14', group: 'Chỉnh sửa', column: 'left', label: 'Chọn tất cả', hint: 'Ctrl+A', disabled: !doc, run: () => { const s = cur(); if (s.doc) s.setSelection(s.doc.topics.map((t) => t.id)) } },
    { id: 'A15', group: 'Chỉnh sửa', column: 'left', label: 'Chọn cả nhánh', disabled: !topicSel, run: () => { const s = cur(); const root = s.selection[0]; if (s.doc && root && getTopic(s.doc, root)) s.setSelection([root, ...descendantsOf(s.doc, root).map((d) => d.id)]) } },
    { id: 'A16', group: 'Chỉnh sửa', column: 'left', label: 'Tìm / Thay thế…', hint: 'Ctrl+F', run: () => cur().openSearch(true) },

    // Thêm chủ đề
    { id: 'A17', group: 'Thêm chủ đề', column: 'left', label: 'Chủ đề con', hint: 'Tab', disabled: !doc, run: () => cur().addChildToSelection() },
    { id: 'A18', group: 'Thêm chủ đề', column: 'left', label: isCentralSelected ? 'Thêm nhánh chính' : 'Chủ đề ngang hàng', hint: 'Enter', disabled: !topicSel, run: () => cur().addSiblingToSelection(false) },
    {
      id: 'A19',
      group: 'Thêm chủ đề',
      column: 'left',
      label: 'Chèn cha',
      disabled: !singleSelTopic || !singleSelTopic.parent_id || singleSelTopic.id === doc?.central_topic_id,
      run: () => {
        const s = cur()
        const id = s.selection.length === 1 ? s.selection[0] : undefined
        const c = s.doc && id ? cmdBuilders.insertParent(s.doc, id) : null
        if (c) s.dispatch(c, 'Chèn cha')
      },
    },
    {
      id: 'A20',
      group: 'Thêm chủ đề',
      column: 'left',
      label: 'Chủ đề nổi (Floating)',
      disabled: !doc,
      run: () => {
        const s = cur()
        if (!s.doc) return
        s.dispatch(
          {
            type: 'addTopic',
            topic: {
              id: uuid(),
              role: 'floating',
              parent_id: null,
              order: 9999,
              text: 'Chủ đề nổi',
              collapsed: false,
              branch_side: 'auto',
              branch_color_seed: null,
              style: {},
              branch_style_override: null,
              image: null,
              icon: null,
              checkbox: null,
              url: null,
              date: null,
              numbering: null,
              manual_position: null,
              notes: null,
            },
            parentId: null,
            index: null,
            focusEditor: false,
          },
          'Thêm chủ đề nổi'
        )
      },
    },

    // Right column — Ứng dụng
    { id: 'A21', group: 'Ứng dụng', column: 'right', label: 'Cài đặt', hint: 'Ctrl+,', run: () => cur().setSettingsOpen(true) },

    // Hiển thị
    { id: 'A22', group: 'Hiển thị', column: 'right', label: 'Sidebar (thu gọn/ẩn)', active: st.sidebar !== 'hidden', run: () => { const s = cur(); s.setSidebar(s.sidebar === 'open' ? 'collapsed' : s.sidebar === 'collapsed' ? 'hidden' : 'open') } },
    { id: 'A23', group: 'Hiển thị', column: 'right', label: 'Inspector', active: st.inspectorOpen, run: () => { const s = cur(); s.setInspector(!s.inspectorOpen) } },
    { id: 'A24', group: 'Hiển thị', column: 'right', label: 'Lưới', active: st.gridOn, run: () => { const s = cur(); s.setGrid(!s.gridOn) } },
    { id: 'A25', group: 'Hiển thị', column: 'right', label: 'Snap', active: st.snapOn, run: () => { const s = cur(); s.setSnap(!s.snapOn) } },
    { id: 'A26', group: 'Hiển thị', column: 'right', label: 'Mini map', active: st.minimapOn, run: () => { const s = cur(); s.setMinimap(!s.minimapOn) } },
    { id: 'A27', group: 'Hiển thị', column: 'right', label: 'Vừa khít toàn sơ đồ', hint: 'Ctrl+0', disabled: !doc, run: () => document.dispatchEvent(new CustomEvent('omm-canvas', { detail: { action: 'fit' } })) },
    {
      id: 'A28',
      group: 'Hiển thị',
      column: 'right',
      label: 'Tập trung vào nhánh đã chọn',
      disabled: !topicSel,
      run: () => {
        const s = cur()
        const id = s.selection[0]
        if (!s.doc || !id || !getTopic(s.doc, id)) return
        s.focusBranch(id)
        document.dispatchEvent(new CustomEvent('omm-canvas', { detail: { action: 'center', id } }))
      },
    },

    // Thuộc tính node
    {
      id: 'A29',
      group: 'Thuộc tính node',
      column: 'right',
      label: 'Ghi chú…',
      disabled: !topicSel,
      run: () => {
        const s = cur()
        const id = s.selection[0]
        if (!id) return
        s.setInspector(true, 'content')
        s.startEdit(id, 'notes')
      },
    },
    {
      id: 'A30',
      group: 'Thuộc tính node',
      column: 'right',
      label: 'Checkbox',
      disabled: !topicSel,
      active: topicSel?.checkbox === true,
      run: () => {
        const s = cur()
        const t = s.doc && s.selection[0] ? getTopic(s.doc, s.selection[0]) : undefined
        if (!t) return
        s.dispatch({ type: 'setProps', id: t.id, before: { checkbox: t.checkbox }, after: { checkbox: !(t.checkbox === true) } }, 'Checkbox')
      },
    },
    { id: 'A31', group: 'Thuộc tính node', column: 'right', label: 'Ngày…', disabled: !topicSel, run: () => cur().setInspector(true, 'content') },
    { id: 'A32', group: 'Thuộc tính node', column: 'right', label: 'Liên kết URL…', disabled: !topicSel, run: () => cur().setInspector(true, 'content') },
    { id: 'A33', group: 'Thuộc tính node', column: 'right', label: 'Ảnh và biểu tượng…', disabled: !topicSel, run: () => cur().setInspector(true, 'attach') },

    // Sắp xếp nhánh
    {
      id: 'A34',
      group: 'Sắp xếp nhánh',
      column: 'right',
      label: 'Lên thứ tự',
      disabled: !singleSelTopic || !doc || !cmdBuilders.reorderUpDown(doc, singleSelTopic.id, -1),
      run: () => {
        const s = cur()
        const id = s.selection.length === 1 ? s.selection[0] : undefined
        const c = s.doc && id ? cmdBuilders.reorderUpDown(s.doc, id, -1) : null
        if (c) s.dispatch(c, 'Lên thứ tự')
      },
    },
    {
      id: 'A35',
      group: 'Sắp xếp nhánh',
      column: 'right',
      label: 'Xuống thứ tự',
      disabled: !singleSelTopic || !doc || !cmdBuilders.reorderUpDown(doc, singleSelTopic.id, 1),
      run: () => {
        const s = cur()
        const id = s.selection.length === 1 ? s.selection[0] : undefined
        const c = s.doc && id ? cmdBuilders.reorderUpDown(s.doc, id, 1) : null
        if (c) s.dispatch(c, 'Xuống thứ tự')
      },
    },
    {
      id: 'A36',
      group: 'Sắp xếp nhánh',
      column: 'right',
      label: 'Lên cấp (Promote)',
      disabled: !topicSel || !doc || !cmdBuilders.promote(doc, topicSel.id),
      run: () => {
        const s = cur()
        const id = s.selection[0]
        const c = s.doc && id ? cmdBuilders.promote(s.doc, id) : null
        if (c) s.dispatch(c, 'Lên cấp')
      },
    },
    {
      id: 'A37',
      group: 'Sắp xếp nhánh',
      column: 'right',
      label: 'Xuống cấp (Demote)',
      disabled: !topicSel || !doc || !cmdBuilders.demote(doc, topicSel.id),
      run: () => {
        const s = cur()
        const id = s.selection[0]
        const c = s.doc && id ? cmdBuilders.demote(s.doc, id) : null
        if (c) s.dispatch(c, 'Xuống cấp')
      },
    },
    {
      id: 'A38',
      group: 'Sắp xếp nhánh',
      column: 'right',
      label: 'Tách thành Floating',
      disabled: !topicSel || !topicSel.parent_id,
      run: () => {
        const s = cur()
        const id = s.selection[0]
        const c = s.doc && id ? cmdBuilders.detachToFloating(s.doc, id) : null
        if (c) s.dispatch(c, 'Tách floating')
      },
    },
    {
      id: 'A39',
      group: 'Sắp xếp nhánh',
      column: 'right',
      label: 'Thu gọn / Mở rộng',
      disabled: !topicSel,
      active: !!topicSel?.collapsed,
      run: () => {
        const s = cur()
        const t = s.doc && s.selection[0] ? getTopic(s.doc, s.selection[0]) : undefined
        if (!t) return
        s.dispatch({ type: 'collapse', items: [{ id: t.id, value: !t.collapsed }] }, 'Thu gọn')
      },
    },

    // Trợ giúp
    { id: 'A40', group: 'Trợ giúp', column: 'right', label: 'Hướng dẫn sử dụng', run: () => uiActions?.openGuide() },
    { id: 'A41', group: 'Trợ giúp', column: 'right', label: 'Phím tắt', run: () => cur().setShortcutsOpen(true) },
    { id: 'A42', group: 'Trợ giúp', column: 'right', label: 'Giới thiệu', run: () => uiActions?.openAbout() },
    {
      id: 'A43',
      group: 'Trợ giúp',
      column: 'right',
      label: 'Báo lỗi (xuất log đã loại dữ liệu)',
      run: () => {
        const s = cur()
        const log = {
          app: 'OpenMindmap',
          version: '3.5.0',
          time: new Date().toISOString(),
          saveStatus: s.saveStatus,
          projects: s.registry.length,
          hasDoc: !!s.doc,
          ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        }
        const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' })
        download(blob, 'openmindmap-log.json')
        s.toast('info', 'Đã xuất log chẩn đoán', 'Log không chứa nội dung dự án.')
      },
    },

    // Native macOS extra Edit / View / Recent commands (outside web 2-col popup)
    {
      id: 'EDIT_CUT',
      group: 'Khác',
      label: 'Cắt nhánh',
      disabled: selectedRoots.length !== 1 || !topicSel || isCentralSelected,
      run: () => copySelection(true),
    },
    {
      id: 'EDIT_PASTE',
      group: 'Khác',
      label: 'Dán nhánh',
      disabled: !doc || !getBranchClipboard(),
      run: () => pasteFromClipboard(),
    },
    {
      id: 'VIEW_ZOOM_IN',
      group: 'Khác',
      label: 'Phóng to',
      disabled: !doc,
      run: () => document.dispatchEvent(new CustomEvent('omm-canvas', { detail: { action: 'zoom', dir: 1 } })),
    },
    {
      id: 'VIEW_ZOOM_OUT',
      group: 'Khác',
      label: 'Thu nhỏ',
      disabled: !doc,
      run: () => document.dispatchEvent(new CustomEvent('omm-canvas', { detail: { action: 'zoom', dir: -1 } })),
    },
    {
      id: 'A05_OPEN_RECENT',
      group: 'Khác',
      label: 'Mở dự án gần đây',
      disabled: !st.registry.length,
      run: (targetId?: string) => {
        if (targetId) void cur().openProject(targetId)
      },
    },
  ]
}

export function buildMenuStateSnapshot(viewSession: string, st: AppState = useApp.getState()): MenuStateSnapshot {
  const items = buildCatalogItems(st)
  const commands: Record<string, MenuCommandSnapshotItem> = {}
  for (const item of items) {
    commands[item.id] = {
      label: item.label,
      enabled: !item.disabled,
      ...(item.active !== undefined ? { checked: item.active } : {}),
    }
  }
  const dirty = !!st.doc && (st.saveStatus !== 'clean' || (!!st.editor && st.editor.draft !== st.editor.baseText))
  const trashCount = typeof localStorage !== 'undefined' ? trashList().length : 0

  return {
    version: 1,
    generation: st.generation,
    viewSession,
    hasDoc: !!st.doc,
    projectId: st.doc?.project_id ?? null,
    projectName: st.doc?.name ?? null,
    saveStatus: st.saveStatus,
    dirty,
    conflict: st.saveStatus === 'conflict',
    transitionBusy: st.transitionBusy,
    leavePromptOpen: !!st.leavePrompt,
    modalOpen: hasBlockingDialogOpen(),
    focusedField: isFocusedTextField(),
    editingNode: !!st.editor,
    trashCount,
    recentProjects: st.registry.slice(0, 8).map((m) => ({
      id: m.id,
      name: m.name,
      updatedAt: m.updatedAt,
      active: st.doc?.project_id === m.id,
    })),
    commands,
  }
}
