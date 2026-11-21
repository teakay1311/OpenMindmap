import { describe, test, expect, beforeEach } from 'bun:test'
import { captureProjectRenameTarget, useApp as app } from '../lib/store'
import { newProjectDoc, newTopic, parseProjectJSON } from '../lib/core/types'
import { collectRecoveryCandidates, defaultSettings, loadProject, STORAGE_KEYS as K, simpleHash, metaFromDoc, recentProjects, pushTrash, trashList } from '../lib/storage/projects'
import { assertImportSize, buildImportPreview, detectFormat } from '../lib/io/importers'
import { persistProject, withStorageWrite } from '../lib/storage/persistence'
import { copyBranch, pasteBranch } from '../lib/core/clipboard'

const memory = new Map<string, string>()
let failKey = ''
let lockTail = Promise.resolve()
const events = new EventTarget()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { if (key === failKey) throw new Error('TEST_QUOTA'); memory.set(key, String(value)) },
  removeItem: (key: string) => memory.delete(key), key: (i: number) => [...memory.keys()][i], get length() { return memory.size },
} })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
  request: (_name: string, options: { signal: AbortSignal }, callback: () => unknown) => {
    const task = lockTail.then(() => { if (options.signal.aborted) throw new Error('aborted'); return callback() })
    lockTail = task.then(() => {}, () => {})
    return task
  },
} } })
Object.assign(globalThis, {
  window: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), matchMedia: () => ({ matches: false }) },
  document: { documentElement: { classList: { toggle() {} }, style: {} }, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
})
async function seed() {
  const old = app.getState()
  if (old._autosaveTimer) clearTimeout(old._autosaveTimer)
  if (old._journalTimer) clearTimeout(old._journalTimer)
  old._unwatch?.()
  failKey = ''; memory.clear()
  memory.set(K.settings, JSON.stringify({ ...defaultSettings(), autosaveEnabled: false }))
  const doc = newProjectDoc('Fixture')
  doc.topics.push(newTopic({ id: 'child', parent_id: doc.central_topic_id, text: 'Child' }))
  const raw = JSON.stringify(doc)
  memory.set(K.project(doc.project_id), raw)
  memory.set(K.registry, JSON.stringify([]))
  app.setState({ doc, generation: old.generation + 1, persistedRaw: raw, savedHash: simpleHash(raw), saveStatus: 'clean', saveError: null, settings: { ...defaultSettings(), autosaveEnabled: false }, registry: [], past: [], future: [], editor: null, selection: [], transitionBusy: false, leavePrompt: null, confirm: null, toasts: [], _autosaveTimer: null, _journalTimer: null })
  return doc
}
beforeEach(seed)
const edit = (text: string) => { const s = app.getState(); return s.dispatch({ type: 'setText', id: 'child', before: s.doc!.topics[1].text, after: text }, 'Edit') }

describe('B02/B06/B07 storage and async save', () => {
  test('same revision different data conflicts before write', async () => {
    const doc = app.getState().doc!; const base = app.getState().persistedRaw
    const external = structuredClone(doc); external.topics[1].text = 'Other tab'
    memory.set(K.project(doc.project_id), JSON.stringify(external))
    edit('Mine')
    expect((await app.getState().saveNow()).kind).toBe('conflict')
    expect(memory.get(K.project(doc.project_id))).toBe(JSON.stringify(external))
  })
  test('deleted project is not silently recreated', async () => {
    const id = app.getState().doc!.project_id; memory.delete(K.project(id)); edit('Mine')
    expect((await app.getState().saveNow()).kind).toBe('conflict'); expect(memory.has(K.project(id))).toBe(false)
  })
  test('concurrent writes to same base: exactly one succeeds', async () => {
    const doc = app.getState().doc!, base = app.getState().persistedRaw
    const a = structuredClone(doc), b = structuredClone(doc); a.topics[1].text = 'A'; b.topics[1].text = 'B'
    const results = await Promise.all([persistProject(a, base), persistProject(b, base)])
    expect(results.map(r => r.kind)).toEqual(['saved', 'conflict'])
  })
  test('concurrent different projects preserve both registry entries', async () => {
    const a = newProjectDoc('A'), b = newProjectDoc('B')
    await Promise.all([persistProject(a, null), persistProject(b, null)])
    const ids = JSON.parse(memory.get(K.registry)!).map((m: any) => m.id)
    expect(ids).toContain(a.project_id); expect(ids).toContain(b.project_id)
  })
  test('document write failure retains RAM, history and base', async () => {
    edit('Mine'); const s = app.getState(); failKey = K.project(s.doc!.project_id)
    expect((await s.saveNow()).kind).toBe('error'); expect(app.getState().saveStatus).toBe('error')
    expect(app.getState().persistedRaw).toBe(s.persistedRaw); expect(app.getState().past.length).toBe(1)
    expect(app.getState().doc!.topics[1].text).toBe('Mine')
  })
  test('registry failure acknowledges written document then retries metadata', async () => {
    edit('Mine'); failKey = K.registry
    expect((await app.getState().saveNow()).kind).toBe('error')
    expect(app.getState().saveStatus).toBe('error')
    expect(app.getState().persistedRaw).toBe(memory.get(K.project(app.getState().doc!.project_id))!)
    failKey = ''; expect((await app.getState().saveNow()).kind).toBe('saved')
    expect(app.getState().saveStatus).toBe('clean')
  })
  test('same snapshot shares one save job', async () => {
    edit('Mine'); const a = app.getState().saveNow(), b = app.getState().saveNow()
    expect(a).toBe(b); await a
    const backups = JSON.parse(memory.get(K.backup(app.getState().doc!.project_id))!)
    expect(backups.length).toBe(1)
  })
  test('edits during save remain dirty with autosave off', async () => {
    let release!: () => void
    const held = withStorageWrite(() => new Promise<void>(r => { release = r }))
    await Promise.resolve(); await Promise.resolve()
    edit('One'); const saving = app.getState().saveNow(); edit('Two'); release(); await held
    const result = await saving
    expect(result.kind).toBe('saved'); if (result.kind === 'saved') expect(result.stillDirty).toBe(true)
    expect(app.getState().saveStatus).toBe('dirty')
    expect(JSON.parse(memory.get(K.project(app.getState().doc!.project_id))!).topics[1].text).toBe('One')
  })
  test('Save As metadata failure retains source and retries same ID', async () => {
    edit('Mine'); const id = app.getState().doc!.project_id
    failKey = K.registry; expect(await app.getState().resolveConflictSaveAs()).toBe(false)
    expect(app.getState().doc!.project_id).toBe(id); expect(app.getState().past.length).toBe(1)
    const projects = [...memory.keys()].filter(k => k.startsWith('omm.project.'))
    failKey = ''; expect(await app.getState().resolveConflictSaveAs()).toBe(true)
    expect([...memory.keys()].filter(k => k.startsWith('omm.project.'))).toEqual(projects)
    expect(app.getState().doc!.project_id).not.toBe(id)
  })
  test('missing Web Locks fails safely', async () => {
    const locks = navigator.locks; (navigator as any).locks = undefined
    edit('Mine'); const result = await app.getState().saveNow(); (navigator as any).locks = locks
    expect(result.kind).toBe('error'); expect(app.getState().doc!.topics[1].text).toBe('Mine')
  })
})
describe('B01/B04 project lifecycle', () => {
  test('cancel preserves dirty document and history', async () => {
    edit('Mine'); const id = app.getState().doc!.project_id
    const switching = app.getState().createProject('New')
    expect(app.getState().leavePrompt).not.toBeNull(); await app.getState().chooseLeave('cancel')
    expect(await switching).toBe(false); expect(app.getState().doc!.project_id).toBe(id); expect(app.getState().past.length).toBe(1)
  })
  test('save and continue retains changes after reopening', async () => {
    edit('Mine'); const id = app.getState().doc!.project_id
    const switching = app.getState().createProject('New'); await app.getState().chooseLeave('save')
    expect(await switching).toBe(true); expect(await app.getState().openProject(id)).toBe(true)
    expect(app.getState().doc!.topics[1].text).toBe('Mine')
  })
  test('discard changes switches without rewriting source', async () => {
    edit('Mine'); const id = app.getState().doc!.project_id
    const switching = app.getState().createProject('New'); await app.getState().chooseLeave('discard')
    expect(await switching).toBe(true); expect(JSON.parse(memory.get(K.project(id))!).topics[1].text).toBe('Child')
  })
  test('failed save stops switching and preserves draft journal', async () => {
    app.getState().startEdit('child', 'title'); app.getState().updateDraft('Draft')
    const id = app.getState().doc!.project_id, switching = app.getState().createProject('New')
    failKey = K.project(id); await app.getState().chooseLeave('save')
    expect(await switching).toBe(false); expect(app.getState().doc!.project_id).toBe(id)
    expect(app.getState().doc!.topics[1].text).toBe('Draft'); expect(memory.get(K.journal(id))).toContain('Draft')
  })
  test('second transition cannot replace the pending first one', async () => {
    edit('Mine'); const first = app.getState().createProject('First')
    expect(await app.getState().createProject('Second')).toBe(false)
    await app.getState().chooseLeave('discard'); expect(await first).toBe(true); expect(app.getState().doc!.name).toBe('First')
  })
  test('Undo/Redo revision increases and content is restored', () => {
    const revisions = [app.getState().doc!.document_revision]
    for (const text of ['A', 'B', 'C']) { edit(text); revisions.push(app.getState().doc!.document_revision) }
    for (let i = 0; i < 3; i++) { app.getState().undo(); revisions.push(app.getState().doc!.document_revision) }
    expect(app.getState().doc!.topics[1].text).toBe('Child')
    for (let i = 0; i < 3; i++) { app.getState().redo(); revisions.push(app.getState().doc!.document_revision) }
    expect(app.getState().doc!.topics[1].text).toBe('C')
    expect(revisions.every((v, i) => !i || v > revisions[i - 1])).toBe(true)
  })
  test('journal cleared only after verified save', async () => {
    app.getState().startEdit('child', 'title'); app.getState().updateDraft('Draft'); app.getState().commitEdit()
    const key = K.journal(app.getState().doc!.project_id)
    await withStorageWrite(() => expect(memory.has(key)).toBe(true))
    await app.getState().saveNow(); expect(memory.has(key)).toBe(false)
  })
})
describe('B03/B08 data integrity', () => {
  test('clipboard carries assets, remaps collisions and undoes all together', () => {
    const source = app.getState().doc!; source.assets = [{ id: 'image', mime: 'image/png', width: 1, height: 1, hash: 'same-hash', data_url: 'data:image/png;base64,A' }]
    source.topics[1].image = { asset_id: 'image', fit: 'contain', placement: 'below', width_fraction: 0.5 }
    const clip = copyBranch(source, 'child')!
    const target = newProjectDoc('Target'); target.assets = [{ ...source.assets[0], data_url: 'data:image/png;base64,B' }]
    app.setState({ doc: target, past: [], future: [], saveStatus: 'clean' })
    const before = structuredClone(target)
    expect(app.getState().dispatch(pasteBranch(target, clip, target.central_topic_id), 'Paste')).toBe(true)
    const doc = app.getState().doc!, copied = doc.topics[1]
    expect(copied.parent_id).toBe(doc.central_topic_id); expect(copied.image!.asset_id).not.toBe('image')
    expect(doc.assets.find(a => a.id === copied.image!.asset_id)!.data_url).toBe(source.assets[0].data_url)
    app.getState().undo(); expect(app.getState().doc!.assets).toEqual(before.assets)
    app.getState().redo(); expect(app.getState().doc!.assets.length).toBe(2)
    expect(source.topics[1].image.asset_id).toBe('image')
  })
  test('duplicate IDs rejected for root and ordinary nodes in v1/v2/v3', () => {
    for (const version of [1, 2, 3]) for (const root of [true, false]) {
      const d = newProjectDoc('Invalid'); d.topics.push(newTopic({ id: root ? d.central_topic_id : 'duplicate', text: 'A' }))
      if (!root) d.topics.push(newTopic({ id: 'duplicate', text: 'B' }))
      expect(() => parseProjectJSON(JSON.stringify({ ...d, schema_version: version }))).toThrow('ID topic trùng')
    }
    const d = newProjectDoc('Valid'); expect(parseProjectJSON(JSON.stringify(d)).doc.project_id).toBe(d.project_id)
  })
})

