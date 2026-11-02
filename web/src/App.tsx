import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Box, Check, ChevronDown, CircleHelp, ExternalLink, Fingerprint, ImagePlus, Layers3, LoaderCircle, Plus, RefreshCw, ScanLine, Send, Settings2, ShieldCheck, Sparkles, Upload, WandSparkles, X } from 'lucide-react'
import { api, post, DEFAULT_TRANSFORM, jobLabels, type Asset, type Job, type Project, type Settings, type StudioRun, type Transform } from './api'
import CropEditor from './CropEditor'
import SettingsDialog from './SettingsDialog'
import TripoWorkspace from './TripoWorkspace'
import PartsPanel from './PartsPanel'
import PartEditor from './PartEditor'
import ModelFaceBudget from './ModelFaceBudget'
import ZoomImage from './ZoomImage'
import { characterSteps, partSteps, partStatus, resumeStep, viewsReady, type Step } from './workflow'

const LazyModelViewer = lazy(() => import('./ModelViewer'))
const ModelViewer = (props: {url?: string; reference?: string}) => <Suspense fallback={<div className="model-viewer"><span className="viewer-label">加载 3D 查看器…</span></div>}><LazyModelViewer {...props}/></Suspense>

const viewNames: Record<string,string> = {front:'正面 / FRONT',left:'左侧 / LEFT',right:'右侧 / RIGHT',back:'背面 / BACK'}
const activeStatus = (job: Job) => ['queued','running'].includes(job.status)
const download = (asset: Asset, label: string) => <a key={asset.id} className="button secondary" href={asset.url+'?download=true'}><ArrowDownToLine size={15}/>{label}</a>

