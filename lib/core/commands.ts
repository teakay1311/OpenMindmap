/* ============================================================
 * OpenMindmap — lib/core/commands.ts
 * Mọi thay đổi nội dung CHỈ qua Command (LOCK-06, SRS 19.1).
 * Mỗi gesture hợp lệ = MỘT command; Undo khôi phục đầy đủ qua snapshot.
 * ============================================================ */
import { ProjectDocV3, Topic, Crosslink, DrawingObject, Asset, LayoutSettings, ImageAttachment, IconAttachment, NumberingPolicy, TextStyleOverride, BoxStyleOverride, EdgeStyleOverride, BranchStyleOverride, uuid, stableSeed, newTopic } from './types'
import { childrenOf, getTopic, descendantsOf, nextOrder, normalizeOrders, isDescendantOrSelf, cloneSubtree, crosslinksTouching, crosslinksWithin, subtreeSize } from './tree'

export type NodePropsPatch = Partial<Pick<Topic, 'checkbox' | 'url' | 'date' | 'numbering' | 'icon' | 'image' | 'notes' | 'branch_side'>>

export type Command =
  | { type: 'addTopic'; topic: Topic; parentId: string | null; index: number | null; focusEditor: boolean }
  | { type: 'addSubtree'; assets?: Asset[]; crosslinks?: Crosslink[]; topics: Topic[]; rootParentId: string | null; rootIndex: number | null; focusEditor: boolean }
  | { type: 'deleteTopics'; ids: string[] } // mỗi id: xóa subtree + crosslinks chạm
  | { type: 'deleteOnly'; id: string }
  | { type: 'setText'; id: string; before: string; after: string }
  | { type: 'batchEditText'; edits: { id: string; field?: 'title' | 'notes'; before: string; after: string }[] }
  | { type: 'setProps'; id: string; before: NodePropsPatch; after: NodePropsPatch }
  | { type: 'setTextStyle'; ids: string[]; before: Record<string, TextStyleOverride>; after: TextStyleOverride; perTopic?: Record<string, TextStyleOverride> }
  | { type: 'setBoxStyle'; ids: string[]; before: Record<string, BoxStyleOverride>; after: BoxStyleOverride }
  | { type: 'setEdgeStyle'; ids: string[]; before: Record<string, EdgeStyleOverride>; after: EdgeStyleOverride }
  | { type: 'setBranchStyle'; id: string; before: BranchStyleOverride | null; after: BranchStyleOverride }
  | { type: 'resetNodeStyle'; scope?: 'text' | 'box_style'; ids: string[]; before: Record<string, Topic['style']> }
  | { type: 'resetBranchStyle'; id: string; before: BranchStyleOverride | null }
  | { type: 'reparent'; items: { id: string; oldParentId: string | null; oldOrder: number; newParentId: string | null; newOrder: number; floatingPosition?: { x: number; y: number } }[] }
  | { type: 'moveFreeform'; items: { id: string; from: { x: number; y: number } | null; to: { x: number; y: number } | null }[] }
  | { type: 'collapse'; items: { id: string; value: boolean }[] }
  | { type: 'duplicateSubtree'; id: string; resolvedPositions?: Record<string, { x: number; y: number }> }
  | { type: 'attachImage'; id: string; asset: Asset; before: ImageAttachment | null; after: ImageAttachment }
  | { type: 'removeImage'; id: string; before: ImageAttachment | null }
  | { type: 'addDrawing'; drawing: DrawingObject }
  | { type: 'removeDrawings'; drawings: DrawingObject[] }
  | { type: 'modifyDrawing'; id: string; before: Partial<DrawingObject>; after: Partial<DrawingObject> }
  | { type: 'addCrosslink'; crosslink: Crosslink }
  | { type: 'modifyCrosslink'; id: string; before: Partial<Crosslink>; after: Partial<Crosslink> }
  | { type: 'removeCrosslinks'; crosslinks: Crosslink[] }
  | { type: 'setLayout'; before: LayoutSettings; after: LayoutSettings }
  | { type: 'setTheme'; before: string; after: string }
  | { type: 'renameProject'; before: string; after: string }
  | { type: 'composite'; commands: Command[] }

