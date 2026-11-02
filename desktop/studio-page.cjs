// DOM adapter for the Chinese Studio workspace. Selectors were checked against
// the live P2.0 multi-view/topology UI; unknown or ambiguous controls stop a run.
function studioPage(action, args = {}) {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible)
  const one = (items, label) => {
    if (items.length !== 1) throw new Error(`无法唯一识别${label}（${items.length} 个），请检查网页或更新适配器`)
    return items[0]
  }
  const button = (label, root = document) => one(all('button', root).filter(el => text(el) === label), label)
  const click = el => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error(`网页控件暂不可用：${text(el)}`)
    el.scrollIntoView({ block: 'nearest' }); el.click()
  }
  const dialog = () => one(all('[role="dialog"]').filter(el => el.querySelector('button[value="triangle"]')), '拓扑设置面板')
  const loginRequired = () => all('button').some(el => ['注册/登录', '登录/注册', '发送验证码'].includes(text(el)))
  const slotNames = { front: '前', left: '左侧', right: '右侧', back: '后' }
  const exportDialog = () => one(all('[role="dialog"]').filter(el => /文件名/.test(text(el)) && /格式/.test(text(el)) && el.querySelector('[role="combobox"]')), '模型导出面板')
  const slot = label => {
    const marked = document.querySelector(`[data-forge-slot="${label}"]`)
    if (marked) return marked
    const icon = document.querySelector(`[class~="i-tripo:${label}-view"]`)
    if (!icon) return null
    const root = icon.closest('div[class~="w-1/2"][class~="aspect-square"][class~="box-border"]')
    if (!root || [...root.parentElement.children].filter(el => el.matches('div[class~="w-1/2"][class~="aspect-square"][class~="box-border"]')).length !== 4) return null
    root.setAttribute('data-forge-slot', label)
    return root
  }
  const slotState = label => {
    const root = slot(label)
    if (!root) return { exists: false, ready: false }
    const images = [...root.querySelectorAll('img')].filter(el => visible(el) && el.complete && el.naturalWidth > 0)
    const loading = root.querySelector('[class~="loading-container"],[class~="animate-spin"],[role="progressbar"]')
    const empty = !!root.querySelector('input[type="file"][accept*="image"]')
    return { exists: true, empty, ready: images.length === 1 && !loading && !empty, imageCount: images.length, text: text(root).slice(0,120) }
  }
  switch (action) {
    case 'open-login': {
      if (all('button').some(el => text(el) === '发送验证码')) return true
      const entry = all('button').find(el => ['注册/登录', '登录/注册'].includes(text(el)))
      if (entry) click(entry)
      return true
    }
    case 'snapshot': return {
      ready: all('button').some(el => text(el) === '智能网格') || all('[data-workspace-panel] h2').some(el => text(el) === '智能拆分'), loginRequired: loginRequired(),
      notices: all('[data-sonner-toast],[role="alert"]').map(el => text(el).slice(0,300)),
      slots: Object.fromEntries(Object.keys(slotNames).map(label => [label, slotState(label)])),
    }
    case 'smart': click(button('智能网格')); return true
    case 'multi': click(one(all('button').filter(el => el.querySelector('[class~="i-tripo:multi-view"]')), '多视图模式')); return true
    case 'quantity': click(one(all('button[value="1"][aria-pressed]'), '生成数量 1')); return true
    case 'open-topology': {
      const trigger = one(all('[aria-haspopup="dialog"]').filter(el => text(el) === '拓扑'), '拓扑入口')
      if (trigger.getAttribute('aria-expanded') !== 'true') click(trigger)
      return true
    }
    case 'topology': click(one(all(`button[value="${args.topology}"]`, dialog()), '拓扑模式')); return true
    case 'faces': {
      const input = one(all('input[type="text"],input[type="number"]', dialog()), '面数输入框')
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(args.faces))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    case 'commit-faces': {
      // Studio's wrapped input commits its draft on blur, not DOM change.
      // Commit in a separate invocation after Vue has processed the input.
      // Native focus/blur can be suppressed in a background WebContentsView.
      const input = one(all('input[type="text"],input[type="number"]', dialog()), '面数输入框')
      let blurred = false
      const onBlur = () => { blurred = true }
      input.addEventListener('blur', onBlur, { once: true })
      input.blur()
      input.removeEventListener('blur', onBlur)
      if (!blurred) {
        input.dispatchEvent(new FocusEvent('blur'))
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      }
      return true
    }
    case 'read-topology': {
      const root = dialog()
      return { topology: root.querySelector('button[aria-pressed="true"]')?.value,
        faces: Number(root.querySelector('input')?.value), slider: Number(root.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')) }
    }
    case 'close-topology': click(one(all('button', dialog()).filter(el => el.querySelector('[class~="i-tripo:close"]')), '关闭拓扑面板')); return true
    case 'mark-upload': {
      if (!Object.hasOwn(slotNames, args.label)) throw new Error('无效的视角')
      // Mark all four stable slot containers before Vue replaces their children.
      Object.keys(slotNames).forEach(slot)
      const root = slot(args.label)
      if (!root) throw new Error(`未找到${slotNames[args.label]}视图槽`)
      const input = one([...root.querySelectorAll('input[type="file"][accept*="image"]')], `${slotNames[args.label]}上传控件`)
      document.querySelectorAll('[data-forge-upload]').forEach(el => el.removeAttribute('data-forge-upload'))
      input.setAttribute('data-forge-upload', args.label)
      return `input[data-forge-upload="${args.label}"]`
    }
    case 'verify-inputs': {
      const smart = button('智能网格')
      const quantity = one(all('button[value="1"][aria-pressed]'), '生成数量')
      const p2 = all('[role="combobox"]').some(el => /^P2\.0(?:\s|$)/.test(text(el)))
      const slots = Object.fromEntries(Object.keys(slotNames).map(label => [label, slotState(label)]))
      return { smart: smart.classList.contains('c-black') || smart.getAttribute('aria-selected') === 'true',
        p2, quantity: quantity.getAttribute('aria-pressed') === 'true', slots, loginRequired: loginRequired() }
    }
    case 'generate': {
      if (loginRequired()) throw new Error('登录已失效，请先在网页登录')
      const target = one(all('button').filter(el => /^生成模型(?:\s|$)/.test(text(el))), '生成模型按钮')
      click(target)
      return true
    }
    case 'open-segmentation': {
      const link = one(all('a[href]').filter(el => /^\/workspace\/segmentation\//.test(new URL(el.href).pathname) && text(el) === '智能拆分'), '智能拆分入口')
      if (!new URL(link.href).pathname.endsWith(args.projectId)) throw new Error('拆分入口没有关联当前模型')
      click(link); return true
    }
    case 'segmentation-ready': return all('[data-workspace-panel] button').some(el => /6\s*[-–—~～]\s*15\s*个部件/.test(text(el)))
    case 'segmentation-medium': {
      click(one(all('[data-workspace-panel] button').filter(el => /6\s*[-–—~～]\s*15\s*个部件/.test(text(el))), '第二档 6–15 个部件'))
      return true
    }
    case 'segmentation-submit': click(one(all('[data-workspace-panel] button').filter(el => /^开始拆分(?:\s|$)/.test(text(el))), '开始拆分按钮')); return true
    case 'export-visible': return all('[aria-haspopup="dialog"]').some(el => text(el) === '导出')
    case 'export-ready': {
      const targets = all('[aria-haspopup="dialog"]').filter(el => text(el) === '导出')
      return targets.length === 1 && !targets[0].disabled && !targets[0].closest('[aria-disabled="true"],[disabled]') && getComputedStyle(targets[0]).pointerEvents !== 'none'
    }
    case 'open-export': {
      const trigger = one(all('[aria-haspopup="dialog"]').filter(el => text(el) === '导出'), '模型导出入口')
      if (trigger.getAttribute('aria-expanded') !== 'true') click(trigger)
      return true
    }
    case 'export-format': {
      const root = exportDialog()
      const select = one(all('[role="combobox"]', root).filter(el => /^(GLB|FBX|OBJ|STL|USD|3MF)/i.test(text(el))), '导出格式')
      if (text(select) === 'GLB') return true
      click(select)
      return false
    }
    case 'select-glb': click(one(all('[role="option"]').filter(el => text(el) === 'GLB'), 'GLB 格式')); return true
    case 'export-name': {
      const input = one(all('input:not([type]),input[type="text"]', exportDialog()), '导出文件名')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, args.name)
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.blur()
      return true
    }
    case 'read-export': {
      const root = exportDialog()
      return { name: root.querySelector('input')?.value, glb: all('[role="combobox"]', root).some(el => text(el) === 'GLB') }
    }
    case 'export-submit': click(button('导出', exportDialog())); return true
    default: throw new Error(`未知页面操作：${action}`)
  }
}

module.exports = { studioPage }
