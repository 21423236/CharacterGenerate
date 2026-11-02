// Real Electron/CDP uploads and passive network observation against a local
// Studio UI fixture. No provider or user profile is used.
process.env.CHARACTER_FORGE_PORT = '18767'
const { _electron, expect } = require('../../web/node_modules/@playwright/test')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { zipSync } = require('fflate')
const { BASE } = require('../policy.cjs')
const ROOT = path.resolve(__dirname, '../..')
const DATA = path.join(ROOT, 'data', 'automation-e2e', Date.now().toString())
const env = { ...process.env, CHARACTER_FORGE_DATA: DATA }
delete env.ELECTRON_RUN_AS_NODE

function modelBytes() {
  const doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] }
  let json = Buffer.from(JSON.stringify(doc))
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)])
  const binary = Buffer.alloc(36)
  ;[0,0,0,1,0,0,0,1,0].forEach((value,index)=>binary.writeFloatLE(value,index*4))
  const header = Buffer.alloc(20)
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+36,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16)
  const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(36);binHeader.writeUInt32LE(0x004e4942,4)
  return Buffer.concat([header,json,binHeader,binary])
}

async function api(route, options = {}) {
  const response = await fetch(BASE + '/api' + route, { ...options, headers: { 'X-Forge-Request': 'local-ui', ...options.headers } })
  assert.equal(response.ok, true, await response.clone().text())
  return response.json()
}

async function mock(electron, html, success = false, login = false, withoutDetail = false) {
  await electron.evaluate(async ({ session, app }, input) => {
    await session.fromPartition('persist:tripo-studio').setProxy({ mode: 'direct' })
    globalThis.forgeMock = { success: input.success, generate: 0, details: 0, lastRequest: null }
    globalThis.studioShows = []
    app.on('browser-window-created', (_event, window) => window.on('show', () => globalThis.studioShows.push(window.getTitle())))
    const project='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', operator='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }
    session.fromPartition('persist:tripo-studio').protocol.handle('https', async request => {
      const url = new URL(request.url)
      if (url.hostname === 'studio.tripo3d.com') {
        if (url.pathname === '/workspace/generate/' + project) return new Response(`<script>location.replace('/workspace/generate/female-witch-'+${JSON.stringify(project)})</script>`, { headers: { 'Content-Type': 'text/html' } })
        return new Response(input.html, { headers: { 'Content-Type': 'text/html' } })
      }
      if (url.hostname !== 'api-cn.tripo3d.com') return new Response('', { status: 404 })
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
      let data
      if (url.pathname.endsWith('/operation/multiview_to_model')) {
        globalThis.forgeMock.generate++
        globalThis.forgeMock.lastRequest = await request.json()
        data = { project_id: project, operator_id: operator }
      } else if (url.pathname.endsWith('/progress')) {
        data = [{ operator_id: operator, status: globalThis.forgeMock.success ? 'success' : 'running', progress: globalThis.forgeMock.success ? 100 : 25 }]
      } else if (url.pathname.endsWith('/detail/v3/' + project)) {
        globalThis.forgeMock.details++
        data = globalThis.forgeMock.success ? { id: project, model_url: 'https://cdn.example.com/model.glb', operator: { operator_id: operator, is_latest_operator: true } } : { id: project, running_operator: { operator_id: operator, status: 'running', progress: 25 } }
      } else return new Response('', { status: 404 })
      return new Response(JSON.stringify({ code: 0, data }), { headers })
    })
  }, { html: html.replace('__LOGIN_REQUIRED__', String(login)).replace('__NO_DETAIL__', String(withoutDetail)), success })
}

