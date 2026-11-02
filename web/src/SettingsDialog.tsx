import { useState } from 'react'
import { FolderOpen, LockKeyhole, Save, X } from 'lucide-react'
import { api, post, type Provider, type Settings } from './api'

export default function SettingsDialog({ initial, close, saved, onError }: {initial: Settings; close: () => void; saved: (s: Settings) => void; onError: (e: unknown) => void}) {
  const [value, setValue] = useState<Settings>(structuredClone(initial))
  const [saving, setSaving] = useState(false)
  const setProvider = (section: 'llm' | 'image', key: keyof Provider, field: unknown) => setValue(current => ({...current, [section]: {...current[section], [key]: field}}))
  const browse = async (kind: 'executable' | 'template' | 'output') => {
    try { const result = await post<{path: string}>('/browse', {kind}); if (result.path) setValue(v => kind === 'output' ? {...v, output_dir:result.path} : {...v, blender:{...v.blender, [kind]:result.path}}) }
    catch(e) { onError(e) }
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();setSaving(true)
    try { const result = await api<Settings>('/settings', {method:'PUT', body:JSON.stringify(value)}); saved(result); close() }
    catch(e) {onError(e)} finally {setSaving(false)}
  }
  return <div className="modal-backdrop" onClick={close}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="工具设置" onClick={e => e.stopPropagation()}>
    <header><div><span className="eyebrow">YOUR WORKSPACE</span><h2>连接你的创作工具</h2></div><button className="icon-button" aria-label="关闭设置" onClick={close}><X/></button></header>
    <form onSubmit={submit}>
      <div className="settings-grid">{(['llm','image'] as const).map(section => <fieldset key={section}><legend>{section === 'llm' ? '01 / 大语言模型' : '02 / 生图模型'}</legend>
        <label>API Base URL<input required value={value[section].base_url} onChange={e => setProvider(section,'base_url',e.target.value)} placeholder="https://example.com/v1"/></label>
        <label>模型名称<input value={value[section].model} onChange={e => setProvider(section,'model',e.target.value)} placeholder={section === 'llm' ? '填写支持 tools 的模型' : '填写支持生成 / 编辑的图像模型'}/></label>
        <label>API Key<input type="password" autoComplete="new-password" value={value[section].api_key || ''} onChange={e => setProvider(section,'api_key',e.target.value)} placeholder={value[section].has_key ? '已保存 · 留空保留' : '仅保存在本机，加密存储'}/></label>
        {section === 'llm' ? <label className="checkline"><input type="checkbox" checked={!!value.llm.vision} onChange={e => setProvider('llm','vision',e.target.checked)}/>模型支持图片理解（将参考图发送给 LLM）</label> : <div className="two-col"><label>图像尺寸<input value={value.image.size} onChange={e => setProvider('image','size',e.target.value)}/></label><label>响应格式<select value={value.image.response_format} onChange={e => setProvider('image','response_format',e.target.value)}><option value="auto">不传 / 自动</option><option value="b64_json">b64_json</option><option value="url">url</option></select></label></div>}
        <p className="field-note">{section === 'llm' ? '使用 /chat/completions，需支持 tools/tool_choice。' : '无参考图使用 /images/generations；有参考图使用 multipart /images/edits（image[]）。'}</p>
      </fieldset>)}</div>
      <fieldset><legend>03 / Tripo 3D</legend>
        <label>建模方式<select value={value.tripo.mode || 'studio'} onChange={e=>setValue({...value,tripo:{...value.tripo,mode:e.target.value as 'studio'|'api'}})}><option value="studio">网页会员 · 使用 Studio 套餐（推荐）</option><option value="api">开发者 API · 独立计费</option></select></label>
        {value.tripo.mode !== 'api' ? <>
          <div className="settings-grid"><label>智能网格拓扑<select value={value.tripo.studio_topology || 'triangle'} onChange={e=>setValue({...value,tripo:{...value.tripo,studio_topology:e.target.value as 'triangle'|'quad'}})}><option value="triangle">三角面（默认）</option><option value="quad">四边面</option></select></label><label>网页生成面数<input type="number" min={500} max={value.tripo.studio_topology === 'quad' ? 25000 : 50000} step={500} value={value.tripo.studio_face_limit ?? 15000} onChange={e=>setValue({...value,tripo:{...value.tripo,studio_face_limit:Number(e.target.value)}})}/></label></div>
          <p className="field-note">后台上传正 / 侧 / 背三视图，选择智能网格 P2.0，生成 1 个模型并下载 GLB 预览。仅在需要登录时弹窗，登录成功后自动收起并继续；验证或网页异常会提示处理。使用网页会员额度。</p>
        </> : <>
          <div className="settings-grid"><label>API 账号区域<select value={value.tripo.region} onChange={e => setValue({...value,tripo:{...value.tripo,region:e.target.value}})}><option value="cn">国内站 CN</option><option value="ov">海外站 OV</option></select></label><label>API Key（可选，留空使用本地 CLI 登录）<input type="password" autoComplete="new-password" value={value.tripo.api_key || ''} placeholder={value.tripo.has_key ? '已保存 · 留空保留' : '或在终端运行 tripo login'} onChange={e => setValue({...value,tripo:{...value.tripo,api_key:e.target.value}})}/></label><label>API 几何模型<select value={value.tripo.model} onChange={e => setValue({...value,tripo:{...value.tripo,model:e.target.value}})}><option value="tripo-v3.1">H / v3.1 · 标准精细</option><option value="tripo-p1">P1 · 游戏低模</option><option value="tripo-p2">P2 · Preview</option></select></label><label>API 面数预算<input type="number" min={500} max={150000} value={value.tripo.face_limit} onChange={e => setValue({...value,tripo:{...value.tripo,face_limit:Number(e.target.value)}})}/></label></div><p className="field-note">CLI 登录同样消耗 API 积分，不使用网页会员额度。H 系列预算 ≤ 20,000 时自动选 P1。不开启 Tripo 自动绑骨。</p>
        </>}
      </fieldset>
      <fieldset><legend>04 / Blender 与骨架模板</legend>
        <label>Blender 程序<div className="path-input"><input required value={value.blender.executable} onChange={e => setValue({...value,blender:{...value.blender,executable:e.target.value}})}/><button type="button" className="icon-button" title="选择 Blender 程序" onClick={() => void browse('executable')}><FolderOpen size={18}/></button></div></label>
        <label>骨架模板 .blend<div className="path-input"><input required value={value.blender.template} onChange={e => setValue({...value,blender:{...value.blender,template:e.target.value}})}/><button type="button" className="icon-button" title="选择骨架模板" onClick={() => void browse('template')}><FolderOpen size={18}/></button></div></label>
        <div className="settings-grid four"><label>骨架对象<input required value={value.blender.armature} onChange={e => setValue({...value,blender:{...value.blender,armature:e.target.value}})}/></label><label>人体权重源<input required value={value.blender.body} onChange={e => setValue({...value,blender:{...value.blender,body:e.target.value}})}/></label><label>头部权重源（可空）<input value={value.blender.head} onChange={e => setValue({...value,blender:{...value.blender,head:e.target.value}})}/></label><label>最大权重影响<input type="number" min={1} max={8} value={value.blender.influences} onChange={e => setValue({...value,blender:{...value.blender,influences:Number(e.target.value)}})}/></label></div>
        <p className="field-note">可选择 blender-launcher.exe，后台会使用同目录 blender.exe。原模板只读，结果另存为新工程。</p>
      </fieldset>
      <label>输出目录<div className="path-input"><input required value={value.output_dir} onChange={e => setValue({...value,output_dir:e.target.value})}/><button type="button" className="icon-button" title="选择输出目录" onClick={() => void browse('output')}><FolderOpen size={18}/></button></div></label>
      <footer><span><LockKeyhole size={14}/>密钥使用 Windows DPAPI 加密，不发送给设计助手。</span><button type="submit" className="button primary" disabled={saving}><Save size={16}/>{saving ? '保存中…' : '保存设置'}</button></footer>
    </form>
  </section></div>
}
