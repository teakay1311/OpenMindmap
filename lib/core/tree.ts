/* ============================================================
 * OpenMindmap — lib/core/tree.ts
 * Hỗ trợ cấu trúc cây: children map, descendants, ancestors,
 * kiểm tra cycle, orders, clone/remap (SRS 04, 08.2)
 * ============================================================ */
import { Topic, ProjectDocV3, Crosslink, uuid, stableSeed, getTheme } from './types'

export function childrenOf(doc: ProjectDocV3, parentId: string | null): Topic[] {
  return doc.topics
    .filter((t) => t.parent_id === parentId)
    .sort((a, b) => a.order - b.order)
}

/* ============================================================
 * TreeIndex — lookup O(1) cho các đường nóng (buildScene/layout).
 * Chỉ dùng trong phạm vi một lần tính toán thuần (không mutate doc),
 * commands.ts tiếp tục dùng các hàm tuyến tính phía trên vì nó
 * mutate draft giữa các lần gọi (an toàn hơn là cache toàn cục).
 * ============================================================ */
export interface TreeIndex {
  byId: Map<string, Topic>
  children: Map<string | null, Topic[]> // đã sort theo order
}

export function buildIndex(doc: ProjectDocV3): TreeIndex {
  const byId = new Map<string, Topic>()
  const children = new Map<string | null, Topic[]>()
  for (const t of doc.topics) {
    byId.set(t.id, t)
    const arr = children.get(t.parent_id)
    if (arr) arr.push(t)
    else children.set(t.parent_id, [t])
  }
  for (const arr of children.values()) arr.sort((a, b) => a.order - b.order)
  return { byId, children }
}

