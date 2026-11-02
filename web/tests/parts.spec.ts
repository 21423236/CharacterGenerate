import { test, expect } from '@playwright/test'
import path from 'node:path'
import type { Project, Job } from '../src/api'

test('hair component workflow keeps the character reference and separate image stages', async ({ page }) => {
  const asset = (id: string) => ({id, name:id+'.png', kind:'image', url:'/api/assets/'+id})
  const root: Project = {id:'parts-root', title:'部件角色', prompt:'蓝色长发角色', references:[], sheet:asset('source'), views:{}, messages:[], side:'left', updated:new Date().toISOString()}
  const projects = [root]
  const jobs: Record<string, Job[]> = {}
  const submitted: string[] = []
  const edits: string[] = []
  await page.route('**/api/assets/*', route=>route.fulfill({path:path.resolve('../data/smoke-test/sheet.png'),contentType:'image/png'}))
  await page.route('**/api/projects**', async route=>{
    const request=route.request(), segments=new URL(request.url()).pathname.split('/'), id=segments[3], action=segments[4]
    if(!id)return route.fulfill({json:projects})
    const project=projects.find(p=>p.id===id)!
    if(action==='parts') {
      if(request.method()==='POST') {
        const body=request.postDataJSON()
        const child: Project = {...root,id:'hair-part',parent_id:id,part_kind:body.kind,title:body.title||'发型',sheet:undefined, references:[root.sheet!],views:{}}
        projects.push(child);return route.fulfill({json:child})
      }
      return route.fulfill({json:projects.filter(p=>p.parent_id===id)})
    }
    if(action==='jobs') {
      if(request.method()==='POST') {
        const kind=request.postDataJSON().kind
        submitted.push(kind)
        if(kind==='part_image')project.part_image=asset('hair-isolated')
        if(kind==='part_edit') {
          edits.push(request.postDataJSON().message)
          project.part_edit_prompt=request.postDataJSON().message
          project.part_image=asset('hair-edited')
          project.sheet=undefined;project.views={}
        }
        const job: Job={id:`job-${submitted.length}`,kind,status:kind==='image'?'running':'success',created:new Date().toISOString()}
        jobs[id]=[job,...jobs[id]||[]];return route.fulfill({json:job})
      }
      return route.fulfill({json:jobs[id]||[]})
    }
    if(request.method()==='PATCH')Object.assign(project,request.postDataJSON())
    return route.fulfill({json:project})
  })
  await page.goto('/')
  await page.getByRole('button',{name:'添加部件',exact:true}).click()
  await page.getByRole('button',{name:'编辑部件',exact:true}).click()
  await expect(page.getByRole('heading',{name:'发型工作流'})).toBeVisible()
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'生成独立部件图',exact:true}).click()
  await expect(page.getByAltText('发型独立部件图')).toHaveAttribute('src','/api/assets/hair-isolated')
  await page.getByRole('button',{name:'放大查看 发型独立部件图',exact:true}).click()
  const viewer=page.getByRole('dialog',{name:'发型独立部件图大图预览'})
  await expect(viewer).toBeVisible()
  await viewer.getByRole('button',{name:'放大图片',exact:true}).click()
  await expect(viewer.getByText('150%',{exact:true})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await page.getByLabel('部件修改要求',{exact:true}).fill('保留发色，缩短刘海，去掉发饰')
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'按要求修改当前部件图',exact:true}).click()
  await expect(page.getByAltText('发型独立部件图')).toHaveAttribute('src','/api/assets/hair-edited')
  expect(edits).toEqual(['保留发色，缩短刘海，去掉发饰'])
  await page.getByRole('checkbox',{name:/Tripo 二次智能拆分/}).check()
  await expect.poll(()=>projects[1].split_model).toBe(true)
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'生成三视图',exact:true}).click()
  // Finish on the server while a different project is selected. Re-entering
  // the component must show its saved result without another generation POST.
  await page.getByRole('button',{name:'← 返回角色：部件角色'}).click()
  await expect(page.getByRole('heading',{name:'部件角色',exact:true})).toBeVisible()
  projects[1].sheet=asset('hair-sheet')
  Object.assign(projects[1],{boxes:[[0,0,.33,1],[.33,0,.66,1],[.66,0,1,1]]})
  jobs['hair-part'][0].status='success'
  await page.getByRole('button',{name:'编辑部件',exact:true}).click()
  await expect(page.getByAltText('发型已关联三视图')).toHaveAttribute('src','/api/assets/hair-sheet')
  await page.getByRole('button',{name:'放大查看 发型已关联三视图',exact:true}).click()
  await expect(page.getByRole('dialog').getByAltText('发型已关联三视图放大预览')).toHaveAttribute('src','/api/assets/hair-sheet')
  await page.getByRole('button',{name:'关闭大图预览',exact:true}).click()
  await expect(page.getByRole('button',{name:'重新生成部件三视图（计费）',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'查看／裁切已有三视图',exact:true}).click()
  await expect(page.getByAltText('待拆分角色三视图')).toHaveAttribute('src','/api/assets/hair-sheet')
  expect(submitted).toEqual(['part_image','part_edit','image'])
  await page.getByRole('button',{name:'← 返回角色：部件角色'}).click()
  await expect(page.getByRole('heading',{name:'部件角色',exact:true})).toBeVisible()
  expect(root.sheet?.id).toBe('source')
  await expect(page.getByRole('button',{name:'组装全部部件并绑定'})).toBeDisabled()
})
