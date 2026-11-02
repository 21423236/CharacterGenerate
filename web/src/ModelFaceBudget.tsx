import { useEffect, useRef, useState } from 'react'
import { api, type Project, type Settings } from './api'

export default function ModelFaceBudget({ project, config, busy, changed, onDirty, error }: {
  project: Project; config?: Settings['tripo']; busy: boolean;
  changed: (project: Project) => void; onDirty: (dirty: boolean) => void; error: (e: unknown) => void;
}) {
  const saved = project.model_face_limit == null ? '' : String(project.model_face_limit)
  const [value, setValue] = useState(saved)
  const [saving, setSaving] = useState(false)
  const editing = useRef(false)
  const active = useRef(true)
  useEffect(() => { if (!editing.current) setValue(saved) }, [saved])
  useEffect(() => {
    active.current = true
    return () => { active.current = false; onDirty(false) }
  }, [onDirty])
  const studio = config?.mode !== 'api'
  const globalFaces = studio ? config?.studio_face_limit ?? 15000 : config?.face_limit ?? 50000
  const maximum = studio ? (config?.studio_topology === 'quad' && !project.split_model ? 25000 : 50000) : config?.model === 'tripo-p1' ? 20000 : config?.model === 'tripo-p2' ? 50000 : 150000
  const faces = value.trim() ? Number(value) : null
  const invalid = faces !== null && (!Number.isInteger(faces) || faces < 500 || faces > maximum)
  const dirty = value !== saved
  const edit = (next: string) => { setValue(next); editing.current = next !== saved; onDirty(next !== saved) }
  const save = async () => {
    if (invalid || saving || busy) return
    setSaving(true); onDirty(true)
    try {
      const fresh = await api<Project>(`/projects/${project.id}`, {method:'PATCH', body:JSON.stringify({model_face_limit:faces})})
      changed(fresh)
      if (active.current) { editing.current = false; setValue(fresh.model_face_limit == null ? '' : String(fresh.model_face_limit)); onDirty(false) }
    } catch (e) { error(e) } finally { if (active.current) setSaving(false) }
  }
  return <div className="model-face-budget">
    <label htmlFor="part-face-limit">当前部件面数 <span className="muted">· 可选，留空使用全局默认</span></label>
    <div className="row wrap"><input id="part-face-limit" type="number" min={500} max={maximum} step={1} value={value} placeholder={`全局默认：${globalFaces.toLocaleString()} 面`} disabled={busy || saving} onChange={e=>edit(e.target.value)}/><button className="button secondary" disabled={busy || saving || !dirty || invalid} onClick={()=>void save()}>{saving?'保存中…':'保存面数设置'}</button><button className="button ghost" disabled={busy || saving || !value} onClick={()=>edit('')}>使用全局默认</button></div>
    <p className="muted">{invalid ? `请输入 500–${maximum.toLocaleString()} 之间的整数。` : dirty ? '面数设置尚未保存，保存后再开始建模。' : project.model_face_limit == null ? `当前使用全局默认：${globalFaces.toLocaleString()} 面。` : `当前部件使用：${project.model_face_limit.toLocaleString()} 面。全局默认：${globalFaces.toLocaleString()} 面。`}</p>
  </div>
}
