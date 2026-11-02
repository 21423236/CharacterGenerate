import { useEffect, useRef, useState } from 'react'
import { api, type Project } from './api'
import { type Step } from './workflow'
import ZoomImage from './ZoomImage'

export default function PartEditor({ project, step, busy, draft, editDraft, changed, generate, revise, turnaround, navigate, error }: {
  project: Project; step: Step; busy: boolean; changed: (p: Project) => void;
  draft: string; editDraft: (value: string) => void;
  generate: () => void; revise: (message: string) => void; turnaround: () => void;
  navigate: (step: Step) => void; error: (e: unknown) => void;
}) {
  const [working, setWorking] = useState(false)
  const [bone, setBone] = useState(project.binding_bone || '')
  const [editPrompt, setEditPrompt] = useState(project.part_edit_prompt || '')
  const editDirty = useRef(false)
  useEffect(() => { if (!editDirty.current) setEditPrompt(project.part_edit_prompt || '') }, [project.part_edit_prompt])
  const disabled = busy || working
  const update = async (value: Record<string, unknown>) => {
    setWorking(true)
    changed({...project, ...value})
    try { changed(await api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify(value) })) }
    catch (e) { changed(project); error(e) } finally { setWorking(false) }
  }
  if (step === 'model') return <details className="part-model-options"><summary>部件建模选项{project.split_model ? ' · 已启用二次拆分' : ''}</summary><label className="part-check"><input type="checkbox" checked={!!project.split_model} disabled={disabled} onChange={e => void update({split_model: e.target.checked})}/>Tripo 二次智能拆分：第二档（6–15 个部件）</label>{project.split_model && <p className="field-note">先生成三角面模型，再提交二次拆分；两次操作分别使用网页会员额度。</p>}</details>
  if (step === 'rig') return <div className="part-binding-options"><div className="row wrap"><label>绑定方式<select value={project.binding_mode || 'surface'} disabled={disabled} onChange={e => void update({binding_mode: e.target.value})}><option value="surface">表面权重转移（身体／衣物／发型）</option><option value="rigid">单骨骼刚性绑定（硬质配件／短发）</option></select></label>{project.binding_mode === 'rigid' && <label>模板骨骼名<input aria-label="部件绑定骨骼" value={bone} onChange={e => setBone(e.target.value)} onBlur={() => { if (bone !== project.binding_bone) void update({binding_bone: bone}) }} disabled={disabled}/></label>}</div>{project.part_kind === 'hair' && <p className="field-note">长发独立摆动需在 Blender 中补充发骨和权重。</p>}</div>
  return <section className="panel">
    <div className="section-title"><div><span className="eyebrow">{step === 'part-image' ? 'PART / ISOLATED IMAGE' : 'PART / CONSISTENT VIEWS'}</span><h2>{step === 'part-image' ? `提取独立部件 · ${project.title}` : `生成部件三视图 · ${project.title}`}</h2></div></div>
    {step === 'part-image' ? <>
      <p className="muted">以创建部件时的角色总图为参考，提取当前部件。确认外观后再制作三视图。</p>
      <details className="image-design"><summary>提取说明与参考图</summary>{project.references[0]&&<div className="source-sheet"><ZoomImage src={project.references[0].url} alt={`${project.title}提取参考总图`}/><p className="muted">此部件创建时保存的角色总图。</p></div>}<textarea aria-label="部件提取说明" className="prompt-editor" value={draft} disabled={disabled} onChange={e=>editDraft(e.target.value)}/><button className="button secondary" disabled={disabled} onClick={()=>void update({prompt:draft})}>保存提取说明</button></details>
      {project.part_image ? <div className="part-result"><ZoomImage src={project.part_image.url} alt={`${project.title}独立部件图`}/></div> : <div className="workflow-empty"><p>还没有独立部件图。</p></div>}
      <button className={`button ${project.part_image ? 'secondary' : 'primary'}`} disabled={disabled} onClick={generate}>{project.part_image ? '重新生成部件图' : '生成独立部件图'}</button>
      {project.part_image && <div className="part-edit"><label htmlFor="part-edit-prompt">部件修改要求</label><textarea id="part-edit-prompt" value={editPrompt} maxLength={8000} disabled={disabled} onChange={e => { editDirty.current = true; setEditPrompt(e.target.value) }} placeholder="例如：袖口收窄，保留原配色、纽扣和领口。"/><p className="muted">修改成功后需重新生成三视图和模型，历史结果可在任务记录中下载。</p><div className="row wrap"><button className="button secondary" disabled={disabled} onClick={() => { editDirty.current = false; void update({part_edit_prompt: editPrompt}) }}>保存修改要求</button><button className="button secondary" disabled={disabled || !editPrompt.trim()} onClick={() => revise(editPrompt)}>按要求修改当前部件图</button></div></div>}
      <div className="panel-actions"><span className="muted">当前仅处理「{project.title}」。</span><button className="button primary" disabled={!project.part_image || disabled} onClick={() => navigate('part-sheet')}>确认部件图，下一步 →</button></div>
    </> : <>
      <p className="muted">以独立部件图为参考，生成一致的正面、侧面和背面。生成完成后进入裁切确认。</p>
      {project.sheet ? <div className="part-result"><ZoomImage src={project.sheet.url} alt={`${project.title}已关联三视图`}/></div> : project.part_image ? <div className="source-sheet"><ZoomImage src={project.part_image.url} alt={`${project.title}三视图参考图`}/><p className="muted">本次三视图使用这张独立部件图作为参考。</p></div> : <div className="workflow-empty"><p>先提取独立部件图，再生成三视图。</p><button className="button secondary" onClick={() => navigate('part-image')}>前往独立部件图</button></div>}
      <label className="side-option">中间视图<select value={project.side} disabled={disabled} onChange={e => void update({side: e.target.value})}><option value="left">部件左侧</option><option value="right">部件右侧</option></select></label>
      <div className="panel-actions"><button className={`button ${project.sheet ? 'secondary' : 'primary'}`} disabled={disabled || !project.part_image} onClick={turnaround}>{project.sheet ? '重新生成部件三视图（计费）' : '生成部件三视图'}</button><button className="button primary" disabled={disabled || !project.sheet} onClick={() => navigate('crop')}>查看／裁切已有三视图 →</button></div>
    </>}
  </section>
}
