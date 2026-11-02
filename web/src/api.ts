export type Asset = { id: string; name: string; kind: string; url: string }
export type Transform = { rotation_x: number; rotation_y: number; rotation_z: number; scale: number; offset_x: number; offset_y: number; offset_z: number }
export const DEFAULT_TRANSFORM: Transform = { rotation_x: 0, rotation_y: 0, rotation_z: 0, scale: 1, offset_x: 0, offset_y: 0, offset_z: 0 }
export type Inspection = { armature: string; bone_count: number; height: number; pose_hint: string; sources: {name: string; vertices: number; unweighted: number}[]; actions: string[]; warnings: string[]; mesh_candidates: string[] }
export type Rig = { assets: Record<string, Asset>; warnings: string[]; weights: { name: string; vertices: number; unweighted: number; far_from_source: number }[]; tests: { name: string; asset: Asset }[] }
export type Project = {
  parent_id?: string; part_kind?: string; part_image?: Asset; split_model?: boolean; binding_mode?: 'surface' | 'rigid'; binding_bone?: string;
  part_suggestions?: {title: string; kind: string}[];
  part_edit_prompt?: string;
  model_face_limit?: number | null;
  id: string; title: string; prompt: string; side: 'left' | 'right'; updated: string;
  references: Asset[]; sheet?: Asset; boxes?: number[][]; views: Record<string, Asset>;
  messages: { role: string; content: string }[]; inspection?: Inspection;
  model?: Asset; model_preview?: Asset; alignment?: { assets: Record<string, Asset>; transform: Transform; model_id: string }; rig?: Rig; view_warnings?: string[]
}
export type Job = { id: string; kind: string; status: string; message?: string; progress?: number; remote_id?: string; created: string; result?: { assets?: Record<string, Asset>; credits?: number; message?: string } }
export type Provider = { base_url: string; model: string; api_key?: string; has_key?: boolean; vision?: boolean; size?: string; response_format?: string }
export type Settings = {
  llm: Provider; image: Provider;
  tripo: { mode: 'studio' | 'api'; region: string; api_key?: string; has_key?: boolean; model: string; face_limit: number; studio_topology: 'triangle' | 'quad'; studio_face_limit: number };
  blender: { executable: string; template: string; armature: string; body: string; head: string; influences: number };
  output_dir: string
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Forge-Request': 'local-ui', ...options.headers as Record<string, string> }
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const response = await fetch('/api' + path, { ...options, headers })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(typeof data.detail === 'string' ? data.detail : `请求失败 (${response.status})，请检查配置和输入`)
  }
  return response.json()
}

export const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) })
export const jobLabels: Record<string, string> = { parts_plan: '识别部件清单', part_image: '生成独立部件图', assemble: '组装部件与统一绑定', chat: '设计助手', inspect: '模板检测', image: '生成三视图', model: 'API 多视图建模', studio_import: 'Tripo 网页模型导入', align: '对齐预览', bind: '权重转移', resume: '恢复查询', doctor: 'Tripo API 检查' }
jobLabels.part_edit = '按提示词修改部件图'

declare global {
  interface Window {
    forgeDesktop?: {
      deleteProject: (projectId: string) => Promise<void>;
      openStudio: (projectId: string) => Promise<void>;
      automateStudio: (projectId: string, action: 'start' | 'resume' | 'pause' | 'cancel') => Promise<void>;
      studioState: (projectId: string) => Promise<StudioRun | null>;
      onStudioState: (callback: (state: StudioRun) => void) => () => void;
    }
  }
}

export type StudioRun = { projectId: string; runId: string; status: string; stage: string; message: string; faces: number; topology: 'triangle' | 'quad'; submitted: boolean; taskId?: string; active: boolean; updated: string }
