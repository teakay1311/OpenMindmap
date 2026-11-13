import { describe, expect, test } from 'bun:test'
import { newProjectDoc, newTopic, ThemeId } from '../lib/core/types'
import { applyCommand, cmdBuilders } from '../lib/core/commands'
import { classifyAutoDragTarget } from '../lib/scene/dragTarget'
import { resolveStyle } from '../lib/core/style'
import {
  buildScene,
  fitChangedFixedNodes,
  measureNodeContent,
  pillClearanceAtCorner,
  pillPath,
  pillRadius,
  pillSafeGuard,
  sceneToSVG,
} from '../lib/scene/scene'

const canvasState = { font: '13px sans-serif', textAlign: 'start', textBaseline: 'alphabetic' }
const canvasMock = () => ({
  width: 8,
  height: 8,
  getContext: () => ({
    get font() { return canvasState.font },
    set font(v: string) { canvasState.font = v },
    get textAlign() { return canvasState.textAlign },
    set textAlign(v: string) { canvasState.textAlign = v },
    get textBaseline() { return canvasState.textBaseline },
    set textBaseline(v: string) { canvasState.textBaseline = v },
    save() {},
    restore() {},
    measureText: (s: string) => {
      const px = Number(canvasState.font.match(/([\d.]+)px/)?.[1] ?? 16)
      const w = [...s].length * (px * 0.55)
      const center = canvasState.textAlign === 'center'
      return {
        width: w,
        actualBoundingBoxAscent: px * 0.72,
        actualBoundingBoxDescent: px * 0.22,
        actualBoundingBoxLeft: center ? w / 2 : 0,
        actualBoundingBoxRight: center ? w / 2 : w,
      }
    },
  }),
})

if (typeof globalThis.document === 'undefined') {
  Object.assign(globalThis, {
    document: {
      createElement: canvasMock,
    },
  })
} else {
  Object.assign(globalThis.document, {
    createElement: canvasMock,
  })
}

const SAMPLE_SENTENCE = 'Xin chào tất cả mọi người đây là đài truyền hình việt nam'
const TINYPNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAEklEQVR4nGP4z8DwHwwZ8SkAAJ4SAx4+W6IAAAAASUVORK5CYII='

function makePillDoc(opts: {
  text?: string
  shape?: 'pill' | 'rounded' | 'rect'
  sizeMode?: 'auto' | 'fixed'
  w?: number
  h?: number
  strokeWidth?: number
  padding?: [number, number, number, number]
  hAlign?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'middle' | 'bottom'
  fontSizePt?: number
  italic?: boolean
  underline?: boolean
  wrap?: boolean
  wrapWidth?: number
  themeId?: ThemeId
} = {}) {
  const doc = newProjectDoc('Pill Test')
  if (opts.themeId) doc.theme_id = opts.themeId
  const t = newTopic({
    id: 'p1',
    parent_id: doc.central_topic_id,
    order: 0,
    text: opts.text ?? SAMPLE_SENTENCE,
    style: {
      box_style: {
        shape: opts.shape ?? 'pill',
        size_mode: opts.sizeMode ?? 'auto',
        width_world: opts.w,
        height_world: opts.h,
        stroke_width_world: opts.strokeWidth ?? 2,
      },
      text: {
        padding_world: opts.padding ?? [10, 14, 10, 14],
        horizontal_align: opts.hAlign ?? 'center',
        vertical_align: opts.vAlign ?? 'middle',
        font_size_pt: opts.fontSizePt ?? 13,
        italic: opts.italic ?? false,
        underline: opts.underline ?? false,
        wrap: opts.wrap ?? true,
        wrap_width_world: opts.wrapWidth ?? 240,
      },
    },
  })
  doc.topics.push(t)
  return { doc, topic: t }
}

