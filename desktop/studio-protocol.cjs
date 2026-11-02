// Passive observation of requests made by Studio's own UI. No API requests are
// constructed here. Shapes/paths are from the shipped CN Studio P2.0 frontend.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const GENERATE = '/v2/studio/operation/multiview_to_model'
const PROGRESS = '/v2/studio/progress'
const DETAIL = '/v2/studio/project/detail/v3/'
const FAILED = new Set(['failed', 'banned', 'expired', 'cancelled', 'unknown'])

function apiPath(value) {
  try { const url = new URL(value); return url.origin === 'https://api-cn.tripo3d.com' ? url.pathname : null } catch { return null }
}

function unpack(raw) {
  if (!raw || typeof raw !== 'object' || (raw.code !== undefined && raw.code !== 0)) return null
  return raw.data ?? raw
}

function acceptance(raw) {
  const data = unpack(raw)
  if (!data) return null
  const entries = Array.isArray(data.variations) ? data.variations.filter(item => item.accepted) : [data]
  if (entries.length !== 1 || !UUID.test(entries[0].project_id) || !UUID.test(entries[0].operator_id)) return null
  return { taskId: entries[0].operator_id, remoteProjectId: entries[0].project_id }
}

function detailState(raw, identity) {
  const data = unpack(raw)
  if (!data || data.id !== identity.remoteProjectId) return null
  if (data.running_operator) {
    return data.running_operator.operator_id === identity.taskId ? { pending: true } : { conflict: true }
  }
  if (data.operator?.operator_id !== identity.taskId || data.operator?.is_latest_operator !== true) return { conflict: true }
  if (typeof data.model_url !== 'string' || !data.model_url.startsWith('https://')) return { pending: true }
  return { ready: true, taskId: identity.taskId, remoteProjectId: identity.remoteProjectId }
}

function routeProject(value) {
  try {
    const url = new URL(value)
    if (url.origin !== 'https://studio.tripo3d.com' || !url.pathname.startsWith('/workspace/generate/')) return null
    const id = url.pathname.split('/').at(-1).slice(-36)
    return UUID.test(id) ? id : null
  } catch { return null }
}

module.exports = { UUID, GENERATE, PROGRESS, DETAIL, FAILED, apiPath, unpack, acceptance, detailState, routeProject }
