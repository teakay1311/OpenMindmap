import { embeddedBitmap } from '../core/types'
/* ============================================================
 * OpenMindmap — lib/scene/scene.ts
 * SceneBuilder: Document snapshot → SceneGraph (V35-007, 14.7)
 * Cùng Scene cho Canvas render, Preview, PNG/SVG/PDF export.
 * Layer order (16.1): bg → hierarchy edges → node boxes/text/assets
 *                     → crosslinks → committed drawings → overlays(UI only)
 * ============================================================ */
import { ProjectDocV3, Topic, DrawingObject, getTheme } from '../core/types'
import { resolveStyle, ResolvedStyle, ResolvedTextStyle, numberingPrefix } from '../core/style'
import { childrenOf, getTopic, rootsOf, buildIndex, idxChildren, idxTopic, TreeIndex } from '../core/tree'
import { computeLayout, LayoutResult, Box, FISHBONE_RIB_SLOPE } from '../layout/engine'
import { layoutTextBlock, fontString, measureCenteredText, measureTextWidth, PT_TO_WORLD, beginTextMeasurementSession, endTextMeasurementSession } from './text'

export interface SceneTextStyle {
  font: string
  fontFamily: string
  sizePx: number
  color: string
  hAlign: 'left' | 'center' | 'right'
  weight: number
  italic: boolean
  underline: boolean
  strike: boolean
}
export interface SceneNode {
  id: string
  box: Box
  shape: 'rect' | 'rounded' | 'pill'
  r: number
  fill: string
  stroke: string
  strokeWidth: number
  dash: 'solid' | 'dashed' | 'dotted'
  shadow: boolean
  isCentral: boolean
  textLines: { text: string; width: number }[]
  textLineY: number[] // baseline offsets from textArea.y
  textStyle: SceneTextStyle
  textArea: { x: number; y: number; w: number; h: number } // vùng chữ (world)
  textBounds: Box
  requestedBox?: { w: number; h: number }
  icon?: { id: string; x: number; y: number; size: number }
  checkbox?: { x: number; y: number; size: number; checked: boolean; uncheckedFill: string; borderColor: string }
  numbering?: { text: string; x: number; y: number }
  dateText?: { text: string; x: number; y: number }
  image?: { href: string; x: number; y: number; w: number; h: number; fit: 'contain' | 'cover' }
  hasNote: boolean
  hasUrl: boolean
  notePos?: { x: number; y: number }
  urlPos?: { x: number; y: number }
  effectivePadding?: [number, number, number, number]
  edgeColor: string
  edgeWidth: number
  edgeRouting: string
  accent: string
  /* Số con trực tiếp + trạng thái thu gọn + số node ẩn (cho chevron overlay)
     — tính sẵn tại buildScene để Canvas không phải quét doc mỗi frame render */
  childCount: number
  collapsed: boolean
  hidden: number
}
export interface SceneEdge { id: string; d: string; color: string; width: number; dash: string; from: string; to: string }
export const CROSSLINK_LABEL_FONT = { family: 'Noto Sans, sans-serif', size: 10.5, stroke: 0.9 }
export interface SceneCrosslink {
  id: string
  d: string
  p1: { x: number; y: number }
  ctrl: { x: number; y: number }
  p2: { x: number; y: number }
  color: string
  width: number
  dash: string
  arrowStart: boolean
  arrowEnd: boolean
  label?: string
  labelBox?: Box
  labelBg: string
  labelText: string
  labelBaselineY?: number
  mid: { x: number; y: number }
  source: string
  target: string
}
export const NOTE_BADGE_PATH = 'M -5 -5 h 10 v 8 h -7 l -3 3 Z'
export const URL_BADGE_LINK_PATHS = [
  'M -1.2 1.8 L -2.6 3.2 A 2.4 2.4 0 0 1 -6 -0.2 L -3.8 -2.4 A 2.4 2.4 0 0 1 -0.4 1',
  'M 1.2 -1.8 L 2.6 -3.2 A 2.4 2.4 0 0 1 6 0.2 L 3.8 2.4 A 2.4 2.4 0 0 1 0.4 -1',
] as const
export interface SceneDrawing { obj: DrawingObject; d: string }
export interface Scene {
  nodes: SceneNode[]
  edges: SceneEdge[]
  crosslinks: SceneCrosslink[]
  drawings: SceneDrawing[]
  byId: Map<string, SceneNode>
  bounds: Box
  layoutResult: LayoutResult
  canvasBg: string
}

export interface SceneOpts {
  includeCollapsed?: boolean // export: mở toàn bộ subtree
  includeDrawings?: boolean
  scopeRoot?: string | null // xuất nhánh: subtree của topic này (null = toàn bộ)
  visibleOnly?: boolean
}

/* ---------- Helper hình học viên thuốc (PILL) ---------- */
/** Unified pill corner radius along both box dimensions. */
export function pillRadius(w: number, h: number): number {
  return Math.min(Math.max(0, w), Math.max(0, h)) / 2
}

/** Required symmetric edge inset G(r) ensuring >= 6 world-unit inner clearance. */
export function pillSafeGuard(r: number, strokeWidth: number): number {
  const s = Math.max(0, strokeWidth)
  const m = 6 + s / 2
  const k = 1 - 1 / Math.SQRT2
  const eps = 0.05
  return Math.ceil(m + k * Math.max(0, r - m) + eps)
}

/** Signed inner clearance (world units) from a local corner point to the pill inner wall. */
export function pillClearanceAtCorner(w: number, h: number, strokeWidth: number, pt: { x: number; y: number }): number {
  const r = pillRadius(w, h)
  const s = Math.max(0, strokeWidth)
  const ax1 = w >= h ? r : w / 2
  const ay1 = w >= h ? h / 2 : r
  const ax2 = w >= h ? w - r : w / 2
  const ay2 = w >= h ? h / 2 : h - r
  const vx = ax2 - ax1, vy = ay2 - ay1
  const len2 = vx * vx + vy * vy
  let t = 0
  if (len2 > 0) t = Math.max(0, Math.min(1, ((pt.x - ax1) * vx + (pt.y - ay1) * vy) / len2))
  const px = ax1 + t * vx, py = ay1 + t * vy
  return r - Math.hypot(pt.x - px, pt.y - py) - s / 2
}

/* ---------- Đo kích thước node (dùng bởi layout) ---------- */
function measureLongestParagraph(text: string, stText: ResolvedTextStyle): number {
  if (!text) return 0
  const font = fontString(stText)
  const paras = text.split('\n')
  let maxW = 0
  for (const par of paras) {
    if (!par) continue
    const w = measureTextWidth(par, font)
    if (w > maxW) maxW = w
  }
  return maxW
}

