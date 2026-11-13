/* ============================================================
 * OpenMindmap — lib/core/style.ts
 * Thuật toán resolve style (SRS 18.3):
 *   Theme → Role → Map overrides → AncestorBranch → Topic
 * + đo đạc kích thước node dựa trên TextLayoutService
 * ============================================================ */
import { ProjectDocV3, Topic, getTheme, WeightKind, HAlign, VAlign, ShapeKind, DashStyle, EdgeRouting } from './types'
import { getTopic, ancestorsOf, branchAccentFor, depthOf, TreeIndex, idxAncestors, idxTopic } from './tree'

export interface ResolvedTextStyle {
  fontFamily: string
  fontSizePt: number
  fontWeight: WeightKind
  italic: boolean
  underline: boolean
  strike: boolean
  color: string
  hAlign: HAlign
  vAlign: VAlign
  lineHeight: number
  paragraphGap: number
  wrap: boolean
  wrapWidth: number
  wrapWidthExplicit: boolean
  referenceFontSizePt: number
  padding: [number, number, number, number]
}
export interface ResolvedBoxStyle {
  shape: ShapeKind
  sizeMode: 'auto' | 'fixed'
  width: number | null
  height: number | null
  minWidth: number
  minHeight: number
  cornerRadius: number
  fill: string
  stroke: string
  strokeWidth: number
  dash: DashStyle
  shadow: ShadowPreset2
}
type ShadowPreset2 = 'none' | 'soft'
export interface ResolvedEdgeStyle {
  routing: EdgeRouting
  color: string
  width: number
  dash: DashStyle
}
export interface ResolvedStyle {
  text: ResolvedTextStyle
  box: ResolvedBoxStyle
  edge: ResolvedEdgeStyle
  accent: string
  inheritedFrom: string // 'theme' | topicId
}

/** Vai trò mặc định (16.4): Central 22 Bold, Level1 17 Semibold, Normal 14 Regular */
export function roleDefaults(doc: ProjectDocV3, topic: Topic): { size: number; weight: WeightKind; hAlign: HAlign } {
  if (topic.role === 'central') return { size: 22, weight: 700, hAlign: 'center' }
  if (topic.parent_id === doc.central_topic_id) return { size: 17, weight: 600, hAlign: 'left' }
  return { size: 14, weight: 400, hAlign: 'left' }
}

