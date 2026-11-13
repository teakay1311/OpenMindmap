/* ============================================================
 * OpenMindmap — lib/layout/engine.ts
 * 8 thuật toán bố cục L01–L08 + floating islands (SRS 11.5)
 * Thuần tính toán: nhận sizeOf, không mutate Document.
 * Cùng input (doc snapshot + metrics + options) → cùng output.
 * ============================================================ */
import { ProjectDocV3, Topic, LayoutSettings } from '../core/types'
import { childrenOf, getTopic, rootsOf, descendantsOf, buildIndex, idxChildren, idxDescendants, TreeIndex } from '../core/tree'

export interface Box { x: number; y: number; w: number; h: number } // x,y = top-left world
export interface LayoutResult {
  pos: Map<string, Box>
  bounds: Box
  visibleIds: Set<string>
  hiddenCount: Map<string, number> // id của node collapsed → số descendants bị ẩn
}

export type SizeOf = (t: Topic) => { w: number; h: number }

interface RT { // cây runtime
  t: Topic
  box: Box
  kids: RT[]
  subH: number // chiều cao subtree (horizontal layouts)
  subW: number // chiều rộng subtree (vertical layouts)
}

function buildRT(doc: ProjectDocV3, root: Topic, sizeOf: SizeOf, visibleIds: Set<string>, hiddenCount: Map<string, number>, idx: TreeIndex, gapNode: number): RT {
  const s = sizeOf(root)
  const node: RT = { t: root, box: { x: 0, y: 0, w: s.w, h: s.h }, kids: [], subH: s.h, subW: s.w }
  visibleIds.add(root.id)
  const kids = idxChildren(idx, root.id)
  for (const k of kids) {
    if (root.collapsed) {
      const n = idxDescendants(idx, k.id).length + 1
      hiddenCount.set(root.id, (hiddenCount.get(root.id) ?? 0) + n)
      continue
    }
    const child = buildRT(doc, k, sizeOf, visibleIds, hiddenCount, idx, gapNode)
    node.kids.push(child)
  }
  // chiều cao/rộng subtree = max(node, tổng con + gapNode)
  if (node.kids.length) {
    const sum = node.kids.reduce((a, c) => a + c.subH, 0) + (node.kids.length - 1) * gapNode
    node.subH = Math.max(node.box.h, sum)
    const sumW = node.kids.reduce((a, c) => a + c.subW, 0) + (node.kids.length - 1) * gapNode
    node.subW = Math.max(node.box.w, sumW)
  }
  return node
}

function leafCount(n: RT): number {
  if (!n.kids.length) return 1
  return n.kids.reduce((a, c) => a + leafCount(c), 0)
}

/* ---------- Cây ngang (Balanced/Logic): đẻ con sang trái/phải ---------- */
function layoutH(n: RT, dir: 1 | -1, xCenter: number, yTop: number, gapNode: number, gapLevel: number): void {
  n.box.x = xCenter - n.box.w / 2
  n.box.y = yTop
  if (!n.kids.length) return
  const totalH = n.kids.reduce((a, c) => a + c.subH, 0) + (n.kids.length - 1) * gapNode
  let cursor = yTop + (n.box.h - totalH) / 2 // căn giữa theo parent
  for (const c of n.kids) {
    const childTop = cursor + (c.subH - c.box.h) / 2
    const childCenterX = xCenter + dir * (n.box.w / 2 + gapLevel + c.box.w / 2)
    layoutH(c, dir, childCenterX, childTop, gapNode, gapLevel)
    cursor += c.subH + gapNode
  }
}