async function main() {
  await fs.mkdir(DATA, { recursive: true })
  const archive = Buffer.from(zipSync({ 'model/character.glb': modelBytes() })).toString('base64')
  const html = (await fs.readFile(path.join(__dirname, 'fixtures/studio.html'), 'utf8')).replace('__MODEL_ZIP__', archive)
  let electron, id
  const launch = () => _electron.launch({ executablePath: require('electron'), args: [ROOT], cwd: ROOT, env })
  try {
    electron = await launch()
    let page = await electron.firstWindow()
    await expect(page.getByRole('button', { name: '创建第一个角色' })).toBeVisible()
    const project = await api('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '自动建模测试' }) })
    id = project.id
    const form = new FormData()
    form.append('file', new Blob([await fs.readFile(path.join(ROOT, 'data/smoke-test/sheet.png'))]), 'sheet.png')
    const sheet = await api(`/projects/${id}/upload?kind=sheet`, { method: 'POST', body: form })
    await api(`/projects/${id}/crop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boxes: sheet.boxes, labels: ['front', 'right', 'back'], confirmed: true }) })
    await page.reload()
    await mock(electron, html, false, true)
    await page.getByRole('button', { name: /3D 模型/ }).click()
    await page.getByRole('button', { name: '一键生成并预览' }).click()
    const runState = () => page.evaluate(id => window.forgeDesktop.studioState(id), id)
    const studioVisible = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().endsWith('/toolbar.html') && window.isVisible()))
    await expect.poll(async()=> (await runState())?.stage, { timeout: 30000 }).toBe('login')
    await expect.poll(studioVisible).toBe(true)
    assert.equal(await electron.evaluate(()=>globalThis.forgeMock.generate), 0)
    // Dismissing login pauses the task; it must not continue in a hidden window.
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/toolbar.html')).close())
    await expect.poll(async()=> (await runState())?.active).toBe(false)
    assert.equal(await studioVisible(), false)
    assert.equal(await electron.evaluate(()=>globalThis.forgeMock.generate), 0)
    await page.getByRole('button', { name: '继续任务' }).click()
    await expect.poll(async()=> (await runState())?.stage).toBe('login')
    await expect.poll(studioVisible).toBe(true)
    const toolbar = electron.windows().find(window => window.url().endsWith('/toolbar.html'))
    await expect(toolbar.getByText('完成登录后窗口会自动收起，模型将在角色工坊中显示。')).toBeVisible()
    await expect(toolbar.getByRole('button', { name: '一键上传并生成' })).toBeHidden()
    await electron.evaluate(async ({ webContents }) => {
      const remote = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('https://studio.tripo3d.com/'))
      await remote.executeJavaScript("document.getElementById('finish-login').click()")
    })
    await expect.poll(async()=> (await runState())?.stage, { timeout: 30000 }).toBe('waiting')
    assert.equal(await studioVisible(), false)
    assert.deepEqual(await electron.evaluate(()=>globalThis.studioShows), ['登录 Tripo · 登录后自动继续', '登录 Tripo · 登录后自动继续'])
    const before = await electron.evaluate(()=>globalThis.forgeMock)
    assert.equal(before.generate, 1)
    assert.equal(before.lastRequest.face_limit, 15000)
    assert.equal(before.lastRequest.model_version, 'Nexus-v2.1-future')
    assert.deepEqual(before.lastRequest.variations, [])
    assert.equal(before.lastRequest.quad, false)
    assert.deepEqual(before.lastRequest.image.map(item=>item?.key || null), ['front', null, 'back', 'right'])
    await page.getByRole('button', { name: '暂停自动操作' }).click()
    await expect.poll(async()=> (await runState())?.active).toBe(false)
    const saved = JSON.parse(await fs.readFile(path.join(DATA, 'studio', id, 'automation.json'), 'utf8'))
    assert.equal(saved.submitted, true)
    assert.equal(saved.remoteProjectId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    assert.equal(saved.taskId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    await electron.close(); electron = undefined
    await expect.poll(()=>fetch(BASE+'/api/health',{signal:AbortSignal.timeout(500)}).then(()=>true,()=>false)).toBe(false)

    // Restart the actual desktop, restore the persisted operator, then finish a
    // ZIP download. The second process must never submit another generation.
    electron = await launch()
    page = await electron.firstWindow()
    await expect(page.getByRole('heading', { name: '自动建模测试' })).toBeVisible()
    await mock(electron, html, true)
    await page.getByRole('button', { name: /3D 模型/ }).click()
    await page.getByRole('button', { name: '继续任务' }).click()
    await expect.poll(async()=> (await runState())?.status, { timeout: 30000 }).toBe('complete')
    assert.equal(await studioVisible(), false)
    assert.deepEqual(await electron.evaluate(()=>globalThis.studioShows), [])
    await expect(page.getByRole('button', { name: '适配我的骨架' })).toBeEnabled()
    await expect(page.getByText('拖动旋转 · 滚轮缩放', { exact: true })).toBeVisible()
    assert.equal(await electron.evaluate(()=>globalThis.forgeMock.generate), 0)
    const current = await api(`/projects/${id}`)
    assert.ok(current.model)
    assert.equal((await api(`/projects/${id}/jobs`))[0].kind, 'studio_import')
    const downloads = await fs.readdir(path.join(DATA, 'studio', id, 'downloads'))
    assert.ok(downloads.some(name=>name.endsWith('.zip')))
    assert.ok(downloads.some(name=>name.endsWith('.zip.glb')))
    await page.screenshot({ path: path.join(DATA, 'automation-complete.png'), fullPage: true })
    await electron.close(); electron = undefined
    await expect.poll(()=>fetch(BASE+'/api/health',{signal:AbortSignal.timeout(500)}).then(()=>true,()=>false)).toBe(false)
    // Reproduce a legacy journal whose POST was sent but the old strict request
    // validator discarded its response. Repair only this isolated test journal.
    const journal = path.join(DATA, 'studio', id, 'automation.json')
    const legacy = JSON.parse(await fs.readFile(journal, 'utf8'))
    Object.assign(legacy, { status: 'uncertain', stage: 'submitting', taskId: null, remoteProjectId: null, expectedModelId: current.model.id })
    await fs.writeFile(journal, JSON.stringify(legacy))
    electron = await launch()
    page = await electron.firstWindow()
    await expect(page.getByRole('heading', { name: '自动建模测试' })).toBeVisible()
    await mock(electron, html, true, false, true)
    await page.getByRole('button', { name: /3D 模型/ }).click()
    await page.getByRole('button', { name: '继续任务' }).click()
    await expect.poll(async()=> (await runState())?.status).toBe('uncertain')
    await expect.poll(studioVisible).toBe(true)
    const recoveryToolbar = electron.windows().find(window => window.url().endsWith('/toolbar.html'))
    await recoveryToolbar.getByRole('button', { name: '接续当前网页模型' }).click()
    await expect(recoveryToolbar.locator('#status')).toContainText('请先在下方 Tripo 资产中点选')
    assert.equal(await electron.evaluate(()=>globalThis.forgeMock.generate), 0)
    const remote = electron.context().pages().find(window => window.url().startsWith('https://studio.tripo3d.com'))
    await remote.goto('https://studio.tripo3d.com/workspace/generate/female-witch-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    await recoveryToolbar.getByRole('button', { name: '接续当前网页模型' }).click()
    await expect.poll(async()=> (await runState())?.status, { timeout: 30000 }).toBe('complete')
    assert.equal(await studioVisible(), false)
    assert.equal(await electron.evaluate(()=>globalThis.forgeMock.generate), 0)
    const recovered = JSON.parse(await fs.readFile(journal, 'utf8'))
    assert.equal(recovered.taskId, null)
    assert.equal(recovered.remoteProjectId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    assert.equal(recovered.recoveryMode, 'selected-model')
    assert.equal(await electron.evaluate(()=>globalThis.forgeMock.details), 0)
    assert.ok(recovered.recoveredAt)
    await electron.close(); electron = undefined
    console.log('PASS: login/background generation, tolerant request fields, restart without regeneration, GLB preview, selected-model export with no task ID or detail response and no generation POST.')
    console.log('Artifacts: '+DATA)
  } catch (error) {
    if (id) console.error('Run journal:', await fs.readFile(path.join(DATA, 'studio', id, 'automation.json'), 'utf8').catch(()=>''))
    throw error
  } finally { if (electron) await electron.close() }
}

main().catch(error=>{console.error(error);process.exitCode=1})
