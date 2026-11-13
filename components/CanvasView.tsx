/* ============================================================
 * OpenMindmap — components/CanvasView.tsx
 * Canvas: render SceneGraph (V35-007), pan/zoom (12.x), Drag&Drop
 * state machine (07.1–07.3), inline editor (04.3), drawing engine
 * (09.x), crosslinks (10.x), mini map, focus, search, zoom HUD.
 * Preview/ghost chỉ nằm RAM (LOCK-05).
 * ============================================================ */
'use client'
import { loadSession } from '../lib/storage/projects'
import { readImage } from '../lib/io/images'
import { BranchClipboard, pasteBranch } from '../lib/core/clipboard'

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { placeOverlay } from '../lib/scene/overlay'
import { useApp } from '../lib/store'
import { CROSSLINK_LABEL_FONT, NOTE_BADGE_PATH, URL_BADGE_LINK_PATHS, buildScene, computeBounds, measureNodeContent, pillPath, pillRadius, Scene, SceneNode, SceneEdge, SceneCrosslink, SceneDrawing } from '../lib/scene/scene'
import { classifyAutoDragTarget, AutoDragResult } from '../lib/scene/dragTarget'
import { resolveStyle } from '../lib/core/style'
import { getTopic, childrenOf, descendantsOf, isDescendantOrSelf } from '../lib/core/tree'
import { Topic, uuid, Crosslink, DrawingObject, LayoutKind, ProjectDocV3 } from '../lib/core/types'
import { NODE_ICONS } from '../lib/scene/icons'
import { PlusIcon, UploadIcon, CheckCircleIcon, AlertTriangleIcon, XCircleIcon, InfoCircleIcon, CloseIcon } from './ui-icons'

type Pt = { x: number; y: number }

type ChevronSide = 'right' | 'left' | 'top' | 'bottom'
interface ChevronPlacement {
  cx: number
  cy: number
  side: ChevronSide
  badgeRect?: { x: number; y: number; w: number; h: number }
}

function chevronPlacementOf(
  n: SceneNode,
  layoutKind: LayoutKind = 'balanced',
  direction?: string | null,
  centralBox?: { x: number; y: number; w: number; h: number } | null,
): ChevronPlacement {
  const hidden = n.collapsed ? n.hidden : 0
  const badgeW = hidden > 0 ? (hidden > 99 ? 26 : hidden > 9 ? 20 : 14) : 0
  let side: ChevronSide = 'right'
  if (layoutKind === 'tree' || layoutKind === 'organization') {
    side = direction === 'bottom' ? 'top' : 'bottom'
  } else if (layoutKind === 'timeline') {
    if (n.isCentral) side = 'right'
    else if (centralBox && n.box.y + n.box.h / 2 < centralBox.y + 1) side = 'top'
    else side = 'bottom'
  } else if (layoutKind === 'logic') {
    side = direction === 'left' ? 'left' : 'right'
  } else if (layoutKind === 'balanced') {
    if (n.isCentral) side = direction === 'left' ? 'left' : 'right'
    else if (centralBox && n.box.x + n.box.w / 2 < centralBox.x + centralBox.w / 2) side = 'left'
    else side = 'right'
  } else if (layoutKind === 'fishbone') {
    side = direction === 'left' ? 'right' : 'left'
  } else if (layoutKind === 'radial') {
    if (!n.isCentral && centralBox) {
      const dx = (n.box.x + n.box.w / 2) - (centralBox.x + centralBox.w / 2)
      const dy = (n.box.y + n.box.h / 2) - (centralBox.y + centralBox.h / 2)
      if (Math.abs(dx) >= Math.abs(dy)) side = dx < 0 ? 'left' : 'right'
      else side = dy < 0 ? 'top' : 'bottom'
    }
  }

  if (side === 'bottom') {
    const shiftX = badgeW > 0 ? -(badgeW + 2) / 2 : 0
    const cx = n.box.x + n.box.w / 2 + shiftX
    const cy = n.box.y + n.box.h + 13
    return { cx, cy, side, badgeRect: badgeW > 0 ? { x: cx + 7, y: cy - 8, w: badgeW, h: 16 } : undefined }
  }
  if (side === 'top') {
    const shiftX = badgeW > 0 ? -(badgeW + 2) / 2 : 0
    const cx = n.box.x + n.box.w / 2 + shiftX
    const cy = n.box.y - 13
    return { cx, cy, side, badgeRect: badgeW > 0 ? { x: cx + 7, y: cy - 8, w: badgeW, h: 16 } : undefined }
  }
  if (side === 'left') {
    const cx = n.box.x - 14
    const cy = n.box.y + n.box.h / 2
    return { cx, cy, side, badgeRect: badgeW > 0 ? { x: cx - 7 - badgeW, y: cy - 8, w: badgeW, h: 16 } : undefined }
  }
  const cx = n.box.x + n.box.w + 14
  const cy = n.box.y + n.box.h / 2
  return { cx, cy, side: 'right', badgeRect: badgeW > 0 ? { x: cx + 7, y: cy - 8, w: badgeW, h: 16 } : undefined }
}

function connectorHandleOf(
  n: SceneNode,
  zoom: number,
  layoutKind: LayoutKind = 'balanced',
  direction?: string | null,
  centralBox?: { x: number; y: number; w: number; h: number } | null,
): { x: number; y: number; r: number } {
  const r = 5 / zoom
  const hasChevron = n.childCount > 0 || n.hidden > 0
  if (!hasChevron) return { x: n.box.x + n.box.w + Math.max(4, 6 / zoom), y: n.box.y + n.box.h / 2, r }
  const ch = chevronPlacementOf(n, layoutKind, direction, centralBox)
  if (ch.side !== 'right') {
    return { x: n.box.x + n.box.w + Math.max(4, 6 / zoom), y: n.box.y + n.box.h / 2, r }
  }
  const badgeExtra = ch.badgeRect ? ch.badgeRect.w + 2 : 9
  return { x: n.box.x + n.box.w + 14 + badgeExtra + Math.max(8, 10 / zoom), y: n.box.y + n.box.h / 2, r }
}

function drawingFillHit(obj: DrawingObject, w: Pt): boolean {
  if ((obj.kind !== 'rect' && obj.kind !== 'ellipse') || !obj.fill || obj.fill === 'none' || obj.fill === 'transparent') return false
  const pts = obj.points
  if (pts.length < 2) return false
  const [p1, p2] = [pts[0], pts[pts.length - 1]]
  const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y)
  const ww = Math.abs(p2.x - p1.x), hh = Math.abs(p2.y - p1.y)
  if (ww <= 0 || hh <= 0) return false
  if (obj.kind === 'rect') return w.x >= x && w.x <= x + ww && w.y >= y && w.y <= y + hh
  const rx = ww / 2, ry = hh / 2
  const cx = x + rx, cy = y + ry
  const nx = (w.x - cx) / rx, ny = (w.y - cy) / ry
  return nx * nx + ny * ny <= 1
}

function titleEditorBox(node: SceneNode, zoom: number, size: { w: number; h: number }) {
  const marginX = Math.min(8, Math.max(0, (size.w - 80) / 2))
  const marginY = Math.min(8, Math.max(0, (size.h - 30) / 2))
  return {
    w: Math.min(Math.max(80, node.box.w * zoom), size.w - 2 * marginX),
    h: Math.min(Math.max(30, node.box.h * zoom), size.h - 2 * marginY),
    marginX, marginY,
  }
}
type Intent = 'reparent' | 'reorder' | 'side' | 'detach' | 'move' | 'invalid' | 'cancel' | null

interface Interaction {
  kind: 'none' | 'pan' | 'marquee' | 'node' | 'handle' | 'stroke' | 'shape' | 'erase' | 'resize'
  startScreen: Pt
  startClient: Pt
  startWorld: Pt
  startCamera: { x: number; y: number; zoom: number }
  pointerWorld: Pt
  pointerScreen: Pt
  pointerClient: Pt
  moved: boolean
  spaceHeld?: boolean
  ids: string[]
  originBoxes: Map<string, { x: number; y: number }>
  dropTargetId: string | null
  intent: Intent
  insertLine: { x1: number; y1: number; x2: number; y2: number } | null
  insertParentId: string | null
  insertIndex: number
  balancedStartSide: 'left' | 'right' | null
  livePoints: Pt[]
  crosslinkFrom: string | null
  invalidMsg: string
  guides: { vertical: number | null; horizontal: number | null }
  resizeId: string | null
  resizeStart: { w: number; h: number } | null
  resizeNext?: { w: number; h: number }
  delta?: Pt
}

type RenderedDrop = {
  pointer: number
  doc: ProjectDocV3 | null
  generation: number
  layoutKind: LayoutKind | null
  rootId: string
} & (
  | { intent: 'detach' }
  | { intent: 'reparent'; targetId: string }
  | { intent: 'reorder'; parentId: string; index: number }
)

interface ActiveGesture {
  pointer: number
  doc: ProjectDocV3 | null
  generation: number
  layoutKind: LayoutKind | null
  target: Element
  rootId: string | null
  dragOriginId: string | null
  startBox: Pt | null
  startWorld: Pt
}

function matchesRenderedDrop(rendered: RenderedDrop | null, active: ActiveGesture | null, drop: AutoDragResult): boolean {
  if (!rendered || !active || !active.rootId) return false
  if (
    rendered.pointer !== active.pointer
    || rendered.doc !== active.doc
    || rendered.generation !== active.generation
    || rendered.layoutKind !== active.layoutKind
    || rendered.rootId !== active.rootId
  ) return false
  if (drop.intent === 'detach') return rendered.intent === 'detach'
  if (drop.intent === 'reparent') return rendered.intent === 'reparent' && rendered.targetId === drop.target
  if (drop.intent === 'reorder') return rendered.intent === 'reorder' && rendered.parentId === drop.parentId && rendered.index === drop.index
  return false
}

const IDLE: Interaction = {
  kind: 'none', startScreen: { x: 0, y: 0 }, startClient: { x: 0, y: 0 }, startWorld: { x: 0, y: 0 },
  startCamera: { x: 0, y: 0, zoom: 1 }, pointerWorld: { x: 0, y: 0 }, pointerScreen: { x: 0, y: 0 }, pointerClient: { x: 0, y: 0 },
  moved: false, ids: [], originBoxes: new Map(), dropTargetId: null, intent: null,
  insertLine: null, insertParentId: null, insertIndex: 0, balancedStartSide: null,
  livePoints: [], crosslinkFrom: null, invalidMsg: '', guides: { vertical: null, horizontal: null }, resizeId: null, resizeStart: null,
}

