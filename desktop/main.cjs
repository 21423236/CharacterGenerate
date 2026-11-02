const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog, clipboard } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { BASE, STUDIO, MAX_MODEL_BYTES, projectID, localURL, remoteURL, downloadName } = require('./policy.cjs')
const { StudioDriver, PauseRequired, delay } = require('./studio-driver.cjs')
const { StudioRun, publicRun } = require('./studio-run.cjs')
const { modelFromDownload } = require('./studio-download.cjs')
const { configureStudioNetwork, installNetworkDiagnostics } = require('./studio-network.cjs')

const ROOT = path.resolve(__dirname, '..')
const DATA = path.resolve(process.env.CHARACTER_FORGE_DATA || path.join(ROOT, 'data'))
const TOOLBAR = pathToFileURL(path.join(__dirname, 'toolbar.html')).href
const HEIGHT = 184
fs.mkdirSync(path.join(DATA, 'desktop', 'profile'), { recursive: true })
app.setPath('userData', path.join(DATA, 'desktop', 'profile'))
app.setName('Character Forge')

let mainWindow, backend, backendLog, studioSession
let quitting = false
let studioNetwork
const studios = new Map()
const owners = new Map()
const opening = new Map()

async function api(route, options = {}) {
  const response = await fetch(`${BASE}/api${route}`, {
    ...options, headers: { 'X-Forge-Request': 'local-ui', ...options.headers },
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}))
    throw new Error(typeof detail.detail === 'string' ? detail.detail : `本地服务错误 (${response.status})`)
  }
  return response.json()
}

async function health() {
  let response
  try { response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) }) }
  catch { return false }
  const info = await response.json().catch(() => ({}))
  if (!response.ok || info.app !== 'character-forge') throw new Error(`${new URL(BASE).port} 端口被其他应用占用`)
  if (!info.capabilities?.includes('studio-automation')) throw new Error('旧版角色工坊服务正在运行，请关闭原来的启动窗口后重新打开桌面版')
  return true
}