function applyTextStyle(base: ResolvedTextStyle, o: Record<string, unknown> | undefined) {
  if (!o) return
  const v = o as Record<string, unknown>
  if (typeof v.font_family === 'string') base.fontFamily = v.font_family
  if (typeof v.font_size_pt === 'number') base.fontSizePt = clamp(v.font_size_pt, 6, 96)
  if (typeof v.font_weight === 'number') base.fontWeight = v.font_weight as WeightKind
  if (typeof v.italic === 'boolean') base.italic = v.italic
  if (typeof v.underline === 'boolean') base.underline = v.underline
  if (typeof v.strike === 'boolean') base.strike = v.strike
  if (typeof v.color === 'string') base.color = v.color
  if (typeof v.horizontal_align === 'string') base.hAlign = v.horizontal_align as HAlign
  if (typeof v.vertical_align === 'string') base.vAlign = v.vertical_align as VAlign
  if (typeof v.line_height_multiplier === 'number') base.lineHeight = clamp(v.line_height_multiplier, 1, 2)
  if (typeof v.paragraph_gap_world === 'number') base.paragraphGap = clamp(v.paragraph_gap_world, 0, 32)
  if (typeof v.wrap === 'boolean') base.wrap = v.wrap
  if (typeof v.wrap_width_world === 'number') {
    base.wrapWidth = clamp(v.wrap_width_world, 80, 800)
    base.wrapWidthExplicit = true
  }
  if (Array.isArray(v.padding_world) && v.padding_world.length === 4) base.padding = (v.padding_world as number[]).map((x) => clamp(x, 0, 64)) as [number, number, number, number]
}
function applyBoxStyle(base: ResolvedBoxStyle, o: Record<string, unknown> | undefined) {
  if (!o) return
  const v = o as Record<string, unknown>
  if (v.shape === 'rect' || v.shape === 'rounded' || v.shape === 'pill') base.shape = v.shape
  if (v.size_mode === 'auto' || v.size_mode === 'fixed') base.sizeMode = v.size_mode
  if (typeof v.width_world === 'number') base.width = clamp(v.width_world, 32, 1200)
  if (typeof v.height_world === 'number') base.height = clamp(v.height_world, 24, 800)
  if (typeof v.min_width_world === 'number') base.minWidth = clamp(v.min_width_world, 0, 1200)
  if (typeof v.min_height_world === 'number') base.minHeight = clamp(v.min_height_world, 0, 800)
  if (typeof v.corner_radius_world === 'number') base.cornerRadius = clamp(v.corner_radius_world, 0, 32)
  if (typeof v.fill === 'string') base.fill = v.fill
  if (typeof v.stroke === 'string') base.stroke = v.stroke
  if (typeof v.stroke_width_world === 'number') base.strokeWidth = clamp(v.stroke_width_world, 0, 12)
  if (typeof v.stroke_dash === 'string') base.dash = v.stroke_dash as DashStyle
  if (v.shadow_preset === 'none' || v.shadow_preset === 'soft') base.shadow = v.shadow_preset
}
function applyEdgeStyle(base: ResolvedEdgeStyle, o: Record<string, unknown> | undefined) {
  if (!o) return
  const v = o as Record<string, unknown>
  if (typeof v.routing === 'string') base.routing = v.routing as EdgeRouting
  if (typeof v.color === 'string') base.color = v.color
  if (typeof v.width_world === 'number') base.width = clamp(v.width_world, 0.5, 12)
  if (typeof v.dash === 'string') base.dash = v.dash as DashStyle
}
function applyBranchInherit(base: ResolvedTextStyle, edge: ResolvedEdgeStyle, accent: { value: string | null }, o: Record<string, unknown> | undefined) {
  if (!o) return
  const v = o as Record<string, unknown>
  // Chỉ các field kế thừa được (18.2): text_color, font_family, font_size_pt, edge_color, edge_width, edge_routing, accent
  if (typeof v.text_color === 'string') base.color = v.text_color
  if (typeof v.font_family === 'string') base.fontFamily = v.font_family
  if (typeof v.font_size_pt === 'number') base.fontSizePt = clamp(v.font_size_pt, 6, 96)
  if (typeof v.edge_color === 'string') edge.color = v.edge_color
  if (typeof v.edge_width_world === 'number') edge.width = clamp(v.edge_width_world, 0.5, 12)
  if (typeof v.edge_routing === 'string') edge.routing = v.edge_routing as EdgeRouting
  if (typeof v.accent_color === 'string') accent.value = v.accent_color
}
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export const DEFAULT_TOPIC_FONT = 'Noto Sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'

/**
 * resolveStyle — thứ tự duy nhất: Theme → Role → Map → AncestorBranch → Topic.
 * Branch accent suy ra từ seed ổn định khi không có accent tường minh.
 * idx (tuỳ chọn): TreeIndex dùng lại cho đường nóng (buildScene/layout) —
 * giúp ancestorsOf/branchAccentFrom từ O(n) xuống O(depth) mỗi node.
 * cache (tuỳ chọn): Map<topicId, ResolvedStyle> dùng chung một lượt build.
 */
export function resolveStyle(doc: ProjectDocV3, topic: Topic, idx?: TreeIndex, cache?: Map<string, ResolvedStyle>): ResolvedStyle {
  if (cache) {
    const hit = cache.get(topic.id)
    if (hit) return hit
  }
  const st = resolveStyleInner(doc, topic, idx)
  if (cache) cache.set(topic.id, st)
  return st
}

