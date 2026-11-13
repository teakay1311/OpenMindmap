import { Box } from '../layout/engine'
import { childrenOf, getTopic, isDescendantOrSelf } from '../core/tree'
import { ProjectDocV3 } from '../core/types'
import { Scene, SceneNode } from './scene'

export const DETACH_MIN_DRAG_CSS = 120
export const DETACH_MIN_TARGET_CLEARANCE_CSS = 48

export type AutoDragIntent = 'move' | 'reparent' | 'reorder' | 'side' | 'detach' | 'invalid' | 'cancel'

export interface AutoDragClassifyInput {
  doc: ProjectDocV3
  scene: Scene
  sourceIds: string[]
  startClient: { x: number; y: number }
  pointerClient: { x: number; y: number }
  pointerWorld: { x: number; y: number }
  zoom: number
  inActiveCanvas: boolean
  balancedStartSide: 'left' | 'right' | null
  hoveredNode: SceneNode | null
  overCanvasObstacle?: boolean
}

export interface AutoDragResult {
  intent: AutoDragIntent
  target: string | null
  line: { x1: number; y1: number; x2: number; y2: number } | null
  parentId: string | null
  index: number
  msg: string
  dragDistCss: number
  minTargetDistCss: number
}

/** Distance in CSS px from world point `pt` to world box `b` at `zoom`. Returns 0 if inside. */
export function pointToBoxDistCss(pt: { x: number; y: number }, box: Box, zoom: number): number {
  const dx = pt.x < box.x ? box.x - pt.x : pt.x > box.x + box.w ? pt.x - (box.x + box.w) : 0
  const dy = pt.y < box.y ? box.y - pt.y : pt.y > box.y + box.h ? pt.y - (box.y + box.h) : 0
  return Math.hypot(dx, dy) * zoom
}

/** Opposite-side Balanced flip zones padded by 48 CSS px and clamped to the target half of Central. */
export function balancedFlipZones(
  doc: ProjectDocV3,
  scene: Scene,
  sourceId: string,
  startSide: 'left' | 'right' | null,
  zoom: number,
): { boxes: Box[]; oppSide: 'left' | 'right' } | null {
  if (doc.layout.kind !== 'balanced' || !startSide) return null
  const src = getTopic(doc, sourceId)
  if (!src || src.parent_id !== doc.central_topic_id) return null
  const central = scene.byId.get(doc.central_topic_id)
  if (!central) return null
  const cx = central.box.x + central.box.w / 2
  const oppSide: 'left' | 'right' = startSide === 'left' ? 'right' : 'left'
  const oppBoxes: Box[] = []
  for (const t of childrenOf(doc, doc.central_topic_id)) {
    if (t.id === sourceId) continue
    const n = scene.byId.get(t.id)
    if (!n) continue
    const nSide = n.box.x + n.box.w / 2 < cx ? 'left' : 'right'
    if (nSide === oppSide) oppBoxes.push(n.box)
  }
  if (!oppBoxes.length) {
    const srcNode = scene.byId.get(sourceId)
    if (!srcNode) return null
    oppBoxes.push({
      x: 2 * cx - (srcNode.box.x + srcNode.box.w),
      y: srcNode.box.y,
      w: srcNode.box.w,
      h: srcNode.box.h,
    })
  }
  const pad = DETACH_MIN_TARGET_CLEARANCE_CSS / zoom
  const padded = oppBoxes.map((b) => {
    const top = b.y - pad
    const bottom = b.y + b.h + pad
    if (oppSide === 'right') {
      const left = Math.max(cx, b.x - pad)
      const right = Math.max(left, b.x + b.w + pad)
      return { x: left, y: top, w: right - left, h: bottom - top }
    }
    const right = Math.min(cx, b.x + b.w + pad)
    const left = Math.min(right, b.x - pad)
    return { x: left, y: top, w: right - left, h: bottom - top }
  })
  return { boxes: padded, oppSide }
}

