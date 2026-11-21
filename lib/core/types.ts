/* ============================================================
 * OpenMindmap — lib/core/types.ts
 * Mô hình dữ liệu Project JSON V3 (schema_version 3) theo SRS 18.1–18.4
 * + 8 Project Theme tokens (SRS 16.4) + Migration v1/v2 → v3 (LOCK-11)
 * ============================================================ */

export type Role = 'central' | 'normal' | 'floating'
export type BranchSide = 'auto' | 'left' | 'right'
export type LayoutKind =
  | 'balanced' | 'logic' | 'tree' | 'organization'
  | 'radial' | 'fishbone' | 'timeline' | 'freeform'
export type EdgeRouting = 'curved' | 'straight' | 'elbow'
export type ShapeKind = 'rect' | 'rounded' | 'pill'
export type SizeMode = 'auto' | 'fixed'
export type DashStyle = 'solid' | 'dashed' | 'dotted'
export type ShadowPreset = 'none' | 'soft'
export type WeightKind = 400 | 500 | 600 | 700
export type HAlign = 'left' | 'center' | 'right'
export type VAlign = 'top' | 'middle' | 'bottom'
export type ImagePlacement = 'above' | 'below' | 'left' | 'right'
export type NumberingFormat = 'none' | 'decimal' | 'dotted' | 'alpha'
export type SortPolicy = 'user_order' | 'by_date'

/* ---------- Style overrides (null/absent = kế thừa — SRS 18.2) ---------- */
export interface TextStyleOverride {
  font_family?: string | null
  font_size_pt?: number | null
  font_weight?: WeightKind | null
  italic?: boolean | null
  underline?: boolean | null
  strike?: boolean | null
  color?: string | null
  horizontal_align?: HAlign | null
  vertical_align?: VAlign | null
  line_height_multiplier?: number | null
  paragraph_gap_world?: number | null
  wrap?: boolean | null
  wrap_width_world?: number | null
  padding_world?: [number, number, number, number] | null // T R B L
}
export interface BoxStyleOverride {
  shape?: ShapeKind | null
  size_mode?: SizeMode | null
  width_world?: number | null
  height_world?: number | null
  min_width_world?: number | null
  min_height_world?: number | null
  corner_radius_world?: number | null
  fill?: string | null
  stroke?: string | null
  stroke_width_world?: number | null
  stroke_dash?: DashStyle | null
  shadow_preset?: ShadowPreset | null
}
export interface EdgeStyleOverride {
  routing?: EdgeRouting | null
  color?: string | null
  width_world?: number | null
  dash?: DashStyle | null
}
/** Chỉ các field kế thừa được xuống descendants (SRS 18.2 branch inheritance) */
export interface BranchStyleOverride {
  text_color?: string | null
  font_family?: string | null
  font_size_pt?: number | null
  edge_color?: string | null
  edge_width_world?: number | null
  edge_routing?: EdgeRouting | null
  accent_color?: string | null
}

export interface ImageAttachment {
  asset_id: string
  fit: 'contain' | 'cover'
  placement: ImagePlacement
  width_fraction: number // 0.1..1 tương đối bề ngang text
}
export interface IconAttachment {
  icon_id: string
  size: 's' | 'm' | 'l'
  position: 'before_title' | 'corner'
}
export interface NumberingPolicy {
  format: NumberingFormat
  apply_to_subtree: boolean
}

/* ---------- Topic ---------- */
export interface Topic {
  id: string
  role: Role
  parent_id: string | null
  order: number
  text: string
  notes?: string | null
  collapsed: boolean
  manual_position?: { x: number; y: number } | null
  branch_side: BranchSide
  branch_color_seed: number | null // 0..255 ổn định
  style: {
    text?: TextStyleOverride
    box_style?: BoxStyleOverride
    hierarchy_edge?: EdgeStyleOverride
  }
  branch_style_override?: BranchStyleOverride | null
  image?: ImageAttachment | null
  icon?: IconAttachment | null
  checkbox?: boolean | null
  url?: string | null
  date?: string | null // ISO yyyy-mm-dd
  numbering?: NumberingPolicy | null
}

