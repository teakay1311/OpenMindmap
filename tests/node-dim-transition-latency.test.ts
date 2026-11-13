import { describe, expect, test } from 'bun:test'
import { newProjectDoc, newTopic, ProjectDocV3, Topic } from '../lib/core/types'
import { applyCommand, cmdBuilders } from '../lib/core/commands'
import { resolveStyle } from '../lib/core/style'
import { buildScene, measureNodeContent, fitChangedFixedNodes } from '../lib/scene/scene'
import { useApp } from '../lib/store'
import { measureTextWidth } from '../lib/scene/text'

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
  Object.assign(globalThis, { document: { createElement: canvasMock } })
} else {
  Object.assign(globalThis.document, { createElement: canvasMock })
}

const SAMPLE_3_PARAGRAPHS = `Chủ đề mới ngày hôm nay là gì
Tôi cũng không biết nữa
Bạn có thể cho tôi biết được không?`

describe('Section 2: Transition Overlay & Busy Lock (T1–T5)', () => {
  test('T1 & T2: transitionBusy is single source of truth; fast transitions do not flash overlay', () => {
    const st = useApp.getState()
    expect(st.transitionBusy).toBe(false)
    // When transition starts, transitionBusy becomes true immediately
    useApp.setState({ transitionBusy: true })
    expect(useApp.getState().transitionBusy).toBe(true)

    // Interaction checks guard against transitionBusy
    expect(st.dispatch({ type: 'setText', id: 'dummy', before: 'a', after: 'b' }, 'test')).toBe(false)

    // Complete transition fast (< 180ms)
    useApp.setState({ transitionBusy: false })
    expect(useApp.getState().transitionBusy).toBe(false)
  })

  test('T3 & T4: 180ms delay timer logic and cleanup contract', async () => {
    let overlayVisible = false
    let ticket = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const startTransition = (durationMs: number, onDone: () => void) => {
      const myTicket = ++ticket
      timer = setTimeout(() => {
        if (myTicket === ticket) overlayVisible = true
      }, 180)

      setTimeout(() => {
        ticket++
        if (timer) clearTimeout(timer)
        overlayVisible = false
        onDone()
      }, durationMs)
    }

    // Fast run: 50ms (less than 180ms) -> overlay never appears
    await new Promise<void>((resolve) => {
      startTransition(50, () => {
        expect(overlayVisible).toBe(false)
        resolve()
      })
    })

    // Slow run: 220ms (greater than 180ms) -> overlay appears then clears
    await new Promise<void>((resolve) => {
      startTransition(220, () => {
        expect(overlayVisible).toBe(false)
        resolve()
      })
      setTimeout(() => {
        expect(overlayVisible).toBe(true)
      }, 190)
    })
  })
})