/* ---------- Cây dọc (Tree/Organization/Timeline lane) ---------- */
function layoutV(n: RT, dirY: 1 | -1, xLeft: number, yCenter: number, gapNode: number, gapLevel: number): void {
  n.box.x = xLeft
  n.box.y = yCenter - n.box.h / 2
  if (!n.kids.length) return
  const totalW = n.kids.reduce((a, c) => a + c.subW, 0) + (n.kids.length - 1) * gapNode
  let cursor = xLeft + (n.box.w - totalW) / 2
  for (const c of n.kids) {
    const childLeft = cursor + (c.subW - c.box.w) / 2
    const childCenterY = yCenter + dirY * (n.box.h / 2 + gapLevel + c.box.h / 2)
    layoutV(c, dirY, childLeft, childCenterY, gapNode, gapLevel)
    cursor += c.subW + gapNode
  }
}

/* ---------- Radial ---------- */
function radialHalfExtent(w: number, h: number, angle: number): number {
  const ca = Math.abs(Math.cos(angle))
  const sa = Math.abs(Math.sin(angle))
  const tx = ca > 1e-4 ? (w / 2) / ca : Infinity
  const ty = sa > 1e-4 ? (h / 2) / sa : Infinity
  return Math.min(tx, ty)
}

function layoutRadial(n: RT, angle: number, radius: number, span: number, gapNode: number, gapLevel: number, depth: number): void {
  const kidNeedArc = n.kids.reduce((sum, c) => sum + Math.hypot(c.box.w, c.box.h) * 0.7 + gapNode, 0)
  const needRadius = span > 0.0001 ? kidNeedArc / span : radius
  const r = Math.max(radius, isFinite(needRadius) ? needRadius : radius)
  n.box.x = Math.cos(angle) * r - n.box.w / 2
  n.box.y = Math.sin(angle) * r - n.box.h / 2
  if (!n.kids.length) return
  const total = leafCount(n)
  let a0 = angle - span / 2
  const parentHalf = radialHalfExtent(n.box.w, n.box.h, angle)
  for (const c of n.kids) {
    const cSpan = (leafCount(c) / total) * span
    const cAngle = a0 + cSpan / 2
    const childHalf = radialHalfExtent(c.box.w, c.box.h, cAngle)
    const nextR = r + parentHalf + gapLevel + childHalf
    layoutRadial(c, cAngle, nextR, Math.max(cSpan * 0.96, 0.05), gapNode, gapLevel, depth + 1)
    a0 += cSpan
  }
}

function boxesOverlapPad(a: Box, b: Box, pad: number): boolean {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > -pad
    && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > -pad
}

function shiftRadialSubtree(node: RT, dr: number): void {
  const cx = node.box.x + node.box.w / 2
  const cy = node.box.y + node.box.h / 2
  const r = Math.hypot(cx, cy)
  const ux = r > 1e-4 ? cx / r : 1
  const uy = r > 1e-4 ? cy / r : 0
  const shift = (n: RT) => {
    n.box.x += ux * dr
    n.box.y += uy * dr
    n.kids.forEach(shift)
  }
  shift(node)
}

function resolveRadialOverlaps(centralRT: RT, gapNode: number): void {
  const minGap = Math.min(6, Math.max(2, gapNode * 0.15))
  const entries: { rt: RT; depth: number; branchIdx: number }[] = [{ rt: centralRT, depth: 0, branchIdx: -1 }]
  centralRT.kids.forEach((b, bi) => {
    const walk = (n: RT, d: number) => {
      entries.push({ rt: n, depth: d, branchIdx: bi })
      n.kids.forEach((k) => walk(k, d + 1))
    }
    walk(b, 1)
  })
  for (let iter = 0; iter < 64; iter++) {
    let pushed = false
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const A = entries[i], B = entries[j]
        if (!boxesOverlapPad(A.rt.box, B.rt.box, minGap)) continue
        const target = A.depth === 0 ? B.rt
          : B.depth === 0 ? A.rt
          : B.depth >= A.depth ? B.rt : A.rt
        const overlapX = Math.min(A.rt.box.x + A.rt.box.w, B.rt.box.x + B.rt.box.w) - Math.max(A.rt.box.x, B.rt.box.x) + minGap
        const overlapY = Math.min(A.rt.box.y + A.rt.box.h, B.rt.box.y + B.rt.box.h) - Math.max(A.rt.box.y, B.rt.box.y) + minGap
        const step = Math.max(12, Math.min(overlapX, overlapY) + 4)
        shiftRadialSubtree(target, step)
        pushed = true
        break
      }
      if (pushed) break
    }
    if (!pushed) break
  }
}