export interface ApplyResult { ok: boolean; error?: string; focusIds?: string[] }

function isFinitePoint(p: unknown): p is { x: number; y: number } {
  return Boolean(p && typeof p === 'object' && !Array.isArray(p)
    && typeof (p as { x?: unknown }).x === 'number' && Number.isFinite((p as { x: number }).x)
    && typeof (p as { y?: unknown }).y === 'number' && Number.isFinite((p as { y: number }).y))
}

/* ---------- Validation (17.5 InvalidHierarchy...) ---------- */
export function validateReparent(doc: ProjectDocV3, id: string, newParentId: string | null): string | null {
  const t = getTopic(doc, id)
  if (!t) return 'Node không tồn tại'
  if (t.id === doc.central_topic_id) return 'Không thể chuyển Chủ đề trung tâm'
  if (newParentId === null) return null // thành floating root — hợp lệ
  if (newParentId === id) return 'Không thể chuyển node vào chính nó'
  if (isDescendantOrSelf(doc, id, newParentId)) return 'Không thể thả: sẽ tạo vòng lặp cha–con'
  const target = getTopic(doc, newParentId)
  if (!target) return 'Đích đến không tồn tại'
  return null
}

/* ---------- Helper dựng topic mới ---------- */
export function makeChildTopic(doc: ProjectDocV3, parentId: string | null, text: string, role: Topic['role'] = 'normal'): Topic {
  return newTopic({
    id: uuid(),
    role: parentId === null ? (role === 'central' ? 'central' : 'floating') : 'normal',
    parent_id: parentId,
    order: nextOrder(doc, parentId),
    text,
    branch_color_seed: null,
  })
}

/* ---------- Áp command lên doc (đã clone) ---------- */
export function applyCommand(doc: ProjectDocV3, cmd: Command): ApplyResult {
  const focusIds: string[] = []
  const res = applyInner(doc, cmd, focusIds)
  if (res.ok) {
    doc.updated_at = new Date().toISOString()
    doc.document_revision += 1
  }
  return { ...res, focusIds }
}

function touchProps(t: Topic, patch: NodePropsPatch) {
  Object.assign(t, patch)
  if (patch.image === null) t.image = null
}

