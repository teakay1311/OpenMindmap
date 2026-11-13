import { describe, test, expect, beforeEach } from 'bun:test'
import { useApp as app } from '../lib/store'
import { newProjectDoc, newTopic, parseProjectJSON } from '../lib/core/types'
import { defaultSettings, STORAGE_KEYS as K, simpleHash, pushTrash } from '../lib/storage/projects'
import { buildImportPreview, parseOPML } from '../lib/io/importers'
import { inspectNativeImportId } from '../lib/storage/persistence'
import { cmdBuilders } from '../lib/core/commands'
import { resolveStyle } from '../lib/core/style'
import { sha256Hex } from '../lib/io/images'
import { NODE_ICONS } from '../lib/scene/icons'
import { computeLayout } from '../lib/layout/engine'
import { buildScene, makeSizeOf, sceneToSVG, shapeBorderAnchor } from '../lib/scene/scene'
import { exportOPML, estimatePNG, pngDimensionsFromWorld, planPdfMultipage } from '../lib/io/exporters'
import { layoutTextBlock } from '../lib/scene/text'

const memory = new Map<string, string>()
let failKey = ''
let lockTail = Promise.resolve()
const events = new EventTarget()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === failKey) throw new Error('TEST_QUOTA')
      memory.set(key, String(value))
    },
    removeItem: (key: string) => memory.delete(key),
    key: (i: number) => [...memory.keys()][i],
    get length() { return memory.size },
  },
})
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    locks: {
      request: (_name: string, options: { signal: AbortSignal }, callback: () => unknown) => {
        const task = lockTail.then(() => {
          if (options.signal.aborted) throw new Error('aborted')
          return callback()
        })
        lockTail = task.then(() => {}, () => {})
        return task
      },
    },
  },
})
Object.assign(globalThis, {
  window: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), matchMedia: () => ({ matches: false }) },
  document: {
    documentElement: { classList: { toggle() {} }, style: {} },
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
    createElement: () => ({
      width: 8,
      height: 8,
      getContext: () => ({
        font: '',
        textAlign: '',
        textBaseline: '',
        save() {},
        restore() {},
        measureText: (s: string) => ({
          width: [...s].length * 7.5,
          actualBoundingBoxAscent: 9,
          actualBoundingBoxDescent: 3,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: [...s].length * 7.5,
        }),
      }),
    }),
  },
  DOMParser: class {
    parseFromString(xml: string) {
      const strip = xml.replace(/<!--[\s\S]*?-->/g, '')
      const stack: { children: any[] }[] = [{ children: [] }]
      const tagRe = /<\/?outline\b([^>]*)>/gi
      let m: RegExpExecArray | null
      while ((m = tagRe.exec(strip)) !== null) {
        const raw = m[0]
        if (raw.startsWith('</')) {
          if (stack.length > 1) stack.pop()
          continue
        }
        const attrs = m[1]
        const tm = attrs.match(/text="([^"]*)"/)
        const node = {
          tagName: 'outline',
          getAttribute: (k: string) => (k === 'text' ? (tm ? tm[1] : null) : null),
          children: [] as any[],
        }
        stack[stack.length - 1].children.push(node)
        if (!attrs.trimEnd().endsWith('/')) stack.push(node)
      }
      return {
        querySelector: (sel: string) => sel === 'parsererror' ? null : (sel === 'opml > body' || sel === 'body') ? { children: stack[0].children } : null,
      }
    }
  },
})

function overlapBoxes(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return ox > 0.5 && oy > 0.5 ? ox * oy : 0
}

