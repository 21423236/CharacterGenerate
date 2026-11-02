import { ExternalLink, LoaderCircle, Pause, Play, Settings2 } from 'lucide-react'
import type { Project, Settings, StudioRun } from './api'

export default function TripoWorkspace({ project, studio, busy, open, prepare, settings, config, run, automate }: { project: Project; studio: boolean; busy: boolean; open: () => void; prepare: () => void; settings: () => void; config?: Settings['tripo']; run?: StudioRun; automate: (action: 'start'|'resume'|'pause'|'cancel') => void }) {
  const unfinished = run && !['complete', 'failed', 'cancelled'].includes(run.status)
  const missing = ['front', project.side, 'back'].filter(label => !project.views[label])
  const missingNames = missing.map(label => ({ front: '正面', left: '左侧', right: '右侧', back: '背面' })[label]).join('、')
  const inputMessage = project.sheet ? `尚未准备好${missingNames}图。请先确认裁切，保存三张视图后再生成模型。` : `此${project.parent_id?'部件':'角色'}还没有三视图。请先生成或导入三视图，再确认裁切。`
  return <div className="tripo-workspace">
    <div className="row between"><strong>{studio ? 'Tripo 网页会员模式' : 'Tripo API 模式'}</strong><button className="button ghost compact" onClick={settings}><Settings2 size={14}/>切换模式</button></div>
    {!!missing.length&&!unfinished&&<div className="inline-warning" role="status"><p>{inputMessage}</p><button className="button secondary" disabled={busy} onClick={prepare}>前往裁切确认</button></div>}
    {studio ? <>
      <p><strong>智能网格 P2.0 · {(config?.studio_topology || 'triangle') === 'triangle' ? '三角面' : '四边面'} · {(config?.studio_face_limit ?? 15000).toLocaleString()} 面 · 生成 1 个</strong></p>
      <p>后台上传三视图并生成，完成后直接显示模型。使用网页会员额度。</p>
      <p>需要登录时会自动弹出窗口，登录成功后自动收起并继续。遇到验证或网页异常时再提示处理。</p>
      {run&&<div className="studio-run" role="status"><div className="row">{run.active&&<LoaderCircle size={15} className="spin"/>}<strong>{run.message}</strong></div>{run.taskId&&<small>已保存本次生成版本 · {run.taskId}</small>}</div>}
      {!window.forgeDesktop && <p className="inline-warning">当前为普通浏览器版。双击 start-desktop.cmd 可使用内置工作台和下载回填；也可以在网站生成后使用“导入 GLB”。</p>}
      <div className="row wrap">{window.forgeDesktop?.automateStudio&&<>
        {run?.active ? <button className="button secondary" onClick={()=>automate('pause')}><Pause size={15}/>暂停自动操作</button> : unfinished ? <button className="button primary" disabled={busy} onClick={()=>automate('resume')}><Play size={15}/>继续任务</button> : <button className="button primary" disabled={busy||!!missing.length} title={missing.length ? inputMessage : busy ? '请等待当前任务完成' : undefined} onClick={()=>automate('start')}><Play size={15}/>一键生成并预览</button>}
        {unfinished&&!run.active&&!run.submitted&&<button className="button ghost" disabled={busy} onClick={()=>automate('cancel')}>取消未提交任务</button>}
      </>}<button className="button secondary" disabled={busy&&!run?.active} onClick={open}><ExternalLink size={16}/>{window.forgeDesktop ? '打开内置 Tripo 工作台' : '打开 Tripo 会员网页'}</button>{Object.entries(project.views).map(([label, asset]) => <a className="button secondary compact" key={label} href={asset.url + '?download=true'}>下载{{ front: '正面', left: '左侧', right: '右侧', back: '背面' }[label]}图</a>)}</div>
    </> : <p>API 使用独立积分；CLI 浏览器登录也不消耗 Studio 会员额度。下方按钮会提交 API 建模任务。</p>}
  </div>
}