describe('related lifecycle regressions', () => {
  test('open target failure does not discard current unsaved edits', async () => {
    edit('Mine'); const before = app.getState().doc
    const switching = app.getState().openProject('missing'); await app.getState().chooseLeave('discard')
    expect(await switching).toBe(false); expect(app.getState().doc).toBe(before)
  })
  test('Save As includes draft but leaves source document unchanged', async () => {
    const source = app.getState().doc!, original = structuredClone(source)
    app.getState().startEdit('child', 'notes'); app.getState().updateDraft('Draft notes')
    expect(await app.getState().resolveConflictSaveAs()).toBe(true)
    expect(app.getState().doc!.topics[1].notes).toBe('Draft notes')
    expect(JSON.parse(memory.get(K.project(source.project_id))!)).toEqual(original)
  })
  test('settings failure when activating copy retries without duplicate', async () => {
    const id = app.getState().doc!.project_id; failKey = K.settings
    expect(await app.getState().resolveConflictSaveAs()).toBe(false)
    expect(app.getState().doc!.project_id).toBe(id)
    const projects = [...memory.keys()].filter(k => k.startsWith('omm.project.'))
    failKey = ''; expect(await app.getState().resolveConflictSaveAs()).toBe(true)
    expect([...memory.keys()].filter(k => k.startsWith('omm.project.'))).toEqual(projects)
  })
  test('latest source edits are used when retrying a partial copy', async () => {
    failKey = K.registry; await app.getState().resolveConflictSaveAs(); edit('Latest')
    failKey = ''; expect(await app.getState().resolveConflictSaveAs()).toBe(true)
    expect(app.getState().doc!.topics[1].text).toBe('Latest')
  })
  test('concurrent explicit saves drain newest snapshot with autosave off', async () => {
    let release!: () => void
    const held = withStorageWrite(() => new Promise<void>(r => { release = r })); await Promise.resolve(); await Promise.resolve()
    edit('One'); const a = app.getState().saveNow(); edit('Two'); const b = app.getState().saveNow()
    release(); await held; await Promise.all([a, b])
    expect(app.getState().saveStatus).toBe('clean'); expect(JSON.parse(app.getState().persistedRaw!).topics[1].text).toBe('Two')
  })
  test('journal disabled remains disabled and creates no journal', () => {
    app.setState({ settings: { ...app.getState().settings, draftJournalEnabled: false } })
    app.getState().startEdit('child', 'title'); app.getState().updateDraft('Draft'); app.getState().commitEdit()
    expect(memory.has(K.journal(app.getState().doc!.project_id))).toBe(false)
  })
  test('Undo/Redo are blocked during conflict and transition', () => {
    edit('Mine'); app.setState({ saveStatus: 'conflict' }); const doc = app.getState().doc
    app.getState().undo(); expect(app.getState().doc).toBe(doc)
    app.setState({ saveStatus: 'dirty', transitionBusy: true }); app.getState().undo(); expect(app.getState().doc).toBe(doc)
  })
  test('identical image data is reused, not duplicated', () => {
    const source = app.getState().doc!
    source.assets = [{ id: 'a', mime: 'image/png', width: 1, height: 1, hash: 'a', data_url: 'data:image/png;base64,A' }]
    source.topics[1].image = { asset_id: 'a', fit: 'contain', placement: 'below', width_fraction: 0.5 }
    const clip = copyBranch(source, 'child')!; const cmd = pasteBranch(source, clip, source.central_topic_id)
    app.getState().dispatch(cmd, 'Paste'); expect(app.getState().doc!.assets.length).toBe(1)
  })
})

test('native open partial metadata write can be retried without self-conflict', async () => {
  const incoming = structuredClone(app.getState().doc!)
  incoming.project_id = 'native-retry-free-id'
  incoming.topics[1].text = 'Imported'
  failKey = K.registry
  expect(await app.getState().openNativeDoc(incoming, { taskId: 'native-task-1' })).toBe(false)
  expect(app.getState().doc!.topics[1].text).toBe('Child')
  failKey = ''
  const retry = app.getState().openNativeDoc(incoming, { taskId: 'native-task-1' })
  if (app.getState().leavePrompt) await app.getState().chooseLeave('discard')
  expect(await retry).toBe(true)
  expect(app.getState().doc!.project_id).toBe('native-retry-free-id')
  expect(app.getState().doc!.topics[1].text).toBe('Imported')
})

test('a clean tab cannot hide another unacknowledged draft on startup', async () => {
  const { collectRecoveryCandidates } = await import('../lib/storage/projects')
  const doc = app.getState().doc!
  memory.set(K.cleanShutdown, '1')
  memory.set(K.journal(doc.project_id), JSON.stringify({ journal_schema_version: 1, project_id: doc.project_id, node_id: 'child', field: 'title', base_document_revision: 1, draft_text: 'Unacknowledged', timestamp: new Date().toISOString() }))
  expect(collectRecoveryCandidates().length).toBe(1)
  memory.set(K.journal(doc.project_id), JSON.stringify({ journal_schema_version: 1, project_id: doc.project_id, node_id: 'child', field: 'title', base_document_revision: 1, draft_text: 'Child', timestamp: new Date().toISOString() }))
  expect(collectRecoveryCandidates().length).toBe(0)
})

test('read-back failure can retry identical bytes without self-conflict', async () => {
  edit('Verified retry')
  const key = K.project(app.getState().doc!.project_id), read = localStorage.getItem
  let reads = 0
  localStorage.getItem = (k: string) => k === key && ++reads === 2 ? 'READBACK_MISMATCH' : read(k)
  try { expect((await app.getState().saveNow()).kind).toBe('error') }
  finally { localStorage.getItem = read }
  expect((await app.getState().saveNow()).kind).toBe('saved')
  expect(app.getState().saveStatus).toBe('clean')
})

test('verified Undo save does not resurrect a committed draft on restart', async () => {
  app.getState().startEdit('child', 'title'); app.getState().updateDraft('Undo me'); app.getState().commitEdit()
  app.getState().undo(); expect(app.getState().doc!.topics[1].text).toBe('Child')
  expect((await app.getState().saveNow()).kind).toBe('saved')
  expect(memory.has(K.journal(app.getState().doc!.project_id))).toBe(false)
})

test('registry read-back validates all metadata, not just count and revision', async () => {
  const doc = app.getState().doc!, meta = metaFromDoc(doc)
  const stored = { ...meta, updatedAt: 'STALE' }
  memory.set(K.registry, JSON.stringify([stored]))
  app.setState({ registry: [stored] })
  const write = localStorage.setItem
  localStorage.setItem = (key: string, value: string) => { if (key !== K.registry) write(key, value) }
  try { expect((await app.getState().saveNow()).kind).toBe('error') }
  finally { localStorage.setItem = write }
  expect((await app.getState().saveNow()).kind).toBe('saved')
})

test('settings with a failed read-back do not report success', async () => {
  const write = localStorage.setItem
  localStorage.setItem = (key: string, value: string) => { if (key !== K.settings) write(key, value) }
  try { expect(await app.getState().setSettings({ backupCount: 9 })).toBe(false) }
  finally { localStorage.setItem = write }
  expect(app.getState().settings.backupCount).toBe(5)
})