/* ---------- Crosslink / Drawing / Asset ---------- */
export interface Crosslink {
  id: string
  source: string
  target: string
  label?: string | null
  color?: string | null
  width_world?: number | null
  dash?: DashStyle | null
  arrow_start?: boolean
  arrow_end?: boolean
  waypoints?: { x: number; y: number }[] | null
}
export type DrawingKind = 'pen' | 'highlighter' | 'line' | 'rect' | 'ellipse'
export interface DrawingObject {
  id: string
  kind: DrawingKind
  points: { x: number; y: number }[] // pen/highlighter: polyline; line: [p1,p2]; rect/ellipse: [p1,p2]
  color: string
  width_world: number
  opacity: number // 0..1
  fill?: string | null
  layer_order: number
}
export interface Asset {
  id: string
  mime: string
  width: number
  height: number
  hash: string
  data_url: string
}

/** Restrict image consumers to embedded passive bitmap resources. */
export function embeddedBitmap(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const header = /^data:image\/(png|jpeg|webp|gif);base64,/.exec(value)
  if (!header) return false
  const body = value.slice(header[0].length)
  if (!body || body.length % 4 || /[^A-Za-z0-9+/=]/.test(body)) return false
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
  if (body.indexOf('=') !== (padding ? body.length - padding : -1) || body.length / 4 * 3 - padding > LIMITS.imageBytes) return false
  try {
    const signature = atob(body.slice(0, 16))
    switch (header[1]) {
      case 'png': return signature.startsWith('\x89PNG\r\n\x1a\n')
      case 'jpeg': return signature.startsWith('\xff\xd8\xff')
      case 'gif': return signature.startsWith('GIF87a') || signature.startsWith('GIF89a')
      case 'webp': return signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP'
    }
  } catch { return false }
  return false
}

/* ---------- Layout settings (11.4) ---------- */
export interface LayoutSettings {
  kind: LayoutKind
  direction: 'both' | 'left' | 'right' | 'top' | 'bottom' | 'cw' | 'ccw'
  node_gap: number
  branch_gap: number
  level_gap: number
  root_island_gap: number
  routing: EdgeRouting
  sort_policy: SortPolicy
  chronological: boolean
  start_angle_deg: number
  snap_to_grid: boolean
}

/* ---------- ProjectDocV3 ---------- */
export interface ProjectDocV3 {
  schema_version: 3
  project_id: string
  name: string
  created_at: string
  updated_at: string
  document_revision: number
  central_topic_id: string
  topics: Topic[]
  crosslinks: Crosslink[]
  drawings: DrawingObject[]
  assets: Asset[]
  layout: LayoutSettings
  theme_id: string
  map_style_overrides: { text?: TextStyleOverride; box_style?: BoxStyleOverride }
  role_style_defaults: Partial<Record<Role, { text?: TextStyleOverride; box_style?: BoxStyleOverride }>>
  version_note?: string | null
}