/** Single-pass primitive using explicit effective padding [T, R, B, L] without nested pill loops. */
function measureNodeSinglePass(
  doc: ProjectDocV3,
  t: Topic,
  st: ResolvedStyle,
  numbering: string,
  pads: readonly [number, number, number, number],
  cachedMaxParW?: number,
) {
  const fixed = st.box.sizeMode === 'fixed'
  const isPill = st.box.shape === 'pill'
  let image = t.image ? imgDims(doc, t, st) : { w: 0, h: 0 }
  const horizontal = !!t.image && (t.image.placement === 'left' || t.image.placement === 'right')
  const vertical = !!t.image && !horizontal
  const leftW = extrasLeftWidth(t, st, numbering)
  const badgeCount = (t.notes ? 1 : 0) + (t.url ? 1 : 0)
  const badgeReserveW = badgeCount ? (badgeCount === 2 ? 34 : 20) : 0
  const badgeExtraH = badgeCount ? (t.date ? 0 : (isPill ? 14 : Math.max(0, 15 - pads[2]))) : 0
  if (t.image?.fit === 'cover' && fixed && image.w > 0 && image.h > 0) {
    const body = measureNodeSinglePass(doc, { ...t, image: null }, st, numbering, pads, cachedMaxParW)
    const textWidth = horizontal ? body.leftW + Math.max(24, body.tb.width) + body.inset.left + body.inset.right + 8 : 0
    const textHeight = vertical ? body.bodyH + 8 : 0
    const dateHeight = t.date ? 14 * PT_TO_WORLD : 0
    const availableW = (st.box.width ?? 160) - pads[1] - pads[3] - textWidth
    const availableH = (st.box.height ?? 60) - pads[0] - pads[2] - textHeight - dateHeight - badgeExtraH
    image = {
      w: availableW > 0 ? Math.min(image.w, availableW) : image.w,
      h: availableH > 0 ? Math.min(image.h, availableH) : image.h,
    }
  }
  const sideW = horizontal ? image.w + 8 : 0

  let available: number | null = null
  let targetW = 0

  if (!st.text.wrap) {
    available = null
  } else if (fixed) {
    const outerW = Math.max(st.box.width ?? 160, st.box.minWidth ?? 48)
    const frameTextW = outerW - pads[1] - pads[3] - leftW - sideW
    available = st.text.wrapWidthExplicit
      ? Math.min(frameTextW, st.text.wrapWidth)
      : frameTextW
  } else {
    // Auto mode
    if (st.text.wrapWidthExplicit) {
      available = st.text.wrapWidth - pads[1] - pads[3] - leftW - sideW
    } else {
      const refSize = st.text.referenceFontSizePt ?? 14
      if (st.text.fontSizePt <= refSize) {
        available = st.text.wrapWidth - pads[1] - pads[3] - leftW - sideW
      } else {
        const ceiling = Math.min(800, 240 * (st.text.fontSizePt / refSize))
        const maxParW = cachedMaxParW !== undefined ? cachedMaxParW : measureLongestParagraph(t.text || '', st.text)
        targetW = Math.min(ceiling, maxParW + pads[1] + pads[3] + leftW + sideW)
        available = targetW - pads[1] - pads[3] - leftW - sideW
      }
    }
  }

  const tb = layoutTextBlock(t.text || ' ', st.text, available !== null ? Math.max(24, available) : null)
  const fontPx = st.text.fontSizePt * PT_TO_WORLD
  let inkTop = 0, inkBottom = tb.height, inkLeft = 0, inkRight = 0
  tb.lines.forEach((line, i) => {
    const m = measureCenteredText(line.text, fontString(st.text))
    const baseline = tb.lineY[i]
    const strikeTop = st.text.strike ? baseline - fontPx * 0.38 : baseline
    const asc = isPill
      ? Math.max(m.actualBoundingBoxAscent || 0, (m as TextMetrics & { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent || 0)
      : (m.actualBoundingBoxAscent || 0)
    const desc = isPill
      ? Math.max(m.actualBoundingBoxDescent || 0, (m as TextMetrics & { fontBoundingBoxDescent?: number }).fontBoundingBoxDescent || 0)
      : (m.actualBoundingBoxDescent || 0)
    inkTop = Math.min(inkTop, baseline - asc, strikeTop)
    let bot = baseline + desc
    if (st.text.underline) bot = Math.max(bot, baseline + Math.max(2, fontPx * 0.22))
    inkBottom = Math.max(inkBottom, bot)
    inkLeft = Math.max(inkLeft, (m.actualBoundingBoxLeft || 0) - line.width / 2)
    inkRight = Math.max(inkRight, (m.actualBoundingBoxRight || 0) - line.width / 2)
  })
  const inset = { top: -inkTop, bottom: inkBottom - tb.height, left: inkLeft, right: inkRight }
  const accessoryH = Math.max(t.icon ? (t.icon.size === 's' ? 16 : t.icon.size === 'm' ? 20 : 26) + 2 : 0, t.checkbox != null ? 18 : 0)
  const bodyH = Math.max(16, tb.height + inset.top + inset.bottom, accessoryH, horizontal ? image.h : 0)
  const dateW = t.date ? measureTextWidth(t.date, '10.7px Noto Sans, sans-serif') : 0
  const bottomStripW = t.date ? dateW + (badgeReserveW ? 8 + badgeReserveW : 0) : badgeReserveW
  const contentW = pads[3] + Math.max(leftW + sideW + Math.max(tb.width, 24) + inset.left + inset.right, vertical ? image.w : 0, bottomStripW) + pads[1]
  const requiredW = Math.ceil(targetW > 0 ? Math.max(targetW, contentW) : contentW)
  const requiredH = Math.ceil(pads[0] + (vertical ? image.h + 8 : 0) + bodyH + (t.date ? 14 * PT_TO_WORLD : 0) + badgeExtraH + pads[2])
  return {
    tb, image, leftW, bodyH, inset, badgeExtraH,
    requiredW,
    requiredH,
    w: Math.max(fixed ? st.box.width ?? 160 : 0, st.box.minWidth ?? 48, requiredW),
    h: Math.max(fixed ? st.box.height ?? 60 : 0, st.box.minHeight ?? 24, requiredH),
  }
}

/** One content measurement for layout, the renderer, resize and Fixed commits (including pill safe padding). */
export function measureNodeContent(doc: ProjectDocV3, t: Topic, st: ResolvedStyle, numbering = '') {
  const basePads = st.text.padding
  let maxParW: number | undefined
  const isAutoWrapLarge = st.box.sizeMode !== 'fixed' && st.text.wrap && !st.text.wrapWidthExplicit && st.text.fontSizePt > (st.text.referenceFontSizePt ?? 14)
  if (isAutoWrapLarge) {
    maxParW = measureLongestParagraph(t.text || '', st.text)
  }

  if (st.box.shape !== 'pill') {
    const res = measureNodeSinglePass(doc, t, st, numbering, basePads, maxParW)
    const ep: [number, number, number, number] = [basePads[0], basePads[1], basePads[2], basePads[3]]
    return { ...res, effectivePadding: ep, radius: st.box.shape === 'rect' ? 0 : st.box.cornerRadius }
  }
  const s = st.box.stroke !== 'none' && st.box.strokeWidth > 0 ? st.box.strokeWidth : 0
  let guard = 0
  let last = measureNodeSinglePass(doc, t, st, numbering, basePads, maxParW)
  let lastPads: [number, number, number, number] = [basePads[0], basePads[1], basePads[2], basePads[3]]
  for (let pass = 0; pass < 4; pass++) {
    const effPads: [number, number, number, number] = [
      Math.max(basePads[0], guard),
      Math.max(basePads[1], guard),
      Math.max(basePads[2], guard),
      Math.max(basePads[3], guard),
    ]
    const res = measureNodeSinglePass(doc, t, st, numbering, effPads, maxParW)
    last = res
    lastPads = effPads
    const r = pillRadius(res.w, res.h)
    const g = pillSafeGuard(r, s)
    if (effPads[0] >= g && effPads[1] >= g && effPads[2] >= g && effPads[3] >= g
      && res.requiredW <= res.w && res.requiredH <= res.h) {
      return { ...res, effectivePadding: effPads, radius: r }
    }
    guard = Math.max(guard, g)
  }
  const m = 6 + s / 2
  const k = 1 - 1 / Math.SQRT2
  const eps = 0.05
  const h0 = Math.min(last.w, last.h)
  const fallback = Math.ceil((m + k * (h0 / 2) + eps) / (1 - k))
  const finalPads: [number, number, number, number] = [
    Math.max(lastPads[0], fallback),
    Math.max(lastPads[1], fallback),
    Math.max(lastPads[2], fallback),
    Math.max(lastPads[3], fallback),
  ]
  const dw = (finalPads[1] - lastPads[1]) + (finalPads[3] - lastPads[3])
  const dh = (finalPads[0] - lastPads[0]) + (finalPads[2] - lastPads[2])
  const finalW = last.w + dw
  const finalH = last.h + dh
  return {
    ...last,
    w: finalW,
    h: finalH,
    requiredW: last.requiredW + dw,
    requiredH: last.requiredH + dh,
    effectivePadding: finalPads,
    radius: pillRadius(finalW, finalH),
  }
}

function buildNumbering(doc: ProjectDocV3, idx: TreeIndex) {
  const result = new Map<string, string>()
  const walk = (pid: string, path: number[], active: string | null) => {
    idxChildren(idx, pid).forEach((t, i) => {
      const fmt = t.numbering && t.numbering.format !== 'none' ? t.numbering.format : null
      const current = fmt ?? (t.numbering?.apply_to_subtree === false ? null : active)
      if (current) result.set(t.id, numberingPrefix(current, [...path, i]))
      walk(t.id, [...path, i], t.numbering?.apply_to_subtree && fmt ? fmt : (active && (!t.numbering || t.numbering.apply_to_subtree !== false) ? active : fmt))
    })
  }
  rootsOf(doc).forEach(t => walk(t.id, [], t.numbering && t.numbering.format !== 'none' ? t.numbering.format : null))
  return result
}

export function makeSizeOf(doc: ProjectDocV3, idx = buildIndex(doc), styleMemo = new Map<string, ResolvedStyle>()) {
  const numbering = buildNumbering(doc, idx)
  return (t: Topic): { w: number; h: number } => measureNodeContent(doc, t, resolveStyle(doc, t, idx, styleMemo), numbering.get(t.id))
}

/** Only changed geometry is normalized; opening/previewing old data never writes it. */
export function fitChangedFixedNodes(before: ProjectDocV3, after: ProjectDocV3): void {
  if (after.map_style_overrides.box_style?.size_mode !== 'fixed' && !after.topics.some(t => t.style.box_style?.size_mode === 'fixed')) return
  const oldIdx = buildIndex(before), idx = buildIndex(after)
  const oldStyles = new Map<string, ResolvedStyle>(), styles = new Map<string, ResolvedStyle>()
  const oldNumbers = buildNumbering(before, oldIdx), numbers = buildNumbering(after, idx)
  const signature = (doc: ProjectDocV3, t: Topic, st: ResolvedStyle, number: string | undefined) => {
    const { color: _color, strike: _strike, hAlign: _hAlign, vAlign: _vAlign, ...text } = st.text
    const effectiveUnderline = st.box.shape === 'pill' ? text.underline : false
    const effectiveStroke = st.box.stroke !== 'none' ? st.box.strokeWidth : 0
    const a = t.image && doc.assets.find(a => a.id === t.image!.asset_id)
    return JSON.stringify([
      t.text, { ...text, underline: effectiveUnderline },
      st.box.shape, effectiveStroke,
      st.box.sizeMode, st.box.width, st.box.height, st.box.minWidth, st.box.minHeight,
      t.image, a && [a.width, a.height], t.icon, t.checkbox != null, t.date, number,
    ])
  }
  for (const t of after.topics) {
    const st = resolveStyle(after, t, idx, styles)
    if (st.box.sizeMode !== 'fixed') continue
    const old = idxTopic(oldIdx, t.id)
    if (old && signature(before, old, resolveStyle(before, old, oldIdx, oldStyles), oldNumbers.get(t.id)) === signature(after, t, st, numbers.get(t.id))) continue
    const measured = measureNodeContent(after, t, st, numbers.get(t.id))
    if (measured.w > 1200 || measured.h > 800) throw new Error('Nội dung vượt kích thước Cố định tối đa 1200 × 800. Hãy dùng Auto hoặc điều chỉnh cỡ chữ bằng các điều khiển hiện có.')
    const curW = st.box.width ?? 160
    const curH = st.box.height ?? 60
    const patch: { width_world?: number; height_world?: number } = {}
    if (measured.w > curW) patch.width_world = measured.w
    if (measured.h > curH) patch.height_world = measured.h
    if (patch.width_world !== undefined || patch.height_world !== undefined) {
      t.style.box_style = { ...t.style.box_style, ...patch }
    }
  }
}
function clamp01(v: number) { return Math.min(1, Math.max(0.05, v || 0.4)) }
function extrasLeftWidth(t: Topic, st: ResolvedStyle, numbering: string): number {
  let w = 0
  if (t.icon) w += (t.icon.size === 's' ? 16 : t.icon.size === 'm' ? 20 : 26) + 6
  if (t.checkbox !== null && t.checkbox !== undefined) w += 18 + 6
  if (numbering) w += Math.max(26, measureTextWidth(numbering, `600 ${Math.min(st.text.fontSizePt * PT_TO_WORLD, 14)}px Noto Sans, sans-serif`) + 4)
  return w
}

/* ---------- Anchor trên viền node ---------- */
export function borderAnchor(b: Box, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const dx = toward.x - cx, dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const sx = dx !== 0 ? (b.w / 2) / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? (b.h / 2) / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

export function shapeBorderAnchor(b: Box, shape: 'rect' | 'rounded' | 'pill', r: number, toward: { x: number; y: number }): { x: number; y: number } {
  const rectPt = borderAnchor(b, toward)
  const cr = shape === 'rect' ? 0 : shape === 'pill' ? Math.min(b.w / 2, b.h / 2) : Math.min(Math.max(0, r), b.w / 2, b.h / 2)
  if (cr <= 0.5) return rectPt
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const hw = b.w / 2 - cr, hh = b.h / 2 - cr
  const dx = toward.x - cx, dy = toward.y - cy
  if (Math.abs(rectPt.x - cx) <= hw + 1e-4 || Math.abs(rectPt.y - cy) <= hh + 1e-4) return rectPt
  const len = Math.hypot(dx, dy)
  if (len === 0) return rectPt
  const ux = dx / len, uy = dy / len
  const kx = cx + Math.sign(dx) * hw, ky = cy + Math.sign(dy) * hh
  const vx = cx - kx, vy = cy - ky
  const uv = ux * vx + uy * vy
  const vv = vx * vx + vy * vy
  const disc = Math.max(0, uv * uv - (vv - cr * cr))
  const t = -uv + Math.sqrt(disc)
  return { x: cx + ux * t, y: cy + uy * t }
}

function isDarkSurface(color: string | null | undefined, fallbackDark: boolean): boolean {
  if (!color || color === 'transparent' || color === 'none') return fallbackDark
  let r = 0, g = 0, b = 0, a = 1
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16)
      if (h.length === 4) a = parseInt(h[3] + h[3], 16) / 255
    } else {
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16)
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255
    }
  } else {
    const rgb = color.trim().match(/^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i)
    if (!rgb) return fallbackDark
    r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3])
    if (rgb[4] != null) a = rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : Number(rgb[4])
  }
  if (a < 0.25) return fallbackDark
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return lum < 0.45
}