test('QA15 recovery compares the whole source and preserves a same-revision concurrent write', async () => {
  const source = app.getState().doc!
  const raw = JSON.stringify(source)
  const draft = { journal_schema_version: 1 as const, project_id: source.project_id, node_id: 'child', field: 'title' as const, base_document_revision: source.document_revision, base_field_value: 'Child', draft_text: 'Recovered', timestamp: '2026-11-09T00:00:00.000Z' }
  memory.set(K.journal(source.project_id), JSON.stringify(draft))
  app.setState({ recovery: { open: true, candidates: [{ kind: 'draft', projectId: source.project_id, projectName: source.name, timestamp: draft.timestamp, detail: '', doc: source, draft, baseRaw: raw }] } })
  const concurrent = JSON.stringify({ ...source, name: 'Newer name with same revision' })
  memory.set(K.project(source.project_id), concurrent)
  expect(await app.getState().applyRecovery(0, false)).toBe(false)
  expect(memory.get(K.project(source.project_id))).toBe(concurrent)
  expect(memory.get(K.journal(source.project_id))).toBe(JSON.stringify(draft))
  expect(await app.getState().applyRecovery(0, true)).toBe(true)
  expect(app.getState().doc!.project_id).not.toBe(source.project_id)
  expect(app.getState().doc!.topics[1].text).toBe('Recovered')
  expect(memory.get(K.project(source.project_id))).toBe(concurrent)
})

test('QA16 branch paste remaps internal crosslinks and restores them through undo and redo', () => {
  const source = app.getState().doc!
  source.topics.push(newTopic({ id: 'grandchild', parent_id: 'child', text: 'Grandchild' }))
  source.crosslinks = [{ id: 'inner', source: 'child', target: 'grandchild' }, { id: 'outer', source: 'child', target: source.central_topic_id }]
  const clip = copyBranch(source, 'child')!
  const command = pasteBranch(source, clip, source.central_topic_id)
  expect(app.getState().dispatch(command, 'Paste')).toBe(true)
  const pasted = app.getState().doc!
  const link = pasted.crosslinks.find(c => c.id !== 'inner' && c.id !== 'outer')!
  expect(link.source).not.toBe('child')
  expect(pasted.topics.find(t => t.id === link.target)?.parent_id).toBe(link.source)
  expect(pasted.crosslinks).toHaveLength(3)
  app.getState().undo()
  expect(app.getState().doc!.crosslinks).toEqual(source.crosslinks)
  app.getState().redo()
  expect(app.getState().doc!.crosslinks).toEqual(pasted.crosslinks)
})

test('QA15 a verified recovery with pending registry write retries exactly once', async () => {
  const source = app.getState().doc!
  const raw = JSON.stringify(source)
  const draft = { journal_schema_version: 1 as const, project_id: source.project_id, node_id: 'child', field: 'title' as const, base_document_revision: source.document_revision, base_field_value: 'Child', draft_text: 'Recovered', timestamp: '2026-11-09T00:00:00.000Z' }
  memory.set(K.journal(source.project_id), JSON.stringify(draft))
  app.setState({ recovery: { open: true, candidates: [{ kind: 'draft', projectId: source.project_id, projectName: source.name, timestamp: draft.timestamp, detail: '', doc: source, draft, baseRaw: raw }] } })
  failKey = K.registry
  expect(await app.getState().applyRecovery(0, false)).toBe(false)
  const verified = memory.get(K.project(source.project_id))!
  expect(JSON.parse(verified).topics[1].text).toBe('Recovered')
  expect(JSON.parse(verified).document_revision).toBe(source.document_revision + 1)
  expect(memory.get(K.journal(source.project_id))).toBe(JSON.stringify(draft))
  expect(app.getState().saveStatus).toBe('error')
  failKey = ''
  // Resume the existing operation after the error, using the verified write as its base.
  const resumed = app.getState().applyRecovery(0, false)
  if (app.getState().leavePrompt) await app.getState().chooseLeave('discard')
  expect(await resumed).toBe(true)
  expect(memory.get(K.project(source.project_id))).toBe(verified)
  expect(memory.has(K.journal(source.project_id))).toBe(false)
})

test('permanent removal cannot be raced by a stale restore or queued project auxiliaries', async () => {
  const doc = app.getState().doc!
  const id = doc.project_id
  const other = newProjectDoc('Other')
  const registry = [metaFromDoc(doc), metaFromDoc(other)]
  memory.set(K.registry, JSON.stringify(registry))
  app.setState({ registry })
  memory.set(K.project(other.project_id), JSON.stringify(other))
  memory.set(K.backup(id), JSON.stringify([{ rev: doc.document_revision, json: JSON.stringify(doc) }]))
  memory.set(K.backup(other.project_id), 'other backup')
  memory.set(K.session(id), '{"camera":{"x":3,"y":4,"zoom":1}}')
  memory.set(K.session(other.project_id), 'other session')
  memory.set(K.journal(other.project_id), 'other draft')
  memory.set(K.settings, JSON.stringify({ ...defaultSettings(), lastProjectId: id, sessionByProject: { [id]: {}, [other.project_id]: {} } }))
  pushTrash(doc)
  const item = trashList()[0]
  const backup = memory.get(K.backup(id))
  expect(await app.getState().purgeTrash(item)).toBe(false)
  expect(memory.get(K.backup(id))).toBe(backup)
  memory.delete(K.project(id))

  const originalRemove = localStorage.removeItem
  localStorage.removeItem = key => {
    if (key === K.session(id)) throw new Error('TEST_SESSION_REMOVE')
    originalRemove(key)
  }
  try {
    expect(await app.getState().purgeTrash(item)).toBe(false)
    expect(trashList()[0]).toEqual(item)
  } finally { localStorage.removeItem = originalRemove }

  const purge = app.getState().purgeTrash(item)
  app.getState().setCamera({ x: 99, y: 40, zoom: 2 })
  app.getState().startEdit('child', 'title')
  app.getState().updateDraft('Late draft')
  app.getState().commitEdit()
  const restore = app.getState().restoreTrash(item)
  expect(await purge).toBe(true)
  expect(await restore).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 275))
  await withStorageWrite(() => {
    for (const key of [K.project(id), K.backup(id), K.journal(id), K.session(id)]) expect(memory.has(key)).toBe(false)
  })
  expect(trashList()).toEqual([])
  expect(JSON.parse(memory.get(K.registry)!)).toEqual([registry[1]])
  expect(JSON.parse(memory.get(K.settings)!).lastProjectId).toBeNull()
  expect(JSON.parse(memory.get(K.settings)!).sessionByProject).toEqual({ [other.project_id]: {} })
  expect(memory.get(K.project(other.project_id))).toBe(JSON.stringify(other))
  expect(memory.get(K.backup(other.project_id))).toBe('other backup')
  expect(memory.get(K.journal(other.project_id))).toBe('other draft')
  expect(memory.get(K.session(other.project_id))).toBe('other session')
})

test('a partially persisted trash restore reuses its candidate and excludes stale purge', async () => {
  const doc = app.getState().doc!
  pushTrash(doc)
  const item = trashList()[0]
  const originalSet = localStorage.setItem
  localStorage.setItem = (key, value) => {
    if (key === K.trash && JSON.parse(value).length === 0) throw new Error('TEST_TRASH_FINALIZE')
    originalSet(key, value)
  }
  try { expect(await app.getState().restoreTrash(item)).toBe(false) }
  finally { localStorage.setItem = originalSet }
  const restoreId = trashList()[0].restoreId!
  expect(restoreId).not.toBe(doc.project_id)
  expect(memory.has(K.project(restoreId))).toBe(true)
  const retry = app.getState().restoreTrash(item)
  const stalePurge = app.getState().purgeTrash(item)
  expect(await retry).toBe(true)
  expect(await stalePurge).toBe(false)
  expect(trashList()).toEqual([])
  expect([...memory.keys()].filter(key => key.startsWith('omm.project.')).sort()).toEqual([K.project(doc.project_id), K.project(restoreId)].sort())
  expect(memory.get(K.project(doc.project_id))).toBe(JSON.stringify(doc))
  expect(loadProject(restoreId)?.topics).toEqual(doc.topics)
})

test('hide from Recent survives save and reload and an explicit open unhides it', async () => {
  const doc = app.getState().doc!
  const id = doc.project_id
  const metadata = metaFromDoc(doc)
  const source = memory.get(K.project(id))
  memory.set(K.registry, JSON.stringify([metadata]))
  memory.set(K.settings, JSON.stringify({ ...defaultSettings(), autosaveEnabled: false, lastProjectId: id }))
  app.setState({ registry: [metadata] })
  expect(await app.getState().removeRecent(id)).toBe(true)
  expect(memory.get(K.project(id))).toBe(source)
  expect(app.getState().registry[0].id).toBe(id)
  expect(recentProjects(app.getState().registry)).toEqual([])
  edit('Still available')
  expect((await app.getState().saveNow()).kind).toBe('saved')
  expect(recentProjects(app.getState().registry)).toEqual([])
  expect(await app.getState().resolveConflictReload()).toBe(true)
  expect(recentProjects(app.getState().registry)).toEqual([])
  expect(await app.getState().openProject(id)).toBe(true)
  expect(recentProjects(app.getState().registry).map(meta => meta.id)).toEqual([id])
})

test('Project V3 preserves valid version notes and normalizes unsupported values', async () => {
  const { remapProject } = await import('../lib/io/importers')
  const doc = app.getState().doc!
  for (const value of ['Phê duyệt 🗺️', '', null, undefined, 12]) {
    const parsed = parseProjectJSON(JSON.stringify({ ...doc, version_note: value })).doc
    const expected = typeof value === 'string' ? value : null
    expect(parsed.version_note).toBe(expected)
    expect(remapProject(parsed).version_note).toBe(expected)
    expect(parsed.project_id).toBe(doc.project_id)
    expect(parsed.topics[1].parent_id).toBe(parsed.central_topic_id)
  }
})

