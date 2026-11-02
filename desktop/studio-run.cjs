const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { PauseRequired } = require('./studio-driver.cjs')

const finished = record => ['complete', 'failed', 'cancelled'].includes(record?.status)
const safeMessage = value => String(value).replace(/https?:\/\/[^\s]+/g, '[网页地址]').slice(0, 700)
function publicRun(record, active = false) {
  if (!record) return null
  const { projectId, runId, status, stage, message, config, submitted, taskId, updated } = record
  return { projectId, runId, status, stage, message, faces: config.faces, topology: config.topology, submitted, taskId, active, updated }
}

class StudioRun {
  constructor({ directory, projectId, driver, onState, onDownload }) {
    this.filename = path.join(directory, 'automation.json')
    this.projectId = projectId
    this.driver = driver
    this.onState = onState
    this.onDownload = onDownload
    this.record = null
    this.active = false
    this.writes = Promise.resolve()
  }

  async load() {
    try {
      this.record = JSON.parse(await fs.readFile(this.filename, 'utf8'))
      if (this.record.projectId !== this.projectId || this.record.version !== 1) throw new Error('自动化任务记录不匹配')
      if (!finished(this.record)) {
        await this.save({ status: 'paused', message: this.record.submitted ? '已有提交记录，点击继续仅跟踪和下载，不会重新生成' : '上次操作已暂停，点击继续完成上传与生成' })
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    return this.publicState()
  }

  publicState() {
    return publicRun(this.record, this.active)
  }

  async save(changes) {
    this.record = { ...this.record, ...changes, updated: new Date().toISOString() }
    const json = JSON.stringify(this.record, null, 2)
    const writing = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.filename), { recursive: true })
      const temporary = this.filename + '.tmp'
      await fs.writeFile(temporary, json)
      await fs.rename(temporary, this.filename)
    })
    this.writes = writing.catch(() => {})
    await writing
    this.onState?.(this.publicState())
  }

  async start({ config, files, assetIds, expectedModelId }) {
    if (this.active) throw new Error('此角色已有自动任务正在执行')
    if (this.record && !finished(this.record)) throw new Error('此角色已有任务，请使用“继续任务”')
    if (!['triangle', 'quad'].includes(config.topology) || !Number.isInteger(config.faces) || config.faces < 500 || config.faces > (config.topology === 'quad' ? 25000 : 50000)) throw new Error('智能网格参数无效')
    const labels = Object.keys(files)
    if (!files.front || !files.back || labels.length !== 3 || Number(!!files.left) + Number(!!files.right) !== 1) throw new Error('需要正面、一个侧面和背面三张视图')
    this.active = true
    try {
      if (this.record && /^[0-9a-f-]{36}$/i.test(this.record.runId)) {
        const history = path.join(path.dirname(this.filename), 'runs')
        await fs.mkdir(history, { recursive: true })
        await fs.writeFile(path.join(history, this.record.runId + '.json'), JSON.stringify(this.record, null, 2))
      }
      await this.save({ version: 1, projectId: this.projectId, runId: randomUUID(), config, files, assetIds, expectedModelId,
        submitted: false, taskId: null, remoteProjectId: null, splitSubmitted: false, splitTaskId: null, splitProjectId: null, recoveryMode: null, selectedModelURL: null, recoveredAt: null, appliedConfig: null, status: 'running', stage: 'preparing', message: '正在打开智能网格工作台', started: new Date().toISOString() })
      this.launch()
    } catch (error) { this.active = false; throw error }
  }

  async resume() {
    if (this.active) return
    if (!this.record || finished(this.record)) throw new Error('没有需要继续的自动任务')
    this.launch()
  }

  async recoverCurrent() {
    if (this.active) throw new Error('请先暂停当前任务')
    if (!this.record?.submitted || finished(this.record)) throw new Error('当前没有需要接续下载的任务')
    this.active = true
    this.abort = new AbortController()
    this.work = (async () => {
      try {
        await this.stage('recovering', '正在关联你选中的网页模型，准备直接导出')
        const identity = await this.driver.recoverCurrentTask(this.abort.signal)
        if (this.abort.signal.aborted) throw new PauseRequired('接续已暂停')
        await this.save({ ...identity, status: 'running', stage: 'exporting', message: '已选中模型，将通过网页直接导出 GLB', recoveredAt: new Date().toISOString() })
      } catch (error) {
        await this.save({ status: 'uncertain', message: safeMessage(error.message) })
        throw error
      } finally {
        this.active = false
        this.onState?.(this.publicState())
      }
    })()
    await this.work
  }

  launch() {
    this.active = true
    this.abort = new AbortController()
    this.onState?.(this.publicState())
    this.work = this.execute(this.abort.signal).catch(async error => {
      if (finished(this.record)) return
      const status = this.record.submitted && !this.record.taskId && this.record.recoveryMode !== 'selected-model' ? 'uncertain' : 'paused'
      await this.save({ status, message: safeMessage(error.message) }).catch(() => {})
    }).finally(() => {
      this.active = false
      this.driver.stopTracking?.()
      this.onState?.(this.publicState())
    })
  }

  async pause() {
    this.abort?.abort()
    await this.work
  }

  async cancel() {
    await this.pause()
    if (!this.record || this.record.submitted) throw new Error('任务已提交，只能暂停或继续跟踪；不能撤销云端生成')
    await this.save({ status: 'cancelled', stage: 'cancelled', message: '未提交任务已取消，可以使用新的三视图重新开始' })
  }

  async stage(stage, message, changes = {}) {
    await this.save({ stage, status: 'running', message, ...changes })
  }

  async execute(signal) {
    if (this.record.submitted && this.record.recoveryMode === 'selected-model') {
      if (this.record.config.splitModel && !this.record.splitSubmitted) { await this.executeSplit(signal); return }
      await this.stage('exporting', '正在导出你选中的网页模型，完成后直接显示结果')
      await this.driver.exportSelectedModel(this.record, signal)
      await this.onDownload(signal)
      if (this.record.status !== 'complete') throw new PauseRequired('下载尚未完成，点击继续任务可再次导出这个模型')
      return
    }
    if (this.record.splitSubmitted) { await this.executeSplit(signal); return }
    if (!this.record.submitted) {
      await this.stage('preparing', '检查登录状态并准备网页')
      await this.driver.reset(signal)
      await this.driver.ready(signal)
      await this.stage('configuring', `智能网格 · ${this.record.config.topology === 'triangle' ? '三角面' : '四边面'} · ${this.record.config.faces.toLocaleString()} 面`)
      const appliedConfig = await this.driver.configure(this.record.config, signal)
      await this.save({ appliedConfig })
      for (const label of ['front', this.record.files.left ? 'left' : 'right', 'back']) {
        await this.stage('uploading', `正在上传${{front:'正面',left:'左侧',right:'右侧',back:'背面'}[label]}图片`)
        await this.driver.upload(label, this.record.files[label], signal)
      }
      await this.driver.verify(this.record.config, Object.keys(this.record.files), signal)
      if (signal.aborted) throw new PauseRequired('自动操作已暂停')
      await this.driver.startTracking(this.record, event => this.taskEvent(event))
      // Durable checkpoint BEFORE the only generation click. A timeout, crash or
      // network error after this point must never replay that click on resume.
      await this.stage('submitting', '正在提交网页生成，请勿重复点击', { submitted: true, submittedAt: new Date().toISOString() })
      await this.driver.submit(signal)
      await this.driver.waitForTask(signal)
    } else {
      if (!this.record.taskId) throw new PauseRequired('请求已发出但未记录任务编号。请在下方 Tripo 资产中选中这次生成的模型，再点击“接续当前网页模型”，即可继续下载结果')
      await this.driver.startTracking(this.record, event => this.taskEvent(event))
      await this.driver.restore(this.record, signal)
    }
    if (signal.aborted) throw new PauseRequired('已暂停跟踪；云端任务仍会继续，可稍后恢复')
    await this.stage('waiting', '已记录本次任务，等待 Tripo 生成完成')
    const result = await this.driver.waitForResult(this.record, signal)
    if (result.failed) { await this.save({ status: 'failed', stage: 'failed', message: 'Tripo 网页报告本次生成失败，可检查网页后重新开始' }); return }
    if (this.record.config.splitModel) { await this.executeSplit(signal); return }
    await this.stage('exporting', '生成完成，正在导出本次任务的 GLB')
    await this.driver.exportModel(this.record, result, signal)
    await this.onDownload(signal)
    if (this.record.status !== 'complete') throw new PauseRequired('下载或回填尚未完成，请检查工具栏提示后继续')
  }

  async executeSplit(signal) {
    if (!this.record.splitSubmitted) {
      await this.stage('split-configuring', '模型已生成，正在选择智能拆分第二档：6–15 个部件')
      await this.driver.prepareSegmentation(this.record, signal)
      await this.driver.startTracking({ ...this.record, operation: 'segmentation', taskId: null }, event => this.splitEvent(event))
      if (signal.aborted) throw new PauseRequired('二次拆分已暂停')
      await this.stage('split-submitting', '正在提交二次拆分，请勿重复操作', { splitSubmitted: true, recoveryMode: null, splitSubmittedAt: new Date().toISOString() })
      await this.driver.submitSegmentation(signal)
      await this.driver.waitForTask(signal)
    } else {
      if (!this.record.splitTaskId) throw new PauseRequired('二次拆分已发出，但未记录编号。请在网页选中拆分结果，再点击“接续当前网页模型”，不会重复拆分')
      await this.driver.startTracking(this.splitRecord(), event => this.splitEvent(event))
      await this.driver.restore(this.splitRecord(), signal)
    }
    await this.stage('split-waiting', '等待 Tripo 二次拆分完成 · 第二档 6–15 个部件')
    const record = this.splitRecord()
    const result = await this.driver.waitForResult(record, signal)
    if (result.failed) throw new PauseRequired('Tripo 报告二次拆分失败，请在网页核对；原生成任务不会重提')
    await this.stage('exporting', '二次拆分完成，正在导出保留独立部件的 GLB')
    await this.driver.exportModel(record, result, signal)
    await this.onDownload(signal)
    if (this.record.status !== 'complete') throw new PauseRequired('拆分模型尚未导入，请继续下载')
  }

  splitRecord() {
    return { ...this.record, operation: 'segmentation', taskId: this.record.splitTaskId, remoteProjectId: this.record.splitProjectId || this.record.remoteProjectId }
  }

  async splitEvent(event) {
    if (!event.taskId || (this.record.splitTaskId && this.record.splitTaskId !== event.taskId)) return
    await this.save({ splitTaskId: event.taskId, splitProjectId: event.remoteProjectId || this.record.remoteProjectId })
  }

  async taskEvent(event) {
    if (!event.taskId || (this.record.taskId && this.record.taskId !== event.taskId)) return
    const changes = { taskId: event.taskId }
    if (event.remoteProjectId) changes.remoteProjectId = event.remoteProjectId
    if (event.progress !== undefined && this.record.stage === 'waiting') changes.message = `Tripo 生成中 · ${event.progress}%`
    await this.save(changes)
  }

  async downloaded() {
    await this.save({ status: 'complete', stage: 'complete', message: '模型已下载并显示，可以继续骨架适配' })
  }
}

module.exports = { StudioRun, safeMessage, publicRun }
