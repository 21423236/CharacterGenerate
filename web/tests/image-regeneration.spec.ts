import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Job, Project } from '../src/api'

test('regeneration saves the new design and clearly distinguishes failure from the old sheet', async ({ page }) => {
  const project: Project = { id: 'image-test', title: '换角色测试', prompt: '旧角色红衣游侠', side: 'left',
    references: [], views: {}, messages: [], updated: new Date().toISOString(),
    sheet: { id: 'old-sheet', name: 'old.png', kind: 'image', url: '/api/assets/old-sheet' },
    boxes: [[0, 0, .33, 1], [.33, 0, .66, 1], [.66, 0, 1, 1]] }
  let jobs: Job[] = []
  const submissions: string[] = []
  await page.route('**/api/assets/*', route => route.fulfill({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/smoke-test/sheet.png'), contentType: 'image/png' }))
  await page.route('**/api/projects', route => route.fulfill({ json: [project] }))
  await page.route('**/api/projects/image-test**', async route => {
    const request = route.request()
    if (request.url().endsWith('/jobs')) {
      if (request.method() === 'POST') {
        expect(request.postDataJSON().kind).toBe('image')
        submissions.push(project.prompt)
        const job: Job = { id: `image-${submissions.length}`, kind: 'image', status: 'running', message: '正在生图', created: new Date().toISOString() }
        jobs = [job, ...jobs]
        await route.fulfill({ json: job })
      } else await route.fulfill({ json: jobs })
    } else {
      if (request.method() === 'PATCH') Object.assign(project, request.postDataJSON())
      await route.fulfill({ json: project })
    }
  })
  await page.goto('/')
  await page.getByRole('navigation', { name: '角色制作阶段' }).getByRole('button', { name: /角色设定/ }).click()
  await page.getByLabel('角色设计提示词').fill('新角色蓝色机器人')
  await page.getByRole('button', { name: '保存设定，下一步' }).click()
  await expect(page.getByRole('heading', { name: '角色设计助手' })).toHaveCount(0)
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: '重新生成（计费）', exact: true }).click()
  await expect(page.getByRole('heading', { name: '生成角色总图' })).toBeVisible()
  expect(submissions).toEqual([])
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '重新生成（计费）', exact: true }).click()
  await expect(page.getByText(/正在生成新的三视图，完成后会自动替换预览/)).toBeVisible()
  expect(submissions).toEqual(['新角色蓝色机器人'])
  jobs[0] = { ...jobs[0], status: 'failed', message: '测试：生图服务暂不可用' }
  await expect(page.getByRole('alert').filter({ hasText: '本次三视图未生成成功' })).toContainText('测试：生图服务暂不可用')
  await expect(page.getByText('下方保留的是上次结果，不是本次新图。')).toBeVisible()
  await expect(page.getByAltText('换角色测试角色总图')).toHaveAttribute('src', '/api/assets/old-sheet')
  expect(submissions).toHaveLength(1)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '重新生成（计费）' }).click()
  await expect.poll(() => submissions.length).toBe(2)
  project.sheet = { id: 'new-sheet', name: 'new.png', kind: 'image', url: '/api/assets/new-sheet' }
  jobs[0] = { ...jobs[0], status: 'success', message: '新三视图已生成' }
  await expect(page.getByAltText('换角色测试角色总图')).toHaveAttribute('src', '/api/assets/new-sheet')
  await expect(page.getByText(/本次三视图未生成成功/)).toHaveCount(0)
})