export const FISHBONE_RIB_SLOPE = 0.58 // dx per |dy| along diagonal category bone (~60 deg)

/* ============================================================
 * computeLayout — điểm vào chính
 * ============================================================ */
export function computeLayout(doc: ProjectDocV3, sizeOf: SizeOf, layout: LayoutSettings, idxPrebuilt?: TreeIndex): LayoutResult {
  const idx = idxPrebuilt ?? buildIndex(doc) // lookup O(1) cho toàn bộ lượt layout
  const visibleIds = new Set<string>()
  const hiddenCount = new Map<string, number>()
  const pos = new Map<string, Box>()
  const roots = rootsOf(doc)
  const central = roots[0]
  const floating = roots.slice(1)
  const gapNode = layout.node_gap ?? 24
  const gapBranch = layout.branch_gap ?? 40
  const gapLevel = layout.level_gap ?? 90

  const centralRT = buildRT(doc, central, sizeOf, visibleIds, hiddenCount, idx, gapNode)

  const placeIslands = (islands: RT[], mainBounds: Box, xCursorStart: number, placedBoxes: Box[]) => {
    let x = xCursorStart
    const baseY = mainBounds.y + mainBounds.h + (layout.root_island_gap ?? 160) * 0.4
    for (const isl of islands) {
      if (layout.kind === 'freeform') {
        const mp = isl.t.manual_position
        if (mp) {
          isl.box.x = mp.x
          isl.box.y = mp.y
        } else {
          isl.box.x = x
          isl.box.y = baseY
          while (placedBoxes.some((b) => boxesOverlapPad(isl.box, b, gapNode))) {
            isl.box.y += Math.max(isl.subH, isl.box.h) + gapNode
          }
        }
        walkFreeformRT(isl, gapNode, gapLevel, pos, placedBoxes)
        x = Math.max(x + isl.box.w, subtreeMaxX(isl)) + (layout.root_island_gap ?? 160) * 0.6
        continue
      }
      isl.box.x = x
      isl.box.y = baseY
      pos.set(isl.t.id, { ...isl.box })
      if (layout.kind === 'tree' || layout.kind === 'organization' || layout.kind === 'timeline') {
        layoutV(isl, 1, x, baseY + isl.box.h / 2, gapNode, Math.min(gapLevel, 60))
      } else {
        layoutBalancedRoot(isl, x + isl.box.w / 2, baseY, gapNode, Math.min(gapLevel, 60), pos)
      }
      x += islandWidth(isl) + (layout.root_island_gap ?? 160) * 0.6
    }
    return x
  }

  const allRT: RT[] = [centralRT]
  const islandRTs: RT[] = []
  for (const f of floating) {
    islandRTs.push(buildRT(doc, f, sizeOf, visibleIds, hiddenCount, idx, gapNode))
  }
  const freeformPlaced: Box[] = []

  let mainBounds: Box = { x: 0, y: 0, w: 0, h: 0 }

  switch (layout.kind) {
    case 'balanced': {
      // Chia trái/phải theo Hướng (both/left/right) và subtree height (11.5 L01)
      const sides: { right: RT[]; left: RT[] } = { right: [], left: [] }
      if (layout.direction === 'left') {
        sides.left.push(...centralRT.kids)
      } else if (layout.direction === 'right') {
        sides.right.push(...centralRT.kids)
      } else {
        let hR = 0, hL = 0
        for (const c of centralRT.kids) {
          if (c.t.branch_side === 'right' || (c.t.branch_side === 'auto' && hR <= hL)) { sides.right.push(c); hR += c.subH + gapNode }
          else { sides.left.push(c); hL += c.subH + gapNode }
        }
      }
      const cx = 0, cy = 0
      centralRT.box.x = cx - centralRT.box.w / 2
      centralRT.box.y = cy - centralRT.box.h / 2
      const stackRight = sides.right.reduce((a, c) => a + c.subH, 0) + Math.max(0, sides.right.length - 1) * gapNode
      let cursor = cy - stackRight / 2
      for (const c of sides.right) {
        layoutH(c, 1, cx + centralRT.box.w / 2 + gapLevel + c.box.w / 2, cursor + (c.subH - c.box.h) / 2, gapNode, gapLevel)
        cursor += c.subH + gapNode
      }
      const stackLeft = sides.left.reduce((a, c) => a + c.subH, 0) + Math.max(0, sides.left.length - 1) * gapNode
      cursor = cy - stackLeft / 2
      for (const c of sides.left) {
        layoutH(c, -1, cx - centralRT.box.w / 2 - gapLevel - c.box.w / 2, cursor + (c.subH - c.box.h) / 2, gapNode, gapLevel)
        cursor += c.subH + gapNode
      }
      break
    }
    case 'logic': {
      const dir: 1 | -1 = layout.direction === 'left' ? -1 : 1
      centralRT.box.x = -centralRT.box.w / 2
      centralRT.box.y = -centralRT.box.h / 2
      const stack = centralRT.kids.reduce((a, c) => a + c.subH, 0) + Math.max(0, centralRT.kids.length - 1) * gapNode
      let cursor = -stack / 2
      for (const c of centralRT.kids) {
        layoutH(c, dir, dir * (centralRT.box.w / 2 + gapLevel + c.box.w / 2), cursor + (c.subH - c.box.h) / 2, gapNode, gapLevel)
        cursor += c.subH + gapNode
      }
      break
    }
    case 'tree': {
      const dirY: 1 | -1 = layout.direction === 'bottom' ? -1 : 1
      centralRT.box.x = -centralRT.box.w / 2
      centralRT.box.y = -centralRT.box.h / 2
      layoutV(centralRT, dirY, -centralRT.box.w / 2, 0, gapNode, gapLevel)
      break
    }
    case 'organization': {
      const dirY: 1 | -1 = layout.direction === 'bottom' ? -1 : 1
      centralRT.box.x = -centralRT.box.w / 2
      centralRT.box.y = -centralRT.box.h / 2
      layoutV(centralRT, dirY, -centralRT.box.w / 2, 0, gapNode, gapLevel)
      alignOrganizationLevels(centralRT, dirY, gapLevel)
      break
    }
    case 'radial': {
      centralRT.box.x = -centralRT.box.w / 2
      centralRT.box.y = -centralRT.box.h / 2
      const start = (layout.start_angle_deg ?? -90) * (Math.PI / 180)
      const cw = layout.direction !== 'ccw'
      const total = leafCount(centralRT) || 1
      let a = start
      const r0 = Math.hypot(centralRT.box.w, centralRT.box.h) / 2 + gapLevel
      for (const c of centralRT.kids) {
        const span = (leafCount(c) / total) * Math.PI * 2
        const mid = a + (cw ? span : -span) / 2
        const childHalf = radialHalfExtent(c.box.w, c.box.h, mid)
        layoutRadial(c, mid, r0 + childHalf, Math.abs(span) * 0.92, gapNode, gapLevel * 0.9, 1)
        a += cw ? span : -span
      }
      resolveRadialOverlaps(centralRT, gapNode)
      break
    }
    case 'fishbone': {
      // Ishikawa Fishbone: trục xương sống ngang y=0; Central là đầu cá ('right' mặc định hoặc 'left').
      const headDir: 1 | -1 = layout.direction === 'left' ? -1 : 1
      const cats = centralRT.kids
      const k3GapX = Math.max(18, gapLevel * 0.35)
      const stubGap = Math.max(24, gapLevel * 0.3)
      const spineMinY = Math.max(36, gapNode * 1.4)
      let topFarEdge = 0 // furthest horizontal extent toward headDir * -1 or tail/head bounds
      let botFarEdge = 0
      let prevSpineX = 0
      let hasTop = false
      let hasBot = false

      cats.forEach((c, i) => {
        const side: 1 | -1 = i % 2 === 0 ? -1 : 1
        let yCursor = spineMinY

        // 1. Place k2 causes along the diagonal rib (around local spineX = 0):
        // ribX(y) = -headDir * FISHBONE_RIB_SLOPE * |y|
        for (const k2 of c.kids) {
          const bandH = k2.subH
          const k2CenterY = side * (yCursor + bandH / 2)
          const ribXAtK2 = -headDir * FISHBONE_RIB_SLOPE * Math.abs(k2CenterY)
          const k2InnerX = ribXAtK2 - headDir * stubGap
          k2.box.x = headDir === 1 ? k2InnerX - k2.box.w : k2InnerX
          k2.box.y = k2CenterY - k2.box.h / 2

          // Place k3+ grandchildren further toward tail without cutting siblings' vertical band
          const kidsTotalH = k2.kids.reduce((sum, ch) => sum + ch.subH, 0) + Math.max(0, k2.kids.length - 1) * gapNode
          let subY = k2CenterY - kidsTotalH / 2
          for (const k3 of k2.kids) {
            const k3Anchor = headDir === 1 ? k2.box.x - k3GapX : k2.box.x + k2.box.w + k3GapX
            layoutHPlain(k3, k3Anchor, subY + (k3.subH - k3.box.h) / 2, gapNode, k3GapX, pos, headDir === 1 ? -1 : 1)
            subY += k3.subH + gapNode
          }
          yCursor += bandH + gapNode
        }

        // 2. Place Category box at the outer end of the diagonal rib
        const cEdgeY = side * (c.kids.length ? yCursor + gapNode * 0.4 : spineMinY)
        const cTipX = -headDir * FISHBONE_RIB_SLOPE * Math.abs(cEdgeY)
        c.box.x = cTipX - c.box.w / 2
        c.box.y = side === -1 ? cEdgeY - c.box.h : cEdgeY

        // 3. Measure actual horizontal footprint of category subtree + spine attachment (x=0)
        let localMinX = 0, localMaxX = 0
        const measureX = (rt: RT) => {
          localMinX = Math.min(localMinX, rt.box.x)
          localMaxX = Math.max(localMaxX, rt.box.x + rt.box.w)
          rt.kids.forEach(measureX)
        }
        measureX(c)

        const minSpineStep = Math.max(56, gapLevel * 0.55)
        let spineX = 0
        if (headDir === 1) {
          const prevSideMax = side === -1 ? (hasTop ? topFarEdge : -Infinity) : (hasBot ? botFarEdge : -Infinity)
          const minNeeded = prevSideMax === -Infinity ? -localMinX + 20 : prevSideMax + gapBranch - localMinX
          spineX = Math.max(i === 0 ? -localMinX + 20 : prevSpineX + minSpineStep, minNeeded)
        } else {
          const prevSideMin = side === -1 ? (hasTop ? topFarEdge : Infinity) : (hasBot ? botFarEdge : Infinity)
          const maxAllowed = prevSideMin === Infinity ? -localMaxX - 20 : prevSideMin - gapBranch - localMaxX
          spineX = Math.min(i === 0 ? -localMaxX - 20 : prevSpineX - minSpineStep, maxAllowed)
        }

        const shiftX = (rt: RT) => {
          rt.box.x += spineX
          pos.set(rt.t.id, { ...rt.box })
          rt.kids.forEach(shiftX)
        }
        shiftX(c)

        if (headDir === 1) {
          if (side === -1) { topFarEdge = spineX + localMaxX; hasTop = true }
          else { botFarEdge = spineX + localMaxX; hasBot = true }
        } else {
          if (side === -1) { topFarEdge = spineX + localMinX; hasTop = true }
          else { botFarEdge = spineX + localMinX; hasBot = true }
        }
        prevSpineX = spineX
      })

      if (headDir === 1) {
        const rightEnd = Math.max(hasTop ? topFarEdge : 0, hasBot ? botFarEdge : 0, cats.length ? prevSpineX : 0)
        centralRT.box.x = rightEnd + Math.max(60, gapLevel * 0.75)
      } else {
        const leftEnd = Math.min(hasTop ? topFarEdge : 0, hasBot ? botFarEdge : 0, cats.length ? prevSpineX : 0)
        centralRT.box.x = leftEnd - Math.max(60, gapLevel * 0.75) - centralRT.box.w
      }
      centralRT.box.y = -centralRT.box.h / 2
      break
    }
    case 'timeline': {
      const byDate = layout.chronological || layout.sort_policy === 'by_date'
      const mstones = [...centralRT.kids]
      if (byDate) {
        mstones.sort((a, b) => {
          const da = a.t.date ?? null, dbb = b.t.date ?? null
          if (da && dbb) return da < dbb ? -1 : da > dbb ? 1 : 0
          if (da) return -1
          if (dbb) return 1
          return a.t.order - b.t.order // thiếu date xuống cuối theo order
        })
      }
      centralRT.box.x = 0
      centralRT.box.y = -centralRT.box.h / 2
      let cursorX = centralRT.box.w + gapLevel
      mstones.forEach((m) => {
        // xen kẽ trên/dưới trục: chia con theo parity giữ order (11.5 L07)
        const above: RT[] = [], below: RT[] = []
        m.kids.forEach((k, j) => (j % 2 === 0 ? below : above).push(k))
        m.box.x = cursorX
        m.box.y = -m.box.h / 2
        pos.set(m.t.id, { ...m.box })
        const placeCol = (list: RT[], dirY: 1 | -1) => {
          let x = cursorX
          let maxRight = cursorX
          for (const c of list) {
            layoutV(c, dirY, x + (c.subW - c.box.w) / 2, dirY * (m.box.h / 2 + gapLevel * 0.6 + c.box.h / 2), gapNode, gapLevel * 0.6)
            maxRight = Math.max(maxRight, x + c.subW)
            x += c.subW + gapNode
          }
          return maxRight
        }
        const rightMost = Math.max(m.box.x + m.box.w, placeCol(below, 1), placeCol(above, -1))
        cursorX = rightMost + gapNode * 2
      })
      break
    }
    case 'freeform': {
      centralRT.box.x = centralRT.t.manual_position?.x ?? 0
      centralRT.box.y = centralRT.t.manual_position?.y ?? 0
      seedFreeformPlaced(centralRT, freeformPlaced)
      for (const isl of islandRTs) {
        if (isl.t.manual_position) {
          isl.box.x = isl.t.manual_position.x
          isl.box.y = isl.t.manual_position.y
        }
        seedFreeformPlaced(isl, freeformPlaced)
      }
      walkFreeformRT(centralRT, gapNode, gapLevel, pos, freeformPlaced)
      break
    }
  }

  // Thu thập vị trí cây chính
  const collect = (n: RT) => {
    pos.set(n.t.id, { ...n.box })
    n.kids.forEach(collect)
  }
  if (layout.kind !== 'fishbone' && layout.kind !== 'timeline') collect(centralRT)
  else {
    collect(centralRT)
    // fishbone/timeline: những node đã set thủ công ở trên, con sâu hơn của timeline:
    mstonesCollect(centralRT, pos)
  }

  // Bounds cây chính
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  pos.forEach((b) => {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
  })
  if (!pos.size) { minX = 0; minY = 0; maxX = 200; maxY = 100 }
  mainBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }

  // Floating islands hàng dưới
  if (islandRTs.length) {
    placeIslands(islandRTs, mainBounds, mainBounds.x, freeformPlaced)
    islandRTs.forEach((isl) => {
      pos.set(isl.t.id, { ...isl.box })
      islandCollect(isl, pos)
    })
    if (layout.kind !== 'freeform') {
      for (const isl of islandRTs) {
        if (isl.t.role === 'floating' && isl.t.parent_id === null && isValidManualPosition(isl.t.manual_position)) {
          const mp = isl.t.manual_position
          const dx = mp.x - isl.box.x
          const dy = mp.y - isl.box.y
          if (dx || dy) translateIsland(isl, dx, dy, pos, mp)
        }
      }
    }
    // recompute bounds
    pos.forEach((b) => {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
    })
  }

  return {
    pos,
    bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    visibleIds,
    hiddenCount,
  }
}

