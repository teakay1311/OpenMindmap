import { describe, expect, test } from 'bun:test'
import { computeLayout } from '../lib/layout/engine'
import { applyCommand, cmdBuilders } from '../lib/core/commands'
import { LayoutKind, newProjectDoc, newTopic, ProjectDocV3 } from '../lib/core/types'
import { buildScene } from '../lib/scene/scene'
import { classifyAutoDragTarget } from '../lib/scene/dragTarget'

if (typeof globalThis.document === 'undefined') {
  Object.assign(globalThis, {
    document: {
      createElement: () => {
        const state = { font: '13px sans-serif', textAlign: 'start', textBaseline: 'alphabetic' }
        return {
          width: 8,
          height: 8,
          getContext: () => ({
            get font() { return state.font },
            set font(v: string) { state.font = v },
            get textAlign() { return state.textAlign },
            set textAlign(v: string) { state.textAlign = v },
            get textBaseline() { return state.textBaseline },
            set textBaseline(v: string) { state.textBaseline = v },
            save() {},
            restore() {},
            measureText: (txt: string) => {
              const m = /(\d+(?:\.\d+)?)px/.exec(state.font)
              const px = m ? Number(m[1]) : 13
              return {
                width: txt.length * px * 0.56,
                actualBoundingBoxAscent: px * 0.78,
                actualBoundingBoxDescent: px * 0.22,
                fontBoundingBoxAscent: px * 0.9,
                fontBoundingBoxDescent: px * 0.25,
              }
            },
          }),
        }
      },
    },
  })
}

function makeRichDoc(kind: LayoutKind = 'balanced'): ProjectDocV3 {
  const doc = newProjectDoc('Central')
  doc.layout.kind = kind
  const cen = doc.central_topic_id
  doc.topics.push(
    newTopic({ id: 'm1', role: 'normal', parent_id: cen, order: 0, text: 'Main 1' }),
    newTopic({ id: 'm1a', role: 'normal', parent_id: 'm1', order: 0, text: 'Main 1a' }),
    newTopic({ id: 'm2', role: 'normal', parent_id: cen, order: 1, text: 'Main 2' }),
    newTopic({ id: 'f1', role: 'floating', parent_id: null, order: 1, text: 'Float Anchored 1', manual_position: { x: 420, y: -180 } }),
    newTopic({ id: 'f1a', role: 'normal', parent_id: 'f1', order: 0, text: 'Float Child 1a', manual_position: { x: 99, y: 88 } }),
    newTopic({ id: 'f1a1', role: 'normal', parent_id: 'f1a', order: 0, text: 'Float Grand 1a1' }),
    newTopic({ id: 'f2', role: 'floating', parent_id: null, order: 2, text: 'Float Default 2', manual_position: null }),
    newTopic({ id: 'f2a', role: 'normal', parent_id: 'f2', order: 0, text: 'Float Child 2a' }),
    newTopic({ id: 'f3', role: 'floating', parent_id: null, order: 3, text: 'Float ZeroNeg 3', manual_position: { x: 0, y: -240 } }),
  )
  return doc
}

const fixedSize = () => ({ w: 120, h: 40 })
const AUTO_LAYOUTS: LayoutKind[] = ['balanced', 'logic', 'tree', 'organization', 'radial', 'fishbone', 'timeline']

