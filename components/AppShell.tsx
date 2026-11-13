/* ============================================================
 * OpenMindmap — components/AppShell.tsx
 * Shell cố định (LOCK-02): Header 2 hàng tổng 84–92 logical px,
 * không hàng thứ 3. Sidebar 240/48/0 (LOCK-03). Menu app popup
 * (02.5). Trạng thái lưu phía phải hàng 2. Phím tắt toàn cục.
 * ============================================================ */
'use client'

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../lib/store'
import { placeOverlay } from '../lib/scene/overlay'
import { getTopic } from '../lib/core/tree'
import { buildCatalogItems, copySelection, pasteFromClipboard, registerMenuUiActions, type CatalogItem } from '../lib/core/menuCatalog'
import { isNativeMacOS, mountNativeBridge } from '../lib/native/bridge'
import { IconBtn, Divider } from './ui-bits'
import {
  BrandBranchIcon, ChevronDownIcon, ChevronsLeftIcon, ChevronsRightIcon,
  DownloadIcon, FolderOpenIcon, LayoutGridIcon, PaletteBrushIcon, PenToolIcon,
  PlusIcon, RedoIcon, SaveIcon, UndoIcon, UploadIcon,
  CheckCircleIcon, AlertTriangleIcon, XCircleIcon,
} from './ui-icons'
import { CanvasView, ContextMenu, MenuItem } from './CanvasView'
import { Inspector, LAYOUTS } from './Inspector'
import { ImportDialog, ExportDialog, SettingsDialog, RecoveryDialog, ConfirmDialog, ShortcutsDialog, AboutDialog, GuideDialog, TrashDialog, LeaveProjectDialog } from './dialogs'