/* ---------- 8 Project Themes (SRS 16.4 — HEX quy phạm) ---------- */
export interface ProjectTheme {
  id: string
  name: string
  canvas: string
  centralFill: string
  centralText: string
  normalFill: string
  normalText: string
  border: string
  edge: string
  accents: string[]
}
export const PROJECT_THEMES: ProjectTheme[] = [
  { id: 'modern-blue', name: 'Hiện đại Xanh', canvas: '#FFFFFF', centralFill: '#2563EB', centralText: '#FFFFFF', normalFill: '#EFF6FF', normalText: '#1F2937', border: '#60A5FA', edge: '#60A5FA', accents: ['#2563EB', '#06B6D4', '#7C3AED', '#16A34A', '#F59E0B', '#EC4899'] },
  { id: 'colorful', name: 'Nhiều màu', canvas: '#FFFFFF', centralFill: '#7C3AED', centralText: '#FFFFFF', normalFill: '#FFFFFF', normalText: '#111827', border: '#94A3B8', edge: '#94A3B8', accents: ['#F43F5E', '#F59E0B', '#22C55E', '#06B6D4', '#6366F1', '#D946EF'] },
  { id: 'soft', name: 'Nhẹ nhàng', canvas: '#FFFDFB', centralFill: '#D8B4FE', centralText: '#312E81', normalFill: '#FAF5FF', normalText: '#374151', border: '#C4B5FD', edge: '#C4B5FD', accents: ['#A78BFA', '#F9A8D4', '#93C5FD', '#86EFAC', '#FCD34D', '#FDBA74'] },
  { id: 'monochrome', name: 'Đơn sắc', canvas: '#FFFFFF', centralFill: '#111827', centralText: '#FFFFFF', normalFill: '#FFFFFF', normalText: '#111827', border: '#6B7280', edge: '#6B7280', accents: ['#374151', '#4B5563', '#6B7280', '#9CA3AF'] },
  { id: 'dark-map', name: 'Bản đồ tối', canvas: '#0B1220', centralFill: '#1D4ED8', centralText: '#FFFFFF', normalFill: '#172033', normalText: '#F8FAFC', border: '#64748B', edge: '#64748B', accents: ['#60A5FA', '#22D3EE', '#C084FC', '#4ADE80', '#FBBF24', '#FB7185'] },
  { id: 'warm', name: 'Ấm', canvas: '#FFFCF7', centralFill: '#B45309', centralText: '#FFFFFF', normalFill: '#FFF7ED', normalText: '#422006', border: '#FDBA74', edge: '#FDBA74', accents: ['#EA580C', '#CA8A04', '#B45309', '#DC2626', '#65A30D', '#A16207'] },
  { id: 'nature', name: 'Thiên nhiên', canvas: '#F8FCF8', centralFill: '#15803D', centralText: '#FFFFFF', normalFill: '#F0FDF4', normalText: '#14532D', border: '#86EFAC', edge: '#86EFAC', accents: ['#16A34A', '#0D9488', '#84CC16', '#65A30D', '#0891B2', '#D97706'] },
  { id: 'minimal', name: 'Tối giản', canvas: '#FFFFFF', centralFill: '#F1F5F9', centralText: '#0F172A', normalFill: '#FFFFFF', normalText: '#0F172A', border: '#CBD5E1', edge: '#CBD5E1', accents: ['#64748B', '#475569', '#334155', '#94A3B8'] },
]
export function getTheme(id: string): ProjectTheme {
  return PROJECT_THEMES.find((t) => t.id === id) ?? PROJECT_THEMES[0]
}

/* ---------- Layout defaults (11.4) ---------- */
export const LAYOUT_DEFAULTS: Record<LayoutKind, Partial<LayoutSettings>> = {
  balanced: { direction: 'both', node_gap: 24, branch_gap: 40, level_gap: 90, routing: 'curved' },
  logic: { direction: 'right', node_gap: 24, level_gap: 90, routing: 'curved' },
  tree: { direction: 'top', node_gap: 24, level_gap: 90, routing: 'elbow' },
  organization: { direction: 'top', node_gap: 24, level_gap: 90, routing: 'elbow' },
  radial: { direction: 'cw', start_angle_deg: -90, node_gap: 90, level_gap: 110, routing: 'straight' },
  fishbone: { direction: 'right', node_gap: 40, branch_gap: 90, level_gap: 120, routing: 'straight' },
  timeline: { direction: 'right', node_gap: 24, level_gap: 70, routing: 'elbow' },
  freeform: { routing: 'straight' },
}

export function defaultLayout(kind: LayoutKind = 'balanced'): LayoutSettings {
  return {
    kind,
    direction: 'both',
    node_gap: 24,
    branch_gap: 40,
    level_gap: 90,
    root_island_gap: 160,
    routing: 'curved',
    sort_policy: 'user_order',
    chronological: false,
    start_angle_deg: -90,
    snap_to_grid: false,
    ...LAYOUT_DEFAULTS[kind],
  }
}

/* ---------- Kiến tạo dự án mới (PR01) ---------- */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function newTopic(partial: Partial<Topic> & { id: string; text: string }): Topic {
  return {
    role: 'normal',
    parent_id: null,
    order: 0,
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
    ...partial,
  }
}