function mstonesCollect(n: RT, pos: Map<string, Box>) {
  n.kids.forEach((c) => {
    if (!pos.has(c.t.id)) pos.set(c.t.id, { ...c.box })
    c.kids.forEach((k) => {
      if (!pos.has(k.t.id)) { pos.set(k.t.id, { ...k.box }); layoutVCollect(k, pos) }
      else collectDeep(k, pos)
    })
  })
}
function layoutVCollect(n: RT, pos: Map<string, Box>) {
  pos.set(n.t.id, { ...n.box })
  n.kids.forEach((k) => layoutVCollect(k, pos))
}
function collectDeep(n: RT, pos: Map<string, Box>) {
  if (!pos.has(n.t.id)) pos.set(n.t.id, { ...n.box })
  n.kids.forEach((k) => collectDeep(k, pos))
}

function layoutHPlain(n: RT, xAnchor: number, yTop: number, gapNode: number, gapLevel: number, pos: Map<string, Box>, dir: 1 | -1 = 1) {
  n.box.x = dir === 1 ? xAnchor : xAnchor - n.box.w
  n.box.y = yTop
  pos.set(n.t.id, { ...n.box })
  const totalH = n.kids.reduce((a, c) => a + c.subH, 0) + Math.max(0, n.kids.length - 1) * gapNode
  let cursor = yTop + (n.box.h - totalH) / 2
  for (const c of n.kids) {
    const childTop = cursor + (c.subH - c.box.h) / 2
    const childAnchor = dir === 1 ? n.box.x + n.box.w + gapLevel : n.box.x - gapLevel
    layoutHPlain(c, childAnchor, childTop, gapNode, gapLevel, pos, dir)
    cursor += c.subH + gapNode
  }
}

