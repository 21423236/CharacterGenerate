const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { zipSync } = require('fflate')
const { StudioRun } = require('../studio-run.cjs')
const { modelFromDownload } = require('../studio-download.cjs')
const { acceptance, detailState, routeProject } = require('../studio-protocol.cjs')
const { StudioDriver } = require('../studio-driver.cjs')
const { EventEmitter } = require('node:events')

const project = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const operator = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const other = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const directory = async () => {
  const dir = path.join(__dirname, '../../data/test-cache/studio-automation', require('node:crypto').randomUUID())
  await fs.mkdir(dir, { recursive: true })
  return dir
}
const options = { config: { topology: 'triangle', faces: 15000 }, files: { front: 'front.png', left: 'left.png', back: 'back.png' }, assetIds: {}, expectedModelId: '' }

test('accepted submissions are tracked despite changed, normalized or absent request fields', async () => {
  for (const body of [undefined, '{invalid JSON', JSON.stringify({ model_version: 'future-model', face_limit: '14999', image: [], variations: [] })]) {
    const debuggerAPI = new EventEmitter()
    debuggerAPI.isAttached = () => true
    debuggerAPI.sendCommand = async method => method === 'Network.getResponseBody' ? { body: JSON.stringify({ data: { project_id: project, operator_id: operator } }) } : {}
    const driver = new StudioDriver({ debugger: debuggerAPI, isDestroyed: () => false })
    const observed = []
    await driver.startTracking(options, event => observed.push(event))
    driver.acceptSubmission = true
    const request = { url: 'https://api-cn.tripo3d.com/v2/studio/operation/multiview_to_model', method: 'POST', postData: body }
    debuggerAPI.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'first', request })
    debuggerAPI.emit('message', {}, 'Network.responseReceived', { requestId: 'first', response: { status: 202 } })
    debuggerAPI.emit('message', {}, 'Network.loadingFinished', { requestId: 'first' })
    await driver.events
    assert.equal(driver.observationError, null)
    assert.deepEqual(observed, [{ taskId: operator, remoteProjectId: project }])
    driver.stopTracking()
  }
})

test('explicit selection can be recovered without navigating or inspecting network responses', async () => {
  let url = 'https://studio.tripo3d.com/workspace/generate'
  const driver = new StudioDriver({ getURL: () => url })
  const signal = new AbortController().signal
  await assert.rejects(driver.recoverCurrentTask(signal), /点选/)
  url += '/female-witch-' + project + '?private=omit'
  const selected = await driver.recoverCurrentTask(signal)
  assert.equal(selected.remoteProjectId, project)
  assert.equal(selected.recoveryMode, 'selected-model')
  assert.equal(selected.taskId, null)
  assert.equal(selected.selectedModelURL, url.split('?')[0])
})