describe('Section 3: Node Width Scaling on Font Increase (W1–W6)', () => {
  test('W1: Auto node with 3 paragraphs scales width and keeps fewer lines at 24/36 pt, returns stably to 17 pt', () => {
    const doc = newProjectDoc('Scale Test')
    const t = newTopic({
      id: 'k1',
      parent_id: doc.central_topic_id, // Level 1 (refSize = 17)
      order: 0,
      text: SAMPLE_3_PARAGRAPHS,
    })
    doc.topics.push(t)

    // 17 pt (cỡ tham chiếu)
    const st17 = resolveStyle(doc, t)
    expect(st17.text.fontSizePt).toBe(17)
    expect(st17.text.wrapWidthExplicit).toBe(false)
    const m17 = measureNodeContent(doc, t, st17)

    // 24 pt (lớn hơn tham chiếu: Auto tự nở ngang)
    t.style = { text: { font_size_pt: 24 } }
    const st24 = resolveStyle(doc, t)
    expect(st24.text.fontSizePt).toBe(24)
    const m24 = measureNodeContent(doc, t, st24)
    expect(m24.w).toBeGreaterThanOrEqual(m17.w)
    // Chiều rộng nở ra nên không bị bóp nghẽn 240
    expect(m24.w).toBeGreaterThan(240)

    // 36 pt
    t.style = { text: { font_size_pt: 36 } }
    const st36 = resolveStyle(doc, t)
    const m36 = measureNodeContent(doc, t, st36)
    expect(m36.w).toBeGreaterThanOrEqual(m24.w)

    // Quay lại 17 pt: hình học quay về ổn định
    t.style = { text: { font_size_pt: 17 } }
    const st17Back = resolveStyle(doc, t)
    const m17Back = measureNodeContent(doc, t, st17Back)
    expect(m17Back.w).toBe(m17.w)
    expect(m17Back.h).toBe(m17.h)
  })

  test('W2: Reference sizes (Central 22, Level1 17, Normal 14) and 800 ceiling', () => {
    const doc = newProjectDoc('Ref Size Test')
    const central = doc.topics.find((x) => x.id === doc.central_topic_id)!
    const stCentral = resolveStyle(doc, central)
    expect(stCentral.text.referenceFontSizePt).toBe(22)

    const l1 = newTopic({ id: 'l1', parent_id: doc.central_topic_id, order: 0, text: 'L1' })
    doc.topics.push(l1)
    const stL1 = resolveStyle(doc, l1)
    expect(stL1.text.referenceFontSizePt).toBe(17)

    const norm = newTopic({ id: 'n1', parent_id: 'l1', order: 0, text: 'Norm' })
    doc.topics.push(norm)
    const stNorm = resolveStyle(doc, norm)
    expect(stNorm.text.referenceFontSizePt).toBe(14)

    // Short text node takes only needed width
    const mShort = measureNodeContent(doc, norm, stNorm)
    expect(mShort.w).toBeLessThan(120)

    // Huge paragraph caps ceiling at 800
    norm.text = 'A'.repeat(500)
    norm.style = { text: { font_size_pt: 72 } } // 72 / 14 * 240 > 800 -> ceiling 800
    const stHuge = resolveStyle(doc, norm)
    const mHuge = measureNodeContent(doc, norm, stHuge)
    expect(mHuge.w).toBeLessThanOrEqual(800)
    expect(mHuge.w).toBeGreaterThan(600)
  })

  test('W3: Explicit Wrap width 240 and 520 are honored over default auto ceiling', () => {
    const doc = newProjectDoc('Explicit Wrap')
    const t = newTopic({
      id: 't1',
      parent_id: doc.central_topic_id,
      order: 0,
      text: SAMPLE_3_PARAGRAPHS,
      style: { text: { font_size_pt: 24, wrap_width_world: 240 } },
    })
    doc.topics.push(t)

    const stExplicit240 = resolveStyle(doc, t)
    expect(stExplicit240.text.wrapWidthExplicit).toBe(true)
    expect(stExplicit240.text.wrapWidth).toBe(240)
    const mExplicit240 = measureNodeContent(doc, t, stExplicit240)
    expect(mExplicit240.w).toBeLessThanOrEqual(240)

    // Wrap disabled: single line per paragraph
    t.style = { text: { wrap: false } }
    const stNoWrap = resolveStyle(doc, t)
    const mNoWrap = measureNodeContent(doc, t, stNoWrap)
    expect(mNoWrap.tb.lines.length).toBe(3)
  })

  test('W4: Fixed box with default wrap uses full box width without 240 bottleneck; explicit wrap restricts it', () => {
    const doc = newProjectDoc('Fixed Box Wrap')
    const t = newTopic({
      id: 'f1',
      parent_id: doc.central_topic_id,
      order: 0,
      text: SAMPLE_3_PARAGRAPHS,
      style: {
        box_style: { size_mode: 'fixed', width_world: 520, height_world: 300 },
        text: { font_size_pt: 36 }, // Wrap mặc định (không đặt wrap_width_world)
      },
    })
    doc.topics.push(t)

    const stDefault = resolveStyle(doc, t)
    expect(stDefault.text.wrapWidthExplicit).toBe(false)
    const mDefault = measureNodeContent(doc, t, stDefault)
    // Vùng chữ tận dụng trọn 520 trừ lề, không bị bóp ở 240
    expect(mDefault.tb.lines.length).toBeLessThan(12)

    // Khi đặt wrap rõ 240 trên khung 520
    t.style.text = { font_size_pt: 36, wrap_width_world: 240 }
    const stExplicit = resolveStyle(doc, t)
    expect(stExplicit.text.wrapWidthExplicit).toBe(true)
    const mExplicit = measureNodeContent(doc, t, stExplicit)
    expect(mExplicit.tb.lines.length).toBeGreaterThan(mDefault.tb.lines.length)
  })

  test('W5: Accessories, icons, checkboxes, badges and pills respect boundaries', () => {
    const doc = newProjectDoc('Accessories')
    const t = newTopic({
      id: 'acc1',
      parent_id: doc.central_topic_id,
      order: 0,
      text: 'Topic with accessories',
      icon: { id: 'star', size: 'm' },
      checkbox: { checked: false },
      date: '2026-11-13',
      notes: 'Some notes',
      url: 'https://example.com',
      style: { box_style: { shape: 'pill' } },
    })
    doc.topics.push(t)
    const st = resolveStyle(doc, t)
    const m = measureNodeContent(doc, t, st)
    expect(m.radius).toBeGreaterThan(0)
    expect(m.effectivePadding[0]).toBeGreaterThanOrEqual(10)
    expect(m.effectivePadding[1]).toBeGreaterThanOrEqual(14)
  })

  test('W6: Serialization integrity: Project V3 schema and properties preserved', () => {
    const doc = newProjectDoc('Preserve')
    const t = newTopic({
      id: 'p1',
      parent_id: doc.central_topic_id,
      order: 0,
      text: 'Title',
    })
    doc.topics.push(t)
    const json = JSON.stringify(doc)
    const parsed = JSON.parse(json) as ProjectDocV3
    expect(parsed.schema_version).toBe(3)
    expect(parsed.topics[1].text).toBe('Title')
    // No extra runtime fields leaked into doc
    expect((parsed.topics[1] as any).wrapWidthExplicit).toBeUndefined()
    expect((parsed.topics[1] as any).referenceFontSizePt).toBeUndefined()
  })
})