export function AppShell() {
  const hydrated = useApp((s) => s.hydrated)
  const transitionBusy = useApp((s) => s.transitionBusy)
  const doc = useApp((s) => s.doc)
  const saveStatus = useApp((s) => s.saveStatus)
  const sidebar = useApp((s) => s.sidebar)
  const inspectorOpen = useApp((s) => s.inspectorOpen)
  const drawMode = useApp((s) => s.drawMode)
  const past = useApp((s) => s.past)
  const future = useApp((s) => s.future)
  const [menuOpen, setMenuOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const layoutButton = useRef<HTMLButtonElement>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const layoutPickerOpen = useApp((s) => s.layoutPickerOpen)
  const nativeMac = isNativeMacOS()

  /* ---------- transition overlay (trì hoãn 180ms tránh nháy cho thao tác nhanh) ---------- */
  const [showTransitionOverlay, setShowTransitionOverlay] = useState(false)
  const transitionTicketRef = useRef(0)
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transitionRafRef = useRef<number | null>(null)

  useEffect(() => {
    const handleBusy = (busy: boolean) => {
      if (busy) {
        const ticket = ++transitionTicketRef.current
        transitionTimerRef.current = setTimeout(() => {
          transitionRafRef.current = requestAnimationFrame(() => {
            if (ticket === transitionTicketRef.current && useApp.getState().transitionBusy) {
              setShowTransitionOverlay(true)
            }
          })
        }, 180)
      } else {
        transitionTicketRef.current++
        if (transitionTimerRef.current) {
          clearTimeout(transitionTimerRef.current)
          transitionTimerRef.current = null
        }
        if (transitionRafRef.current) {
          cancelAnimationFrame(transitionRafRef.current)
          transitionRafRef.current = null
        }
        setShowTransitionOverlay(false)
      }
    }

    if (useApp.getState().transitionBusy) {
      handleBusy(true)
    }

    const unsub = useApp.subscribe((state, prev) => {
      if (state.transitionBusy !== prev.transitionBusy) {
        handleBusy(state.transitionBusy)
      }
    })

    return () => {
      unsub()
      transitionTicketRef.current++
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = null
      }
      if (transitionRafRef.current) {
        cancelAnimationFrame(transitionRafRef.current)
        transitionRafRef.current = null
      }
    }
  }, [])

  useEffect(() => { useApp.getState().init() }, [])

  useEffect(() => {
    const unregUi = registerMenuUiActions({
      openGuide: () => setGuideOpen(true),
      openAbout: () => setAboutOpen(true),
      openTrash: () => setTrashOpen(true),
    })
    const unmountBridge = nativeMac ? mountNativeBridge() : () => {}
    return () => {
      unmountBridge()
      unregUi()
    }
  }, [nativeMac])

  /* ---------- global shortcuts ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useApp.getState()
      const target = e.target as HTMLElement
      if (e.defaultPrevented || e.isComposing || st.transitionBusy || st.leavePrompt) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (document.querySelector('[role="menu"]')) return
      const inField = target?.closest?.('input, textarea, select, [contenteditable="true"]')
      if (!nativeMac && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'F10') {
        if (!e.repeat && !inField && !st.editor) {
          e.preventDefault()
          setMenuOpen('keyboard')
        }
        return
      }
      const inDrawToolbar = !!target?.closest?.('[data-omm-draw-toolbar]')
      if (!e.ctrlKey && !e.metaKey && !inDrawToolbar && target?.closest?.('button, a, [role="button"], [data-omm-control]')) return
      if (e.key === 'Escape' && !inField && !e.isComposing) {
        // Esc đóng lớp trên cùng: search panel trước, rồi focus mode (02.4/12.4)
        if (st.search.open) { st.openSearch(false); return }
        if (st.focusRootId) { st.exitFocus(); return }
      }
      if (inField || e.isComposing) return
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (ctrl && !inDrawToolbar) {
        switch (key) {
          case 'n': e.preventDefault(); st.createProject(); return
          case 'o': e.preventDefault(); st.setSidebar('open'); return
          case 's': e.preventDefault(); if (e.shiftKey) st.resolveConflictSaveAs(); else void st.saveNow(); return
          case 'z': e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return
          case 'y': e.preventDefault(); st.redo(); return
          case 'f': e.preventDefault(); st.openSearch(true); return
          case 'i': e.preventDefault(); st.setImportOpen(true); return
          case 'e': e.preventDefault(); st.openExport(); return
          case ',': e.preventDefault(); st.setSettingsOpen(true); return
          case 'd': e.preventDefault(); st.duplicateSelection(); return
          case 'a': e.preventDefault(); if (st.doc) st.setSelection(st.doc.topics.map((t) => t.id)); return
          case 'c': e.preventDefault(); copySelection(); return
          case 'x': e.preventDefault(); copySelection(true); return
          case 'v': e.preventDefault(); pasteFromClipboard(); return
          case '0': e.preventDefault(); document.dispatchEvent(new CustomEvent('omm-canvas', { detail: { action: 'fit' } })); return
          case '=': case '+': e.preventDefault(); document.dispatchEvent(new CustomEvent('omm-canvas', { detail: { action: 'zoom', dir: 1 } })); return
          case '-': e.preventDefault(); document.dispatchEvent(new CustomEvent('omm-canvas', { detail: { action: 'zoom', dir: -1 } })); return
        }
        return
      }
      if (!st.doc) return
      if (!inDrawToolbar) {
        switch (e.key) {
          case 'Tab':
            if (!e.shiftKey && target?.closest?.('[data-omm-canvas]')) { e.preventDefault(); st.addChildToSelection() }
            return
          case 'Enter': e.preventDefault(); st.addSiblingToSelection(false); return
          case 'F2': e.preventDefault(); if (st.selection[0] && !st.selection[0].startsWith('drawing:') && !st.selection[0].startsWith('crosslink:')) st.startEdit(st.selection[0], 'title'); return
          case 'Delete': case 'Backspace':
            if (st.selection[0]?.startsWith('drawing:')) {
              const d = st.doc.drawings.find((x) => x.id === st.selection[0].slice('drawing:'.length))
              if (d) { st.dispatch({ type: 'removeDrawings', drawings: [d] }, 'Xóa nét vẽ'); st.setSelection([]) }
            } else if (st.selection[0]?.startsWith('crosslink:')) {
              const c = st.doc.crosslinks.find((x) => x.id === st.selection[0].slice('crosslink:'.length))
              if (c) { st.dispatch({ type: 'removeCrosslinks', crosslinks: [c] }, 'Xóa nối'); st.setSelection([]) }
            } else st.deleteSelection()
            return
          case 'Escape': return // handled ở trên + component
        }
      }
      if (e.altKey || ctrl || document.querySelector('[role="dialog"], [role="menu"]')) return
      // tool keys
      if (key === 'v') { e.preventDefault(); st.setTool('select') }
      else if (key === 'p') { e.preventDefault(); st.setDrawMode(true); st.setTool('pen') }
      else if (key === 'h') { e.preventDefault(); st.setDrawMode(true); st.setTool('highlighter') }
      else if (key === 'e') { e.preventDefault(); st.setDrawMode(true); st.setTool('eraser') }
      else if (key === 'l') { e.preventDefault(); st.setDrawMode(true); st.setTool('line') }
      else if (key === 'r') { e.preventDefault(); st.setDrawMode(true); st.setTool('rect') }
      else if (key === 'o') { e.preventDefault(); st.setDrawMode(true); st.setTool('ellipse') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nativeMac])

  const statusInfo = useMemo(() => {
    switch (saveStatus) {
      case 'clean': return { icon: <CheckCircleIcon size={13} />, text: 'Đã lưu', cls: 'text-[var(--success)]', bg: 'bg-[var(--successSoft)]' }
      case 'dirty': return { icon: <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />, text: 'Chưa lưu', cls: 'text-[var(--text2)]', bg: 'bg-[var(--panel-2-bg)]' }
      case 'saving': return { icon: <span className="h-2 w-2 animate-pulse rounded-full bg-current" aria-hidden="true" />, text: 'Đang lưu…', cls: 'text-[var(--accent)]', bg: 'bg-[var(--accentSoft)]' }
      case 'error': return { icon: <XCircleIcon size={13} />, text: 'Lỗi lưu', cls: 'text-[var(--danger)]', bg: 'bg-[var(--dangerSoft)]' }
      case 'conflict': return { icon: <AlertTriangleIcon size={13} />, text: 'Xung đột tệp', cls: 'text-[var(--warning)]', bg: 'bg-[var(--warningSoft)]' }
      default: return null
    }
  }, [saveStatus])

  if (!hydrated) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-[var(--bg)] text-[var(--text2)]">
        <img src="/openmindmap-logo-v4.png" alt="OpenMindmap" className="h-14 w-14 rounded-2xl shadow-md" />
        <div className="text-[13px]">Đang mở OpenMindmap…</div>
      </div>
    )
  }

  const sidebarWidth = sidebar === 'open' ? 240 : sidebar === 'collapsed' ? 48 : 0

  return (
    <div onMouseDownCapture={e => { if (useApp.getState().editor && (e.target as HTMLElement).closest('[data-project-transition]')) e.preventDefault() }} className="flex h-dvh flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      {/* Header cố định 44px — single unified command bar */}
      <header inert={transitionBusy} className="relative z-20 flex h-[44px] shrink-0 items-center justify-between gap-1.5 border-b border-[var(--border)] bg-[var(--panel)] px-2.5" style={{ boxShadow: 'var(--shadow-sm)' }}>
        <div className="flex min-w-0 items-center gap-0.5">
          <div className="relative flex shrink-0 items-center">
            {nativeMac ? (
              <div data-omm-native-brand className="flex h-8 items-center gap-1.5 rounded-lg px-1.5 text-[13px] font-semibold">
                <span className="grid h-6 w-6 place-items-center rounded-md bg-[var(--accent)] text-[var(--onAccent)] shadow-sm">
                  <BrandBranchIcon size={16} />
                </span>
                <span className="hidden sm:inline text-[var(--text)]">OpenMindmap</span>
              </div>
            ) : (
              <>
                <button
                  ref={menuButton}
                  type="button"
                  onClick={() => setMenuOpen(current => current ? false : 'pointer')}
                  aria-expanded={!!menuOpen}
                  aria-haspopup="menu"
                  className="flex h-8 items-center gap-1.5 rounded-lg px-1.5 text-[13px] font-semibold transition-colors hover:bg-[var(--hover)]"
                  title="Mở menu ứng dụng (Alt+F10)"
                >
                  <span className="grid h-6 w-6 place-items-center rounded-md bg-[var(--accent)] text-[var(--onAccent)] shadow-sm">
                    <BrandBranchIcon size={16} />
                  </span>
                  <span className="hidden sm:inline text-[var(--text)]">OpenMindmap</span>
                  <ChevronDownIcon size={13} className="text-[var(--text3)]" />
                </button>
                {menuOpen && <AppMenu focusOnOpen={menuOpen === 'keyboard'} onClose={(restoreFocus) => { setMenuOpen(false); if (restoreFocus) menuButton.current?.focus() }} />}
              </>
            )}
          </div>
          <Divider />
          <IconBtn title="Mở danh sách dự án (Ctrl+O)" onClick={() => useApp.getState().setSidebar(sidebar === 'open' ? 'collapsed' : 'open')}>
            <FolderOpenIcon size={16} /><span className="hidden lg:inline">Mở</span>
          </IconBtn>
          <IconBtn title="Lưu dự án (Ctrl+S)" disabled={!doc || saveStatus === 'clean' || saveStatus === 'conflict'} onClick={() => void useApp.getState().saveNow()}>
            <SaveIcon size={16} /><span className="hidden lg:inline">Lưu</span>
          </IconBtn>
          <Divider />
          <IconBtn title={`Hoàn tác (Ctrl+Z)${past.length ? ` — ${past[past.length - 1].label}` : ''}`} disabled={!past.length} onClick={() => useApp.getState().undo()}>
            <UndoIcon size={16} /><span className="hidden md:inline">Hoàn tác</span>
          </IconBtn>
          <IconBtn title="Làm lại (Ctrl+Y)" disabled={!future.length} onClick={() => useApp.getState().redo()}>
            <RedoIcon size={16} /><span className="hidden md:inline">Làm lại</span>
          </IconBtn>
          <Divider />
          <IconBtn title="Thêm chủ đề con (Tab)" disabled={!doc} onClick={() => useApp.getState().addChildToSelection()}>
            <PlusIcon size={16} /><span className="hidden md:inline">Thêm</span>
          </IconBtn>
          <IconBtn buttonRef={layoutButton} title="Bố cục (8 kiểu)" active={layoutPickerOpen} aria-expanded={layoutPickerOpen} aria-haspopup="menu" disabled={!doc} onClick={() => useApp.getState().setLayoutPicker(!layoutPickerOpen)}>
            <LayoutGridIcon size={16} /><span className="hidden md:inline">Bố cục</span>
          </IconBtn>
          {layoutPickerOpen && (
            <LayoutPopover
              anchorRef={layoutButton}
              currentKind={doc?.layout.kind ?? 'balanced'}
              onSelect={(id) => { useApp.getState().applyLayoutKind(id); useApp.getState().setLayoutPicker(false); layoutButton.current?.focus() }}
              onClose={(restoreFocus) => { useApp.getState().setLayoutPicker(false); if (restoreFocus) layoutButton.current?.focus() }}
            />
          )}
          <IconBtn title="Kiểu (Inspector)" disabled={!doc} onClick={() => useApp.getState().setInspector(true, useApp.getState().selection.length ? 'text' : 'theme')}>
            <PaletteBrushIcon size={16} /><span className="hidden md:inline">Kiểu</span>
          </IconBtn>
          <IconBtn title="Công cụ vẽ: bút, đánh dấu, tẩy, hình" active={drawMode} disabled={!doc} onClick={() => useApp.getState().setDrawMode(!drawMode)}>
            <PenToolIcon size={16} /><span className="hidden md:inline">Vẽ</span>
          </IconBtn>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {saveStatus === 'conflict' && (
            <>
              <button type="button" onClick={() => useApp.getState().resolveConflictReload()} className="h-7 rounded-md border border-[var(--warning)] bg-[var(--warningSoft)] px-2 text-[11.5px] font-medium text-[var(--warning)] transition-colors hover:opacity-85">Tải lại</button>
              <button type="button" onClick={() => useApp.getState().resolveConflictSaveAs()} className="h-7 rounded-md border border-[var(--warning)] bg-[var(--warningSoft)] px-2 text-[11.5px] font-medium text-[var(--warning)] transition-colors hover:opacity-85">Lưu thành</button>
            </>
          )}
          {statusInfo && doc && (
            <span className={`hidden sm:inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium ${statusInfo.bg} ${statusInfo.cls}`} title="Trạng thái lưu dự án">
              {statusInfo.icon} {statusInfo.text}
            </span>
          )}
          <button
            type="button"
            onClick={() => useApp.getState().setImportOpen(true)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[12px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--accent)]"
            title="Nhập JSON/MD/OPML/TXT (Ctrl+I)"
          >
            <UploadIcon size={15} className="text-[var(--text2)]" />
            <span className="hidden sm:inline">Nhập</span>
          </button>
          <button
            type="button"
            onClick={() => useApp.getState().openExport()}
            disabled={!doc}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--onAccent)] shadow-sm transition-colors hover:bg-[var(--accentStrong)] disabled:cursor-not-allowed disabled:opacity-40"
            title="Xuất 7 định dạng (Ctrl+E)"
          >
            <DownloadIcon size={15} />
            <span className="hidden sm:inline">Xuất</span>
          </button>
        </div>
      </header>

      {transitionBusy && showTransitionOverlay && <div role="status" className="fixed inset-0 z-[120] grid place-items-center bg-black/20">Đang xử lý dự án…</div>}
      {/* Main */}
      <div inert={transitionBusy} className="relative flex min-h-0 flex-1">
        <Sidebar width={sidebarWidth} />
        <CanvasView />
        {inspectorOpen && <Inspector />}
      </div>

      {/* Dialogs */}
      <ImportDialog />
      <ExportDialog />
      <SettingsDialog />
      <RecoveryDialog />
      <ShortcutsDialog />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <GuideDialog open={guideOpen} onClose={() => setGuideOpen(false)} />
      <TrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} />
      <ConfirmDialog />
      <LeaveProjectDialog />
    </div>
  )
}