/** layout island kiểu balanced quanh gốc island */
function layoutBalancedRoot(isl: RT, xCenter: number, yTop: number, gapNode: number, gapLevel: number, pos: Map<string, Box>) {
  isl.box.x = xCenter - isl.box.w / 2
  isl.box.y = yTop
  pos.set(isl.t.id, { ...isl.box })
  const sides: { right: RT[]; left: RT[] } = { right: [], left: [] }
  let hR = 0, hL = 0
  for (const c of isl.kids) {
    if (hR <= hL) { sides.right.push(c); hR += c.subH + gapNode } else { sides.left.push(c); hL += c.subH + gapNode }
  }
  const place = (list: RT[], dir: 1 | -1) => {
    const stack = list.reduce((a, c) => a + c.subH, 0) + Math.max(0, list.length - 1) * gapNode
    let cursor = yTop + (isl.box.h - stack) / 2
    for (const c of list) {
      layoutH(c, dir, xCenter + dir * (isl.box.w / 2 + gapLevel + c.box.w / 2), cursor + (c.subH - c.box.h) / 2, gapNode, gapLevel)
      cursor += c.subH + gapNode
    }
  }
  place(sides.right, 1)
  place(sides.left, -1)
}
function isValidManualPosition(mp: Topic['manual_position']): mp is { x: number; y: number } {
  return Boolean(mp && typeof mp.x === 'number' && Number.isFinite(mp.x) && typeof mp.y === 'number' && Number.isFinite(mp.y))
}
function translateIsland(n: RT, dx: number, dy: number, pos: Map<string, Box>, rootTarget?: { x: number; y: number }): void {
  n.box.x = rootTarget ? rootTarget.x : n.box.x + dx
  n.box.y = rootTarget ? rootTarget.y : n.box.y + dy
  const cur = pos.get(n.t.id)
  if (cur) pos.set(n.t.id, { x: rootTarget ? rootTarget.x : cur.x + dx, y: rootTarget ? rootTarget.y : cur.y + dy, w: cur.w, h: cur.h })
  n.kids.forEach((k) => translateIsland(k, dx, dy, pos))
}
function islandCollect(isl: RT, pos: Map<string, Box>) {
  isl.kids.forEach((c) => {
    if (!pos.has(c.t.id)) collectDeep(c, pos)
  })
}
function islandWidth(n: RT): number {
  let minX = Infinity, maxX = -Infinity
  const walk = (node: RT) => {
    minX = Math.min(minX, node.box.x); maxX = Math.max(maxX, node.box.x + node.box.w)
    node.kids.forEach(walk)
  }
  walk(n)
  return isFinite(minX) ? maxX - minX : n.box.w
}

