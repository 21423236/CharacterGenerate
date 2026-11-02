import { useEffect, useRef, useState } from 'react'
import { Check, Move, RotateCcw } from 'lucide-react'
import type { Project } from './api'

export default function CropEditor({ project, disabled, onSave }: { project: Project; disabled: boolean; onSave: (boxes: number[][], labels: string[]) => Promise<void> }) {
  const [boxes, setBoxes] = useState(project.boxes || [[0, 0, 1/3, 1], [1/3, 0, 2/3, 1], [2/3, 0, 1, 1]])
  const [labels, setLabels] = useState(['front', project.side || 'left', 'back'])
  const [active, setActive] = useState(0)
  const [checked, setChecked] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const origin = useRef<[number, number] | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  useEffect(() => { setBoxes(project.boxes || [[0, 0, 1/3, 1], [1/3, 0, 2/3, 1], [2/3, 0, 1, 1]]); setLabels(['front', project.side || 'left', 'back']); setChecked(false) }, [project.sheet?.id])
  const point = (event: React.PointerEvent) => {
    const rect = frame.current!.getBoundingClientRect()
    return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))] as [number, number]
  }
  const move = (event: React.PointerEvent) => {
    if (!origin.current || disabled) return
    const [x, y] = point(event), [ox, oy] = origin.current
    setBoxes(current => current.map((b, i) => i === active ? [Math.min(x, ox), Math.min(y, oy), Math.max(x, ox), Math.max(y, oy)] : b)); setChecked(false)
  }
  return <div className="crop-editor">
    <div className="section-title"><div><span className="eyebrow">TURNAROUND / 三视图</span><h2>每个角度，同一个角色。</h2></div><span className="subtle"><Move size={14} /> 选中视图后可拖动重画裁切框</span></div>
    <div className={'sheet-frame ' + (drawing ? 'drawing' : '')} ref={frame}
      onPointerDown={e => { if (!drawing || disabled) return; e.preventDefault(); origin.current = point(e); e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={move} onPointerUp={e => { move(e); origin.current = null }}>
      <img src={project.sheet!.url} alt="待拆分角色三视图" draggable={false} />
      {boxes.map((b, i) => <div key={i} className={'crop-box color-' + i + (active === i ? ' selected' : '')} style={{left: `${b[0]*100}%`, top: `${b[1]*100}%`, width: `${(b[2]-b[0])*100}%`, height: `${(b[3]-b[1])*100}%`}}><span>{i + 1} · {{front:'正面', left:'左侧', right:'右侧', back:'背面'}[labels[i]]}</span></div>)}
    </div>
    <div className="crop-controls">{boxes.map((box, i) => <div className={'crop-control ' + (active === i ? 'active' : '')} key={i}>
      <button className="crop-index" onClick={() => setActive(i)}>视图 0{i+1}</button>
      <select aria-label={`视图${i+1}方向`} value={labels[i]} onChange={e => {setLabels(labels.map((v,j) => j === i ? e.target.value : v));setChecked(false)}} disabled={disabled}><option value="front">正面 Front</option><option value="left">左侧 Left</option><option value="right">右侧 Right</option><option value="back">背面 Back</option></select>
      <div className="coords">{box.map((v,j) => <label key={j}>{['左','上','右','下'][j]}<input aria-label={`视图${i+1}${['左','上','右','下'][j]}`} type="number" min="0" max="100" step="0.1" value={Number((v*100).toFixed(1))} disabled={disabled} onChange={e => {setBoxes(boxes.map((b,k) => k===i ? b.map((a,n) => n===j ? Number(e.target.value)/100 : a) : b));setChecked(false)}} /></label>)}</div>
    </div>)}</div>
    <div className="row wrap"><button className={'button secondary ' + (drawing ? 'toggled' : '')} onClick={() => setDrawing(!drawing)} disabled={disabled}><Move size={15}/>{drawing ? '结束重画' : '拖动重画'}</button><button className="button ghost" onClick={() => {setBoxes([[0,0,1/3,1],[1/3,0,2/3,1],[2/3,0,1,1]]);setChecked(false)}} disabled={disabled}><RotateCcw size={14}/>等分重置</button></div>
    <label className="checkline"><input type="checkbox" checked={checked} disabled={disabled} onChange={e => setChecked(e.target.checked)}/>我已确认三个视图属于同一角色，身体完整，方向标签正确（左右按角色自身）。</label>
    <button className="button primary" disabled={!checked || disabled} onClick={() => void onSave(boxes, labels)}><Check size={16}/>确认并拆分为三张图</button>
  </div>
}
