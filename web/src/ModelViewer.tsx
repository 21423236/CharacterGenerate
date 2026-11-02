import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Rotate3d } from 'lucide-react'

export default function ModelViewer({ url, reference }: { url?: string; reference?: string }) {
  const mount = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!url || !mount.current) return
    setError(''); setLoading(true)
    const container = mount.current
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }) }
    catch { setError('无法启用 WebGL，请尝试更新显卡驱动或开启浏览器硬件加速'); setLoading(false); return }
    let disposed = false
    let frame = 0
    const controller = new AbortController()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    container.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#e5e8df')
    const camera = new THREE.PerspectiveCamera(35, 1, .01, 1000)
    camera.position.set(2, 1.6, 3)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    scene.add(new THREE.HemisphereLight(0xffffff, 0x83917b, 2.5))
    const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(3, 5, 4); scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 1.5); fill.position.set(-3, 2, -2); scene.add(fill)
    const grid = new THREE.GridHelper(10, 40, 0xaebba7, 0xcad2c3); scene.add(grid)
    const manager = new THREE.LoadingManager()
    // No external model resources, tracking pixels or remote textures are permitted.
    manager.setURLModifier(resource => {
      if (resource.startsWith('blob:') || resource.startsWith('data:')) return resource
      throw new Error('模型引用了外部资源，请使用自包含 GLB')
    })
    const loader = new GLTFLoader(manager)
    const disposeObject = (root: THREE.Object3D) => root.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return
      obj.geometry.dispose()
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const material of materials) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose()
        material.dispose()
      }
    })
    const load = async (address: string) => {
      const response = await fetch(address, { signal: controller.signal })
      if (!response.ok) throw new Error('模型文件读取失败')
      return loader.parseAsync(await response.arrayBuffer(), '')
    }
    const start = async () => {
      try {
        const model = await load(url)
        if (disposed) { disposeObject(model.scene); return }
        scene.add(model.scene)
        const bounds = new THREE.Box3().setFromObject(model.scene)
        const center = bounds.getCenter(new THREE.Vector3())
        const size = bounds.getSize(new THREE.Vector3())
        const span = Math.max(size.x, size.y, size.z, .01)
        camera.near = span / 1000; camera.far = span * 100; camera.updateProjectionMatrix()
        camera.position.copy(center).add(new THREE.Vector3(span * .9, span * .25, span * 1.9))
        controls.target.copy(center)
        grid.position.set(center.x, bounds.min.y, center.z); grid.scale.setScalar(span / 3)
        if (reference) {
          const ghost = await load(reference)
          if (disposed) { disposeObject(ghost.scene); return }
          ghost.scene.traverse(obj => {
            if (obj instanceof THREE.Mesh) {
              const old = Array.isArray(obj.material) ? obj.material : [obj.material]
              old.forEach(m => m.dispose())
              obj.material = new THREE.MeshBasicMaterial({ color: 0x13805b, wireframe: true, transparent: true, opacity: .5, depthTest: false })
            }
          })
          scene.add(ghost.scene)
        }
        setLoading(false)
      } catch (e) {
        if (!disposed) { setError(e instanceof Error ? e.message : '模型加载失败'); setLoading(false) }
      }
    }
    void start()
    const resize = () => {
      const { width, height } = container.getBoundingClientRect()
      renderer.setSize(width, Math.max(height, 1)); camera.aspect = width / Math.max(height, 1); camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize); observer.observe(container); resize()
    const animate = () => { if (disposed) return; frame = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera) }
    animate()
    return () => {
      disposed = true; controller.abort(); cancelAnimationFrame(frame); observer.disconnect(); controls.dispose()
      disposeObject(scene); renderer.dispose(); renderer.domElement.remove()
    }
  }, [url, reference])
  return <div className="model-viewer" ref={mount}>
    {!url && <div className="viewer-empty"><Rotate3d size={42} strokeWidth={1} /><h3>模型将在这里预览</h3><p>确认三视图裁切后生成模型，或导入已有 GLB</p></div>}
    {loading && <span className="viewer-label">正在加载模型…</span>}
    {error && <span className="viewer-error">{error}</span>}
    {url && !error && <span className="viewer-label">拖动旋转 · 滚轮缩放{reference ? ' · 绿色线框为模板人体' : ''}</span>}
  </div>
}