export function newProjectDoc(name: string, now = new Date()): ProjectDocV3 {
  const cid = uuid()
  return {
    schema_version: 3,
    project_id: uuid(),
    name,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    document_revision: 1,
    central_topic_id: cid,
    topics: [newTopic({ id: cid, role: 'central', text: name || 'Chủ đề trung tâm' })],
    crosslinks: [],
    drawings: [],
    assets: [],
    layout: defaultLayout('balanced'),
    theme_id: 'modern-blue',
    map_style_overrides: {},
    role_style_defaults: {},
    version_note: null,
  }
}

/* ============================================================
 * Validation + Migration v1/v2 → v3 (LOCK-11, SRS 18.4)
 * ============================================================ */
export interface MigrateReport {
  from: number | 'unknown'
  warnings: string[]
  remapped: string[]
}

export interface ParseResult {
  doc: ProjectDocV3
  report: MigrateReport
  synthesizedUpdatedAt?: boolean
}

const nowISO = () => new Date().toISOString()

function coerceLayout(raw: unknown): LayoutSettings {
  const l = (raw ?? {}) as Record<string, unknown>
  const kind = (typeof l.kind === 'string' && LAYOUT_DEFAULTS[l.kind as LayoutKind] !== undefined
    ? l.kind : 'balanced') as LayoutKind
  const base = defaultLayout(kind)
  const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : d)
  return {
    ...base,
    direction: (typeof l.direction === 'string' ? l.direction : base.direction) as LayoutSettings['direction'],
    node_gap: num(l.node_gap, base.node_gap),
    branch_gap: num(l.branch_gap, base.branch_gap),
    level_gap: num(l.level_gap, base.level_gap),
    root_island_gap: num(l.root_island_gap, base.root_island_gap),
    routing: (['curved', 'straight', 'elbow'].includes(l.routing as string) ? l.routing : base.routing) as EdgeRouting,
    sort_policy: (l.sort_policy === 'by_date' ? 'by_date' : 'user_order'),
    chronological: l.chronological === true,
    start_angle_deg: typeof l.start_angle_deg === 'number' ? l.start_angle_deg : -90,
    snap_to_grid: l.snap_to_grid === true,
  }
}

