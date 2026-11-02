const { test } = require('node:test')
const assert = require('node:assert/strict')
const { configureStudioNetwork, networkDiagnostic } = require('../studio-network.cjs')

test('only bypass services after system failure and successful credential-free direct preflight', async () => {
  for (const [systemOK, directOK, expected] of [[true, true, 'system'], [false, false, 'system'], [false, true, 'service-direct']]) {
    let mode, applied
    const probe = {
      setProxy: async value => { mode = value.mode }, closeAllConnections: async () => {},
      fetch: async (url, options) => {
        assert.ok(['auth-cn.tripo3d.com', 'api-cn.tripo3d.com', 'msapi.tripo3d.com'].includes(new URL(url).hostname))
        assert.equal(options.method, 'OPTIONS')
        assert.equal(options.credentials, 'omit')
        if (!(mode === 'system' ? systemOK : directOK)) throw new Error('net::ERR_CONNECTION_CLOSED')
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': 'https://studio.tripo3d.com' } })
      },
    }
    const studio = { resolveProxy: async () => 'PROXY 127.0.0.1:10808', setProxy: async value => { applied = value } }
    const result = await configureStudioNetwork(studio, { fromPartition: () => probe }, async () => ({ server: '127.0.0.1:10808', bypass: '<local>;*.example.test' }))
    assert.equal(result.mode, expected)
    assert.deepEqual(applied, expected === 'system' ? undefined : { mode: 'fixed_servers', proxyRules: '127.0.0.1:10808', proxyBypassRules: '<local>;*.example.test;auth-cn.tripo3d.com;api-cn.tripo3d.com;msapi.tripo3d.com' })
  }
})

test('mixed connectivity only bypasses a service whose direct probe succeeds', async () => {
  let mode, applied
  const probe = {
    setProxy: async value => { mode = value.mode }, closeAllConnections: async () => {},
    fetch: async url => {
      const host = new URL(url).hostname
      if (host === 'msapi.tripo3d.com' || (host === 'api-cn.tripo3d.com' && mode === 'system')) throw new Error('closed')
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': 'https://studio.tripo3d.com' } })
    },
  }
  const studio = { resolveProxy: async () => 'PROXY 127.0.0.1:10808', setProxy: async value => { applied = value } }
  const result = await configureStudioNetwork(studio, { fromPartition: () => probe }, async () => ({ server: '127.0.0.1:10808', bypass: '<local>' }))
  assert.deepEqual(result.bypass, ['api-cn.tripo3d.com'])
  assert.equal(applied.proxyBypassRules, '<local>;api-cn.tripo3d.com')
})

test('diagnostics omit login credentials, paths, query parameters and headers', () => {
  const record = networkDiagnostic({ url: 'https://auth-cn.tripo3d.com/self-service/login?flow=secret&code=123456', method: 'POST', error: 'net::ERR_CONNECTION_CLOSED', requestHeaders: { Cookie: 'secret-cookie' }, uploadData: 'secret-phone' })
  assert.equal(record.route, 'login-flow')
  assert.equal(record.error, 'net::ERR_CONNECTION_CLOSED')
  assert.doesNotMatch(JSON.stringify(record), /secret|123456|self-service/)
  assert.equal(networkDiagnostic({ url: 'https://other.example/private', statusCode: 500 }), null)
  assert.equal(networkDiagnostic({ url: 'https://auth-cn.tripo3d.com/sessions/whoami', statusCode: 200 }), null)
})

test('system PAC or changed routing does not get replaced', async () => {
  const sessions = { fromPartition: () => { throw new Error('unexpected probe') } }
  assert.equal((await configureStudioNetwork({}, sessions, async () => null)).mode, 'system')
  assert.equal((await configureStudioNetwork({ resolveProxy: async () => 'DIRECT' }, sessions, async () => ({ server: '127.0.0.1:10808' }))).mode, 'system')
})