export function CanvasView() {
  const doc = useApp((s) => s.doc)
  const camera = useApp((s) => s.camera)
  const setCamera = useApp((s) => s.setCamera)
  const selection = useApp((s) => s.selection)
  const setSelection = useApp((s) => s.setSelection)
  const toggleSelection = useApp((s) => s.toggleSelection)
  const hoverId = useApp((s) => s.hoverId)
  const tool = useApp((s) => s.tool)
  const drawMode = useApp((s) => s.drawMode)
  const brush = useApp((s) => s.brush)
  const gridOn = useApp((s) => s.gridOn)
  const snapOn = useApp((s) => s.snapOn)
  const settings = useApp((s) => s.settings)
  const focusRootId = useApp((s) => s.focusRootId)
  const minimapOn = useApp((s) => s.minimapOn)
  const dispatch = useApp((s) => s.dispatch)
  const toast = useApp((s) => s.toast)
  const startEdit = useApp((s) => s.startEdit)
  const editor = useApp((s) => s.editor)
  const setHover = (id: string | null) => useApp.setState({ hoverId: id })

  /* ---------- Stable callbacks (định nghĩa 1 lần) ----------
   * Đọc state tươi qua useApp.getState() → nhận dạng không đổi giữa các lần
   * render → kết hợp React.memo giúp node không đổi không bao giờ re-render. */
  const onChevronToggle = useCallback((id: string) => {
    const st = useApp.getState()
    if (!st.doc) return
    const t = getTopic(st.doc, id)
    if (!t) return
    st.dispatch({ type: 'collapse', items: [{ id, value: !t.collapsed }] }, t.collapsed ? 'Mở rộng' : 'Thu gọn')
  }, [])
  const onNoteOpen = useCallback((id: string) => {
    const st = useApp.getState()
    st.setSelection([id])
    st.setInspector(true, 'content')
    st.startEdit(id, 'notes')
  }, [])
  const onUrlOpen = useCallback((id: string) => {
    const st = useApp.getState()
    const t = st.doc ? getTopic(st.doc, id) : undefined
    const url = t?.url ?? ''
    if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener')
    else st.toast('warn', 'Liên kết không an toàn', 'Chỉ mở được http/https/mailto.')
  }, [])
  const onCheckboxToggle = useCallback((id: string) => {
    const st = useApp.getState()
    if (!st.doc) return
    const t = getTopic(st.doc, id)
    if (!t) return
    st.dispatch({ type: 'setProps', id, before: { checkbox: t.checkbox }, after: { checkbox: !(t.checkbox === true) } }, 'Checkbox')
  }, [])
  const selectionSet = useMemo(() => new Set(selection), [selection])

  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const sizeRef = useRef(size)
  sizeRef.current = size
  const titleEditorRef = useRef<HTMLTextAreaElement>(null)
  const [fontReadyTick, setFontReadyTick] = useState(0)
  const [editorRect, setEditorRect] = useState<{ key: string; left: number; top: number; w: number; h: number } | null>(null)
  const editorSessionRef = useRef<{ key: string; prevW: number; lastRect: { key: string; left: number; top: number; w: number; h: number } | null }>({ key: '', prevW: 0, lastRect: null })
  const [it, updateInteraction] = useState<Interaction>(IDLE)
  const itRef = useRef(it)
  const gesture = useRef<ActiveGesture | null>(null)
  const renderedDropRef = useRef<RenderedDrop | null>(null)
  const setIt = useCallback((next: Interaction) => { itRef.current = next; updateInteraction(next) }, [])
  const cancelGesture = useCallback(() => {
    const active = gesture.current
    gesture.current = null
    renderedDropRef.current = null
    setIt(IDLE)
    if (active?.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer)
    setEraseCursor(null)
    setEraseHoverId(null)
  }, [setIt])
  const [mounted, setMounted] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [pendingChoice, setHandleChoice] = useState<{ from: string; to: string; x: number; y: number; generation: number } | null>(null)
  const choiceRef = useRef<HTMLDivElement>(null)
  const [moveBranchMode, setMoveBranchMode] = useState(false)
  /* Eraser (09.4): vị trí cursor + nét sắp xóa khi hover (V35-BR06) */
  const [eraseCursor, setEraseCursor] = useState<Pt | null>(null)
  const [eraseHoverId, setEraseHoverId] = useState<string | null>(null)
  const searchOpen = useApp((s) => s.search.open)
  const [reveal, setReveal] = useState<{ id: string; projectId: string; request: number } | null>(null)
  const revealId = searchOpen && reveal?.projectId === doc?.project_id ? reveal?.id : undefined
  const centeredRequest = useRef<number | undefined>(undefined)
  const generation = useApp(s => s.generation)
  const saveStatus = useApp(s => s.saveStatus)
  const handleChoice = pendingChoice?.generation === generation ? pendingChoice : null
  useLayoutEffect(() => {
    const box = choiceRef.current, canvas = wrapRef.current
    if (!handleChoice || !box || !canvas) return
    const place = () => {
      const p = placeOverlay(handleChoice.x, handleChoice.y, box.offsetWidth, box.offsetHeight, canvas.clientWidth, canvas.clientHeight)
      box.style.left = `${p.left}px`
      box.style.top = `${p.top}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(canvas)
    observer.observe(box)
    return () => observer.disconnect()
  }, [handleChoice])
  useEffect(() => {
    setHandleChoice(null)
  }, [generation])
  useEffect(() => {
    if (!handleChoice) return
    choiceRef.current?.querySelector('button')?.focus()
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      event.stopPropagation()
      setHandleChoice(null)
    }
    const outside = (event: PointerEvent) => {
      if (choiceRef.current && !choiceRef.current.contains(event.target as Node)) {
        setHandleChoice(null)
      }
    }
    window.addEventListener('keydown', dismiss, true)
    window.addEventListener('pointerdown', outside, true)
    return () => {
      window.removeEventListener('keydown', dismiss, true)
      window.removeEventListener('pointerdown', outside, true)
    }
  }, [handleChoice])
  const focusCameraBeforeSearch = useRef<{ generation: number; focusId: string; camera: typeof camera } | null>(null)
  useEffect(() => {
    if (searchOpen) return
    const snapshot = focusCameraBeforeSearch.current
    focusCameraBeforeSearch.current = null
    if (snapshot?.generation === generation && snapshot.focusId === focusRootId) setCamera(snapshot.camera)
    setReveal(null)
  }, [searchOpen, generation, focusRootId, setCamera])
  const showSearchResult = useCallback((id: string | null) => {
    setReveal(previous => id && doc?.project_id ? { id, projectId: doc.project_id, request: (previous?.request ?? centeredRequest.current ?? 0) + 1 } : null)
  }, [doc?.project_id])
  const fittedRef = useRef<number | null>(null)
  const compositionRef = useRef(false)

  useEffect(() => { setMounted(true) }, [])

  /* ---------- kích thước ---------- */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [doc?.project_id])

  /* ---------- scene ---------- */
  const focusIds = useMemo(() => {
    if (!doc || !focusRootId) return null
    const set = new Set<string>([focusRootId])
    descendantsOf(doc, focusRootId).forEach((d) => set.add(d.id))
    return set
  }, [doc, focusRootId])

  const scene: Scene | null = useMemo(() => {
    if (!doc || typeof document === 'undefined') return null
    try {
      if (!revealId) return buildScene(doc, { includeDrawings: true })
      const ancestors = new Set<string>()
      const topics = new Map(doc.topics.map(topic => [topic.id, topic]))
      let id = topics.get(revealId)?.parent_id
      while (id && !ancestors.has(id)) {
        ancestors.add(id)
        id = topics.get(id)?.parent_id
      }
      return buildScene({ ...doc, topics: doc.topics.map(topic => ancestors.has(topic.id) && topic.collapsed ? { ...topic, collapsed: false } : topic) }, { includeDrawings: true })
    } catch (e) {
      console.error('layout error', e)
      return null
    }
  }, [doc, revealId])

  const scene2: Scene | null = useMemo(() => {
    // scene đã lọc focus + sắp z-order ổn định
    if (!scene) return null
    if (!focusIds || (revealId && !focusIds.has(revealId))) return scene
    const nodes = scene.nodes.filter((n) => focusIds.has(n.id))
    const ids = new Set(nodes.map((n) => n.id))
    const edges = scene.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
    const crosslinks = scene.crosslinks.filter((c) => ids.has(c.source) && ids.has(c.target))
    return {
      ...scene,
      nodes,
      edges,
      crosslinks,
      byId: new Map(nodes.map((n) => [n.id, n])),
      // Focus fit/minimap must use the visible subtree, not the whole document.
      // Drawings stay rendered per current behavior but do not expand focus bounds.
      bounds: computeBounds(nodes, edges, [], crosslinks),
    }
  }, [scene, focusIds, revealId])
  const backDrawings = useMemo(() => scene2 ? scene2.drawings.filter((dr) => dr.obj.layer_order < 0) : [], [scene2])
  const frontDrawings = useMemo(() => scene2 ? scene2.drawings.filter((dr) => dr.obj.layer_order >= 0) : [], [scene2])
  const warnedFixedGeneration = useRef<number | null>(null)
  useEffect(() => {
    if (!scene2 || warnedFixedGeneration.current === generation) return
    if (!scene2.nodes.some(n => n.requestedBox && (n.box.w > n.requestedBox.w || n.box.h > n.requestedBox.h))) return
    warnedFixedGeneration.current = generation
    useApp.getState().toast('warn', 'Khung Cố định nhỏ hơn nội dung', 'Đang hiển thị kích thước đủ nội dung; dữ liệu đã lưu chưa bị thay đổi. Xem kích thước tại Inspector → Hình khối.')
  }, [scene2, generation])
  useEffect(() => {
    if (!revealId || !reveal || centeredRequest.current === reveal.request) return
    const node = scene2?.byId.get(revealId)
    if (!node) return
    centeredRequest.current = reveal.request
    const camera = useApp.getState().camera
    if (focusRootId && focusIds && !focusIds.has(revealId)) {
      focusCameraBeforeSearch.current ??= { generation, focusId: focusRootId, camera }
    } else focusCameraBeforeSearch.current = null
    setCamera({ ...camera, x: node.box.x + node.box.w / 2, y: node.box.y + node.box.h / 2 })
  }, [reveal, revealId, scene2, setCamera, focusRootId, focusIds, generation])

  /* ---------- transform ---------- */
  const worldFromScreen = useCallback((sx: number, sy: number): Pt => {
    return {
      x: (sx - size.w / 2) / camera.zoom + camera.x,
      y: (sy - size.h / 2) / camera.zoom + camera.y,
    }
  }, [camera, size])
  const screenFromWorld = useCallback((wx: number, wy: number): Pt => {
    return {
      x: (wx - camera.x) * camera.zoom + size.w / 2,
      y: (wy - camera.y) * camera.zoom + size.h / 2,
    }
  }, [camera, size])

  const titleSessionKey = editor?.field === 'title' && doc ? `${generation}:${editor.nodeId}:title` : ''
  useEffect(() => {
    if (!titleSessionKey) {
      editorSessionRef.current = { key: '', prevW: 0, lastRect: null }
      return
    }
    let alive = true
    void document.fonts?.ready?.then(() => { if (alive) setFontReadyTick((v) => v + 1) })
    const el = titleEditorRef.current
    if (el && document.activeElement !== el) el.focus()
    return () => { alive = false }
  }, [titleSessionKey])
  useLayoutEffect(() => {
    if (!titleSessionKey || !editor || editor.field !== 'title' || !doc || !scene2) return
    if (size.w <= 0 || size.h <= 0) return
    const n = scene2.byId.get(editor.nodeId)
    if (!n) return
    const base = titleEditorBox(n, camera.zoom, size)
    if (editorSessionRef.current.key !== titleSessionKey) {
      editorSessionRef.current = { key: titleSessionKey, prevW: base.w, lastRect: null }
    }
    const fontSizePx = n.textStyle.sizePx * camera.zoom
    const fontStr = `${n.textStyle.italic ? 'italic ' : ''}${n.textStyle.weight} ${fontSizePx}px ${n.textStyle.fontFamily}`

    const lineMirror = document.createElement('div')
    lineMirror.setAttribute('aria-hidden', 'true')
    Object.assign(lineMirror.style, {
      position: 'fixed', left: '-99999px', top: '-99999px', visibility: 'hidden', pointerEvents: 'none',
      boxSizing: 'border-box', whiteSpace: 'pre', font: fontStr, lineHeight: '1.25',
      padding: '6px', border: '2px solid transparent', width: 'max-content',
    })
    lineMirror.textContent = editor.draft.length ? editor.draft : ' '
    document.body.appendChild(lineMirror)
    const desiredW = Math.ceil(lineMirror.getBoundingClientRect().width) + 18
    lineMirror.remove()

    const availableW = Math.max(80, size.w - 2 * base.marginX)
    const w = Math.round(Math.min(availableW, Math.max(base.w, Math.min(360, desiredW), editorSessionRef.current.prevW)))
    editorSessionRef.current.prevW = w

    const taMirror = document.createElement('textarea')
    taMirror.setAttribute('aria-hidden', 'true')
    taMirror.readOnly = true
    taMirror.tabIndex = -1
    Object.assign(taMirror.style, {
      position: 'fixed', left: '-99999px', top: '-99999px', visibility: 'hidden', pointerEvents: 'none',
      boxSizing: 'border-box', resize: 'none', overflowX: 'hidden', overflowY: 'hidden',
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word',
      font: fontStr, lineHeight: '1.25', padding: '6px', border: '2px solid transparent',
      width: `${w}px`, height: '0px', minHeight: '0px',
    })
    taMirror.value = editor.draft
    document.body.appendChild(taMirror)
    const availableH = Math.max(30, size.h - 2 * base.marginY)
    const maxH = Math.min(availableH, Math.max(base.h, Math.floor(availableH * 0.70)))
    let requiredH = Math.ceil(taMirror.scrollHeight + 4)
    if (requiredH > maxH) {
      taMirror.style.overflowY = 'scroll'
      taMirror.style.height = `${maxH}px`
      requiredH = Math.ceil(taMirror.scrollHeight + 4)
    }
    taMirror.remove()

    const h = Math.round(Math.min(maxH, Math.max(base.h, requiredH)))
    const p = screenFromWorld(n.box.x, n.box.y)
    const left = Math.round(Math.max(base.marginX, Math.min(p.x, size.w - base.marginX - w)))
    const top = Math.round(Math.max(base.marginY, Math.min(p.y, size.h - base.marginY - h)))

    const live = titleEditorRef.current
    if (live) {
      live.style.left = `${left}px`
      live.style.top = `${top}px`
      live.style.width = `${w}px`
      live.style.height = `${h}px`
      const maxScrollTop = Math.max(0, live.scrollHeight - live.clientHeight)
      if (live.scrollTop > maxScrollTop) live.scrollTop = maxScrollTop
    }

    const nextRect = { key: titleSessionKey, left, top, w, h }
    const prev = editorSessionRef.current.lastRect
    if (!prev || prev.key !== nextRect.key || prev.left !== nextRect.left || prev.top !== nextRect.top || prev.w !== nextRect.w || prev.h !== nextRect.h) {
      editorSessionRef.current.lastRect = nextRect
      setEditorRect(nextRect)
    }
  }, [titleSessionKey, editor, doc, scene2, camera.x, camera.y, camera.zoom, size, screenFromWorld, fontReadyTick])

  /* Keep the active/edited node inside the visible canvas when panels resize,
   * and keep the inline title editor inside the visible canvas when it opens.
   * Only camera (view state) moves; zoom, text, selection and doc stay untouched. */
  const prevViewportRef = useRef<{ w: number; h: number; generation: number } | null>(null)
  useLayoutEffect(() => {
    if (size.w <= 0 || size.h <= 0 || !scene2) return
    const prev = prevViewportRef.current
    prevViewportRef.current = { w: size.w, h: size.h, generation }
    if (!prev || prev.generation !== generation || (prev.w === size.w && prev.h === size.h)) return
    if (fittedRef.current !== generation) return
    const targetId = editor?.nodeId ?? selection.find((id) => !id.startsWith('drawing:') && !id.startsWith('crosslink:'))
    if (!targetId) return
    const n = scene2.byId.get(targetId)
    if (!n) return
    const cam = useApp.getState().camera
    const marginX = Math.min(16, Math.max(4, (size.w - 40) / 2))
    const marginY = Math.min(16, Math.max(4, (size.h - 40) / 2))
    const px = (n.box.x - cam.x) * cam.zoom + size.w / 2
    const py = (n.box.y - cam.y) * cam.zoom + size.h / 2
    const nw = n.box.w * cam.zoom
    const nh = n.box.h * cam.zoom
    let dx = 0, dy = 0
    if (nw <= size.w - 2 * marginX) {
      if (px < marginX) dx = marginX - px
      else if (px + nw > size.w - marginX) dx = (size.w - marginX) - (px + nw)
    } else {
      if (px + nw < marginX + 40) dx = (marginX + 40) - (px + nw)
      else if (px > size.w - marginX - 40) dx = (size.w - marginX - 40) - px
    }
    if (nh <= size.h - 2 * marginY) {
      if (py < marginY) dy = marginY - py
      else if (py + nh > size.h - marginY) dy = (size.h - marginY) - (py + nh)
    } else {
      if (py + nh < marginY + 24) dy = (marginY + 24) - (py + nh)
      else if (py > size.h - marginY - 24) dy = (size.h - marginY - 24) - py
    }
    if (dx || dy) setCamera({ ...cam, x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom })
  }, [size.w, size.h, generation, scene2, editor?.nodeId, selection, setCamera])

  const editorPanKey = useRef('')
  useLayoutEffect(() => { editorPanKey.current = '' }, [generation, editor?.nodeId, editor?.field])
  useLayoutEffect(() => {
    if (!editor || editor.field !== 'title' || !scene2 || size.w <= 0 || size.h <= 0) return
    const n = scene2.byId.get(editor.nodeId)
    if (!n) return
    const key = `${editor.nodeId}|${size.w}|${size.h}`
    if (editorPanKey.current === key) return
    editorPanKey.current = key
    const { w, h, marginX, marginY } = titleEditorBox(n, camera.zoom, size)
    const p = screenFromWorld(n.box.x, n.box.y)
    let dx = 0, dy = 0
    if (p.x < marginX) dx = marginX - p.x
    else if (p.x + w > size.w - marginX) dx = size.w - marginX - (p.x + w)
    if (p.y < marginY) dy = marginY - p.y
    else if (p.y + h > size.h - marginY) dy = size.h - marginY - (p.y + h)
    if (dx || dy) setCamera({ ...camera, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom })
  }, [editor?.nodeId, editor?.field, size.w, size.h, scene2, camera, screenFromWorld, setCamera])

  /* ---------- fit ---------- */
  const fitAll = useCallback((ids?: string[]) => {
    if (!scene2 || !scene2.nodes.length) return
    let b = scene2.bounds
    if (ids && ids.length) {
      const sel = scene2.nodes.filter((n) => ids.includes(n.id))
      if (sel.length) {
        const x1 = Math.min(...sel.map((n) => n.box.x)), y1 = Math.min(...sel.map((n) => n.box.y))
        const x2 = Math.max(...sel.map((n) => n.box.x + n.box.w)), y2 = Math.max(...sel.map((n) => n.box.y + n.box.h))
        b = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
      }
    }
    const zoom = clampZoom(Math.min(1, Math.min((size.w - 80) / Math.max(40, b.w), (size.h - 80) / Math.max(40, b.h))))
    setCamera({ x: b.x + b.w / 2, y: b.y + b.h / 2, zoom })
  }, [scene2, size, setCamera])

  useEffect(() => {
    if (fittedRef.current === generation || !doc || !scene2?.nodes.length || !wrapRef.current?.clientWidth || !wrapRef.current.clientHeight) return
    fittedRef.current = generation
    const session = loadSession(doc.project_id)?.camera
    if (!session || ![session.x, session.y, session.zoom].every(Number.isFinite) || session.zoom < 0.1 || session.zoom > 4) fitAll()
  }, [doc, scene2, generation, fitAll])

  /* ---------- hit testing ---------- */
  const hitNode = useCallback((w: Pt): SceneNode | null => {
    if (!scene2) return null
    for (let i = scene2.nodes.length - 1; i >= 0; i--) {
      const n = scene2.nodes[i]
      if (w.x >= n.box.x && w.x <= n.box.x + n.box.w && w.y >= n.box.y && w.y <= n.box.y + n.box.h) return n
    }
    return null
  }, [scene2])

  const hitDrawing = useCallback((w: Pt, layer?: 'front' | 'back'): string | null => {
    if (!scene2) return null
    const tol = 10 / camera.zoom
    for (let i = scene2.drawings.length - 1; i >= 0; i--) {
      const dr = scene2.drawings[i]
      if (layer === 'front' && dr.obj.layer_order < 0) continue
      if (layer === 'back' && dr.obj.layer_order >= 0) continue
      const hw = dr.obj.width_world / 2 + tol
      if (drawingFillHit(dr.obj, w) || drawingHitsDisc(dr.obj, w, hw)) return dr.obj.id
    }
    return null
  }, [scene2, camera.zoom])

  /* Hit test đĩa Tẩy (SET-C16): một nét bị "chạm" khi bất kỳ đoạn nào của nó
     đi qua trong bán kính R (tính cả độ dày nét). Xét cả đoạn nối, không chỉ
     điểm mẫu — trước đây chỉ xét điểm rời khiến Tẩy gần như luôn hụt (09.4). */
  const hitDrawingsDisc = useCallback((w: Pt, radius: number): string[] => {
    if (!scene2) return []
    const ids: string[] = []
    for (let i = scene2.drawings.length - 1; i >= 0; i--) {
      const dr = scene2.drawings[i]
      const hw = radius + dr.obj.width_world / 2
      if (drawingHitsDisc(dr.obj, w, hw)) ids.push(dr.obj.id)
    }
    return ids
  }, [scene2])

  const hitCrosslinkLabel = useCallback((w: Pt): Crosslink | null => {
    if (!scene2 || !doc) return null
    const pad = 3 / camera.zoom
    for (let i = scene2.crosslinks.length - 1; i >= 0; i--) {
      const c = scene2.crosslinks[i]
      if (c.labelBox && w.x >= c.labelBox.x - pad && w.x <= c.labelBox.x + c.labelBox.w + pad
        && w.y >= c.labelBox.y - pad && w.y <= c.labelBox.y + c.labelBox.h + pad) {
        return doc.crosslinks.find((cc) => cc.id === c.id) ?? null
      }
    }
    return null
  }, [scene2, doc, camera.zoom])

  const hitCrosslinkPath = useCallback((w: Pt): Crosslink | null => {
    if (!scene2 || !doc) return null
    const maxErrWorld = 0.5 / camera.zoom
    for (let i = scene2.crosslinks.length - 1; i >= 0; i--) {
      const c = scene2.crosslinks[i]
      const tol = Math.max(8 / camera.zoom, c.width / 2 + 4 / camera.zoom)
      const ddx = c.p1.x - 2 * c.ctrl.x + c.p2.x
      const ddy = c.p1.y - 2 * c.ctrl.y + c.p2.y
      const steps = Math.max(24, Math.min(256, Math.ceil(Math.sqrt(Math.hypot(ddx, ddy) / Math.max(1e-4, 4 * maxErrWorld)))))
      let prev = c.p1
      for (let s = 1; s <= steps; s++) {
        const k = s / steps
        const curPt = {
          x: (1 - k) * (1 - k) * c.p1.x + 2 * (1 - k) * k * c.ctrl.x + k * k * c.p2.x,
          y: (1 - k) * (1 - k) * c.p1.y + 2 * (1 - k) * k * c.ctrl.y + k * k * c.p2.y,
        }
        if (distPointToSegment(w, prev, curPt) <= tol) {
          return doc.crosslinks.find((cc) => cc.id === c.id) ?? null
        }
        prev = curPt
      }
    }
    return null
  }, [scene2, doc, camera.zoom])

  const hitCrosslink = useCallback((w: Pt): Crosslink | null => {
    return hitCrosslinkLabel(w) ?? hitCrosslinkPath(w)
  }, [hitCrosslinkLabel, hitCrosslinkPath])

  const isCanvasPointActive = useCallback((clientX: number, clientY: number): boolean => {
    const wrap = wrapRef.current
    if (!wrap) return false
    const rect = wrap.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false
    if (typeof document === 'undefined' || !document.elementFromPoint) return true
    const hitEl = document.elementFromPoint(clientX, clientY)
    if (!hitEl || !wrap.contains(hitEl)) return false
    return !hitEl.closest('[data-omm-control], [data-omm-draw-toolbar], [role="menu"], [role="dialog"], [role="region"], aside, header, button, input, select, textarea, a')
  }, [])

  /* ---------- DnD helpers (07.2 + DETACH) ---------- */
  const computeAutoDrop = useCallback((
    w: Pt,
    sourceIds: string[],
    opts: { startClient: Pt; pointerClient: Pt; inActiveCanvas: boolean; balancedStartSide: 'left' | 'right' | null; zoom?: number },
  ) => {
    if (!doc || !scene2) {
      return { intent: 'invalid' as const, target: null, line: null, parentId: null, index: -1, msg: '', dragDistCss: 0, minTargetDistCss: 0 }
    }
    const overObstacle = Boolean(hitDrawing(w, 'front') || hitCrosslink(w) || hitDrawing(w, 'back'))
    return classifyAutoDragTarget({
      doc,
      scene: scene2,
      sourceIds,
      startClient: opts.startClient,
      pointerClient: opts.pointerClient,
      pointerWorld: w,
      zoom: opts.zoom ?? camera.zoom,
      inActiveCanvas: opts.inActiveCanvas,
      balancedStartSide: opts.balancedStartSide,
      hoveredNode: hitNode(w),
      overCanvasObstacle: overObstacle,
    })
  }, [doc, scene2, hitNode, hitDrawing, hitCrosslink, camera.zoom])

  /* ---------- pointer handlers ---------- */
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest?.('[data-omm-control], [role="menu"], button, input, select, textarea, a')) return
    if (useApp.getState().editor && !useApp.getState().commitEdit()) return
    if (menu) setMenu(null)
    if (handleChoice) { setHandleChoice(null); return }
    if ((e.button !== 0 && e.button !== 1) || gesture.current) return
    const target = wrapRef.current!
    target.focus({ preventScroll: true })
    const rect = target.getBoundingClientRect()
    const camNow = useApp.getState().camera
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
    const w = {
      x: (sx - sizeRef.current.w / 2) / camNow.zoom + camNow.x,
      y: (sy - sizeRef.current.h / 2) / camNow.zoom + camNow.y,
    }
    const startClient = { x: e.clientX, y: e.clientY }
    const base: Interaction = {
      ...IDLE,
      startScreen: { x: sx, y: sy },
      startClient,
      startWorld: w,
      startCamera: camNow,
      pointerWorld: w,
      pointerScreen: { x: sx, y: sy },
      pointerClient: startClient,
      spaceHeld,
    }
    gesture.current = {
      pointer: e.pointerId,
      doc,
      generation,
      layoutKind: doc?.layout.kind ?? null,
      target: e.target as Element,
      rootId: null,
      dragOriginId: null,
      startBox: null,
      startWorld: w,
    }
    renderedDropRef.current = null
    // Preserve the actual click target for canvas controls while capturing.
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    if (e.button === 1 || spaceHeld) {
      setIt({ ...base, kind: 'pan' })
      return
    }

    // resize handles (fixed size, freeform)
    if (tool === 'select' && doc?.layout.kind === 'freeform' && selection.length === 1) {
      const n = scene2?.byId.get(selection[0])
      if (n && n.shape && getTopic(doc, n.id)?.style.box_style?.size_mode === 'fixed') {
        const hs = 8 / camera.zoom
        const corners = [
          { x: n.box.x + n.box.w, y: n.box.y + n.box.h },
        ]
        for (const c of corners) {
          if (Math.abs(w.x - c.x) < hs && Math.abs(w.y - c.y) < hs) {
            setIt({ ...base, kind: 'resize', resizeId: n.id, resizeStart: { w: n.box.w, h: n.box.h } })
            return
          }
        }
      }
    }

    // drawing tools
    if (drawMode && tool !== 'select' && tool !== 'eraser') {
      setIt({ ...base, kind: tool === 'pen' || tool === 'highlighter' ? 'stroke' : 'shape', livePoints: [w] })
      return
    }
    if (drawMode && tool === 'eraser') {
      // 09.4: sweep/click gom MỘT transaction — chỉ đánh dấu ở đây,
      // commit duy nhất ở pointer-up (một Undo cho cả sweep, V35-BR07).
      const hits = hitDrawingsDisc(w, settings.eraserRadius)
      setIt({ ...base, kind: 'erase', ids: hits })
      setEraseCursor(w)
      return
    }

    const connector = !drawMode ? scene2?.byId.get(hoverId ?? selection[0]) : undefined
    const cenBoxDown = doc && scene2 ? scene2.byId.get(doc.central_topic_id)?.box : null
    const handlePt = connector ? connectorHandleOf(connector, camera.zoom, doc?.layout.kind, doc?.layout.direction, cenBoxDown) : null
    const handleOwner = connector && handlePt && Math.hypot(w.x - handlePt.x, w.y - handlePt.y) <= Math.max(handlePt.r + 2 / camera.zoom, 6 / camera.zoom) ? connector.id : null
    if (handleOwner) {
      setIt({ ...base, kind: 'handle', crosslinkFrom: handleOwner })
      return
    }

    // Painter's z-order hit-testing:
    // 1. front drawings (layer_order >= 0), 2. crosslink labels, 3. nodes, 4. crosslink paths, 5. back drawings (layer_order < 0)
    const frontDr = hitDrawing(w, 'front')
    if (frontDr) {
      setSelection(['drawing:' + frontDr])
      setIt({ ...base, kind: 'none' })
      return
    }
    const labelCl = hitCrosslinkLabel(w)
    if (labelCl) {
      setSelection(['crosslink:' + labelCl.id])
      setIt({ ...base, kind: 'none' })
      return
    }
    const hoveredNode = hitNode(w)
    if (hoveredNode) {
      toggleSelection(hoveredNode.id, e.shiftKey || e.ctrlKey || e.metaKey)
      let ids = selection.includes(hoveredNode.id) && selection.length > 1 && !e.shiftKey ? selection.filter(id => !!getTopic(doc!, id)) : [hoveredNode.id]
      if (doc?.layout.kind === 'freeform' && moveBranchMode) ids = [...new Set(ids.flatMap(id => [id, ...descendantsOf(doc, id).map(t => t.id)]))]
      if (doc && doc.layout.kind !== 'freeform') {
        const selected = ids
        ids = selected.filter(id => !selected.some(parent => id !== parent && isDescendantOrSelf(doc, parent, id)))
        if (ids.includes(doc.central_topic_id) || new Set(ids.map(id => getTopic(doc, id)?.parent_id)).size > 1) return
        ids.sort((a, b) => getTopic(doc, a)!.order - getTopic(doc, b)!.order)
      }
      const origins = new Map<string, Pt>()
      ids.forEach((id) => {
        const b = scene2?.layoutResult.pos.get(id)
        if (b) origins.set(id, { x: b.x, y: b.y })
      })
      let balancedStartSide: 'left' | 'right' | null = null
      if (doc && doc.layout.kind === 'balanced' && ids.length === 1) {
        const central = scene2?.byId.get(doc.central_topic_id)
        const srcNode = scene2?.byId.get(ids[0])
        if (central && srcNode && getTopic(doc, ids[0])?.parent_id === doc.central_topic_id) {
          balancedStartSide = (srcNode.box.x + srcNode.box.w / 2 < central.box.x + central.box.w / 2) ? 'left' : 'right'
        }
      }
      const b0Node = ids[0] ? scene2?.byId.get(ids[0]) : undefined
      const startBox = b0Node ? { x: b0Node.box.x, y: b0Node.box.y } : (ids[0] ? origins.get(ids[0]) ?? null : null)
      if (gesture.current) {
        gesture.current.rootId = ids[0] ?? null
        gesture.current.dragOriginId = hoveredNode.id
        gesture.current.startBox = startBox ? { x: startBox.x, y: startBox.y } : null
      }
      setIt({ ...base, kind: 'node', ids, originBoxes: origins, balancedStartSide })
      return
    }
    const pathCl = hitCrosslinkPath(w)
    if (pathCl) {
      setSelection(['crosslink:' + pathCl.id])
      setIt({ ...base, kind: 'none' })
      return
    }
    const backDr = hitDrawing(w, 'back')
    if (backDr) {
      setSelection(['drawing:' + backDr])
      setIt({ ...base, kind: 'none' })
      return
    }
    // blank
    setSelection([])
    setIt({ ...base, kind: 'marquee' })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (gesture.current && e.pointerId !== gesture.current.pointer) return
    const rect = wrapRef.current!.getBoundingClientRect()
    updatePointer(e.clientX - rect.left, e.clientY - rect.top, e.shiftKey, e.clientX, e.clientY)
  }
  const updatePointer = (sx: number, sy: number, shift = false, clientX?: number, clientY?: number) => {
    const active = gesture.current
    const appSt = useApp.getState()
    if (active && (!appSt.doc || appSt.doc !== active.doc || appSt.generation !== active.generation
      || appSt.doc.layout.kind !== active.layoutKind || appSt.saveStatus === 'conflict'
      || appSt.transitionBusy || appSt.leavePrompt)) {
      cancelGesture()
      return
    }
    const cur = itRef.current
    const rect = wrapRef.current?.getBoundingClientRect()
    const cx = clientX ?? (rect ? rect.left + sx : sx)
    const cy = clientY ?? (rect ? rect.top + sy : sy)
    const cam = appSt.camera
    const w = { x: (sx - sizeRef.current.w / 2) / cam.zoom + cam.x, y: (sy - sizeRef.current.h / 2) / cam.zoom + cam.y }
    const moved = cur.moved || Math.hypot(cx - cur.startClient.x, cy - cur.startClient.y) > 5

    // hover: với Eraser, cursor highlight nét vẽ (V35-BR06) thay vì node
    if (drawMode && tool === 'eraser') {
      setEraseCursor(w)
      setEraseHoverId(cur.kind === 'none' ? (hitDrawingsDisc(w, settings.eraserRadius)[0] ?? null) : null)
    } else if (eraseCursor) {
      setEraseCursor(null)
      setEraseHoverId(null)
    }

    // hover (giữ hover khi di chuột từ node chưa chọn sang handle nối chéo)
    if (cur.kind === 'none' || cur.kind === 'marquee') {
      let nextHover = hitNode(w)?.id ?? null
      if (!nextHover && hoverId && !drawMode) {
        const prevNode = scene2?.byId.get(hoverId)
        if (prevNode) {
          const cenBoxHover = doc && scene2 ? scene2.byId.get(doc.central_topic_id)?.box : null
          const hp = connectorHandleOf(prevNode, cam.zoom, doc?.layout.kind, doc?.layout.direction, cenBoxHover)
          const corridorY = Math.max(8 / cam.zoom, prevNode.box.h / 2 + 4 / cam.zoom)
          const cy = prevNode.box.y + prevNode.box.h / 2
          if (w.x >= prevNode.box.x + prevNode.box.w - 4 / cam.zoom && w.x <= hp.x + hp.r + 8 / cam.zoom
            && w.y >= cy - corridorY && w.y <= cy + corridorY) {
            nextHover = hoverId
          }
        }
      }
      if (nextHover !== hoverId) setHover(nextHover)
    }

    switch (cur.kind) {
      case 'pan':
        setCamera({
          x: cur.startCamera.x - (sx - cur.startScreen.x) / camera.zoom,
          y: cur.startCamera.y - (sy - cur.startScreen.y) / camera.zoom,
          zoom: camera.zoom,
        })
        return
      case 'node': {
        if (!moved) return
        if (doc?.layout.kind === 'freeform') {
          let nx = w.x - cur.startWorld.x, ny = w.y - cur.startWorld.y
          // snap guides
          let gv: number | null = null, gh: number | null = null
          const moved0 = cur.originBoxes.get(cur.ids[0])
          if (moved0 && snapOn) {
            const sp = settings.gridSpacing
            nx = Math.round((moved0.x + nx) / sp) * sp - moved0.x
            ny = Math.round((moved0.y + ny) / sp) * sp - moved0.y
          } else if (moved0) {
            // snap to node centers
            for (const n of scene2!.nodes) {
              if (cur.ids.includes(n.id)) continue
              const cx = n.box.x + n.box.w / 2, cy = n.box.y + n.box.h / 2
              const myCx = moved0.x + nx + (scene2!.byId.get(cur.ids[0])?.box.w ?? 0) / 2
              const myCy = moved0.y + ny + (scene2!.byId.get(cur.ids[0])?.box.h ?? 0) / 2
              if (Math.abs(myCx - cx) < 6 / camera.zoom) { nx = cx - (scene2!.byId.get(cur.ids[0])?.box.w ?? 0) / 2 - moved0.x; gv = cx }
              if (Math.abs(myCy - cy) < 6 / camera.zoom) { ny = cy - (scene2!.byId.get(cur.ids[0])?.box.h ?? 0) / 2 - moved0.y; gh = cy }
            }
          }
          setIt({ ...cur, moved, pointerWorld: w, guides: { vertical: gv, horizontal: gh }, intent: 'move', delta: { x: nx, y: ny }, pointerScreen: { x: sx, y: sy }, pointerClient: { x: cx, y: cy } })
          return
        }
        const drop = computeAutoDrop(w, cur.ids, {
          startClient: cur.startClient,
          pointerClient: { x: cx, y: cy },
          inActiveCanvas: isCanvasPointActive(cx, cy),
          balancedStartSide: cur.balancedStartSide,
          zoom: cam.zoom,
        })
        if (!matchesRenderedDrop(renderedDropRef.current, gesture.current, drop)) renderedDropRef.current = null
        setIt({ ...cur, moved, pointerWorld: w, pointerScreen: { x: sx, y: sy }, pointerClient: { x: cx, y: cy }, dropTargetId: drop.target, intent: drop.intent, insertLine: drop.line, insertParentId: drop.parentId, insertIndex: drop.index, invalidMsg: drop.msg })
        return
      }
      case 'handle': {
        setIt({ ...cur, moved, pointerWorld: w, pointerScreen: { x: sx, y: sy } })
        return
      }
      case 'stroke': {
        const pts = cur.livePoints
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(w.x - last.x, w.y - last.y) > 2 / camera.zoom) {
          setIt({ ...cur, moved, livePoints: [...pts, w] })
        }
        return
      }
      case 'shape': {
        let end = w
        if (shift) {
          const dx = w.x - cur.startWorld.x, dy = w.y - cur.startWorld.y
          if (tool === 'line') {
            const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
            const radius = Math.hypot(dx, dy)
            end = { x: cur.startWorld.x + radius * Math.cos(angle), y: cur.startWorld.y + radius * Math.sin(angle) }
          } else {
            const length = Math.max(Math.abs(dx), Math.abs(dy))
            end = { x: cur.startWorld.x + (dx < 0 ? -length : length), y: cur.startWorld.y + (dy < 0 ? -length : length) }
          }
        }
        setIt({ ...cur, moved, pointerScreen: { x: sx, y: sy }, livePoints: [cur.startWorld, end] })
        return
      }
      case 'erase': {
        // quét tiếp: gom thêm nét chạm đĩa tẩy (chưa commit)
        const hits = hitDrawingsDisc(w, settings.eraserRadius)
        const merged = [...cur.ids]
        for (const h of hits) if (!merged.includes(h)) merged.push(h)
        setEraseCursor(w)
        setIt({ ...cur, moved, ids: merged })
        return
      }
      case 'resize': {
        if (!cur.resizeStart) return
        let resizeNext = {
          w: Math.min(1200, Math.max(32, cur.resizeStart.w + w.x - cur.startWorld.x)),
          h: Math.min(800, Math.max(24, cur.resizeStart.h + w.y - cur.startWorld.y)),
        }
        const topic = doc && cur.resizeId ? getTopic(doc, cur.resizeId) : null
        if (topic && doc) {
          const st = resolveStyle(doc, topic)
          const measured = measureNodeContent(doc, topic, { ...st, box: { ...st.box, sizeMode: 'fixed', width: resizeNext.w, height: resizeNext.h } }, scene2?.byId.get(topic.id)?.numbering?.text)
          resizeNext = { w: measured.w, h: measured.h }
        }
        const invalidMsg = resizeNext.w > 1200 || resizeNext.h > 800 ? 'Nội dung vượt kích thước Cố định tối đa 1200 × 800.' : ''
        setIt({ ...cur, moved, pointerWorld: w, resizeNext: invalidMsg ? undefined : resizeNext, invalidMsg })
        return
      }
      case 'marquee': {
        setIt({ ...cur, moved, pointerWorld: w })
        return
      }
      default:
        return
    }
  }

  const pointerUpdate = useRef(updatePointer)
  useEffect(() => { pointerUpdate.current = updatePointer })
  useEffect(() => {
    if (it.kind !== 'node' || !it.moved) return
    let frame: number
    let previous = 0
    const tick = (time: number) => {
      const dt = Math.min(32, time - (previous || time)) / 16
      previous = time
      const wrap = wrapRef.current
      const cur = itRef.current
      if (!wrap || !gesture.current || cur.kind !== 'node') return
      const { x, y } = cur.pointerScreen
      const rect = wrap.getBoundingClientRect()
      const hit = document.elementFromPoint(x + rect.left, y + rect.top)
      if (hit && wrap.contains(hit) && !hit.closest('[data-omm-control], [data-omm-draw-toolbar], [role="menu"], [role="dialog"], [role="region"], aside, header, button, input, select, textarea, a')) {
        const velocity = (v: number, max: number) => v < 32 ? (v - 32) * 0.5 : v > max - 32 ? (v - max + 32) * 0.5 : 0
        const dx = velocity(x, rect.width), dy = velocity(y, rect.height)
        if (dx || dy) {
          const cam = useApp.getState().camera
          setCamera({ ...cam, x: cam.x + dx * dt / cam.zoom, y: cam.y + dy * dt / cam.zoom })
          pointerUpdate.current(x, y, false, rect.left + x, rect.top + y)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [it.kind, it.moved, setCamera])
  useLayoutEffect(() => {
    const cur = it
    const active = gesture.current
    if (cur.kind === 'node' && cur.moved && active && cur.ids.length === 1) {
      if (cur.intent === 'detach') {
        renderedDropRef.current = { pointer: active.pointer, doc: active.doc, generation: active.generation, layoutKind: active.layoutKind, rootId: cur.ids[0], intent: 'detach' }
        return
      }
      if (cur.intent === 'reparent' && cur.dropTargetId) {
        renderedDropRef.current = { pointer: active.pointer, doc: active.doc, generation: active.generation, layoutKind: active.layoutKind, rootId: cur.ids[0], intent: 'reparent', targetId: cur.dropTargetId }
        return
      }
      if (cur.intent === 'reorder' && cur.insertParentId !== null) {
        renderedDropRef.current = { pointer: active.pointer, doc: active.doc, generation: active.generation, layoutKind: active.layoutKind, rootId: cur.ids[0], intent: 'reorder', parentId: cur.insertParentId, index: cur.insertIndex }
        return
      }
    }
    renderedDropRef.current = null
  }, [it])
  useEffect(() => {
    const active = gesture.current
    if (!active) return
    if (
      active.doc !== doc
      || active.generation !== generation
      || active.layoutKind !== (doc?.layout.kind ?? null)
      || saveStatus === 'conflict'
      || tool !== 'select'
      || drawMode
    ) {
      cancelGesture()
    }
  }, [doc, doc?.layout.kind, generation, saveStatus, tool, drawMode, cancelGesture])

  const onPointerUp = (e: React.PointerEvent) => {
    const active = gesture.current
    if (!active || e.pointerId !== active.pointer) return
    const renderedDrop = renderedDropRef.current
    if (itRef.current.kind !== 'node' && (itRef.current.moved || itRef.current.kind === 'shape')) onPointerMove(e)
    const cur = itRef.current
    const rect = wrapRef.current?.getBoundingClientRect()
    const cam = useApp.getState().camera
    const sxUp = rect ? e.clientX - rect.left : cur.pointerScreen.x
    const syUp = rect ? e.clientY - rect.top : cur.pointerScreen.y
    const wUp = { x: (sxUp - sizeRef.current.w / 2) / cam.zoom + cam.x, y: (syUp - sizeRef.current.h / 2) / cam.zoom + cam.y }
    const movedUp = cur.moved || Math.hypot(e.clientX - cur.startClient.x, e.clientY - cur.startClient.y) > 5
    const finalAutoDrop = cur.kind === 'node' && movedUp && doc && doc.layout.kind !== 'freeform'
      ? computeAutoDrop(wUp, cur.ids, {
          startClient: cur.startClient,
          pointerClient: { x: e.clientX, y: e.clientY },
          inActiveCanvas: isCanvasPointActive(e.clientX, e.clientY),
          balancedStartSide: cur.balancedStartSide,
          zoom: cam.zoom,
        })
      : null
    cancelGesture()
    const appSt = useApp.getState()
    if (!doc || appSt.doc !== active.doc || appSt.generation !== active.generation || doc.layout.kind !== active.layoutKind || appSt.transitionBusy || appSt.leavePrompt || appSt.saveStatus === 'conflict') return
    switch (cur.kind) {
      case 'node': {
        if (!movedUp) return
        if (doc.layout.kind === 'freeform') {
          const nx = cur.delta ? cur.delta.x : wUp.x - cur.startWorld.x
          const ny = cur.delta ? cur.delta.y : wUp.y - cur.startWorld.y
          const delta = cur.delta ?? { x: nx, y: ny }
          if (!delta || (!delta.x && !delta.y)) return
          const items = cur.ids.flatMap(id => {
            const from = cur.originBoxes.get(id)
            return from ? [{ id, from, to: { x: from.x + delta.x, y: from.y + delta.y } }] : []
          })
          if (!items.length) return
          dispatch({ type: 'moveFreeform', items }, cur.ids.length > 1 ? 'Di chuyển các node' : 'Di chuyển node')
          return
        }
        // auto layout
        const drop = finalAutoDrop!
        const srcId = cur.ids[0]
        const srcTopic = cur.ids.length === 1 && srcId ? getTopic(doc, srcId) : undefined
        const isSingleFloatingDrag = Boolean(
          srcTopic
          && srcTopic.role === 'floating'
          && srcTopic.parent_id === null
          && srcTopic.id !== doc.central_topic_id
          && active.dragOriginId === srcTopic.id,
        )
        const targetPos = active.startBox && Number.isFinite(wUp.x) && Number.isFinite(wUp.y)
          ? { x: active.startBox.x + (wUp.x - active.startWorld.x), y: active.startBox.y + (wUp.y - active.startWorld.y) }
          : null
        if (drop.intent === 'reparent' && drop.target) {
          if (isSingleFloatingDrag && !matchesRenderedDrop(renderedDrop, active, drop)) return
          const items = cur.ids.map((id) => {
            const t = getTopic(doc, id)!
            return { id, oldParentId: t.parent_id, oldOrder: t.order, newParentId: drop.target!, newOrder: 9999 }
          })
          dispatch({ type: 'reparent', items }, 'Chuyển cha')
        } else if (drop.intent === 'reorder' && drop.parentId !== null) {
          if (isSingleFloatingDrag && !matchesRenderedDrop(renderedDrop, active, drop)) return
          const parent = drop.parentId
          const siblings = childrenOf(doc, parent).filter(t => !cur.ids.includes(t.id)).map(t => t.id)
          siblings.splice(drop.index, 0, ...cur.ids)
          const items = siblings.flatMap((id, index) => {
            const t = getTopic(doc, id)!
            return t.parent_id !== parent || t.order !== index
              ? [{ id, oldParentId: t.parent_id, oldOrder: t.order, newParentId: parent, newOrder: index }] : []
          })
          if (!items.length) return
          dispatch({ type: 'reparent', items }, 'Sắp xếp lại thứ tự')
        } else if (drop.intent === 'side' && drop.target) {
          const side = drop.index === -2 ? 'left' : 'right'
          const t = getTopic(doc, drop.target)
          if (t) dispatch({ type: 'setProps', id: drop.target, before: { branch_side: t.branch_side }, after: { branch_side: side } }, `Gán nhánh bên ${side === 'left' ? 'trái' : 'phải'}`)
        } else if (drop.intent === 'detach') {
          if (!matchesRenderedDrop(renderedDrop, active, drop) || cur.ids.length !== 1 || !targetPos || !Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) return
          const cmd = cmdBuilders.detachToFloating(doc, cur.ids[0], targetPos)
          if (cmd) dispatch(cmd, 'Tách thành chủ đề nổi')
        } else if (drop.intent === 'move') {
          if (!isSingleFloatingDrag || !targetPos || !Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y)) return
          const roundScene = (v: number) => Math.round(v * 100) / 100
          if (active.startBox && Math.abs(roundScene(targetPos.x) - roundScene(active.startBox.x)) < 1e-6 && Math.abs(roundScene(targetPos.y) - roundScene(active.startBox.y)) < 1e-6) {
            return
          }
          const fromPos = srcTopic!.manual_position ? { x: srcTopic!.manual_position.x, y: srcTopic!.manual_position.y } : null
          dispatch({ type: 'moveFreeform', items: [{ id: srcTopic!.id, from: fromPos, to: targetPos }] }, 'Di chuyển chủ đề nổi')
        } else if (drop.intent === 'cancel') {
          return
        } else if (drop.msg) {
          toast('warn', 'Không thể thả', drop.msg)
        }
        return
      }
      case 'handle': {
        if (!cur.moved || !cur.crosslinkFrom) return
        const target = hitNode(cur.pointerWorld)
        if (!target || target.id === cur.crosslinkFrom) return
        if (doc.layout.kind === 'freeform') {
          setHandleChoice({ from: cur.crosslinkFrom, to: target.id, x: cur.pointerScreen.x, y: cur.pointerScreen.y, generation })
          return
        }
        dispatch({ type: 'addCrosslink', crosslink: { id: uuid(), source: cur.crosslinkFrom, target: target.id, arrow_end: true } }, 'Nối chéo')
        return
      }
      case 'erase': {
        // 09.4/V35-BR07: toàn bộ nét chạm trong 1 lần quét = MỘT lệnh removeDrawings
        // = MỘT bước Undo. Chỉ xóa nét vẽ, không bao giờ đụng node/edge/crosslink.
        setEraseCursor(null)
        setEraseHoverId(null)
        if (cur.ids.length) {
          const fresh = useApp.getState().doc
          const removed = fresh ? fresh.drawings.filter((d) => cur.ids.includes(d.id)) : []
          if (removed.length) dispatch({ type: 'removeDrawings', drawings: removed }, 'Xóa nét vẽ')
        }
        return
      }
      case 'stroke': {
        if (cur.livePoints.length < 2) return
        const obj: DrawingObject = {
          id: uuid(),
          kind: tool === 'pen' ? 'pen' : 'highlighter',
          points: cur.livePoints,
          color: brush.color,
          width_world: tool === 'highlighter' ? Math.max(10, brush.width * 4) : brush.width,
          opacity: tool === 'highlighter' ? 0.35 : 0.95,
          layer_order: (doc.drawings.reduce((a, d) => Math.max(a, d.layer_order), 0) ?? 0) + 1,
        }
        dispatch({ type: 'addDrawing', drawing: obj }, 'Vẽ')
        return
      }
      case 'shape': {
        const [p1, p2] = [cur.livePoints[0], cur.livePoints[cur.livePoints.length - 1]]
        if (!p1 || !p2 || Math.hypot(p2.x - p1.x, p2.y - p1.y) < 4 / camera.zoom) return
        const obj: DrawingObject = {
          id: uuid(),
          kind: tool as 'line' | 'rect' | 'ellipse',
          points: [p1, p2],
          color: brush.color,
          width_world: brush.width,
          opacity: 0.95,
          fill: null,
          layer_order: (doc.drawings.reduce((a, d) => Math.max(a, d.layer_order), 0) ?? 0) + 1,
        }
        dispatch({ type: 'addDrawing', drawing: obj }, 'Vẽ hình')
        return
      }
      case 'resize': {
        if (!cur.moved || !cur.resizeId) return
        if (cur.invalidMsg) { toast('warn', 'Không thể đổi kích thước', cur.invalidMsg); return }
        const next = cur.resizeNext
        if (!next || (next.w === cur.resizeStart?.w && next.h === cur.resizeStart?.h)) return
        dispatch({ type: 'setBoxStyle', ids: [cur.resizeId], before: {}, after: { size_mode: 'fixed', width_world: next.w, height_world: next.h } }, 'Đổi kích thước node')
        return
      }
      case 'marquee': {
        if (!cur.moved) return
        const x1 = Math.min(cur.startWorld.x, cur.pointerWorld.x), x2 = Math.max(cur.startWorld.x, cur.pointerWorld.x)
        const y1 = Math.min(cur.startWorld.y, cur.pointerWorld.y), y2 = Math.max(cur.startWorld.y, cur.pointerWorld.y)
        const ids = (scene2?.nodes ?? []).filter((n) => n.box.x + n.box.w > x1 && n.box.x < x2 && n.box.y + n.box.h > y1 && n.box.y < y2).map((n) => n.id)
        setSelection(ids)
        return
      }
      default:
        return
    }
  }

  /* wheel: đăng ký phi-passive qua addEventListener — React gắn wheel passive
   * nên e.preventDefault() cũ không có tác dụng => trình duyệt zoom cả trang
   * song song với zoom canvas (Ctrl+wheel). Logic giữ nguyên. */
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheelNative = (e: WheelEvent) => {
      const targetEl = e.target as HTMLElement | null
      if (targetEl && titleEditorRef.current && (targetEl === titleEditorRef.current || titleEditorRef.current.contains(targetEl)) && !(e.ctrlKey || e.metaKey)) {
        return
      }
      const st = useApp.getState()
      const cam = st.camera
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const factor = Math.exp(-e.deltaY * 0.0022)
        const nz = clampZoom(cam.zoom * factor)
        const rect = el.getBoundingClientRect()
        const sx = e.clientX - rect.left - sizeRef.current.w / 2
        const sy = e.clientY - rect.top - sizeRef.current.h / 2
        const wx = cam.x + sx / cam.zoom
        const wy = cam.y + sy / cam.zoom
        st.setCamera({ x: wx - sx / nz, y: wy - sy / nz, zoom: nz })
      } else {
        st.setCamera({ ...cam, x: cam.x + (e.shiftKey ? e.deltaY : e.deltaX) / cam.zoom, y: cam.y + (e.shiftKey ? 0 : e.deltaY) / cam.zoom })
      }
    }
    el.addEventListener('wheel', onWheelNative, { passive: false })
    return () => el.removeEventListener('wheel', onWheelNative)
  }, [mounted])

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const rect = wrapRef.current!.getBoundingClientRect()
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
    const w = worldFromScreen(sx, sy)
    const frontDr = hitDrawing(w, 'front')
    if (frontDr) {
      setSelection(['drawing:' + frontDr])
      setMenu({ x: sx, y: sy, items: drawingMenuItems(frontDr) })
      return
    }
    const labelCl = hitCrosslinkLabel(w)
    if (labelCl) {
      setSelection(['crosslink:' + labelCl.id])
      setMenu({ x: sx, y: sy, items: crosslinkMenuItems(labelCl.id) })
      return
    }
    const node = hitNode(w)
    if (node) {
      if (!selection.includes(node.id)) setSelection([node.id])
      setMenu({ x: sx, y: sy, items: nodeMenuItems(node.id) })
      return
    }
    const pathCl = hitCrosslinkPath(w)
    if (pathCl) {
      setSelection(['crosslink:' + pathCl.id])
      setMenu({ x: sx, y: sy, items: crosslinkMenuItems(pathCl.id) })
      return
    }
    const backDr = hitDrawing(w, 'back')
    if (backDr) {
      setSelection(['drawing:' + backDr])
      setMenu({ x: sx, y: sy, items: drawingMenuItems(backDr) })
      return
    }
    setMenu({ x: sx, y: sy, items: canvasMenuItems(w) })
  }

  /* ---------- menu items ---------- */
  const requestDeleteOnly = (id: string) => {
    const st = useApp.getState()
    const doc = st.doc
    const node = doc && getTopic(doc, id)
    if (!doc || !node || !node.parent_id || id === doc.central_topic_id) return
    const projectId = doc.project_id
    const revision = doc.document_revision
    const generation = st.generation
    const links = doc.crosslinks.filter((c) => c.source === id || c.target === id)
    const run = (): boolean => {
      const live = useApp.getState()
      const current = live.doc
      if (!current || current.project_id !== projectId || live.generation !== generation) {
        live.toast('warn', 'Dự án đã thay đổi', 'Thao tác xóa đã bị hủy. Hãy chọn lại node.')
        return true
      }
      if (current.document_revision !== revision) {
        live.toast('warn', 'Dữ liệu đã thay đổi', 'Thao tác xóa đã bị hủy để tránh xóa nhầm node.')
        return true
      }
      if (!getTopic(current, id)) {
        live.toast('warn', 'Node không còn tồn tại', 'Thao tác xóa đã bị hủy.')
        return true
      }
      return live.dispatch({ type: 'deleteOnly', id }, 'Xóa node')
    }
    if (links.length) {
      st.setConfirm({
        message: `Xóa chỉ node "${node.text.slice(0, 60)}"?`,
        detail: `${links.length} đường nối chạm node sẽ bị gỡ. Các node con được nối lên cha; có thể hoàn tác bằng Ctrl+Z.`,
        danger: true,
        onOk: run,
      })
    } else run()
  }
  const nodeMenuItems = (id: string): MenuItem[] => {
    const st = useApp.getState()
    const t = st.doc && getTopic(st.doc, id)
    if (!t) return []
    const isCentral = st.doc!.central_topic_id === id || t.role === 'central'
    const freeform = st.doc!.layout.kind === 'freeform'
    const singleSelected = st.selection.length <= 1
    const canDemote = !isCentral && !!cmdBuildersDemote(id)
    const canPromote = !isCentral && !!cmdBuildersPromote(id)
    return [
      { menuId: 'N01', group: 'Sửa và thêm', label: 'Sửa tiêu đề', hint: 'F2', onClick: () => startEdit(id, 'title') },
      { menuId: 'N02', group: 'Sửa và thêm', label: 'Thêm con', hint: 'Tab', onClick: () => { useApp.setState({ selection: [id] }); useApp.getState().addChildToSelection() } },
      {
        menuId: 'N03',
        group: 'Sửa và thêm',
        label: isCentral ? 'Thêm nhánh chính' : 'Thêm ngang hàng',
        hint: 'Enter',
        onClick: () => { useApp.setState({ selection: [id] }); useApp.getState().addSiblingToSelection(false) },
      },
      { menuId: 'N04', group: 'Sửa và thêm', label: 'Chèn cha', disabled: !singleSelected || isCentral || !t.parent_id, disabledReason: isCentral ? 'Không thể chèn cha cho chủ đề trung tâm' : !t.parent_id ? 'Chủ đề nổi chưa có cha' : 'Chỉ áp dụng khi chọn một node', onClick: () => { const c = cmdBuildersInsertParent(id); if (c) dispatch(c, 'Chèn cha') } },

      { sep: true, label: '' },
      { menuId: 'N05', group: 'Thuộc tính', label: 'Nội dung node…', onClick: () => useApp.getState().setInspector(true, 'content') },
      { menuId: 'N06', group: 'Thuộc tính', label: 'Kiểu chữ…', onClick: () => useApp.getState().setInspector(true, 'text') },
      { menuId: 'N07', group: 'Thuộc tính', label: 'Đặt lại kiểu node', onClick: () => dispatch({ type: 'resetNodeStyle', ids: [id], before: {} }, 'Đặt lại kiểu') },

      { sep: true, label: '' },
      { menuId: 'N08', group: 'Nhánh', label: 'Chọn cả nhánh', onClick: () => setSelection([id, ...descendantsOf(st.doc!, id).map((d) => d.id)]) },
      { menuId: 'N09', group: 'Nhánh', label: 'Nhân bản nhánh', hint: 'Ctrl+D', disabled: isCentral, disabledReason: 'Không nhân bản chủ đề trung tâm', onClick: () => { useApp.setState({ selection: [id] }); useApp.getState().duplicateSelection() } },
      { menuId: 'N10', group: 'Nhánh', label: 'Nhân bản chỉ node này', disabled: isCentral, disabledReason: 'Không nhân bản chủ đề trung tâm', onClick: () => { const c = cmdBuildersDuplicateOnly(id); if (c) dispatch(c, 'Nhân bản node') } },
      { menuId: 'N11', group: 'Nhánh', label: t.collapsed ? 'Mở rộng nhánh' : 'Thu gọn nhánh', disabled: !childrenOf(st.doc!, id).length, disabledReason: 'Node chưa có chủ đề con', onClick: () => dispatch({ type: 'collapse', items: [{ id, value: !t.collapsed }] }, 'Thu gọn/mở') },
      { menuId: 'N12', group: 'Nhánh', label: 'Tập trung vào nhánh', onClick: () => { useApp.getState().focusBranch(id); centerOn(id) } },
      { menuId: 'N13', group: 'Nhánh', label: 'Xuất nhánh này…', onClick: () => useApp.getState().openExport(id) },

      { sep: true, label: '' },
      { menuId: 'N14', group: 'Sắp xếp và vị trí', label: 'Lên thứ tự', disabled: isCentral || !cmdBuildersReorder(id, -1), onClick: () => { const c = cmdBuildersReorder(id, -1); if (c) dispatch(c, 'Lên thứ tự') } },
      { menuId: 'N15', group: 'Sắp xếp và vị trí', label: 'Xuống thứ tự', disabled: isCentral || !cmdBuildersReorder(id, 1), onClick: () => { const c = cmdBuildersReorder(id, 1); if (c) dispatch(c, 'Xuống thứ tự') } },
      { menuId: 'N16', group: 'Sắp xếp và vị trí', label: 'Xuống cấp (Demote)', disabled: !canDemote, disabledReason: canDemote ? undefined : 'Không có node phía trước cùng cha', onClick: () => { const c = cmdBuildersDemote(id); if (c) dispatch(c, 'Xuống cấp') } },
      { menuId: 'N17', group: 'Sắp xếp và vị trí', label: 'Lên cấp (Promote)', disabled: !canPromote, disabledReason: canPromote ? undefined : 'Node cấp 1: dùng Tách thành chủ đề nổi', onClick: () => { const c = cmdBuildersPromote(id); if (c) dispatch(c, 'Lên cấp') } },
      { menuId: 'N18', group: 'Sắp xếp và vị trí', label: t.parent_id ? 'Tách thành chủ đề nổi' : 'Gắn vào chủ đề trung tâm', disabled: isCentral && !t.parent_id, onClick: () => {
        if (t.parent_id) { const c = cmdBuildersDetach(id); if (c) dispatch(c, 'Tách thành floating') }
        else { const c = cmdBuildersAttach(id); if (c) dispatch(c, 'Gắn về trung tâm') }
      } },
      ...(freeform ? [
        { menuId: 'N19', group: 'Sắp xếp và vị trí', label: moveBranchMode ? '✓ Di chuyển cả nhánh khi kéo' : 'Di chuyển cả nhánh khi kéo', onClick: () => setMoveBranchMode(!moveBranchMode) },
        { menuId: 'N20', group: 'Sắp xếp và vị trí', label: 'Về vị trí tự do mặc định', disabled: !t.manual_position, disabledReason: 'Node đang ở vị trí mặc định', onClick: () => dispatch({ type: 'moveFreeform', items: [{ id, from: t.manual_position ?? null, to: null }] }, 'Vị trí') },
      ] : []),

      { sep: true, label: '' },
      { menuId: 'N21', group: 'Xóa', label: 'Xóa cả nhánh', hint: 'Delete', danger: true, disabled: isCentral, disabledReason: 'Không thể xóa chủ đề trung tâm', onClick: () => { useApp.setState({ selection: [id] }); useApp.getState().deleteSelection() } },
      { menuId: 'N22', group: 'Xóa', label: 'Xóa node này', subtitle: 'Nối các node con lên cha', danger: true, disabled: isCentral || !t.parent_id, disabledReason: isCentral ? 'Không thể xóa chủ đề trung tâm' : 'Chủ đề nổi chưa có node cha để nối lên', onClick: () => requestDeleteOnly(id) },
    ]
  }
  const crosslinkMenuItems = (id: string): MenuItem[] => {
    const st = useApp.getState()
    const c = st.doc?.crosslinks.find((x) => x.id === id)
    if (!c) return []
    return [
      { label: 'Sửa nhãn…', onClick: () => { const label = window.prompt('Nhãn đường nối:', c.label ?? ''); if (label !== null) dispatch({ type: 'modifyCrosslink', id, before: { label: c.label ?? null }, after: { label: label || null } }, 'Sửa nhãn nối') } },
      { label: 'Đảo chiều mũi tên', onClick: () => dispatch({ type: 'modifyCrosslink', id, before: { arrow_start: c.arrow_start, arrow_end: c.arrow_end }, after: { arrow_start: c.arrow_end === true, arrow_end: c.arrow_start === true } }, 'Đảo mũi tên') },
      { label: 'Đổi màu', onClick: () => { const color = window.prompt('Màu hex (#RRGGBB):', c.color ?? '#8B5CF6'); if (color) dispatch({ type: 'modifyCrosslink', id, before: { color: c.color ?? null }, after: { color } }, 'Đổi màu nối') } },
      { sep: true, label: '' },
      { label: 'Xóa đường nối', danger: true, onClick: () => { dispatch({ type: 'removeCrosslinks', crosslinks: [c] }, 'Xóa nối'); setSelection([]) } },
    ]
  }
  const drawingMenuItems = (id: string): MenuItem[] => {
    const st = useApp.getState()
    const d = st.doc?.drawings.find((x) => x.id === id)
    if (!d) return []
    return [
      { label: 'Màu / độ dày…', onClick: () => useApp.getState().setInspector(true, 'drawing') },
      { label: 'Nhân bản', onClick: () => dispatch({ type: 'addDrawing', drawing: { ...structuredClone(d), id: uuid(), points: d.points.map((p) => ({ x: p.x + 24, y: p.y + 24 })) } }, 'Nhân bản nét') },
      { label: 'Lớp: đưa lên trước', onClick: () => dispatch({ type: 'modifyDrawing', id, before: { layer_order: d.layer_order }, after: { layer_order: (st.doc!.drawings.reduce((a, x) => Math.max(a, x.layer_order), 0) ?? 0) + 1 } }, 'Lớp nét vẽ') },
      { label: 'Lớp: đưa về sau', onClick: () => dispatch({ type: 'modifyDrawing', id, before: { layer_order: d.layer_order }, after: { layer_order: (st.doc!.drawings.reduce((a, x) => Math.min(a, x.layer_order), 0) ?? 0) - 1 } }, 'Lớp nét vẽ') },
      { sep: true, label: '' },
      { label: 'Xóa nét vẽ', danger: true, onClick: () => { dispatch({ type: 'removeDrawings', drawings: [d] }, 'Xóa nét vẽ'); setSelection([]) } },
    ]
  }
  const canvasMenuItems = (w: Pt): MenuItem[] => {
    const st = useApp.getState()
    const freeform = st.doc?.layout.kind === 'freeform'
    return [
      ...(freeform && st.doc ? [
        { label: 'Thêm chủ đề nổi tại đây', onClick: () => {
          const t = { ...newTopicLite('Chủ đề nổi'), manual_position: { x: w.x, y: w.y } }
          dispatch({ type: 'addTopic', topic: t, parentId: null, index: null, focusEditor: false }, 'Thêm chủ đề nổi')
        } },
      ] : []),
      { label: 'Thêm chủ đề con (Tab)', onClick: () => useApp.getState().addChildToSelection() },
      { label: 'Dán nhánh (Ctrl+V)', disabled: !hasClipboard(), onClick: () => pasteClipboard(w) },
      { sep: true, label: '' },
      { label: 'Vừa khít toàn sơ đồ (Ctrl+0)', onClick: () => fitAll() },
      { label: st.gridOn ? '✓ Lưới' : 'Lưới', onClick: () => useApp.getState().setGrid(!st.gridOn) },
      { label: st.snapOn ? '✓ Snap' : 'Snap vào lưới', onClick: () => useApp.getState().setSnap(!st.snapOn) },
      { label: 'Cài đặt Canvas…', onClick: () => useApp.getState().setSettingsOpen(true) },
    ]
  }

  const centerOn = (id: string) => {
    const n = scene2?.byId.get(id)
    if (n) setCamera({ ...camera, x: n.box.x + n.box.w / 2, y: n.box.y + n.box.h / 2 })
  }

  /* ---------- clipboard nội bộ (08.2) ----------
   * Dùng chung 1 nguồn với AppShell: window.__ommClipboard (do copySelection/cut ghi).
   * (Bản cũ đọc (useApp)._clipboard — không bao giờ được ghi nên mục Dán nhánh
   *   trong menu chuột phải luôn disabled.) */
  const hasClipboard = () => !!(window as unknown as { __ommClipboard?: unknown }).__ommClipboard
  const readClipboard = () => (window as unknown as { __ommClipboard?: BranchClipboard | null }).__ommClipboard ?? null

  const pasteClipboard = (w?: Pt) => {
    const st = useApp.getState()
    const clipboard = readClipboard()
    if (!st.doc || !clipboard) return
    const parent = st.selection.find(id => !!getTopic(st.doc!, id)) ?? st.doc.central_topic_id
    try { dispatch(pasteBranch(st.doc, clipboard, parent, w), 'Dán nhánh') }
    catch (e) { st.toast('error', 'Dán thất bại', String(e)) }
  }

  /* ---------- phím tắt trong canvas ---------- */
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      const st = useApp.getState()
      if (e.defaultPrevented || e.isComposing || st.transitionBusy || st.leavePrompt || document.querySelector('[role="dialog"]') || (e.target as HTMLElement)?.closest?.('[role="menu"], button, input, textarea, select, [data-omm-control]')) return
      if (e.key === 'Shift' && itRef.current.kind === 'shape') {
        const { x, y } = itRef.current.pointerScreen
        pointerUpdate.current(x, y, true)
      }
      if (e.key === 'Escape' && gesture.current && itRef.current.kind !== 'none') { cancelGesture(); e.preventDefault(); e.stopPropagation(); return }
      if (e.code === 'Space' && !(e.target as HTMLElement)?.matches?.('input, textarea')) { setSpaceHeld(true); e.preventDefault() }
    }
    const ku = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
      if (e.key === 'Shift' && itRef.current.kind === 'shape') {
        const { x, y } = itRef.current.pointerScreen
        pointerUpdate.current(x, y)
      }
    }
    window.addEventListener('keydown', kd, true)
    window.addEventListener('keyup', ku)
    const blur = () => { cancelGesture(); setSpaceHeld(false) }
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', kd, true); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur) }
  }, [cancelGesture])

  /* ---------- sự kiện từ AppShell (fit/zoom/center) ---------- */
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { action: string; dir?: number; id?: string }
      if (d.action === 'fit') fitAll()
      else if (d.action === 'zoom') {
        const nz = clampZoom(camera.zoom * (d.dir === 1 ? 1.25 : 0.8))
        setCamera({ ...camera, zoom: nz })
      } else if (d.action === 'center' && d.id) centerOn(d.id)
    }
    document.addEventListener('omm-canvas', h)
    return () => document.removeEventListener('omm-canvas', h)
  }, [camera, fitAll, centerOn])

  if (!mounted) return <div ref={wrapRef} className="flex-1 bg-[var(--canvas)]" />

  /* ================= render ================= */
  return (
    <div
      ref={wrapRef}
      data-omm-canvas
      tabIndex={-1}
      className="relative flex-1 overflow-hidden bg-[var(--canvas)] select-none outline-none"
      style={{ backgroundColor: scene2?.canvasBg, cursor: it.kind === 'pan' ? 'grabbing' : spaceHeld ? 'grab' : drawMode && tool === 'eraser' ? 'none' : drawMode ? 'crosshair' : 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={e => { if (gesture.current?.pointer === e.pointerId) cancelGesture() }}
      onLostPointerCapture={e => { if (gesture.current?.pointer === e.pointerId) cancelGesture() }}
      onPointerLeave={() => { setHover(null); setEraseCursor(null); setEraseHoverId(null) }}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest?.('[data-omm-control], button, input, select, textarea, a')) return
        const rect = wrapRef.current!.getBoundingClientRect()
        const w = worldFromScreen(e.clientX - rect.left, e.clientY - rect.top)
        const n = hitNode(w)
        if (n) startEdit(n.id, 'title')
        else if (doc?.layout.kind === 'freeform') {
          const t = { ...newTopicLite('Chủ đề nổi'), manual_position: { x: w.x, y: w.y } }
          dispatch({ type: 'addTopic', topic: t, parentId: null, index: null, focusEditor: false }, 'Thêm chủ đề nổi')
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onFileDrop}
    >
      {doc && scene2 ? (() => {
        const gridStep = Math.max(4, settings.gridSpacing * camera.zoom)
        const ox = size.w / 2 - camera.x * camera.zoom
        const oy = size.h / 2 - camera.y * camera.zoom
        const gx = ((ox % gridStep) + gridStep) % gridStep
        const gy = ((oy % gridStep) + gridStep) % gridStep
        return (
        <svg width={size.w} height={size.h} className="absolute inset-0 touch-none">
          <defs>
            <pattern id="grid" x={gx} y={gy} width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
              <path d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`} fill="none" stroke="var(--border)" strokeWidth="0.6" opacity="0.5" />
            </pattern>
          </defs>
          {gridOn && <rect width={size.w} height={size.h} fill="url(#grid)" />}
          <g transform={`translate(${ox} ${oy}) scale(${camera.zoom})`}>
            {/* back drawings (layer_order < 0) */}
            <DrawingLayer drawings={backDrawings} hideIds={it.kind === 'erase' ? it.ids : null} />
            {/* hierarchy edges — memo layer: chỉ re-render khi scene đổi */}
            <EdgeLayer edges={scene2.edges} />
            {/* crosslink paths + arrows (under node boxes) */}
            <CrosslinkPathLayer crosslinks={scene2.crosslinks} />
            {/* nodes — memo per-node: node không đổi hình ảnh không bao giờ re-render */}
            <NodeLayer nodes={scene2.nodes} onNote={onNoteOpen} onUrl={onUrlOpen} onCheckbox={onCheckboxToggle} />
            {/* crosslink labels (clear of nodes) */}
            <CrosslinkLabelLayer crosslinks={scene2.crosslinks} />
            {/* front drawings (layer_order >= 0) — ẩn tạm nét đang nằm trong vùng quét Tẩy */}
            <DrawingLayer drawings={frontDrawings} hideIds={it.kind === 'erase' ? it.ids : null} />
            {/* ===== overlays ===== */}
            {/* hover outline */}
            {hoverId && !selectionSet.has(hoverId) && scene2.byId.get(hoverId) && !(drawMode && tool === 'eraser') && (
              <rect x={scene2.byId.get(hoverId)!.box.x - 3} y={scene2.byId.get(hoverId)!.box.y - 3} width={scene2.byId.get(hoverId)!.box.w + 6} height={scene2.byId.get(hoverId)!.box.h + 6} rx={8} fill="none" stroke="var(--accent)" strokeWidth={1.2} strokeDasharray="4 3" opacity={0.6} />
            )}
            {/* selection */}
            {scene2.nodes.filter((n) => selectionSet.has(n.id)).map((n) => (
              <g key={'sel' + n.id}>
                <rect x={n.box.x - 3.5} y={n.box.y - 3.5} width={n.box.w + 7} height={n.box.h + 7} rx={9} fill="none" stroke="var(--accent)" strokeWidth={1.8} />
                {doc.layout.kind === 'freeform' && n.id === selection[0] && getTopic(doc, n.id)?.style.box_style?.size_mode === 'fixed' && (
                  <circle cx={n.box.x + n.box.w} cy={n.box.y + n.box.h} r={5 / camera.zoom} fill="var(--accent)" />
                )}
              </g>
            ))}
            {/* connector handle khi hover/selection */}
            {(hoverId || selection[0]) && !drawMode && (() => {
              const id = hoverId ?? selection[0]
              const n = scene2.byId.get(id)
              if (!n || id.startsWith('drawing:') || id.startsWith('crosslink:')) return null
              const hp = connectorHandleOf(n, camera.zoom, doc.layout.kind, doc.layout.direction, scene2.byId.get(doc.central_topic_id)?.box)
              return (
                <g data-omm-handle={n.id}>
                  <line x1={n.box.x + n.box.w} y1={hp.y} x2={hp.x} y2={hp.y} stroke="var(--accent)" strokeWidth={1 / camera.zoom} strokeDasharray="2 2" opacity={0.55} />
                  <circle cx={hp.x} cy={hp.y} r={hp.r} fill="var(--accent)" stroke="#fff" strokeWidth={1.5 / camera.zoom} opacity={0.95} />
                  <title>Kéo để nối chéo</title>
                </g>
              )
            })()}
            {/* chevron + badge — đặt theo hướng mọc nhánh để tránh đè node hàng xóm */}
            <ChevronLayer nodes={scene2.nodes} layoutKind={doc.layout.kind} direction={doc.layout.direction} centralBox={scene2.byId.get(doc.central_topic_id)?.box} onToggle={onChevronToggle} />
            {it.kind === 'resize' && it.resizeNext && it.resizeId && (() => {
              const node = scene2.byId.get(it.resizeId)
              return node && <rect x={node.box.x} y={node.box.y} width={it.resizeNext.w} height={it.resizeNext.h} fill="none" stroke="var(--accent)" strokeDasharray="4 3" pointerEvents="none" />
            })()}
            {/* DnD preview (LOCK-05: RAM only) */}
            {it.kind === 'node' && it.moved && doc.layout.kind === 'freeform' && [...it.ids].map((id) => {
              const n = scene2.byId.get(id)
              const o = it.originBoxes.get(id)
              if (!n || !o) return null
              const { x: dx, y: dy } = it.delta ?? { x: 0, y: 0 }
              return <g key={'gh' + id} opacity={0.65} pointerEvents="none" transform={`translate(${dx} ${dy})`}>
                <rect x={n.box.x} y={n.box.y} width={n.box.w} height={n.box.h} rx={n.shape === 'pill' ? pillRadius(n.box.w, n.box.h) : n.r} fill={n.fill} stroke={n.stroke} strokeWidth={n.strokeWidth} />
                <text x={n.textArea.x + dx * 0} y={n.textArea.y + 14} fontSize={n.textStyle.sizePx} fill={n.textStyle.color}>{n.textLines[0]?.text.slice(0, 24)}</text>
              </g>
            })}
            {it.kind === 'node' && it.moved && doc.layout.kind !== 'freeform' && it.ids[0] && (() => {
              const n = scene2.byId.get(it.ids[0])
              if (!n) return null
              const isFloatingGhost = it.intent === 'detach' || it.intent === 'move'
              return <g data-omm-drag-ghost={it.intent ?? 'none'} opacity={0.78} pointerEvents="none" transform={`translate(${it.pointerWorld.x - it.startWorld.x} ${it.pointerWorld.y - it.startWorld.y})`}>
                <rect x={n.box.x} y={n.box.y} width={n.box.w} height={n.box.h} rx={n.shape === 'pill' ? pillRadius(n.box.w, n.box.h) : n.r} fill={n.fill} stroke={it.intent === 'invalid' ? 'var(--danger)' : isFloatingGhost ? 'var(--accent)' : n.stroke} strokeWidth={isFloatingGhost ? Math.max(2, n.strokeWidth) : n.strokeWidth} strokeDasharray={isFloatingGhost ? '6 3' : undefined} />
                {it.ids.length > 1 || descendantsOf(doc, it.ids[0]).length > 0 ? (
                  <g>
                    <rect x={n.box.x} y={n.box.y + n.box.h + 6} width={n.box.w * 0.9} height={16} rx={8} fill="#334155" opacity={0.85} />
                    <text x={n.box.x + n.box.w * 0.45} y={n.box.y + n.box.h + 17.5} textAnchor="middle" fontSize={10} fill="#fff">Nhánh · {1 + descendantsOf(doc, it.ids[0]).length} node</text>
                  </g>
                ) : null}
              </g>
            })()}
            {it.kind === 'node' && it.moved && it.dropTargetId && it.intent === 'reparent' && scene2.byId.get(it.dropTargetId) && (() => {
              const t = scene2.byId.get(it.dropTargetId)!
              return <rect x={t.box.x - 4} y={t.box.y - 4} width={t.box.w + 8} height={t.box.h + 8} rx={10} fill="var(--success)" opacity={0.14} stroke="var(--success)" strokeWidth={2.2} pointerEvents="none" />
            })()}
            {it.insertLine && <line x1={it.insertLine.x1} y1={it.insertLine.y1} x2={it.insertLine.x2} y2={it.insertLine.y2} stroke="var(--accent)" strokeWidth={2.5} strokeLinecap="round" pointerEvents="none" />}
            {it.intent === 'invalid' && it.moved && (
              <g pointerEvents="none" transform={`translate(${it.pointerWorld.x + 14} ${it.pointerWorld.y + 18})`}>
                <rect x={0} y={0} width={Math.max(120, it.invalidMsg.length * 5.6 + 16)} height={24} rx={6} fill="var(--danger)" opacity={0.92} />
                <text x={8} y={15.5} fontSize={10.5} fill="#fff">{it.invalidMsg.slice(0, 60)}</text>
              </g>
            )}
            {it.guides.vertical !== null && <line x1={it.guides.vertical} y1={-10000} x2={it.guides.vertical} y2={10000} stroke="var(--accent)" strokeWidth={0.8} strokeDasharray="4 4" opacity={0.7} />}
            {it.guides.horizontal !== null && <line x1={-10000} y1={it.guides.horizontal} x2={10000} y2={it.guides.horizontal} stroke="var(--accent)" strokeWidth={0.8} strokeDasharray="4 4" opacity={0.7} />}
            {/* crosslink drag */}
            {it.kind === 'handle' && it.crosslinkFrom && (() => {
              const n = scene2.byId.get(it.crosslinkFrom)
              if (!n) return null
              const ax = n.box.x + n.box.w, ay = n.box.y + n.box.h / 2
              return <line x1={ax} y1={ay} x2={it.pointerWorld.x} y2={it.pointerWorld.y} stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" />
            })()}
            {/* live stroke */}
            {it.kind === 'stroke' && it.livePoints.length > 1 && (
              <path d={it.livePoints.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')} fill="none" stroke={brush.color} strokeWidth={tool === 'highlighter' ? Math.max(10, brush.width * 4) : brush.width} opacity={tool === 'highlighter' ? 0.35 : 0.9} strokeLinecap="round" strokeLinejoin="round" />
            )}
            {it.kind === 'shape' && it.livePoints.length === 2 && (() => {
              const [p1, p2] = it.livePoints
              const d = tool === 'line' ? `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`
                : tool === 'rect' ? `M ${Math.min(p1.x, p2.x)} ${Math.min(p1.y, p2.y)} h ${Math.abs(p2.x - p1.x)} v ${Math.abs(p2.y - p1.y)} h ${-Math.abs(p2.x - p1.x)} Z`
                : `M ${(p1.x + p2.x) / 2} ${Math.min(p1.y, p2.y)} a ${Math.abs(p2.x - p1.x) / 2} ${Math.abs(p2.y - p1.y) / 2} 0 1 0 0.01 0 Z`
              return <path d={d} fill="none" stroke={brush.color} strokeWidth={brush.width} strokeDasharray="6 4" opacity={0.9} />
            })()}
            {/* marquee */}
            {it.kind === 'marquee' && it.moved && (
              <rect x={Math.min(it.startWorld.x, it.pointerWorld.x)} y={Math.min(it.startWorld.y, it.pointerWorld.y)} width={Math.abs(it.pointerWorld.x - it.startWorld.x)} height={Math.abs(it.pointerWorld.y - it.startWorld.y)} fill="var(--accent)" opacity={0.08} stroke="var(--accent)" strokeWidth={1} strokeDasharray="4 3" />
            )}
            {/* Eraser: viền nét sắp xóa (V35-BR06) + đĩa cursor bán kính thật (SET-C16, 09.7) */}
            {drawMode && tool === 'eraser' && eraseHoverId && (() => {
              const dr = scene2.drawings.find((x) => x.obj.id === eraseHoverId)
              if (!dr) return null
              return <path d={dr.d} fill="none" stroke="var(--danger)" strokeWidth={dr.obj.width_world + 6} strokeDasharray="5 4" opacity={0.55} strokeLinecap="round" strokeLinejoin="round" />
            })()}
            {drawMode && tool === 'eraser' && eraseCursor && (
              <g pointerEvents="none">
                <circle cx={eraseCursor.x} cy={eraseCursor.y} r={Math.max(4, settings.eraserRadius)} fill="var(--accent)" opacity={0.07} />
                <circle cx={eraseCursor.x} cy={eraseCursor.y} r={Math.max(4, settings.eraserRadius)} fill="none" stroke={eraseHoverId || (it.kind === 'erase' && it.ids.length) ? 'var(--danger)' : 'var(--text2)'} strokeWidth={1.2} strokeDasharray="4 3" opacity={0.9} />
                <circle cx={eraseCursor.x} cy={eraseCursor.y} r={1.6} fill="var(--text2)" opacity={0.8} />
              </g>
            )}
          </g>
        </svg>
        )
      })() : (
        !doc && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-4 text-center">
            <img src="/openmindmap-logo-v4.png" alt="OpenMindmap" className="h-20 w-20 rounded-2xl shadow-lg" />
            <div className="space-y-1.5">
              <div className="text-[18px] font-semibold leading-snug text-[var(--text)]">Tạo một dự án để bắt đầu</div>
              <div className="text-[13px] text-[var(--text2)]">Một dự án là một sơ đồ tư duy với một chủ đề trung tâm.</div>
            </div>
            <div className="flex flex-wrap justify-center gap-2.5">
              <button type="button" onClick={() => useApp.getState().createProject()} className="flex h-10 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-5 text-[13px] font-medium text-[var(--onAccent)] shadow-sm transition-colors hover:bg-[var(--accentStrong)]">
                <PlusIcon size={16} /> Tạo dự án
              </button>
              <button type="button" onClick={() => useApp.getState().setImportOpen(true)} className="flex h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-5 text-[13px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--accent)]">
                <UploadIcon size={15} /> Nhập tệp…
              </button>
            </div>
            <div className="mt-2 flex flex-wrap justify-center items-center gap-4 text-[11px] text-[var(--text3)]">
              <span><kbd className="rounded bg-[var(--panel)] px-1.5 py-0.5 font-mono text-[10px] border border-[var(--border)]">Tab</kbd> thêm con</span>
              <span><kbd className="rounded bg-[var(--panel)] px-1.5 py-0.5 font-mono text-[10px] border border-[var(--border)]">Enter</kbd> thêm ngang hàng</span>
              <span><kbd className="rounded bg-[var(--panel)] px-1.5 py-0.5 font-mono text-[10px] border border-[var(--border)]">F2</kbd> sửa tiêu đề</span>
            </div>
          </div>
        )
      )}

      {it.kind === 'node' && it.moved && it.intent === 'detach' && doc && (() => {
        const srcId = it.ids[0]
        const outsideFocus = Boolean(focusRootId && srcId && srcId !== focusRootId && isDescendantOrSelf(doc, focusRootId, srcId))
        const left = Math.min(Math.max(12, it.pointerScreen.x + 16), Math.max(12, size.w - 280))
        const top = Math.min(Math.max(12, it.pointerScreen.y + 18), Math.max(12, size.h - 68))
        return (
          <div
            data-omm-detach-hint="true"
            className="pointer-events-none absolute z-30 max-w-[268px] rounded-lg border border-[var(--accent)] bg-[var(--panel)] px-3 py-2 text-left shadow-lg"
            style={{ left, top }}
          >
            <div className="text-[12px] font-semibold text-[var(--accent)]">Thả để tách thành chủ đề nổi</div>
            <div className="mt-0.5 text-[11px] leading-snug text-[var(--text2)]">
              {outsideFocus
                ? 'Gốc nổi sẽ đặt tại vị trí thả (ngoài vùng Focus hiện tại)'
                : 'Gốc nổi sẽ đặt tại vị trí thả'}
            </div>
          </div>
        )
      })()}

      {/* inline text editor (04.3) — CHỈ dành cho tiêu đề; ghi chú có editor
          riêng trong Inspector (17.3). Trước đây mount cho mọi field nên khi sửa
          ghi chú 2 textarea cùng autoFocus => textarea Inspector chiếm focus =>
          onBlur của textarea canvas gọi commitEdit => editor tự hủy ~6ms =>
          nút "Sửa ghi chú" vô dụng. */}
      {editor && editor.field === 'title' && doc && scene2?.byId.get(editor.nodeId) && (() => {
        const n = scene2.byId.get(editor.nodeId)!
        const p = screenFromWorld(n.box.x, n.box.y)
        const base = titleEditorBox(n, camera.zoom, size)
        const activeRect = editorRect?.key === titleSessionKey
          ? editorRect
          : editorSessionRef.current.lastRect?.key === titleSessionKey
            ? editorSessionRef.current.lastRect
            : {
                left: Math.round(Math.max(base.marginX, Math.min(p.x, size.w - base.marginX - base.w))),
                top: Math.round(Math.max(base.marginY, Math.min(p.y, size.h - base.marginY - base.h))),
                w: base.w,
                h: base.h,
              }
        return (
          <textarea
            ref={titleEditorRef}
            autoFocus
            value={editor.draft}
            aria-label="Sửa tiêu đề node"
            onChange={(e) => useApp.getState().updateDraft(e.target.value)}
            onCompositionStart={() => { compositionRef.current = true }}
            onCompositionEnd={() => { compositionRef.current = false }}
            onKeyDown={(e) => {
              if (compositionRef.current || e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (useApp.getState().commitEdit()) wrapRef.current?.focus({ preventScroll: true })
              } else if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation(); useApp.getState().cancelEdit()
                wrapRef.current?.focus({ preventScroll: true })
              }
            }}
            onBlur={e => {
              const input = e.currentTarget
              if (!useApp.getState().commitEdit()) requestAnimationFrame(() => { if (input.isConnected && !document.querySelector('[role=dialog],[role=menu]')) input.focus() })
            }}
            style={{
              left: activeRect.left, top: activeRect.top, width: activeRect.w, height: activeRect.h,
              fontFamily: n.textStyle.fontFamily,
              fontSize: n.textStyle.sizePx * camera.zoom,
              fontWeight: n.textStyle.weight, fontStyle: n.textStyle.italic ? 'italic' : 'normal',
              lineHeight: 1.25,
              overflowWrap: 'anywhere',
              overscrollBehavior: 'contain',
              color: 'var(--text)', caretColor: 'var(--text)', textAlign: n.textStyle.hAlign === 'center' ? 'center' : n.textStyle.hAlign === 'right' ? 'right' : 'left',
              boxShadow: 'var(--shadow-pop)',
            }}
            className="absolute z-30 resize-none overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words rounded-lg border-2 border-[var(--accent)] bg-[var(--panel)] p-1.5 outline-none omm-fade-in"
            placeholder="Nhập nội dung…"
          />
        )
      })()}

      {/* handle choice popover (free-form reconnect) */}
      {handleChoice && (
        <div ref={choiceRef} data-omm-control="true" role="menu" onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} className="absolute z-40 w-max max-w-[calc(100%_-_16px)] max-h-[calc(100%_-_16px)] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1.5 shadow-xl" style={{ left: handleChoice.x, top: handleChoice.y }}>
          <button className="block w-full rounded px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--hover)]" onClick={() => {
            dispatch({ type: 'reparent', items: [{ id: handleChoice.from, oldParentId: getTopic(doc!, handleChoice.from)?.parent_id ?? null, oldOrder: getTopic(doc!, handleChoice.from)?.order ?? 0, newParentId: handleChoice.to, newOrder: 9999 }] }, 'Chuyển cha')
            setHandleChoice(null)
          }}>Làm con của node này</button>
          <button className="block w-full rounded px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--hover)]" onClick={() => {
            dispatch({ type: 'addCrosslink', crosslink: { id: uuid(), source: handleChoice.from, target: handleChoice.to, arrow_end: true } }, 'Nối chéo')
            setHandleChoice(null)
          }}>Nối chéo (Crosslink)</button>
          <button className="block w-full rounded px-3 py-1.5 text-left text-[12.5px] text-[var(--text2)] hover:bg-[var(--hover)]" onClick={() => setHandleChoice(null)}>Hủy</button>
        </div>
      )}

      {/* focus breadcrumb */}
      {focusRootId && doc && (
        <div data-omm-control className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3.5 py-1.5 text-[12px] omm-fade-in" style={{ boxShadow: 'var(--shadow-md)' }}>
          <span className="text-[var(--text3)]">Tập trung:</span>
          <span className="max-w-[280px] truncate font-medium text-[var(--accent)]">{breadcrumb(doc, focusRootId)}</span>
          <button onClick={() => useApp.getState().exitFocus()} className="ml-1 flex items-center gap-1 rounded-full bg-[var(--hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--text2)] transition-colors hover:bg-[var(--accentSoft)] hover:text-[var(--accent)]">
            <span>✕</span> Thoát <kbd className="text-[10px] opacity-70">Esc</kbd>
          </button>
        </div>
      )}

      {/* search panel */}
      {searchOpen && <SearchPanel revealOn={showSearchResult} />}

      {/* Shared flow reserves space for both controls on narrow canvases. */}
      <div data-omm-control className="pointer-events-none absolute bottom-3 left-3 right-3 z-20 flex flex-col items-end gap-2">
        <div className="flex w-full flex-wrap items-end justify-end gap-2">
          {minimapOn && scene2 && <MiniMap scene2={scene2} camera={camera} size={size} setCamera={setCamera} />}
          <ZoomHud camera={camera} setCamera={setCamera} fitAll={() => fitAll()} />
        </div>
        {drawMode && <DrawToolbar />}
      </div>

      {/* context menu */}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {/* toasts */}
      <ToastHost />
    </div>
  )

  /* ---------- OS file drop → import (14.4) ---------- */
  function onFileDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (/\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
      // ảnh → gắn vào node đang chọn
      const target = selection.find((s) => !s.startsWith('drawing:') && !s.startsWith('crosslink:'))
      if (!target) { toast('warn', 'Chưa chọn node', 'Hãy chọn một node để gắn ảnh.'); return }
      attachImageFile(file, target)
      return
    }
    const st = useApp.getState()
    if (/\.(mindmap\.json|json|md|markdown|opml|txt)$/i.test(file.name)) {
      st.setImportOpen(true)
      window.dispatchEvent(new CustomEvent('omm-import-file', { detail: file }))
      return
    }
    toast('warn', 'Định dạng không hỗ trợ', 'Chỉ nhập được .mindmap.json / .json / .md / .opml / .txt')
  }

  async function attachImageFile(file: File, nodeId: string) {
    const generation = useApp.getState().generation
    try {
      const { asset, image } = await readImage(file)
      const current = useApp.getState()
      if (current.generation !== generation || !current.doc) return
      const node = getTopic(current.doc, nodeId)
      if (!node) return
      dispatch({ type: 'attachImage', id: nodeId, asset, before: node.image ?? null, after: image }, 'Gắn ảnh')
    } catch (e) { toast('error', 'Gắn ảnh thất bại', e instanceof Error ? e.message : String(e)) }
  }

}