describe('Group A: Auto layout floating island manual_position placement', () => {
  test('translates anchored floating subtree by exact delta across all 7 Auto layouts without mutating doc', () => {
    for (const kind of AUTO_LAYOUTS) {
      const doc = makeRichDoc(kind)
      const baseline = structuredClone(doc)
      baseline.topics.find((t) => t.id === 'f1')!.manual_position = null

      const beforeRaw = JSON.stringify(doc)
      const baseRes = computeLayout(baseline, fixedSize, baseline.layout)
      const res = computeLayout(doc, fixedSize, doc.layout)

      // No doc mutation during layout
      expect(JSON.stringify(doc)).toBe(beforeRaw)

      // Anchored root f1 placed at exact manual_position (top-left)
      const f1Box = res.pos.get('f1')!
      expect(f1Box.x).toBe(420)
      expect(f1Box.y).toBe(-180)

      // Whole subtree f1a, f1a1 shifts by exact same (dx, dy) as f1
      const baseF1 = baseRes.pos.get('f1')!
      const dx = 420 - baseF1.x
      const dy = -180 - baseF1.y
      for (const id of ['f1a', 'f1a1']) {
        const b0 = baseRes.pos.get(id)!
        const b1 = res.pos.get(id)!
        expect(b1.x).toBeCloseTo(b0.x + dx, 6)
        expect(b1.y).toBeCloseTo(b0.y + dy, 6)
        expect(b1.w).toBe(b0.w)
        expect(b1.h).toBe(b0.h)
      }

      // Main tree & unanchored root after anchored root keep exact default row boxes
      for (const id of [doc.central_topic_id, 'm1', 'm1a', 'm2', 'f2', 'f2a']) {
        expect(res.pos.get(id)).toEqual(baseRes.pos.get(id))
      }

      // Zero and negative manual_position (0, -240) work validly
      const f3Box = res.pos.get('f3')!
      expect(f3Box.x).toBe(0)
      expect(f3Box.y).toBe(-240)

      // Bounds include translated boxes
      expect(res.bounds.x).toBeLessThanOrEqual(0)
      expect(res.bounds.y).toBeLessThanOrEqual(-240)
      expect(res.bounds.x + res.bounds.w).toBeGreaterThanOrEqual(f1Box.x + f1Box.w)
    }
  })

  test('moving anchored root only keeps unanchored row and main tree identical; re-expanding collapsed kids keeps delta', () => {
    const docA = makeRichDoc('balanced')
    const docB = structuredClone(docA)
    docB.topics.find((t) => t.id === 'f1')!.manual_position = { x: -550, y: 310 }

    const resA = computeLayout(docA, fixedSize, docA.layout)
    const resB = computeLayout(docB, fixedSize, docB.layout)

    for (const id of [docA.central_topic_id, 'm1', 'm1a', 'm2', 'f2', 'f2a', 'f3']) {
      expect(resB.pos.get(id)).toEqual(resA.pos.get(id))
    }

    // Collapsed root ignores hidden kids; expanding restores relative subtree at anchored pos
    docB.topics.find((t) => t.id === 'f1')!.collapsed = true
    const collapsed = computeLayout(docB, fixedSize, docB.layout)
    expect(collapsed.pos.get('f1')!.x).toBe(-550)
    expect(collapsed.pos.get('f1')!.y).toBe(310)
    expect(collapsed.pos.has('f1a')).toBe(false)

    docB.topics.find((t) => t.id === 'f1')!.collapsed = false
    const reopened = computeLayout(docB, fixedSize, docB.layout)
    expect(reopened.pos.get('f1a')).toEqual(resB.pos.get('f1a'))
    expect(reopened.pos.get('f1a1')).toEqual(resB.pos.get('f1a1'))
  })

  test('SceneGraph & crosslink endpoints move with translated floating cluster while waypoints stay world-space; Free-form untouched', () => {
    const doc = makeRichDoc('balanced')
    doc.crosslinks.push({
      id: 'cl-int',
      source: 'f1',
      target: 'f1a1',
      waypoints: [{ x: 480, y: -120 }],
      arrow_end: true,
    }, {
      id: 'cl-ext',
      source: 'm1',
      target: 'f1',
      waypoints: [{ x: 250, y: -60 }],
      arrow_end: true,
    })
    const s1 = buildScene(doc, { includeDrawings: true })
    const doc2 = structuredClone(doc)
    doc2.topics.find((t) => t.id === 'f1')!.manual_position = { x: 640, y: -320 }
    const s2 = buildScene(doc2, { includeDrawings: true })

    expect(s2.byId.get('f1')!.box.x).toBe(640)
    expect(s2.byId.get('f1')!.box.y).toBe(-320)
    // Crosslink endpoints updated, waypoints untouched in doc
    const clExt1 = s1.crosslinks.find((c) => c.id === 'cl-ext')!
    const clExt2 = s2.crosslinks.find((c) => c.id === 'cl-ext')!
    expect(clExt2.p2.x).toBeGreaterThan(clExt1.p2.x)
    expect(doc2.crosslinks[1].waypoints).toEqual([{ x: 250, y: -60 }])

    // Switch to freeform: f1 stays at its manual_position and descendant f1a uses its own manual_position (99, 88)
    doc2.layout.kind = 'freeform'
    const ff = computeLayout(doc2, fixedSize, doc2.layout)
    expect(ff.pos.get('f1')!.x).toBe(640)
    expect(ff.pos.get('f1')!.y).toBe(-320)
    expect(ff.pos.get('f1a')!.x).toBe(99)
    expect(ff.pos.get('f1a')!.y).toBe(88)
  })
})