function minSceneNodeTextClearance(doc: ReturnType<typeof newProjectDoc>, topicId: string): number {
  const scene = buildScene(doc)
  const n = scene.byId.get(topicId)!
  const s = n.strokeWidth
  let minClear = Infinity
  // Check corners of textBounds (which bounds full wrapped ink + textArea) relative to box
  const left = n.textArea.x - n.box.x
  const top = n.textArea.y - n.box.y
  const right = n.textArea.x + n.textArea.w - n.box.x
  const bottom = n.textArea.y + n.textArea.h - n.box.y
  for (const pt of [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ]) {
    minClear = Math.min(minClear, pillClearanceAtCorner(n.box.w, n.box.h, s, pt))
  }
  return minClear
}

describe('Group PILL geometry, padding guard & validation', () => {
  test('pillSafeGuard matches plan example W=392, H=140, stroke=2 => G=26', () => {
    const r = pillRadius(392, 140)
    expect(r).toBe(70)
    expect(pillSafeGuard(r, 2)).toBe(26)
  })

  test('PILL-01 Auto pill keeps >= 6 world-unit clearance across all alignments and asymmetric padding', () => {
    for (const hAlign of ['left', 'center', 'right'] as const) {
      for (const vAlign of ['top', 'middle', 'bottom'] as const) {
        const { doc } = makePillDoc({ hAlign, vAlign, padding: [4, 24, 6, 8] })
        const scene = buildScene(doc)
        const n = scene.byId.get('p1')!
        const minC = minSceneNodeTextClearance(doc, 'p1')
        expect(minC).toBeGreaterThanOrEqual(6)
        // Stored padding in document must remain untouched
        expect(doc.topics.find((t) => t.id === 'p1')!.style.text?.padding_world).toEqual([4, 24, 6, 8])
        expect(n.effectivePadding![0]).toBeGreaterThanOrEqual(pillSafeGuard(n.r, n.strokeWidth))
        expect(n.effectivePadding![1]).toBeGreaterThanOrEqual(24)
        expect(n.r).toBeCloseTo(pillRadius(n.box.w, n.box.h), 1)
      }
    }
  })

  test('PILL-02 Fixed narrow/tall pills, italic, underline, emoji, stroke=0 vs stroke=8 converge finitely & render matching SVG arc', () => {
    const variants = [
      { text: 'OneLine', w: 90, h: 180, strokeWidth: 0, italic: false, underline: false, wrap: true },
      { text: 'Narrow\nTall\nPill\n😀🎉🚀', w: 80, h: 240, strokeWidth: 6, italic: true, underline: true, wrap: true },
      { text: 'SuperLongUnbreakableTokenWithoutSpacesForPillSafetyCheck', w: 120, h: 60, strokeWidth: 4, wrap: true },
      { text: SAMPLE_SENTENCE + ' 😀', w: 220, h: 90, strokeWidth: 8, wrap: false },
    ]
    for (const v of variants) {
      const { doc, topic } = makePillDoc({ sizeMode: 'fixed', ...v })
      const m = measureNodeContent(doc, topic, resolveStyle(doc, topic))
      expect(Number.isFinite(m.w) && m.w > 0).toBe(true)
      expect(Number.isFinite(m.h) && m.h > 0).toBe(true)
      const c = minSceneNodeTextClearance(doc, 'p1')
      expect(c).toBeGreaterThanOrEqual(6)

      const scene = buildScene(doc)
      const n = scene.byId.get('p1')!
      const svg = sceneToSVG(scene, { background: 'white', padding: 20 })
      const expectedR = pillRadius(n.box.w, n.box.h)
      expect(pillPath(n.box)).toContain(`a ${expectedR} ${expectedR} `)
      expect(svg).toContain(`a ${expectedR} ${expectedR} `)
    }
  })

  test('PILL-03 accessories (4 image placements, Cover/Contain, icon, checkbox, date, notes, URL) respect effectivePadding', () => {
    for (const placement of ['left', 'right', 'above', 'below'] as const) {
      for (const fit of ['contain', 'cover'] as const) {
        const { doc, topic } = makePillDoc({ sizeMode: 'fixed', w: 260, h: 160, strokeWidth: 2 })
        doc.assets.push({ id: 'img-1', mime: 'image/png', data_url: TINYPNG, width: 120, height: 80, hash: 'h1' })
        topic.image = { asset_id: 'img-1', placement, fit, width_fraction: 0.35 }
        topic.icon = { icon_id: 'star', size: 'm' }
        topic.checkbox = true
        topic.date = '2026-11-12'
        topic.notes = 'Ghi chú'
        topic.url = 'https://example.com'

        const scene = buildScene(doc)
        const n = scene.byId.get('p1')!
        const ep = n.effectivePadding!
        expect(n.image).toBeTruthy()
        expect(n.image!.x).toBeGreaterThanOrEqual(n.box.x + ep[3] - 0.15)
        expect(n.image!.x + n.image!.w).toBeLessThanOrEqual(n.box.x + n.box.w - ep[1] + 0.15)
        expect(n.notePos).toBeTruthy()
        expect(n.urlPos).toBeTruthy()
        expect(n.notePos!.x + 6).toBeLessThanOrEqual(n.box.x + n.box.w - ep[1] + 0.2)
        expect(n.notePos!.y + 6).toBeLessThanOrEqual(n.box.y + n.box.h - ep[2] + 0.2)
        expect(n.urlPos!.x).toBeLessThan(n.notePos!.x - 10)
      }
    }
  })

  test('PILL-04 fitChangedFixedNodes reacts to shape=pill and stroke_width_world, updates only needed axis, and rejects >1200x800', () => {
    const { doc, topic } = makePillDoc({
      shape: 'rounded',
      sizeMode: 'fixed',
      text: 'Long text line one\nLong text line two\nLong text line three',
      w: 180,
      h: 95,
      strokeWidth: 2,
      wrapWidth: 300,
    })
    const draft = structuredClone(doc)
    applyCommand(draft, { type: 'setBoxStyle', ids: [topic.id], before: {}, after: { shape: 'pill', stroke_width_world: 8 } })
    fitChangedFixedNodes(doc, draft)
    const afterTopic = draft.topics.find((t) => t.id === topic.id)!
    // Height/width only written if grown; old theme/shape change triggered fitChangedFixedNodes!
    expect(afterTopic.style.box_style?.shape).toBe('pill')
    expect((afterTopic.style.box_style?.width_world ?? 180) > 180 || (afterTopic.style.box_style?.height_world ?? 95) > 95).toBe(true)

    // Exceeding 1200x800 must throw cleanly so store rolls back
    const bigDraft = structuredClone(doc)
    bigDraft.topics.find((t) => t.id === topic.id)!.style.box_style = {
      shape: 'pill',
      size_mode: 'fixed',
      width_world: 1200,
      height_world: 790,
      stroke_width_world: 12,
    }
    bigDraft.topics.find((t) => t.id === topic.id)!.text = Array.from({ length: 40 }, () => 'Line').join('\n')
    expect(() => fitChangedFixedNodes(doc, bigDraft)).toThrow('1200 × 800')
  })

  test('PILL-06 rounded and rect shapes keep identical non-pill effectivePadding and measurements', () => {
    const rDoc = makePillDoc({ shape: 'rounded', padding: [10, 14, 10, 14] })
    const sDoc = makePillDoc({ shape: 'rect', padding: [10, 14, 10, 14] })
    const rm = measureNodeContent(rDoc.doc, rDoc.topic, resolveStyle(rDoc.doc, rDoc.topic))
    const sm = measureNodeContent(sDoc.doc, sDoc.topic, resolveStyle(sDoc.doc, sDoc.topic))
    expect(rm.effectivePadding).toEqual([10, 14, 10, 14])
    expect(sm.effectivePadding).toEqual([10, 14, 10, 14])
    expect(rm.w).toBe(sm.w)
    expect(rm.h).toBe(sm.h)
  })
})