/** Chuẩn hóa một topic từ dữ liệu cũ (v1/v2/v3 lỏng) → Topic v3 */
function normalizeTopic(raw: Record<string, unknown>, index: number, schemaVersion: number, warnings: string[], remapped: string[]): Topic {
  const rawId = raw.id
  if (rawId !== undefined && typeof rawId !== 'string') throw new Error(`Trường topics[${index}].id phải là chuỗi`)
  if (schemaVersion >= 3 && (typeof rawId !== 'string' || !rawId)) throw new Error(`Thiếu topics[${index}].id hợp lệ`)
  const idLabel = typeof rawId === 'string' && rawId ? rawId : `topics[${index}]`
  if (raw.text === undefined) {
    if (schemaVersion >= 3) throw new Error(`Thiếu trường text tại topic "${idLabel}"`)
  } else if (typeof raw.text !== 'string') {
    throw new Error(`Trường text tại topic "${idLabel}" (${index}) phải là chuỗi`)
  }
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== 'string') throw new Error(`Trường notes tại topic "${idLabel}" không hợp lệ`)
  if (raw.url !== undefined && raw.url !== null && typeof raw.url !== 'string') throw new Error(`Trường url tại topic "${idLabel}" không hợp lệ`)
  if (raw.date !== undefined && raw.date !== null && typeof raw.date !== 'string') throw new Error(`Trường date tại topic "${idLabel}" không hợp lệ`)
  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) throw new Error(`Trường order tại topic "${idLabel}" không hợp lệ`)
  if (raw.collapsed !== undefined && typeof raw.collapsed !== 'boolean') throw new Error(`Trường collapsed tại topic "${idLabel}" không hợp lệ`)
  if (raw.checkbox !== undefined && raw.checkbox !== null && typeof raw.checkbox !== 'boolean') throw new Error(`Trường checkbox tại topic "${idLabel}" không hợp lệ`)
  if (raw.parent_id !== undefined && raw.parent_id !== null && typeof raw.parent_id !== 'string') throw new Error(`Trường parent_id tại topic "${idLabel}" không hợp lệ`)

  const style = (raw.style ?? {}) as Record<string, unknown>
  if (raw.style !== undefined && (typeof raw.style !== 'object' || raw.style === null || Array.isArray(raw.style))) throw new Error(`Trường style tại topic "${idLabel}" không hợp lệ`)
  const legacyOverride = (raw.style_override ?? {}) as Record<string, unknown>
  const text: TextStyleOverride = { ...(style.text as TextStyleOverride | undefined) }
  // v1: style_override flat
  if (legacyOverride.font_size !== undefined) { text.font_size_pt = legacyOverride.font_size as number; remapped.push('font_size→font_size_pt') }
  if (legacyOverride.wrap_width !== undefined && text.wrap_width_world === undefined) text.wrap_width_world = legacyOverride.wrap_width as number
  if (legacyOverride.color !== undefined && text.color === undefined) text.color = legacyOverride.color as string
  const manualPos = raw.manual_position ?? raw.manual_pos
  if (raw.manual_pos && !raw.manual_position) {
    remapped.push('manual_pos→manual_position')
  }
  const bso = (raw.branch_style_override ?? null) as BranchStyleOverride | null
  const role = (['central', 'floating', 'normal'].includes(raw.role as string) ? raw.role : 'normal') as Role
  const seed = typeof raw.branch_color_seed === 'number' ? raw.branch_color_seed : null
  let parsedPos: { x: number; y: number } | null = null
  if (manualPos !== undefined && manualPos !== null) {
    if (typeof manualPos !== 'object' || Array.isArray(manualPos)) throw new Error(`Tọa độ manual_position tại topic "${idLabel}" không hợp lệ`)
    const mp = manualPos as { x: unknown; y: unknown }
    if (typeof mp.x !== 'number' || typeof mp.y !== 'number' || !Number.isFinite(mp.x) || !Number.isFinite(mp.y)) {
      throw new Error(`Tọa độ node không hợp lệ tại topic "${idLabel}"`)
    }
    parsedPos = { x: mp.x, y: mp.y }
  }
  return {
    id: (typeof rawId === 'string' && rawId) ? rawId : uuid(),
    role,
    parent_id: (raw.parent_id as string | null) ?? null,
    order: typeof raw.order === 'number' ? raw.order : 0,
    text: typeof raw.text === 'string' ? raw.text : '',
    notes: typeof raw.notes === 'string' ? raw.notes : null,
    collapsed: raw.collapsed === true,
    manual_position: parsedPos,
    branch_side: (['auto', 'left', 'right'].includes(raw.branch_side as string) ? raw.branch_side : 'auto') as BranchSide,
    branch_color_seed: seed,
    style: { text, box_style: (style.box_style ?? {}) as BoxStyleOverride, hierarchy_edge: (style.hierarchy_edge ?? {}) as EdgeStyleOverride },
    branch_style_override: bso,
    image: (raw.image ?? null) as ImageAttachment | null,
    icon: (raw.icon ?? null) as IconAttachment | null,
    checkbox: raw.checkbox === null || raw.checkbox === undefined ? null : raw.checkbox === true,
    url: typeof raw.url === 'string' ? raw.url : null,
    date: typeof raw.date === 'string' ? raw.date : null,
    numbering: (raw.numbering ?? null) as NumberingPolicy | null,
  }
}

/** Mở JSON native: nhận v1/v2/v3, từ chối phiên bản tương lai (18.4.1) */
export function assertUniqueTopicIds(topics: Pick<Topic, 'id'>[]): void {
  const ids = new Set<string>()
  for (const topic of topics) {
    if (!topic || typeof topic.id !== 'string' || !topic.id) throw new Error('ID topic phải là chuỗi không rỗng')
    if (ids.has(topic.id)) throw new Error(`ID topic trùng: ${topic.id}. Tệp chưa được nhập.`)
    ids.add(topic.id)
  }
}