export default function App() {
  const [settings, setSettings] = useState<Settings>()
  const [projects, setProjects] = useState<Project[]>([])
  const [deletedProjects, setDeletedProjects] = useState<Project[]>([])
  const [deleting, setDeleting] = useState(false)
  const hiddenProjects = useRef(new Set<string>())
  const [project, setProject] = useState<Project>()
  const projectRef = useRef<Project | undefined>(undefined)
  const [jobs, setJobs] = useState<Job[]>([])
  const [step, setStepState] = useState<Step>('design')
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState('')
  const [chat, setChat] = useState('')
  const [pending, setPending] = useState(false)
  const [modelOptionsDirty, setModelOptionsDirty] = useState(false)
  const [studioRuns, setStudioRuns] = useState<Record<string, StudioRun>>({})
  const shownRuns = useRef(new Set<string>())
  const [promptRequest, setPromptRequest] = useState<{ message: string; value: string; resolve: (value: string | null) => void }>()
  const [transform, setTransform] = useState<Transform>({...DEFAULT_TRANSFORM})
  const [testPose, setTestPose] = useState('rest')
  const refsInput = useRef<HTMLInputElement>(null)
  const sheetInput = useRef<HTMLInputElement>(null)
  const modelInput = useRef<HTMLInputElement>(null)
  const studioRun = project ? studioRuns[project.id] : undefined
  const busy = pending || jobs.some(activeStatus) || !!studioRun?.active
  const studioMode = settings?.tripo.mode !== 'api'
  const ask = (message: string, value = '') => new Promise<string | null>(resolve => setPromptRequest({ message, value, resolve }))
  const finishPrompt = (value: string | null) => { promptRequest?.resolve(value); setPromptRequest(undefined) }
  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : '操作失败，请检查配置'), [])
  const setStep = useCallback((value: Step) => {
    setStepState(value)
    if(projectRef.current) localStorage.setItem(`forge-step:${projectRef.current.id}`, value)
  }, [])
  const chooseProject = useCallback((p: Project, target?: Step, items: Project[] = []) => {
    if(hiddenProjects.current.has(p.id)) return
    projectRef.current = p; setProject(p); setDraft(p.prompt); setTransform(p.alignment?.transform || {...DEFAULT_TRANSFORM}); setJobs([]); setTestPose('rest'); setChat(''); setError(''); setNotice('')
    setStep(target || resumeStep(p, items))
    localStorage.setItem('forge-project', p.id)
  }, [setStep])
  useEffect(() => {
    let valid = true
    Promise.all([api<Settings>('/settings'), api<Project[]>('/projects')]).then(([s, items]) => {
      if (!valid) return
      setSettings(s);setProjects(items)
      const last = localStorage.getItem('forge-project'); const selected = items.find(p => p.id === last) || items.find(p=>!p.parent_id)
      if(selected) chooseProject(selected, undefined, items)
    }).catch(fail)
    return () => {valid=false}
  }, [chooseProject, fail])
  useEffect(() => window.forgeDesktop?.onStudioState?.(value => {
    if(hiddenProjects.current.has(value.projectId)) return
    setStudioRuns(items=>({...items,[value.projectId]:value}))
    if(value.status==='complete' && !shownRuns.current.has(value.runId)) {
      shownRuns.current.add(value.runId)
       void api<Project>(`/projects/${value.projectId}`).then(fresh=>{
         if(hiddenProjects.current.has(fresh.id)) return
        setProjects(items=>items.map(p=>p.id===fresh.id?fresh:p))
         if(projectRef.current?.id===fresh.id) { projectRef.current=fresh;setProject(fresh) }
        setNotice(`${fresh.title}：Tripo 模型已生成并回填。`)
      }).catch(fail)
    }
  }), [fail])
  useEffect(() => {
    if(!project?.id || !window.forgeDesktop?.studioState) return
    const id=project.id
    void window.forgeDesktop.studioState(id).then(value=>{if(value)setStudioRuns(items=>({...items,[id]:items[id] && items[id].updated>value.updated?items[id]:value}))}).catch(fail)
  }, [project?.id,fail])
  useEffect(() => {
    if (!project?.id) return
    let valid = true; let fetching = false; let previous: string | undefined
    const id = project.id
    const refresh = async () => {
      if(fetching) return
      fetching=true
      try {
        const list = await api<Job[]>(`/projects/${id}/jobs`)
        if(!valid || hiddenProjects.current.has(id) || projectRef.current?.id!==id) return
        setJobs(list)
        const signature = list.map(j => `${j.id}:${j.status}`).join(',')
        if(signature !== previous) {
          const fresh = await api<Project>(`/projects/${id}`)
            if(!valid || hiddenProjects.current.has(id) || projectRef.current?.id!==id) return
          previous = signature
          const old = projectRef.current
            projectRef.current=fresh;setProject(fresh)
           if (old?.model?.id !== fresh.model?.id && list[0]?.kind === 'studio_import') setNotice('Tripo 网页模型已回填，可进入骨架与蒙皮。')
          if(old?.prompt !== fresh.prompt) setDraft(fresh.prompt)
          setProjects(items => items.map(p => p.id === id ? fresh : p))
        }
      }catch(e){if(valid) fail(e)}finally{fetching=false}
    }
    void refresh();const timer = window.setInterval(() => void refresh(), 1800)
    return () => {valid=false;window.clearInterval(timer)}
  }, [project?.id,fail])
   const apply = useCallback((p: Project) => {if(hiddenProjects.current.has(p.id))return;if(projectRef.current?.id===p.id){projectRef.current=p;setProject(p)}setProjects(items => items.map(item => item.id===p.id?p:item))}, [])
  const removeProject = async (p: Project) => {
    if(deleting || pending) return
    setDeleting(true);setError('')
    hiddenProjects.current.add(p.id)
    try {
      if(window.forgeDesktop) await window.forgeDesktop.deleteProject(p.id)
      else await api(`/projects/${p.id}`,{method:'DELETE'})
      projects.filter(item=>item.parent_id===p.id).forEach(item=>hiddenProjects.current.add(item.id))
      setProjects(items=>items.filter(item=>item.id!==p.id&&item.parent_id!==p.id))
      setDeletedProjects(items=>[p,...items])
      if(projectRef.current?.id===p.id||projectRef.current?.parent_id===p.id) {
        const next=projects.find(item=>item.id===p.parent_id)||projects.find(item=>!item.parent_id&&item.id!==p.id&&!hiddenProjects.current.has(item.id))
         if(next) chooseProject(next, undefined, projects)
        else {projectRef.current=undefined;setProject(undefined);setJobs([]);setDraft('');localStorage.removeItem('forge-project')}
         setChat('')
      }
    } catch(e) {hiddenProjects.current.delete(p.id);fail(e)}
    finally {setDeleting(false)}
  }
  const undoDelete = async () => {
    const p=deletedProjects[0]
    if(!p || deleting) return
    setDeleting(true);setError('')
    try {
      const restored=await post<Project>(`/projects/${p.id}/restore`)
      hiddenProjects.current.delete(p.id)
      const items=await api<Project[]>('/projects')
      items.forEach(item=>hiddenProjects.current.delete(item.id))
      setProjects(items)
      setDeletedProjects(items=>items.filter(item=>item.id!==p.id))
       chooseProject(restored, undefined, items)
    } catch(e) {fail(e)} finally {setDeleting(false)}
  }
  const create = async () => {
    const title=await ask('为这个角色取个名字', '未命名旅人')
    if(title === null) return
    try{const p=await post<Project>('/projects',{title});setProjects(items=>[p,...items]);chooseProject(p, 'design')}catch(e){fail(e)}
  }
  const saveDraft = async () => {
    if(!project) return
    const p=await api<Project>(`/projects/${project.id}`,{method:'PATCH',body:JSON.stringify({prompt:draft})});apply(p)
  }
  const openStudio = async () => {
    if (!project || pending) return
    setError('')
    if (!window.forgeDesktop) {
      window.open('https://studio.tripo3d.com/workspace/generate', '_blank', 'noopener,noreferrer')
      setNotice('请在 Tripo 网站生成并下载 GLB，再使用“导入 GLB”继续。桌面版支持下载自动回填。')
      return
    }
    setPending(true)
    try { await window.forgeDesktop.openStudio(project.id) }
    catch (e) { fail(e) }
    finally { setPending(false) }
  }
  const automateStudio = async (action: 'start'|'resume'|'pause'|'cancel') => {
    if(!project || !window.forgeDesktop?.automateStudio || pending) return
    if(action==='start' && modelOptionsDirty) return
    setPending(true);setError('');setStep('model')
    try { await window.forgeDesktop.automateStudio(project.id,action) }
    catch(e) { fail(e) }
    finally { setPending(false) }
  }
  const start = async (kind: string, extra: Record<string,unknown> = {}) => {
    if(!project || busy) return
    if(kind==='model' && modelOptionsDirty) return
    if(kind==='assemble'&&projects.some(p=>p.parent_id===project.id&&studioRuns[p.id]?.active)){setError('部件仍在 Tripo 生成或下载，请等待完成再组装');return}
    if((kind==='model' || kind==='doctor') && studioMode) { await openStudio(); return }
    if((kind==='image'||kind==='part_image'||kind==='part_edit') && !window.confirm('即将向你配置的生图服务发送设计提示词和参考图，可能产生费用。确认生成？')) return
    if(kind==='model' && !window.confirm('即将上传三视图并消耗独立的 Tripo API 积分，不使用网页会员额度。确认提交 API 建模？')) return
    if((kind==='bind'||kind==='assemble') && !window.confirm('已确认各模型与绿色模板人体的朝向、比例和关节位置？将绑定到模板骨架并另存新工程。')) return
    setPending(true);setError('')
    try {
      if(kind==='image' || kind==='part_image' || kind==='chat') await saveDraft()
      const job=await post<Job>(`/projects/${project.id}/jobs`,{kind,confirmed:true,transform,...extra})
      if(projectRef.current?.id===project.id) {
        setJobs(items=>[job,...items]);if(kind==='chat') setChat('')
        if(kind==='image') setStep(project.parent_id ? 'part-sheet' : 'image')
        if(kind==='assemble')setStep('rig')
      }
    }catch(e){fail(e)}finally{setPending(false)}
  }
  const upload = async (file: File | undefined, kind: string) => {
    if(!project || !file) return
    setPending(true)
    try{const form=new FormData();form.append('file',file);const p=await api<Project>(`/projects/${project.id}/upload?kind=${kind}`,{method:'POST',body:form});apply(p);if(projectRef.current?.id===p.id){if(kind==='sheet')setStep(p.parent_id?'crop':'image');if(kind==='model')setStep('model')}}catch(e){fail(e)}finally{setPending(false)}
  }
  const crop = async (boxes:number[][],labels:string[]) => {
    if(!project) return
    setPending(true)
    try{apply(await post<Project>(`/projects/${project.id}/crop`,{boxes,labels,confirmed:true}));setNotice('三张视图已保存。请检查预览后再提交建模。')}catch(e){fail(e)}finally{setPending(false)}
  }
  const resume = async (job: Job) => {
    const id = job.remote_id || await ask('填写供应商已存在的 Tripo API 任务 ID（只查询，不重新生成）')
    if(id) await start('resume',{remote_id:id})
  }
  const currentJob = jobs.find(activeStatus)
  const imageJob = jobs.find(job => job.kind === 'image')
  const imageWorking = !!imageJob && activeStatus(imageJob)
  const imageFailed = !!imageJob && ['failed', 'uncertain', 'interrupted'].includes(imageJob.status)
  const modelURL = project?.rig && step==='rig' ? (testPose==='rest' ? project.rig.assets.glb?.url : project.rig.tests.find(t=>t.name===testPose)?.asset.url) : project?.model?.url
  const validAlignment = project?.alignment && JSON.stringify(project.alignment.transform) === JSON.stringify(transform)
  const character = project?.parent_id ? projects.find(p=>p.id===project.parent_id) : project
  const parts = projects.filter(p=>p.parent_id===character?.id)
  const mainStep = project?.parent_id || ['model','crop','rig'].includes(step) ? 'models' : step
  const mainComplete = [!!character?.prompt, !!character?.sheet, !!parts.length, !!parts.length && parts.every(p=>p.model)]
  const partComplete = project ? [!!project.part_image, !!project.sheet, viewsReady(project), !!project.model] : []
  const assistantVisible = !project?.parent_id && step==='design'
  const partEditor = project?.parent_id ? <PartEditor key={project.id} project={project} step={step} busy={busy} draft={draft} editDraft={setDraft} changed={apply} generate={()=>void start('part_image')} revise={message=>void start('part_edit',{message})} turnaround={()=>void start('image')} navigate={setStep} error={fail}/> : null
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/" aria-label="角色工坊首页"><div className="brand-symbol"><Fingerprint size={27}/></div><div>角色工坊<span>CHARACTER FORGE</span></div></a>
      <div className="workspace-label">本地工作空间 <span className="live-dot"/></div>
      <button className="new-project" onClick={() => void create()}><Plus size={18}/>创建新角色</button>
      <div className="nav-caption">角色项目 <span>{projects.filter(p=>!p.parent_id).length.toString().padStart(2,'0')}</span></div>
      <nav className="project-list">{projects.filter(p=>!p.parent_id).map(p=><div className="project-entry" key={p.id}><button className={project?.id===p.id||project?.parent_id===p.id?'active':''} onClick={()=>chooseProject(p, undefined, projects)}><span className="project-glyph"><Box size={17}/></span><span>{p.title}<small>{new Date(p.updated).toLocaleDateString('zh-CN')}</small></span>{project?.id===p.id&&<span className="selected-dot"/>}</button><button className="delete-project" aria-label={`删除角色 ${p.title}`} title="删除角色（可撤销）" disabled={deleting||pending||!!studioRuns[p.id]?.active||(project?.id===p.id&&jobs.some(activeStatus))} onClick={()=>void removeProject(p)}><X size={15}/></button></div>)}{!projects.length&&<p className="sidebar-empty">每个好角色，<br/>都从一个想法开始。</p>}</nav>
      <div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={17}/><div>你的模板，始终安全<small>原文件只读 · 结果独立保存</small></div></div><button onClick={()=>setShowSettings(true)} disabled={!settings}><Settings2 size={17}/>模型与工具设置</button><div className="sidebar-version">LOCAL FIRST <span>v0.1.0</span></div></div>
    </aside>
    <main className="main-shell"><header className="topbar"><div className="breadcrumb">工作空间 <span>/</span> <strong>{character?.title || '开始创作'}</strong>{project?.parent_id && <><span>/ 部件建模 /</span><strong>{project.title}</strong></>}<ChevronDown size={13}/></div><div className="row"><span className="local-badge"><span className="live-dot"/> 本地运行</span><button className="icon-button" title="设置" onClick={()=>setShowSettings(true)} disabled={!settings}><Settings2 size={19}/></button></div></header>
      {error&&<div role="alert" className="toast error"><span>{error}</span><button aria-label="关闭错误" onClick={()=>setError('')}><X size={16}/></button></div>}
      {!!deletedProjects.length&&<div role="status" className="delete-notice"><span>已删除「{deletedProjects[0].title}」</span><button className="button secondary compact" disabled={deleting} onClick={()=>void undoDelete()}>撤销删除</button></div>}
      {notice&&<div role="status" className="toast success"><span>{notice}</span><button aria-label="关闭提示" onClick={()=>setNotice('')}><X size={16}/></button></div>}
      {!project ? <div className="welcome"><span className="eyebrow">FROM AN IDEA TO A CHARACTER</span><h1>让想象，<br/>有形可见。</h1><p>先设计角色，再拆分部件，逐个生成模型。<br/>把繁琐交给工具，把创造留给自己。</p><button className="button primary" onClick={()=>void create()}><Plus size={17}/>创建第一个角色<ArrowRight size={17}/></button><div className="welcome-process"><span><ImagePlus/>角色设定</span><i/><span><Layers3/>角色图片</span><i/><span><ScanLine/>部件拆分</span><i/><span><Box/>部件建模</span></div><span className="welcome-watermark">形 / FORM</span></div> : <>
      <div className="page-heading"><div><span className="eyebrow">{project.parent_id ? 'PART STUDIO / 部件工作台' : 'CHARACTER STUDIO / 角色工作台'}</span><h1>{project.title}</h1><p>{project.parent_id ? `所属角色：${character?.title || ''} · 当前仅处理此部件` : '角色设定 → 角色图片 → 部件拆分 → 逐件建模'}</p></div><div className="project-tag"><span className="live-dot"/>{project.parent_id ? partStatus(project) : '部件化角色制作'}</div></div>
      <nav className="steps" aria-label="角色制作阶段">{characterSteps.map(({step: target,label},i)=><button key={target} aria-current={mainStep===target?'step':undefined} className={mainStep===target?'active':''} onClick={()=>{if(project.parent_id && character)chooseProject(character,target);else setStep(target)}}><span className="step-number">{mainComplete[i]?<Check size={14}/>:String(i+1).padStart(2,'0')}</span>{label}{i<3&&<span className="step-line"/>}</button>)}</nav>
      <div className={`studio-layout${assistantVisible ? '' : ' focused-layout'}${project.parent_id ? ' part-layout' : ''}`}>
        {project.parent_id && <aside className="parts-rail"><button className="button ghost" onClick={()=>{if(character)chooseProject(character,'models')}}>← 返回角色：{character?.title}</button><h3>角色部件 <small>{parts.filter(p=>p.model).length} / {parts.length} 完成</small></h3><nav aria-label="角色部件">{parts.map(p=><button key={p.id} className={p.id===project.id?'active':''} aria-current={p.id===project.id?'page':undefined} onClick={()=>{if(p.id!==project.id)chooseProject(p)}}><strong>{p.title}</strong><small>{studioRuns[p.id]?.active ? '正在建模…' : partStatus(p)}</small></button>)}</nav></aside>}
        <div className="work-area">
        {project.parent_id && <><nav className="part-steps" aria-label="部件制作阶段">{partSteps.map(({step:target,label},i)=><button key={target} className={step===target?'active':''} aria-current={step===target?'step':undefined} onClick={()=>setStep(target)}><span>{partComplete[i]?<Check size={14}/>:i+1}</span>{label}</button>)}</nav>{step==='rig' && <div className="workflow-context"><button className="button ghost" onClick={()=>setStep('model')}>← 返回部件模型</button><strong>后续处理 · 对齐与绑定</strong></div>}</>}
        {!project.parent_id && ['rig','model','crop'].includes(step) && <div className="workflow-context"><button className="button ghost" onClick={()=>setStep('models')}>← 返回部件建模总览</button><strong>{step==='rig' ? '后续处理 · 骨架与组装结果' : '整角色模型工具'}</strong></div>}
        {currentJob&&<div className="running-job"><LoaderCircle className="spin" size={18}/><div><strong>{jobLabels[currentJob.kind]}</strong><span>{currentJob.message}</span></div><span>{currentJob.progress || 0}%</span><div className="job-progress" style={{width:`${Math.max(currentJob.progress||0,3)}%`}}/></div>}
        {!project.parent_id && (step==='parts'||step==='models') && <PartsPanel key={project.id} project={project} projects={projects} mode={step} busy={busy} open={p=>chooseProject(p)} added={p=>setProjects(items=>[p,...items])} changed={apply} remove={p=>void removeProject(p)} assemble={()=>void start('assemble')} identify={()=>void start('parts_plan')} next={()=>setStep(step==='parts'?'models':'parts')} image={()=>setStep('image')} rig={()=>setStep('rig')} legacy={()=>setStep('model')} error={fail}/>}
        {project.parent_id && (step==='part-image'||step==='part-sheet') && <>{partEditor}{step==='part-sheet' && imageWorking && <p role="status" className="inline-warning">正在生成新的部件三视图，完成后会自动替换预览。{project.sheet?'上方是上次结果。':''}</p>}{step==='part-sheet' && imageFailed && <p role="alert" className="inline-warning">本次部件三视图未生成成功：{imageJob.message}。{project.sheet?'上方保留上次结果。':''}</p>}</>}
        {step==='design'&&!project.parent_id&&<>
          <section className="panel design-panel"><div className="section-title"><div><span className="eyebrow">01 / THE IDEA</span><h2>先给想象一个轮廓。</h2></div><WandSparkles size={24} strokeWidth={1}/></div><p className="muted">描述你心中的角色，也可以让右侧设计助手一起完善细节。</p>
            <label className="input-label" htmlFor="design-prompt">角色设计提示词 <span>可直接编辑，无需先调用大语言模型</span></label><textarea id="design-prompt" className="prompt-editor" value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)} placeholder="例如：一位行走在荒野的年轻游侠，黑色短发，暗红色不对称披风，米白色内衬与棕色皮革腰带。完整人形角色，保留左肩的金色徽章……"/>
            <div className="panel-actions"><button className="button secondary" disabled={busy} onClick={()=>void saveDraft().then(()=>setNotice('设计已保存')).catch(fail)}>保存设计</button><button className="button primary" disabled={busy||!draft.trim()} onClick={()=>{const id=project.id;setPending(true);void saveDraft().then(()=>{if(projectRef.current?.id===id)setStep('image')}).catch(fail).finally(()=>setPending(false))}}>保存设定，下一步<ArrowRight size={16}/></button></div>
          </section>
          <section className="panel"><div className="section-title"><div><span className="eyebrow">REFERENCE BOARD</span><h2>灵感，来自这里。</h2></div><span className="counter">{project.references.length} / 8</span></div><p className="muted">支持 PNG、JPG、WebP。参考图会发送给生图服务；不会自动上传给其他服务。</p><div className="reference-grid">{project.references.map(ref=><div className="reference-card" key={ref.id}><img src={ref.url} alt="角色参考图"/><button aria-label="移除参考图" disabled={busy} onClick={()=>void api<Project>(`/projects/${project.id}/references/${ref.id}`,{method:'DELETE'}).then(apply).catch(fail)}><X size={14}/></button></div>)}<button className="reference-upload" disabled={busy||project.references.length>=8} onClick={()=>refsInput.current?.click()}><ImagePlus size={25} strokeWidth={1.3}/><strong>添加参考图</strong><span>点击选择 · 最多 25 MB</span></button></div></section>
        </>}
        {step==='image'&&!project.parent_id&&<section className="panel"><div className="section-title"><div><span className="eyebrow">02 / CHARACTER IMAGE</span><h2>生成角色总图</h2></div><button className="button secondary" disabled={busy} onClick={()=>sheetInput.current?.click()}><Upload size={15}/>导入角色图片</button></div>
          <p className="muted">根据角色设定生成完整三视图总图，作为后续提取各个部件的来源。</p>
          <details className="image-design"><summary>查看 / 调整本次角色设定</summary><textarea aria-label="生图使用的角色设定" className="prompt-editor" value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)}/><button className="button ghost" onClick={()=>setStep('design')}>返回角色设定，与助手讨论</button></details>
          <div className="design-options"><label>中间视图<select value={project.side} disabled={busy} onChange={e=>void api<Project>(`/projects/${project.id}`,{method:'PATCH',body:JSON.stringify({side:e.target.value})}).then(apply).catch(fail)}><option value="left">角色左侧</option><option value="right">角色右侧</option></select></label><span className="muted">{project.inspection?'使用已检测的模板姿态':'使用默认 A-pose；可在骨架工具中检测模板姿态。'}</span></div>
          {imageWorking&&<p role="status" className="inline-warning">正在生成新的三视图，完成后会自动替换预览。{project.sheet ? '下方是上次结果，不是本次新图。' : ''}</p>}
          {imageFailed&&<div role="alert" className="inline-warning"><strong>本次三视图未生成成功：</strong>{imageJob.message}{project.sheet&&<p>下方保留的是上次结果，不是本次新图。</p>}</div>}
          {project.sheet?<div className="character-sheet"><ZoomImage src={project.sheet.url} alt={`${project.title}角色总图`}/></div>:<div className="sheet-empty"><Layers3 size={50} strokeWidth={1}/><h3>先确定完整角色的外观</h3><p>正面 · 侧面 · 背面，统一姿态和比例。</p></div>}
          <div className="panel-actions"><button className={`button ${project.sheet?'secondary':'primary'}`} disabled={busy||!draft.trim()} onClick={()=>void start('image')}><Sparkles size={16}/>{project.sheet?'重新生成（计费）':'生成角色图片'}</button><button className="button primary" disabled={busy||!project.sheet} onClick={()=>setStep('parts')}>使用这张图，进入部件拆分<ArrowRight size={16}/></button></div>
        </section>}
        {step==='crop'&&<>
          <section className="panel"><div className="section-title"><div><span className="eyebrow">VIEWS / CONFIRM CROPS</span><h2>{project.parent_id ? `确认部件裁切 · ${project.title}` : '确认整角色三视图裁切'}</h2></div><button className="button secondary" disabled={busy} onClick={()=>sheetInput.current?.click()}><Upload size={15}/>导入三视图</button></div>
          {project.sheet ? <CropEditor key={project.id+project.sheet.id} project={project} disabled={busy} onSave={crop}/> : <div className="workflow-empty"><p>尚无三视图，请先生成或导入图片。</p><button className="button secondary" onClick={()=>setStep(project.parent_id?'part-sheet':'image')}>前往生成三视图</button></div>}
          {!!Object.keys(project.views).length&&<><h3 className="subheading">建模使用的三张视图</h3><div className="views-grid">{Object.entries(project.views).map(([label,asset])=><div key={label}><img src={asset.url} alt={viewNames[label]}/><div><span>{viewNames[label]}</span><a href={asset.url+'?download=true'} aria-label={'下载'+viewNames[label]}><ArrowDownToLine size={16}/></a></div></div>)}</div>{project.view_warnings?.map(w=><div className="inline-warning" key={w}>{w}</div>)}</>}
          <div className="panel-actions"><button className="button ghost" onClick={()=>setStep(project.parent_id?'part-sheet':'image')}>返回查看三视图</button><button className="button primary" disabled={busy||!viewsReady(project)} onClick={()=>setStep('model')}>裁切已确认，进入建模<ArrowRight size={16}/></button></div></section>
        </>}
        {step==='model'&&<section className="panel model-panel"><div className="section-title"><div><span className="eyebrow">MODEL / RECONSTRUCTION</span><h2>{project.parent_id ? `生成部件模型 · ${project.title}` : '整角色模型工具'}</h2></div><button className="button secondary" disabled={busy} onClick={()=>modelInput.current?.click()}><Upload size={15}/>导入 GLB</button></div>
          {project.parent_id && <ModelFaceBudget key={project.id} project={project} config={settings?.tripo} busy={busy} changed={apply} onDirty={setModelOptionsDirty} error={fail}/>}
          {partEditor}
          <TripoWorkspace project={project} studio={studioMode} busy={busy||modelOptionsDirty} open={()=>void openStudio()} prepare={()=>setStep('crop')} settings={()=>setShowSettings(true)} config={settings?.tripo} run={studioRun} automate={action=>void automateStudio(action)}/>
          <ModelViewer url={project.model?.name.endsWith('.glb')?project.model.url:undefined}/>{project.model_preview&&<details className="preview-details"><summary>查看 Tripo 服务端预览图</summary><img src={project.model_preview.url} alt="Tripo 预览"/></details>}<div className="panel-actions"><div className="row wrap">{project.model&&download(project.model,'下载原始模型')}{!studioMode&&<button className="button primary" disabled={busy||modelOptionsDirty||!viewsReady(project)} onClick={()=>void start('model')}><RefreshCw size={14}/>{project.model?'API 重新建模（计费）':'API 从三视图生成模型'}</button>}</div>{project.parent_id&&project.model ? <button className="button primary" onClick={()=>{if(character)chooseProject(character,'models')}}>完成，返回部件总览<ArrowRight size={16}/></button> : null}</div><div className="workflow-followup"><button className="button secondary" disabled={!project.model||busy} onClick={()=>setStep('rig')}>{project.parent_id?'后续处理：对齐与绑定':'适配我的骨架'}<ArrowRight size={16}/></button></div></section>}
        {step==='rig'&&<>
          <section className="panel"><div className="section-title"><div><span className="eyebrow">04 / MADE TO MOVE</span><h2>让角色，用你的骨架动起来。</h2></div><button className="button secondary" disabled={busy} onClick={()=>void start('inspect')}><ScanLine size={15}/>检测模板</button></div><div className="template-path"><Fingerprint size={20}/><div><strong>{settings?.blender.armature || '_COM'}</strong><span>{settings?.blender.template}</span></div><button className="icon-button" title="修改模板路径" onClick={()=>setShowSettings(true)}><Settings2 size={16}/></button></div>
          {project.inspection&&<><div className="inspection-stats"><div><strong>{project.inspection.bone_count}</strong><span>骨骼</span></div><div><strong>{project.inspection.sources.reduce((sum,s)=>sum+s.vertices,0).toLocaleString()}</strong><span>权重源顶点</span></div><div><strong>{project.inspection.height.toFixed(2)} m</strong><span>模板高度</span></div><div><strong>{project.inspection.actions.length}</strong><span>保留动作数据</span></div></div><p className="field-note">静止姿态：{project.inspection.pose_hint}</p></>}
          {(project.parent_id||project.model)&&<>{partEditor}<h3 className="subheading">先对齐，再转移权重</h3><p className="muted">默认按身高等比缩放并脚底对齐。请旋转模型匹配人体朝向，检查肩、肘、髋、膝位置；不自动改变原骨架。</p><div className="transform-grid">{Object.entries(transform).map(([key,value])=><label key={key}>{{rotation_x:'X 旋转 °',rotation_y:'Y 旋转 °',rotation_z:'Z 旋转 °',scale:'相对缩放',offset_x:'X 偏移 m',offset_y:'Y 偏移 m',offset_z:'Z 偏移 m'}[key]}<input type="number" step={key.startsWith('rotation')?90:.01} value={value} disabled={busy} onChange={e=>setTransform({...transform,[key]:Number(e.target.value)})}/></label>)}</div><div className="row wrap"><button className="button secondary" disabled={busy||!project.model} onClick={()=>void start('align')}><ScanLine size={16}/>生成对齐预览</button><button className="button ghost" disabled={busy} onClick={()=>setTransform({...DEFAULT_TRANSFORM})}>重置参数</button></div></>}
          {project.alignment&&<><div className="small-gap"/><ModelViewer url={project.alignment.assets.aligned?.url} reference={project.alignment.assets.reference?.url}/>{!validAlignment&&<div className="inline-warning">参数已修改，请重新生成预览。蒙皮只使用已预览的参数。</div>}<div className="panel-actions"><span className="muted">绿色线框为原人体，仅作对齐参考。</span>{project.parent_id?<><button className="button secondary" disabled={busy||!validAlignment} onClick={()=>void start('bind')}>单独绑定此部件</button><button className="button primary" disabled={busy||!validAlignment} onClick={()=>{if(character)chooseProject(character,'models')}}>确认对齐，返回统一组装</button></>:<button className="button primary" disabled={busy||!validAlignment} onClick={()=>void start('bind')}><Fingerprint size={16}/>确认对齐，开始蒙皮</button>}</div></>}
          </section>
          {project.rig&&<section className="panel"><div className="section-title"><div><span className="eyebrow">SKINNING REVIEW</span><h2>检查每一个动作细节。</h2></div><span className="pill">模板已保护</span></div><div className="pose-tabs">{[{name:'rest',label:'静止姿态'},...project.rig.tests.map(t=>({name:t.name,label:({elbow:'屈肘测试',knee:'屈膝测试',shoulder:'肩部测试'} as Record<string,string>)[t.name]||t.name}))].map(t=><button className={testPose===t.name?'active':''} key={t.name} onClick={()=>setTestPose(t.name)}>{t.label}</button>)}</div><ModelViewer url={modelURL}/>{project.rig.warnings?.map(w=><div className="inline-warning" key={w}>{w}</div>)}<div className="weight-report">{project.rig.weights?.map(w=><div key={w.name}><span>{w.name}</span><span>{w.vertices.toLocaleString()} 顶点</span><span className={w.unweighted?'warning-text':'good-text'}>未绑定 {w.unweighted}</span><span>远离人体 {w.far_from_source}</span></div>)}</div><div className="panel-actions"><div className="row wrap">{Object.entries(project.rig.assets).map(([key,asset])=>download(asset,key.toUpperCase()))}</div><button className="button primary" onClick={()=>void post(`/projects/${project.id}/open-blender`).then(()=>setNotice('已启动 Blender 打开生成的工程')).catch(fail)}><ExternalLink size={15}/>在 Blender 中打开</button></div><p className="field-note">静态屈曲预览用于发现问题，不代表通过生产验收。复杂服饰、手指及体型差异仍可能需要人工修正。</p></section>}
        </>}
        <section className="task-history"><details open={jobs.some(j=>['failed','uncertain','interrupted'].includes(j.status))}><summary>任务记录 <span>{jobs.length}</span></summary>{jobs.length===0?<p className="muted">还没有任务。每次生成和处理都会记录在这里。</p>:jobs.slice(0,20).map(job=><div className="task-row" key={job.id}><span className={'status-dot '+job.status}/><div><strong>{jobLabels[job.kind]||job.kind}<small>{new Date(job.created).toLocaleTimeString('zh-CN')}</small></strong><p>{job.message}</p>{job.remote_id&&<code>{job.remote_id}</code>}{job.result?.credits!=null&&<small>实际消耗：{job.result.credits} 积分</small>}</div>{['model','resume'].includes(job.kind)&&!activeStatus(job)&&job.status!=='success'&&<button className="button secondary compact" disabled={busy} onClick={()=>void resume(job)}><RefreshCw size={13}/>恢复查询</button>}{job.result?.assets&&<div className="history-assets">{Object.entries(job.result.assets).map(([key,asset])=><a key={asset.id} href={asset.url+'?download=true'}>{key}</a>)}</div>}</div>)}</details></section>
      </div>
      {assistantVisible&&<aside className="assistant-panel"><div className="assistant-header"><span className="assistant-symbol"><Sparkles size={18}/></span><div><h3>角色设计助手</h3><span>一起，把想法打磨得更好。</span></div></div><div className="assistant-messages">{!project.messages.length?<div className="assistant-intro"><span className="eyebrow">A LITTLE INSPIRATION</span><h3>你想创造一个<br/>怎样的角色？</h3><p>告诉我角色的故事、风格与服装。我会整理为可编辑的设计提示词，确认设定后再进入角色图片。</p><button disabled={busy} onClick={()=>setChat('帮我设计一位风格化奇幻游侠，强调不对称披风和可辨识的轮廓。')}>奇幻游侠，辨识度鲜明 <ArrowRight size={13}/></button><button disabled={busy} onClick={()=>setChat('请基于我的参考图完善完整角色设计，保留服装配色和不对称细节，并补充背面结构。')}>根据参考图完善设计 <ArrowRight size={13}/></button></div>:project.messages.map((m,i)=><div key={i} className={'chat-message '+m.role}><span>{m.role==='user'?'你':'设计助手'}</span><p>{m.content}</p></div>)}</div><form className="chat-form" onSubmit={e=>{e.preventDefault();void start('chat',{message:chat})}}><textarea aria-label="发给设计助手的消息" value={chat} onChange={e=>setChat(e.target.value)} disabled={busy} placeholder="描述想法，或告诉我哪里需要修改…"/><div><span>{settings?.llm.model||'请先在设置中配置 LLM'}</span><button aria-label="发送设计消息" disabled={busy||!chat.trim()||!settings?.llm.model}><Send size={16}/></button></div></form><div className="assistant-disclaimer"><ShieldCheck size={12}/>设定确认后，在下一步生成角色图片。</div></aside>}</div>
      </>}
      <footer className="page-footer"><span>CHARACTER FORGE <i> / </i> 想象不止于平面。</span><span><CircleHelp size={12}/>生成结果需人工检查 · 付费任务不会自动重提</span></footer>
    </main>
    <input ref={refsInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e=>{void upload(e.target.files?.[0],'reference');e.target.value=''}}/>
    <input ref={sheetInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e=>{void upload(e.target.files?.[0],'sheet');e.target.value=''}}/>
    <input ref={modelInput} type="file" accept=".glb" hidden onChange={e=>{void upload(e.target.files?.[0],'model');e.target.value=''}}/>
    {promptRequest&&<div className="modal-backdrop"><form className="settings-modal prompt-modal" role="dialog" aria-modal="true" aria-label={promptRequest.message} onSubmit={e=>{e.preventDefault();finishPrompt(promptRequest.value)}}><h2>{promptRequest.message}</h2><input autoFocus aria-label={promptRequest.message} value={promptRequest.value} onChange={e=>setPromptRequest({...promptRequest,value:e.target.value})} onKeyDown={e=>{if(e.key==='Escape')finishPrompt(null)}}/><div className="panel-actions"><button type="button" className="button secondary" onClick={()=>finishPrompt(null)}>取消</button><button className="button primary" type="submit">确定</button></div></form></div>}
    {showSettings&&settings&&<SettingsDialog initial={settings} close={()=>setShowSettings(false)} saved={s=>{setSettings(s);setNotice('配置已保存到本机')}} onError={fail}/>}
  </div>
}