describe('Group DETACH classifier, Balanced mirror zones, command & Fixed atomicity', () => {
  function makeBranchDoc(kind: 'balanced' | 'logic' | 'tree' | 'organization' | 'radial' | 'fishbone' | 'timeline' | 'freeform' = 'balanced') {
    const doc = newProjectDoc('Detach Test')
    doc.layout.kind = kind
    const c = doc.central_topic_id
    const n1 = newTopic({ id: 'b1', parent_id: c, order: 0, text: 'Branch 1', notes: 'B1 note', checkbox: true })
    const n1a = newTopic({ id: 'b1a', parent_id: 'b1', order: 0, text: 'Child 1A' })
    const n2 = newTopic({ id: 'b2', parent_id: c, order: 1, text: 'Branch 2' })
    doc.topics.push(n1, n1a, n2)
    doc.crosslinks.push(
      { id: 'cl-int', source: 'b1', target: 'b1a', label: 'Inner', arrow_end: true },
      { id: 'cl-ext', source: 'b1a', target: 'b2', label: 'Outer', arrow_end: true },
    )
    return doc
  }

  test('DETACH-THRESHOLD enforces exact 119/120/121 CSS px drag and 47/48/49 CSS px clearance across 0.5x/1x/2x zooms', () => {
    const doc = makeBranchDoc('tree')
    const scene = buildScene(doc)
    const maxRight = Math.max(...scene.nodes.map((n) => n.box.x + n.box.w))
    const band = (zoom: number) => Math.max(14, 14 / zoom)

    for (const zoom of [0.5, 1, 2]) {
      const startClient = { x: 100, y: 100 }
      // Far enough in world (> band + 48/zoom away from maxRight) so target clearance >= 48
      const safeWorld = { x: maxRight + band(zoom) + 60 / zoom, y: 0 }

      const drag119 = classifyAutoDragTarget({
        doc, scene, sourceIds: ['b1'], startClient,
        pointerClient: { x: 100 + 119, y: 100 },
        pointerWorld: safeWorld, zoom, inActiveCanvas: true, balancedStartSide: null, hoveredNode: null,
      })
      const drag120 = classifyAutoDragTarget({
        doc, scene, sourceIds: ['b1'], startClient,
        pointerClient: { x: 100 + 120, y: 100 },
        pointerWorld: safeWorld, zoom, inActiveCanvas: true, balancedStartSide: null, hoveredNode: null,
      })
      const drag121 = classifyAutoDragTarget({
        doc, scene, sourceIds: ['b1'], startClient,
        pointerClient: { x: 100 + 121, y: 100 },
        pointerWorld: safeWorld, zoom, inActiveCanvas: true, balancedStartSide: null, hoveredNode: null,
      })
      expect(drag119.intent).toBe('invalid')
      expect(drag120.intent).toBe('detach')
      expect(drag121.intent).toBe('detach')

      // Measure exact 47 / 48 / 49 CSS px horizontally from the rightmost hit zone (at that zone's center Y)
      const nonSrc = scene.nodes.filter((n) => n.id !== 'b1')
      const rightNonSrc = nonSrc.reduce((best, n) => (n.box.x + n.box.w > best.box.x + best.box.w ? n : best), nonSrc[0])
      const reorderRightEdge = rightNonSrc.box.x + rightNonSrc.box.w + band(zoom)
      const b1Node = scene.byId.get('b1')!
      const b1RightEdge = b1Node.box.x + b1Node.box.w
      const outerEdge = Math.max(reorderRightEdge, b1RightEdge)
      const refY = reorderRightEdge >= b1RightEdge
        ? rightNonSrc.box.y + rightNonSrc.box.h / 2
        : b1Node.box.y + b1Node.box.h / 2

      const clr47 = classifyAutoDragTarget({
        doc, scene, sourceIds: ['b1'], startClient,
        pointerClient: { x: 250, y: 100 },
        pointerWorld: { x: outerEdge + 47 / zoom, y: refY },
        zoom, inActiveCanvas: true, balancedStartSide: null, hoveredNode: null,
      })
      const clr48 = classifyAutoDragTarget({
        doc, scene, sourceIds: ['b1'], startClient,
        pointerClient: { x: 250, y: 100 },
        pointerWorld: { x: outerEdge + 48 / zoom, y: refY },
        zoom, inActiveCanvas: true, balancedStartSide: null, hoveredNode: null,
      })
      const clr49 = classifyAutoDragTarget({
        doc, scene, sourceIds: ['b1'], startClient,
        pointerClient: { x: 250, y: 100 },
        pointerWorld: { x: outerEdge + 49 / zoom, y: refY },
        zoom, inActiveCanvas: true, balancedStartSide: null, hoveredNode: null,
      })
      expect(clr47.intent).toBe('invalid')
      expect(clr48.intent).toBe('detach')
      expect(clr49.intent).toBe('detach')
    }
  })

  test('Balanced opposite-side empty mirrors source across central, requires 48 CSS px past padded flip-zone to detach', () => {
    const doc = newProjectDoc('Bal Mirror')
    doc.topics.push(newTopic({ id: 'b1', parent_id: doc.central_topic_id, order: 0, text: 'Only Right', branch_side: 'right' }))
    const scene = buildScene(doc)
    const central = scene.byId.get(doc.central_topic_id)!
    const cx = central.box.x + central.box.w / 2
    const b1 = scene.byId.get('b1')!
    // Mirror b1 across central X -> left side box
    const mirroredLeft = 2 * cx - (b1.box.x + b1.box.w)
    const mirroredY = b1.box.y + b1.box.h / 2

    // Inside padded flip zone (within 48 CSS px of mirroredLeft) -> side
    const insideFlip = classifyAutoDragTarget({
      doc, scene, sourceIds: ['b1'], startClient: { x: 400, y: 100 }, pointerClient: { x: 100, y: 100 },
      pointerWorld: { x: mirroredLeft - 47, y: mirroredY }, zoom: 1, inActiveCanvas: true, balancedStartSide: 'right', hoveredNode: null,
    })
    expect(insideFlip.intent).toBe('side')

    // 47 CSS px OUTSIDE the padded flip zone -> invalid (clear deadband buffer!)
    const bufferZone = classifyAutoDragTarget({
      doc, scene, sourceIds: ['b1'], startClient: { x: 400, y: 100 }, pointerClient: { x: 50, y: 100 },
      pointerWorld: { x: mirroredLeft - 48 - 47, y: mirroredY }, zoom: 1, inActiveCanvas: true, balancedStartSide: 'right', hoveredNode: null,
    })
    expect(bufferZone.intent).toBe('invalid')

    // 48 CSS px OUTSIDE the padded flip zone -> detach!
    const detachPastBuffer = classifyAutoDragTarget({
      doc, scene, sourceIds: ['b1'], startClient: { x: 400, y: 100 }, pointerClient: { x: 10, y: 100 },
      pointerWorld: { x: mirroredLeft - 48 - 48, y: mirroredY }, zoom: 1, inActiveCanvas: true, balancedStartSide: 'right', hoveredNode: null,
    })
    expect(detachPastBuffer.intent).toBe('detach')
  })

  test('Priority 1 cancels outside/occluded canvas, rejects drawing/crosslink obstacle & non-normal/multi-root sources', () => {
    const doc = makeBranchDoc('logic')
    const scene = buildScene(doc)
    const farPt = { x: 2000, y: 2000 }
    // Overlay / outside canvas -> cancel
    expect(classifyAutoDragTarget({
      doc, scene, sourceIds: ['b1'], startClient: { x: 0, y: 0 }, pointerClient: { x: 300, y: 0 },
      pointerWorld: farPt, zoom: 1, inActiveCanvas: false, balancedStartSide: null, hoveredNode: null,
    }).intent).toBe('cancel')
    // Over drawing/crosslink obstacle -> invalid (not blank canvas)
    expect(classifyAutoDragTarget({
      doc, scene, sourceIds: ['b1'], startClient: { x: 0, y: 0 }, pointerClient: { x: 300, y: 0 },
      pointerWorld: farPt, zoom: 1, inActiveCanvas: true, balancedStartSide: null, hoveredNode: null, overCanvasObstacle: true,
    }).intent).toBe('invalid')
    // Multiple sibling roots -> cannot detach
    expect(classifyAutoDragTarget({
      doc, scene, sourceIds: ['b1', 'b2'], startClient: { x: 0, y: 0 }, pointerClient: { x: 300, y: 0 },
      pointerWorld: farPt, zoom: 1, inActiveCanvas: true, balancedStartSide: null, hoveredNode: null,
    }).intent).toBe('invalid')
    // Free-form never detaches by drag
    doc.layout.kind = 'freeform'
    expect(classifyAutoDragTarget({
      doc, scene, sourceIds: ['b1'], startClient: { x: 0, y: 0 }, pointerClient: { x: 300, y: 0 },
      pointerWorld: farPt, zoom: 1, inActiveCanvas: true, balancedStartSide: null, hoveredNode: null,
    }).intent).toBe('invalid')
  })

  test('detachToFloating returns direct reparent command without composite & preserves crosslinks/subtree', () => {
    const doc = makeBranchDoc('tree')
    expect(cmdBuilders.detachToFloating(doc, doc.central_topic_id)).toBeNull()
    const cmd = cmdBuilders.detachToFloating(doc, 'b1')!
    expect(cmd).not.toBeNull()
    expect(cmd.type).toBe('reparent')
    const beforeRev = doc.document_revision
    const res = applyCommand(doc, cmd)
    expect(res.ok).toBe(true)
    expect(doc.document_revision).toBe(beforeRev + 1) // single revision (no extra composite increment!)
    const detached = doc.topics.find((t) => t.id === 'b1')!
    expect(detached.parent_id).toBeNull()
    expect(detached.role).toBe('floating')
    expect(doc.topics.find((t) => t.id === 'b1a')!.parent_id).toBe('b1')
    expect(doc.crosslinks.length).toBe(2)
  })

  test('DETACH-FIXED fitChangedFixedNodes updates only needed dimension when style changes on detach & skips untouched legacy Fixed nodes', () => {
    const doc = newProjectDoc('Fixed Detach')
    doc.role_style_defaults.floating = { text: { font_size_pt: 22, wrap: false } }
    const b1 = newTopic({
      id: 'b1', parent_id: doc.central_topic_id, order: 0, text: 'MediumLabel',
      style: { box_style: { size_mode: 'fixed', width_world: 120, height_world: 80 } },
    })
    const legacyUntouched = newTopic({
      id: 'leg', parent_id: doc.central_topic_id, order: 1, text: 'Legacy Too Big For Stored Box\nLine 2\nLine 3',
      style: { box_style: { size_mode: 'fixed', width_world: 80, height_world: 40 } },
    })
    doc.topics.push(b1, legacyUntouched)

    const draft = structuredClone(doc)
    const cmd = cmdBuilders.detachToFloating(draft, 'b1')!
    applyCommand(draft, cmd)
    fitChangedFixedNodes(doc, draft)

    const detached = draft.topics.find((t) => t.id === 'b1')!
    const untouch = draft.topics.find((t) => t.id === 'leg')!
    // b1 width should have grown for larger floating font without inventing untouched legacy changes
    expect((detached.style.box_style?.width_world ?? 0) > 120).toBe(true)
    expect(untouch.style.box_style?.width_world).toBe(80)
    expect(untouch.style.box_style?.height_world).toBe(40)
  })
})