/* ================= sub components ================= */

/* React.memo cho từng node: kết hợp với object reuse trong buildScene
 * (node không đổi hình ảnh giữ nguyên nhận dạng) → chỉ node thực sự thay đổi
 * mới re-render + ghi DOM. Trước đây 1500 node re-render toàn bộ mỗi thay đổi. */
const MemoNodeRender = React.memo(function SceneNodeRender({ n, onNote, onUrl, onCheckbox }: {
  n: SceneNode
  onNote: (id: string) => void
  onUrl: (id: string) => void
  onCheckbox: (id: string) => void
}) {
  const imageClipId = useId()
  const shapeD = n.shape === 'rect'
    ? `M ${n.box.x} ${n.box.y} h ${n.box.w} v ${n.box.h} h ${-n.box.w} Z`
    : n.shape === 'pill'
      ? pillPath(n.box)
      : roundRectPath(n.box, Math.min(n.r, n.box.w / 2, n.box.h / 2))
  const anchor = n.textStyle.hAlign === 'center' ? 'middle' : n.textStyle.hAlign === 'right' ? 'end' : 'start'
  const tx = n.textStyle.hAlign === 'center' ? n.textArea.x + n.textArea.w / 2 : n.textStyle.hAlign === 'right' ? n.textArea.x + n.textArea.w : n.textArea.x
  const lineH = n.textStyle.sizePx
  return (
    <g>
      {n.shadow && <path d={shapeD} transform="translate(3,4)" fill="rgba(15,23,42,0.10)" />}
      <path d={shapeD} fill={n.fill} stroke={n.strokeWidth > 0 ? n.stroke : 'none'} strokeWidth={n.strokeWidth} strokeDasharray={n.dash === 'dashed' ? '8 5' : n.dash === 'dotted' ? '2 4' : undefined} />
      {n.image && n.image.fit === 'cover' && (
        <clipPath id={imageClipId} clipPathUnits="userSpaceOnUse">
          <rect x={n.image.x} y={n.image.y} width={n.image.w} height={n.image.h} />
        </clipPath>
      )}
      {n.image && <image href={n.image.href} x={n.image.x} y={n.image.y} width={n.image.w} height={n.image.h} preserveAspectRatio={n.image.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'} clipPath={n.image.fit === 'cover' ? `url(#${imageClipId})` : undefined} />}
      {n.textLines.map((l, i) => (
        <text key={i} x={tx} y={n.textArea.y + (n.textLineY[i] ?? lineH)} textAnchor={anchor} fontSize={n.textStyle.sizePx} fill={n.textStyle.color} fontFamily={n.textStyle.fontFamily} fontWeight={n.textStyle.weight} fontStyle={n.textStyle.italic ? 'italic' : 'normal'} textDecoration={`${n.textStyle.underline ? 'underline ' : ''}${n.textStyle.strike ? 'line-through' : ''}`.trim() || undefined}>
          {l.text || ' '}
        </text>
      ))}
      {n.numbering && <text x={n.numbering.x} y={n.numbering.y + (n.textLineY[0] ?? lineH)} fontFamily="Noto Sans, sans-serif" fontSize={Math.min(n.textStyle.sizePx, 14)} fontWeight={600} fill={n.textStyle.color}>{n.numbering.text}</text>}
      {n.dateText && <text x={n.dateText.x} y={n.dateText.y + 11} fontFamily="Noto Sans, sans-serif" fontSize={10.7} fill={n.textStyle.color} opacity={0.75}>{n.dateText.text}</text>}
      {n.checkbox && (
        <g data-omm-control onClick={(e) => { e.stopPropagation(); onCheckbox(n.id) }} style={{ cursor: 'pointer' }}>
          <rect x={n.checkbox.x} y={n.checkbox.y} width={n.checkbox.size} height={n.checkbox.size} rx={3.5} fill={n.checkbox.checked ? '#2563EB' : n.checkbox.uncheckedFill} stroke={n.checkbox.checked ? '#1D4ED8' : n.checkbox.borderColor} strokeWidth={1.2} />
          {n.checkbox.checked && <path d={`M ${n.checkbox.x + 4} ${n.checkbox.y + n.checkbox.size / 2} l 3.4 3.4 l 6.2 -7`} fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
        </g>
      )}
      {n.icon && <IconPath id={n.icon.id} x={n.icon.x} y={n.icon.y} size={n.icon.size} color={n.textStyle.color} />}
      {n.hasNote && (() => {
        const np = n.notePos ?? { x: n.box.x + n.box.w - 10, y: n.box.y + n.box.h - 8 }
        return (
          <g data-omm-badge="note" transform={`translate(${np.x} ${np.y})`} onClick={(e) => { e.stopPropagation(); onNote(n.id) }} style={{ cursor: 'pointer' }}>
            <title>Mở ghi chú</title>
            <path d={NOTE_BADGE_PATH} fill="#F59E0B" stroke="#B45309" strokeWidth={0.6} />
          </g>
        )
      })()}
      {n.hasUrl && (() => {
        const up = n.urlPos ?? { x: n.box.x + n.box.w - (n.hasNote ? 24 : 10), y: n.box.y + n.box.h - 8 }
        return (
          <g data-omm-badge="url" transform={`translate(${up.x} ${up.y})`} onClick={(e) => { e.stopPropagation(); onUrl(n.id) }} style={{ cursor: 'pointer' }}>
            <title>Mở liên kết</title>
            <rect x={-7} y={-7} width={14} height={14} fill="transparent" />
            <path d={URL_BADGE_LINK_PATHS[0]} fill="none" stroke="#0284C7" strokeWidth={1.6} strokeLinecap="round" />
            <path d={URL_BADGE_LINK_PATHS[1]} fill="none" stroke="#0284C7" strokeWidth={1.6} strokeLinecap="round" />
          </g>
        )
      })()}
    </g>
  )
})

/* NodeLayer — memo theo mảng nodes + selectionSet + các callback ổn định.
 * Khi pan/zoom/hover (không đổi doc) thì layer này bị bỏ qua hoàn toàn. */
const NodeLayer = React.memo(function NodeLayer({ nodes, onNote, onUrl, onCheckbox }: {
  nodes: SceneNode[]
  onNote: (id: string) => void
  onUrl: (id: string) => void
  onCheckbox: (id: string) => void
}) {
  return (
    <>
      {nodes.map((n) => <MemoNodeRender key={n.id} n={n} onNote={onNote} onUrl={onUrl} onCheckbox={onCheckbox} />)}
    </>
  )
})

/* EdgeLayer — memo theo mảng edges (nhận dạng ổn định nhờ buildScene reuse) */
const EdgeLayer = React.memo(function EdgeLayer({ edges }: { edges: SceneEdge[] }) {
  return (
    <>
      {edges.map((e) => (
        <path key={e.id} d={e.d} fill="none" stroke={e.color} strokeWidth={e.width} strokeLinecap="round" strokeDasharray={e.dash === 'dashed' ? '8 5' : e.dash === 'dotted' ? '2 4' : undefined} />
      ))}
    </>
  )
})

/* CrosslinkPathLayer & CrosslinkLabelLayer — đường nối nằm dưới node, nhãn nằm trên node */
const CrosslinkPathLayer = React.memo(function CrosslinkPathLayer({ crosslinks }: { crosslinks: SceneCrosslink[] }) {
  return (
    <>
      {crosslinks.map((c) => (
        <g key={c.id}>
          <path d={c.d} fill="none" stroke={c.color} strokeWidth={c.width} strokeDasharray={c.dash === 'dotted' ? '2 4' : c.dash === 'dashed' ? '8 5' : undefined} />
          {c.arrowEnd && <ArrowD d={c.d} end color={c.color} />}
          {c.arrowStart && <ArrowD d={c.d} color={c.color} />}
        </g>
      ))}
    </>
  )
})
const CrosslinkLabelLayer = React.memo(function CrosslinkLabelLayer({ crosslinks }: { crosslinks: SceneCrosslink[] }) {
  return (
    <>
      {crosslinks.map((c) => c.label && c.labelBox ? (
        <g key={'clbl-' + c.id}>
          <rect x={c.labelBox.x} y={c.labelBox.y} width={c.labelBox.w} height={c.labelBox.h} rx={5} fill={c.labelBg} stroke={c.color} strokeWidth={CROSSLINK_LABEL_FONT.stroke} />
          <text x={c.mid.x} y={c.labelBaselineY ?? c.mid.y + 3} textAnchor="middle" fontSize={CROSSLINK_LABEL_FONT.size} fill={c.labelText} fontFamily={CROSSLINK_LABEL_FONT.family}>{c.label}</text>
        </g>
      ) : null)}
    </>
  )
})

/* DrawingLayer — memo theo drawings; hideIds chỉ khác null khi đang quét Tẩy */
const DrawingLayer = React.memo(function DrawingLayer({ drawings, hideIds }: { drawings: SceneDrawing[]; hideIds: string[] | null }) {
  return (
    <>
      {drawings.map((dr) => {
        if (hideIds && hideIds.includes(dr.obj.id)) return null
        return dr.obj.kind === 'rect' || dr.obj.kind === 'ellipse'
          ? <path key={dr.obj.id} d={dr.d} fill={dr.obj.fill ?? 'none'} stroke={dr.obj.color} strokeWidth={dr.obj.width_world} opacity={dr.obj.opacity} />
          : <path key={dr.obj.id} d={dr.d} fill="none" stroke={dr.obj.color} strokeWidth={dr.obj.width_world} opacity={dr.obj.opacity} strokeLinecap="round" strokeLinejoin="round" />
      })}
    </>
  )
})

/* ChevronLayer — nút thu gọn/mở rộng + badge số node ẩn.
 * Dùng childCount/collapsed/hidden tính sẵn trong SceneNode (không quét doc). */
const ChevronLayer = React.memo(function ChevronLayer({
  nodes, layoutKind, direction, centralBox, onToggle,
}: {
  nodes: SceneNode[]
  layoutKind: LayoutKind
  direction?: string | null
  centralBox?: { x: number; y: number; w: number; h: number } | null
  onToggle: (id: string) => void
}) {
  const [focused, setFocused] = useState<string | null>(null)
  return (
    <>
      {nodes.map((n) => {
        if (!n.childCount && !n.hidden) return null
        const collapsed = n.collapsed
        const hidden = n.hidden
        const { cx, cy, side, badgeRect } = chevronPlacementOf(n, layoutKind, direction, centralBox)
        const chevronPath = collapsed
          ? (side === 'left'
              ? `M ${cx + 2.5} ${cy - 4} l -5 4 l 5 4`
              : side === 'bottom'
                ? `M ${cx - 4} ${cy - 2} l 4 4.5 l 4 -4.5`
                : side === 'top'
                  ? `M ${cx - 4} ${cy + 2} l 4 -4.5 l 4 4.5`
                  : `M ${cx - 2.5} ${cy - 4} l 5 4 l -5 4`)
          : (side === 'top'
              ? `M ${cx - 4} ${cy + 2.5} l 4 -5 l 4 5`
              : side === 'bottom'
                ? `M ${cx - 4} ${cy + 2} l 4 -4.5 l 4 4.5`
                : `M ${cx - 4} ${cy - 2.5} l 4 5 l 4 -5`)
        return (
          <g key={'ch' + n.id} data-omm-control data-omm-chevron-side={side} role="button" tabIndex={0} aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Mở rộng nhánh' : 'Thu gọn nhánh'} ${n.textLines.map(line => line.text).join(' ')}${collapsed && hidden ? ` (${hidden} node ẩn)` : ''}`}
            onPointerDown={(e) => { e.stopPropagation() }}
            onClick={(e) => { e.stopPropagation(); onToggle(n.id) }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              if (!e.repeat && !e.nativeEvent.isComposing) onToggle(n.id)
            }}
            onFocus={() => setFocused(n.id)} onBlur={() => setFocused(null)}
            style={{ cursor: 'pointer', outline: 'none' }}>
            {focused === n.id && <circle cx={cx} cy={cy} r={10.5} fill="none" stroke="var(--accent)" strokeWidth={2} />}
            <circle cx={cx} cy={cy} r={7.5} fill="var(--panel)" stroke="var(--border)" />
            <path d={chevronPath} fill="none" stroke="var(--text2)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
            {badgeRect && hidden > 0 && (
              <>
                <rect x={badgeRect.x} y={badgeRect.y} width={badgeRect.w} height={badgeRect.h} rx={8} fill="var(--accent)" />
                <text x={badgeRect.x + badgeRect.w / 2} y={badgeRect.y + 11.5} textAnchor="middle" fontSize={9.5} fill="var(--onAccent)" fontWeight="600">{hidden}</text>
              </>
            )}
          </g>
        )
      })}
    </>
  )
})

function IconPath({ id, x, y, size, color }: { id: string; x: number; y: number; size: number; color: string }) {
  const icon = NODE_ICONS.find((i) => i.id === id)
  if (!icon) return <rect x={x} y={y} width={size} height={size} fill="none" stroke={color} strokeDasharray="2 2" />
  const s = size / 24
  return <g transform={`translate(${x},${y}) scale(${s})`}><path d={icon.path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></g>
}

function ArrowD({ d, end, color }: { d: string; end?: boolean; color: string }) {
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
  const n = nums.length
  const x2 = end ? nums[n - 2] : nums[0]
  const y2 = end ? nums[n - 1] : nums[1]
  const x1 = end ? nums[n - 4] : nums[2]
  const y1 = end ? nums[n - 3] : nums[3]
  if (Math.hypot(x2 - x1, y2 - y1) < 0.01) return null
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const len = 9
  const a1 = { x: x2 - len * Math.cos(ang - 0.45), y: y2 - len * Math.sin(ang - 0.45) }
  const a2 = { x: x2 - len * Math.cos(ang + 0.45), y: y2 - len * Math.sin(ang + 0.45) }
  return <path d={`M ${a1.x} ${a1.y} L ${x2} ${y2} L ${a2.x} ${a2.y}`} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
}

function ZoomHud({ camera, setCamera, fitAll }: { camera: { x: number; y: number; zoom: number }; setCamera: (c: { x: number; y: number; zoom: number }) => void; fitAll: () => void }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')
  const steps = [10, 25, 50, 75, 100, 125, 150, 200, 300, 400]
  const zoomStep = (dir: 1 | -1) => {
    const cur = camera.zoom * 100
    const next = dir === 1 ? steps.find((s) => s > cur + 0.5) : [...steps].reverse().find((s) => s < cur - 0.5)
    setCamera({ ...camera, zoom: clampZoom((next ?? (dir === 1 ? 400 : 10)) / 100) })
  }
  return (
    <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1 omm-fade-in" style={{ boxShadow: 'var(--shadow-md)' }}>
      <button type="button" onClick={() => zoomStep(-1)} className="grid h-7 w-7 place-items-center rounded-lg text-[15px] text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--accent)]" title="Thu nhỏ (−)" aria-label="Thu nhỏ">−</button>
      {editing ? (
        <input
          autoFocus value={val} onChange={(e) => setVal(e.target.value)}
          aria-label="Nhập tỷ lệ thu phóng (%)"
          onBlur={() => {
            const v = parseFloat(val.replace('%', ''))
            if (isFinite(v)) setCamera({ ...camera, zoom: clampZoom(v / 100) })
            setEditing(false)
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false) }}
          className="h-7 w-14 rounded-md border border-[var(--accent)] bg-[var(--panel)] text-center text-[11.5px] tabular-nums"
        />
      ) : (
        <button type="button" onClick={() => { setVal(String(Math.round(camera.zoom * 100))); setEditing(true) }} className="h-7 w-14 rounded-lg text-[11.5px] font-medium tabular-nums text-[var(--text)] transition-colors hover:bg-[var(--hover)]" title="Nhập tỷ lệ 10–400%" aria-label={`Tỷ lệ thu phóng ${Math.round(camera.zoom * 100)}%`}>
          {Math.round(camera.zoom * 100)}%
        </button>
      )}
      <button type="button" onClick={() => zoomStep(1)} className="grid h-7 w-7 place-items-center rounded-lg text-[15px] text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--accent)]" title="Phóng to (+)" aria-label="Phóng to">+</button>
      <div className="mx-0.5 h-5 w-px bg-[var(--border)]" />
      <button type="button" onClick={fitAll} className="h-7 rounded-lg px-2.5 text-[11.5px] font-medium text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--accent)]" title="Vừa khít (Ctrl+0)">Fit</button>
    </div>
  )
}

function MiniMap({ scene2, camera, size, setCamera }: { scene2: Scene; camera: { x: number; y: number; zoom: number }; size: { w: number; h: number }; setCamera: (c: { x: number; y: number; zoom: number }) => void }) {
  const W = 180, H = 120
  const b = scene2.bounds
  const scale = Math.min((W - 12) / Math.max(1, b.w), (H - 12) / Math.max(1, b.h))
  const viewW = (size.w / camera.zoom) * scale
  const viewH = (size.h / camera.zoom) * scale
  const toMini = (wx: number, wy: number) => ({
    x: 6 + (wx - b.x) * scale,
    y: 6 + (wy - b.y) * scale,
  })
  const viewCenter = toMini(camera.x, camera.y)
  const jump = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const wx = (mx - 6) / scale + b.x
    const wy = (my - 6) / scale + b.y
    setCamera({ ...camera, x: wx, y: wy })
  }
  /* Rects của node chỉ phụ thuộc scene — memo để pan/zoom không dựng lại 1500 rect */
  const nodeRects = useMemo(() => scene2.nodes.map((n) => {
    const px = 6 + (n.box.x - b.x) * scale
    const py = 6 + (n.box.y - b.y) * scale
    return <rect key={n.id} x={px} y={py} width={Math.max(2, n.box.w * scale)} height={Math.max(2, n.box.h * scale)} rx={1.5} fill={n.fill} stroke={n.stroke} strokeWidth={0.5} opacity={0.85} />
  }), [scene2, scale, b.x, b.y])
  return (
    <div data-omm-control className="pointer-events-auto mr-auto shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] omm-fade-in" style={{ width: W, height: H, cursor: 'pointer', boxShadow: 'var(--shadow-md)' }} onPointerDown={jump} onPointerMove={(e) => e.buttons === 1 && jump(e)}>
      <svg width={W} height={H}>
        {nodeRects}
        <rect x={viewCenter.x - viewW / 2} y={viewCenter.y - viewH / 2} width={viewW} height={viewH} fill="var(--accent)" fillOpacity={0.08} stroke="var(--accent)" strokeWidth={1.5} rx={3} />
      </svg>
    </div>
  )
}

function SearchPanel({ revealOn }: { revealOn: (id: string | null) => void }) {
  const search = useApp((s) => s.search)
  const setSearch = useApp((s) => s.setSearch)
  const doc = useApp((s) => s.doc)
  const dispatch = useApp((s) => s.dispatch)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const pattern = useMemo(() => search.query
    ? new RegExp(search.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), search.matchCase ? 'gu' : 'giu')
    : null, [search.query, search.matchCase])
  const matches = useMemo(() => {
    if (!doc || !pattern) return []
    return doc.topics.filter(t => t.text.search(pattern) !== -1 || (search.inNotes && t.notes && t.notes.search(pattern) !== -1)).map(t => t.id)
  }, [doc, pattern, search.inNotes])

  const [cursorId, setCursorId] = useState<string | null>(null)
  const index = Math.max(0, cursorId === null ? 0 : matches.indexOf(cursorId))
  const currentId = matches[index] ?? null
  // Normalize the cursor in the same render as the changed match list.
  if (cursorId !== currentId) setCursorId(currentId)
  const previousResult = useRef({ id: currentId, query: search.query })
  useEffect(() => {
    const previous = previousResult.current
    previousResult.current = { id: currentId, query: search.query }
    if (previous.query !== search.query || previous.id === currentId) return
    revealOn(currentId)
    if (currentId) useApp.getState().setSelection([currentId])
  }, [currentId, search.query, revealOn])
  const goto = (i: number) => {
    if (!matches.length) return
    const idx = ((i % matches.length) + matches.length) % matches.length
    const id = matches[idx]
    setCursorId(id)
    previousResult.current = { id, query: search.query }
    revealOn(id)
    useApp.getState().setSelection([id])
  }

  const replacePreview = useMemo(() => {
    // return [] khi: không doc, không query, hoặc ô thay thế trống
    if (!doc || !pattern || !search.replace) return []
    const topics = new Map(doc.topics.map(t => [t.id, t]))
    const rows: { id: string; field: 'title' | 'notes'; old: string; next: string; count: number }[] = []
    for (const id of matches) {
      const t = topics.get(id)
      if (!t) continue
      const fields = search.inNotes ? (['title', 'notes'] as const) : (['title'] as const)
      for (const field of fields) {
        const old = field === 'title' ? t.text : t.notes ?? ''
        let count = 0
        const next = old.replace(pattern, match => {
          if (match !== search.replace) count++
          return search.replace
        })
        if (count > 0) rows.push({ id, field, old, next, count })
      }
    }
    return rows
  }, [doc, matches, pattern, search.replace, search.inNotes])

  return (
    <div data-omm-control className="absolute left-1/2 top-3 z-30 w-[520px] max-w-[92%] -translate-x-1/2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 omm-fade-in" style={{ boxShadow: 'var(--shadow-pop)' }}>
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          value={search.query}
          aria-label="Tìm trong tiêu đề và ghi chú"
          onChange={(e) => { setCursorId(null); revealOn(null); setSearch({ query: e.target.value, index: 0 }) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); goto(index + (e.shiftKey ? -1 : 1)) }
            if (e.key === 'Escape') useApp.getState().openSearch(false)
          }}
          placeholder="Tìm trong tiêu đề (và ghi chú)…"
          className="h-9 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-[12.5px] transition-colors placeholder:text-[var(--text3)] focus:border-[var(--accent)] focus:bg-[var(--panel)]"
        />
        <span className="min-w-[44px] text-center text-[11px] font-medium tabular-nums text-[var(--text2)]">{matches.length ? `${index + 1}/${matches.length}` : '0/0'}</span>
        <button type="button" onClick={() => goto(index - 1)} className="grid h-7 w-7 place-items-center rounded-lg text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--accent)]" title="Kết quả trước" aria-label="Kết quả trước">↑</button>
        <button type="button" onClick={() => goto(index + 1)} className="grid h-7 w-7 place-items-center rounded-lg text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--accent)]" title="Kết quả sau (Enter)" aria-label="Kết quả sau">↓</button>
        <button type="button" onClick={() => useApp.getState().openSearch(false)} className="grid h-7 w-7 place-items-center rounded-lg text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--danger)]" title="Đóng (Esc)" aria-label="Đóng tìm kiếm"><CloseIcon size={14} /></button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-[var(--text2)]">
        <label className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={search.matchCase} onChange={(e) => setSearch({ matchCase: e.target.checked })} className="accent-[var(--accent)]" /> Phân biệt hoa/thường</label>
        <label className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={search.inNotes} onChange={(e) => setSearch({ inNotes: e.target.checked })} className="accent-[var(--accent)]" /> Trong ghi chú</label>
      </div>
      {search.query && (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <div className="flex items-center gap-1.5">
            <input
              value={search.replace}
              aria-label="Thay bằng"
              onChange={(e) => setSearch({ replace: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !e.nativeEvent.isComposing && !document.querySelector('[role="dialog"]')) {
                  e.preventDefault()
                  e.stopPropagation()
                  useApp.getState().openSearch(false)
                  document.querySelector<HTMLElement>('[data-omm-canvas]')?.focus({ preventScroll: true })
                }
              }}
              placeholder="Thay bằng…"
              className="h-8 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 text-[12px] transition-colors placeholder:text-[var(--text3)] focus:border-[var(--accent)] focus:bg-[var(--panel)]"
            />
            <button
              type="button"
              disabled={!replacePreview.length}
              onClick={() => {
                if (!replacePreview.length) return
                const total = replacePreview.reduce((a, r) => a + r.count, 0)
                if (!dispatch({ type: 'batchEditText', edits: replacePreview.map((r) => ({ id: r.id, field: r.field, before: r.old, after: r.next })) }, `Thay thế ${total} vị trí`)) return
                setSearch({ query: search.query })
                useApp.getState().toast('success', `Đã thay ${total} vị trí trong ${new Set(replacePreview.map((r) => r.id)).size} node`)
              }}
              className="h-8 rounded-lg bg-[var(--accent)] px-3 text-[11.5px] font-medium text-[var(--onAccent)] transition-colors hover:bg-[var(--accentStrong)] disabled:cursor-not-allowed disabled:opacity-40"
            >Thay tất cả</button>
          </div>
          {replacePreview.length > 0 && (
            <div className="mt-1.5 max-h-24 overflow-y-auto text-[11px] text-[var(--text2)]">
              {replacePreview.slice(0, 6).map((r) => (
                <div key={`${r.id}:${r.field}`} className="truncate">{r.field === 'notes' ? 'Ghi chú' : 'Tiêu đề'}: “{r.old.slice(0, 30)}” → “{r.next.slice(0, 30)}” ({r.count})</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DrawToolbar() {
  const tool = useApp((s) => s.tool)
  const setTool = useApp((s) => s.setTool)
  const brush = useApp((s) => s.brush)
  const setBrush = useApp((s) => s.setBrush)
  const setDrawMode = useApp((s) => s.setDrawMode)
  const eraserRadius = useApp((s) => s.settings.eraserRadius)
  const setSettings = useApp((s) => s.setSettings)
  const tools: { id: typeof tool; label: string; svg: React.ReactNode }[] = [
    {
      id: 'select',
      label: 'Chọn (V)',
      svg: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 2.5 L3.5 13 L6.8 9.8 L9.5 14 L11 13.2 L8.3 9 L12.5 8.8 Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>,
    },
    {
      id: 'pen',
      label: 'Bút (P)',
      svg: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.8 2.8 L13.2 5.2 L5.4 13 L2.5 13.5 L3 10.6 Z M9.4 4.2 L11.8 6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    },
    {
      id: 'highlighter',
      label: 'Đánh dấu (H)',
      svg: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5 L13.5 6.5 L7.2 12.8 L3.2 8.8 Z M2.5 13.5 L6.8 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    },
    {
      id: 'eraser',
      label: 'Tẩy đối tượng (E)',
      svg: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M7.5 3 L13 8.5 L8.5 13 L4.5 13 L2.5 11 Z M2.5 13.5 L13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    },
    {
      id: 'line',
      label: 'Đường thẳng (L)',
      svg: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>,
    },
    {
      id: 'rect',
      label: 'Hình chữ nhật (R)',
      svg: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.5" /></svg>,
    },
    {
      id: 'ellipse',
      label: 'Hình elip (O)',
      svg: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><ellipse cx="8" cy="8" rx="5.5" ry="4.2" stroke="currentColor" strokeWidth="1.5" /></svg>,
    },
  ]
  return (
    <div data-omm-draw-toolbar className="pointer-events-auto mx-auto flex max-w-full flex-wrap items-center justify-center gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-1.5 py-1 omm-fade-in" style={{ boxShadow: 'var(--shadow-pop)' }}>
      {tools.map((t) => (
        <button key={t.id} type="button" title={t.label} aria-label={t.label} aria-pressed={tool === t.id} onClick={() => setTool(t.id)}
          className={`grid h-8 w-8 place-items-center rounded-lg transition-colors ${tool === t.id ? 'bg-[var(--accent)] text-[var(--onAccent)] shadow-sm' : 'text-[var(--text2)] hover:bg-[var(--hover)] hover:text-[var(--accent)]'}`}>
          {t.svg}
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-[var(--border)]" />
      {tool === 'eraser' ? (
        /* SET-C16: bán kính Tẩy 4–64 world, chỉ hiện khi Tẩy active */
        <>
          <input type="range" min={4} max={64} step={1} value={eraserRadius}
            aria-label="Bán kính tẩy"
            onChange={(e) => setSettings({ eraserRadius: Number(e.target.value) })}
            title="Bán kính Tẩy (4–64)" className="w-20 cursor-pointer accent-[var(--accent)]" />
          <span className="w-7 text-center text-[10.5px] tabular-nums text-[var(--text2)]">{eraserRadius}</span>
        </>
      ) : (
        <>
          <input type="color" value={brush.color} aria-label="Màu bút vẽ" onChange={(e) => setBrush({ color: e.target.value })} title="Màu bút" className="h-7 w-7 cursor-pointer rounded-md border border-[var(--border)] bg-transparent p-0" />
          <input type="range" min={1} max={12} step={0.5} value={brush.width} aria-label="Độ dày nét vẽ" onChange={(e) => setBrush({ width: Number(e.target.value) })} title="Độ dày" className="w-16 cursor-pointer accent-[var(--accent)]" />
          <span className="w-6 text-center text-[10.5px] tabular-nums text-[var(--text2)]">{brush.width}</span>
        </>
      )}
      <span className="mx-1 h-5 w-px bg-[var(--border)]" />
      <button type="button" onClick={() => setDrawMode(false)} className="h-7 rounded-lg px-2.5 text-[11.5px] font-medium text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]" title="Tắt chế độ vẽ" aria-label="Đóng thanh vẽ">Đóng</button>
    </div>
  )
}

export interface MenuItem { label: string; onClick?: () => void; disabled?: boolean; danger?: boolean; sep?: boolean; hint?: string; group?: string; subtitle?: string; disabledReason?: string; menuId?: string }
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (box && ref.current) {
      ref.current.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`
      ref.current.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`
    }
  }, [x, y, items])
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc) }
  }, [onClose])
  return (
    <div ref={ref} role="menu" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } e.stopPropagation() }} className="fixed z-[70] max-h-[calc(100dvh-16px)] min-w-[240px] max-w-[min(360px,calc(100vw-16px))] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] py-1.5 omm-fade-in" style={{ left: x, top: y, boxShadow: 'var(--shadow-pop)' }}>
      {items.map((item, i) => {
        if (item.sep) return <div key={i} className="my-1 h-px bg-[var(--border)]" />
        const prevItem = [...items.slice(0, i)].reverse().find((it) => !it.sep)
        const showGroup = !!item.group && item.group !== prevItem?.group
        const tooltip = item.disabled ? (item.disabledReason ?? 'Không khả dụng trong ngữ cảnh này') : item.hint
        return (
          <React.Fragment key={i}>
            {showGroup && (
              <div className="px-3 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text3)]">
                {item.group}
              </div>
            )}
            <button
              type="button"
              data-menu-id={item.menuId}
              disabled={item.disabled}
              title={tooltip}
              onClick={() => { item.onClick?.(); onClose() }}
              className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[12.5px] leading-[17px] transition-colors
                ${item.danger ? 'text-[var(--danger)]' : 'text-[var(--text)]'}
                ${item.disabled ? 'cursor-not-allowed opacity-40' : item.danger ? 'hover:bg-[var(--dangerSoft)]' : 'hover:bg-[var(--hover)]'}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words">{item.label}</span>
                {item.subtitle && <span className="block text-[10.5px] leading-tight text-[var(--text3)]">{item.subtitle}</span>}
              </span>
              {item.hint && <span className="shrink-0 whitespace-nowrap rounded bg-[var(--panel-2-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text3)]">{item.hint}</span>}
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}

export function ToastHost() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  const searchOpen = useApp((s) => s.search.open)
  return (
    <div className={`pointer-events-none absolute right-3 ${searchOpen ? 'top-[136px]' : 'top-3'} z-[60] flex w-[340px] max-w-[80%] flex-col gap-2`}>
      {toasts.map((t) => {
        const colorCls = t.severity === 'error' ? 'border-l-[var(--danger)]' : t.severity === 'warn' ? 'border-l-[var(--warning)]' : t.severity === 'success' ? 'border-l-[var(--success)]' : 'border-l-[var(--accent)]'
        const iconCls = t.severity === 'error' ? 'text-[var(--danger)]' : t.severity === 'warn' ? 'text-[var(--warning)]' : t.severity === 'success' ? 'text-[var(--success)]' : 'text-[var(--accent)]'
        const sevIcon = t.severity === 'error'
          ? <XCircleIcon size={16} />
          : t.severity === 'warn'
            ? <AlertTriangleIcon size={16} />
            : t.severity === 'success'
              ? <CheckCircleIcon size={16} />
              : <InfoCircleIcon size={16} />
        return (
          <div key={t.id} data-omm-control role={t.severity === 'error' ? 'alert' : 'status'} className={`pointer-events-auto rounded-lg border border-[var(--border)] border-l-[3px] ${colorCls} bg-[var(--panel)] p-3 omm-fade-in backdrop-blur-sm`}
            style={{ boxShadow: 'var(--shadow-md)' }}>
            <div className="flex items-start gap-2.5">
              <span className={`mt-0.5 shrink-0 ${iconCls}`}>{sevIcon}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-[var(--text)]">{t.text}</div>
                {t.detail && <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--text2)]">{t.detail}</div>}
              </div>
              <button type="button" aria-label="Đóng thông báo" onClick={() => dismiss(t.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]">
                <CloseIcon size={13} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ================= helpers ================= */
function clampZoom(z: number): number {
  return Math.min(4, Math.max(0.1, z))
}
/* ---------- Eraser geometry (09.4) ---------- */
function distPointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
/** Nét vẽ có giao với đĩa bán kính radius quanh w không? Xét theo ĐOẠN nối
 *  (không chỉ điểm mẫu): polyline pen/highlighter, line, cạnh rect, viền ellipse. */
function drawingHitsDisc(obj: DrawingObject, w: Pt, radius: number): boolean {
  const pts = obj.points
  if (!pts.length) return false
  if (obj.kind === 'rect' || obj.kind === 'line' || obj.kind === 'ellipse') {
    const [p1, p2] = [pts[0], pts[pts.length - 1]]
    if (obj.kind === 'line') return distPointToSegment(w, p1, p2) <= radius
    const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y)
    const ww = Math.abs(p2.x - p1.x), hh = Math.abs(p2.y - p1.y)
    if (obj.kind === 'rect') {
      const c1 = { x, y }, c2 = { x: x + ww, y }, c3 = { x: x + ww, y: y + hh }, c4 = { x, y: y + hh }
      return distPointToSegment(w, c1, c2) <= radius || distPointToSegment(w, c2, c3) <= radius
        || distPointToSegment(w, c3, c4) <= radius || distPointToSegment(w, c4, c1) <= radius
    }
    // ellipse: lấy mẫu viền ellipse rồi xét từng đoạn
    if (ww <= 0.01 && hh <= 0.01) return Math.hypot(w.x - (x + ww / 2), w.y - (y + hh / 2)) <= radius
    const cx = x + ww / 2, cy = y + hh / 2
    const N = 72
    let prev = { x: cx + (ww / 2), y: cy }
    for (let i = 1; i <= N; i++) {
      const a = (i / N) * Math.PI * 2
      const cur = { x: cx + (ww / 2) * Math.cos(a), y: cy + (hh / 2) * Math.sin(a) }
      if (distPointToSegment(w, prev, cur) <= radius) return true
      prev = cur
    }
    return false
  }
  // polyline (pen/highlighter)
  if (pts.length === 1) return Math.hypot(w.x - pts[0].x, w.y - pts[0].y) <= radius
  for (let i = 1; i < pts.length; i++) {
    if (distPointToSegment(w, pts[i - 1], pts[i]) <= radius) return true
  }
  return false
}
function roundRectPath(b: { x: number; y: number; w: number; h: number }, r: number): string {
  const rr = Math.max(0, Math.min(r, b.w / 2, b.h / 2))
  return `M ${b.x + rr} ${b.y} h ${b.w - 2 * rr} a ${rr} ${rr} 0 0 1 ${rr} ${rr} v ${b.h - 2 * rr} a ${rr} ${rr} 0 0 1 ${-rr} ${rr} h ${-(b.w - 2 * rr)} a ${rr} ${rr} 0 0 1 ${-rr} ${-rr} v ${-(b.h - 2 * rr)} a ${rr} ${rr} 0 0 1 ${rr} ${-rr} Z`
}
function breadcrumb(doc: NonNullable<ReturnType<typeof useApp.getState>['doc']>, id: string): string {
  const t = doc.topics.find((x) => x.id === id)
  if (!t) return ''
  const parts: string[] = [t.text]
  let cur = t
  const guard = new Set<string>()
  while (cur.parent_id && !guard.has(cur.parent_id)) {
    guard.add(cur.parent_id)
    const p = doc.topics.find((x) => x.id === cur.parent_id)
    if (!p) break
    parts.unshift(p.text)
    cur = p
  }
  return ['Toàn sơ đồ', ...parts].join(' › ')
}
function newTopicLite(text: string): Topic {
  return {
    id: uuid(), role: 'floating', parent_id: null, order: 9999, text,
    collapsed: false, branch_side: 'auto', branch_color_seed: null, style: {},
    branch_style_override: null, image: null, icon: null, checkbox: null, url: null,
    date: null, numbering: null, manual_position: null, notes: null,
  }
}
type Command2 = { type: 'addSubtree'; topics: Topic[]; rootParentId: string; rootIndex: number | null; focusEditor: boolean }

/* command builders địa phương (wrap cmdBuilders với store) */
import { cmdBuilders } from '../lib/core/commands'
function cmdBuildersInsertParent(id: string) {
  const st = useApp.getState()
  return st.doc ? cmdBuilders.insertParent(st.doc, id) : null
}
function cmdBuildersDuplicateOnly(id: string) {
  const st = useApp.getState()
  if (!st.doc) return null
  let resolvedPos: { x: number; y: number } | undefined
  if (st.doc.layout.kind === 'freeform') {
    const b = buildScene(st.doc).layoutResult.pos.get(id)
    if (b) resolvedPos = { x: b.x, y: b.y }
  }
  return cmdBuilders.duplicateNodeOnly(st.doc, id, resolvedPos)
}
function cmdBuildersReorder(id: string, dir: -1 | 1) {
  const st = useApp.getState()
  return st.doc ? cmdBuilders.reorderUpDown(st.doc, id, dir) : null
}
function cmdBuildersDemote(id: string) {
  const st = useApp.getState()
  return st.doc ? cmdBuilders.demote(st.doc, id) : null
}
function cmdBuildersPromote(id: string) {
  const st = useApp.getState()
  return st.doc ? cmdBuilders.promote(st.doc, id) : null
}
function cmdBuildersDetach(id: string) {
  const st = useApp.getState()
  return st.doc ? cmdBuilders.detachToFloating(st.doc, id) : null
}
function cmdBuildersAttach(id: string) {
  const st = useApp.getState()
  if (!st.doc) return null
  return cmdBuilders.attachFloating(st.doc, id, st.doc.central_topic_id)
}