async function seed() {
  const old = app.getState()
  if (old._autosaveTimer) clearTimeout(old._autosaveTimer)
  if (old._journalTimer) clearTimeout(old._journalTimer)
  old._unwatch?.()
  failKey = ''
  memory.clear()
  memory.set(K.settings, JSON.stringify({ ...defaultSettings(), autosaveEnabled: false }))
  const doc = newProjectDoc('Fixture A')
  doc.topics.push(
    newTopic({ id: 'child1', parent_id: doc.central_topic_id, order: 0, text: 'Nhánh 1' }),
    newTopic({ id: 'child2', parent_id: doc.central_topic_id, order: 1, text: 'Nhánh 2' }),
  )
  const raw = JSON.stringify(doc)
  memory.set(K.project(doc.project_id), raw)
  memory.set(K.registry, JSON.stringify([{
    id: doc.project_id,
    name: doc.name,
    lastOpened: doc.updated_at,
    createdAt: doc.updated_at,
    nodeCount: doc.topics.length,
    revision: doc.document_revision,
  }]))
  app.setState({
    doc,
    generation: old.generation + 1,
    persistedRaw: raw,
    savedHash: simpleHash(raw),
    saveStatus: 'clean',
    saveError: null,
    settings: { ...defaultSettings(), autosaveEnabled: false },
    registry: JSON.parse(memory.get(K.registry)!),
    past: [],
    future: [],
    editor: null,
    selection: [],
    transitionBusy: false,
    leavePrompt: null,
    confirm: null,
    toasts: [],
    _autosaveTimer: null,
    _journalTimer: null,
  })
  return doc
}

beforeEach(seed)