function alignOrganizationLevels(centralRT: RT, dirY: 1 | -1, gapLevel: number): void {
  const levels = new Map<number, RT[]>()
  const walk = (n: RT, depth: number) => {
    const arr = levels.get(depth)
    if (arr) arr.push(n)
    else levels.set(depth, [n])
    n.kids.forEach((k) => walk(k, depth + 1))
  }
  walk(centralRT, 0)
  const maxDepth = Math.max(...levels.keys())
  let edgeY = dirY === 1 ? centralRT.box.y + centralRT.box.h : centralRT.box.y
  for (let d = 1; d <= maxDepth; d++) {
    const row = levels.get(d)
    if (!row?.length) continue
    const startY = edgeY + dirY * gapLevel
    let maxH = 0
    for (const n of row) {
      n.box.y = dirY === 1 ? startY : startY - n.box.h
      maxH = Math.max(maxH, n.box.h)
    }
    edgeY = startY + dirY * maxH
  }
}

function seedFreeformPlaced(root: RT, placed: Box[]): void {
  const walk = (n: RT) => {
    if (n.t.manual_position) {
      placed.push({ x: n.t.manual_position.x, y: n.t.manual_position.y, w: n.box.w, h: n.box.h })
    }
    n.kids.forEach(walk)
  }
  if (!root.t.manual_position && root.t.role === 'central') {
    placed.push({ ...root.box })
  }
  walk(root)
}

