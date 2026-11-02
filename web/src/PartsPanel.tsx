import { useEffect, useRef, useState } from 'react'
import { api, post, type Project } from './api'
import ZoomImage from './ZoomImage'

const kinds: Record<string,string> = {body:'基础身体',hair:'发型',top:'上衣',coat:'外套',bottom:'裤子／裙子',shoes:'鞋子（一双）',gloves:'手套（一双）',accessory:'大型配件'}

export default function PartsPanel({ project, projects, busy, open, added, changed, remove, generate, revise, turnaround, reviewSheet, assemble, identify, error }: {
  project: Project; projects: Project[]; busy: boolean; open: (p: Project) => void; added: (p: Project) => void;
  changed: (p: Project) => void; remove: (p: Project) => void; generate: () => void; assemble: () => void; error: (e: unknown) => void;
  identify: () => void;
  turnaround: () => void;
  reviewSheet: () => void;
  revise: (instruction: string) => void;
}) {
  const [kind, setKind] = useState('hair')
  const [title, setTitle] = useState('')
  const [working, setWorking] = useState(false)
  const [folder, setFolder] = useState('')
  const [bone, setBone] = useState(project.binding_bone || '')
  const [editPrompt, setEditPrompt] = useState(project.part_edit_prompt || '')
  const editDirty = useRef(false)
  useEffect(()=>{if(!editDirty.current)setEditPrompt(project.part_edit_prompt || '')},[project.part_edit_prompt])
  const parent = projects.find(p=>p.id===project.parent_id)
  const parts = projects.filter(p=>p.parent_id===project.id)
  const paired = new Set<string>()
  const suggestions = (project.part_suggestions || []).flatMap(s=>{
    if(!['shoes','gloves'].includes(s.kind))return [s]
    if(paired.has(s.kind))return []
    paired.add(s.kind)
    return [{...s,title:kinds[s.kind]}]
  })
  useEffect(()=>{
    if(project.parent_id || !parts.length)return
    let valid=true
    const timer=window.setInterval(()=>{void api<Project[]>(`/projects/${project.id}/parts`).then(items=>{if(valid)items.forEach(changed)}).catch(error)},2000)
    return()=>{valid=false;window.clearInterval(timer)}
  },[project.id,parts.length])
  const disabled = busy || working
  const perform = async (fn: () => Promise<void>) => {setWorking(true);try {await fn()}catch(e){error(e)}finally{setWorking(false)}}
  const update = (value: Record<string,unknown>) => {
    changed({...project,...value})
    return perform(async()=>{try {changed(await api<Project>(`/projects/${project.id}`,{method:'PATCH',body:JSON.stringify(value)}))}catch(e){changed(project);throw e}})
  }
  return <section className="panel parts-panel">
    <div className="row between"><div><span className="eyebrow">MODULAR CHARACTER ASSETS</span><h2>{project.parent_id ? `${kinds[project.part_kind!] || '独立部件'}工作流` : '部件拆分与资产'}</h2></div>
      <button className="button secondary" disabled={working} onClick={()=>void perform(async()=>{const result=await post<{path:string}>(`/projects/${project.id}/open-folder`);setFolder(result.path)})}>整理并打开资产文件夹</button></div>
    {folder&&<p className="field-note">{folder}</p>}
    {project.parent_id ? <>
      {parent&&<button className="button ghost" onClick={()=>open(parent)}>← 返回角色：{parent.title}</button>}
      <p className="muted">独立部件图 → 部件三视图 → 裁切确认 → 建模 → 对齐预览 → 返回角色统一组装绑定。</p>
      <div className="part-image-row">{project.part_image&&<ZoomImage src={project.part_image.url} alt={`${project.title}独立部件图`}/>}
        <div className="row wrap"><button className="button secondary" disabled={disabled} onClick={generate}>{project.part_image?'重新生成部件图':'生成独立部件图'}</button><button className="button secondary" disabled={disabled||!project.part_image} onClick={turnaround}>{project.sheet?'重新生成部件三视图（计费）':'生成部件三视图'}</button></div></div>
      {project.part_image&&<div className="part-edit"><label htmlFor="part-edit-prompt">部件修改要求</label><textarea id="part-edit-prompt" value={editPrompt} maxLength={8000} disabled={disabled} onChange={e=>{editDirty.current=true;setEditPrompt(e.target.value)}} placeholder="例如：袖口收窄，保留原配色、纽扣和领口；去掉多余的腰带。"/><p className="muted">以当前部件图为参考，只修改你描述的内容。成功后需重新生成三视图和模型；原图可在任务记录中下载。</p><div className="row wrap"><button className="button secondary" disabled={disabled} onClick={()=>{editDirty.current=false;void update({part_edit_prompt:editPrompt})}}>保存修改要求</button><button className="button primary" disabled={disabled||!editPrompt.trim()} onClick={()=>revise(editPrompt)}>按要求修改当前部件图</button></div></div>}
      {project.sheet&&<div className="part-sheet-result"><ZoomImage src={project.sheet.url} alt={`${project.title}已关联三视图`}/><div><strong>部件三视图已关联</strong><p className="muted">{Object.keys(project.views).length?'已确认裁切，可继续建模。':'图片已保存，请确认裁切后继续建模。'}</p><button className="button primary" onClick={reviewSheet}>查看／裁切已有三视图</button></div></div>}
      <label className="part-check"><input type="checkbox" checked={!!project.split_model} disabled={disabled} onChange={e=>void update({split_model:e.target.checked})}/>Tripo 二次智能拆分：第二档（6–15 个部件）</label>
      {project.split_model&&<p className="field-note">该部件将使用三角面建模，再提交二次拆分；两次操作分别使用网页会员额度。</p>}
      <div className="row wrap"><label>绑定方式<select value={project.binding_mode || 'surface'} disabled={disabled} onChange={e=>void update({binding_mode:e.target.value})}><option value="surface">表面权重转移（身体／衣物／发型）</option><option value="rigid">单骨骼刚性绑定（硬质配件／短发）</option></select></label>
        {project.binding_mode==='rigid'&&<label>模板骨骼名<input aria-label="部件绑定骨骼" value={bone} onChange={e=>setBone(e.target.value)} onBlur={()=>{if(bone!==project.binding_bone)void update({binding_bone:bone})}} disabled={disabled}/></label>}</div>
      {project.part_kind==='hair'&&<p className="field-note">长发、辫子当前随模板骨架蒙皮；独立摆动需在 Blender 中补充发骨和权重。</p>}
    </> : <>
      <p className="muted">以当前角色总图为参考，逐件提取发型、服装、鞋子、手套及配件。鞋子、手套按一双生成，同一部件包含左右两只。</p>
      <button className="button secondary" disabled={disabled||!project.sheet} onClick={identify}>从总图识别部件清单</button>
      {!!suggestions.length&&<div className="row wrap">{suggestions.filter(s=>!parts.some(p=>p.title===s.title)).map((s,i)=><button className="button ghost compact" key={i} disabled={disabled} onClick={()=>void perform(async()=>added(await post<Project>(`/projects/${project.id}/parts`,s)))}>＋ {s.title}</button>)}</div>}
      <div className="row wrap part-create"><select aria-label="部件类型" value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(kinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><input aria-label="部件名称" placeholder="自定义名称（可选）" value={title} onChange={e=>setTitle(e.target.value)}/><button className="button secondary" disabled={disabled||!project.sheet} onClick={()=>void perform(async()=>{const p=await post<Project>(`/projects/${project.id}/parts`,{kind,title});added(p);setTitle('')})}>添加部件</button></div>
      {!project.sheet&&<p className="field-note">先生成或导入角色总图，再添加部件。</p>}
      <div className="parts-grid">{parts.map(p=><div className="part-card" key={p.id}>{(p.part_image||p.sheet)&&<ZoomImage src={(p.part_image||p.sheet)!.url} alt={p.title}/>}<strong>{p.title}</strong><small>{p.rig?'已绑定':p.alignment?'已对齐':p.model?'已有模型':Object.keys(p.views).length?'三视图已确认':p.sheet?'待确认裁切':p.part_image?'部件图已生成':'待生成部件图'}{p.split_model?' · 二次拆分 6–15':''}</small><div className="row"><button className="button secondary compact" onClick={()=>open(p)}>编辑部件</button><button className="button ghost compact" disabled={disabled} onClick={()=>remove(p)}>删除部件</button></div></div>)}</div>
      {!!parts.length&&<div className="panel-actions"><span className="muted">每个部件完成对齐后，统一绑定到同一骨架，保留独立网格与材质。</span><button className="button primary" disabled={disabled||parts.some(p=>!p.alignment||!p.model)} onClick={assemble}>组装全部部件并绑定</button></div>}
    </>}
  </section>
}