function applyInner(doc: ProjectDocV3, cmd: Command, focusIds: string[]): ApplyResult {
  switch (cmd.type) {
    case 'composite':
      for (const c of cmd.commands) {
        const r = applyInner(doc, c, focusIds)
        if (!r.ok) return r
        doc.document_revision += 1
      }
      return { ok: true, focusIds }
    case 'addTopic': {
      let parent: Topic | undefined
      if (cmd.parentId !== null) {
        parent = getTopic(doc, cmd.parentId)
        if (!parent) return { ok: false, error: 'Cha không tồn tại' }
        if (parent.collapsed) parent.collapsed = false
      }
      const t = cmd.topic
      if (cmd.index === null) t.order = nextOrder(doc, cmd.parentId)
      else {
        const sibs = childrenOf(doc, cmd.parentId)
        sibs.filter((s) => s.order >= cmd.index!).forEach((s) => { s.order += 1 })
        t.order = cmd.index
      }
      doc.topics.push(t)
      normalizeOrders(doc, cmd.parentId)
      if (cmd.focusEditor) focusIds.push(t.id)
      return { ok: true, focusIds }
    }
    case 'addSubtree': {
      const [root, ...rest] = cmd.topics
      if (!root || (cmd.rootParentId !== null && !getTopic(doc, cmd.rootParentId))) return { ok: false, error: 'Nhánh hoặc node đích không hợp lệ' }
      root.parent_id = cmd.rootParentId
      root.role = cmd.rootParentId === null ? 'floating' : 'normal'
      const incomingAssets = cmd.assets ?? []
      for (const topic of cmd.topics) {
        if (topic.image && !doc.assets.some(a => a.id === topic.image!.asset_id) && !incomingAssets.some(a => a.id === topic.image!.asset_id)) return { ok: false, error: 'Nhánh thiếu dữ liệu ảnh' }
      }
      for (const asset of incomingAssets) if (!doc.assets.some(a => a.id === asset.id)) doc.assets.push(structuredClone(asset))
      if (cmd.rootIndex === null) {
        root.order = nextOrder(doc, cmd.rootParentId)
      } else {
        const idx = cmd.rootIndex
        childrenOf(doc, cmd.rootParentId).filter((s) => s.order >= idx).forEach((s) => { s.order += 1 })
        root.order = idx
      }
      doc.topics.push(root, ...rest)
      doc.crosslinks.push(...(cmd.crosslinks ?? []))
      normalizeOrders(doc, cmd.rootParentId)
      normalizeOrders(doc, root.id)
      if (cmd.focusEditor) focusIds.push(root.id)
      return { ok: true, focusIds }
    }
    case 'deleteTopics': {
      const allIds = new Set<string>()
      for (const id of cmd.ids) {
        const t = getTopic(doc, id)
        if (!t) continue
        if (id === doc.central_topic_id) continue // không xóa Central (N35-09)
        allIds.add(id)
        descendantsOf(doc, id).forEach((d) => allIds.add(d.id))
      }
      if (allIds.size === 0) return { ok: false, error: 'Không có node nào để xóa' }
      doc.topics = doc.topics.filter((t) => !allIds.has(t.id))
      doc.crosslinks = doc.crosslinks.filter((c) => !allIds.has(c.source) && !allIds.has(c.target))
      // orphan floating giữ nguyên (chúng có parent null); orphan normal được nối về null? không xảy ra vì xóa cả subtree
      return { ok: true, focusIds }
    }
    case 'deleteOnly': {
      const t = getTopic(doc, cmd.id)
      if (!t || !t.parent_id) return { ok: false, error: 'Chỉ áp dụng cho node thường có cha' }
      if (t.id === doc.central_topic_id) return { ok: false, error: 'Không thể xóa Central' }
      const parent = t.parent_id
      const kids = childrenOf(doc, t.id)
      const touched = doc.crosslinks.filter((c) => c.source === t.id || c.target === t.id)
      doc.topics = doc.topics.filter((x) => x.id !== t.id)
      kids.forEach((k) => { k.parent_id = parent })
      // Giữ vị trí của node bị xóa cho các con: dựng mảng đích tường minh
      // [các anh chị em trước pos] + [các con (giữ thứ tự tương đối)] + [sau pos]
      // rồi gán order 0..n-1. (Trước đây dùng pos+i+1000 => normalizeOrders luôn
      // đẩy các con xuống cuối, mất vị trí.)
      const sibs = childrenOf(doc, parent).filter((s) => !kids.includes(s))
      const pos = sibs.findIndex((s) => s.order > t.order)
      const insertAt = pos < 0 ? sibs.length : pos
      const final = [...sibs.slice(0, insertAt), ...kids, ...sibs.slice(insertAt)]
      final.forEach((n, i) => { n.order = i })
      doc.crosslinks = doc.crosslinks.filter((c) => !touched.includes(c))
      return { ok: true, focusIds }
    }
    case 'setText': {
      const t = getTopic(doc, cmd.id)
      if (!t) return { ok: false, error: 'Node không tồn tại' }
      t.text = cmd.after
      return { ok: true, focusIds }
    }
    case 'batchEditText': {
      const topics = new Map(doc.topics.map(t => [t.id, t]))
      const seen = new Set<string>()
      for (const e of cmd.edits) {
        const t = topics.get(e.id)
        if (!t) return { ok: false, error: 'Node không tồn tại trong batch thay thế' }
        const field = e.field ?? 'title'
        const current = field === 'notes' ? (t.notes ?? '') : t.text
        const key = `${field}:${e.id}`
        if (seen.has(key) || current !== e.before) return { ok: false, error: 'Nội dung đã thay đổi trong lúc xem trước. Hãy chạy lại thay thế.' }
        if (field === 'title' && current.trim() && !e.after.trim()) return { ok: false, error: 'Kết quả thay thế sẽ làm trống tiêu đề.' }
        seen.add(key)
      }
      for (const e of cmd.edits) {
        const t = topics.get(e.id)!
        if (e.field === 'notes') t.notes = e.after || null
        else t.text = e.after
      }
      return { ok: true, focusIds }
    }
    case 'setProps': {
      const t = getTopic(doc, cmd.id)
      if (!t) return { ok: false, error: 'Node không tồn tại' }
      touchProps(t, cmd.after)
      return { ok: true, focusIds }
    }
    case 'setTextStyle': {
      for (const id of cmd.ids) {
        const t = getTopic(doc, id)
        if (!t) continue
        const patch = cmd.perTopic?.[id] ? { ...cmd.after, ...cmd.perTopic[id] } : cmd.after
        const merged: TextStyleOverride = { ...(t.style.text ?? {}), ...clean(patch) }
        t.style.text = Object.keys(merged).length ? merged : {}
      }
      return { ok: true, focusIds }
    }
    case 'setBoxStyle': {
      for (const id of cmd.ids) {
        const t = getTopic(doc, id)
        if (!t) continue
        const merged: BoxStyleOverride = { ...(t.style.box_style ?? {}), ...clean(cmd.after) }
        t.style.box_style = Object.keys(merged).length ? merged : {}
      }
      return { ok: true, focusIds }
    }
    case 'setEdgeStyle': {
      for (const id of cmd.ids) {
        const t = getTopic(doc, id)
        if (!t) continue
        const merged: EdgeStyleOverride = { ...(t.style.hierarchy_edge ?? {}), ...clean(cmd.after) }
        t.style.hierarchy_edge = Object.keys(merged).length ? merged : {}
      }
      return { ok: true, focusIds }
    }
    case 'setBranchStyle': {
      const t = getTopic(doc, cmd.id)
      if (!t) return { ok: false, error: 'Node không tồn tại' }
      const merged: BranchStyleOverride = { ...(t.branch_style_override ?? {}), ...clean(cmd.after) }
      t.branch_style_override = Object.keys(merged).length ? merged : null
      return { ok: true, focusIds }
    }
    case 'resetNodeStyle': {
      for (const id of cmd.ids) {
        const t = getTopic(doc, id)
        if (!t) continue
        if (cmd.scope) t.style[cmd.scope] = {}
        else t.style = { text: {}, box_style: {}, hierarchy_edge: {} }
      }
      return { ok: true, focusIds }
    }
    case 'resetBranchStyle': {
      const t = getTopic(doc, cmd.id)
      if (t) t.branch_style_override = null
      return { ok: true, focusIds }
    }
    case 'reparent': {
      const hasFloatPos = cmd.items.some((it) => it.floatingPosition !== undefined)
      if (hasFloatPos) {
        if (cmd.items.length !== 1) return { ok: false, error: 'Tọa độ nổi chỉ áp dụng khi tách một nhánh' }
        const it = cmd.items[0]
        const src = getTopic(doc, it.id)
        if (!src || src.id === doc.central_topic_id || src.role !== 'normal' || src.parent_id === null || it.newParentId !== null) {
          return { ok: false, error: 'Tọa độ nổi chỉ áp dụng khi tách nhánh thường đang có cha' }
        }
        if (!isFinitePoint(it.floatingPosition)) {
          return { ok: false, error: 'Tọa độ nổi không hợp lệ' }
        }
      }
      for (const it of cmd.items) {
        const t = getTopic(doc, it.id)
        if (!t) continue
        const err = validateReparent(doc, it.id, it.newParentId)
        if (err) return { ok: false, error: err }
      }
      for (const it of cmd.items) {
        const t = getTopic(doc, it.id)
        if (!t) continue
        t.parent_id = it.newParentId
        t.order = it.newOrder
        if (it.newParentId === null && t.role === 'normal') t.role = 'floating'
        if (it.newParentId !== null && t.role === 'floating') t.role = 'normal'
        if (it.floatingPosition !== undefined) {
          t.manual_position = { x: it.floatingPosition.x, y: it.floatingPosition.y }
        }
      }
      const parents = new Set(cmd.items.map((i) => i.newParentId))
      parents.forEach((p) => normalizeOrders(doc, p))
      cmd.items.forEach((i) => normalizeOrders(doc, i.oldParentId))
      return { ok: true, focusIds }
    }
    case 'moveFreeform': {
      for (const it of cmd.items) {
        const t = getTopic(doc, it.id)
        if (t) t.manual_position = it.to ? { ...it.to } : null
      }
      return { ok: true, focusIds }
    }
    case 'collapse': {
      for (const it of cmd.items) {
        const t = getTopic(doc, it.id)
        if (t) t.collapsed = it.value
      }
      return { ok: true, focusIds }
    }
    case 'duplicateSubtree': {
      const src = getTopic(doc, cmd.id)
      if (!src) return { ok: false, error: 'Node không tồn tại' }
      if (src.id === doc.central_topic_id || src.role === 'central') {
        return { ok: false, error: 'Không thể nhân bản Chủ đề trung tâm' }
      }
      const { topics, idMap } = cloneSubtree(doc, cmd.id, { newTopicIds: true, seedFromIds: true })
      const revMap = new Map<string, string>()
      for (const [origId, newId] of idMap) revMap.set(newId, origId)
      const delta = { x: 40, y: 40 }
      const isFreeform = doc.layout.kind === 'freeform'
      const shiftedTopics = topics.map((t, index) => {
        const origId = revMap.get(t.id)
        const basePos = t.manual_position ?? (isFreeform && origId ? cmd.resolvedPositions?.[origId] ?? null : null)
        const manual_position = basePos ? { x: basePos.x + delta.x, y: basePos.y + delta.y } : null
        if (index === 0) return { ...t, order: nextOrder(doc, src.parent_id), manual_position }
        return { ...t, manual_position }
      })
      const internalLinks = crosslinksWithin(doc, new Set(idMap.keys())).map((c) => {
        const cloned = structuredClone(c)
        return {
          ...cloned,
          id: uuid(),
          source: idMap.get(c.source)!,
          target: idMap.get(c.target)!,
          waypoints: cloned.waypoints ? cloned.waypoints.map((wp) => ({ x: wp.x + delta.x, y: wp.y + delta.y })) : cloned.waypoints,
        }
      })
      doc.topics.push(...shiftedTopics)
      doc.crosslinks.push(...internalLinks)
      normalizeOrders(doc, src.parent_id)
      focusIds.push(shiftedTopics[0].id)
      return { ok: true, focusIds }
    }
    case 'attachImage': {
      const t = getTopic(doc, cmd.id)
      if (!t) return { ok: false, error: 'Node không tồn tại' }
      const incoming = cmd.asset
      const existing = doc.assets.find(a => a.mime === incoming.mime && a.width === incoming.width
        && a.height === incoming.height && a.data_url === incoming.data_url)
      const asset = existing ?? (doc.assets.some(a => a.id === incoming.id) ? { ...incoming, id: uuid() } : incoming)
      if (!existing) doc.assets.push(asset)
      t.image = { ...cmd.after, asset_id: asset.id }
      return { ok: true, focusIds }
    }
    case 'removeImage': {
      const t = getTopic(doc, cmd.id)
      if (t) t.image = null
      return { ok: true, focusIds }
    }
    case 'addDrawing': {
      doc.drawings.push(cmd.drawing)
      return { ok: true, focusIds }
    }
    case 'removeDrawings': {
      const ids = new Set(cmd.drawings.map((d) => d.id))
      doc.drawings = doc.drawings.filter((d) => !ids.has(d.id))
      return { ok: true, focusIds }
    }
    case 'modifyDrawing': {
      const d = doc.drawings.find((x) => x.id === cmd.id)
      if (d) Object.assign(d, cmd.after)
      return { ok: true, focusIds }
    }
    case 'addCrosslink': {
      if (cmd.crosslink.source === cmd.crosslink.target) return { ok: false, error: 'Hai đầu nối phải khác nhau' }
      // Bất biến dữ liệu: cả 2 đầu phải là topic tồn tại (đồng bộ phía nhập
      // parseProjectJSON đã lọc theo ids.has). Trước đây chấp nhận đầu nối lạ
      // => crosslink mồ côi vô hình, lưu/xuất vĩnh viễn, không xóa được qua UI.
      if (!getTopic(doc, cmd.crosslink.source) || !getTopic(doc, cmd.crosslink.target)) return { ok: false, error: 'Đầu nối không tồn tại' }
      doc.crosslinks.push(cmd.crosslink)
      return { ok: true, focusIds }
    }
    case 'modifyCrosslink': {
      const c = doc.crosslinks.find((x) => x.id === cmd.id)
      if (c) Object.assign(c, cmd.after)
      return { ok: true, focusIds }
    }
    case 'removeCrosslinks': {
      const ids = new Set(cmd.crosslinks.map((c) => c.id))
      doc.crosslinks = doc.crosslinks.filter((c) => !ids.has(c.id))
      return { ok: true, focusIds }
    }
    case 'setLayout': {
      doc.layout = { ...cmd.after }
      return { ok: true, focusIds }
    }
    case 'setTheme': {
      doc.theme_id = cmd.after
      return { ok: true, focusIds }
    }
    case 'renameProject': {
      doc.name = cmd.after
      return { ok: true, focusIds }
    }
    default:
      return { ok: false, error: 'Lệnh không hỗ trợ' }
  }
}