/* ================= App menu popup — 2 cột 43 mục (A01–A43) ================= */
interface AppMenuAction {
  id: string
  label: string
  hint?: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
  recentToggle?: boolean
}

function AppMenu({ focusOnOpen, onClose }: { focusOnOpen: boolean; onClose: (restoreFocus?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const doc = useApp((s) => s.doc)
  const registry = useApp((s) => s.registry)
  const gridOn = useApp((s) => s.gridOn)
  const snapOn = useApp((s) => s.snapOn)
  const minimapOn = useApp((s) => s.minimapOn)
  const sidebar = useApp((s) => s.sidebar)
  const inspectorOpen = useApp((s) => s.inspectorOpen)
  const selection = useApp((s) => s.selection)
  const pastLen = useApp((s) => s.past.length)
  const futureLen = useApp((s) => s.future.length)
  const [recentOpen, setRecentOpen] = useState(false)

  useEffect(() => { if (focusOnOpen) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [focusOnOpen])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); onClose(true) } }
    window.addEventListener('pointerdown', h, true)
    window.addEventListener('keydown', k)
    return () => { window.removeEventListener('pointerdown', h, true); window.removeEventListener('keydown', k) }
  }, [onClose])

  const st = () => useApp.getState()
  const { leftGroups, rightGroups } = useMemo(() => {
    void doc; void gridOn; void snapOn; void minimapOn; void sidebar; void inspectorOpen; void selection; void pastLen; void futureLen
    const items = buildCatalogItems(useApp.getState()).filter((item) => item.column === 'left' || item.column === 'right')
    const groupByCol = (col: 'left' | 'right') => {
      const map = new Map<string, AppMenuAction[]>()
      for (const item of items) {
        if (item.column !== col) continue
        const action: AppMenuAction = {
          id: item.id,
          label: item.label,
          hint: item.hint,
          disabled: item.disabled,
          active: item.active,
          recentToggle: item.recentToggle,
          onClick: item.recentToggle
            ? () => setRecentOpen((v) => !v)
            : () => {
                item.run()
                onClose()
              },
        }
        const list = map.get(item.group) ?? []
        list.push(action)
        map.set(item.group, list)
      }
      return Array.from(map.entries()).map(([title, groupItems]) => ({ title, items: groupItems }))
    }
    return { leftGroups: groupByCol('left'), rightGroups: groupByCol('right') }
  }, [doc, gridOn, snapOn, minimapOn, sidebar, inspectorOpen, selection, pastLen, futureLen, onClose])

  const renderGroup = (g: { title: string; items: AppMenuAction[] }) => (
    <section key={g.title} className="mb-1.5 last:mb-0">
      <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text3)]">{g.title}</div>
      <div className="space-y-0">
        {g.items.map((item) => (
          <div key={item.id}>
            <button
              type="button"
              data-menu-id={item.id}
              disabled={item.disabled}
              title={item.disabled ? 'Không khả dụng' : item.hint}
              aria-expanded={item.recentToggle ? recentOpen : undefined}
              onClick={item.onClick}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-[3px] text-left text-[12px] leading-[16px] text-[var(--text)] transition-colors hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {item.active !== undefined && (
                  <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${item.active ? 'bg-[var(--accent)]' : 'border border-[var(--border-strong)] bg-transparent'}`} aria-hidden="true" />
                )}
                <span className="break-words">{item.label}</span>
              </span>
              {item.recentToggle ? (
                <span className="shrink-0 whitespace-nowrap rounded bg-[var(--panel-2-bg)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--text3)]">
                  {registry.length} {recentOpen ? '▴' : '▾'}
                </span>
              ) : item.hint ? (
                <span className="shrink-0 whitespace-nowrap rounded bg-[var(--panel-2-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text3)]">
                  {item.hint}
                </span>
              ) : null}
            </button>
            {item.recentToggle && recentOpen && (
              <div className="my-1 ml-2 max-h-40 overflow-y-auto border-l border-[var(--border)] pl-2">
                {registry.slice(0, 8).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    title={m.name}
                    onClick={() => { onClose(); void st().openProject(m.id) }}
                    className="flex w-full items-center rounded-md px-2 py-1 text-left text-[11.5px] text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <span className="truncate">{m.name}</span>
                  </button>
                ))}
                {!registry.length && <div className="px-2 py-1 text-[11px] text-[var(--text3)]">Chưa có dự án nào</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Menu ứng dụng"
      className="fixed left-2 top-[48px] z-[80] max-h-[calc(100dvh-56px)] w-[680px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] omm-fade-in"
      style={{ boxShadow: 'var(--shadow-pop)' }}
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--panel-2-bg)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <img src="/openmindmap-logo-v4.png" alt="OpenMindmap" className="h-6 w-6 rounded-md" />
          <span className="text-[12px] font-semibold text-[var(--text)]">OpenMindmap</span>
        </div>
        <span className="text-[11px] text-[var(--text3)]">Esc để đóng</span>
      </div>
      <div className="grid grid-cols-1 gap-3 p-2.5 lg:grid-cols-2">
        <div className="min-w-0 lg:border-r lg:border-[var(--border)] lg:pr-3">{leftGroups.map(renderGroup)}</div>
        <div className="min-w-0">{rightGroups.map(renderGroup)}</div>
      </div>
    </div>
  )
}

/* ================= Sidebar (LOCK-03) ================= */
function Sidebar({ width }: { width: number }) {
  const registry = useApp((s) => s.registry)
  const doc = useApp((s) => s.doc)
  const sidebar = useApp((s) => s.sidebar)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null)
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...registry].sort((a, b) => (b.lastOpened > a.lastOpened ? 1 : -1)).filter((m) => !q || m.name.toLowerCase().includes(q))
  }, [registry, query])

  if (width === 0) {
    return (
      <button type="button" onClick={() => useApp.getState().setSidebar('open')} className="grid w-7 shrink-0 place-items-center border-r border-[var(--border)] bg-[var(--panel)] text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--accent)]" title="Mở sidebar" aria-label="Mở sidebar">
        <ChevronsRightIcon size={15} />
      </button>
    )
  }

  return (
    <aside aria-label="Danh sách dự án" className="relative flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)] max-sm:absolute max-sm:inset-y-0 max-sm:left-0 max-sm:z-30 max-sm:shadow-lg" style={{ width }}>
      {/* header */}
      <div className="flex items-center justify-between px-3 pt-2.5" style={{ height: 42 }}>
        {sidebar === 'open' ? (
          <>
            <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text2)]">Dự án</span>
            <button type="button" onClick={() => useApp.getState().setSidebar('collapsed')} className="grid h-7 w-7 place-items-center rounded-md text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]" title="Thu gọn sidebar" aria-label="Thu gọn sidebar">
              <ChevronsLeftIcon size={15} />
            </button>
          </>
        ) : (
          <div className="flex w-full flex-col items-center gap-2 pt-1">
            <button type="button" onClick={() => useApp.getState().setSidebar('open')} className="mx-auto grid h-8 w-8 place-items-center rounded-md text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--accent)]" title="Mở sidebar" aria-label="Mở sidebar">
              <ChevronsRightIcon size={16} />
            </button>
          </div>
        )}
      </div>
      {sidebar === 'collapsed' && (
        <div className="mt-2 flex flex-col items-center gap-2 px-1">
          <button type="button" data-project-transition onClick={() => useApp.getState().createProject()} className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--accent)] text-[var(--onAccent)] shadow-sm transition-colors hover:bg-[var(--accentStrong)]" title="Tạo dự án (Ctrl+N)" aria-label="Tạo dự án">
            <PlusIcon size={16} />
          </button>
        </div>
      )}
      {sidebar === 'open' && (
        <>
          <div className="px-3 pb-2.5 pt-1">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm dự án…" aria-label="Tìm dự án" className="h-8 min-h-[32px] w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 text-[12px] transition-colors placeholder:text-[var(--text3)] focus:border-[var(--accent)] focus:bg-[var(--panel)]" />
          </div>
          <div className="flex-1 overflow-y-auto px-2.5">
            {list.map((m) => (
              <div
                key={m.id}
                tabIndex={0}
                data-project-transition onClick={() => useApp.getState().openProject(m.id)}
                onKeyDown={e => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'F2') { e.preventDefault(); setRenaming(m.id) }
                  else if (e.key === 'Enter') { e.preventDefault(); void useApp.getState().openProject(m.id) }
                }}
                onDoubleClick={() => setRenaming(m.id)}
                onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, id: m.id }) }}
                className={`group mb-1 flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] transition-colors ${doc?.project_id === m.id ? 'bg-[var(--accentSoft)] font-medium text-[var(--accent)]' : 'text-[var(--text)] hover:bg-[var(--hover)]'}`}
                title={`${m.name} · ${m.nodeCount} node · mở ${new Date(m.lastOpened).toLocaleString('vi-VN')}`}
              >
                {renaming === m.id ? (
                  <input
                    autoFocus defaultValue={m.name}
                    aria-label="Đổi tên dự án"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const v = (e.target as HTMLInputElement).value.trim()
                        if (v) {
                          if (doc?.project_id === m.id) useApp.getState().renameProject(v)
                          else {
                            const cur = registry.find((x) => x.id === m.id)
                            if (cur) void useApp.getState().renameStoredProject(cur.id, v)
                          }
                        }
                        setRenaming(null)
                      }
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={() => setRenaming(null)}
                    className="w-full rounded border border-[var(--accent)] bg-[var(--bg)] px-1.5 py-0.5 text-[12px]"
                  />
                ) : (
                  <>
                    <span className="truncate">{m.name}</span>
                    <button
                      type="button"
                      aria-label={`Thao tác cho dự án ${m.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        const r = e.currentTarget.getBoundingClientRect()
                        setCtx({ x: e.clientX || r.right, y: e.clientY || r.bottom, id: m.id })
                      }}
                      className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text2)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:opacity-100 hover:bg-[var(--border-strong)]"
                      title="Thao tác khác"
                    >···</button>
                  </>
                )}
              </div>
            ))}
            {!list.length && <div className="px-2 py-6 text-center text-[11.5px] text-[var(--text3)]">{query ? 'Không tìm thấy' : 'Chưa có dự án nào'}</div>}
          </div>
          <div className="border-t border-[var(--border)] p-3">
            <button type="button" data-project-transition onClick={() => useApp.getState().createProject()} className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] text-[12.5px] font-medium text-[var(--onAccent)] shadow-sm transition-colors hover:bg-[var(--accentStrong)]" title="Tạo dự án (Ctrl+N)">
              <PlusIcon size={15} /> Tạo dự án
            </button>
          </div>
        </>
      )}
      {ctx && (
        <ContextMenu
          x={ctx.x} y={ctx.y}
          items={[
            { label: 'Đổi tên (F2/double-click)', onClick: () => setRenaming(ctx.id) },
            { label: 'Nhân bản', onClick: () => useApp.getState().duplicateProject(ctx.id) },
            { label: 'Lưu thành bản sao độc lập', disabled: doc?.project_id !== ctx.id, onClick: () => useApp.getState().resolveConflictSaveAs() },
            { sep: true, label: '' },
            { label: 'Chuyển vào thùng rác', danger: true, onClick: () => useApp.getState().deleteProject(ctx.id) },
            { label: 'Bỏ khỏi danh sách gần đây', onClick: () => useApp.getState().removeRecent(ctx.id) },
          ]}
          onClose={() => setCtx(null)}
        />
      )}
    </aside>
  )
}