test('a selected model resumes directly after restart without submitting or requiring a task ID', async () => {
  const dir = await directory()
  let exports = 0
  let run
  const driver = {
    exportSelectedModel: async record => { assert.equal(record.remoteProjectId, project); assert.equal(record.taskId, null); exports++ },
  }
  try {
    run = new StudioRun({ directory: dir, projectId: 'a'.repeat(32), driver, onDownload: async () => run.downloaded() })
    await run.save({ version: 1, projectId: 'a'.repeat(32), runId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', config: options.config,
      submitted: true, taskId: null, remoteProjectId: project, recoveryMode: 'selected-model', status: 'paused' })
    run = new StudioRun({ directory: dir, projectId: 'a'.repeat(32), driver, onDownload: async () => run.downloaded() })
    await run.load(); await run.resume(); await run.work
    assert.equal(exports, 1)
    assert.equal(run.record.status, 'complete')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('project loading tolerates aborted canonical redirects without replaying navigation', async () => {
  const canonical = 'https://studio.tripo3d.com/workspace/generate/female-witch-' + project
  let current = 'https://studio.tripo3d.com/workspace/generate'
  const loads = []
  const contents = {
    getURL: () => current, isDestroyed: () => false, isLoadingMainFrame: () => false,
    loadURL: async url => { loads.push(url); current = canonical; throw Object.assign(new Error('navigation replaced'), { errno: -3, code: 'ERR_ABORTED' }) },
  }
  const driver = new StudioDriver(contents)
  const signal = new AbortController().signal
  await driver.loadProject(project, signal)
  assert.deepEqual(loads, ['https://studio.tripo3d.com/workspace/generate/' + project])
  await driver.loadProject(project, signal)
  assert.equal(loads[1], canonical)
  assert.equal(loads.length, 2)
})

test('project loading still rejects genuine failures, wrong projects and cancellation', async () => {
  const contents = {
    getURL: () => 'https://studio.tripo3d.com/workspace/generate/' + other,
    isDestroyed: () => false, isLoadingMainFrame: () => false,
    loadURL: async () => { throw Object.assign(new Error('TLS connection closed'), { errno: -100 }) },
  }
  const driver = new StudioDriver(contents)
  const abort = new AbortController()
  await assert.rejects(driver.loadProject(project, abort.signal), /TLS connection closed/)
  contents.loadURL = async () => { throw Object.assign(new Error('replaced'), { errno: -3 }) }
  await assert.rejects(driver.loadProject(project, abort.signal, 1), /尚未加载到选中的项目/)
  abort.abort()
  await assert.rejects(driver.loadProject(project, abort.signal), /已暂停/)
})

test('acceptance and completion reject other projects, old operators and placeholders', () => {
  const identity = { taskId: operator, remoteProjectId: project }
  assert.deepEqual(acceptance({ code: 0, data: { project_id: project, operator_id: operator } }), identity)
  assert.equal(acceptance({ code: 401, data: { project_id: project, operator_id: operator } }), null)
  assert.equal(acceptance({ data: { task_id: operator } }), null)
  assert.equal(acceptance({ variations: [{ accepted: true, project_id: project, operator_id: operator }, { accepted: true, project_id: other, operator_id: other }] }), null)
  const detail = { id: project, model_url: 'https://example.com/model.glb', operator: { operator_id: operator, is_latest_operator: true } }
  assert.equal(detailState(detail, identity).ready, true)
  assert.equal(detailState({ ...detail, id: other }, identity), null)
  assert.equal(detailState({ ...detail, operator: { operator_id: other, is_latest_operator: true } }, identity).conflict, true)
  assert.equal(detailState({ ...detail, running_operator: { operator_id: operator } }, identity).pending, true)
  assert.equal(detailState({ ...detail, model_url: undefined, point_cloud_model_url: 'https://example.com/preview.glb' }, identity).ready, undefined)
  assert.equal(routeProject('https://studio.tripo3d.com/workspace/generate/a-model-' + project), project)
})

test('submission checkpoint survives failure and restart without repeating generation', async () => {
  const dir = await directory()
  let clicks = 0
  const driver = { reset: async()=>{}, ready: async()=>{}, configure: async()=>{}, upload: async()=>{}, verify: async()=>{}, startTracking: async()=>{}, stopTracking:()=>{}, submit: async()=>{
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'automation.json'), 'utf8'))
    assert.equal(saved.submitted, true)
    clicks++
    throw new Error('network disconnected after click')
  } }
  try {
    const run = new StudioRun({ directory: dir, projectId: 'a'.repeat(32), driver })
    await run.start(options); await run.work
    assert.equal(run.record.status, 'uncertain')
    assert.equal(clicks, 1)
    await assert.rejects(run.start(options), /继续/)
    const restored = new StudioRun({ directory: dir, projectId: 'a'.repeat(32), driver })
    await restored.load(); await restored.resume(); await restored.work
    assert.equal(restored.record.status, 'uncertain')
    assert.equal(clicks, 1)
    await assert.rejects(restored.cancel(), /已提交/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a pre-submit pause can be cancelled and replaced with a fresh input snapshot', async () => {
  const dir = await directory()
  try {
    const driver = { reset: async()=>{}, ready: async()=>{throw new Error('login required')}, stopTracking:()=>{} }
    const run = new StudioRun({ directory: dir, projectId: 'a'.repeat(32), driver })
    await run.start(options); await run.work
    const original = run.record.runId
    assert.equal(run.record.submitted, false)
    await run.cancel()
    assert.equal(run.record.status, 'cancelled')
    await run.start({ ...options, config: { topology: 'triangle', faces: 12000 } }); await run.work
    assert.notEqual(run.record.runId, original)
    assert.equal(run.record.config.faces, 12000)
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'runs', original + '.json'), 'utf8')).status, 'cancelled')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('archives extract only a unique bounded GLB without using archive paths', async () => {
  const dir = await directory()
  try {
    const filename = path.join(dir, 'model.zip')
    const glb = Buffer.from('glTFtest-content-validated-by-backend')
    await fs.writeFile(filename, zipSync({ '../../escape.glb': glb, 'texture.png': Buffer.from('not extracted') }))
    const result = await modelFromDownload(filename)
    assert.equal(result, filename + '.glb')
    assert.deepEqual(await fs.readFile(result), glb)
    assert.deepEqual((await fs.readdir(dir)).sort(), ['model.zip', 'model.zip.glb'])
    const ambiguous = path.join(dir, 'ambiguous.zip')
    await fs.writeFile(ambiguous, zipSync({ 'a.glb': glb, 'b.glb': glb }))
    await assert.rejects(modelFromDownload(ambiguous), /唯一/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