export function idxTopic(idx: TreeIndex, id: string): Topic | undefined {
  return idx.byId.get(id)
}
export function idxChildren(idx: TreeIndex, parentId: string | null): Topic[] {
  return idx.children.get(parentId) ?? EMPTY_CHILDREN
}
const EMPTY_CHILDREN: Topic[] = []
export function idxDescendants(idx: TreeIndex, id: string): Topic[] {
  const out: Topic[] = []
  const walk = (pid: string) => {
    for (const c of idxChildren(idx, pid)) { out.push(c); walk(c.id) }
  }
  walk(id)
  return out
}
export function idxAncestors(idx: TreeIndex, id: string): Topic[] {
  const out: Topic[] = []
  let cur = idx.byId.get(id)
  const guard = new Set<string>()
  while (cur?.parent_id) {
    if (guard.has(cur.parent_id)) break
    guard.add(cur.parent_id)
    const p = idx.byId.get(cur.parent_id)
    if (!p) break
    out.push(p)
    cur = p
  }
  return out
}
export function topicMap(doc: ProjectDocV3): Map<string, Topic> {
  return new Map(doc.topics.map((t) => [t.id, t]))
}
export function getTopic(doc: ProjectDocV3, id: string): Topic | undefined {
  return doc.topics.find((t) => t.id === id)
}
export function descendantsOf(doc: ProjectDocV3, id: string): Topic[] {
  const out: Topic[] = []
  const walk = (pid: string) => {
    for (const c of childrenOf(doc, pid)) { out.push(c); walk(c.id) }
  }
  walk(id)
  return out
}
export function ancestorsOf(doc: ProjectDocV3, id: string): Topic[] {
  const byId = topicMap(doc)
  const out: Topic[] = []
  let cur = byId.get(id)
  const guard = new Set<string>()
  while (cur?.parent_id) {
    if (guard.has(cur.parent_id)) break
    guard.add(cur.parent_id)
    const p = byId.get(cur.parent_id)
    if (!p) break
    out.push(p)
    cur = p
  }
  return out
}
export function depthOf(doc: ProjectDocV3, id: string): number {
  return ancestorsOf(doc, id).length
}
/** root của subtree (central hoặc floating) */
export function rootOf(doc: ProjectDocV3, id: string): Topic {
  const anc = ancestorsOf(doc, id)
  return anc.length ? anc[anc.length - 1] : getTopic(doc, id)!
}
/** Danh sách các root (central + floating) theo order */
export function rootsOf(doc: ProjectDocV3): Topic[] {
  const central = doc.topics.find((t) => t.id === doc.central_topic_id)!
  const floating = childrenOf(doc, null).filter((t) => t.id !== doc.central_topic_id)
  return [central, ...floating]
}
/** Kiểm tra target có phải là descendant của node (chống cycle khi reparent) */
export function isDescendantOrSelf(doc: ProjectDocV3, ancestorId: string, maybeChildId: string): boolean {
  if (ancestorId === maybeChildId) return true
  return descendantsOf(doc, ancestorId).some((t) => t.id === maybeChildId)
}
export function nextOrder(doc: ProjectDocV3, parentId: string | null): number {
  const kids = doc.topics.filter((t) => t.parent_id === parentId)
  return kids.length ? Math.max(...kids.map((k) => k.order)) + 1 : 0
}
/** Chuẩn hóa order 0..n-1 giữ theo thứ tự order cũ */
export function normalizeOrders(doc: ProjectDocV3, parentId: string | null): void {
  const kids = childrenOf(doc, parentId)
  kids.forEach((k, i) => { k.order = i })
}
export function isCentral(doc: ProjectDocV3, id: string): boolean {
  return id === doc.central_topic_id
}
export function isFloatingRoot(doc: ProjectDocV3, id: string): boolean {
  const t = getTopic(doc, id)
  return !!t && t.role === 'floating'
}
export function isLevel1(doc: ProjectDocV3, id: string): boolean {
  const t = getTopic(doc, id)
  return !!t && t.parent_id === doc.central_topic_id
}
/** Tạo bản clone subtree với ID mới (Duplicate Branch / Save As remap) */
export function cloneSubtree(
  doc: ProjectDocV3, rootId: string,
  opts: { newTopicIds?: boolean; seedFromIds?: boolean } = { newTopicIds: true, seedFromIds: true },
): { topics: Topic[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>()
  const srcRoot = getTopic(doc, rootId)!
  const subtree = [srcRoot, ...descendantsOf(doc, rootId)]
  for (const t of subtree) idMap.set(t.id, opts.newTopicIds ? uuid() : t.id)
  const topics = subtree.map((t) => ({
    ...structuredClone(t),
    id: idMap.get(t.id)!,
    parent_id: t.parent_id && idMap.has(t.parent_id) ? idMap.get(t.parent_id)! : t.parent_id,
    branch_color_seed: opts.seedFromIds ? stableSeed(idMap.get(t.id)!) : t.branch_color_seed,
  }))
  return { topics, idMap }
}
/** Crosslinks nội bộ của một tập ID (cả 2 đầu thuộc tập) */
export function crosslinksWithin(doc: ProjectDocV3, ids: Set<string>): Crosslink[] {
  return doc.crosslinks.filter((c) => ids.has(c.source) && ids.has(c.target))
}
export function crosslinksTouching(doc: ProjectDocV3, ids: Set<string>): Crosslink[] {
  return doc.crosslinks.filter((c) => ids.has(c.source) || ids.has(c.target))
}
/** Số node trong subtree (để confirm xóa >20 — N35-09) */
export function subtreeSize(doc: ProjectDocV3, id: string): number {
  return 1 + descendantsOf(doc, id).length
}
/** Lớp sâu nhất của subtree */
export function subtreeMaxDepth(doc: ProjectDocV3, id: string): number {
  let max = 0
  const walk = (tid: string, d: number) => {
    max = Math.max(max, d)
    for (const c of childrenOf(doc, tid)) walk(c.id, d + 1)
  }
  walk(id, 0)
  return max
}
/** Sắp xếp mọi order theo duyệt cây để xuất ổn định */
export function walkTree(doc: ProjectDocV3, rootId: string, visit: (t: Topic, depth: number, index: number) => void): void {
  const walk = (pid: string, depth: number) => {
    childrenOf(doc, pid).forEach((c, i) => {
      visit(c, depth, i)
      walk(c.id, depth + 1)
    })
  }
  const root = getTopic(doc, rootId)
  if (!root) return
  visit(root, 0, 0)
  walk(rootId, 1)
}
/** topic-path zero-based theo duyệt toàn file (14.6.1.1): root đầu tiên là "0" */
export function topicPathOf(doc: ProjectDocV3, id: string): string {
  const roots = rootsOf(doc)
  const rootIdx = roots.findIndex((r) => r.id === rootOf(doc, id).id)
  const path: number[] = []
  let cur = getTopic(doc, id)!
  const byId = topicMap(doc)
  while (cur.parent_id && cur.parent_id !== rootOf(doc, id).id) {
    const sibs = childrenOf(doc, cur.parent_id)
    path.unshift(sibs.findIndex((s) => s.id === cur.id))
    cur = byId.get(cur.parent_id)!
  }
  return [rootIdx, ...path].join('.')
}
/** Gán màu nhánh cấp-1 theo seed ổn định (16.4 branch assignment) */
export function branchAccentFor(doc: ProjectDocV3, themeId: string, topicId: string, idx?: TreeIndex): string {
  const theme = getTheme(doc.theme_id)
  const t = idx ? idx.byId.get(topicId) : getTopic(doc, topicId)
  if (t?.branch_style_override?.accent_color) return t.branch_style_override.accent_color
  const seed = t?.branch_color_seed ?? stableSeed(topicId)
  return theme.accents[seed % theme.accents.length]
}
