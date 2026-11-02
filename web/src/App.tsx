import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Box, Check, ChevronDown, CircleHelp, ExternalLink, Fingerprint, ImagePlus, Layers3, LoaderCircle, Plus, RefreshCw, ScanLine, Send, Settings2, ShieldCheck, Sparkles, Upload, WandSparkles, X } from 'lucide-react'
import { api, post, DEFAULT_TRANSFORM, jobLabels, type Asset, type Job, type Project, type Settings, type StudioRun, type Transform } from './api'
import CropEditor from './CropEditor'
import SettingsDialog from './SettingsDialog'
import TripoWorkspace from './TripoWorkspace'

const LazyModelViewer = lazy(() => import('./ModelViewer'))
const ModelViewer = (props: {url?: string; reference?: string}) => <Suspense fallback={<div className="model-viewer"><span className="viewer-label">加载 3D 查看器…</span></div>}><LazyModelViewer {...props}/></Suspense>

const stepNames = ['角色设计', '三视图', '3D 模型', '骨架与蒙皮']
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
  const [step, setStep] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState('')
  const [chat, setChat] = useState('')
  const [pending, setPending] = useState(false)
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
  const chooseProject = useCallback((p: Project) => {
    if(hiddenProjects.current.has(p.id)) return
    projectRef.current = p; setProject(p); setDraft(p.prompt); setTransform(p.alignment?.transform || {...DEFAULT_TRANSFORM}); setJobs([]); setTestPose('rest')
    localStorage.setItem('forge-project', p.id)
  }, [])
  useEffect(() => {
    let valid = true
    Promise.all([api<Settings>('/settings'), api<Project[]>('/projects')]).then(([s, items]) => {
      if (!valid) return
      setSettings(s);setProjects(items)
      const last = localStorage.getItem('forge-project'); const selected = items.find(p => p.id === last) || items[0]
      if(selected) chooseProject(selected)
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
        if(projectRef.current?.id===fresh.id) { projectRef.current=fresh;setProject(fresh);setStep(2) }
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
    let valid = true; let fetching = false; let previous = ''
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
          previous = signature
          const fresh = await api<Project>(`/projects/${id}`)
           if(!valid || hiddenProjects.current.has(id) || projectRef.current?.id!==id) return
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
   const apply = (p: Project) => {if(hiddenProjects.current.has(p.id))return;if(projectRef.current?.id===p.id){projectRef.current=p;setProject(p)}setProjects(items => items.map(item => item.id===p.id?p:item))}
  const removeProject = async (p: Project) => {
    if(deleting || pending) return
    setDeleting(true);setError('')
    hiddenProjects.current.add(p.id)
    try {
      if(window.forgeDesktop) await window.forgeDesktop.deleteProject(p.id)
      else await api(`/projects/${p.id}`,{method:'DELETE'})
      setProjects(items=>items.filter(item=>item.id!==p.id))
      setDeletedProjects(items=>[p,...items])
      if(projectRef.current?.id===p.id) {
        const next=projects.find(item=>item.id!==p.id && !hiddenProjects.current.has(item.id))
        if(next) chooseProject(next)
        else {projectRef.current=undefined;setProject(undefined);setJobs([]);setDraft('');localStorage.removeItem('forge-project')}
        setStep(0);setChat('')
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
      setProjects(items=>[restored,...items.filter(item=>item.id!==p.id)])
      setDeletedProjects(items=>items.filter(item=>item.id!==p.id))
      chooseProject(restored);setStep(0)
    } catch(e) {fail(e)} finally {setDeleting(false)}
  }
  const create = async () => {
    const title=await ask('为这个角色取个名字', '未命名旅人')
    if(title === null) return
    try{const p=await post<Project>('/projects',{title});setProjects(items=>[p,...items]);chooseProject(p);setStep(0)}catch(e){fail(e)}
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
    setPending(true);setError('');setStep(2)
    try { await window.forgeDesktop.automateStudio(project.id,action) }
    catch(e) { fail(e) }
    finally { setPending(false) }
  }
  const start = async (kind: string, extra: Record<string,unknown> = {}) => {
    if(!project || busy) return
    if((kind==='model' || kind==='doctor') && studioMode) { await openStudio(); return }
    if(kind==='image' && !window.confirm('即将向你配置的生图服务发送设计提示词和参考图，可能产生费用。确认生成？')) return
    if(kind==='model' && !window.confirm('即将上传三视图并消耗独立的 Tripo API 积分，不使用网页会员额度。确认提交 API 建模？')) return
    if(kind==='bind' && !window.confirm('已确认角色与绿色模板人体的朝向、比例和关节位置？将转移权重并另存新工程。')) return
    setPending(true);setError('')
    try {
      if(kind==='image' || kind==='chat') await saveDraft()
      const job=await post<Job>(`/projects/${project.id}/jobs`,{kind,confirmed:true,transform,...extra})
      setJobs(items=>[job,...items]);if(kind==='chat') setChat('');if(kind==='image') setStep(1)
    }catch(e){fail(e)}finally{setPending(false)}
  }
  const upload = async (file: File | undefined, kind: string) => {
    if(!project || !file) return
    setPending(true)
    try{const form=new FormData();form.append('file',file);const p=await api<Project>(`/projects/${project.id}/upload?kind=${kind}`,{method:'POST',body:form});apply(p);if(kind==='sheet')setStep(1);if(kind==='model')setStep(2)}catch(e){fail(e)}finally{setPending(false)}
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
  const modelURL = project?.rig && step===3 ? (testPose==='rest' ? project.rig.assets.glb?.url : project.rig.tests.find(t=>t.name===testPose)?.asset.url) : project?.model?.url
  const validAlignment = project?.alignment && JSON.stringify(project.alignment.transform) === JSON.stringify(transform)
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/" aria-label="角色工坊首页"><div className="brand-symbol"><Fingerprint size={27}/></div><div>角色工坊<span>CHARACTER FORGE</span></div></a>
      <div className="workspace-label">本地工作空间 <span className="live-dot"/></div>
      <button className="new-project" onClick={() => void create()}><Plus size={18}/>创建新角色</button>
      <div className="nav-caption">角色项目 <span>{projects.length.toString().padStart(2,'0')}</span></div>
      <nav className="project-list">{projects.map(p=><div className="project-entry" key={p.id}><button className={project?.id===p.id?'active':''} onClick={()=>chooseProject(p)}><span className="project-glyph"><Box size={17}/></span><span>{p.title}<small>{new Date(p.updated).toLocaleDateString('zh-CN')}</small></span>{project?.id===p.id&&<span className="selected-dot"/>}</button><button className="delete-project" aria-label={`删除角色 ${p.title}`} title="删除角色（可撤销）" disabled={deleting||pending||!!studioRuns[p.id]?.active||(project?.id===p.id&&jobs.some(activeStatus))} onClick={()=>void removeProject(p)}><X size={15}/></button></div>)}{!projects.length&&<p className="sidebar-empty">每个好角色，<br/>都从一个想法开始。</p>}</nav>
      <div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={17}/><div>你的模板，始终安全<small>原文件只读 · 结果独立保存</small></div></div><button onClick={()=>setShowSettings(true)} disabled={!settings}><Settings2 size={17}/>模型与工具设置</button><div className="sidebar-version">LOCAL FIRST <span>v0.1.0</span></div></div>
    </aside>
    <main className="main-shell"><header className="topbar"><div className="breadcrumb">工作空间 <span>/</span> <strong>{project?.title || '开始创作'}</strong><ChevronDown size={13}/></div><div className="row"><span className="local-badge"><span className="live-dot"/> 本地运行</span><button className="icon-button" title="设置" onClick={()=>setShowSettings(true)} disabled={!settings}><Settings2 size={19}/></button></div></header>
      {error&&<div role="alert" className="toast error"><span>{error}</span><button aria-label="关闭错误" onClick={()=>setError('')}><X size={16}/></button></div>}
      {!!deletedProjects.length&&<div role="status" className="delete-notice"><span>已删除「{deletedProjects[0].title}」</span><button className="button secondary compact" disabled={deleting} onClick={()=>void undoDelete()}>撤销删除</button></div>}
      {notice&&<div role="status" className="toast success"><span>{notice}</span><button aria-label="关闭提示" onClick={()=>setNotice('')}><X size={16}/></button></div>}
      {!project ? <div className="welcome"><span className="eyebrow">FROM AN IDEA TO A CHARACTER</span><h1>让想象，<br/>有形可见。</h1><p>从参考图到三视图，从 3D 模型到你的专属骨架。<br/>把繁琐交给工具，把创造留给自己。</p><button className="button primary" onClick={()=>void create()}><Plus size={17}/>创建第一个角色<ArrowRight size={17}/></button><div className="welcome-process"><span><ImagePlus/>角色构想</span><i/><span><Layers3/>一致三视图</span><i/><span><Box/>三维重建</span><i/><span><Fingerprint/>骨架蒙皮</span></div><span className="welcome-watermark">形 / FORM</span></div> : <>
      <div className="page-heading"><div><span className="eyebrow">CHARACTER STUDIO / 角色工作台</span><h1>{project.title}</h1><p>从一张灵感参考，到一个可以动起来的角色。</p></div><div className="project-tag"><span className="live-dot"/>人形角色 · 自定义骨架</div></div>
      <nav className="steps" aria-label="生成阶段">{stepNames.map((name,i)=><button key={name} className={step===i?'active':''} onClick={()=>setStep(i)}><span className="step-number">{(i===0&&project.prompt)||(i===1&&Object.keys(project.views).length)||(i===2&&project.model)||(i===3&&project.rig)?<Check size={14}/>:String(i+1).padStart(2,'0')}</span>{name}{i<3&&<span className="step-line"/>}</button>)}</nav>
      <div className="studio-layout"><div className="work-area">
        {currentJob&&<div className="running-job"><LoaderCircle className="spin" size={18}/><div><strong>{jobLabels[currentJob.kind]}</strong><span>{currentJob.message}</span></div><span>{currentJob.progress || 0}%</span><div className="job-progress" style={{width:`${Math.max(currentJob.progress||0,3)}%`}}/></div>}
        {step===0&&<>
          <section className="panel design-panel"><div className="section-title"><div><span className="eyebrow">01 / THE IDEA</span><h2>先给想象一个轮廓。</h2></div><WandSparkles size={24} strokeWidth={1}/></div><p className="muted">描述你心中的角色，也可以让右侧设计助手一起完善细节。</p>
            <label className="input-label" htmlFor="design-prompt">角色设计提示词 <span>可直接编辑，无需先调用大语言模型</span></label><textarea id="design-prompt" className="prompt-editor" value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)} placeholder="例如：一位行走在荒野的年轻游侠，黑色短发，暗红色不对称披风，米白色内衬与棕色皮革腰带。完整人形角色，保留左肩的金色徽章……"/>
            <div className="design-options"><label>中间视图<select value={project.side} disabled={busy} onChange={e=>void api<Project>(`/projects/${project.id}`,{method:'PATCH',body:JSON.stringify({side:e.target.value})}).then(apply).catch(fail)}><option value="left">角色左侧</option><option value="right">角色右侧</option></select></label><div className="pose-note"><ScanLine size={17}/><span>{project.inspection ? '已检测模板静止姿态' : '建议先检测骨架模板，让生图参考静止姿态'}</span></div></div>
            <div className="panel-actions"><button className="button secondary" disabled={busy} onClick={()=>void saveDraft().then(()=>setNotice('设计已保存')).catch(fail)}>保存设计</button><button className="button primary" disabled={busy||!draft.trim()} onClick={()=>void start('image')}><Sparkles size={16}/>生成三视图<ArrowRight size={16}/></button></div>
          </section>
          <section className="panel"><div className="section-title"><div><span className="eyebrow">REFERENCE BOARD</span><h2>灵感，来自这里。</h2></div><span className="counter">{project.references.length} / 8</span></div><p className="muted">支持 PNG、JPG、WebP。参考图会发送给生图服务；不会自动上传给其他服务。</p><div className="reference-grid">{project.references.map(ref=><div className="reference-card" key={ref.id}><img src={ref.url} alt="角色参考图"/><button aria-label="移除参考图" disabled={busy} onClick={()=>void api<Project>(`/projects/${project.id}/references/${ref.id}`,{method:'DELETE'}).then(apply).catch(fail)}><X size={14}/></button></div>)}<button className="reference-upload" disabled={busy||project.references.length>=8} onClick={()=>refsInput.current?.click()}><ImagePlus size={25} strokeWidth={1.3}/><strong>添加参考图</strong><span>点击选择 · 最多 25 MB</span></button></div></section>
        </>}
        {step===1&&<>
          <section className="panel"><div className="row between"><div><span className="eyebrow">02 / CONSISTENT VIEWS</span><h2>从三个角度，认识你的角色。</h2></div><button className="button secondary" disabled={busy} onClick={()=>sheetInput.current?.click()}><Upload size={15}/>导入三视图</button></div>
          {imageWorking&&<p role="status" className="inline-warning">正在生成新的三视图，完成后会自动替换预览。{project.sheet ? '下方是上次结果，不是本次新图。' : ''}</p>}
          {imageFailed&&<div role="alert" className="inline-warning"><strong>本次三视图未生成成功：</strong>{imageJob.message}{project.sheet&&<p>下方保留的是上次结果，不是本次新图。</p>}</div>}
          {!project.sheet?<div className="sheet-empty"><Layers3 size={50} strokeWidth={1}/><h3>正面 · 侧面 · 背面</h3><p>统一姿态、统一比例、完整身体。<br/>生成后可以校正裁切框，单独保存每个视图。</p><button className="button primary" disabled={busy||!draft.trim()} onClick={()=>void start('image')}><Sparkles size={16}/>生成角色三视图</button></div>:<><CropEditor project={project} disabled={busy} onSave={crop}/><div className="panel-actions"><span className="muted">不满意？在设计页修改提示词后重新生成。</span><button className="button ghost" disabled={busy||!draft.trim()} onClick={()=>void start('image')}><RefreshCw size={14}/>重新生成（计费）</button></div></>}
          </section>
          {!!Object.keys(project.views).length&&<section className="panel"><div className="section-title"><div><span className="eyebrow">READY FOR RECONSTRUCTION</span><h2>检查完毕，进入三维。</h2></div><span className="pill">1024 × 1024</span></div><div className="views-grid">{Object.entries(project.views).map(([label,asset])=><div key={label}><img src={asset.url} alt={viewNames[label]}/><div><span>{viewNames[label]}</span><a href={asset.url+'?download=true'} aria-label={'下载'+viewNames[label]}><ArrowDownToLine size={16}/></a></div></div>)}</div>{project.view_warnings?.map(w=><div className="inline-warning" key={w}>{w}</div>)}<div className="panel-actions"><span className="muted">{studioMode ? '使用 Tripo 网页会员额度，在网页内上传并生成。' : '使用独立 API 积分上传三视图并生成。'}</span><button className="button primary" disabled={busy} onClick={()=>{setStep(2);void start('model')}}><Box size={16}/>{studioMode ? '前往 Tripo 会员工作台' : 'API 生成 3D 模型'}<ArrowRight size={16}/></button></div></section>}
        </>}
        {step===2&&<section className="panel model-panel"><div className="section-title"><div><span className="eyebrow">03 / INTO THE THIRD DIMENSION</span><h2>让轮廓，成为实体。</h2></div><button className="button secondary" disabled={busy} onClick={()=>modelInput.current?.click()}><Upload size={15}/>导入 GLB</button></div>
          <TripoWorkspace project={project} studio={studioMode} busy={busy} open={()=>void openStudio()} prepare={()=>setStep(1)} settings={()=>setShowSettings(true)} config={settings?.tripo} run={studioRun} automate={action=>void automateStudio(action)}/>
          <ModelViewer url={project.model?.name.endsWith('.glb')?project.model.url:undefined}/>{project.model_preview&&<details className="preview-details"><summary>查看 Tripo 服务端预览图</summary><img src={project.model_preview.url} alt="Tripo 预览"/></details>}<div className="panel-actions"><div className="row wrap">{project.model&&download(project.model,'下载原始模型')}{!studioMode&&<button className="button ghost" disabled={busy||!Object.keys(project.views).length} onClick={()=>void start('model')}><RefreshCw size={14}/>{project.model?'API 重新建模（计费）':'API 从三视图生成模型'}</button>}</div><button className="button primary" disabled={!project.model||busy} onClick={()=>setStep(3)}>适配我的骨架<ArrowRight size={16}/></button></div></section>}
        {step===3&&<>
          <section className="panel"><div className="section-title"><div><span className="eyebrow">04 / MADE TO MOVE</span><h2>让角色，用你的骨架动起来。</h2></div><button className="button secondary" disabled={busy} onClick={()=>void start('inspect')}><ScanLine size={15}/>检测模板</button></div><div className="template-path"><Fingerprint size={20}/><div><strong>{settings?.blender.armature || '_COM'}</strong><span>{settings?.blender.template}</span></div><button className="icon-button" title="修改模板路径" onClick={()=>setShowSettings(true)}><Settings2 size={16}/></button></div>
          {project.inspection&&<><div className="inspection-stats"><div><strong>{project.inspection.bone_count}</strong><span>骨骼</span></div><div><strong>{project.inspection.sources.reduce((sum,s)=>sum+s.vertices,0).toLocaleString()}</strong><span>权重源顶点</span></div><div><strong>{project.inspection.height.toFixed(2)} m</strong><span>模板高度</span></div><div><strong>{project.inspection.actions.length}</strong><span>保留动作数据</span></div></div><p className="field-note">静止姿态：{project.inspection.pose_hint}</p></>}
          <h3 className="subheading">先对齐，再转移权重</h3><p className="muted">默认按身高等比缩放并脚底对齐。请旋转模型匹配人体朝向，检查肩、肘、髋、膝位置；不自动改变原骨架。</p><div className="transform-grid">{Object.entries(transform).map(([key,value])=><label key={key}>{{rotation_x:'X 旋转 °',rotation_y:'Y 旋转 °',rotation_z:'Z 旋转 °',scale:'相对缩放',offset_x:'X 偏移 m',offset_y:'Y 偏移 m',offset_z:'Z 偏移 m'}[key]}<input type="number" step={key.startsWith('rotation')?90:.01} value={value} disabled={busy} onChange={e=>setTransform({...transform,[key]:Number(e.target.value)})}/></label>)}</div><div className="row wrap"><button className="button secondary" disabled={busy||!project.model} onClick={()=>void start('align')}><ScanLine size={16}/>生成对齐预览</button><button className="button ghost" disabled={busy} onClick={()=>setTransform({...DEFAULT_TRANSFORM})}>重置参数</button></div>
          {project.alignment&&<><div className="small-gap"/><ModelViewer url={project.alignment.assets.aligned?.url} reference={project.alignment.assets.reference?.url}/>{!validAlignment&&<div className="inline-warning">参数已修改，请重新生成预览。蒙皮只使用已预览的参数。</div>}<div className="panel-actions"><span className="muted">绿色线框为原人体，仅作对齐参考。</span><button className="button primary" disabled={busy||!validAlignment} onClick={()=>void start('bind')}><Fingerprint size={16}/>确认对齐，开始蒙皮</button></div></>}
          </section>
          {project.rig&&<section className="panel"><div className="section-title"><div><span className="eyebrow">SKINNING REVIEW</span><h2>检查每一个动作细节。</h2></div><span className="pill">模板已保护</span></div><div className="pose-tabs">{[{name:'rest',label:'静止姿态'},...project.rig.tests.map(t=>({name:t.name,label:({elbow:'屈肘测试',knee:'屈膝测试',shoulder:'肩部测试'} as Record<string,string>)[t.name]||t.name}))].map(t=><button className={testPose===t.name?'active':''} key={t.name} onClick={()=>setTestPose(t.name)}>{t.label}</button>)}</div><ModelViewer url={modelURL}/>{project.rig.warnings?.map(w=><div className="inline-warning" key={w}>{w}</div>)}<div className="weight-report">{project.rig.weights?.map(w=><div key={w.name}><span>{w.name}</span><span>{w.vertices.toLocaleString()} 顶点</span><span className={w.unweighted?'warning-text':'good-text'}>未绑定 {w.unweighted}</span><span>远离人体 {w.far_from_source}</span></div>)}</div><div className="panel-actions"><div className="row wrap">{Object.entries(project.rig.assets).map(([key,asset])=>download(asset,key.toUpperCase()))}</div><button className="button primary" onClick={()=>void post(`/projects/${project.id}/open-blender`).then(()=>setNotice('已启动 Blender 打开生成的工程')).catch(fail)}><ExternalLink size={15}/>在 Blender 中打开</button></div><p className="field-note">静态屈曲预览用于发现问题，不代表通过生产验收。复杂服饰、手指及体型差异仍可能需要人工修正。</p></section>}
        </>}
        <section className="task-history"><details open={jobs.some(j=>['failed','uncertain','interrupted'].includes(j.status))}><summary>任务记录 <span>{jobs.length}</span></summary>{jobs.length===0?<p className="muted">还没有任务。每次生成和处理都会记录在这里。</p>:jobs.slice(0,20).map(job=><div className="task-row" key={job.id}><span className={'status-dot '+job.status}/><div><strong>{jobLabels[job.kind]||job.kind}<small>{new Date(job.created).toLocaleTimeString('zh-CN')}</small></strong><p>{job.message}</p>{job.remote_id&&<code>{job.remote_id}</code>}{job.result?.credits!=null&&<small>实际消耗：{job.result.credits} 积分</small>}</div>{['model','resume'].includes(job.kind)&&!activeStatus(job)&&job.status!=='success'&&<button className="button secondary compact" disabled={busy} onClick={()=>void resume(job)}><RefreshCw size={13}/>恢复查询</button>}{job.result?.assets&&<div className="history-assets">{Object.entries(job.result.assets).map(([key,asset])=><a key={asset.id} href={asset.url+'?download=true'}>{key}</a>)}</div>}</div>)}</details></section>
      </div>
      <aside className="assistant-panel"><div className="assistant-header"><span className="assistant-symbol"><Sparkles size={18}/></span><div><h3>角色设计助手</h3><span>一起，把想法打磨得更好。</span></div></div><div className="assistant-messages">{!project.messages.length?<div className="assistant-intro"><span className="eyebrow">A LITTLE INSPIRATION</span><h3>你想创造一个<br/>怎样的角色？</h3><p>告诉我角色的故事、风格与服装。我会整理为可编辑的设计提示词，不会擅自提交生图或建模。</p><button disabled={busy} onClick={()=>setChat('帮我设计一位风格化奇幻游侠，强调不对称披风和可辨识的轮廓。')}>奇幻游侠，辨识度鲜明 <ArrowRight size={13}/></button><button disabled={busy} onClick={()=>setChat('请基于我的参考图完善完整角色设计，保留服装配色和不对称细节，并补充背面结构。')}>根据参考图完善设计 <ArrowRight size={13}/></button></div>:project.messages.map((m,i)=><div key={i} className={'chat-message '+m.role}><span>{m.role==='user'?'你':'设计助手'}</span><p>{m.content}</p></div>)}</div><form className="chat-form" onSubmit={e=>{e.preventDefault();void start('chat',{message:chat})}}><textarea aria-label="发给设计助手的消息" value={chat} onChange={e=>setChat(e.target.value)} disabled={busy} placeholder="描述想法，或告诉我哪里需要修改…"/><div><span>{settings?.llm.model||'请先在设置中配置 LLM'}</span><button aria-label="发送设计消息" disabled={busy||!chat.trim()||!settings?.llm.model}><Send size={16}/></button></div></form><div className="assistant-disclaimer"><ShieldCheck size={12}/>生成、上传和本地处理由你确认后执行。</div><div className="template-mini"><div className="row"><Fingerprint size={16}/><strong>你的骨架模板</strong></div><p>{settings?.blender.armature||'_COM'} <span>·</span> {project.inspection?`${project.inspection.bone_count} 根骨骼`:'等待检测'}</p><button disabled={busy} onClick={()=>void start('inspect')}>只读检测模板 <ArrowRight size={13}/></button><button disabled={busy} onClick={()=>void start('doctor')}>检查 Tripo 连接 <ArrowRight size={13}/></button></div></aside></div>
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