function edgeD(
  a: Box,
  b: Box,
  routing: string,
  orientation: 'h' | 'v' | 'free',
  opts?: { layoutKind?: string; busY?: number; fishbone?: { depth: 1 | 2 | 3; headDir: 1 | -1 } }
): { d: string; pts: { x: number; y: number }[] } {
  if (opts?.layoutKind === 'fishbone' && opts.fishbone) {
    const { depth, headDir } = opts.fishbone
    if (depth === 1) {
      const cTipX = b.x + b.w / 2
      const cEdgeY = b.y + b.h / 2 < 0 ? b.y + b.h : b.y
      const spineX = cTipX + headDir * FISHBONE_RIB_SLOPE * Math.abs(cEdgeY)
      const p1 = { x: q(spineX), y: 0 }, p2 = { x: q(cTipX), y: q(cEdgeY) }
      return { d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`, pts: [p1, p2] }
    }
    if (depth === 2) {
      const cTipX = a.x + a.w / 2
      const cEdgeY = a.y + a.h / 2 < 0 ? a.y + a.h : a.y
      const k2MidY = b.y + b.h / 2
      const ribX = cTipX + headDir * FISHBONE_RIB_SLOPE * Math.max(0, Math.abs(cEdgeY) - Math.abs(k2MidY))
      const k2InnerX = headDir === 1 ? b.x + b.w : b.x
      const p1 = { x: q(ribX), y: q(k2MidY) }, p2 = { x: q(k2InnerX), y: q(k2MidY) }
      return { d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`, pts: [p1, p2] }
    }
    const p1 = { x: q(headDir === 1 ? a.x : a.x + a.w), y: q(a.y + a.h / 2) }
    const p2 = { x: q(headDir === 1 ? b.x + b.w : b.x), y: q(b.y + b.h / 2) }
    if (Math.abs(p1.y - p2.y) < 0.5) {
      return { d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`, pts: [p1, p2] }
    }
    const mx = q((p1.x + p2.x) / 2)
    return { d: `M ${p1.x} ${p1.y} L ${mx} ${p1.y} L ${mx} ${p2.y} L ${p2.x} ${p2.y}`, pts: [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2] }
  }
  if ((opts?.layoutKind === 'organization' || opts?.layoutKind === 'tree') && routing === 'elbow') {
    const down = b.y + b.h / 2 >= a.y + a.h / 2
    const p1 = { x: q(a.x + a.w / 2), y: q(down ? a.y + a.h : a.y) }
    const p2 = { x: q(b.x + b.w / 2), y: q(down ? b.y : b.y + b.h) }
    const my = q(opts.busY ?? (p1.y + p2.y) / 2)
    return { d: `M ${p1.x} ${p1.y} L ${p1.x} ${my} L ${p2.x} ${my} L ${p2.x} ${p2.y}`, pts: [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2] }
  }
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const p1 = borderAnchor(a, bc)
  const p2 = borderAnchor(b, ac)
  const pts = [p1, p2]
  if (routing === 'elbow') {
    if (orientation === 'h' || (orientation === 'free' && Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y))) {
      const mx = q((p1.x + p2.x) / 2)
      return { d: `M ${p1.x} ${p1.y} L ${mx} ${p1.y} L ${mx} ${p2.y} L ${p2.x} ${p2.y}`, pts: [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2] }
    }
    const my = q((p1.y + p2.y) / 2)
    return { d: `M ${p1.x} ${p1.y} L ${p1.x} ${my} L ${p2.x} ${my} L ${p2.x} ${p2.y}`, pts: [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2] }
  }
  if (routing === 'straight' || orientation === 'free') {
    if (routing === 'curved' && orientation === 'free') {
      const k = 0.35
      const c1 = { x: p1.x + (p2.x - p1.x) * k, y: p1.y + (p2.y - p1.y) * k }
      const c2 = { x: p2.x - (p2.x - p1.x) * k, y: p2.y - (p2.y - p1.y) * k }
      return { d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`, pts: [p1, c1, c2, p2] }
    }
    return { d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`, pts }
  }
  // curved theo orientation
  const k = Math.min(120, Math.max(30, (orientation === 'h' ? Math.abs(p2.x - p1.x) : Math.abs(p2.y - p1.y)) / 2))
  if (orientation === 'h') {
    const dir = p2.x >= p1.x ? 1 : -1
    const c1 = { x: p1.x + dir * k, y: p1.y }
    const c2 = { x: p2.x - dir * k, y: p2.y }
    return { d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`, pts: [p1, c1, c2, p2] }
  }
  const dir = p2.y >= p1.y ? 1 : -1
  const c1 = { x: p1.x, y: p1.y + dir * k }
  const c2 = { x: p2.x, y: p2.y - dir * k }
  return { d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`, pts: [p1, c1, c2, p2] }
}

function orientationOf(kind: string): 'h' | 'v' | 'free' {
  if (kind === 'balanced' || kind === 'logic') return 'h'
  if (kind === 'tree' || kind === 'organization') return 'v'
  return 'free'
}

function dashAttr(d: string): string {
  if (d === 'dashed') return '8 5'
  if (d === 'dotted') return '2 4'
  return ''
}

/* ============================================================
 * buildScene
 * ============================================================ */

/* Làm tròn 2 số thập phân: loại "fp noise" (sai số 1e-15) giữa các lượt
 * layout — trước đây khiến ~3000 thuộc tính d/y/cy bị ghi lại DOM dù map
 * không đổi gì về hình ảnh (nguyên nhân chính của lag khi tài liệu lớn). */
const q = (v: number): number => Math.round(v * 100) / 100

/* Cache nhận dạng SceneNode/Edge giữa các lượt buildScene: nếu node mới
 * giống hệt node cũ (mọi trường hiển thị) thì TÁI DỤNG object cũ →
 * React.memo bên Canvas bỏ qua render cho toàn bộ node không đổi. */
interface SceneCacheSlot {
  nodes: Map<string, SceneNode>
  edges: Map<string, SceneEdge>
  crosslinks: Map<string, SceneCrosslink>
  drawings: Map<string, SceneDrawing>
  nodesArr: SceneNode[]
  edgesArr: SceneEdge[]
}
let sceneCache: SceneCacheSlot | null = null

function sameNode(a: SceneNode, b: SceneNode): boolean {
  if (a.box.x !== b.box.x || a.box.y !== b.box.y || a.box.w !== b.box.w || a.box.h !== b.box.h) return false
  if (a.requestedBox?.w !== b.requestedBox?.w || a.requestedBox?.h !== b.requestedBox?.h) return false
  if (a.shape !== b.shape || a.r !== b.r || a.fill !== b.fill || a.stroke !== b.stroke) return false
  if (a.strokeWidth !== b.strokeWidth || a.dash !== b.dash || a.shadow !== b.shadow || a.isCentral !== b.isCentral) return false
  if (a.childCount !== b.childCount || a.collapsed !== b.collapsed || a.hidden !== b.hidden) return false
  if (a.hasNote !== b.hasNote || a.hasUrl !== b.hasUrl) return false
  if (a.notePos?.x !== b.notePos?.x || a.notePos?.y !== b.notePos?.y || a.urlPos?.x !== b.urlPos?.x || a.urlPos?.y !== b.urlPos?.y) return false
  if (a.effectivePadding?.join(',') !== b.effectivePadding?.join(',')) return false
  if (a.edgeColor !== b.edgeColor || a.edgeWidth !== b.edgeWidth || a.edgeRouting !== b.edgeRouting || a.accent !== b.accent) return false
  const at = a.textStyle, bt = b.textStyle
  if (at.font !== bt.font || at.sizePx !== bt.sizePx || at.color !== bt.color || at.hAlign !== bt.hAlign || at.weight !== bt.weight || at.italic !== bt.italic || at.underline !== bt.underline || at.strike !== bt.strike) return false
  if (a.textArea.x !== b.textArea.x || a.textArea.y !== b.textArea.y || a.textArea.w !== b.textArea.w || a.textArea.h !== b.textArea.h) return false
  if (a.textLines.length !== b.textLines.length) return false
  for (let i = 0; i < a.textLines.length; i++) {
    if (a.textLines[i].text !== b.textLines[i].text || a.textLines[i].width !== b.textLines[i].width) return false
  }
  if (!!a.icon !== !!b.icon) return false
  if (a.icon && b.icon && (a.icon.id !== b.icon.id || a.icon.x !== b.icon.x || a.icon.y !== b.icon.y || a.icon.size !== b.icon.size)) return false
  if (!!a.checkbox !== !!b.checkbox) return false
  if (a.checkbox && b.checkbox && (a.checkbox.x !== b.checkbox.x || a.checkbox.y !== b.checkbox.y || a.checkbox.size !== b.checkbox.size || a.checkbox.checked !== b.checkbox.checked || a.checkbox.uncheckedFill !== b.checkbox.uncheckedFill || a.checkbox.borderColor !== b.checkbox.borderColor)) return false
  if (!!a.numbering !== !!b.numbering) return false
  if (a.numbering && b.numbering && (a.numbering.text !== b.numbering.text || a.numbering.x !== b.numbering.x || a.numbering.y !== b.numbering.y)) return false
  if (!!a.dateText !== !!b.dateText) return false
  if (a.dateText && b.dateText && (a.dateText.text !== b.dateText.text || a.dateText.x !== b.dateText.x || a.dateText.y !== b.dateText.y)) return false
  if (a.textLineY.length !== b.textLineY.length) return false
  for (let i = 0; i < a.textLineY.length; i++) if (a.textLineY[i] !== b.textLineY[i]) return false
  if (!!a.image !== !!b.image) return false
  if (a.image && b.image && (a.image.href !== b.image.href || a.image.x !== b.image.x || a.image.y !== b.image.y || a.image.w !== b.image.w || a.image.h !== b.image.h || a.image.fit !== b.image.fit)) return false
  return true
}
function sameEdge(a: SceneEdge, b: SceneEdge): boolean {
  return a.d === b.d && a.color === b.color && a.width === b.width && a.dash === b.dash && a.from === b.from && a.to === b.to
}
function sameCrosslink(a: SceneCrosslink, b: SceneCrosslink): boolean {
  return a.d === b.d && a.color === b.color && a.width === b.width && a.dash === b.dash
    && a.arrowStart === b.arrowStart && a.arrowEnd === b.arrowEnd && a.label === b.label
    && a.labelBg === b.labelBg && a.labelText === b.labelText && a.labelBaselineY === b.labelBaselineY
    && a.mid.x === b.mid.x && a.mid.y === b.mid.y
    && a.labelBox?.x === b.labelBox?.x && a.labelBox?.y === b.labelBox?.y
    && a.labelBox?.w === b.labelBox?.w && a.labelBox?.h === b.labelBox?.h
}
function sameDrawing(a: SceneDrawing, b: SceneDrawing): boolean {
  if (a.d !== b.d) return false
  const x = a.obj, y = b.obj
  return x.kind === y.kind && x.color === y.color && x.width_world === y.width_world && x.opacity === y.opacity && x.fill === y.fill && x.layer_order === y.layer_order
}

function boxOverlapArea(a: Box, b: Box, pad = 0): number {
  const ox = Math.min(a.x + a.w, b.x + b.w + pad) - Math.max(a.x, b.x - pad)
  if (ox <= 0) return 0
  const oy = Math.min(a.y + a.h, b.y + b.h + pad) - Math.max(a.y, b.y - pad)
  return oy > 0 ? ox * oy : 0
}

export function buildScene(doc: ProjectDocV3, opts: SceneOpts = {}): Scene {
  beginTextMeasurementSession()
  try {
    return buildSceneInner(doc, opts)
  } finally {
    endTextMeasurementSession()
  }
}

function buildSceneInner(doc: ProjectDocV3, opts: SceneOpts = {}): Scene {
  const theme = getTheme(doc.theme_id)
  // Index O(1) của doc GỐC (style luôn resolve theo doc gốc)
  const docIdx = buildIndex(doc)
  const styleMemo = new Map<string, ResolvedStyle>()
  const numbering = buildNumbering(doc, docIdx)
  const measurements = new Map<string, ReturnType<typeof measureNodeContent>>()
  const sizeOf = (t: Topic) => {
    let measured = measurements.get(t.id)
    if (!measured) {
      measured = measureNodeContent(doc, t, resolveStyle(doc, t, docIdx, styleMemo), numbering.get(t.id))
      measurements.set(t.id, measured)
    }
    return measured
  }
  // Scope: toàn bộ hoặc nhánh được chọn
  let scopeDoc = doc
  if (opts.scopeRoot) {
    const root = getTopic(doc, opts.scopeRoot)
    if (root) {
      const ids = new Set<string>([root.id])
      const collect = (pid: string) => idxChildren(docIdx, pid).forEach((c) => { ids.add(c.id); collect(c.id) })
      collect(root.id)
      scopeDoc = { ...doc, topics: doc.topics.filter((t) => ids.has(t.id)), central_topic_id: root.id, crosslinks: doc.crosslinks.filter((c) => ids.has(c.source) && ids.has(c.target)) }
    }
  }
  // IncludeCollapsed: mở tạm toàn bộ (không mutate)
  let layoutDoc = scopeDoc
  if (opts.includeCollapsed) {
    layoutDoc = { ...scopeDoc, topics: scopeDoc.topics.map((t) => ({ ...t, collapsed: false })) }
  }
  const scopeIdx = scopeDoc === doc ? docIdx : buildIndex(scopeDoc)
  const layoutIdx = layoutDoc === scopeDoc ? scopeIdx : buildIndex(layoutDoc)
  const layoutResult = computeLayout(layoutDoc, sizeOf, layoutDoc.layout, layoutIdx)
  const orientation = orientationOf(layoutDoc.layout.kind)

  const nodes: SceneNode[] = []
  const byId = new Map<string, SceneNode>()
  const prevNodes = sceneCache?.nodes ?? null
  const nextNodeCache = new Map<string, SceneNode>()
  const themeDark = isDarkSurface(theme.canvas, false)

  for (const t of scopeDoc.topics) {
    const box = layoutResult.pos.get(t.id)
    if (!box) continue
    const st = resolveStyle(doc, t, docIdx, styleMemo) // style resolve theo doc gốc (giữ override người dùng)
    const measured = sizeOf(t)
    const tb = measured.tb
    // Kích thước đã có trong kết quả layout (sizeOf đã chạy lúc buildRT) — không đo lại
    const px = q(box.w), py = q(box.h)
    const bx = q(box.x), by = q(box.y)
    const [padT, padR, padB, padL] = measured.effectivePadding
    // bố trí nội dung
    let contentX = bx + padL
    const iconSize = t.icon ? (t.icon.size === 's' ? 16 : t.icon.size === 'm' ? 20 : 26) : 0
    const cbSize = t.checkbox !== null && t.checkbox !== undefined ? 18 : 0
    const imgW = t.image && (t.image.placement === 'left' || t.image.placement === 'right') ? measured.image.w : 0
    const imgH2 = t.image && (t.image.placement === 'left' || t.image.placement === 'right') ? measured.image.h : 0
    if (t.image && (t.image.placement === 'left')) contentX += imgW + 8
    const leftW = measured.leftW
    const textAreaX = contentX + leftW + measured.inset.left
    const textAreaW = Math.max(24, px - padL - padR - leftW - measured.inset.left - measured.inset.right - (t.image && (t.image.placement === 'left' || t.image.placement === 'right') ? imgW + 8 : 0))
    const vertImg = t.image && (t.image.placement === 'above' || t.image.placement === 'below') ? measured.image : null
    const dateH = t.date ? 14 * PT_TO_WORLD : 0
    const badgeExtraH = measured.badgeExtraH
    const aboveH = vertImg && t.image?.placement === 'above' ? vertImg.h + 8 : 0
    const belowH = vertImg && t.image?.placement === 'below' ? vertImg.h + 8 : 0
    const contentTop = by + padT + aboveH
    const contentBottom = by + py - padB - belowH - dateH - badgeExtraH
    const accessoryH = Math.max(iconSize ? iconSize + 2 : 0, cbSize)
    const textGroupH = Math.max(16, tb.height + measured.inset.top + measured.inset.bottom, accessoryH)
    const free = Math.max(0, contentBottom - contentTop - textGroupH)
    const verticalOffset = st.text.vAlign === 'top' ? 0 : st.text.vAlign === 'bottom' ? free : free / 2
    const textTop = contentTop + verticalOffset + measured.inset.top
    const textAreaH = Math.max(16, tb.height)
    const darkNode = isDarkSurface(st.box.fill, themeDark)
    const badgeY = st.box.shape === 'pill' ? q(by + py - padB - 6) : q(by + py - 8)
    const noteX = st.box.shape === 'pill' ? q(bx + px - padR - 6) : q(bx + px - 10)
    const urlX = st.box.shape === 'pill' ? q(noteX - (t.notes ? 14 : 0)) : q(bx + px - (t.notes ? 24 : 10))
    const node: SceneNode = {
      id: t.id,
      box: { x: bx, y: by, w: px, h: py },
      requestedBox: st.box.sizeMode === 'fixed' ? { w: st.box.width ?? 160, h: st.box.height ?? 60 } : undefined,
      shape: st.box.shape,
      r: st.box.shape === 'pill' ? q(pillRadius(px, py)) : st.box.cornerRadius,
      effectivePadding: measured.effectivePadding,
      notePos: t.notes ? { x: noteX, y: badgeY } : undefined,
      urlPos: t.url ? { x: urlX, y: badgeY } : undefined,
      fill: st.box.fill,
      stroke: st.box.stroke,
      strokeWidth: st.box.strokeWidth,
      dash: st.box.dash,
      shadow: st.box.shadow === 'soft',
      isCentral: t.id === doc.central_topic_id,
      textLines: tb.lines,
      textLineY: tb.lineY,
      textStyle: {
        font: fontString(st.text),
        fontFamily: st.text.fontFamily,
        sizePx: st.text.fontSizePt * PT_TO_WORLD,
        color: st.text.color,
        hAlign: st.text.hAlign,
        weight: st.text.fontWeight,
        italic: st.text.italic,
        underline: st.text.underline,
        strike: st.text.strike,
      },
      textArea: { x: textAreaX, y: textTop, w: textAreaW, h: textAreaH },
      textBounds: { x: textAreaX - measured.inset.left, y: textTop - measured.inset.top, w: textAreaW + measured.inset.left + measured.inset.right, h: textAreaH + measured.inset.top + measured.inset.bottom },
      icon: t.icon ? { id: t.icon.icon_id, x: contentX, y: textTop - measured.inset.top + 2, size: iconSize } : undefined,
      checkbox: cbSize ? {
        x: contentX + (t.icon ? iconSize + 6 : 0),
        y: textTop - measured.inset.top + Math.max(0, (Math.min(textAreaH, 24) - cbSize) / 2),
        size: cbSize,
        checked: t.checkbox === true,
        uncheckedFill: darkNode ? '#0F172A' : '#FFFFFF',
        borderColor: darkNode ? '#94A3B8' : '#64748B',
      } : undefined,
      numbering: numbering.get(t.id) ? { text: numbering.get(t.id)!, x: contentX + (t.icon ? iconSize + 6 : 0) + (cbSize ? cbSize + 6 : 0), y: textTop } : undefined,
      dateText: t.date ? { text: t.date, x: bx + padL, y: contentBottom + 2 } : undefined,
      image: t.image ? imageRect(doc, t, st, box, vertImg, { w: imgW, h: imgH2 }, badgeExtraH, measured.effectivePadding) : undefined,
      hasNote: !!t.notes,
      hasUrl: !!t.url,
      edgeColor: st.edge.color,
      edgeWidth: st.edge.width,
      edgeRouting: st.edge.routing,
      accent: st.accent,
      childCount: idxChildren(scopeIdx, t.id).length,
      collapsed: !!t.collapsed,
      hidden: layoutResult.hiddenCount.get(t.id) ?? 0,
    }
    // Tái dụng object lượt trước nếu hiển thị không đổi → node không đổi
    // không bị re-render/ghi DOM (chìa khoá của React.memo bên Canvas)
    const prev = prevNodes?.get(t.id)
    const stable = prev && sameNode(prev, node) ? prev : node
    nodes.push(stable)
    nextNodeCache.set(t.id, stable)
    byId.set(t.id, stable)
  }

  // Hierarchy edges
  const orgBusY = new Map<string, number>()
  if (layoutDoc.layout.kind === 'organization' || layoutDoc.layout.kind === 'tree') {
    const closestChildY = new Map<string, number>()
    for (const t of scopeDoc.topics) {
      if (!t.parent_id) continue
      const a = byId.get(t.parent_id)
      const b = byId.get(t.id)
      if (!a || !b) continue
      const down = b.box.y + b.box.h / 2 >= a.box.y + a.box.h / 2
      const childEdge = down ? b.box.y : b.box.y + b.box.h
      const prev = closestChildY.get(t.parent_id)
      if (prev == null || (down ? childEdge < prev : childEdge > prev)) {
        closestChildY.set(t.parent_id, childEdge)
      }
    }
    for (const [pid, cy] of closestChildY) {
      const a = byId.get(pid)
      if (!a) continue
      const firstChild = idxChildren(scopeIdx, pid).map((c) => byId.get(c.id)).find(Boolean)
      const down = firstChild ? firstChild.box.y + firstChild.box.h / 2 >= a.box.y + a.box.h / 2 : true
      const parentEdge = down ? a.box.y + a.box.h : a.box.y
      orgBusY.set(pid, q((parentEdge + cy) / 2))
    }
  }
  const fishboneHeadDir: 1 | -1 = layoutDoc.layout.direction === 'left' ? -1 : 1
  const mainDepth = new Map<string, number>()
  if (layoutDoc.layout.kind === 'fishbone') {
    mainDepth.set(scopeDoc.central_topic_id, 0)
    const walkDepth = (pid: string, d: number) => {
      for (const ch of idxChildren(scopeIdx, pid)) {
        mainDepth.set(ch.id, d)
        walkDepth(ch.id, d + 1)
      }
    }
    walkDepth(scopeDoc.central_topic_id, 1)
  }
  const edges: SceneEdge[] = []
  const prevEdges = sceneCache?.edges ?? null
  const nextEdgeCache = new Map<string, SceneEdge>()
  if (layoutDoc.layout.kind === 'fishbone') {
    const centralId = scopeDoc.central_topic_id
    const cenNode = byId.get(centralId)
    const cenTopic = getTopic(doc, centralId)
    const catNodes = idxChildren(scopeIdx, centralId).map((c) => byId.get(c.id)).filter((n): n is SceneNode => !!n)
    if (cenNode && cenTopic && catNodes.length > 0) {
      const spineXs = catNodes.map((b) => {
        const cTipX = b.box.x + b.box.w / 2
        const cEdgeY = b.box.y + b.box.h / 2 < 0 ? b.box.y + b.box.h : b.box.y
        return cTipX + fishboneHeadDir * FISHBONE_RIB_SLOPE * Math.abs(cEdgeY)
      })
      const tailX = q(fishboneHeadDir === 1 ? Math.min(...spineXs) - 44 : Math.max(...spineXs) + 44)
      const headX = q(fishboneHeadDir === 1 ? cenNode.box.x : cenNode.box.x + cenNode.box.w)
      const cenSt = resolveStyle(doc, cenTopic, docIdx, styleMemo)
      const spineEdge: SceneEdge = {
        id: 'fishbone-spine',
        d: `M ${tailX} 0 L ${headX} 0`,
        color: cenSt.edge.color,
        width: Math.max(3, q(cenSt.edge.width * 1.4)),
        dash: 'solid',
        from: centralId,
        to: centralId,
      }
      const prev = prevEdges?.get('fishbone-spine')
      const stable = prev && sameEdge(prev, spineEdge) ? prev : spineEdge
      edges.push(stable)
      nextEdgeCache.set('fishbone-spine', stable)
    }
  }
  for (const t of scopeDoc.topics) {
    if (!t.parent_id) continue
    const a = byId.get(t.parent_id)
    const b = byId.get(t.id)
    if (!a || !b) continue
    const st = resolveStyle(doc, t, docIdx, styleMemo)
    const fbDepth = layoutDoc.layout.kind === 'fishbone' ? mainDepth.get(t.id) : undefined
    const { d } = edgeD(a.box, b.box, st.edge.routing, orientation, {
      layoutKind: layoutDoc.layout.kind,
      busY: orgBusY.get(t.parent_id),
      fishbone: fbDepth !== undefined ? { depth: fbDepth === 1 ? 1 : fbDepth === 2 ? 2 : 3, headDir: fishboneHeadDir } : undefined,
    })
    const edge: SceneEdge = { id: `e-${t.id}`, d, color: st.edge.color, width: st.edge.width, dash: st.edge.dash, from: t.parent_id, to: t.id }
    const prev = prevEdges?.get(`e-${t.id}`)
    const stable = prev && sameEdge(prev, edge) ? prev : edge
    edges.push(stable)
    nextEdgeCache.set(`e-${t.id}`, stable)
  }

  // Crosslinks (border-anchored quadratic curve + collision-free label placement)
  const crosslinks: SceneCrosslink[] = []
  const prevCross = sceneCache?.crosslinks ?? null
  const nextCrossCache = new Map<string, SceneCrosslink>()
  const placedLabels: Box[] = []
  const labelBg = themeDark ? '#1E293B' : '#FFFFFF'
  const labelText = themeDark ? '#F1F5F9' : '#1E293B'
  for (const c of scopeDoc.crosslinks) {
    const a = byId.get(c.source), b = byId.get(c.target)
    if (!a || !b) continue
    const ac = { x: a.box.x + a.box.w / 2, y: a.box.y + a.box.h / 2 }
    const bc = { x: b.box.x + b.box.w / 2, y: b.box.y + b.box.h / 2 }
    const dx = bc.x - ac.x, dy = bc.y - ac.y
    const dist = Math.hypot(dx, dy) || 1
    let nx = -dy / dist, ny = dx / dist
    if (Math.abs(dx) >= Math.abs(dy) ? ny < 0 : nx < 0) { nx = -nx; ny = -ny }
    const bow = Math.min(64, Math.max(24, dist * 0.22))
    const rawCtrl = c.waypoints?.length
      ? c.waypoints[0]
      : { x: (ac.x + bc.x) / 2 + nx * bow, y: (ac.y + bc.y) / 2 + ny * bow }
    const p1 = shapeBorderAnchor(a.box, a.shape, a.r, rawCtrl)
    const p2 = shapeBorderAnchor(b.box, b.shape, b.r, rawCtrl)
    const qp1 = { x: q(p1.x), y: q(p1.y) }
    const qp2 = { x: q(p2.x), y: q(p2.y) }
    const qCtrl = { x: q(rawCtrl.x), y: q(rawCtrl.y) }
    const d = `M ${qp1.x} ${qp1.y} Q ${qCtrl.x} ${qCtrl.y} ${qp2.x} ${qp2.y}`
    const quadAt = (t: number) => ({
      x: (1 - t) * (1 - t) * qp1.x + 2 * (1 - t) * t * qCtrl.x + t * t * qp2.x,
      y: (1 - t) * (1 - t) * qp1.y + 2 * (1 - t) * t * qCtrl.y + t * t * qp2.y,
    })
    let mid = quadAt(0.5)
    mid = { x: q(mid.x), y: q(mid.y) }
    let labelBox: Box | undefined
    let labelBaselineY: number | undefined
    if (c.label) {
      const { size, family } = CROSSLINK_LABEL_FONT
      const m = measureCenteredText(c.label, `${size}px ${family}`)
      const half = Math.ceil(Math.max(m.width / 2, m.actualBoundingBoxLeft, m.actualBoundingBoxRight)) + 6
      const ascent = Math.max(8, m.actualBoundingBoxAscent || 8)
      const descent = Math.max(3, m.actualBoundingBoxDescent || 3)
      const labelW = half * 2
      const labelH = Math.ceil(ascent + descent + 8)
      const tCandidates = [0.5, 0.35, 0.65, 0.25, 0.75]
      const normalOffsets = [0, 18, -18, 36, -36, 56, -56]
      let bestScore = Infinity
      let bestCenter = mid
      let foundZero = false
      for (const tc of tCandidates) {
        if (foundZero) break
        const base = quadAt(tc)
        const tx = 2 * (1 - tc) * (qCtrl.x - qp1.x) + 2 * tc * (qp2.x - qCtrl.x)
        const ty = 2 * (1 - tc) * (qCtrl.y - qp1.y) + 2 * tc * (qp2.y - qCtrl.y)
        const tLen = Math.hypot(tx, ty) || 1
        const lnx = -ty / tLen, lny = tx / tLen
        for (const off of normalOffsets) {
          const cx = base.x + lnx * off
          const cy = base.y + lny * off
          const cand: Box = { x: cx - half, y: cy - labelH / 2, w: labelW, h: labelH }
          let overlap = 0
          for (const n of nodes) overlap += boxOverlapArea(cand, n.box, 4)
          for (const lb of placedLabels) overlap += boxOverlapArea(cand, lb, 2)
          if (overlap < bestScore) {
            bestScore = overlap
            bestCenter = { x: q(cx), y: q(cy) }
            if (overlap === 0) { foundZero = true; break }
          }
        }
      }
      mid = bestCenter
      labelBox = { x: q(mid.x - half), y: q(mid.y - labelH / 2), w: labelW, h: labelH }
      labelBaselineY = q(mid.y + (ascent - descent) / 2)
      placedLabels.push(labelBox)
    }
    const sc: SceneCrosslink = {
      id: c.id,
      d,
      p1: qp1,
      ctrl: qCtrl,
      p2: qp2,
      color: c.color ?? '#8B5CF6',
      width: c.width_world ?? 2,
      dash: c.dash ?? 'dashed',
      arrowStart: !!c.arrow_start,
      arrowEnd: c.arrow_end !== false,
      label: c.label ?? undefined,
      labelBox,
      labelBg,
      labelText,
      labelBaselineY,
      mid,
      source: c.source,
      target: c.target,
    }
    const prev = prevCross?.get(c.id)
    const stable = prev && sameCrosslink(prev, sc) ? prev : sc
    crosslinks.push(stable)
    nextCrossCache.set(c.id, stable)
  }

  // Drawings (world-space, LOCK-07, sorted stably by layer_order)
  const drawings: SceneDrawing[] = []
  const prevDraw = sceneCache?.drawings ?? null
  const nextDrawCache = new Map<string, SceneDrawing>()
  const branchBounds = opts.scopeRoot && opts.includeDrawings !== false && doc.drawings.length
    ? computeBounds(nodes, edges, [], crosslinks) : null
  if (opts.includeDrawings !== false) {
    const sortedDrawings = doc.drawings
      .map((obj, index) => ({ obj, index }))
      .sort((a, b) => (a.obj.layer_order - b.obj.layer_order) || (a.index - b.index))
    for (const { obj } of sortedDrawings) {
      const dr: SceneDrawing = { obj, d: drawingD(obj) }
      if (branchBounds) {
        if (!obj.points.length) continue
        const b = computeBounds([], [], [dr], [])
        const margin = 20
        if (b.x + b.w < branchBounds.x - margin || b.y + b.h < branchBounds.y - margin
          || b.x > branchBounds.x + branchBounds.w + margin || b.y > branchBounds.y + branchBounds.h + margin) continue
      }
      const prev = prevDraw?.get(obj.id)
      const stable = prev && sameDrawing(prev, dr) ? prev : dr
      drawings.push(stable)
      nextDrawCache.set(obj.id, stable)
    }
  }

  // Tái dụng chính mảng nodes/edges khi toàn bộ phần tử giữ nguyên nhận dạng
  // → các layer memo bên Canvas được bỏ qua hoàn toàn khi scene không đổi hình ảnh
  let nodesStable = nodes
  if (sceneCache && sceneCache.nodesArr.length === nodes.length && nodes.every((n, i) => n === sceneCache!.nodesArr[i])) nodesStable = sceneCache.nodesArr
  let edgesStable = edges
  if (sceneCache && sceneCache.edgesArr.length === edges.length && edges.every((e, i) => e === sceneCache!.edgesArr[i])) edgesStable = sceneCache.edgesArr
  sceneCache = { nodes: nextNodeCache, edges: nextEdgeCache, crosslinks: nextCrossCache, drawings: nextDrawCache, nodesArr: nodesStable, edgesArr: edgesStable }

  // Bounds (14.7: gồm stroke, text, ảnh, drawings)
  const bounds = computeBounds(nodes, edges, drawings, crosslinks)
  return { nodes: nodesStable, edges: edgesStable, crosslinks, drawings, byId, bounds, layoutResult, canvasBg: theme.canvas }
}

function imgDims(doc: ProjectDocV3, t: Topic, st: ResolvedStyle): { w: number; h: number } {
  const a = doc.assets.find((x) => x.id === t.image!.asset_id)
  if (!a) return { w: 0, h: 0 }
  const base = st.text.wrap ? st.text.wrapWidth : 360
  const targetW = base * clamp01(t.image!.width_fraction || 0.4)
  const ratio = a.height / Math.max(1, a.width)
  const maxH = 160
  let w = targetW, h = targetW * ratio
  if (t.image!.placement === 'left' || t.image!.placement === 'right') {
    if (t.image!.fit === 'cover') h = Math.min(h, maxH)
    else if (h > maxH) { w = maxH * (a.width / Math.max(1, a.height)); h = maxH }
  }
  return { w, h }
}
function imageRect(
  doc: ProjectDocV3,
  t: Topic,
  st: ResolvedStyle,
  box: Box,
  vert: { w: number; h: number } | null,
  horiz: { w: number; h: number },
  badgeExtraH = 0,
  effPads: readonly [number, number, number, number] = st.text.padding,
): { href: string; x: number; y: number; w: number; h: number; fit: 'contain' | 'cover' } | undefined {
  const a = doc.assets.find((x) => x.id === t.image!.asset_id)
  if (!a || !embeddedBitmap(a.data_url)) return undefined
  const [padT, padR, padB, padL] = effPads
  const fit = t.image!.fit
  if (vert) {
    return { href: a.data_url, fit, x: q(box.x + padL), y: q(t.image!.placement === 'below' ? box.y + box.h - padB - badgeExtraH - vert.h : box.y + padT), w: q(vert.w), h: q(vert.h) }
  }
  if (t.image!.placement === 'left') {
    return { href: a.data_url, fit, x: q(box.x + padL), y: q(box.y + box.h / 2 - horiz.h / 2), w: q(horiz.w), h: q(horiz.h) }
  }
  if (t.image!.placement === 'right') {
    return { href: a.data_url, fit, x: q(box.x + box.w - padR - horiz.w), y: q(box.y + box.h / 2 - horiz.h / 2), w: q(horiz.w), h: q(horiz.h) }
  }
  return undefined
}

function drawingD(obj: DrawingObject): string {
  const pts = obj.points
  if (!pts.length) return ''
  if (obj.kind === 'rect' || obj.kind === 'line' || obj.kind === 'ellipse') {
    const [p1, p2] = [pts[0], pts[pts.length - 1]]
    if (obj.kind === 'line') return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`
    const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y)
    const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y)
    if (obj.kind === 'rect') return `M ${x} ${y} h ${w} v ${h} h ${-w} Z`
    return `M ${x + w / 2} ${y} a ${w / 2} ${h / 2} 0 1 0 0.01 0 Z`
  }
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`
  return d
}

export function computeBounds(nodes: SceneNode[], edges: SceneEdge[], drawings: SceneDrawing[], crosslinks: SceneCrosslink[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const push = (x: number, y: number) => {
    if (!isFinite(x) || !isFinite(y)) return
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
  }
  nodes.forEach((n) => {
    push(n.box.x - n.strokeWidth / 2, n.box.y - n.strokeWidth / 2)
    push(n.box.x + n.box.w + n.strokeWidth / 2 + (n.shadow ? 6 : 0), n.box.y + n.box.h + n.strokeWidth / 2 + (n.shadow ? 6 : 0))
    if (n.image) { push(n.image.x, n.image.y); push(n.image.x + n.image.w, n.image.y + n.image.h) }
    push(n.textBounds.x, n.textBounds.y)
    push(n.textBounds.x + n.textBounds.w, n.textBounds.y + n.textBounds.h)
  })
  edges.forEach((e) => {
    const nums = e.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
    for (let i = 0; i < nums.length; i += 2) {
      const hw = e.width / 2
      push(nums[i] - hw, nums[i + 1] - hw)
      push(nums[i] + hw, nums[i + 1] + hw)
    }
  })
  crosslinks.forEach((c) => {
    const nums = c.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
    for (let i = 0; i < nums.length; i += 2) push(nums[i], nums[i + 1])
    if (c.labelBox) {
      const b = c.labelBox
      const half = CROSSLINK_LABEL_FONT.stroke / 2
      push(b.x - half, b.y - half)
      push(b.x + b.w + half, b.y + b.h + half)
    }
  })
  drawings.forEach((dr) => {
    dr.obj.points.forEach((p) => {
      const hw = dr.obj.width_world / 2 + 2
      push(p.x - hw, p.y - hw)
      push(p.x + hw, p.y + hw)
    })
  })
  if (!isFinite(minX)) return { x: 0, y: 0, w: 200, h: 120 }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

/* ============================================================
 * sceneToSVG — canonical SVG (dùng cho export SVG/PNG/PDF + preview)
 * ============================================================ */
export interface SVGOptions {
  background: 'transparent' | 'white' | 'canvas'
  padding: number // world units
  includeUI?: boolean // chưa dùng: badge collapsed v.v.
}
export function sceneToSVG(scene: Scene, opts: SVGOptions): string {
  const pad = opts.padding
  const vb = {
    x: scene.bounds.x - pad,
    y: scene.bounds.y - pad,
    w: scene.bounds.w + pad * 2,
    h: scene.bounds.h + pad * 2,
  }
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="${Math.round(vb.w)}" height="${Math.round(vb.h)}">`)
  if (opts.background !== 'transparent') {
    const color = opts.background === 'white' ? '#FFFFFF' : scene.canvasBg
    parts.push(`<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="${svgPaint(color)}"/>`)
  }
  const drawingSVG = (dr: SceneDrawing) => {
    const o = dr.obj
    if (o.kind === 'rect' || o.kind === 'ellipse') {
      return `<path d="${esc(String(dr.d))}" fill="${svgPaint(o.fill ?? 'none')}" stroke="${svgPaint(o.color)}" stroke-width="${esc(String(o.width_world))}" opacity="${esc(String(o.opacity))}"/>`
    }
    return `<path d="${esc(String(dr.d))}" fill="none" stroke="${svgPaint(o.color)}" stroke-width="${esc(String(o.width_world))}" opacity="${esc(String(o.opacity))}" stroke-linecap="round" stroke-linejoin="round"/>`
  }
  // 1a. back drawings (layer_order < 0)
  for (const dr of scene.drawings) if (dr.obj.layer_order < 0) parts.push(drawingSVG(dr))
  // 1b. hierarchy edges
  parts.push('<g>')
  for (const e of scene.edges) {
    const da = dashAttr(e.dash)
    parts.push(`<path d="${esc(String(e.d))}" fill="none" stroke="${svgPaint(e.color)}" stroke-width="${esc(String(e.width))}"${da ? ` stroke-dasharray="${da}"` : ''} stroke-linecap="round"/>`)
  }
  parts.push('</g>')
  // 1c. crosslink paths + arrowheads (under node boxes)
  for (const c of scene.crosslinks) {
    const da = dashAttr(c.dash)
    parts.push(`<path d="${esc(String(c.d))}" fill="none" stroke="${svgPaint(c.color)}" stroke-width="${esc(String(c.width))}"${da ? ` stroke-dasharray="${da}"` : ''}/>` + arrowSVG(c.d, c.arrowEnd, c.color) + arrowSVGStart(c.d, c.arrowStart, c.color))
  }
  // 2. nodes
  for (const [index, n] of scene.nodes.entries()) {
    parts.push(nodeSVG(n, index))
  }
  // 3. crosslink labels (positioned clear of nodes)
  for (const c of scene.crosslinks) {
    if (c.label && c.labelBox) {
      const b = c.labelBox
      const { family, size, stroke } = CROSSLINK_LABEL_FONT
      const by = c.labelBaselineY ?? c.mid.y + 3
      parts.push(`<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5" fill="${svgPaint(c.labelBg)}" stroke="${svgPaint(c.color)}" stroke-width="${stroke}"/><text x="${c.mid.x}" y="${by}" font-family="${family}" font-size="${size}" fill="${svgPaint(c.labelText)}" text-anchor="middle">${esc(c.label)}</text></g>`)
    }
  }
  // 4. front drawings (layer_order >= 0)
  for (const dr of scene.drawings) if (dr.obj.layer_order >= 0) parts.push(drawingSVG(dr))
  parts.push('</svg>')
  return parts.join('\n')
}