/** Shared drop & detach classifier used by Canvas pointer move, auto-pan, pointer up, and tests. */
export function classifyAutoDragTarget(input: AutoDragClassifyInput): AutoDragResult {
  const {
    doc, scene, sourceIds, startClient, pointerClient, pointerWorld,
    zoom, inActiveCanvas, balancedStartSide, hoveredNode, overCanvasObstacle,
  } = input
  const dragDistCss = Math.hypot(pointerClient.x - startClient.x, pointerClient.y - startClient.y)

  // Compute reorder hit zones and candidate slot (never include source or its descendants!)
  const band = Math.max(14, 14 / zoom)
  const stackY = doc.layout.kind === 'balanced' || doc.layout.kind === 'logic'
  const sourceParent = getTopic(doc, sourceIds[0])?.parent_id ?? null
  const groups = new Map<string, SceneNode[]>()
  for (const n of scene.nodes) {
    if (sourceIds.some((id) => isDescendantOrSelf(doc, id, n.id))) continue
    const t = getTopic(doc, n.id)
    if (!t?.parent_id || sourceIds.some((id) => isDescendantOrSelf(doc, id, t.parent_id!))) continue
    const arr = groups.get(t.parent_id) ?? []
    arr.push(n)
    groups.set(t.parent_id, arr)
  }

  const reorderZones: Box[] = []
  let bestMatch: { parentId: string; group: SceneNode[]; dist: number } | null = null
  const central = scene.byId.get(doc.central_topic_id)
  const centralCx = central ? central.box.x + central.box.w / 2 : 0

  for (const [parentId, rawGroup] of groups) {
    const subGroups: SceneNode[][] = []
    if (doc.layout.kind === 'balanced' && parentId === doc.central_topic_id && central) {
      const leftG = rawGroup.filter((n) => n.box.x + n.box.w / 2 < centralCx)
      const rightG = rawGroup.filter((n) => n.box.x + n.box.w / 2 >= centralCx)
      if (leftG.length) subGroups.push(leftG)
      if (rightG.length) subGroups.push(rightG)
    } else {
      subGroups.push(rawGroup)
    }
    for (const group of subGroups) {
      const minX = Math.min(...group.map((n) => n.box.x)) - band
      const maxX = Math.max(...group.map((n) => n.box.x + n.box.w)) + band
      const minY = Math.min(...group.map((n) => n.box.y)) - band
      const maxY = Math.max(...group.map((n) => n.box.y + n.box.h)) + band
      reorderZones.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY })
      if (pointerWorld.x < minX || pointerWorld.x > maxX || pointerWorld.y < minY || pointerWorld.y > maxY) continue
      const minDist = Math.min(...group.map((n) => stackY
        ? Math.abs(pointerWorld.y - (n.box.y + n.box.h / 2))
        : Math.abs(pointerWorld.x - (n.box.x + n.box.w / 2)))) + (parentId === sourceParent ? 0 : 1e-3)
      if (!bestMatch || minDist < bestMatch.dist) bestMatch = { parentId, group, dist: minDist }
    }
  }

  const flip = sourceIds.length === 1
    ? balancedFlipZones(doc, scene, sourceIds[0], balancedStartSide, zoom)
    : null

  let minTargetDistCss = Infinity
  for (const n of scene.nodes) {
    minTargetDistCss = Math.min(minTargetDistCss, pointToBoxDistCss(pointerWorld, n.box, zoom))
  }
  for (const z of reorderZones) {
    minTargetDistCss = Math.min(minTargetDistCss, pointToBoxDistCss(pointerWorld, z, zoom))
  }
  if (flip) {
    for (const fb of flip.boxes) {
      minTargetDistCss = Math.min(minTargetDistCss, pointToBoxDistCss(pointerWorld, fb, zoom))
    }
  }
  if (!Number.isFinite(minTargetDistCss)) minTargetDistCss = 0

  const src = sourceIds.length === 1 ? getTopic(doc, sourceIds[0]) : undefined
  const isSingleFloatingMove = doc.layout.kind !== 'freeform'
    && !!src
    && src.role === 'floating'
    && src.parent_id === null
    && src.id !== doc.central_topic_id

  // Priority 1: outside active canvas / overlay occluded OR cycle on source/descendant
  if (!inActiveCanvas) {
    return { intent: 'cancel', target: null, line: null, parentId: null, index: -1, msg: '', dragDistCss, minTargetDistCss }
  }
  if (hoveredNode) {
    const isDescendantOnly = sourceIds.some((id) => hoveredNode.id !== id && isDescendantOrSelf(doc, id, hoveredNode.id))
    if (isDescendantOnly) {
      return { intent: 'invalid', target: hoveredNode.id, line: null, parentId: null, index: -1, msg: 'Không thể thả: sẽ tạo vòng lặp cha–con', dragDistCss, minTargetDistCss: 0 }
    }
    if (isSingleFloatingMove) {
      const ownNode = scene.byId.get(src!.id)
      // When pointer is on the dragged floating root's own box (even overlapping another node underneath), treat as move, never self-reparent or underlying attach.
      if (ownNode && pointToBoxDistCss(pointerWorld, ownNode.box, zoom) === 0) {
        return { intent: 'move', target: src!.id, line: null, parentId: null, index: -1, msg: '', dragDistCss, minTargetDistCss }
      }
    }
    if (sourceIds.includes(hoveredNode.id)) {
      return { intent: 'invalid', target: hoveredNode.id, line: null, parentId: null, index: -1, msg: 'Không thể thả: sẽ tạo vòng lặp cha–con', dragDistCss, minTargetDistCss: 0 }
    }
    // Priority 2a: reparent onto target node
    return { intent: 'reparent', target: hoveredNode.id, line: null, parentId: hoveredNode.id, index: -1, msg: '', dragDistCss, minTargetDistCss: 0 }
  }
  if (isSingleFloatingMove) {
    const ownNode = scene.byId.get(src!.id)
    if (ownNode && pointToBoxDistCss(pointerWorld, ownNode.box, zoom) === 0) {
      return { intent: 'move', target: src!.id, line: null, parentId: null, index: -1, msg: '', dragDistCss, minTargetDistCss }
    }
  }

  // Priority 2b: valid sibling reorder insertion band
  if (bestMatch) {
    const sorted = [...bestMatch.group].sort((a, b) => stackY
      ? (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2)
      : (a.box.x + a.box.w / 2) - (b.box.x + b.box.w / 2))
    let slot = sorted.length
    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i].box
      const mid = stackY ? b.y + b.h / 2 : b.x + b.w / 2
      if ((stackY ? pointerWorld.y : pointerWorld.x) < mid) { slot = i; break }
    }
    const sibs = childrenOf(doc, bestMatch.parentId).filter((s) => !sourceIds.includes(s.id))
    const index = slot < sorted.length
      ? Math.max(0, sibs.findIndex((s) => s.id === sorted[slot].id))
      : (sorted.length ? Math.max(0, sibs.findIndex((s) => s.id === sorted[sorted.length - 1].id)) + 1 : 0)
    const targetNode = sorted[Math.min(slot, sorted.length - 1)]
    let line: AutoDragResult['line'] = null
    if (stackY) {
      const x1 = Math.min(...sorted.map((n) => n.box.x)) - 14
      const x2 = Math.max(...sorted.map((n) => n.box.x + n.box.w)) + 14
      const y = slot === 0
        ? sorted[0].box.y - 5
        : slot >= sorted.length
          ? sorted[sorted.length - 1].box.y + sorted[sorted.length - 1].box.h + 5
          : (sorted[slot - 1].box.y + sorted[slot - 1].box.h + sorted[slot].box.y) / 2
      line = { x1, y1: y, x2, y2: y }
    } else {
      const y1 = Math.min(...sorted.map((n) => n.box.y)) - 14
      const y2 = Math.max(...sorted.map((n) => n.box.y + n.box.h)) + 14
      const x = slot === 0
        ? sorted[0].box.x - 5
        : slot >= sorted.length
          ? sorted[sorted.length - 1].box.x + sorted[sorted.length - 1].box.w + 5
          : (sorted[slot - 1].box.x + sorted[slot - 1].box.w + sorted[slot].box.x) / 2
      line = { x1: x, y1, x2: x, y2 }
    }
    return { intent: 'reorder', target: targetNode.id, line, parentId: bestMatch.parentId, index, msg: '', dragDistCss, minTargetDistCss: 0 }
  }

  // Priority 3: Balanced opposite-side 48px flip zone
  if (flip && flip.boxes.some((fb) => pointToBoxDistCss(pointerWorld, fb, zoom) === 0)) {
    return {
      intent: 'side',
      target: sourceIds[0],
      line: null,
      parentId: null,
      index: flip.oppSide === 'left' ? -2 : -3,
      msg: `Gán nhánh về bên ${flip.oppSide === 'left' ? 'trái' : 'phải'}`,
      dragDistCss,
      minTargetDistCss: 0,
    }
  }

  // Priority 4: Blank canvas detach (normal branch) OR move (single floating root)
  if (isSingleFloatingMove) {
    if (!overCanvasObstacle) {
      return {
        intent: 'move',
        target: src!.id,
        line: null,
        parentId: null,
        index: -1,
        msg: '',
        dragDistCss,
        minTargetDistCss,
      }
    }
    return {
      intent: 'invalid',
      target: null,
      line: null,
      parentId: null,
      index: -1,
      msg: 'Không thể đặt chủ đề nổi lên đường nối hoặc nét vẽ',
      dragDistCss,
      minTargetDistCss,
    }
  }
  const canDetach = doc.layout.kind !== 'freeform'
    && !!src
    && src.parent_id !== null
    && src.role === 'normal'
    && src.id !== doc.central_topic_id
    && !overCanvasObstacle
    && dragDistCss >= DETACH_MIN_DRAG_CSS
    && minTargetDistCss >= DETACH_MIN_TARGET_CLEARANCE_CSS

  if (canDetach) {
    return {
      intent: 'detach',
      target: src!.id,
      line: null,
      parentId: null,
      index: -1,
      msg: 'Thả để tách thành chủ đề nổi',
      dragDistCss,
      minTargetDistCss,
    }
  }

  // Priority 5: remaining invalid zone
  return {
    intent: 'invalid',
    target: null,
    line: null,
    parentId: null,
    index: -1,
    msg: src?.parent_id && src.role === 'normal'
      ? 'Kéo xa hơn ra vùng trống để tách thành chủ đề nổi, hoặc thả vào node / khe giữa các node'
      : 'Chỉ thả được vào node hoặc khe giữa các node (bố cục tự động)',
    dragDistCss,
    minTargetDistCss,
  }
}
