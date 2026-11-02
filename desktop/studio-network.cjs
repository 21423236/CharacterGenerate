const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const exec = promisify(execFile)
const ENDPOINTS = [
  'https://auth-cn.tripo3d.com/idp-ext/auth/check-identifier',
  'https://api-cn.tripo3d.com/v2/studio/user/profile/detail',
  'https://msapi.tripo3d.com/tripo.subscription.api.assets.AssetsApi/GetAssets',
]

async function windowsProxy() {
  if (process.platform !== 'win32') return null
  const { stdout } = await exec('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true })
  const values = Object.fromEntries([...stdout.matchAll(/^\s+(\w+)\s+REG_\w+\s+(.+)$/gm)].map(match => [match[1], match[2].trim()]))
  // Only the observed simple manual loopback proxy is eligible. PAC and
  // protocol-specific configurations continue to use Chromium's system mode.
  if (values.ProxyEnable !== '0x1' || values.AutoConfigURL || !/^(127\.0\.0\.1|localhost):\d+$/.test(values.ProxyServer || '')) return null
  return { server: values.ProxyServer, bypass: values.ProxyOverride || '' }
}

async function reachable(ses, url) {
  try {
    const response = await ses.fetch(url, {
      method: 'OPTIONS', credentials: 'omit', redirect: 'error',
      headers: { Origin: 'https://studio.tripo3d.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-tripo-device-id' },
      signal: AbortSignal.timeout(8000),
    })
    await response.arrayBuffer()
    return response.ok && response.headers.get('access-control-allow-origin') === 'https://studio.tripo3d.com'
  } catch { return false }
}

async function configureStudioNetwork(studio, sessions, readProxy = windowsProxy) {
  const settings = await readProxy()
  if (!settings) return { mode: 'system' }
  const eligible = []
  for (const url of ENDPOINTS) {
    if (await studio.resolveProxy(url) === `PROXY ${settings.server}`) eligible.push(url)
  }
  if (!eligible.length) return { mode: 'system' }
  const probe = sessions.fromPartition(`tripo-network-probe-${require('node:crypto').randomUUID()}`)
  try {
    await probe.setProxy({ mode: 'system' })
    const checks = await Promise.all(eligible.map(async url => ({ url, ok: await reachable(probe, url) })))
    const failed = checks.filter(check => !check.ok).map(check => check.url)
    if (!failed.length) return { mode: 'system' }
    await probe.setProxy({ mode: 'direct' })
    await probe.closeAllConnections()
    const direct = await Promise.all(failed.map(async url => ({ url, ok: await reachable(probe, url) })))
    const bypass = direct.filter(check => check.ok).map(check => new URL(check.url).hostname)
    if (!bypass.length) return { mode: 'system' }
    await studio.setProxy({
      mode: 'fixed_servers', proxyRules: settings.server,
      proxyBypassRules: [settings.bypass, ...bypass].filter(Boolean).join(';'),
    })
    return { mode: 'service-direct', bypass, message: `Tripo 服务已绕过本机代理：${bypass.join('、')}。其他请求沿用原代理及例外规则；代理设置改变后请重启应用。` }
  } finally { await probe.closeAllConnections() }
}

// No query strings, bodies, headers, identifiers or response payloads are logged.
function networkDiagnostic(details) {
  let url
  try { url = new URL(details.url) } catch { return null }
  if (!ENDPOINTS.some(endpoint => new URL(endpoint).hostname === url.hostname)) return null
  if (!details.error && !(details.statusCode >= 400)) return null
  const route = url.pathname.startsWith('/self-service/') ? 'login-flow'
    : url.pathname === '/sessions/whoami' ? 'session'
    : url.pathname.startsWith('/idp-ext/auth/') ? 'auth'
    : url.pathname === '/v2/studio/user/profile/detail' ? 'profile'
    : url.hostname === 'msapi.tripo3d.com' ? 'membership' : 'studio-api'
  return { time: new Date().toISOString(), host: url.hostname, route,
    method: /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(details.method) ? details.method : 'OTHER',
    status: Number.isInteger(details.statusCode) ? details.statusCode : null,
    error: /^net::ERR_[A-Z0-9_]+$/.test(details.error || '') ? details.error : null }
}

function installNetworkDiagnostics(studio, filename) {
  const fs = require('node:fs')
  const record = details => {
    const row = networkDiagnostic(details)
    if (!row) return
    try {
      if (fs.existsSync(filename) && fs.statSync(filename).size > 256 * 1024) fs.writeFileSync(filename, '')
      fs.appendFileSync(filename, JSON.stringify(row) + '\n')
    } catch { /* Diagnostics must never interfere with website requests. */ }
  }
  const filter = { urls: ENDPOINTS.map(endpoint => new URL(endpoint).origin + '/*') }
  studio.webRequest.onErrorOccurred(filter, record)
  studio.webRequest.onCompleted(filter, record)
}

module.exports = { configureStudioNetwork, networkDiagnostic, installNetworkDiagnostics }