export function parseProjectJSON(jsonText: string): ParseResult {
  const data = JSON.parse(jsonText) as Record<string, unknown>
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Tệp dự án không hợp lệ')
  const svRaw = data.schema_version ?? data.version ?? 3
  if (typeof svRaw !== 'number' || !Number.isFinite(svRaw)) throw new Error('schema_version không hợp lệ')
  const sv = Math.floor(svRaw)
  if (sv > 3) throw new Error(`SCHEMA_FUTURE: schema_version ${sv} mới hơn ứng dụng (hỗ trợ tối đa 3). Không ghi đè tệp nguồn.`)
  if (data.name !== undefined && data.name !== null && typeof data.name !== 'string') throw new Error('Trường name của dự án phải là chuỗi')
  const warnings: string[] = []
  const remapped: string[] = []
  if (!Array.isArray(data.topics)) throw new Error('Tệp thiếu danh sách topics hợp lệ')
  const rawTopics = data.topics as Record<string, unknown>[]
  if (rawTopics.length === 0) throw new Error('Tệp không có topic nào.')
  if (rawTopics.some(t => !t || typeof t !== 'object' || Array.isArray(t))) throw new Error('Topic không hợp lệ')
  const topics = rawTopics.map((t, index) => normalizeTopic(t, index, sv, warnings, remapped))
  assertUniqueTopicIds(topics)
  // Xác định central: v1/v2 có thể dùng root_id/is_central
  let centralId = typeof data.central_topic_id === 'string' && data.central_topic_id ? data.central_topic_id : null
  if (!centralId && sv < 3) {
    const legacyRoot = topics.find((t) => (rawTopics.find((r) => r.id === t.id)?.is_central === true)) || topics.find((t) => !t.parent_id)
    centralId = legacyRoot?.id ?? topics[0]?.id ?? null
    if (centralId) remapped.push('central_topic_id suy luận từ dữ liệu cũ')
  }
  if (!centralId || !topics.find((t) => t.id === centralId)) {
    throw new Error('Thiếu central topic hợp lệ trong tệp dự án.')
  }
  // Đảm bảo đúng 1 central (LOCK-01)
  const centralCount = topics.filter((t) => t.role === 'central').length
  if (sv >= 3 && centralCount > 1) {
    throw new Error('Tệp có nhiều hơn một central topic.')
  }
  topics.forEach((t) => {
    if (t.id !== centralId && t.role === 'central') { t.role = t.parent_id ? 'normal' : 'floating'; warnings.push(`Topic "${t.text}" đổi role central→${t.role} (chỉ được 1 central).`) }
    if (t.id === centralId) {
      if (t.parent_id !== null) throw new Error(`Central topic "${t.text}" (${t.id}) không được có parent_id.`)
      t.role = 'central'
    }
  })
  // Kiểm tra parent hợp lệ + acyclic (không tự sửa tham chiếu hỏng trong trình nhập)
  assertValidTopicHierarchy(topics, centralId)
  // Gán stable branch seed nếu thiếu (18.4.3)
  topics.forEach((t) => { if (t.branch_color_seed === null) t.branch_color_seed = stableSeed(t.id) })
  const hasExplicitUpdatedAt = typeof data.updated_at === 'string'
  const doc: ProjectDocV3 = {
    schema_version: 3,
    project_id: typeof data.project_id === 'string' ? data.project_id : uuid(),
    name: typeof data.name === 'string' && data.name ? data.name : 'Dự án nhập',
    created_at: typeof data.created_at === 'string' ? data.created_at : nowISO(),
    updated_at: hasExplicitUpdatedAt ? (data.updated_at as string) : nowISO(),
    document_revision: typeof data.document_revision === 'number' ? data.document_revision : 1,
    central_topic_id: centralId,
    topics,
    crosslinks: Array.isArray(data.crosslinks) ? (data.crosslinks as Crosslink[]) : [],
    drawings: Array.isArray(data.drawings) ? (data.drawings as DrawingObject[]) : [],
    assets: Array.isArray(data.assets) ? (data.assets as Asset[]) : [],
    layout: coerceLayout(data.layout),
    theme_id: getTheme(typeof data.theme_id === 'string' ? data.theme_id : '').id,
    map_style_overrides: (data.map_style_overrides ?? {}) as ProjectDocV3['map_style_overrides'],
    role_style_defaults: (data.role_style_defaults ?? {}) as ProjectDocV3['role_style_defaults'],
    version_note: typeof data.version_note === 'string' ? data.version_note : null,
  }
  assertValidImportedProject(doc)
  if (sv < 3) warnings.push(`Đã chuyển đổi schema v${sv} → v3. Tệp nguồn không bị sửa; bản chuyển đổi chỉ ghi khi Lưu/Xác nhận.`)
  return { doc, report: { from: sv, warnings, remapped: [...new Set(remapped)] }, synthesizedUpdatedAt: !hasExplicitUpdatedAt }
}

