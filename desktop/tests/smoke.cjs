// Isolated Electron integration test. All Tripo HTTPS responses are local fixtures.
process.env.CHARACTER_FORGE_PORT = '18765'
const { _electron, expect } = require('../../web/node_modules/@playwright/test')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { BASE } = require('../policy.cjs')

const ROOT = path.resolve(__dirname, '../..')
const DATA = path.join(ROOT, 'data', 'desktop-tests', Date.now().toString())
const env = { ...process.env, CHARACTER_FORGE_DATA: DATA }
delete env.ELECTRON_RUN_AS_NODE

function modelBytes() {
  const document = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] }
  let json = Buffer.from(JSON.stringify(document))
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)])
  const vertices = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => vertices.writeFloatLE(value, index * 4))
  const header = Buffer.alloc(20)
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + vertices.length, 8)
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  const binaryHeader = Buffer.alloc(8)
  binaryHeader.writeUInt32LE(vertices.length); binaryHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, json, binaryHeader, vertices])
}

async function api(route, options = {}) {
  const response = await fetch(BASE + '/api' + route, { ...options, headers: { 'X-Forge-Request': 'local-ui', ...options.headers } })
  assert.equal(response.ok, true, await response.clone().text())
  return response.json()
}

async function launch() {
  return _electron.launch({ executablePath: require('electron'), args: [ROOT], cwd: ROOT, env, timeout: 30000 })
}