function resolveStyleInner(doc: ProjectDocV3, topic: Topic, idx?: TreeIndex): ResolvedStyle {
  const theme = getTheme(doc.theme_id)
  const rd = roleDefaults(doc, topic)
  const isCentral = topic.role === 'central'
  const level1 = topic.parent_id === doc.central_topic_id
  const text: ResolvedTextStyle = {
    fontFamily: DEFAULT_TOPIC_FONT,
    fontSizePt: rd.size,
    fontWeight: rd.weight,
    italic: false,
    underline: false,
    strike: false,
    color: isCentral ? theme.centralText : theme.normalText,
    hAlign: rd.hAlign,
    vAlign: 'middle',
    lineHeight: 1.2,
    paragraphGap: 0,
    wrap: true,
    wrapWidth: 240,
    wrapWidthExplicit: false,
    referenceFontSizePt: rd.size,
    padding: [10, 14, 10, 14],
  }
  const box: ResolvedBoxStyle = {
    shape: 'rounded',
    sizeMode: 'auto',
    width: null,
    height: null,
    minWidth: isCentral ? 120 : level1 ? 64 : 48,
    minHeight: isCentral ? 56 : 32,
    cornerRadius: isCentral ? 14 : 10,
    fill: isCentral ? theme.centralFill : theme.normalFill,
    stroke: isCentral ? (theme.id === 'monochrome' ? theme.edge : theme.edge) : theme.border,
    strokeWidth: isCentral ? 0 : 1.5,
    dash: 'solid',
    shadow: 'none',
  }
  const accent0 = isCentral ? theme.centralFill : level1 ? branchAccentFor(doc, theme.id, topic.id, idx) : null
  const accent = { value: accent0 as string | null }
  const edge: ResolvedEdgeStyle = {
    routing: doc.layout.routing,
    color: accent0 ?? theme.edge,
    width: 2,
    dash: 'solid',
  }
  // Role overrides (document role_style_defaults)
  const roleOverride = doc.role_style_defaults?.[topic.role]
  if (roleOverride) {
    applyTextStyle(text, roleOverride.text as Record<string, unknown>)
    applyBoxStyle(box, roleOverride.box_style as Record<string, unknown>)
  }
  // Map overrides
  applyTextStyle(text, doc.map_style_overrides.text as Record<string, unknown>)
  applyBoxStyle(box, doc.map_style_overrides.box_style as Record<string, unknown>)
  // Ancestor branch (top-down từ root tới cha để nhánh gần node ghi đè nhánh xa)
  const anc = idx ? idxAncestors(idx, topic.id) : ancestorsOf(doc, topic.id)
  for (let i = anc.length - 1; i >= 0; i--) {
    const a = anc[i]
    applyBranchInherit(text, edge, accent, a.branch_style_override as Record<string, unknown> | undefined)
    if (a.numbering?.apply_to_subtree && !topic.numbering) { /* numbering tính riêng */ }
  }
  // Topic style (cao nhất)
  applyTextStyle(text, topic.style.text as Record<string, unknown>)
  applyBoxStyle(box, topic.style.box_style as Record<string, unknown>)
  applyEdgeStyle(edge, topic.style.hierarchy_edge as Record<string, unknown>)
  if (!accent.value) accent.value = theme.edge
  // Cấp con của level-1 kế thừa accent nhưng nền vẫn theme normal (16.4)
  if (!isCentral && !level1 && box.fill === theme.normalFill && topic.style.box_style?.fill === undefined) {
    edge.color = edge.color || accent.value
  }
  return { text, box, edge, accent: accent.value ?? theme.edge, inheritedFrom: 'theme' }
}

/** Số thứ tự đánh số được sinh tại render (không ghi vào text — 06.3) */
export function numberingPrefix(fmt: string, path: number[]): string {
  switch (fmt) {
    case 'decimal': return `${path[path.length - 1] + 1}.`
    case 'dotted': return path.map((i) => i + 1).join('.') + ' '
    case 'alpha': return String.fromCharCode(65 + (path[path.length - 1] % 26)) + '.'
    default: return ''
  }
}
export { depthOf }