describe('Group B: atomic detachToFloating with optional floatingPosition', () => {
  test('sets role=floating, parent_id=null, normalized order, and manual_position in single reparent revision; rejects invalid args cleanly', () => {
    const doc = makeRichDoc('balanced')
    const beforeSnapshot = JSON.stringify(doc)

    // Invalid coordinates rejected at builder & apply levels without mutating doc
    expect(cmdBuilders.detachToFloating(doc, 'm1', { x: Number.NaN, y: 10 })).toBeNull()
    expect(cmdBuilders.detachToFloating(doc, 'm1', { x: 10, y: Number.POSITIVE_INFINITY })).toBeNull()
    expect(cmdBuilders.detachToFloating(doc, 'f1', { x: 10, y: 20 })).toBeNull()
    expect(cmdBuilders.detachToFloating(doc, doc.central_topic_id, { x: 0, y: 0 })).toBeNull()

    const badApplyDoc = structuredClone(doc)
    const badRes1 = applyCommand(badApplyDoc, {
      type: 'reparent',
      items: [{ id: 'f1', oldParentId: null, oldOrder: 1, newParentId: null, newOrder: 1, floatingPosition: { x: 10, y: 20 } }],
    })
    expect(badRes1.ok).toBe(false)
    expect(JSON.stringify(badApplyDoc)).toBe(beforeSnapshot)

    const badRes2 = applyCommand(badApplyDoc, {
      type: 'reparent',
      items: [
        { id: 'm1', oldParentId: doc.central_topic_id, oldOrder: 0, newParentId: null, newOrder: 4, floatingPosition: { x: 0, y: -50 } },
        { id: 'm2', oldParentId: doc.central_topic_id, oldOrder: 1, newParentId: null, newOrder: 5 },
      ],
    })
    expect(badRes2.ok).toBe(false)
    expect(JSON.stringify(badApplyDoc)).toBe(beforeSnapshot)

    // Menu detach (no coordinate) keeps manual_position untouched (null)
    const menuDoc = structuredClone(doc)
    const menuCmd = cmdBuilders.detachToFloating(menuDoc, 'm1')!
    expect(menuCmd.type).toBe('reparent')
    const menuRes = applyCommand(menuDoc, menuCmd)
    expect(menuRes.ok).toBe(true)
    expect(menuDoc.topics.find((t) => t.id === 'm1')!.manual_position).toBeNull()
    expect(menuDoc.document_revision).toBe(doc.document_revision + 1)

    // Drag detach with { x: 0, y: -320 } sets role, parent_id, normalized orders, and exact manual_position in 1 revision
    const dragDoc = structuredClone(doc)
    const dragCmd = cmdBuilders.detachToFloating(dragDoc, 'm1', { x: 0, y: -320 })!
    expect(dragCmd.type).toBe('reparent')
    const dragRes = applyCommand(dragDoc, dragCmd)
    expect(dragRes.ok).toBe(true)
    expect(dragDoc.document_revision).toBe(doc.document_revision + 1)
    const m1 = dragDoc.topics.find((t) => t.id === 'm1')!
    expect(m1.role).toBe('floating')
    expect(m1.parent_id).toBeNull()
    expect(m1.manual_position).toEqual({ x: 0, y: -320 })
    // Remaining child m2 re-normalized under central
    expect(dragDoc.topics.find((t) => t.id === 'm2')!.order).toBe(0)
    // Linked metadata preserved
    expect(dragDoc.topics.find((t) => t.id === 'm1a')!.parent_id).toBe('m1')
  })
})

