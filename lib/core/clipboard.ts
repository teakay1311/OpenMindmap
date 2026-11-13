import { Asset, Crosslink, ProjectDocV3, Topic, uuid } from './types'
import { descendantsOf, getTopic } from './tree'
import { Command } from './commands'

export interface BranchClipboard { topics: Topic[]; rootId: string; assets: Asset[]; crosslinks?: Crosslink[] }

export function copyBranch(doc: ProjectDocV3, rootId: string): BranchClipboard | null {
  const root = getTopic(doc, rootId)
  if (!root) return null
  const topics = structuredClone([root, ...descendantsOf(doc, rootId)])
  const assets = structuredClone(doc.assets.filter(a => topics.some(t => t.image?.asset_id === a.id)))
  const ids = new Set(topics.map(t => t.id))
  const crosslinks = structuredClone(doc.crosslinks.filter(c => ids.has(c.source) && ids.has(c.target)))
  return { topics, rootId, assets, crosslinks }
}

export function pasteBranch(doc: ProjectDocV3, clip: BranchClipboard, parentId: string, position?: { x: number; y: number }): Command {
  if (!getTopic(doc, parentId)) throw new Error('Node đích không tồn tại')
  const idMap = new Map(clip.topics.map(t => [t.id, uuid()]))
  const assetMap = new Map<string, string>()
  const assets: Asset[] = []
  for (const asset of clip.assets ?? []) {
    const existing = doc.assets.find(a => a.id === asset.id)
    const identical = existing && existing.mime === asset.mime && existing.width === asset.width && existing.height === asset.height && existing.data_url === asset.data_url
    const id = existing && !identical ? uuid() : asset.id
    assetMap.set(asset.id, id)
    if (!identical) assets.push({ ...structuredClone(asset), id })
  }
  const topics = clip.topics.map(t => {
    const root = t.id === clip.rootId
    if (t.image && !assetMap.has(t.image.asset_id)) throw new Error('Clipboard thiếu dữ liệu ảnh. Hãy sao chép lại nhánh nguồn.')
    return { ...structuredClone(t), id: idMap.get(t.id)!, parent_id: root ? parentId : idMap.get(t.parent_id!) ?? parentId,
      role: 'normal' as const,
      image: t.image ? { ...t.image, asset_id: assetMap.get(t.image.asset_id)! } : t.image,
      manual_position: root && position ? { ...position } : t.manual_position ? { x: t.manual_position.x + 32, y: t.manual_position.y + 32 } : null }
  })
  const root = topics.find(t => t.id === idMap.get(clip.rootId))
  if (!root) throw new Error('Clipboard không có node gốc')
  const crosslinks = (clip.crosslinks ?? []).filter(c => idMap.has(c.source) && idMap.has(c.target)).map(c => ({
    ...c, id: uuid(), source: idMap.get(c.source)!, target: idMap.get(c.target)!,
  }))
  return { type: 'addSubtree', crosslinks, topics: [root, ...topics.filter(t => t !== root)], assets, rootParentId: parentId, rootIndex: null, focusEditor: false }
}