async function startBackend() {
  if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) throw new Error('请先运行 install.cmd 构建界面')
  if (await health()) return
  const python = path.join(ROOT, '.venv', 'Scripts', 'python.exe')
  if (!fs.existsSync(python)) throw new Error('未找到 Python 环境，请先运行 install.cmd')
  backendLog = fs.createWriteStream(path.join(DATA, 'desktop', 'backend.log'), { flags: 'a' })
  backend = spawn(python, ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', new URL(BASE).port, '--no-access-log'], {
    cwd: ROOT, windowsHide: true, env: { ...process.env, CHARACTER_FORGE_DATA: DATA, PYTHONUTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backend.stdout.pipe(backendLog)
  backend.stderr.pipe(backendLog)
  let failure
  backend.on('error', error => { failure = error })
  backend.on('exit', code => {
    failure = new Error(`本地服务已退出 (${code})，请查看 data/desktop/backend.log`)
    if (mainWindow && !quitting) dialog.showErrorBox('本地服务已停止', failure.message)
  })
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (failure) throw failure
    if (await health()) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('本地服务启动超时，请查看 data/desktop/backend.log')
}

function state(ctx, message = ctx.message) {
  ctx.message = message
  if (!ctx.window.isDestroyed()) ctx.window.webContents.send('studio:state', { title: ctx.title, message, inputs: ctx.inputs, presentation: ctx.presentation, automation: ctx.automation?.publicState() })
}

function inputState(project, busy = false) {
  const missing = ['front', project.side, 'back'].filter(label => !project.views?.[label])
  const reason = missing.length ? '请返回角色工坊的“三视图”页面，生成或导入图片后点击“确认并拆分为三张图”。'
    : busy ? '请等待角色当前处理任务完成。' : ''
  return { ready: !reason, reason }
}

async function refreshInputs(ctx) {
  // Never let an older focus request overwrite a more recent readiness check.
  const revision = ctx.inputRevision = (ctx.inputRevision || 0) + 1
  const [project, jobs] = await Promise.all([api(`/projects/${ctx.id}`), api(`/projects/${ctx.id}/jobs`)])
  if (revision !== ctx.inputRevision || ctx.window.isDestroyed()) return
  const previousReason = ctx.inputs?.reason
  ctx.inputs = inputState(project, jobs.some(job => ['queued', 'running'].includes(job.status)))
  if (previousReason && ctx.message === previousReason) ctx.message = ctx.inputs.reason || '三视图已准备好，可以开始后台生成。'
  state(ctx)
}

function showStudio(ctx, presentation = 'workspace') {
  if (ctx.window.isDestroyed()) return
  ctx.presentation = presentation
  ctx.window.setTitle(presentation === 'login' ? '登录 Tripo · 登录后自动继续' : `Tripo · ${ctx.title}`)
  state(ctx)
  ctx.window.show(); ctx.window.focus()
}

function hideStudio(ctx) {
  if (!ctx.window.isDestroyed()) ctx.window.hide()
  for (const popup of ctx.popups) if (!popup.isDestroyed()) popup.hide()
}

function bindRemote(contents, ctx) {
  owners.set(contents.id, ctx)
  contents.once('destroyed', () => owners.delete(contents.id))
  contents.on('will-navigate', (event, url) => {
    if (!remoteURL(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!remoteURL(url)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (!remoteURL(url) && url !== 'about:blank') return { action: 'deny' }
    return { action: 'allow', overrideBrowserWindowOptions: {
      width: 1050, height: 800, autoHideMenuBar: true,
      webPreferences: { session: studioSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    } }
  })
  contents.on('did-create-window', popup => {
    ctx.popups.add(popup)
    popup.once('closed', () => ctx.popups.delete(popup))
    bindRemote(popup.webContents, ctx)
  })
}

async function importModel(ctx, filename, explicit = false) {
  if (path.extname(filename).toLowerCase() !== '.glb') throw new Error('请选择 GLB 文件；ZIP 请先解压，FBX 请在网页重新导出为 GLB')
  const stat = await fsp.stat(filename)
  if (!stat.isFile() || stat.size > MAX_MODEL_BYTES) throw new Error('GLB 文件必须小于等于 100 MB')
  const expected = explicit ? (await api(`/projects/${ctx.id}`)).model?.id || '' : ctx.modelID
  const form = new FormData()
  form.append('file', new Blob([await fsp.readFile(filename)], { type: 'model/gltf-binary' }), path.basename(filename))
  const project = await api(`/projects/${ctx.id}/upload?kind=model&source=studio&expected_model_id=${encodeURIComponent(expected)}`, { method: 'POST', body: form })
  ctx.modelID = project.model.id
  state(ctx, `已导入「${ctx.title}」：${path.basename(filename)}。返回角色工坊即可适配骨架。`)
}

function queueImport(ctx, filename, explicit = false) {
  // Serialize completed downloads so versions are never imported concurrently.
  const task = ctx.importQueue.then(() => importModel(ctx, filename, explicit))
  ctx.importQueue = task.catch(() => {})
  return task
}

function setupDownloads() {
  studioSession.on('will-download', (event, item, contents) => {
    const ctx = owners.get(contents?.id)
    if (!ctx) { event.preventDefault(); return }
    const name = downloadName(item.getFilename())
    const automated = ctx.automation?.active && ctx.driver.acceptsDownload(item)
    const unrelated = ctx.automation?.active && !automated
    const destination = path.join(ctx.downloads, `${randomUUID()}-${name}`)
    const tooLarge = () => item.getTotalBytes() > MAX_MODEL_BYTES || item.getReceivedBytes() > MAX_MODEL_BYTES
    if (tooLarge()) { event.preventDefault(); ctx.downloadError = '下载超过 100 MB，请在网页降低模型或贴图规格后导出 GLB'; state(ctx, ctx.downloadError); return }
    item.setSavePath(destination)
    ctx.pending++
    if (automated) void ctx.automation.stage('downloading', '正在下载本次生成的模型').catch(() => {})
    state(ctx, `正在下载 ${name}，完成后将回填「${ctx.title}」`)
    item.on('updated', (_event, status) => {
      if (tooLarge()) { item.cancel(); return }
      const total = item.getTotalBytes()
      state(ctx, status === 'interrupted' ? '下载暂时中断，等待浏览器恢复…' : `下载 ${name} · ${total ? Math.round(item.getReceivedBytes() / total * 100) + '%' : Math.round(item.getReceivedBytes() / 1024) + ' KB'}`)
    })
    item.once('done', async (_event, status) => {
      try {
        if (status !== 'completed') { ctx.downloadError = `下载未完成 (${status})，继续任务会恢复导出已有模型`; state(ctx, ctx.downloadError); return }
        await fsp.writeFile(destination + '.json', JSON.stringify({ projectId: ctx.id, projectTitle: ctx.title, filename: path.basename(destination), downloadedAt: new Date().toISOString(), ...(automated ? { runId: ctx.automation.record.runId, remoteProjectId: ctx.automation.record.remoteProjectId, operatorId: ctx.automation.record.taskId } : {}) }, null, 2))
        if (unrelated) { state(ctx, '已保存额外下载；它不属于正在自动导出的任务，因此未自动回填'); return }
        if (automated) {
          const model = await modelFromDownload(destination)
          await queueImport(ctx, model)
          await ctx.automation.downloaded()
          if (ctx.autoMode) hideStudio(ctx)
          mainWindow.show(); mainWindow.focus()
          return
        }
        if (path.extname(name).toLowerCase() !== '.glb') {
          state(ctx, `已保存 ${name}。自动回填支持 GLB；ZIP 请解压后用「导入已下载 GLB」。`)
          return
        }
        await queueImport(ctx, destination)
      } catch (error) {
        ctx.downloadError = error.message
        state(ctx, `文件已保留，回填失败：${error.message}。可用「导入已下载 GLB」重试。`)
      } finally { ctx.pending-- }
    })
  })
}

async function prepareViews(project, directory) {
  await fsp.mkdir(directory, { recursive: true })
  for (const label of ['front', project.side, 'back']) {
    const asset = project.views?.[label]
    if (!asset) continue
    projectID(asset.id)
    const response = await fetch(`${BASE}/api/assets/${asset.id}`, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`读取 ${label} 视图失败，请重新确认裁切`)
    await fsp.writeFile(path.join(directory, `${label}.png`), Buffer.from(await response.arrayBuffer()))
  }
  await fsp.writeFile(path.join(directory, '视图说明.txt'), `角色：${project.title}\nfront.png = 正面\n${project.side}.png = 角色自身${project.side === 'left' ? '左' : '右'}侧\nback.png = 背面\n请根据 Tripo 网页实际支持的视图槽上传。使用网页套餐，生成和导出以网页显示为准。\n`, 'utf8')
}

async function openStudio(id) {
  projectID(id)
  const existing = studios.get(id)
  if (existing) {
    return existing
  }
  const project = await api(`/projects/${id}`)
  studioNetwork ||= configureStudioNetwork(studioSession, session).then(result => {
    if (result.message) console.info(result.message)
    return result
  }).catch(error => { console.warn('Tripo 网络检查失败，沿用系统代理：', error.message); return { mode: 'system' } })
  await studioNetwork
  const directory = path.join(DATA, 'studio', id)
  const views = path.join(directory, 'views', randomUUID())
  const downloads = path.join(directory, 'downloads')
  await prepareViews(project, views)
  await fsp.mkdir(downloads, { recursive: true })
  const window = new BrowserWindow({
    show: false, parent: mainWindow,
    width: 1440, height: 1000, minWidth: 1100, minHeight: 700, autoHideMenuBar: true,
    title: `Tripo · ${project.title}`, backgroundColor: '#191c1c',
    webPreferences: { preload: path.join(__dirname, 'toolbar-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  })
  const view = new WebContentsView({ webPreferences: { session: studioSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } })
  const ctx = { id, title: project.title, window, view, views, downloads, modelID: project.model?.id || '', pending: 0, importQueue: Promise.resolve(), popups: new Set(), message: Object.keys(project.views || {}).length ? '首次请在下方网页登录。点击「打开三视图文件夹」取图；生成完成后在网页导出 GLB，下载将自动回填此角色。' : '请先登录。此项目尚未裁切三视图；可在网页下载已有模型，或裁切后关闭并重新打开工作台。' }
  ctx.inputs = inputState(project)
  ctx.message = ctx.inputs.ready ? '三视图已准备好。点击“一键上传并生成”将在后台处理，需要登录时会弹窗。' : ctx.inputs.reason
  window.on('focus', () => { void refreshInputs(ctx).catch(error => state(ctx, error.message)) })
  let beforeLogin
  ctx.driver = new StudioDriver(view.webContents, { onLogin: async (waiting, signal) => {
    if (waiting) {
      beforeLogin = { stage: ctx.automation.record.stage, message: ctx.automation.record.message }
      await ctx.automation.stage('login', '请在弹出的窗口登录 Tripo，登录成功后会自动后台生成并显示结果')
      showStudio(ctx, 'login')
    } else {
      hideStudio(ctx)
      if (!signal?.aborted && beforeLogin) await ctx.automation.stage(beforeLogin.stage, beforeLogin.message)
      beforeLogin = null
    }
  } })
  ctx.automation = new StudioRun({ directory, projectId: id, driver: ctx.driver,
    onState: value => {
      state(ctx, value.message)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('forge:studio-state', value)
      if (ctx.autoMode && !value.active && ['paused', 'uncertain'].includes(value.status) && !ctx.automation.abort?.signal.aborted) showStudio(ctx, 'workspace')
    },
    onDownload: async signal => {
      const deadline = Date.now() + 10 * 60 * 1000
      while (Date.now() < deadline) {
        if (ctx.automation.record.status === 'complete') return
        if (ctx.downloadError) throw new PauseRequired(`文件已保留或下载中断：${ctx.downloadError}`)
        if (ctx.driver.observationError) throw ctx.driver.observationError
        await delay(700, signal)
      }
      throw new PauseRequired('等待导出下载超时，请检查网页登录、导出额度或网络后继续')
    },
  })
  await ctx.automation.load()
  studios.set(id, ctx)
  window.contentView.addChildView(view)
  const resize = () => { const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: HEIGHT, width, height: Math.max(1, height - HEIGHT) }) }
  resize(); window.on('resize', resize)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('close', event => {
    if (!quitting && ctx.autoMode) {
      event.preventDefault()
      hideStudio(ctx)
      if (ctx.automation.active && ctx.automation.record?.stage === 'login') void ctx.automation.pause()
      return
    }
    if (ctx.pending && !quitting) {
      event.preventDefault()
      state(ctx, '正在下载或导入，请完成后关闭；可先返回角色工坊。')
    }
  })
  window.on('closed', () => {
    ctx.automation.abort?.abort()
    ctx.driver.stopTracking()
    studios.delete(id)
    for (const popup of ctx.popups) if (!popup.isDestroyed()) popup.destroy()
    if (!view.webContents.isDestroyed()) view.webContents.close()
  })
  bindRemote(view.webContents, ctx)
  view.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) state(ctx, `网页加载失败：${description}。可刷新，或使用系统浏览器打开后手动导入 GLB。`)
  })
  await window.loadFile(path.join(__dirname, 'toolbar.html'))
  await view.webContents.loadURL(STUDIO).catch(error => state(ctx, `无法打开 Tripo：${error.message}`))
  return ctx
}

function checkLocalSender(event) {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || !localURL(event.senderFrame.url)) throw new Error('不允许的调用来源')
}

const deletingProjects = new Set()
async function ensureStudio(id, reveal = false) {
  projectID(id)
  if (deletingProjects.has(id)) throw new Error('正在删除角色')
  if (!opening.has(id)) opening.set(id, openStudio(id).finally(() => opening.delete(id)))
  const ctx = await opening.get(id)
  if (reveal) {
    await refreshInputs(ctx)
    showStudio(ctx, ctx.automation.active && ctx.automation.record?.stage === 'login' ? 'login' : 'workspace')
  }
  return ctx
}

async function automate(id, action) {
  const ctx = await ensureStudio(id)
  if (action === 'pause') { await ctx.automation.pause(); return }
  if (action === 'cancel') { await ctx.automation.cancel(); return }
  if (ctx.automation.active) return
  ctx.autoMode = true
  hideStudio(ctx)
  ctx.downloadError = null
  if (action === 'resume') {
    ctx.modelID = ctx.automation.record?.expectedModelId || ''
    await ctx.automation.resume()
    return
  }
  if (action !== 'start') throw new Error('未知自动化操作')
  if (ctx.automation.active || (ctx.automation.record && !['complete', 'failed', 'cancelled'].includes(ctx.automation.record.status))) throw new Error('已有自动化任务，请使用继续任务')
  const [project, settings, jobs] = await Promise.all([api(`/projects/${id}`), api('/settings'), api(`/projects/${id}/jobs`)])
  if (jobs.some(job => ['queued', 'running'].includes(job.status))) throw new Error('请等待角色当前处理任务完成')
  const labels = ['front', project.side, 'back']
  if (!labels.every(label => project.views?.[label])) throw new Error('请先裁切并确认正面、侧面和背面三张视图')
  const views = path.join(DATA, 'studio', id, 'views', randomUUID())
  await prepareViews(project, views)
  ctx.views = views
  ctx.modelID = project.model?.id || ''
  await ctx.automation.start({ config: { topology: settings.tripo.studio_topology || 'triangle', faces: settings.tripo.studio_face_limit ?? 15000 },
    files: Object.fromEntries(labels.map(label => [label, path.join(views, `${label}.png`)])),
    assetIds: Object.fromEntries(labels.map(label => [label, project.views[label].id])), expectedModelId: ctx.modelID })
}

ipcMain.handle('forge:delete-project', async (event, id) => {
  checkLocalSender(event)
  projectID(id)
  if (deletingProjects.has(id) || opening.has(id)) throw new Error('工作台正在操作，请稍后再删除')
  deletingProjects.add(id)
  try {
    const ctx = studios.get(id)
    if (ctx?.automation.active || ctx?.pending) throw new Error('角色正在生成、下载或导入，请暂停任务或等待完成后再删除')
    if (ctx) ctx.window.destroy()
    await api(`/projects/${id}`, { method: 'DELETE' })
  } finally { deletingProjects.delete(id) }
})

ipcMain.handle('forge:studio', async (event, id) => {
  checkLocalSender(event)
  await ensureStudio(id, true)
})

ipcMain.handle('forge:automate', async (event, id, action) => {
  checkLocalSender(event)
  projectID(id)
  await automate(id, action)
})

ipcMain.handle('forge:studio-state', async (event, id) => {
  checkLocalSender(event)
  projectID(id)
  if (studios.has(id)) return studios.get(id).automation.publicState()
  try {
    const record = JSON.parse(await fsp.readFile(path.join(DATA, 'studio', id, 'automation.json'), 'utf8'))
    return publicRun(record)
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
})

ipcMain.handle('studio:action', async (event, action) => {
  const ctx = [...studios.values()].find(item => item.window.webContents === event.sender)
  if (!ctx || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== TOOLBAR) throw new Error('不允许的调用来源')
  switch (action) {
    case 'start': case 'resume': case 'pause': case 'cancel': await automate(ctx.id, action); break
    case 'recover':
      await ctx.automation.recoverCurrent()
      ctx.downloadError = null
      ctx.modelID = ctx.automation.record.expectedModelId || ''
      ctx.autoMode = true
      hideStudio(ctx)
      await ctx.automation.resume()
      break
    case 'ready': await refreshInputs(ctx); break
    case 'views': {
      const current = await api(`/projects/${ctx.id}`)
      const next = path.join(DATA, 'studio', ctx.id, 'views', randomUUID())
      await prepareViews(current, next)
      ctx.views = next
      const error = await shell.openPath(ctx.views)
      if (error) throw new Error(error)
      state(ctx, '已准备最新裁切图片。可复制图片目录，粘贴到网页上传文件选择框的地址栏。')
      break
    }
    case 'copy': clipboard.writeText(ctx.views); state(ctx, `图片目录已复制：${ctx.views}`); break
    case 'downloads': {
      const error = await shell.openPath(ctx.downloads)
      if (error) throw new Error(error)
      break
    }
    case 'reload':
      if (ctx.automation.active) throw new Error('请先暂停自动操作再刷新')
      ctx.view.webContents.loadURL(STUDIO).catch(error => state(ctx, error.message)); break
    case 'external': await shell.openExternal(STUDIO); state(ctx, '已用系统浏览器打开。外部浏览器的下载请用「导入已下载 GLB」选择；登录状态不与内置浏览器共享。'); break
    case 'return': hideStudio(ctx); mainWindow.show(); mainWindow.focus(); break
    case 'import': {
      if (ctx.automation.active) throw new Error('请先暂停自动任务，再手动导入模型')
      const result = await dialog.showOpenDialog(ctx.window, { title: `导入 GLB 到「${ctx.title}」`, defaultPath: ctx.downloads, filters: [{ name: 'GLB 模型', extensions: ['glb'] }], properties: ['openFile'] })
      if (!result.canceled && result.filePaths[0]) {
        ctx.pending++
        try {
          await queueImport(ctx, result.filePaths[0], true)
          if (ctx.automation.record && !['complete', 'failed', 'cancelled'].includes(ctx.automation.record.status)) await ctx.automation.downloaded()
        }
        finally { ctx.pending-- }
      }
      break
    }
    default: throw new Error('未知工作台操作')
  }
})

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus() })
  app.whenReady().then(async () => {
    await startBackend()
    studioSession = session.fromPartition('persist:tripo-studio')
    installNetworkDiagnostics(studioSession, path.join(DATA, 'desktop', 'studio-network.jsonl'))
    studioSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    studioSession.setPermissionCheckHandler(() => false)
    studioSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const url = details.url
      callback({ cancel: !remoteURL(url) && !url.startsWith('blob:') && !url.startsWith('data:') && url !== 'about:blank' && !url.startsWith('wss:') })
    })
    setupDownloads()
    mainWindow = new BrowserWindow({ width: 1512, height: 1050, minWidth: 1000, minHeight: 700, autoHideMenuBar: true, backgroundColor: '#f4f0e7',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
    mainWindow.webContents.on('will-navigate', (event, url) => { if (!localURL(url)) event.preventDefault() })
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (remoteURL(url)) void shell.openExternal(url).catch(() => {})
      return { action: 'deny' }
    })
    mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); app.quit() } })
    await mainWindow.loadURL(BASE)
  }).catch(error => { if (!quitting) dialog.showErrorBox('角色工坊启动失败', error.message); app.quit() })
}

app.on('before-quit', event => {
  if (!quitting && [...studios.values()].some(ctx => ctx.pending)) {
    const choice = dialog.showMessageBoxSync({ type: 'question', title: '下载正在进行', message: '仍有模型正在下载或导入。现在退出会中断操作。', buttons: ['继续等待', '退出应用'], defaultId: 0, cancelId: 0 })
    if (choice === 0) { event.preventDefault(); return }
  }
  quitting = true
  for (const ctx of studios.values()) ctx.automation.abort?.abort()
  studioSession?.flushStorageData()
  if (backend && backend.exitCode === null) backend.kill()
  backendLog?.end()
})
app.on('window-all-closed', () => app.quit())