describe('Group C: classifyAutoDragTarget for floating root move & attach', () => {
  test('short drag inside own floating root box counts as move even overlapping another node; touching descendant is invalid', () => {
    const doc = makeRichDoc('balanced')
    // Overlap f1 deliberately on top of m2 in scene
    const scene0 = buildScene(doc, { includeDrawings: true })
    const m2Box = scene0.byId.get('m2')!.box
    doc.topics.find((t) => t.id === 'f1')!.manual_position = { x: m2Box.x, y: m2Box.y }
    const scene = buildScene(doc, { includeDrawings: true })
    const f1Node = scene.byId.get('f1')!
    const f1aNode = scene.byId.get('f1a')!
    const m1Node = scene.byId.get('m1')!
    const m2Node = scene.byId.get('m2')!

    // 1. Short drag (<120px, >5px) inside f1's own box while m2 sits behind/under f1 -> intent is 'move' (NOT reparent onto m2!)
    const ownHit = classifyAutoDragTarget({
      doc,
      scene,
      sourceIds: ['f1'],
      startClient: { x: 100, y: 100 },
      pointerClient: { x: 112, y: 106 },
      pointerWorld: { x: f1Node.box.x + 12, y: f1Node.box.y + 8 },
      zoom: 1,
      inActiveCanvas: true,
      balancedStartSide: null,
      hoveredNode: m2Node, // even if painter picked overlapping m2
      overCanvasObstacle: true, // even near crosslink border
    })
    expect(ownHit.intent).toBe('move')
    expect(ownHit.target).toBe('f1')

    // 2. Direct hit on descendant f1a -> invalid cycle block
    const descHit = classifyAutoDragTarget({
      doc,
      scene,
      sourceIds: ['f1'],
      startClient: { x: 100, y: 100 },
      pointerClient: { x: 300, y: 100 },
      pointerWorld: { x: f1aNode.box.x + 10, y: f1aNode.box.y + 10 },
      zoom: 1,
      inActiveCanvas: true,
      balancedStartSide: null,
      hoveredNode: f1aNode,
      overCanvasObstacle: false,
    })
    expect(descHit.intent).toBe('invalid')

    // 3. Pointer inside f1's own children's reorder band (between f1a and blank near f1a) MUST NOT pick f1 as parentId
    const descBand = classifyAutoDragTarget({
      doc,
      scene,
      sourceIds: ['f1'],
      startClient: { x: 100, y: 100 },
      pointerClient: { x: 300, y: 100 },
      pointerWorld: { x: f1aNode.box.x + 4, y: f1aNode.box.y - 6 },
      zoom: 1,
      inActiveCanvas: true,
      balancedStartSide: null,
      hoveredNode: null,
      overCanvasObstacle: false,
    })
    expect(descBand.intent).toBe('move')
    expect(descBand.parentId).toBeNull()

    // 4. Drag onto non-descendant m1 -> reparent
    const attachHit = classifyAutoDragTarget({
      doc,
      scene,
      sourceIds: ['f1'],
      startClient: { x: 100, y: 100 },
      pointerClient: { x: 400, y: 100 },
      pointerWorld: { x: m1Node.box.x + 10, y: m1Node.box.y + 10 },
      zoom: 1,
      inActiveCanvas: true,
      balancedStartSide: null,
      hoveredNode: m1Node,
      overCanvasObstacle: false,
    })
    expect(attachHit.intent).toBe('reparent')
    expect(attachHit.target).toBe('m1')

    // 5. Drag to blank canvas only 15px from m1 (<48px!) and only 20px total (<120px!) -> still 'move' for floating root
    const nearBlankMove = classifyAutoDragTarget({
      doc,
      scene,
      sourceIds: ['f1'],
      startClient: { x: 100, y: 100 },
      pointerClient: { x: 118, y: 108 },
      pointerWorld: { x: m1Node.box.x - 15, y: m1Node.box.y - 25 },
      zoom: 1,
      inActiveCanvas: true,
      balancedStartSide: null,
      hoveredNode: null,
      overCanvasObstacle: false,
    })
    expect(nearBlankMove.intent).toBe('move')
    expect(nearBlankMove.dragDistCss).toBeLessThan(120)

    // 6. Blank canvas with drawing/crosslink obstacle -> invalid (not blank canvas)
    const obstacleHit = classifyAutoDragTarget({
      doc,
      scene,
      sourceIds: ['f1'],
      startClient: { x: 100, y: 100 },
      pointerClient: { x: 300, y: 300 },
      pointerWorld: { x: 900, y: 900 },
      zoom: 1,
      inActiveCanvas: true,
      balancedStartSide: null,
      hoveredNode: null,
      overCanvasObstacle: true,
    })
    expect(obstacleHit.intent).toBe('invalid')

    // 7. Multi floating roots keep existing invalid-on-blank rule
    const multiFloat = classifyAutoDragTarget({
      doc,
      scene,
      sourceIds: ['f1', 'f2'],
      startClient: { x: 100, y: 100 },
      pointerClient: { x: 400, y: 400 },
      pointerWorld: { x: 900, y: 900 },
      zoom: 1,
      inActiveCanvas: true,
      balancedStartSide: null,
      hoveredNode: null,
      overCanvasObstacle: false,
    })
    expect(multiFloat.intent).toBe('invalid')

    // 8. Normal branch still requires 120/48 and CANNOT self-reorder into its own child band
    const cleanDoc = makeRichDoc('balanced')
    const cleanScene = buildScene(cleanDoc, { includeDrawings: true })
    const normChildBand = classifyAutoDragTarget({
      doc: cleanDoc,
      scene: cleanScene,
      sourceIds: ['m1'],
      startClient: { x: 100, y: 100 },
      pointerClient: { x: 250, y: 100 },
      pointerWorld: { x: cleanScene.byId.get('m1a')!.box.x + 5, y: cleanScene.byId.get('m1a')!.box.y - 6 },
      zoom: 1,
      inActiveCanvas: true,
      balancedStartSide: null,
      hoveredNode: null,
      overCanvasObstacle: false,
    })
    expect(normChildBand.intent).not.toBe('reorder')
    expect(normChildBand.intent).toBe('invalid')
  })
})