test('QA04 trash failures preserve the source or a verified trash copy and allow retry', async () => {
  const source = app.getState().doc!
  const raw = JSON.stringify(source)
  memory.set(K.registry, JSON.stringify([{ id: source.project_id }]))
  memory.set(K.settings, JSON.stringify({ ...defaultSettings(), lastProjectId: source.project_id }))
  app.getState().deleteProject(source.project_id)
  const confirm = app.getState().confirm!
  failKey = K.trash
  expect(await confirm.onOk()).toBe(false)
  expect(memory.get(K.project(source.project_id))).toBe(raw)
  expect(JSON.parse(memory.get(K.registry)!)).toHaveLength(1)
  failKey = K.registry
  const partial = confirm.onOk()
  if (app.getState().leavePrompt) await app.getState().chooseLeave('discard')
  expect(await partial).toBe(false)
  expect(memory.has(K.project(source.project_id))).toBe(false)
  expect(JSON.parse(memory.get(K.trash)!)[0].doc).toEqual(source)
  expect(app.getState().saveStatus).toBe('conflict')
  failKey = ''
  expect(await confirm.onOk()).toBe(true)
  expect(JSON.parse(memory.get(K.trash)!)).toHaveLength(1)
  expect(JSON.parse(memory.get(K.registry)!)).toEqual([])
  expect(JSON.parse(memory.get(K.settings)!).lastProjectId).toBeNull()
})

test('QA10 rejects malformed topic IDs, style geometry and crosslink fields before preview', () => {
  const base = app.getState().doc!
  const variants = [
    (d: any) => { d.topics[1].id = 42 },
    (d: any) => { d.topics[1].style.text = { padding_world: ['x', 0, 0, 0] } },
    (d: any) => { d.map_style_overrides.text = { font_size_pt: 'large' } },
    (d: any) => { d.crosslinks = [{ id: 'link', source: d.central_topic_id, target: 'child', color: { bad: true } }] },
    (d: any) => { d.crosslinks = [{ id: 'link', source: d.central_topic_id, target: 'child', waypoints: [null] }] },
  ]
  for (const change of variants) {
    const doc = structuredClone(base); change(doc)
    expect(() => parseProjectJSON(JSON.stringify(doc))).toThrow()
  }
  for (const version of [1, 2, 3]) expect(parseProjectJSON(JSON.stringify({ ...base, schema_version: version })).doc.topics).toHaveLength(2)
})

test('QA10 validates both import commits again without modifying storage or the active source', async () => {
  for (const method of ['openNativeDoc', 'importOutline'] as const) {
    const source = app.getState().doc!, before = [...memory.entries()]
    const malformed = structuredClone(source)
    malformed.drawings = [null as any]
    expect(await app.getState()[method](malformed)).toBe(false)
    expect(app.getState().doc).toBe(source)
    expect([...memory.entries()]).toEqual(before)
  }
})

describe('AUD04 stored recovery', () => {
  function journal(doc: ReturnType<typeof newProjectDoc>, nodeId = 'child') {
    return JSON.stringify({ journal_schema_version: 1, project_id: doc.project_id, node_id: nodeId,
      field: 'title', base_document_revision: doc.document_revision, base_field_value: 'Child',
      draft_text: 'Recovered', timestamp: '2026-11-10T00:00:00.000Z' })
  }
  test('bad document, journal and backup records do not suppress a healthy candidate', async () => {
    const healthy = app.getState().doc!
    const corrupt = newProjectDoc('Corrupt')
    const other = newProjectDoc('Broken journal')
    const missing = newProjectDoc('No matching node')
    const raw = JSON.stringify({ project_id: corrupt.project_id, name: corrupt.name })
    memory.set(K.project(corrupt.project_id), raw)
    memory.set(K.journal(corrupt.project_id), journal(corrupt))
    memory.set(K.backup(corrupt.project_id), JSON.stringify([null, { rev: 2, json: '{}' }]))
    memory.set(K.journal(other.project_id), '{')
    memory.set(K.journal(missing.project_id), journal(missing, 'absent'))
    memory.set(K.backup(missing.project_id), JSON.stringify([{ rev: 1, json: JSON.stringify(missing) }]))
    memory.set(K.journal(healthy.project_id), journal(healthy))
    const before = [...memory.entries()]
    const skipped = new Set<string>()
    const candidates = collectRecoveryCandidates(id => skipped.add(id))
    expect(candidates.map(c => c.projectId)).toEqual([healthy.project_id])
    expect(skipped).toEqual(new Set([corrupt.project_id, other.project_id, missing.project_id]))
    expect([...memory.entries()]).toEqual(before)
    expect(loadProject(corrupt.project_id)).toBeNull()
    expect(await app.getState().openProject(corrupt.project_id)).toBe(false)
    expect(app.getState().doc).toBe(healthy)
    expect(memory.get(K.project(corrupt.project_id))).toBe(raw)
  })
  test('backup fallback only copies, preserves the corrupt source and retries the same ID', async () => {
    const healthy = app.getState().doc!
    const source = { ...structuredClone(healthy), project_id: 'corrupt-aud04' }
    const corrupt = '{'
    const draft = journal(source)
    memory.set(K.project(source.project_id), corrupt)
    memory.set(K.journal(source.project_id), draft)
    memory.set(K.backup(source.project_id), JSON.stringify([null, { rev: 1, json: JSON.stringify(source) }]))
    const candidates = collectRecoveryCandidates()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].baseRaw).toBeUndefined()
    app.setState({ recovery: { open: true, candidates } })
    expect(await app.getState().applyRecovery(0, false)).toBe(false)
    failKey = K.registry
    expect(await app.getState().applyRecovery(0, true)).toBe(false)
    const copies = () => [...memory.keys()].filter(key => key.startsWith('omm.project.') && key !== K.project(healthy.project_id) && key !== K.project(source.project_id))
    expect(copies()).toHaveLength(1)
    const [copy] = copies()
    expect(memory.get(K.journal(source.project_id))).toBe(draft)
    failKey = ''
    expect(await app.getState().applyRecovery(0, true)).toBe(true)
    expect(copies()).toEqual([copy])
    expect(app.getState().doc!.topics[1].text).toBe('Recovered')
    expect(memory.get(K.project(source.project_id))).toBe(corrupt)
    expect(memory.has(K.journal(source.project_id))).toBe(false)
  })
})

test('AUD01 format-specific limits, UTF-8 and native parsing', () => {
  const MiB = 1024 * 1024
  for (const format of ['json', 'md', 'opml', 'txt'] as const) {
    const limit = (format === 'json' ? 100 : 25) * MiB
    for (const size of [limit - 1, limit]) expect(() => assertImportSize(size, format)).not.toThrow()
    expect(() => assertImportSize(limit + 1, format)).toThrow('Tệp quá lớn')
  }
  expect(detectFormat('untitled', ' {')).toBe('json')
  expect(detectFormat('untitled.md', '{')).toBe('md')
  const raw = JSON.stringify(app.getState().doc!)
  const spaced = raw + ' '.repeat(26 * MiB)
  expect(buildImportPreview('untitled', spaced).nativeDoc?.project_id).toBe(app.getState().doc!.project_id)
  expect(() => buildImportPreview('broken.json', '{')).toThrow()
  const multibyte = 'é'.repeat(25 * MiB / 2 + 1)
  expect(() => buildImportPreview('large.txt', multibyte)).toThrow('Tệp quá lớn')
})

