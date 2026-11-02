const fs = require('node:fs/promises')
const path = require('node:path')
const { unzipSync, unzip } = require('fflate')
const { MAX_MODEL_BYTES } = require('./policy.cjs')

async function modelFromDownload(filename) {
  const stat = await fs.stat(filename)
  if (stat.size > MAX_MODEL_BYTES) throw new Error('下载文件超过 100 MB')
  const bytes = await fs.readFile(filename)
  if (bytes.subarray(0, 4).toString() === 'glTF') {
    if (path.extname(filename).toLowerCase() === '.glb') return filename
    const result = filename + '.glb'
    await fs.writeFile(result, bytes, { flag: 'wx' })
    return result
  }
  if (bytes.readUInt16LE(0) !== 0x4b50) throw new Error('网页下载不是 GLB 或 ZIP，原文件已保留')
  const candidates = []
  let entries = 0
  // Inventory without decompression. Only one bounded GLB is accepted; archive
  // paths are never used as local paths and other files are never extracted.
  unzipSync(bytes, { filter: entry => {
    if (++entries > 1000) throw new Error('导出压缩包包含过多文件')
    if (/\.glb$/i.test(entry.name)) {
      if (entry.originalSize > MAX_MODEL_BYTES) throw new Error('压缩包中的 GLB 超过 100 MB')
      candidates.push(entry.name)
    }
    return false
  } })
  if (candidates.length !== 1) throw new Error('压缩包中没有唯一的 GLB，请打开下载文件夹后手动导入')
  const files = await new Promise((resolve, reject) => unzip(bytes, { filter: entry => entry.name === candidates[0] }, (error, result) => error ? reject(error) : resolve(result)))
  const model = files[candidates[0]]
  if (!model || model.length > MAX_MODEL_BYTES || Buffer.from(model.subarray(0, 4)).toString() !== 'glTF') throw new Error('压缩包中的 GLB 内容无效')
  const result = filename + '.glb'
  await fs.writeFile(result, model, { flag: 'wx' })
  return result
}

module.exports = { modelFromDownload }
