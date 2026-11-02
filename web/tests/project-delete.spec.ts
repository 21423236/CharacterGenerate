import { test, expect } from '@playwright/test'

test('delete current, other and last characters, then undo', async ({ page }) => {
  const projects = ['甲角色', '乙角色', '丙角色'].map((title, i) => ({ id: `delete-${i}`, title, prompt: '', references: [], views: {}, messages: [], side: 'left', updated: new Date().toISOString() }))
  const hidden = new Set<string>()
  await page.route('**/api/projects', route => route.fulfill({ json: projects.filter(p => !hidden.has(p.id)) }))
  await page.route('**/api/projects/delete-**', route => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = parts[3]
    if(parts[4] === 'jobs') return route.fulfill({ json: [] })
    if(parts[4] === 'restore') hidden.delete(id)
    if(route.request().method() === 'DELETE') hidden.add(id)
    return route.fulfill({ json: projects.find(p => p.id === id) })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '甲角色', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除角色 丙角色' }).click()
  await expect(page.getByRole('heading', { name: '甲角色', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除角色 甲角色' }).click()
  await expect(page.getByRole('heading', { name: '乙角色', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除角色 乙角色' }).click()
  await expect(page.getByRole('button', { name: '创建第一个角色' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('forge-project'))).toBeNull()
  await page.getByRole('button', { name: '撤销删除' }).click()
  await expect(page.getByRole('heading', { name: '乙角色', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '乙角色', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '删除角色 甲角色' })).toHaveCount(0)
})