function clean(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/* ---------- Nghiệp vụ cấp cao dựng command (UI gọi) ---------- */
export const cmdBuilders = {
  addChild(doc: ProjectDocV3, parentId: string | null, text = 'Chủ đề mới', index: number | null = null): Command {
    return { type: 'addTopic', topic: makeChildTopic(doc, parentId, text), parentId, index, focusEditor: true }
  },
  addSibling(doc: ProjectDocV3, refId: string, before = false): Command | null {
    const ref = getTopic(doc, refId)
    if (!ref) return null
    if (ref.role === 'central' || ref.id === doc.central_topic_id) {
      // Central → Enter tạo main child; chèn ngang trước Central vẫn bị chặn (N35-02/N35-03)
      return before ? null : cmdBuilders.addChild(doc, ref.id)
    }
    const index = before ? ref.order : ref.order + 1
    return { type: 'addTopic', topic: makeChildTopic(doc, ref.parent_id, 'Chủ đề mới'), parentId: ref.parent_id, index, focusEditor: true }
  },
  insertParent(doc: ProjectDocV3, id: string): Command | null {
    const t = getTopic(doc, id)
    if (!t || !t.parent_id || t.id === doc.central_topic_id) return null
    const p = makeChildTopic(doc, t.parent_id, 'Chủ đề mới')
    p.order = t.order
    const tNew: Topic = { ...t, parent_id: p.id, order: 0 }
    const kids = childrenOf(doc, t.id)
    return {
      type: 'composite',
      commands: [
        { type: 'addTopic', topic: p, parentId: t.parent_id, index: t.order, focusEditor: true },
        { type: 'reparent', items: [{ id: t.id, oldParentId: t.parent_id, oldOrder: t.order, newParentId: p.id, newOrder: 0 }] },
      ],
    }
  },
  detachToFloating(doc: ProjectDocV3, id: string, floatingPosition?: { x: number; y: number }): Command | null {
    const t = getTopic(doc, id)
    if (!t || !t.parent_id || t.id === doc.central_topic_id || t.role !== 'normal') return null
    if (floatingPosition !== undefined && !isFinitePoint(floatingPosition)) return null
    return {
      type: 'reparent',
      items: [{
        id,
        oldParentId: t.parent_id,
        oldOrder: t.order,
        newParentId: null,
        newOrder: nextOrder(doc, null),
        ...(floatingPosition !== undefined ? { floatingPosition: { x: floatingPosition.x, y: floatingPosition.y } } : {}),
      }],
    }
  },
  attachFloating(doc: ProjectDocV3, id: string, parentId: string, index: number | null = null): Command | null {
    const t = getTopic(doc, id)
    if (!t || t.parent_id !== null) return null
    return { type: 'reparent', items: [{ id, oldParentId: null, oldOrder: t.order, newParentId: parentId, newOrder: index ?? nextOrder(doc, parentId) }] }
  },
  duplicateNodeOnly(doc: ProjectDocV3, id: string, resolvedPos?: { x: number; y: number }): Command | null {
    const t = getTopic(doc, id)
    if (!t || t.id === doc.central_topic_id || t.role === 'central') return null
    const basePos = t.manual_position ?? (doc.layout.kind === 'freeform' ? resolvedPos ?? null : null)
    const copy = newTopic({
      ...structuredClone(t),
      id: uuid(),
      order: t.order + 1,
      branch_color_seed: null,
      manual_position: basePos ? { x: basePos.x + 40, y: basePos.y + 40 } : null,
    })
    return { type: 'addTopic', topic: copy, parentId: t.parent_id, index: t.order + 1, focusEditor: false }
  },
  promote(doc: ProjectDocV3, id: string): Command | null {
    const t = getTopic(doc, id)
    if (!t || !t.parent_id || t.id === doc.central_topic_id) return null
    const parent = getTopic(doc, t.parent_id)
    if (!parent || !parent.parent_id) return null // cấp 1 không promote lên central thứ hai → dùng Detach
    const grandParent = parent.parent_id
    const sibs = childrenOf(doc, grandParent)
    const parentIndex = sibs.findIndex((s) => s.id === parent.id)
    if (parentIndex < 0) return null
    // Insert immediately after the old parent and renumber the target siblings
    // explicitly. The old idx+1 approach collided with the next sibling's order and
    // stable sorting could leave the promoted node after it (A,B,A1 instead of A,A1,B).
    const final = [...sibs.slice(0, parentIndex + 1), t, ...sibs.slice(parentIndex + 1)]
    const items = final.flatMap((node, index) => {
      if (node.id === t.id) return [{ id: t.id, oldParentId: t.parent_id!, oldOrder: t.order, newParentId: grandParent, newOrder: index }]
      return node.order === index ? [] : [{ id: node.id, oldParentId: grandParent, oldOrder: node.order, newParentId: grandParent, newOrder: index }]
    })
    return { type: 'reparent', items }
  },
  demote(doc: ProjectDocV3, id: string): Command | null {
    const t = getTopic(doc, id)
    if (!t || !t.parent_id || t.id === doc.central_topic_id) return null
    const sibs = childrenOf(doc, t.parent_id).filter((s) => s.id !== id)
    const prev = sibs.filter((s) => s.order < t.order).sort((a, b) => b.order - a.order)[0]
    if (!prev) return null // disabled + tooltip
    return { type: 'reparent', items: [{ id, oldParentId: t.parent_id, oldOrder: t.order, newParentId: prev.id, newOrder: nextOrder(doc, prev.id) }] }
  },
  reorderUpDown(doc: ProjectDocV3, id: string, dir: -1 | 1): Command | null {
    const t = getTopic(doc, id)
    if (!t || t.id === doc.central_topic_id || t.role === 'central') return null
    const sibs = childrenOf(doc, t.parent_id).filter((s) => s.id !== doc.central_topic_id)
    const idx = sibs.findIndex((s) => s.id === id)
    const j = idx + dir
    if (idx < 0 || j < 0 || j >= sibs.length) return null
    return {
      type: 'reparent',
      items: [
        { id: sibs[idx].id, oldParentId: t.parent_id, oldOrder: sibs[idx].order, newParentId: t.parent_id, newOrder: sibs[j].order },
        { id: sibs[j].id, oldParentId: t.parent_id, oldOrder: sibs[j].order, newParentId: t.parent_id, newOrder: sibs[idx].order },
      ],
    }
  },
}

export { subtreeSize }