function subtreeMaxX(n: RT): number {
  let m = n.box.x + n.box.w
  for (const c of n.kids) m = Math.max(m, subtreeMaxX(c))
  return m
}

function walkFreeformRT(n: RT, gapNode: number, gapLevel: number, pos: Map<string, Box>, placed: Box[]): void {
  pos.set(n.t.id, { ...n.box })
  const missingKids = n.kids.filter((k) => !k.t.manual_position)
  const totalMissingH = missingKids.reduce((sum, k) => sum + k.subH, 0) + Math.max(0, missingKids.length - 1) * gapNode
  let cursorY = n.box.y + n.box.h / 2 - totalMissingH / 2
  const fallbackX = n.box.x + n.box.w + Math.max(gapLevel, 90)
  for (const k of n.kids) {
    const mp = k.t.manual_position
    if (mp) {
      k.box.x = mp.x
      k.box.y = mp.y
    } else {
      k.box.x = fallbackX
      k.box.y = cursorY + (k.subH - k.box.h) / 2
      let guard = 0
      while (guard++ < 128 && placed.some((b) => boxesOverlapPad(k.box, b, Math.min(gapNode, 12)))) {
        const hit = placed.find((b) => boxesOverlapPad(k.box, b, Math.min(gapNode, 12)))!
        k.box.y = hit.y + hit.h + gapNode
      }
      placed.push({ ...k.box })
      cursorY = Math.max(cursorY + k.subH + gapNode, k.box.y + (k.subH + k.box.h) / 2 + gapNode)
    }
    walkFreeformRT(k, gapNode, gapLevel, pos, placed)
  }
}
