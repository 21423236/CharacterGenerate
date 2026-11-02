import type { Project } from './api'

export type Step = 'design' | 'image' | 'parts' | 'models' | 'part-image' | 'part-sheet' | 'crop' | 'model' | 'rig'
export const characterSteps: { step: Step; label: string }[] = [
  { step: 'design', label: '角色设定' }, { step: 'image', label: '角色图片' },
  { step: 'parts', label: '部件拆分' }, { step: 'models', label: '部件建模' },
]
export const partSteps: { step: Step; label: string }[] = [
  { step: 'part-image', label: '独立部件图' }, { step: 'part-sheet', label: '部件三视图' },
  { step: 'crop', label: '裁切确认' }, { step: 'model', label: '生成模型' },
]
export const partKinds: Record<string, string> = {body:'基础身体',hair:'发型',top:'上衣',coat:'外套',bottom:'裤子／裙子',shoes:'鞋子（一双）',gloves:'手套（一双）',accessory:'大型配件'}
export const viewsReady = (p: Project) => ['front', p.side, 'back'].every(label => !!p.views[label])
export const partStatus = (p: Project) => p.rig ? '已绑定' : p.alignment ? '已对齐' : p.model ? '模型已完成' : viewsReady(p) ? '待建模' : p.sheet ? '待裁切确认' : p.part_image ? '待生成三视图' : '待提取部件图'
export function resumeStep(p: Project, projects: Project[]): Step {
  const saved = localStorage.getItem(`forge-step:${p.id}`) as Step | null
  const allowed: Step[] = p.parent_id ? [...partSteps.map(s => s.step), 'rig'] : [...characterSteps.map(s => s.step), 'crop', 'model', 'rig']
  if (saved && allowed.includes(saved)) return saved
  if (p.parent_id) return p.model ? 'model' : p.sheet ? 'crop' : p.part_image ? 'part-sheet' : 'part-image'
  return projects.some(part => part.parent_id === p.id) ? 'models' : p.sheet ? 'parts' : p.prompt ? 'image' : 'design'
}