function assertValidTopicHierarchy(topics: Topic[], centralId: string): void {
  const byId = new Map(topics.map((t) => [t.id, t]))
  for (const t of topics) {
    if (t.id === centralId && t.parent_id !== null) throw new Error(`Central topic "${t.text}" (${t.id}) không được có parent_id.`)
    if (t.parent_id !== null && !byId.has(t.parent_id)) {
      throw new Error(`Topic "${t.text}" (${t.id}) có parent_id không tồn tại: ${t.parent_id}`)
    }
  }
  for (const t of topics) {
    const seen = new Set<string>([t.id])
    let p = t.parent_id ? byId.get(t.parent_id) : undefined
    while (p) {
      if (seen.has(p.id)) {
        throw new Error(`Phát hiện vòng lặp cha–con (cycle) tại topic "${t.text}" (${t.id}).`)
      }
      seen.add(p.id)
      p = p.parent_id ? byId.get(p.parent_id) : undefined
    }
  }
}

/** Shared by preview and the two import commits; never rewrites the input. */
export function assertValidImportedProject(doc: ProjectDocV3): void {
  if (!Array.isArray(doc.topics) || !Array.isArray(doc.assets) || !Array.isArray(doc.drawings) || !Array.isArray(doc.crosslinks)) throw new Error('Cấu trúc dự án không hợp lệ')
  assertUniqueTopicIds(doc.topics)
  if (!Number.isSafeInteger(doc.document_revision) || doc.document_revision < 0) throw new Error('Revision không hợp lệ')
  const ids = new Set(doc.topics.map(t => t.id))
  if (!ids.has(doc.central_topic_id)) throw new Error('Thiếu central topic')
  if (doc.topics.some(t => t.id !== doc.central_topic_id && t.role === 'central')) throw new Error('Tệp có nhiều hơn một central topic')
  assertValidTopicHierarchy(doc.topics, doc.central_topic_id)
  const linkIds = new Set<string>()
  for (const c of doc.crosslinks) {
    if (!c || typeof c.id !== 'string' || !c.id || linkIds.has(c.id) || !ids.has(c.source) || !ids.has(c.target) || c.source === c.target
      || (c.label != null && typeof c.label !== 'string') || (c.color != null && typeof c.color !== 'string')
      || (c.width_world != null && (!Number.isFinite(c.width_world) || c.width_world <= 0))
      || (c.dash != null && !['solid', 'dashed', 'dotted'].includes(c.dash))
      || (c.arrow_start != null && typeof c.arrow_start !== 'boolean') || (c.arrow_end != null && typeof c.arrow_end !== 'boolean')
      || (c.waypoints != null && (!Array.isArray(c.waypoints) || c.waypoints.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))))) throw new Error('Dữ liệu nối chéo không hợp lệ')
    linkIds.add(c.id)
  }
  const validateStyle = (style: unknown) => {
    if (style == null) return
    if (typeof style !== 'object' || Array.isArray(style)) throw new Error('Style không hợp lệ')
    const fields = style as Record<string, unknown>
    for (const key of ['font_size_pt', 'font_weight', 'line_height_multiplier', 'paragraph_gap_world', 'wrap_width_world', 'width_world', 'height_world', 'min_width_world', 'min_height_world', 'corner_radius_world', 'stroke_width_world', 'edge_width_world']) {
      if (fields[key] != null && !Number.isFinite(fields[key])) throw new Error(`Style ${key} không hợp lệ`)
    }
    if (fields.padding_world != null && (!Array.isArray(fields.padding_world) || fields.padding_world.length !== 4 || fields.padding_world.some(v => !Number.isFinite(v)))) throw new Error('Style padding_world không hợp lệ')
  }
  const validateStyleGroup = (style: ProjectDocV3['map_style_overrides']) => {
    if (!style || typeof style !== 'object' || Array.isArray(style)) throw new Error('Nhóm style không hợp lệ')
    validateStyle(style.text); validateStyle(style.box_style)
  }
  validateStyleGroup(doc.map_style_overrides)
  if (!doc.role_style_defaults || typeof doc.role_style_defaults !== 'object' || Array.isArray(doc.role_style_defaults)) throw new Error('Style vai trò không hợp lệ')
  Object.values(doc.role_style_defaults).forEach(style => { if (style) validateStyleGroup(style) })
  const assetIds = new Set<string>()
  for (const a of doc.assets) {
    if (!a || typeof a.id !== 'string' || !a.id || assetIds.has(a.id) || typeof a.hash !== 'string'
      || !embeddedBitmap(a.data_url) || a.data_url.slice(5, a.data_url.indexOf(';')) !== a.mime
      || !Number.isSafeInteger(a.width) || !Number.isSafeInteger(a.height) || a.width < 1 || a.height < 1
      || a.width * a.height > LIMITS.imagePixels) throw new Error('Dữ liệu ảnh nhúng không hợp lệ')
    assetIds.add(a.id)
  }
  for (const t of doc.topics) {
    if (typeof t.text !== 'string') throw new Error(`Trường text tại topic "${t.id}" không hợp lệ`)
    if (!Number.isFinite(t.order) || (t.branch_color_seed != null && !Number.isFinite(t.branch_color_seed))) throw new Error('Thứ tự hoặc màu nhánh không hợp lệ')
    validateStyleGroup(t.style); validateStyle(t.style.hierarchy_edge); validateStyle(t.branch_style_override)
    if (t.image && (!assetIds.has(t.image.asset_id) || !Number.isFinite(t.image.width_fraction)
      || !['below', 'above', 'left', 'right'].includes(t.image.placement) || !['contain', 'cover'].includes(t.image.fit))) {
      throw new Error('Tham chiếu ảnh của node không hợp lệ')
    }
    if (t.manual_position && (!Number.isFinite(t.manual_position.x) || !Number.isFinite(t.manual_position.y))) throw new Error('Tọa độ node không hợp lệ')
  }
  const drawingIds = new Set<string>()
  for (const d of doc.drawings) {
    if (!d || typeof d.id !== 'string' || !d.id || drawingIds.has(d.id)
      || !['pen', 'highlighter', 'line', 'rect', 'ellipse'].includes(d.kind)
      || !Array.isArray(d.points) || !d.points.length || (['line', 'rect', 'ellipse'].includes(d.kind) && d.points.length !== 2)
      || d.points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
      || typeof d.color !== 'string' || !Number.isFinite(d.width_world) || d.width_world < 0.5 || d.width_world > 60
      || !Number.isFinite(d.opacity) || d.opacity < 0.05 || d.opacity > 1
      || !Number.isInteger(d.layer_order) || (d.fill != null && typeof d.fill !== 'string')) throw new Error('Dữ liệu nét vẽ không hợp lệ')
    drawingIds.add(d.id)
  }
}

/** Seed màu nhánh ổn định theo ID (không đổi khi reorder — 16.4) */
export function stableSeed(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 256 + 256) % 256
}

/* ---------- Giới hạn an toàn (18.4.7) ---------- */
export const LIMITS = {
  jsonBytes: 100 * 1024 * 1024,
  textBytes: 25 * 1024 * 1024,
  nodes: 20000,
  depth: 256,
  imageBytes: 20 * 1024 * 1024,
  imagePixels: 100 * 1024 * 1024,
  pngMaxEdge: 16384,
  pngMaxPixels: 64 * 1024 * 1024,
}
