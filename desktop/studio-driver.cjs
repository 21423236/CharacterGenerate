const { studioPage } = require('./studio-page.cjs')
const { STUDIO } = require('./policy.cjs')
const protocol = require('./studio-protocol.cjs')

class PauseRequired extends Error {}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PauseRequired('自动操作已暂停'))
    const abort = () => { clearTimeout(timer); reject(new PauseRequired('自动操作已暂停')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

class StudioDriver {
  constructor(contents, { onLogin } = {}) { this.contents = contents; this.onLogin = onLogin }

  async login(signal) {
    if (!this.onLogin) throw new PauseRequired('请先完成 Tripo 登录，再继续任务')
    await this.onLogin(true, signal)
    try {
      await this.invoke('open-login')
      const deadline = Date.now() + 10 * 60 * 1000
      let settled = 0
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new PauseRequired('登录已暂停，点击继续任务可重新打开登录窗口')
        // A navigation during login is transient. Require a stable workspace,
        // not merely a briefly missing login button during page replacement.
        const snapshot = await this.invoke('snapshot').catch(() => null)
        settled = snapshot?.ready && !snapshot.loginRequired ? settled + 1 : 0
        if (settled >= 3) return
        await delay(700, signal)
      }
      throw new PauseRequired('等待登录超时，点击继续任务可重新打开登录窗口')
    } finally { await this.onLogin(false, signal) }
  }

  async reset(signal) {
    if (signal.aborted) throw new PauseRequired('自动操作已暂停')
    await this.contents.loadURL(STUDIO)
  }

  async invoke(action, args = {}) {
    if (this.contents.isDestroyed()) throw new PauseRequired('工作台已关闭，重新打开后可以继续跟踪')
    if (new URL(this.contents.getURL()).origin !== new URL(STUDIO).origin) throw new PauseRequired('请返回 Tripo 生成工作台')
    return this.contents.executeJavaScript(`(${studioPage.toString()})(${JSON.stringify(action)},${JSON.stringify(args)})`)
  }

  async until(read, valid, message, signal, timeout = 30000) {
    let deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new PauseRequired('自动操作已暂停')
      const result = await read()
      if (result?.loginRequired) {
        await this.login(signal)
        deadline = Date.now() + timeout
        continue
      }
      if (valid(result)) return result
      await delay(400, signal)
    }
    throw new PauseRequired(message)
  }

  async ready(signal) {
    await this.until(() => this.invoke('snapshot'), value => value.ready, '网页尚未加载完成，请刷新后继续', signal)
  }

  async configure(config, signal) {
    await this.invoke('smart')
    await this.invoke('multi')
    await this.until(() => this.invoke('snapshot'), value => Object.values(value.slots).every(slot => slot.exists && slot.empty), '三视图槽没有完整清空，请清除网页旧图后继续', signal)
    await this.invoke('quantity')
    await this.invoke('open-topology')
    await this.invoke('topology', { topology: config.topology })
    await this.invoke('faces', { faces: config.faces })
    await this.invoke('commit-faces')
    await this.invoke('close-topology')
    // Record the setting accepted by Studio. UI normalization/rounding must not
    // prevent a requested generation from running.
    await this.invoke('open-topology')
    const actual = await this.invoke('read-topology')
    await this.invoke('close-topology')
    return actual
  }

  attach() {
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3')
  }

  async upload(label, filename, signal) {
    const selector = await this.invoke('mark-upload', { label })
    this.attach()
    const { root } = await this.contents.debugger.sendCommand('DOM.getDocument', { depth: 0 })
    const { nodeId } = await this.contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw new Error('上传控件已变化，请重新准备任务')
    await this.contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filename] })
    await this.until(() => this.invoke('snapshot'), value => value.slots[label]?.ready, `${label} 视图尚未上传完成，请检查网页提示后继续`, signal, 120000)
  }

  async verify(config, labels, signal) {
    if ((await this.invoke('snapshot')).loginRequired) await this.login(signal)
    const state = await this.invoke('verify-inputs')
    if (state.loginRequired) throw new PauseRequired('请先完成登录，再继续任务')
    if (!labels.every(label => state.slots[label]?.ready)) throw new Error('三张图片尚未全部上传完成')
    const unused = ['left', 'right'].find(label => !labels.includes(label))
    if (state.slots[unused]?.ready) throw new Error('未使用的侧面槽中有旧图，请移除后继续')
  }

  async startTracking(record, onEvent) {
    this.stopTracking()
    this.attach()
    this.identity = record.taskId ? { taskId: record.taskId, remoteProjectId: record.remoteProjectId } : null
    this.observationError = null; this.result = null; this.acceptSubmission = false; this.expectedDownloadName = null
    this.events = Promise.resolve(); this.detailEpoch = 0
    this.submissionRequest = null
    const requests = new Map()
    this.listener = (_event, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const route = protocol.apiPath(params.request.url)
        if (!route || !(route === protocol.GENERATE || route === protocol.PROGRESS || route.startsWith(protocol.DETAIL))) return
        // Observe the response even when Studio changes its model version,
        // normalizes values, or represents views/variations differently.
        const generation = route === protocol.GENERATE && params.request.method === 'POST' && this.acceptSubmission && !this.identity && !this.submissionRequest
        if (generation) this.submissionRequest = params.requestId
        if (requests.size > 200) requests.delete(requests.keys().next().value)
        requests.set(params.requestId, { route, generation, epoch: this.detailEpoch })
      }
      if (method === 'Network.responseReceived' && requests.has(params.requestId)) requests.get(params.requestId).httpStatus = params.response.status
      if (method === 'Network.loadingFailed') requests.delete(params.requestId)
      if (method !== 'Network.loadingFinished' || !requests.has(params.requestId)) return
      const request = requests.get(params.requestId)
      requests.delete(params.requestId)
      this.events = this.events.then(async () => {
        if (request.httpStatus < 200 || request.httpStatus >= 300 || !request.httpStatus) return
        const response = await this.contents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
        const raw = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body)
        if (request.generation) {
          const identity = protocol.acceptance(raw)
          if (!identity) throw new Error('未能唯一识别本次网页生成任务，请在资产中核对结果')
          this.identity = identity
          this.acceptSubmission = false
          await onEvent(identity)
        }
        if (!this.identity) return
        if (request.route === protocol.PROGRESS) {
          const rows = protocol.unpack(raw)
          const row = Array.isArray(rows) ? rows.find(item => item.operator_id === this.identity.taskId) : null
          if (row) {
            if (protocol.FAILED.has(row.status)) this.result = { failed: true }
            const progress = typeof row.progress === 'number' ? Math.max(0, Math.min(100, Math.round(row.progress))) : undefined
            if (progress !== this.lastProgress) { this.lastProgress = progress; await onEvent({ ...this.identity, progress }) }
          }
        }
        if (request.route === protocol.DETAIL + this.identity.remoteProjectId && request.epoch === this.detailEpoch) {
          const result = protocol.detailState(raw, this.identity)
          if (result?.conflict) throw new Error('该网页项目已切换到其他生成版本或有新的操作，已暂停自动导出')
          if (result?.ready) this.result = result
        }
      }).catch(error => { this.observationError = new PauseRequired(`无法继续确认网页任务：${error.message}`) })
    }
    this.contents.debugger.on('message', this.listener)
    await this.contents.debugger.sendCommand('Network.enable', { maxResourceBufferSize: 8000000, maxTotalBufferSize: 16000000 })
  }

  stopTracking() {
    if (this.listener && !this.contents.isDestroyed()) this.contents.debugger.removeListener('message', this.listener)
    this.listener = null
  }

  async loadProject(projectId, signal, timeout = 30000, preferredURL = null) {
    if (!protocol.UUID.test(projectId)) throw new Error('无效的网页项目 ID')
    if (signal?.aborted) throw new PauseRequired('已暂停任务跟踪')
    // Keep Studio's canonical slug when it is already known. Replacing it with
    // a bare UUID can provoke another navigation during hydration.
    const current = this.contents.getURL()
    const target = protocol.routeProject(current) === projectId ? current
      : protocol.routeProject(preferredURL) === projectId ? preferredURL : `${STUDIO}/${projectId}`
    try { await this.contents.loadURL(target) }
    catch (error) {
      // ERR_ABORTED can mean the site replaced this navigation. Do not reload
      // again: wait for that replacement and confirm its project identity.
      if (error.errno !== -3 && error.code !== 'ERR_ABORTED' && error.code !== -3) throw error
    }
    const deadline = Date.now() + timeout
    let settled = 0
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new PauseRequired('已暂停任务跟踪')
      if (this.contents.isDestroyed()) throw new PauseRequired('工作台已关闭，请重新打开后继续')
      const correct = protocol.routeProject(this.contents.getURL()) === projectId
      settled = correct && !this.contents.isLoadingMainFrame() ? settled + 1 : 0
      if (settled >= 2) return
      await delay(150, signal)
    }
    throw new PauseRequired('模型页面尚未加载到选中的项目，请待网页加载完成或重新选中模型后继续')
  }

  async recoverCurrentTask(signal) {
    const selected = protocol.routeProject(this.contents.getURL())
    if (!selected) throw new PauseRequired('请先在下方 Tripo 资产中点选这次生成的模型，再点击“接续当前网页模型”')
    if (signal.aborted) throw new PauseRequired('接续已暂停')
    // The user explicitly chose this asset. Export through its UI rather than
    // reloading it and requiring an internal detail response or operator ID.
    const url = new URL(this.contents.getURL())
    return { remoteProjectId: selected, taskId: null, recoveryMode: 'selected-model', selectedModelURL: url.origin + url.pathname }
  }

  async exportSelectedModel(record, signal) {
    this.stopTracking()
    this.observationError = null
    this.expectedDownloadName = null
    this.acceptSubmission = false
    if (!protocol.UUID.test(record.remoteProjectId)) throw new PauseRequired('请先在网页选中需要下载的模型')
    if (protocol.routeProject(this.contents.getURL()) !== record.remoteProjectId) {
      await this.loadProject(record.remoteProjectId, signal, 30000, record.selectedModelURL)
    }
    await this.until(async () => {
      if (protocol.routeProject(this.contents.getURL()) !== record.remoteProjectId) throw new PauseRequired('网页选中的模型已变化，请选回刚才的模型后继续')
      const snapshot = await this.invoke('snapshot')
      return { loginRequired: snapshot.loginRequired, ready: !this.contents.isLoadingMainFrame() && await this.invoke('export-ready') }
    }, value => value.ready, '选中的模型还不能导出，请等待生成或加载完成后点击继续任务', signal, 120000)
    await this.exportPage(record, signal, false)
  }

  async submit(signal) {
    if (signal.aborted) throw new PauseRequired('已暂停；请核对网页是否已经生成')
    this.acceptSubmission = true
    await this.invoke('generate')
  }

  async waitForTask(signal) {
    await this.until(async () => {
      if (this.observationError) throw this.observationError
      const snapshot = await this.invoke('snapshot')
      return { ...snapshot, identity: this.identity }
    }, value => !!value.identity, '未收到可识别的提交结果。请核对 Tripo 资产；程序不会重复提交', signal, 60000)
    await this.events
  }

  async restore(record, signal) {
    if (!protocol.UUID.test(record.remoteProjectId) || !protocol.UUID.test(record.taskId)) throw new Error('缺少完整的网页项目与生成版本 ID')
    if (signal.aborted) throw new PauseRequired('已暂停任务跟踪')
    this.result = null
    this.detailEpoch++
    await this.loadProject(record.remoteProjectId, signal)
    await this.ready(signal)
  }

  async waitForResult(_record, signal) {
    const deadline = Date.now() + 30 * 60 * 1000
    while (Date.now() < deadline) {
      if (signal.aborted) throw new PauseRequired('已暂停跟踪；云端任务仍会继续')
      if (this.observationError) throw this.observationError
      if (this.result?.ready || this.result?.failed) return this.result
      const snapshot = await this.invoke('snapshot')
      if (snapshot.loginRequired) await this.login(signal)
      await delay(1200, signal)
    }
    throw new PauseRequired('等待超时，任务可能仍在云端生成；点击继续只恢复跟踪')
  }

  async exportModel(record, _result, signal) {
    // Reload ONLY the known project, to obtain fresh operator/version evidence
    // before an export action (the web export request is project-bound).
    await this.restore(record, signal)
    const current = await this.waitForResult(record, signal)
    if (!current.ready) throw new PauseRequired('本次生成尚不能导出')
    await this.until(() => this.invoke('export-visible'), value => value === true, '模型已生成，但导出工具栏尚未就绪', signal, 90000)
    await this.exportPage(record, signal, true)
  }

  async exportPage(record, signal, checkOperator) {
    await this.invoke('open-export')
    if (!await this.invoke('export-format')) await this.invoke('select-glb')
    const name = `forge-${record.runId}`
    await this.invoke('export-name', { name })
    await this.until(() => this.invoke('read-export'), value => value.glb && value.name === name, '网页导出格式或文件名未生效', signal)
    if (signal.aborted) throw new PauseRequired('已暂停导出')
    if (protocol.routeProject(this.contents.getURL()) !== record.remoteProjectId || (checkOperator && (this.observationError || !this.result?.ready))) throw new PauseRequired('网页当前模型发生变化，请选回需要下载的模型后继续')
    this.expectedDownloadName = name
    await this.invoke('export-submit')
  }

  acceptsDownload(item) {
    return !!this.expectedDownloadName && item.getFilename().startsWith(this.expectedDownloadName)
  }
}

module.exports = { StudioDriver, PauseRequired, delay }
