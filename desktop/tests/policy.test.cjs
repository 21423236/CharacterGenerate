const { test } = require('node:test')
const assert = require('node:assert/strict')
const { remoteURL, localURL, projectID, downloadName } = require('../policy.cjs')

test('remote navigation cannot reach local application or native protocols', () => {
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'http://localhost:8765/api/settings', 'http://127.1/', 'http://2130706433/', 'http://[::1]/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'https://name:pass@example.com']) assert.equal(remoteURL(url), false, url)
  assert.equal(remoteURL('https://studio.tripo3d.com/workspace/generate'), true)
  assert.equal(remoteURL('https://accounts.google.com/'), true)
  assert.equal(localURL('http://127.0.0.1:8765/'), true)
  assert.equal(localURL('http://127.0.0.1:8765.evil.example/'), false)
  assert.equal(localURL('https://studio.tripo3d.com/'), false)
})

test('project IDs and downloaded filenames cannot escape their directories', () => {
  assert.throws(() => projectID('../project'))
  assert.throws(() => projectID(undefined))
  assert.equal(projectID('a'.repeat(32)), 'a'.repeat(32))
  assert.equal(downloadName('../../escape.glb'), 'escape.glb')
  assert.equal(downloadName('C:\\Users\\secret.glb'), 'secret.glb')
  assert.equal(downloadName('bad:stream.glb'), 'bad_stream.glb')
  assert.equal(downloadName('...'), 'download.bin')
})