describe('AG Batch A: data, import, commands, style & UTF-8 history', () => {
  test('AG-01 native open blocks collision across active, inactive, trash, equal-rev diff, and isolates retry by taskId', async () => {
    const active = app.getState().doc!
    const differentSameId = structuredClone(active)
    differentSameId.topics[1].text = 'Mutated'
    expect(await app.getState().openNativeDoc(differentSameId, { taskId: 't1' })).toBe(false)
    expect(app.getState().doc!.topics[1].text).toBe('Nhánh 1')

    // Equivalent content (even with different updated_at when ignored) succeeds without overwriting raw/revision
    const equivalent = structuredClone(active)
    equivalent.updated_at = '2099-01-01T00:00:00.000Z'
    expect(await app.getState().openNativeDoc(equivalent, { taskId: 't2', ignoreUpdatedAt: true })).toBe(true)
    expect(app.getState().doc!.document_revision).toBe(active.document_revision)

    // Trash collision is blocked
    const trashed = newProjectDoc('InTrash')
    trashed.topics.push(newTopic({ id: 'tr-c', parent_id: trashed.central_topic_id, text: 'Trash Child' }))
    pushTrash(trashed)
    const trashInspect = inspectNativeImportId(trashed)
    expect(trashInspect.kind).toBe('collision')
    expect(trashInspect.kind === 'collision' ? trashInspect.message : '').toMatch(/Thùng rác/i)
    expect(await app.getState().openNativeDoc(trashed, { taskId: 't3' })).toBe(false)

    // Retry bound strictly to taskId + exact candidate bytes: changing taskId fails as collision
    const incoming = newProjectDoc('FreshNative')
    failKey = K.registry
    expect(await app.getState().openNativeDoc(incoming, { taskId: 'retry-A' })).toBe(false)
    failKey = ''
    expect(await app.getState().openNativeDoc(incoming, { taskId: 'other-task' })).toBe(false)
    expect(await app.getState().openNativeDoc(incoming, { taskId: 'retry-A' })).toBe(true)
    expect(app.getState().doc!.project_id).toBe(incoming.project_id)
  })

  test('AG-02 / AG-08 / AG-09 / AG-10 / AG-12 / AG-14 command guards & integrity', () => {
    const doc = app.getState().doc!
    // AG-02: duplicateSelection ignores Central even via direct call or selection containing Central
    app.getState().setSelection([doc.central_topic_id])
    const revBefore = app.getState().doc!.document_revision
    app.getState().duplicateSelection()
    expect(app.getState().doc!.topics).toHaveLength(3)
    expect(app.getState().doc!.document_revision).toBe(revBefore)
    expect(app.getState().dispatch({ type: 'duplicateSubtree', id: doc.central_topic_id }, 'Dup Central')).toBe(false)
    expect(cmdBuilders.duplicateNodeOnly(doc, doc.central_topic_id)).toBeNull()

    // AG-10: addSibling before Central & reorderUpDown excluding Central
    expect(cmdBuilders.addSibling(doc, doc.central_topic_id, true)).toBeNull()
    expect(cmdBuilders.reorderUpDown(doc, doc.central_topic_id, -1)).toBeNull()

    // AG-09: addTopic into collapsed parent automatically uncollapses parent
    app.getState().dispatch({ type: 'setProps', id: 'child1', before: { collapsed: false }, after: { collapsed: true } }, 'Collapse')
    app.getState().dispatch({ type: 'addTopic', topic: newTopic({ id: 'grand1', parent_id: 'child1', text: 'Cháu' }), parentId: 'child1', index: null, focusEditor: false }, 'Add child')
    expect(app.getState().doc!.topics.find((t) => t.id === 'child1')!.collapsed).toBe(false)

    // AG-08 & AG-14: Freeform duplicateSubtree remaps internal crosslink & shifts manual_position +40,+40
    app.getState().dispatch({
      type: 'addCrosslink',
      crosslink: { id: 'cl1', source: 'child1', target: 'grand1', arrow_end: true, waypoints: [{ x: 100, y: 120 }] },
    }, 'Add internal link')
    app.getState().dispatch({ type: 'setLayout', before: doc.layout, after: { ...doc.layout, kind: 'freeform' } }, 'Freeform')
    const dupOnly = cmdBuilders.duplicateNodeOnly(app.getState().doc!, 'child1', { x: 200, y: 300 })!
    app.getState().dispatch(dupOnly, 'Dup node only')
    const onlyTopic = app.getState().doc!.topics.find((t) => t.id !== 'child1' && t.id !== 'child2' && t.id !== 'grand1' && t.id !== doc.central_topic_id)!
    expect(onlyTopic.manual_position).toEqual({ x: 240, y: 340 })

    const beforeIds = new Set(app.getState().doc!.topics.map((t) => t.id))
    app.getState().dispatch({
      type: 'duplicateSubtree',
      id: 'child1',
      resolvedPositions: { child1: { x: 200, y: 300 }, grand1: { x: 350, y: 300 } },
    }, 'Dup subtree')
    const latest = app.getState().doc!
    const clonedRoot = latest.topics.find((t) => !beforeIds.has(t.id) && t.text === 'Nhánh 1')!
    expect(clonedRoot.manual_position).toEqual({ x: 240, y: 340 })
    const clonedLink = latest.crosslinks.find((c) => c.id !== 'cl1')!
    expect(clonedLink.source).toBe(clonedRoot.id)
    expect(clonedLink.waypoints).toEqual([{ x: 140, y: 160 }])
  })

  test('AG-03 / AG-15 / AG-16 / AG-17 / AG-18 / AG-23 per-topic padding, UTF-8 byte cost, SHA-256 & nested branch inheritance', async () => {
    const doc = app.getState().doc!
    // AG-03: single command perTopic padding_world preserves 3 resolved sides on mixed selection
    app.getState().dispatch({
      type: 'setTextStyle',
      ids: ['child1'],
      before: {},
      after: { padding_world: [8, 14, 10, 14] },
    }, 'Pad 1')
    app.getState().dispatch({
      type: 'setTextStyle',
      ids: ['child2'],
      before: {},
      after: { padding_world: [12, 20, 14, 8] },
    }, 'Pad 2')
    const revBeforePad = app.getState().doc!.document_revision
    app.getState().dispatch({
      type: 'setTextStyle',
      ids: ['child1', 'child2'],
      before: {},
      after: {},
      perTopic: {
        child1: { padding_world: [16, 14, 10, 14] },
        child2: { padding_world: [16, 20, 14, 8] },
      },
    }, 'Edit padding top')
    expect(app.getState().doc!.document_revision).toBe(revBeforePad + 1)
    expect(app.getState().doc!.topics.find((t) => t.id === 'child1')!.style.text!.padding_world).toEqual([16, 14, 10, 14])
    expect(app.getState().doc!.topics.find((t) => t.id === 'child2')!.style.text!.padding_world).toEqual([16, 20, 14, 8])
    app.getState().undo()
    expect(app.getState().doc!.topics.find((t) => t.id === 'child1')!.style.text!.padding_world).toEqual([8, 14, 10, 14])

    // AG-16: UTF-8 byte cost vs UTF-16 code units across ASCII, Vietnamese, Emoji
    const enc = new TextEncoder()
    const ascii = 'HelloWorld'.repeat(100)
    const viet = 'Tiếng Việt có dấu'.repeat(60)
    const emoji = '🧠💡🚀'.repeat(80)
    expect(enc.encode(ascii).byteLength).toBe(ascii.length)
    expect(enc.encode(viet).byteLength).toBeGreaterThan(viet.length)
    expect(enc.encode(emoji).byteLength).toBeGreaterThan(emoji.length)
    app.getState().dispatch({ type: 'setText', id: 'child1', before: 'Nhánh 1', after: emoji }, 'Emoji text')
    const lastHistory = app.getState().past[app.getState().past.length - 1]
    expect(lastHistory.bytes).toBe(enc.encode(lastHistory.before).byteLength + enc.encode(lastHistory.after).byteLength)

    // AG-17: real SHA-256
    const sampleBytes = new TextEncoder().encode('OpenMindmap-PNG-bytes').buffer
    const digest = await sha256Hex(sampleBytes)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)

    // AG-18: 31 unique icons with non-empty names
    expect(NODE_ICONS).toHaveLength(31)
    expect(new Set(NODE_ICONS.map((i) => i.id)).size).toBe(31)

    // AG-23: inner branch_style_override beats outer ancestor branch_style_override
    const nested = newProjectDoc('Nested')
    const b1 = newTopic({ id: 'b1', parent_id: nested.central_topic_id, text: 'B1', branch_style_override: { edge_color: '#DC2626', text_color: '#DC2626' } })
    const b2 = newTopic({ id: 'b2', parent_id: 'b1', text: 'B2', branch_style_override: { edge_color: '#16A34A', text_color: '#16A34A' } })
    const leaf = newTopic({ id: 'leaf', parent_id: 'b2', text: 'Leaf' })
    nested.topics.push(b1, b2, leaf)
    const resolvedLeaf = resolveStyle(nested, leaf)
    expect(resolvedLeaf.edge.color).toBe('#16A34A')
    expect(resolvedLeaf.text.color).toBe('#16A34A')
  })

  test('AG-04 / AG-05 / AG-06 importer strict validation (OPML DTD anywhere, JSON types & references)', () => {
    // AG-04: DTD past 2,000 chars rejected, comment with DOCTYPE allowed
    const padComment = '<!-- ' + 'x'.repeat(2500) + ' -->'
    expect(() => parseOPML(`<?xml version="1.0"?>${padComment}<!DOCTYPE opml><opml version="2.0"><body><outline text="A"/></body></opml>`)).toThrow(/DTD|ENTITY/i)
    const commentWithDtdExample = `<?xml version="1.0"?><!-- <!DOCTYPE example> --><opml version="2.0"><body><outline text="OK"><outline text="Child"/></outline></body></opml>`
    expect(parseOPML(commentWithDtdExample).roots[0].text).toBe('OK')

    // AG-05: non-string text rejected
    const base = newProjectDoc('BadType')
    const badText: any = structuredClone(base)
    badText.topics[0].text = 12345
    expect(() => parseProjectJSON(JSON.stringify(badText))).toThrow()

    // AG-06: broken parent, cycle, missing crosslink endpoint rejected without repair
    const missingParent: any = structuredClone(base)
    missingParent.topics.push(newTopic({ id: 'orphan', parent_id: 'nope', text: 'Orphan' }))
    expect(() => buildImportPreview('x.mindmap.json', JSON.stringify(missingParent))).toThrow()

    const badLink: any = structuredClone(base)
    badLink.topics.push(newTopic({ id: 'c1', parent_id: badLink.central_topic_id, text: 'C1' }))
    badLink.crosslinks.push({ id: 'l1', source: 'c1', target: 'missing-node' })
    expect(() => buildImportPreview('x.mindmap.json', JSON.stringify(badLink))).toThrow()
  })
})