async function main() {
  const occupied = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
  assert.equal(occupied, false, 'Close the existing Character Forge server before running this isolated test.')
  await fs.mkdir(DATA, { recursive: true })
  let electron
  try {
    electron = await launch()
    const page = await electron.firstWindow()
    await expect(page.getByRole('button', { name: '创建第一个角色' })).toBeVisible()
    await page.getByRole('button', { name: '创建第一个角色' }).click()
    await page.getByRole('textbox', { name: '为这个角色取个名字' }).fill('网页下载所属角色')
    await page.getByRole('button', { name: '确定', exact: true }).click()
    await expect(page.getByRole('heading', { name: '网页下载所属角色' })).toBeVisible()
    const first = (await api('/projects'))[0]
    // Prepare actual crop assets without a provider call.
    const sheet = new FormData()
    sheet.append('file', new Blob([await fs.readFile(path.join(ROOT, 'data', 'smoke-test', 'sheet.png'))]), 'sheet.png')
    const uploaded = await api(`/projects/${first.id}/upload?kind=sheet`, { method: 'POST', body: sheet })
    await api(`/projects/${first.id}/crop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boxes: uploaded.boxes, labels: ['front', 'left', 'back'], confirmed: true }) })
    const other = await api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '另一个角色' }) })
    await page.reload()

    await electron.evaluate(async ({ session }, base64) => {
      const tripo = session.fromPartition('persist:tripo-studio')
      await tripo.setProxy({ mode: 'direct' })
      tripo.protocol.handle('https', () => new Response(`<!doctype html><html><body><h1>Mock Tripo Studio</h1><button id="download">Download GLB</button><button id="zip">Download ZIP</button><script>
        function download(name, data) { const bytes=Uint8Array.from(atob(data), c=>c.charCodeAt(0)); const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([bytes], {type:'application/octet-stream'})); a.download=name; a.click(); }
        document.getElementById('download').onclick=()=>download('character.glb','${base64}');
        document.getElementById('zip').onclick=()=>download('character.zip','UEsDBA==');
        </script></body></html>`, { headers: { 'Content-Type': 'text/html' } }))
    }, modelBytes().toString('base64'))

    await page.getByRole('button', { name: /03.*3D 模型/ }).click()
    await expect(page.getByText('Tripo 网页会员模式', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '打开内置 Tripo 工作台' }).click()
    await expect.poll(() => electron.windows().some(window => window.url().endsWith('/toolbar.html'))).toBe(true)
    const toolbar = electron.windows().find(window => window.url().endsWith('/toolbar.html'))
    await expect(toolbar.getByText('网页下载所属角色', { exact: true })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: '一键上传并生成' })).toBeEnabled()
    // WebContentsView is also exposed as a Playwright page in Electron.
    await expect.poll(() => electron.context().pages().some(window => window.url().startsWith('https://studio.tripo3d.com'))).toBe(true)
    const remote = electron.context().pages().find(window => window.url().startsWith('https://studio.tripo3d.com'))
    await expect(remote.getByRole('heading', { name: 'Mock Tripo Studio' })).toBeVisible()
    assert.deepEqual(await remote.evaluate(() => ({ node: typeof window.require, bridge: typeof window.forgeDesktop, toolbar: typeof window.studioToolbar })), { node: 'undefined', bridge: 'undefined', toolbar: 'undefined' })
    const transfer = path.join(DATA, 'studio', first.id, 'views')
    const versions = await fs.readdir(transfer)
    for (const name of ['front.png', 'left.png', 'back.png']) assert.ok((await fs.stat(path.join(transfer, versions[0], name))).size > 0)

    // Changing the selected project must not change the download target.
    await page.locator('.project-entry>button:first-child').filter({ hasText: '另一个角色' }).click()
    await expect(page.getByRole('button', { name: '一键生成并预览' })).toBeDisabled()
    await expect(page.getByText('此角色还没有三视图。请先生成或导入三视图，再确认裁切。')).toBeVisible()
    await page.getByRole('button', { name: '打开内置 Tripo 工作台' }).click()
    await expect.poll(() => electron.windows().filter(window => window.url().endsWith('/toolbar.html')).length).toBe(2)
    const emptyToolbar = electron.windows().filter(window => window.url().endsWith('/toolbar.html')).find(window => window !== toolbar)
    await expect(emptyToolbar.getByRole('button', { name: '一键上传并生成' })).toBeDisabled()
    await expect(emptyToolbar.locator('#input-status')).toContainText('确认并拆分为三张图')
    await page.getByRole('button', { name: '前往生成或导入三视图' }).click()
    const chooseSheet = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '导入三视图' }).click()
    await (await chooseSheet).setFiles(path.join(ROOT, 'data', 'smoke-test', 'sheet.png'))
    await expect(page.getByAltText('待拆分角色三视图')).toBeVisible()
    await page.getByRole('button', { name: /03.*3D 模型/ }).click()
    await expect(page.getByRole('button', { name: '一键生成并预览' })).toBeDisabled()
    await page.getByRole('button', { name: '去确认并拆分三视图' }).click()
    await page.getByRole('checkbox', { name: /我已确认三个视图/ }).check()
    await page.getByRole('button', { name: '确认并拆分为三张图' }).click()
    await expect(page.getByRole('heading', { name: '检查完毕，进入三维。' })).toBeVisible()
    await page.getByRole('button', { name: /03.*3D 模型/ }).click()
    await expect(page.getByRole('button', { name: '一键生成并预览' })).toBeEnabled()
    await page.getByRole('button', { name: '打开内置 Tripo 工作台' }).click()
    await expect(emptyToolbar.getByRole('button', { name: '一键上传并生成' })).toBeEnabled()
    await emptyToolbar.close()
    await remote.getByRole('button', { name: 'Download GLB' }).click()
    await expect(toolbar.locator('#status')).toContainText('已导入', { timeout: 20000 })
    assert.ok((await api(`/projects/${first.id}`)).model)
    assert.equal((await api(`/projects/${other.id}`)).model, undefined)
    assert.equal((await api(`/projects/${first.id}/jobs`))[0].kind, 'studio_import')
    await page.locator('.project-entry>button:first-child').filter({ hasText: '网页下载所属角色' }).click()
    await expect(page.getByRole('button', { name: '适配我的骨架' })).toBeEnabled({ timeout: 10000 })

    // ZIP stays on disk for manual extraction, never treated as a GLB.
    const previous = (await api(`/projects/${first.id}`)).model.id
    await remote.getByRole('button', { name: 'Download ZIP' }).click()
    await expect(toolbar.locator('#status')).toContainText('ZIP 请解压')
    assert.equal((await api(`/projects/${first.id}`)).model.id, previous)

    // A model replaced outside this window must not be overwritten by a late download.
    const replacement = new FormData()
    replacement.append('file', new Blob([modelBytes()]), 'replacement.glb')
    const newer = await api(`/projects/${first.id}/upload?kind=model`, { method: 'POST', body: replacement })
    await remote.getByRole('button', { name: 'Download GLB' }).click()
    await expect(toolbar.locator('#status')).toContainText('项目模型已更改')
    assert.equal((await api(`/projects/${first.id}`)).model.id, newer.model.id)
    const saved = await fs.readdir(path.join(DATA, 'studio', first.id, 'downloads'))
    assert.equal(saved.filter(name => name.endsWith('.glb')).length, 2)
    await electron.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] })
    }, path.join(DATA, 'studio', first.id, 'downloads', saved.find(name => name.endsWith('.glb'))))
    await toolbar.getByRole('button', { name: '导入已下载 GLB' }).click()
    await expect(toolbar.locator('#status')).toContainText('已导入')
    assert.notEqual((await api(`/projects/${first.id}`)).model.id, newer.model.id)

    // Cookie persistence across a real application restart (synthetic cookie only).
    await electron.evaluate(async ({ session }) => {
      const tripo = session.fromPartition('persist:tripo-studio')
      await tripo.cookies.set({ url: 'https://studio.tripo3d.com', name: 'forge-test', value: 'persisted', expirationDate: Date.now() / 1000 + 3600, secure: true })
      await tripo.cookies.flushStore()
    })
    await page.screenshot({ path: path.join(DATA, 'desktop.png'), fullPage: true })
    await toolbar.screenshot({ path: path.join(DATA, 'workspace.png') })
    const retained = (await api(`/projects/${first.id}`)).model.id
    await page.getByRole('button', { name: '删除角色 网页下载所属角色', exact: true }).click()
    await expect.poll(() => toolbar.isClosed()).toBe(true)
    assert.equal((await api('/projects')).some(p => p.id === first.id), false)
    await page.getByRole('button', { name: '撤销删除' }).click()
    await expect(page.getByRole('heading', { name: '网页下载所属角色' })).toBeVisible()
    assert.equal((await api(`/projects/${first.id}`)).model.id, retained)
    await electron.close(); electron = undefined
    await expect.poll(async () => fetch(BASE + '/api/health', { signal: AbortSignal.timeout(500) }).then(() => true, () => false)).toBe(false)
    electron = await launch()
    const reopened = await electron.firstWindow()
    await expect(reopened.getByRole('heading', { name: '网页下载所属角色' })).toBeVisible()
    const cookies = await electron.evaluate(async ({ session }) => session.fromPartition('persist:tripo-studio').cookies.get({ name: 'forge-test' }))
    assert.equal(cookies[0]?.value, 'persisted')
    await electron.close(); electron = undefined
    console.log('PASS: desktop creation, view handoff, isolated web page, GLB import, project ownership, ZIP retention, overwrite protection, persistent cookies, backend lifecycle.')
    console.log(`Artifacts: ${DATA}`)
  } finally {
    if (electron) await electron.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