test('AUD02 drawing bounds are verified in preview and both commit paths', async () => {
  const source = app.getState().doc!
  const make = (patch: Partial<(typeof source.drawings)[number]>) => {
    const doc = structuredClone(source)
    doc.drawings = [{ id: 'drawing', kind: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000000', width_world: .5, opacity: .05, layer_order: -1, ...patch }]
    return doc
  }
  for (const patch of [{ width_world: -.1 }, { width_world: 61 }, { opacity: .04 }, { opacity: 2 }, { layer_order: .5 }]) {
    const doc = make(patch)
    expect(() => parseProjectJSON(JSON.stringify(doc))).toThrow('Dữ liệu nét vẽ không hợp lệ')
    const before = [...memory.entries()]
    expect(await app.getState().openNativeDoc(doc)).toBe(false)
    expect(await app.getState().importOutline(doc)).toBe(false)
    expect(app.getState().doc).toBe(source)
    expect([...memory.entries()]).toEqual(before)
  }
  for (const version of [1, 2, 3]) {
    for (const doc of [make({}), make({ width_world: 60, opacity: 1, layer_order: 3 })]) {
      expect(parseProjectJSON(JSON.stringify({ ...doc, schema_version: version })).doc.drawings).toEqual(doc.drawings)
    }
  }
})

test('AUD11 identical bytes are reused and an ID collision keeps both images linked through history', () => {
  const doc = app.getState().doc!
  const a = { id: 'same-id', mime: 'image/png', width: 1, height: 1, hash: 'same-hash', data_url: 'data:image/png;base64,AAAA' }
  const attach = (id: string, asset: typeof a) => app.getState().dispatch({
    type: 'attachImage', id, asset, before: null,
    after: { asset_id: asset.id, fit: 'contain', placement: 'below', width_fraction: .5 },
  }, 'Attach')
  expect(attach('child', a)).toBe(true)
  expect(attach(doc.central_topic_id, { ...a, id: 'different-id' })).toBe(true)
  expect(app.getState().doc!.assets).toEqual([a])
  expect(app.getState().doc!.topics[0].image?.asset_id).toBe(a.id)
  expect(attach(doc.central_topic_id, { ...a, data_url: 'data:image/png;base64,BBBB' })).toBe(true)
  const after = app.getState().doc!
  const secondId = after.topics[0].image?.asset_id
  expect(secondId).not.toBe(a.id)
  expect(after.assets.find(x => x.id === secondId)?.data_url).toBe('data:image/png;base64,BBBB')
  expect(after.topics[1].image?.asset_id).toBe(a.id)
  app.getState().undo()
  expect(app.getState().doc!.assets).toEqual([a])
  app.getState().redo()
  expect(app.getState().doc!.topics[0].image?.asset_id).toBe(secondId)
})

/* UI07: module assertions protect command atomicity; pixel proof is in the browser suite. */
describe('UI07 Fixed geometry and editor failure', () => {
  function fixed() {
    Object.assign(document, { createElement: () => ({ getContext: () => ({
      font: '', save() {}, restore() {}, textAlign: 'center', textBaseline: 'alphabetic',
      measureText(text: string) { const width = Array.from(text).length * 8; return { width, actualBoundingBoxLeft: width / 2, actualBoundingBoxRight: width / 2, actualBoundingBoxAscent: 13, actualBoundingBoxDescent: 4 } },
    }) }) })
    const d = structuredClone(app.getState().doc!)
    d.topics[1].style.box_style = { size_mode: 'fixed', width_world: 80, height_world: 32 }
    app.setState({ doc: d })
    return d
  }
  test('text and grown box are one revision/history entry; Undo and Redo restore both', () => {
    const d = fixed(), revision = d.document_revision
    app.getState().startEdit('child', 'title'); app.getState().updateDraft('Tiêu đề tiếng Việt dài nhiều dòng 😀')
    expect(app.getState().commitEdit()).toBe(true)
    const s = app.getState(), changed = s.doc!.topics[1]
    expect(changed.style.box_style!.height_world!).toBeGreaterThan(32)
    expect(s.doc!.document_revision).toBe(revision + 1); expect(s.past.length).toBe(1)
    expect(s.editor).toBeNull()
    s.undo(); expect(app.getState().doc!.topics).toEqual(d.topics)
    app.getState().redo(); expect(app.getState().doc!.topics[1]).toEqual(changed)
  })
  test('over-limit commit keeps document, draft and journal; selection/tab/editor cannot replace it', async () => {
    const d = fixed(); const text = Array(100).fill('Dòng tiếng Việt').join('\n')
    app.getState().startEdit('child', 'title'); app.getState().updateDraft(text)
    expect(app.getState().commitEdit()).toBe(false)
    expect(app.getState().doc).toEqual(d); expect(app.getState().past).toHaveLength(0)
    expect(app.getState().editor!.draft).toBe(text)
    await withStorageWrite(() => expect(JSON.parse(memory.get(K.journal(d.project_id))!).draft_text).toBe(text))
    app.getState().setSelection([d.central_topic_id]); expect(app.getState().selection).toEqual([])
    const inspector = app.getState().inspectorOpen
    app.getState().setInspector(!inspector, 'box'); expect(app.getState().inspectorOpen).toBe(inspector)
    app.getState().startEdit(d.central_topic_id, 'title'); expect(app.getState().editor!.nodeId).toBe('child')
    app.getState().cancelEdit(); expect(app.getState().doc).toEqual(d)
    await withStorageWrite(() => expect(memory.has(K.journal(d.project_id))).toBe(false))
  })
  test('Save and continue stops if Fixed validation rejects the draft', async () => {
    const d = fixed(); app.getState().startEdit('child', 'title'); app.getState().updateDraft(Array(100).fill('Dòng').join('\n'))
    const switching = app.getState().createProject('Other')
    await app.getState().chooseLeave('save')
    expect(await switching).toBe(false); expect(app.getState().doc).toEqual(d)
    expect(app.getState().editor!.nodeId).toBe('child'); expect(app.getState().transitionBusy).toBe(false)
  })
  test('old undersized data renders and exports with effective bounds without being rewritten', async () => {
    const { buildScene, sceneToSVG } = await import('../lib/scene/scene')
    const d = fixed(); d.topics[1].text = 'Một tiêu đề dài cần nhiều dòng để hiển thị đúng'
    const raw = JSON.stringify(d), scene = buildScene(d), n = scene.byId.get('child')!
    expect(n.box.h).toBeGreaterThan(32)
    expect(scene.bounds.y + scene.bounds.h).toBeGreaterThanOrEqual(n.textBounds.y + n.textBounds.h)
    expect(sceneToSVG(scene, { background: 'canvas', padding: 12 })).toContain('viewBox='); expect(JSON.stringify(d)).toBe(raw)
    expect(app.getState().past).toHaveLength(0)
  })
  test('unrelated changes and no-op do not normalize a legacy Fixed box', () => {
    const d = fixed(); d.topics[1].text = 'Old undersized legacy title'
    const box = structuredClone(d.topics[1].style.box_style)
    expect(app.getState().dispatch({ type: 'setProps', id: 'child', before: {}, after: { notes: 'Note only' } }, 'Notes')).toBe(true)
    expect(app.getState().doc!.topics[1].style.box_style).toEqual(box)
    const revision = app.getState().doc!.document_revision
    const length = app.getState().past.length
    expect(app.getState().dispatch({ type: 'setProps', id: 'child', before: {}, after: { notes: 'Note only' } }, 'No-op')).toBe(true)
    expect(app.getState().past).toHaveLength(length); expect(app.getState().doc!.document_revision).toBe(revision)
  })
})

test('UI03/UI09 placement clamps both edges in the same coordinate space', async () => {
  const { placeOverlay } = await import('../lib/scene/overlay')
  expect(placeOverlay(990, 630, 224, 130, 1024, 640)).toEqual({ left: 792, top: 502 })
  expect(placeOverlay(-40, -80, 224, 130, 1024, 640)).toEqual({ left: 8, top: 8 })
})

test('UI07 wrap splits a long word after an earlier line and keeps emoji graphemes intact', async () => {
  const { layoutTextBlock } = await import('../lib/scene/text')
  const { resolveStyle } = await import('../lib/core/style')
  const doc = app.getState().doc!, style = resolveStyle(doc, doc.topics[1]).text
  const b = layoutTextBlock('Đầu câu Rấtdàikhôngcókhoảngtrắng 👨‍👩‍👧‍👦', { ...style, wrap: true }, 80)
  expect(b.lines.every(l => l.width <= 80 || l.text === '👨‍👩‍👧‍👦')).toBe(true)
  expect(b.lines.some(l => l.text.includes('👨‍👩‍👧‍👦'))).toBe(true)
})

test('UI07 wrapping a word does not insert whitespace-only extra lines', async () => {
  const { layoutTextBlock } = await import('../lib/scene/text')
  const { resolveStyle } = await import('../lib/core/style')
  const d = app.getState().doc!, style = resolveStyle(d, d.topics[1]).text
  const block = layoutTextBlock('Z abcdefghij klmnopqr', { ...style, wrap: true }, 16)
  expect(block.lines.every(l => !!l.text.trim())).toBe(true)
  expect(block.lines.map(l => l.text).join('').replace(/\s/g, '')).toBe('Zabcdefghijklmnopqr')
})

/* ===== Audit fixes 2026-11-11 (B02/B03/B06/B07/B08/B09/B10/B12) ===== */
import { applyCommand, cmdBuilders } from '../lib/core/commands'
import { childrenOf, getTopic } from '../lib/core/tree'
import { outlineToTopics } from '../lib/io/importers'
import { analyzeExport, exportJSON, exportMarkdown, exportScopeError } from '../lib/io/exporters'

function exportOpts(over: Record<string, unknown> = {}) {
  return {
    format: 'json' as const, scope: 'entire' as const, scopeRootId: null, visibility: 'includeCollapsed' as const,
    includeDrawings: true, excludedDrawingIds: [], background: 'canvas' as const, autoFit: true,
    paddingPercent: 'auto' as const, pngScale: 2 as const, pdfPaper: 'content' as const,
    pdfOrientation: 'landscape' as const, pdfMode: 'onepage' as const, fileName: 'x', ...over,
  }
}
function docA() {
  const d = newProjectDoc('T')
  const c = d.central_topic_id
  d.topics.push(
    newTopic({ id: 'A', text: 'A', parent_id: c, order: 0 }),
    newTopic({ id: 'B', text: 'B', parent_id: c, order: 1 }),
    newTopic({ id: 'A1', text: 'A1', parent_id: 'A', order: 0 }),
  )
  return d
}
function canvasMock() {
  Object.assign(document, { createElement: () => ({ getContext: () => ({
    font: '', save() {}, restore() {}, textAlign: 'center', textBaseline: 'alphabetic',
    measureText(text: string) { const width = Array.from(text).length * 8; return { width, actualBoundingBoxLeft: width / 2, actualBoundingBoxRight: width / 2, actualBoundingBoxAscent: 13, actualBoundingBoxDescent: 4 } },
  }) }) })
}

describe('audit fixes 2026-11-11', () => {
  test('promote inserts immediately after the old parent (A,A1,B)', () => {
    const d = docA()
    const r = applyCommand(d, cmdBuilders.promote(d, 'A1')!)
    expect(r.ok).toBe(true)
    expect(childrenOf(d, d.central_topic_id).map((t) => t.text)).toEqual(['A', 'A1', 'B'])
    expect(childrenOf(d, d.central_topic_id).map((t) => t.order)).toEqual([0, 1, 2])
    expect(getTopic(d, 'A1')!.parent_id).toBe(d.central_topic_id)
  })

  test('promote keeps order for middle and last parents', () => {
    const d = docA()
    d.topics.push(newTopic({ id: 'C', text: 'C', parent_id: d.central_topic_id, order: 2 }), newTopic({ id: 'C1', text: 'C1', parent_id: 'C', order: 0 }))
    applyCommand(d, cmdBuilders.promote(d, 'C1')!)
    expect(childrenOf(d, d.central_topic_id).map((t) => t.text)).toEqual(['A', 'B', 'C', 'C1'])
    const d2 = docA()
    d2.topics.push(newTopic({ id: 'C', text: 'C', parent_id: d2.central_topic_id, order: 2 }))
    applyCommand(d2, cmdBuilders.promote(d2, 'A1')!)
    expect(childrenOf(d2, d2.central_topic_id).map((t) => t.text)).toEqual(['A', 'A1', 'B', 'C'])
  })

  test('batch edit supports notes and rejects stale before-values', () => {
    const d = docA(); const a = getTopic(d, 'A')!; a.notes = 'Beta'; a.text = 'Alpha'
    const r = applyCommand(d, { type: 'batchEditText', edits: [
      { id: 'A', field: 'title', before: 'Alpha', after: 'Alpha2' },
      { id: 'A', field: 'notes', before: 'Beta', after: 'Beta2' },
    ] })
    expect(r.ok).toBe(true); expect(a.text).toBe('Alpha2'); expect(a.notes).toBe('Beta2')
    const d2 = docA(); const a2 = getTopic(d2, 'A')!; a2.notes = 'Beta'
    const r2 = applyCommand(d2, { type: 'batchEditText', edits: [{ id: 'A', field: 'notes', before: 'Wrong', after: 'X' }] })
    expect(r2.ok).toBe(false); expect(a2.notes).toBe('Beta')
  })

  test('branch export rejects missing/stale scope and never falls back to whole map', () => {
    const d = docA()
    expect(exportScopeError(d, { scope: 'branch', scopeRootId: null })).toContain('Chưa chọn')
    expect(exportScopeError(d, { scope: 'branch', scopeRootId: 'missing' })).toContain('không còn tồn tại')
    expect(() => exportJSON(d, exportOpts({ scope: 'branch', scopeRootId: null }))).toThrow()
    expect(() => exportMarkdown(d, exportOpts({ scope: 'branch', scopeRootId: 'missing' }))).toThrow()
    expect(() => analyzeExport(d, exportOpts({ scope: 'branch', scopeRootId: 'missing' }))).toThrow()
    const valid = JSON.parse(exportJSON(d, exportOpts({ scope: 'branch', scopeRootId: 'A' })))
    expect(valid.topics.map((t: { text: string }) => t.text).sort()).toEqual(['A', 'A1'])
  })

  test('a project transition clears the previous export session', async () => {
    const oldId = app.getState().doc!.project_id
    app.getState().openExport('child')
    expect(app.getState().exportOpen?.scopeRootId).toBe('child')
    expect(await app.getState().createProject('Other')).toBe(true)
    expect(app.getState().doc!.project_id).not.toBe(oldId)
    expect(app.getState().exportOpen).toBeNull()
    app.getState().openExport()
    expect(await app.getState().closeProject()).toBe(true)
    expect(app.getState().exportOpen).toBeNull()
  })

  test('exporting the Central branch excludes floating roots and unrelated drawings', () => {
    canvasMock()
    const d = docA()
    d.layout.kind = 'freeform'
    d.topics.push(newTopic({ id: 'floating', text: 'Separate branch', role: 'floating', manual_position: { x: 10000, y: 10000 } }))
    const opts = exportOpts({ scope: 'branch', scopeRootId: d.central_topic_id })
    const b = analyzeExport(d, opts).scene.byId.get(d.central_topic_id)!.box
    const drawing = { kind: 'line' as const, color: '#000000', width_world: 2, opacity: 1, layer_order: 0 }
    d.drawings = [
      { ...drawing, id: 'near', points: [{ x: b.x, y: b.y }, { x: b.x + 10, y: b.y + 10 }] },
      { ...drawing, id: 'far', points: [{ x: 10000, y: 10000 }, { x: 10100, y: 10100 }] },
    ]
    const scene = analyzeExport(d, opts).scene
    expect(scene.nodes.map(n => n.id).sort()).toEqual([d.central_topic_id, 'A', 'B', 'A1'].sort())
    expect(scene.drawings.map(({ obj }) => obj.id)).toEqual(['near'])
    expect(JSON.parse(exportJSON(d, opts)).drawings).toEqual([d.drawings[0]])
    expect(JSON.parse(exportJSON(d, { ...opts, excludedDrawingIds: ['near'] })).drawings).toEqual([])
    expect(JSON.parse(exportJSON(d, exportOpts()))).toEqual(d)
    expect(analyzeExport(d, exportOpts()).scene.byId.has('floating')).toBe(true)
  })

  test('empty outline/TXT is rejected before project creation', () => {
    expect(() => buildImportPreview('empty.txt', '   \n\t', null)).toThrow('không có chủ đề')
    expect(() => buildImportPreview('empty.md', '   \n\t', null)).toThrow('không có chủ đề')
    expect(buildImportPreview('plain.md', 'Nội dung không có heading', null).nodeCount).toBe(1)
    expect(() => outlineToTopics([])).toThrow()
  })

  test('paragraph gap only applies between manual paragraphs', async () => {
    const { layoutTextBlock } = await import('../lib/scene/text')
    const { resolveStyle } = await import('../lib/core/style')
    const d = app.getState().doc!, style = resolveStyle(d, d.topics[1]).text
    const b = layoutTextBlock('A\nB\nC', { ...style, wrap: true, paragraphGap: 30 }, 200)
    const lineH = b.lineH
    expect(b.lineY[1] - b.lineY[0]).toBeCloseTo(lineH + 30, 5)
    expect(b.lineY[2] - b.lineY[1]).toBeCloseTo(lineH + 30, 5)
    const wrapped = layoutTextBlock('aaaa aaaa aaaa aaaa\nB', { ...style, wrap: true, paragraphGap: 30 }, 45)
    expect(wrapped.lines.length).toBeGreaterThan(1)
    const last = wrapped.lineY.length - 1
    expect(wrapped.lineY[last] - wrapped.lineY[last - 1]).toBeCloseTo(lineH + 30, 5)
    // Wrapped lines inside the same paragraph must not receive paragraphGap.
    for (let i = 1; i < wrapped.lines.length - 1; i++) expect(wrapped.lineY[i] - wrapped.lineY[i - 1]).toBeCloseTo(lineH, 5)
  })

  test('vertical align changes fixed-height text placement', async () => {
    canvasMock()
    const { buildScene } = await import('../lib/scene/scene')
    const d = docA(); const a = getTopic(d, 'A')!
    a.style.box_style = { size_mode: 'fixed', width_world: 240, height_world: 180 }
    a.style.text = { vertical_align: 'top' }
    const top = buildScene(d).byId.get('A')!.textArea.y
    a.style.text = { vertical_align: 'bottom' }
    const bottom = buildScene(d).byId.get('A')!.textArea.y
    expect(bottom).toBeGreaterThan(top + 100)
  })

  test('cover image uses slice crop geometry while contain keeps aspect box', async () => {
    canvasMock()
    const { buildScene } = await import('../lib/scene/scene')
    const d = docA(); const a = getTopic(d, 'A')!
    d.assets.push({ id: 'img', mime: 'image/png', width: 60, height: 200, hash: 'h', data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' })
    a.image = { asset_id: 'img', fit: 'cover', placement: 'right', width_fraction: 0.5 }
    const cover = buildScene(d).byId.get('A')!.image!
    expect(cover.fit).toBe('cover'); expect(cover.w).toBe(120); expect(cover.h).toBe(160)
    a.image.fit = 'contain'
    const contain = buildScene(d).byId.get('A')!.image!
    expect(contain.fit).toBe('contain'); expect(contain.w).toBe(48); expect(contain.h).toBe(160)
  })

  test('deleteOnly publishes the new document and parent selection together', () => {
    const d = app.getState().doc!
    app.setState({ selection: ['child'] })
    const seen: string[][] = []
    const unsubscribe = app.subscribe(state => { if (!getTopic(state.doc!, 'child')) seen.push(state.selection) })
    try {
      expect(app.getState().dispatch({ type: 'deleteOnly', id: 'child' }, 'Xóa node')).toBe(true)
      expect(seen.length).toBeGreaterThan(0)
      for (const selection of seen) expect(selection).toEqual([d.central_topic_id])
    } finally { unsubscribe() }
  })

  test('a rejected replacement leaves the whole batch unchanged', () => {
    for (const edit of [{ id: 'B', before: 'stale', after: 'new' }, { id: 'B', before: 'B', after: '   ' }]) {
      const d = docA()
      const before = structuredClone(d)
      expect(applyCommand(d, { type: 'batchEditText', edits: [{ id: 'A', before: 'A', after: 'new' }, edit] }).ok).toBe(false)
      expect(d).toEqual(before)
    }
  })

  test('Fixed Cover respects the available area in all four image positions', async () => {
    canvasMock()
    const { buildScene } = await import('../lib/scene/scene')
    const d = docA()
    const a = getTopic(d, 'A')!
    a.style.box_style = { size_mode: 'fixed', width_world: 120, height_world: 100 }
    d.assets.push({ id: 'img', mime: 'image/png', width: 60, height: 200, hash: 'h', data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' })
    for (const placement of ['left', 'right', 'above', 'below'] as const) {
      a.image = { asset_id: 'img', fit: 'cover', placement, width_fraction: 1 }
      const n = buildScene(d).byId.get(a.id)!
      expect(n.box.w).toBe(120)
      expect(n.box.h).toBe(100)
      expect(n.image!.w).toBeGreaterThan(0)
      expect(n.image!.h).toBeGreaterThan(0)
      expect(n.image!.h / n.image!.w).not.toBeCloseTo(200 / 60, 2)
    }
  })
})

test('trash retries a reserved original ID after a failed document or metadata write', async () => {
  const doc = app.getState().doc!
  const id = doc.project_id
  memory.delete(K.project(id))
  const snapshot = pushTrash(doc)
  failKey = K.project(id)
  expect(await app.getState().restoreTrash(snapshot)).toBe(false)
  expect(trashList()[0].restoreId).toBe(id)
  expect(trashList()[0].restorePrepared).toBeUndefined()
  expect(memory.has(K.project(id))).toBe(false)

  failKey = K.registry
  expect(await app.getState().restoreTrash(snapshot)).toBe(false)
  const prepared = trashList()[0]
  expect(prepared.restorePrepared).toBe(true)
  expect(memory.get(K.project(id))).toBe(JSON.stringify(doc))
  expect(memory.get(K.registry)).toBe('[]')

  failKey = ''
  expect(await app.getState().restoreTrash(snapshot)).toBe(true)
  expect(JSON.parse(memory.get(K.registry)!)[0].storageEpoch).toBe(prepared.restoreEpoch)
  expect(trashList()).toEqual([])
})

test('a published trash restore can be retired without changing the edited live document', async () => {
  const doc = app.getState().doc!
  const id = doc.project_id
  memory.delete(K.project(id))
  const snapshot = pushTrash(doc)
  const write = localStorage.setItem
  localStorage.setItem = (key, value) => {
    if (key === K.trash && value === '[]') throw new Error('TEST_TRASH_FINALIZE')
    write(key, value)
  }
  try { expect(await app.getState().restoreTrash(snapshot)).toBe(false) }
  finally { localStorage.setItem = write }
  const current = loadProject(id)!
  current.topics[1].text = 'Edited after publication'
  expect((await persistProject(current, memory.get(K.project(id))!)).kind).toBe('saved')
  const raw = memory.get(K.project(id))
  const registry = memory.get(K.registry)
  expect(await app.getState().restoreTrash(snapshot)).toBe(true)
  expect(memory.get(K.project(id))).toBe(raw)
  expect(memory.get(K.registry)).toBe(registry)
  expect(trashList()).toEqual([])
})

for (const keepOriginal of [false, true]) {
  test('moving a published restore back to trash retires its prior snapshot, copy=' + keepOriginal, async () => {
    const doc = app.getState().doc!
    const id = doc.project_id
    if (!keepOriginal) memory.delete(K.project(id))
    const snapshot = pushTrash(doc)
    const write = localStorage.setItem
    localStorage.setItem = (key, value) => {
      if (key === K.trash && value === '[]') throw new Error('TEST_TRASH_FINALIZE')
      write(key, value)
    }
    try { expect(await app.getState().restoreTrash(snapshot)).toBe(false) }
    finally { localStorage.setItem = write }
    const restored = trashList()[0]
    const restoreId = restored.restoreId!
    expect(restoreId === id).toBe(!keepOriginal)
    const current = loadProject(restoreId)!
    current.topics[1].text = 'Fresh snapshot'
    expect((await persistProject(current, memory.get(K.project(restoreId))!)).kind).toBe('saved')
    // Simulate closing the active editor before issuing the sidebar delete.
    app.setState({ doc: null, generation: app.getState().generation + 1, saveStatus: 'none', persistedRaw: null })
    app.getState().deleteProject(restoreId)
    expect(await app.getState().confirm?.onOk()).toBe(true)
    expect(trashList()).toHaveLength(1)
    const next = trashList()[0]
    expect(next.id).toBe(restoreId)
    expect(next.deletionId).not.toBe(snapshot.deletionId)
    expect(next.doc.topics[1].text).toBe('Fresh snapshot')
    expect(await app.getState().restoreTrash(snapshot)).toBe(false)
    expect(await app.getState().purgeTrash(next)).toBe(true)
    expect(await app.getState().restoreTrash(restored)).toBe(false)
    expect(memory.has(K.project(restoreId))).toBe(false)
    expect(memory.has(K.project(id))).toBe(keepOriginal)
  })
}

test('a missing candidate after restore preparation is not recreated from a stale snapshot', async () => {
  const doc = app.getState().doc!
  memory.delete(K.project(doc.project_id))
  const snapshot = pushTrash(doc)
  failKey = K.registry
  expect(await app.getState().restoreTrash(snapshot)).toBe(false)
  expect(trashList()[0].restorePrepared).toBe(true)
  memory.delete(K.project(doc.project_id))
  failKey = ''
  expect(await app.getState().restoreTrash(snapshot)).toBe(false)
  expect(memory.has(K.project(doc.project_id))).toBe(false)
  expect(trashList()).toHaveLength(1)
})

test('restoring a partial deletion keeps the original ID and prevents stale writes before publication', async () => {
  const doc = app.getState().doc!
  const id = doc.project_id
  const original = memory.get(K.project(id))!
  const legacyMeta = { ...metaFromDoc(doc), storageEpoch: undefined }
  memory.set(K.registry, JSON.stringify([legacyMeta]))
  app.setState({ registry: [legacyMeta] })
  const journal = '{"unrelatedDraft":true}'
  const backup = JSON.stringify([{ rev: doc.document_revision, json: original }])
  memory.set(K.journal(id), journal)
  memory.set(K.backup(id), backup)
  failKey = K.registry
  app.getState().deleteProject(id)
  expect(await app.getState().confirm?.onOk()).toBe(false)
  expect(memory.has(K.project(id))).toBe(false)
  expect(trashList()[0].sourceStorageEpoch).toBeNull()
  expect(JSON.parse(memory.get(K.registry)!)[0].id).toBe(id)

  failKey = ''
  const snapshot = trashList()[0]
  const write = localStorage.setItem
  localStorage.setItem = (key, value) => {
    if (key === K.registry && JSON.parse(value).some((meta: { id: string }) => meta.id === id)) {
      throw new Error('TEST_PUBLISH_FAILURE')
    }
    write(key, value)
  }
  try { expect(await app.getState().restoreTrash(snapshot)).toBe(false) }
  finally { localStorage.setItem = write }
  expect(memory.get(K.project(id))).toBe(original)
  expect(memory.get(K.registry)).toBe('[]')
  expect(trashList()[0].restorePrepared).toBe(true)
  expect((await persistProject(doc, original, { identity: { storageEpoch: undefined } })).kind).toBe('conflict')
  expect(await app.getState().renameStoredProject(id, 'Stale rename')).toBe(false)
  const oldState = app.getState()
  app.setState({ doc: null, generation: oldState.generation + 1, saveStatus: 'none' })
  expect(await app.getState().openProject(id)).toBe(false)
  expect(memory.get(K.project(id))).toBe(original)
  expect(memory.get(K.journal(id))).toBe(journal)

  expect(await app.getState().restoreTrash(snapshot)).toBe(true)
  expect(trashList()).toHaveLength(0)
  const registry = JSON.parse(memory.get(K.registry)!)
  expect(registry).toHaveLength(1)
  expect(registry[0].id).toBe(id)
  expect(typeof registry[0].storageEpoch).toBe('string')
  expect(memory.get(K.backup(id))).toBe(backup)
  expect(await app.getState().openProject(id)).toBe(true)
})

test('restore cannot claim an orphan metadata row from a different epoch', async () => {
  const doc = app.getState().doc!
  const id = doc.project_id
  const current = metaFromDoc(doc)
  memory.set(K.registry, JSON.stringify([current]))
  memory.delete(K.project(id))
  const snapshot = pushTrash(doc, [], 'different-epoch')
  expect(await app.getState().restoreTrash(snapshot)).toBe(false)
  expect(memory.has(K.project(id))).toBe(false)
  expect(memory.get(K.registry)).toBe(JSON.stringify([current]))
  expect(trashList()).toEqual([snapshot])
})

test('opening an older formatted document leaves its bytes intact and it can still be moved to trash', async () => {
  const doc = app.getState().doc!
  const id = doc.project_id
  const raw = JSON.stringify(doc, null, 2)
  memory.set(K.project(id), raw)
  const metadata = { ...metaFromDoc(doc), storageEpoch: undefined }
  memory.set(K.registry, JSON.stringify([metadata]))
  app.setState({ doc: null, persistedRaw: null, saveStatus: 'none', registry: [metadata] })
  expect(await app.getState().openProject(id)).toBe(true)
  expect(memory.get(K.project(id))).toBe(raw)
  app.getState().deleteProject(id)
  expect(await app.getState().confirm?.onOk()).toBe(true)
  expect(memory.has(K.project(id))).toBe(false)
  expect(trashList()[0].doc).toEqual(doc)
})

test('an explicit purge can remove a failed restore reservation if no document was written', async () => {
  const doc = app.getState().doc!
  const id = doc.project_id
  memory.delete(K.project(id))
  const snapshot = pushTrash(doc)
  failKey = K.project(id)
  expect(await app.getState().restoreTrash(snapshot)).toBe(false)
  expect(trashList()[0].restoreId).toBe(id)
  failKey = ''
  expect(await app.getState().purgeTrash(snapshot)).toBe(true)
  expect(await app.getState().restoreTrash(snapshot)).toBe(false)
  expect(trashList()).toHaveLength(0)
  expect(memory.has(K.project(id))).toBe(false)
})

test('trash capacity retains pending restores and verifies every retained marker before removing the source', async () => {
  const source = app.getState().doc!
  const originalRaw = memory.get(K.project(source.project_id))
  app.setState({ doc: null, persistedRaw: null, saveStatus: 'none' })
  const pending = pushTrash(newProjectDoc('Unpublished restore'))
  failKey = K.registry
  expect(await app.getState().restoreTrash(pending)).toBe(false)
  failKey = ''
  const reserved = trashList()[0]
  expect(reserved.restorePrepared).toBe(true)
  const oldestOrdinary = pushTrash(newProjectDoc('Oldest completed deletion'))
  for (let i = 0; i < 48; i++) pushTrash(newProjectDoc('Deleted project ' + i))

  const previous = memory.get(K.trash)!
  const write = localStorage.setItem
  localStorage.setItem = (key, value) => {
    const entries = key === K.trash ? JSON.parse(value) as typeof reserved[] : []
    if (entries[0]?.id === source.project_id) {
      write(key, JSON.stringify(entries.filter(entry => entry.id !== pending.id)))
    } else {
      write(key, value)
    }
  }
  app.getState().deleteProject(source.project_id)
  try { expect(await app.getState().confirm?.onOk()).toBe(false) }
  finally { localStorage.setItem = write }
  expect(memory.get(K.project(source.project_id))).toBe(originalRaw)
  expect(memory.get(K.trash)).toBe(previous)

  expect(await app.getState().confirm?.onOk()).toBe(true)
  const result = trashList()
  expect(result).toHaveLength(50)
  expect(result[0].id).toBe(source.project_id)
  expect(result.find(entry => entry.id === pending.id)).toEqual(reserved)
  expect(result.some(entry => entry.id === oldestOrdinary.id)).toBe(false)
  expect(await app.getState().restoreTrash(reserved)).toBe(true)
  expect(loadProject(pending.id)?.project_id).toBe(pending.id)
})

test('trash capacity refuses a new deletion when all 50 entries require protection', async () => {
  const source = app.getState().doc!
  const raw = memory.get(K.project(source.project_id))
  const metadata = metaFromDoc(source)
  memory.set(K.registry, JSON.stringify([metadata]))
  app.setState({ registry: [metadata] })
  const items = Array.from({ length: 50 }, (_, index) => {
    const doc = newProjectDoc('Incomplete restore ' + index)
    return { id: doc.project_id, doc, name: doc.name, deletedAt: doc.updated_at,
      restoreId: doc.project_id, restoreEpoch: 'reservation-' + index }
  })
  const before = JSON.stringify(items)
  memory.set(K.trash, before)
  app.getState().deleteProject(source.project_id)
  expect(await app.getState().confirm?.onOk()).toBe(false)
  expect(memory.get(K.project(source.project_id))).toBe(raw)
  expect(memory.get(K.trash)).toBe(before)
  expect(memory.get(K.registry)).toBe(JSON.stringify([metadata]))
  expect(app.getState().saveStatus).toBe('clean')
  expect(app.getState().saveError).toBeNull()
  expect(app.getState().doc).toBe(source)
  const close = app.getState().closeProject()
  const prompted = app.getState().leavePrompt !== null
  if (prompted) await app.getState().chooseLeave('cancel')
  expect(prompted).toBe(false)
  expect(await close).toBe(true)
})

test('a rejected deletion reports a same-epoch external document change as a conflict', async () => {
  const original = app.getState().doc!
  const id = original.project_id
  const metadata = metaFromDoc(original)
  const registryRaw = JSON.stringify([metadata])
  memory.set(K.registry, registryRaw)
  app.setState({ registry: [metadata] })
  app.getState().deleteProject(id)
  const externalRaw = JSON.stringify({ ...original, name: 'Other tab title' })
  memory.set(K.project(id), externalRaw)

  expect(await app.getState().confirm?.onOk()).toBe(false)
  expect(app.getState().saveStatus).toBe('conflict')
  expect(app.getState().doc).toBe(original)
  expect(memory.get(K.project(id))).toBe(externalRaw)
  expect(memory.get(K.registry)).toBe(registryRaw)
  expect(memory.get(K.trash)).toBeUndefined()
})

test('trash write lock timeout preserves a clean document', async () => {
  const source = app.getState().doc!
  const raw = app.getState().persistedRaw
  const metadata = metaFromDoc(source)
  memory.set(K.registry, JSON.stringify([metadata]))
  app.setState({ registry: [metadata] })
  app.getState().deleteProject(source.project_id)
  const locks = navigator.locks
  const request = locks.request
  locks.request = ((_name: string, options: LockOptions) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
  })) as LockManager['request']
  try {
    expect(await app.getState().confirm?.onOk()).toBe(false)
    expect(app.getState().saveStatus).toBe('clean')
    expect(app.getState().saveError).toBeNull()
    expect(app.getState().doc).toBe(source)
    expect(memory.get(K.project(source.project_id))).toBe(raw)
    expect(memory.get(K.trash)).toBeUndefined()
    expect(app.getState().toasts.at(-1)).toMatchObject({
      text: 'Chuyển vào thùng rác thất bại',
      detail: expect.stringContaining('Hết thời gian chờ khóa ghi'),
    })
  } finally {
    locks.request = request
  }
}, 7000)

test.each(['same tab', 'settings write failure', 'settings read-back failure', 'other tab', 'same-byte restore'])('legacy sidebar rename after epoch assignment by %s', async (scenario) => {
  const source = newProjectDoc('Legacy project')
  const id = source.project_id
  const raw = JSON.stringify(source)
  const meta = { ...metaFromDoc(source), storageEpoch: undefined }
  memory.set(K.project(id), raw)
  memory.set(K.registry, JSON.stringify([meta]))
  app.setState({ registry: [meta] })
  const target = captureProjectRenameTarget(meta)
  expect(target.legacy).toEqual({ raw, generation: app.getState().generation })

  if (scenario.startsWith('settings')) {
    const before = app.getState()
    const read = localStorage.getItem
    try {
      if (scenario === 'settings write failure') failKey = K.settings
      else {
        localStorage.getItem = key => {
          const value = read(key)
          if (key === K.settings && JSON.parse(value ?? '{}').lastProjectId === id) return null
          return value
        }
      }
      expect(await app.getState().openProject(id)).toBe(false)
    } finally {
      failKey = ''
      localStorage.getItem = read
    }
    const assigned = JSON.parse(memory.get(K.registry)!)[0].storageEpoch
    expect(assigned).toBeString()
    expect(await app.getState().renameStoredProject(id, 'Blocked before retry', target)).toBe(false)
    expect(app.getState().doc).toBe(before.doc)
    expect(app.getState().past).toBe(before.past)
    expect(app.getState().future).toBe(before.future)
    expect(memory.get(K.project(id))).toBe(raw)
  } else if (scenario === 'other tab') {
    memory.set(K.registry, JSON.stringify([{ ...meta, storageEpoch: 'other-tab-epoch' }]))
  } else if (scenario === 'same-byte restore') {
    app.getState().deleteProject(id)
    expect(await app.getState().confirm?.onOk()).toBe(true)
    expect(await app.getState().restoreTrash(trashList()[0])).toBe(true)
    expect(memory.get(K.project(id))).toBe(raw)
  }

  expect(await app.getState().openProject(id)).toBe(true)
  const before = app.getState()
  expect(before.doc?.name).toBe(source.name)
  const renamed = await app.getState().renameStoredProject(id, 'New title', target)
  if (scenario === 'same tab') {
    expect(renamed).toBe(true)
    expect(app.getState().doc?.name).toBe('New title')
    expect(app.getState().past).toHaveLength(1)
    app.getState().undo()
    expect(app.getState().doc?.name).toBe(source.name)
    app.getState().redo()
    expect(app.getState().doc?.name).toBe('New title')
  } else {
    expect(renamed).toBe(false)
    expect(app.getState().doc).toBe(before.doc)
    expect(app.getState().past).toBe(before.past)
    expect(app.getState().future).toBe(before.future)
  }
  expect(memory.get(K.project(id))).toBe(raw)
})

test('sidebar rename revalidates its epoch before choosing either the store or the newly opened editor', async () => {
  const source = newProjectDoc('Before restore')
  const id = source.project_id
  const initial = app.getState()
  const old = metaFromDoc(source)
  const raw = JSON.stringify(source)
  memory.set(K.project(id), raw)
  memory.set(K.registry, JSON.stringify([old]))
  app.setState({ registry: [old] })
  app.getState().deleteProject(id)
  expect(await app.getState().confirm?.onOk()).toBe(true)
  const snapshot = trashList()[0]
  failKey = K.registry
  expect(await app.getState().restoreTrash(snapshot)).toBe(false)
  failKey = ''

  let release!: () => void
  let locked!: () => void
  const acquired = new Promise<void>(resolve => { locked = resolve })
  const hold = withStorageWrite(() => new Promise<void>(resolve => { release = resolve; locked() }))
  await acquired
  const restore = app.getState().restoreTrash(snapshot)
  const renameClosed = app.getState().renameStoredProject(id, 'Stale closed title', old)
  const open = app.getState().openProject(id)
  const renameAfterOpen = app.getState().renameStoredProject(id, 'Stale active title', old)
  release()
  await hold
  expect(await restore).toBe(true)
  expect(await renameClosed).toBe(false)
  expect(await open).toBe(true)
  expect(await renameAfterOpen).toBe(false)
  expect(app.getState().doc?.name).toBe(source.name)
  expect(app.getState().past).toHaveLength(0)
  expect(memory.get(K.project(id))).toBe(raw)
  const current = app.getState().registry.find(entry => entry.id === id)!
  expect(current.storageEpoch).not.toBe(old.storageEpoch)
  expect(await app.getState().renameStoredProject(id, 'New active title', current)).toBe(true)
  expect(app.getState().doc?.name).toBe('New active title')
  expect(memory.get(K.project(id))).toBe(raw)
  app.getState().undo()
  expect(app.getState().doc?.name).toBe(source.name)
  app.setState({ doc: initial.doc, persistedRaw: initial.persistedRaw, generation: initial.generation + 10 })
  expect(await app.getState().renameStoredProject(id, 'New stored title', current)).toBe(true)
  expect(loadProject(id)?.name).toBe('New stored title')
})