function LayoutPopover({ anchorRef, currentKind, onSelect, onClose }: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  currentKind: string
  onSelect: (id: (typeof LAYOUTS)[number]['id']) => void
  onClose: (restoreFocus?: boolean) => void
}) {
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 16, top: 90 })

  useLayoutEffect(() => {
    const place = () => {
      const btn = anchorRef.current
      const pop = popRef.current
      if (!btn || !pop) return
      const r = btn.getBoundingClientRect()
      const pr = pop.getBoundingClientRect()
      const p = placeOverlay(r.left, r.bottom + 6, pr.width || 420, pr.height || 260, window.innerWidth, window.innerHeight)
      setPos(p)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorRef])

  useEffect(() => {
    popRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (popRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !document.querySelector('[role="dialog"]')) {
        e.preventDefault()
        e.stopPropagation()
        onClose(true)
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={popRef}
      role="region"
      aria-label="Chọn bố cục sơ đồ"
      data-layout-popover
      data-omm-control
      className="fixed z-50 w-[440px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 omm-fade-in"
      style={{ left: pos.left, top: pos.top, boxShadow: 'var(--shadow-pop)' }}
    >
      <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text2)]">Chọn bố cục — click để áp dụng</div>
      <div className="grid grid-cols-4 gap-1.5">
        {LAYOUTS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onSelect(l.id)}
            title={l.name}
            aria-pressed={currentKind === l.id}
            className={`flex flex-col items-center gap-1.5 rounded-lg border p-2.5 text-[10.5px] font-medium leading-tight transition-all ${currentKind === l.id ? 'border-[var(--accent)] bg-[var(--accentSoft)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text2)] hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)]'}`}
          >
            <svg width="34" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={l.thumb} /></svg>
            {l.name.split(' (')[0]}
          </button>
        ))}
      </div>
      <div className="mt-2 px-1 text-[10.5px] leading-relaxed text-[var(--text3)]">Đổi layout không đụng manual_position (Free-form) và không di chuyển nét vẽ (LOCK-07). Tinh chỉnh khoảng cách trong Inspector → Bố cục.</div>
    </div>,
    document.body
  )
}