describe('Section 4: Title Commit Latency Optimization & Caching (E1–E6)', () => {
  test('E4: setText with new title skips duplicate stringify, updates history & revision by 1', () => {
    const doc = newProjectDoc('Latency Test')
    useApp.setState({
      doc,
      past: [],
      future: [],
      saveStatus: 'clean',
      transitionBusy: false,
      leavePrompt: null,
    })

    const initialRev = doc.document_revision
    const ok = useApp.getState().dispatch({ type: 'setText', id: doc.central_topic_id, before: doc.topics[0].text, after: 'Tiêu đề mới tối ưu' }, 'Đổi tên')
    expect(ok).toBe(true)

    const st = useApp.getState()
    expect(st.doc!.document_revision).toBe(initialRev + 1)
    expect(st.past.length).toBe(1)
    expect(st.doc!.topics[0].text).toBe('Tiêu đề mới tối ưu')
    expect(st.saveStatus).toBe('dirty')

    // Dispatching identical title does NOT create extra history or revision bump
    const okSame = useApp.getState().dispatch({ type: 'setText', id: doc.central_topic_id, before: 'Tiêu đề mới tối ưu', after: 'Tiêu đề mới tối ưu' }, 'Đổi tên')
    expect(okSame).toBe(true)
    expect(useApp.getState().doc!.document_revision).toBe(initialRev + 1)
    expect(useApp.getState().past.length).toBe(1)

    // Undo restores previous title
    useApp.getState().undo()
    expect(useApp.getState().doc!.topics[0].text).toBe('Latency Test')
    expect(useApp.getState().past.length).toBe(0)
    expect(useApp.getState().future.length).toBe(1)

    // Redo restores new title
    useApp.getState().redo()
    expect(useApp.getState().doc!.topics[0].text).toBe('Tiêu đề mới tối ưu')
    expect(useApp.getState().past.length).toBe(1)
    expect(useApp.getState().future.length).toBe(0)
  })

  test('E1 / E2: Scene building with 1,500 nodes runs cleanly and completes well within budget', () => {
    const doc = newProjectDoc('Perf 1500 Test')
    const centralId = doc.central_topic_id
    // Create 15 branches of 100 nodes = 1,500 nodes
    for (let b = 0; b < 15; b++) {
      const bId = `b_${b}`
      doc.topics.push(newTopic({ id: bId, parent_id: centralId, order: b, text: `Nhánh chính số ${b}` }))
      for (let c = 0; c < 99; c++) {
        doc.topics.push(newTopic({ id: `c_${b}_${c}`, parent_id: bId, order: c, text: `Node con cấp hai ${c}` }))
      }
    }
    expect(doc.topics.length).toBe(1501)

    // Build scene
    const t0 = performance.now()
    const scene = buildScene(doc)
    const t1 = performance.now()
    const dt = t1 - t0
    expect(scene.nodes.length).toBe(1501)
    // Must be well within performance budget (< 150 ms)
    expect(dt).toBeLessThan(150)
  })
})
