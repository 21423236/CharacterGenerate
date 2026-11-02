import { useEffect, useState } from 'react'
import { api, post, type Project } from './api'
import { partKinds, partStatus } from './workflow'
import ZoomImage from './ZoomImage'

export default function PartsPanel({ project, projects, mode, busy, open, added, changed, remove, assemble, identify, next, image, rig, legacy, error }: {
  project: Project; projects: Project[]; mode: 'parts' | 'models'; busy: boolean;
  open: (p: Project) => void; added: (p: Project) => void; changed: (p: Project) => void;
  remove: (p: Project) => void; assemble: () => void; identify: () => void;
  next: () => void; image: () => void; rig: () => void; legacy: () => void; error: (e: unknown) => void;
}) {
  const [kind, setKind] = useState('hair')
  const [title, setTitle] = useState('')
  const [working, setWorking] = useState(false)
  const [folder, setFolder] = useState('')
  const parts = projects.filter(p => p.parent_id === project.id)
  const paired = new Set<string>()
  const suggestions = (project.part_suggestions || []).flatMap(s => {
    if (!['shoes', 'gloves'].includes(s.kind)) return [s]
    if (paired.has(s.kind)) return []
    paired.add(s.kind)
    return [{ ...s, title: partKinds[s.kind] }]
  }).filter(s => !parts.some(p => p.title === s.title))
  useEffect(() => {
    if (!parts.length) return
    let valid = true
    const timer = window.setInterval(() => {
      void api<Project[]>(`/projects/${project.id}/parts`).then(items => { if (valid) items.forEach(changed) }).catch(e => { if (valid) error(e) })
    }, 2000)
    return () => { valid = false; window.clearInterval(timer) }
  }, [project.id, parts.length, changed, error])
  const disabled = busy || working
  const perform = async (fn: () => Promise<void>) => { setWorking(true); try { await fn() } catch (e) { error(e) } finally { setWorking(false) } }
  const completed = parts.filter(p => p.model).length
  return <section className="panel parts-panel">
    <div className="section-title"><div><span className="eyebrow">{mode === 'parts' ? '03 / PLAN THE PARTS' : '04 / BUILD EACH PART'}</span><h2>{mode === 'parts' ? '确定角色的部件清单' : '逐个完成部件模型'}</h2></div><span className="pill">{mode === 'parts' ? `${parts.length} 个部件` : `${completed} / ${parts.length} 模型完成`}</span></div>
    {mode === 'parts' ? <>
      <p className="muted">以角色总图为依据，确定需要独立制作的身体、发型、服装和配件。鞋子、手套按一双建项。</p>
      {project.sheet ? <div className="source-sheet"><ZoomImage src={project.sheet.url} alt={`${project.title}角色总图`}/><div><strong>拆分来源 · 当前角色总图</strong><p className="muted">确认清单后，进入部件建模，逐个提取部件图并生成模型。</p><button className="button ghost" onClick={image}>返回查看角色图片</button></div></div> : <div className="workflow-empty"><p>先生成或导入角色总图，再确定部件清单。</p><button className="button primary" onClick={image}>前往角色图片</button></div>}
      <button className="button secondary" disabled={disabled || !project.sheet} onClick={identify}>从总图识别部件清单</button>
      {!!suggestions.length && <div className="part-suggestions"><p className="muted">识别建议 · 点击添加到清单</p><div className="row wrap">{suggestions.map((s, i) => <button className="button ghost compact" key={i} disabled={disabled} onClick={() => void perform(async () => added(await post<Project>(`/projects/${project.id}/parts`, s)))}>＋ {s.title}</button>)}</div></div>}
      <div className="row wrap part-create"><select aria-label="部件类型" value={kind} onChange={e => setKind(e.target.value)}>{Object.entries(partKinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><input aria-label="部件名称" placeholder="自定义名称（可选）" value={title} onChange={e => setTitle(e.target.value)}/><button className="button secondary" disabled={disabled || !project.sheet} onClick={() => void perform(async () => { added(await post<Project>(`/projects/${project.id}/parts`, { kind, title })); setTitle('') })}>添加部件</button></div>
      <div className="part-plan-list">{parts.map((p, i) => <div className="row between" key={p.id}><span><small>{String(i + 1).padStart(2, '0')}</small><strong>{p.title}</strong><span className="muted">{partKinds[p.part_kind!]}</span></span><button className="button ghost compact" disabled={disabled} onClick={() => remove(p)}>删除部件 {p.title}</button></div>)}</div>
      <div className="panel-actions"><span className="muted">共 {parts.length} 个部件，下一步逐个制作。</span><button className="button primary" disabled={!parts.length || disabled} onClick={next}>进入部件建模 →</button></div>
    </> : <>
      <p className="muted">选择部件，依次完成独立部件图、三视图、裁切和建模。每个部件单独保存进度。</p>
      {!parts.length && <div className="workflow-empty"><p>还没有部件，先确定需要制作的清单。</p><button className="button primary" onClick={next}>前往部件拆分</button></div>}
      <div className="parts-grid">{parts.map(p => <div className="part-card" key={p.id}>{(p.part_image || p.sheet) ? <ZoomImage src={(p.part_image || p.sheet)!.url} alt={p.title}/> : <div className="part-placeholder">{partKinds[p.part_kind!] || '部件'}</div>}<strong>{p.title}</strong><small>{partStatus(p)}</small><button className="button secondary compact" onClick={() => open(p)}>{p.model ? '查看部件模型' : '继续制作'} · {p.title}</button></div>)}</div>
      {!!parts.length && <div className="panel-actions"><button className="button ghost" onClick={next}>调整部件清单</button><span className="muted">已完成 {completed} 个，还剩 {parts.length - completed} 个模型。</span></div>}
      <details className="workflow-followup" open={!!parts.length && completed === parts.length}><summary>后续处理 · 对齐、组装与导出</summary><p className="muted">在各部件的模型页进入对齐设置，完成后统一组装到同一骨架。</p><div className="row wrap"><button className="button primary" disabled={disabled || !parts.length || parts.some(p => !p.alignment || !p.model)} onClick={assemble}>组装全部部件并绑定</button><button className="button secondary" onClick={rig}>{project.rig ? '查看组装结果与导出' : '查看骨架模板'}</button><button className="button secondary" disabled={working} onClick={() => void perform(async () => { const result = await post<{path: string}>(`/projects/${project.id}/open-folder`); setFolder(result.path) })}>整理并打开资产文件夹</button></div>{folder && <p className="field-note">{folder}</p>}</details>
      <details className="workflow-followup"><summary>已有整角色模型 / 整角色建模</summary><p className="muted">可导入已有 GLB，或继续处理历史整角色模型。</p><button className="button secondary" onClick={legacy}>打开整角色模型工具</button></details>
    </>}
  </section>
}
