const status = document.getElementById('status')
let automation = null
let inputs = { ready: false, reason: '正在检查三视图…' }
let invoking = false
function controls() {
  const active = !!automation?.active
  const unfinished = automation && !['complete', 'failed', 'cancelled'].includes(automation.status)
  document.querySelector('[data-action="start"]').disabled = invoking || active || !!unfinished || !inputs.ready
  document.querySelector('[data-action="start"]').title = inputs.reason || ''
  document.querySelector('[data-action="resume"]').disabled = invoking || active || !unfinished
  const recover = document.querySelector('[data-action="recover"]')
  recover.hidden = !unfinished || !automation.submitted
  recover.disabled = invoking || active || recover.hidden
  document.querySelectorAll('[data-action="pause"]').forEach(button => { button.disabled = invoking || !active })
  document.querySelector('[data-action="cancel"]').disabled = invoking || active || !unfinished || automation.submitted
  for (const action of ['reload', 'import']) document.querySelector(`[data-action="${action}"]`).disabled = invoking || active
}
window.studioToolbar.onState(state => {
  const login = state.presentation === 'login'
  document.getElementById('login-heading').hidden = !login
  for (const selector of ['.heading', '.automation-actions', '.actions']) document.querySelector(selector).hidden = login
  document.getElementById('project').textContent = state.title
  status.textContent = state.message
  status.title = state.message
  automation = state.automation
  inputs = state.inputs || { ready: false, reason: '尚未读取三视图状态' }
  document.getElementById('input-status').textContent = inputs.ready ? '三视图已就绪 · 自动运行时请勿更换网页图片或模型' : inputs.reason
  if (automation) document.getElementById('parameters').textContent = `智能网格 · ${automation.topology === 'triangle' ? '三角面' : '四边面'} / ${automation.faces.toLocaleString()} 面 · 网页会员额度`
  controls()
})
document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', async () => {
    invoking = true; button.disabled = true; controls()
    try { await window.studioToolbar.action(button.dataset.action) }
    catch (error) { status.textContent = error.message }
    finally { invoking = false; button.disabled = false; controls() }
  })
})
window.studioToolbar.action('ready').catch(error => { status.textContent = error.message })
