const path = require('node:path')

const port = Number(process.env.CHARACTER_FORGE_PORT || 8765)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效的本地服务端口')
const BASE = `http://127.0.0.1:${port}`
const STUDIO = 'https://studio.tripo3d.com/workspace/generate'
const MAX_MODEL_BYTES = 100 * 1024 * 1024

function projectID(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error('无效项目 ID')
  return value
}

function localURL(value) {
  try { return new URL(value).origin === BASE } catch { return false }
}

function remoteURL(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
      !/^(localhost|.*\.localhost|127\..*|0\.0\.0\.0|\[::1\]|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*)$/.test(host)
  } catch { return false }
}

function downloadName(value) {
  // Keep only a filename, including when a server sends Windows separators.
  const name = path.win32.basename(String(value)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(-160)
  return name || 'download.bin'
}

module.exports = { BASE, STUDIO, MAX_MODEL_BYTES, projectID, localURL, remoteURL, downloadName }