function nodeSVG(n: SceneNode, index: number): string {
  const parts: string[] = []
  const { box } = n
  let shapeD = ''
  if (n.shape === 'rect') shapeD = `M ${box.x} ${box.y} h ${box.w} v ${box.h} h ${-box.w} Z`
  else if (n.shape === 'pill') shapeD = pillPath(box)
  else shapeD = roundRectPath(box, Math.min(n.r, box.w / 2, box.h / 2))
  if (n.shadow) {
    parts.push(`<path d="${shapeD}" transform="translate(3,4)" fill="rgba(15,23,42,0.10)"/>`)
  }
  parts.push(`<path d="${shapeD}" fill="${svgPaint(n.fill)}" stroke="${svgPaint(n.strokeWidth > 0 ? n.stroke : 'none')}" stroke-width="${n.strokeWidth}"${n.dash !== 'solid' ? ` stroke-dasharray="${dashAttr(n.dash)}"` : ''}/>`)
  // text
  const t = n.textStyle
  const anchor = t.hAlign === 'center' ? 'middle' : t.hAlign === 'right' ? 'end' : 'start'
  const tx = t.hAlign === 'center' ? n.textArea.x + n.textArea.w / 2 : t.hAlign === 'right' ? n.textArea.x + n.textArea.w : n.textArea.x
  const lineH = t.sizePx
  const decor: string[] = []
  if (t.underline) decor.push('underline')
  if (t.strike) decor.push('line-through')
  if (n.textLines.length) {
    const tspans = n.textLines.map((l, i) => `<tspan x="${tx}" y="${n.textArea.y + n.textLineY[i]}">${esc(l.text)}</tspan>`).join('')
    parts.push(`<text font-family="${esc(t.fontFamily)}" font-size="${t.sizePx}" font-weight="${esc(String(t.weight))}" font-style="${t.italic ? 'italic' : 'normal'}" fill="${svgPaint(t.color)}" text-anchor="${anchor}"${decor.length ? ` text-decoration="${decor.join(' ')}"` : ''}>${tspans}</text>`)
  }
  if (n.dateText) {
    parts.push(`<text x="${n.dateText.x}" y="${n.dateText.y + 11}" font-family="Noto Sans, sans-serif" font-size="10.7" fill="${svgPaint(t.color)}" opacity="0.75">${esc(n.dateText.text)}</text>`)
  }
  if (n.numbering) {
    parts.push(`<text x="${n.numbering.x}" y="${n.numbering.y + (n.textLineY[0] ?? lineH)}" font-family="Noto Sans, sans-serif" font-size="${Math.min(t.sizePx, 14)}" font-weight="600" fill="${svgPaint(t.color)}">${esc(n.numbering.text)}</text>`)
  }
  if (n.checkbox) {
    const c = n.checkbox
    parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.size}" height="${c.size}" rx="3" fill="${c.checked ? '#2563EB' : svgPaint(c.uncheckedFill)}" stroke="${svgPaint(c.checked ? '#1D4ED8' : c.borderColor)}" stroke-width="1.2"/>`)
    if (c.checked) parts.push(`<path d="M ${c.x + 4} ${c.y + c.size / 2} l 3.4 3.4 l 6.2 -7" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`)
  }
  if (n.icon) {
    parts.push(iconSVG(n.icon.id, n.icon.x, n.icon.y, n.icon.size, t.color))
  }
  if (n.image && embeddedBitmap(n.image.href)) {
    const clipId = `export-imgclip-${index}`
    if (n.image.fit === 'cover') {
      parts.push(`<clipPath id="${esc(clipId)}" clipPathUnits="userSpaceOnUse"><rect x="${n.image.x}" y="${n.image.y}" width="${n.image.w}" height="${n.image.h}"/></clipPath>`)
    }
    parts.push(`<image x="${n.image.x}" y="${n.image.y}" width="${n.image.w}" height="${n.image.h}" preserveAspectRatio="${n.image.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'}"${n.image.fit === 'cover' ? ` clip-path="url(#${esc(clipId)})"` : ''} xlink:href="${esc(String(n.image.href))}"/>`)
  }
  if (n.hasNote) {
    const np = n.notePos ?? { x: n.box.x + n.box.w - 10, y: n.box.y + n.box.h - 8 }
    parts.push(noteBadge(np.x, np.y))
  }
  if (n.hasUrl) {
    const up = n.urlPos ?? { x: n.box.x + n.box.w - (n.hasNote ? 24 : 10), y: n.box.y + n.box.h - 8 }
    parts.push(urlBadge(up.x, up.y))
  }
  return parts.join('\n')
}

