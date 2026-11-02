import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function ZoomImage({src, alt}: {src: string; alt: string}) {
  const [open, setOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(()=>{
    if(!open)return
    dialog.current?.showModal()
    const overflow=document.body.style.overflow
    document.body.style.overflow='hidden'
    return()=>{document.body.style.overflow=overflow}
  },[open])
  return <>
    <button className="image-zoom" type="button" aria-label={`放大查看 ${alt}`} title="点击放大查看" onClick={()=>{setZoom(1);setOpen(true)}}><img src={src} alt={alt}/><span>点击放大</span></button>
    {open&&createPortal(<dialog ref={dialog} className="image-viewer-dialog" aria-label={`${alt}大图预览`} onClose={()=>setOpen(false)} onClick={e=>{if(e.target===e.currentTarget)dialog.current?.close()}}>
      <div className="image-viewer-toolbar"><strong>{alt}</strong><div className="row"><button type="button" aria-label="缩小图片" disabled={zoom<=1} onClick={()=>setZoom(v=>Math.max(1,v-.5))}>−</button><span>{Math.round(zoom*100)}%</span><button type="button" aria-label="放大图片" disabled={zoom>=4} onClick={()=>setZoom(v=>Math.min(4,v+.5))}>＋</button><button type="button" onClick={()=>setZoom(1)}>适应窗口</button><button autoFocus type="button" aria-label="关闭大图预览" onClick={()=>dialog.current?.close()}>关闭 ×</button></div></div>
      <div className="image-viewer-scroll"><div style={{width:`${zoom*100}%`,height:`${zoom*100}%`}}><img src={src} alt={`${alt}放大预览`} draggable={false}/></div></div>
    </dialog>,document.body)}
  </>
}