describe('AG Batch C & D: layout, scene geometry & exports', () => {
  test('AG-24 / AG-25 / AG-26 / AG-37 / AG-38 no overlaps, balanced direction, gaps, org busY, timeline spacing', () => {
    const doc = newProjectDoc('Geom')
    for (let i = 0; i < 6; i++) {
      const p = newTopic({ id: `p${i}`, parent_id: doc.central_topic_id, order: i, text: `Nhánh dài cấp một số ${i} với tiêu đề rộng` })
      doc.topics.push(p)
      for (let j = 0; j < 2; j++) {
        doc.topics.push(newTopic({ id: `c${i}_${j}`, parent_id: p.id, order: j, text: `Con ${i}.${j}` }))
      }
    }
    const sizeOf = makeSizeOf(doc)

    // Tree, Organization, Fishbone, Radial: zero overlaps across all pairs
    for (const kind of ['tree', 'organization', 'fishbone', 'radial', 'logic', 'balanced'] as const) {
      const res = computeLayout(doc, sizeOf, { ...doc.layout, kind })
      const boxes = [...res.pos.entries()]
      let totalOverlap = 0
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          totalOverlap += overlapBoxes(boxes[i][1], boxes[j][1])
        }
      }
      expect(totalOverlap).toBe(0)
    }

    // AG-25: balanced honors left vs right direction
    const balLeft = computeLayout(doc, sizeOf, { ...doc.layout, kind: 'balanced', direction: 'left' })
    const cLeft = balLeft.pos.get(doc.central_topic_id)!
    expect(balLeft.pos.get('p0')!.x + balLeft.pos.get('p0')!.w).toBeLessThan(cLeft.x)

    const balRight = computeLayout(doc, sizeOf, { ...doc.layout, kind: 'balanced', direction: 'right' })
    const cRight = balRight.pos.get(doc.central_topic_id)!
    expect(balRight.pos.get('p0')!.x).toBeGreaterThan(cRight.x + cRight.w)

    // AG-26: node_gap & level_gap move layout spacing strictly by delta
    const org1 = computeLayout(doc, sizeOf, { kind: 'organization', direction: 'both', node_gap: 20, level_gap: 40, branch_gap: 20, timeline_sort: 'manual' })
    const org2 = computeLayout(doc, sizeOf, { kind: 'organization', direction: 'both', node_gap: 60, level_gap: 90, branch_gap: 20, timeline_sort: 'manual' })
    const gap1 = org1.pos.get('c0_1')!.x - (org1.pos.get('c0_0')!.x + org1.pos.get('c0_0')!.w)
    const gap2 = org2.pos.get('c0_1')!.x - (org2.pos.get('c0_0')!.x + org2.pos.get('c0_0')!.w)
    expect(gap2 - gap1).toBeGreaterThanOrEqual(35)
    const lvl1 = org1.pos.get('c0_0')!.y - (org1.pos.get('p0')!.y + org1.pos.get('p0')!.h)
    const lvl2 = org2.pos.get('c0_0')!.y - (org2.pos.get('p0')!.y + org2.pos.get('p0')!.h)
    expect(lvl2 - lvl1).toBeCloseTo(50, 1)

    // AG-38: organization + elbow shares exact horizontal busY across siblings + center anchors
    const orgDoc = structuredClone(doc)
    orgDoc.layout.kind = 'organization'
    orgDoc.layout.routing = 'elbow'
    const orgScene = buildScene(orgDoc)
    const e0 = orgScene.edges.find((e) => e.to === 'p0')!
    const e1 = orgScene.edges.find((e) => e.to === 'p1')!
    const busY0 = Number(e0.d.split(' ')[5])
    const busY1 = Number(e1.d.split(' ')[5])
    expect(busY0).toBe(busY1)

    // AG-37: timeline equal spacing without quadratic accumulation
    const tlDoc = newProjectDoc('Timeline')
    for (let i = 0; i < 4; i++) tlDoc.topics.push(newTopic({ id: `m${i}`, parent_id: tlDoc.central_topic_id, order: i, text: `Mốc ${i}` }))
    const tlRes = computeLayout(tlDoc, makeSizeOf(tlDoc), { ...tlDoc.layout, kind: 'timeline', branch_gap: 36 })
    const d01 = tlRes.pos.get('m1')!.x - (tlRes.pos.get('m0')!.x + tlRes.pos.get('m0')!.w)
    const d12 = tlRes.pos.get('m2')!.x - (tlRes.pos.get('m1')!.x + tlRes.pos.get('m1')!.w)
    const d23 = tlRes.pos.get('m3')!.x - (tlRes.pos.get('m2')!.x + tlRes.pos.get('m2')!.w)
    expect(Math.abs(d01 - d12)).toBeLessThan(1)
    expect(Math.abs(d12 - d23)).toBeLessThan(1)
  })

  test('AG-27 / AG-35 / AG-36 / AG-39 / AG-42 / AG-43 / AG-44 / AG-49 / AG-50 / AG-52 scene & export fidelity', () => {
    const doc = newProjectDoc('SceneGeom')
    doc.theme_id = 'dark-map'
    doc.layout.kind = 'freeform'
    doc.layout.routing = 'elbow'
    doc.topics.push(
      newTopic({ id: 'n1', parent_id: doc.central_topic_id, manual_position: { x: 250, y: 120 }, text: 'Node có badges', notes: 'Ghi chú mẫu', url: 'https://example.com', checkbox: false }),
      newTopic({ id: 'n2', parent_id: doc.central_topic_id, manual_position: { x: 520, y: 260 }, text: 'Node Đích', checkbox: true }),
      newTopic({ id: 'mid', parent_id: doc.central_topic_id, manual_position: { x: 380, y: 190 }, text: 'Phần 29' }),
    )
    doc.crosslinks.push({ id: 'c1', source: 'n1', target: 'n2', label: 'Liên kết rất dài kiểm tránh Phần 29', arrow_end: true })
    doc.drawings.push(
      { id: 'd_front', kind: 'rect', points: [{ x: 0, y: 0 }, { x: 50, y: 50 }], color: '#000', fill: '#FEF08A', width_world: 2, opacity: 1, layer_order: 2 },
      { id: 'd_back', kind: 'rect', points: [{ x: 0, y: 0 }, { x: 50, y: 50 }], color: '#000', fill: '#E2E8F0', width_world: 2, opacity: 1, layer_order: -1 },
    )
    const scene = buildScene(doc)

    // AG-27: sorted ascending by layer_order (-1 before 2)
    expect(scene.drawings.map((d) => d.obj.id)).toEqual(['d_back', 'd_front'])

    // AG-36: freeform elbow has orthogonal L segments
    expect(scene.edges.find((e) => e.to === 'n1')!.d.split('L').length).toBeGreaterThanOrEqual(4)

    // AG-39: crosslink anchored on shape border (not box center) & label does not overlap mid node ("Phần 29")
    const cl = scene.crosslinks[0]
    const n1 = scene.byId.get('n1')!
    const nMid = scene.byId.get('mid')!
    const expectedBorder = shapeBorderAnchor(n1.box, n1.shape, n1.r, cl.ctrl)
    expect(Math.hypot(cl.p1.x - expectedBorder.x, cl.p1.y - expectedBorder.y)).toBeLessThan(0.1)
    expect(overlapBoxes(cl.labelBox!, nMid.box)).toBe(0)

    // AG-43 & AG-44: dark map theme resolves dark unchecked checkbox & dark crosslink label contrast
    expect(n1.checkbox!.uncheckedFill).toBe('#0F172A')
    expect(cl.labelBg).toBe('#1E293B')
    expect(cl.labelText).toBe('#F1F5F9')

    // AG-42: SVG contains recognizable link badge paths (<path> not empty <circle>) & bottom badge clearance
    const svg = sceneToSVG(scene, { background: 'canvas', padding: 16 })
    expect(svg).not.toContain('<circle cx="')
    expect(n1.textBounds.y + n1.textBounds.h).toBeLessThanOrEqual(n1.box.y + n1.box.h - 14)

    // AG-49: OPML branch export preserves root url
    const opmlBranch = exportOPML(doc, {
      format: 'opml', scope: 'branch', scopeRootId: 'n1', visibility: 'includeCollapsed',
      includeDrawings: true, excludedDrawingIds: [], background: 'canvas', autoFit: true,
      paddingPercent: 'auto', pngScale: 1, pdfPaper: 'content', pdfOrientation: 'landscape',
      pdfMode: 'onepage', fileName: 'branch',
    })
    expect(opmlBranch).toContain('url="https://example.com"')

    // AG-50: unified ceil((bounds + 2*pad)*scale) formula
    const est3 = estimatePNG(scene, 17, 3)
    const exact3 = pngDimensionsFromWorld(scene.bounds.w + 34, scene.bounds.h + 34, 3)
    expect(est3.w).toBe(exact3.w)
    expect(est3.h).toBe(exact3.h)
    expect(est3.exceedsLimit).toBe(false)

    // AG-52: PDF multipage plan returns safe cuts with zero overlap on protected nodes
    const pdfDoc = newProjectDoc('ManyPages')
    pdfDoc.layout.kind = 'freeform'
    for (let i = 0; i < 8; i++) {
      pdfDoc.topics.push(newTopic({ id: `k${i}`, parent_id: pdfDoc.central_topic_id, manual_position: { x: i * 320, y: (i % 2) * 260 }, text: `Node Trang ${i}` }))
    }
    const pdfScene = buildScene(pdfDoc)
    const plan = planPdfMultipage(pdfScene, { pdfPaper: 'a4', pdfOrientation: 'portrait', pngScale: 2 }, 20)
    expect(plan.ok).toBe(true)
    expect(plan.pageCount).toBeGreaterThan(1)
    for (const cut of plan.xSlices.slice(0, -1).map((s) => s.to)) {
      const worldX = plan.vb.x + cut / plan.scale
      for (const n of pdfScene.nodes) {
        expect(worldX <= n.box.x || worldX >= n.box.x + n.box.w).toBe(true)
      }
    }

    // Oversized single node > A4 portrait width returns ok=false instead of cutting through node text
    const hugeDoc = newProjectDoc('Huge')
    hugeDoc.layout.kind = 'freeform'
    hugeDoc.topics[0].text = 'NodeSiêuRộng'
    hugeDoc.topics[0].style.box_style = { size_mode: 'fixed', width_world: 1180, height_world: 90 }
    const hugeScene = buildScene(hugeDoc)
    const badPlan = planPdfMultipage(hugeScene, { pdfPaper: 'a4', pdfOrientation: 'portrait', pngScale: 2 }, 20)
    expect(badPlan.ok).toBe(false)
    expect(badPlan.error).toContain('Một trang')

    // AG-35: 64px Fixed box keeps emoji grapheme intact when wrapping
    const baseTextStyle = resolveStyle(hugeDoc, hugeDoc.topics[0]).text
    const wrap64 = layoutTextBlock('Quản lý dự án 🧠💡 thông minh', { ...baseTextStyle, wrap: true, wrapWidth: 48 }, 48)
    expect(wrap64.lines.map((l) => l.text).join('')).toContain('🧠')
    expect(wrap64.lines.map((l) => l.text).join('')).toContain('💡')
  })
})