function svgPaint(value: unknown): string {
  return typeof value === 'string' && /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\([0-9.,% +\-/]+\)|hsla?\([0-9.,% +\-/]+\))$/i.test(value) ? esc(value) : 'none'
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function roundRectPath(b: Box, r: number): string {
  return `M ${b.x + r} ${b.y} h ${b.w - 2 * r} a ${r} ${r} 0 0 1 ${r} ${r} v ${b.h - 2 * r} a ${r} ${r} 0 0 1 ${-r} ${r} h ${-(b.w - 2 * r)} a ${r} ${r} 0 0 1 ${-r} ${-r} v ${-(b.h - 2 * r)} a ${r} ${r} 0 0 1 ${r} ${-r} Z`
}
export function pillPath(b: Box): string {
  return roundRectPath(b, pillRadius(b.w, b.h))
}
function arrowSVG(d: string, on: boolean, color: string): string {
  if (!on) return ''
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
  const n = nums.length
  const x2 = nums[n - 2], y2 = nums[n - 1]
  const x1 = nums[n - 4], y1 = nums[n - 3]
  return arrowAt(x1, y1, x2, y2, color)
}
function arrowSVGStart(d: string, on: boolean, color: string): string {
  if (!on) return ''
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
  const x2 = nums[0], y2 = nums[1]
  const x1 = nums[2], y1 = nums[3]
  return arrowAt(x1, y1, x2, y2, color)
}
function arrowAt(x1: number, y1: number, x2: number, y2: number, color: string): string {
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const len = 9
  const a1 = { x: x2 - len * Math.cos(ang - 0.45), y: y2 - len * Math.sin(ang - 0.45) }
  const a2 = { x: x2 - len * Math.cos(ang + 0.45), y: y2 - len * Math.sin(ang + 0.45) }
  return `<path d="M ${a1.x} ${a1.y} L ${x2} ${y2} L ${a2.x} ${a2.y}" fill="none" stroke="${svgPaint(color)}" stroke-width="1.8" stroke-linecap="round"/>`
}
function noteBadge(x: number, y: number): string {
  return `<g transform="translate(${x},${y})"><path d="${NOTE_BADGE_PATH}" fill="#F59E0B" stroke="#B45309" stroke-width="0.6"/></g>`
}
function urlBadge(x: number, y: number): string {
  return `<g transform="translate(${x},${y})"><path d="${URL_BADGE_LINK_PATHS[0]}" fill="none" stroke="#0284C7" stroke-width="1.6" stroke-linecap="round"/><path d="${URL_BADGE_LINK_PATHS[1]}" fill="none" stroke="#0284C7" stroke-width="1.6" stroke-linecap="round"/></g>`
}

/* Icon vector nội bộ (06.3: 20–50 icon, không tải mạng) */
import { NODE_ICONS } from './icons'
function iconSVG(iconId: string, x: number, y: number, size: number, color: string): string {
  const icon = NODE_ICONS.find((i) => i.id === iconId)
  if (!icon) return `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="none" stroke="${svgPaint(color)}" stroke-dasharray="2 2"/>`
  const s = size / 24
  return `<g transform="translate(${x},${y}) scale(${s})"><path d="${esc(String(icon.path))}" fill="none" stroke="${svgPaint(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`
}
