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
  await page.route('**/api/assets/*', route=>route.fulfill({path:path.resolve('../data/smoke-test/'+(route.request().url().endsWith('hair-model')?'fixture.glb':'sheet.png')),contentType:route.request().url().endsWith('hair-model')?'model/gltf-binary':'image/png'}))
  await page.route('**/api/projects**', async route=>{
    const request=route.request(), segments=new URL(request.url()).pathname.split('/'), id=segments[3], action=segments[4]
    if(!id)return route.fulfill({json:projects})
    const project=projects.find(p=>p.id===id)!
    if(action==='crop') {
      project.views={front:asset('front'),left:asset('left'),back:asset('back')}
      return route.fulfill({json:project})
    }
    if(action==='upload') {
      project.model={id:'hair-model',name:'hair-model.glb',kind:'model',url:'/api/assets/hair-model'}
      return route.fulfill({json:project})
    }
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
  await expect(page.getByRole('heading',{name:'确定角色的部件清单'})).toBeVisible()
  await expect(page.getByRole('button',{name:'生成独立部件图',exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'添加部件',exact:true}).click()
  await page.getByRole('button',{name:'进入部件建模 →',exact:true}).click()
  await page.getByRole('button',{name:'继续制作 · 发型',exact:true}).click()
  await expect(page.getByRole('heading',{name:'提取独立部件 · 发型'})).toBeVisible()
  await expect(page.getByRole('heading',{name:'角色设计助手'})).toHaveCount(0)
  await expect(page.getByRole('checkbox',{name:/Tripo 二次智能拆分/})).toHaveCount(0)
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
  await page.getByRole('button',{name:'确认部件图，下一步 →',exact:true}).click()
  page.once('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'生成部件三视图',exact:true}).click()
  // Finish on the server while a different project is selected. Re-entering
  // the component must show its saved result without another generation POST.
  await page.getByRole('button',{name:'← 返回角色：部件角色'}).click()
  await expect(page.getByRole('heading',{name:'部件角色',exact:true})).toBeVisible()
  projects[1].sheet=asset('hair-sheet')
  Object.assign(projects[1],{boxes:[[0,0,.33,1],[.33,0,.66,1],[.66,0,1,1]]})
  jobs['hair-part'][0].status='success'
  await page.getByRole('button',{name:'继续制作 · 发型',exact:true}).click()
  await expect(page.getByAltText('发型已关联三视图')).toHaveAttribute('src','/api/assets/hair-sheet')
  await page.getByRole('button',{name:'放大查看 发型已关联三视图',exact:true}).click()
  await expect(page.getByRole('dialog').getByAltText('发型已关联三视图放大预览')).toHaveAttribute('src','/api/assets/hair-sheet')
  await page.getByRole('button',{name:'关闭大图预览',exact:true}).click()
  await expect(page.getByRole('button',{name:'重新生成部件三视图（计费）',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'查看／裁切已有三视图 →',exact:true}).click()
  await expect(page.getByAltText('待裁切部件三视图')).toHaveAttribute('src','/api/assets/hair-sheet')
  await expect(page.getByRole('button',{name:'裁切已确认，进入建模'})).toBeDisabled()
  await page.reload()
  await expect(page.getByAltText('待裁切部件三视图')).toHaveAttribute('src','/api/assets/hair-sheet')
  await page.getByRole('navigation',{name:'部件制作阶段'}).getByRole('button',{name:/生成模型/}).click()
  await page.getByText('部件建模选项',{exact:true}).click()
  await page.getByRole('checkbox',{name:/Tripo 二次智能拆分/}).check()
  await expect.poll(()=>projects[1].split_model).toBe(true)
  await expect(page.getByRole('button',{name:'前往裁切确认'})).toBeVisible()
  await page.getByRole('button',{name:'前往裁切确认'}).click()
  await page.getByRole('checkbox',{name:/我已确认三个视图属于同一部件/}).check()
  await page.getByRole('button',{name:'确认裁切，保存三张视图'}).click()
  await expect(page.getByAltText('正面 / FRONT')).toBeVisible()
  await page.getByRole('button',{name:'裁切已确认，进入建模'}).click()
  const chooser=page.waitForEvent('filechooser')
  await page.getByRole('button',{name:'导入 GLB'}).click()
  await (await chooser).setFiles(path.resolve('../data/smoke-test/fixture.glb'))
  await expect(page.getByRole('button',{name:'完成，返回部件总览'})).toBeVisible()
  await expect(page.getByRole('link',{name:'下载原始模型'})).toBeVisible()
  await page.setViewportSize({width:390,height:844})
  await page.screenshot({path:path.resolve('../data/part-workflow-mobile.png'),fullPage:true})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)).toBe(false)
  await page.setViewportSize({width:1512,height:1080})
  await page.screenshot({path:path.resolve('../data/part-workflow.png'),fullPage:true})
  expect(submitted).toEqual(['part_image','part_edit','image'])
  await page.getByRole('button',{name:'← 返回角色：部件角色'}).click()
  await expect(page.getByRole('heading',{name:'部件角色',exact:true})).toBeVisible()
  expect(root.sheet?.id).toBe('source')
  await expect(page.getByRole('button',{name:'组装全部部件并绑定'})).toBeDisabled()
  await page.getByRole('navigation',{name:'角色制作阶段'}).getByRole('button',{name:/角色设定/}).click()
  await expect(page.getByRole('heading',{name:'角色设计助手'})).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading',{name:'角色设计助手'})).toBeVisible()
  await page.getByRole('navigation',{name:'角色制作阶段'}).getByRole('button',{name:/部件建模/}).click()
  await page.getByRole('button',{name:'查看部件模型 · 发型'}).click()
  await expect(page.getByRole('heading',{name:'生成部件模型 · 发型'})).toBeVisible()
})