describe('Layout polish: Fishbone spine/ribs & Tree shared busY', () => {
  test('Tree elbow shares exact single horizontal busY across all siblings of a parent', () => {
    const doc = newProjectDoc('Tree Root')
    doc.layout.kind = 'tree'
    doc.layout.routing = 'elbow'
    const cen = doc.central_topic_id
    for (let i = 0; i < 7; i++) {
      doc.topics.push(newTopic({ id: `c${i}`, parent_id: cen, order: i, text: `Branch ${i}` }))
    }
    const scene = buildScene(doc)
    const busYs = new Set<number>()
    for (let i = 0; i < 7; i++) {
      const e = scene.edges.find((x) => x.to === `c${i}`)!
      // Format: M px py L px my L cx my L cx cy
      const nums = e.d.match(/-?\d+(\.\d+)?/g)!.map(Number)
      expect(nums.length).toBe(8)
      busYs.add(nums[3]) // my
      expect(nums[3]).toBe(nums[5])
      // All start from exact center bottom of parent
      const cenBox = scene.byId.get(cen)!.box
      expect(nums[0]).toBeCloseTo(cenBox.x + cenBox.w / 2, 1)
    }
    expect(busYs.size).toBe(1)
  })

  test('Fishbone generates main spine into Central, diagonal category ribs onto spine, horizontal k2 branches onto rib, and zero overlaps', () => {
    const doc = newProjectDoc('Fishbone Head')
    doc.layout.kind = 'fishbone'
    const cen = doc.central_topic_id
    doc.topics.push(
      newTopic({ id: 'cat1', parent_id: cen, order: 0, text: 'Cat 1' }),
      newTopic({ id: 'c1a', parent_id: 'cat1', order: 0, text: 'Cause 1a' }),
      newTopic({ id: 'c1a1', parent_id: 'c1a', order: 0, text: 'Sub 1a1' }),
      newTopic({ id: 'c1b', parent_id: 'cat1', order: 1, text: 'Cause 1b' }),
      newTopic({ id: 'cat2', parent_id: cen, order: 1, text: 'Cat 2' }),
      newTopic({ id: 'c2a', parent_id: 'cat2', order: 0, text: 'Cause 2a' }),
    )
    const scene = buildScene(doc)
    const spine = scene.edges.find((e) => e.id === 'fishbone-spine')
    expect(spine).toBeDefined()
    const cenBox = scene.byId.get(cen)!.box
    expect(spine!.d.endsWith(`L ${cenBox.x} 0`)).toBe(true)

    // Cat 1 rib meets spine at y=0
    const eCat1 = scene.edges.find((e) => e.to === 'cat1')!
    const cat1Nums = eCat1.d.match(/-?\d+(\.\d+)?/g)!.map(Number)
    expect(cat1Nums[1]).toBe(0) // starts on spine y=0
    expect(cat1Nums[2]).toBeCloseTo(scene.byId.get('cat1')!.box.x + scene.byId.get('cat1')!.box.w / 2, 1)

    // k2 Cause 1a connects horizontally (y1 === y2) onto Cat 1's slanted rib
    const eC1a = scene.edges.find((e) => e.to === 'c1a')!
    const c1aNums = eC1a.d.match(/-?\d+(\.\d+)?/g)!.map(Number)
    expect(c1aNums[1]).toBe(c1aNums[3])
    expect(c1aNums[0]).toBeGreaterThan(c1aNums[2]) // tail-left box connects rightward onto slanted rib

    // Zero overlaps between any pair of nodes
    for (let i = 0; i < scene.nodes.length; i++) {
      for (let j = i + 1; j < scene.nodes.length; j++) {
        const a = scene.nodes[i].box, b = scene.nodes[j].box
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
        expect(ox * oy).toBe(0)
      }
    }
  })
})
