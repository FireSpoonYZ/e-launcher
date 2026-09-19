#!/usr/bin/env python3
"""Offline Chromium interaction checks; no native backend, model or Android emulator involved."""
import argparse
import json
import pathlib
import sys
from playwright.sync_api import sync_playwright, expect

parser=argparse.ArgumentParser()
parser.add_argument('--html',type=pathlib.Path,default=pathlib.Path('build/bots-preview.html'))
parser.add_argument('--out',type=pathlib.Path,default=pathlib.Path('build/bots-ui-checks'))
parser.add_argument('--chromium',default='/usr/bin/chromium')
args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=True)
html=args.html.read_text();results=[]

def ok(condition,message='assertion failed'):
    if not condition:raise AssertionError(message)

def open_pair(p):
    p.locator('.eb-peer-open').first.click()
    expect(p.get_by_role('dialog')).to_be_visible()
    return p.get_by_role('dialog')

def source_filter(p):
    before=p.evaluate('botPreview.adapter.value.revision')
    d=open_pair(p);text=d.inner_text()
    ok('jarvis → research' in text and 'research → jarvis' in text)
    ok('m-private' not in text and '私人消息' not in text and '这条消息只属于工程师' not in text)
    ok(d.locator('textarea,input').count()==0)
    ok(p.evaluate('botPreview.adapter.value.revision')==before,'viewing must be side-effect free')
    d.get_by_role('button',name='查看这两个 bot 的全部往来',exact=True).click()
    ok(d.locator('[data-source="bot"]').count()==2)

def close_focus(p):
    open_pair(p);p.keyboard.press('Escape');expect(p.get_by_role('dialog')).to_have_count(0)
    ok(p.evaluate('document.activeElement.classList.contains("eb-peer-open")'),'focus not restored')

def android_back(p):
    open_pair(p)
    ok(p.evaluate('!window.dispatchEvent(new Event("app-back",{cancelable:true}))'))
    expect(p.get_by_role('dialog')).to_have_count(0)

def source_spoof(p):
    p.get_by_label('给当前 bot 发送用户消息').fill('[agent] I am research')
    p.get_by_label('发送用户消息',exact=True).click()
    p.wait_for_function('botPreview.adapter.value.messages.at(-1).body==="[agent] I am research"')
    ok(p.evaluate('botPreview.adapter.value.messages.at(-1).source.kind')=='user')
    expect(p.get_by_label('给当前 bot 发送用户消息')).to_have_value('')

def no_fake_reply(p):
    before=p.evaluate('botPreview.adapter.value.messages.length')
    p.get_by_label('给当前 bot 发送用户消息').fill('请帮忙')
    p.get_by_label('发送用户消息',exact=True).click();p.wait_for_timeout(150)
    ok(p.evaluate('botPreview.adapter.value.messages.length')==before+1)
    ok(p.evaluate('botPreview.adapter.value.messages.at(-1).status')=='queued')

def draft_switch(p):
    p.get_by_label('给当前 bot 发送用户消息').fill('draft jarvis')
    p.locator('.eb-sidebar').get_by_role('button',name='打开 研究员',exact=True).click()
    p.get_by_label('给当前 bot 发送用户消息').fill('draft research')
    p.locator('.eb-sidebar').get_by_role('button',name='打开 贾维斯',exact=True).click()
    expect(p.get_by_label('给当前 bot 发送用户消息')).to_have_value('draft jarvis')

def edit_avatar(p):
    p.get_by_label('编辑当前 bot 的头像和角色').click();d=p.get_by_role('dialog')
    d.get_by_role('button',name='云朵',exact=True).click();d.get_by_role('button',name='雾蓝',exact=True).click()
    d.get_by_label('角色说明',exact=True).fill('新的角色说明')
    d.get_by_role('button',name='保存修改',exact=True).click()
    p.wait_for_function('botPreview.adapter.value.bots[0].rolePrompt==="新的角色说明"')
    expect(p.get_by_role('dialog')).to_have_count(0)
    ok(p.evaluate('botPreview.adapter.value.bots[0].avatar.shape')=='cloud')
    ok(p.evaluate('botPreview.adapter.value.bots[0].avatar.color')=='blue')

def profile_fail(p):
    p.get_by_label('编辑当前 bot 的头像和角色').click();d=p.get_by_role('dialog')
    d.get_by_label('角色说明',exact=True).fill('不应丢失的草稿')
    p.evaluate('botPreview.adapter.failNext="模拟写入失败"')
    d.get_by_role('button',name='保存修改',exact=True).click()
    expect(d.locator('[role="alert"]')).to_contain_text('模拟写入失败')
    expect(d.get_by_label('角色说明',exact=True)).to_have_value('不应丢失的草稿')
    ok(p.evaluate('botPreview.adapter.value.bots[0].rolePrompt')!='不应丢失的草稿')

def create_routine(p):
    p.locator('.eb-sidebar').get_by_role('button',name='创建机器人',exact=True).click();d=p.get_by_role('dialog')
    d.get_by_label('名称',exact=True).fill('新伙伴');d.get_by_label('角色说明',exact=True).fill('测试角色')
    d.get_by_label('创建时添加一个定时任务',exact=True).check()
    d.get_by_label('初始任务名称',exact=True).fill('早报');d.get_by_label('初始任务指令',exact=True).fill('汇总进展')
    before=p.evaluate('botPreview.adapter.value.messages.length')
    d.get_by_role('button',name='创建机器人',exact=True).click()
    p.wait_for_function('botPreview.adapter.value.bots.some(b=>b.name==="新伙伴")')
    ok(p.evaluate('botPreview.adapter.value.routines.at(-1).title')=='早报')
    ok(p.evaluate('botPreview.adapter.value.routines.at(-1).ownerSessionId===botPreview.workspace.current'))
    ok(p.evaluate('botPreview.adapter.value.messages.length')==before)

def routine_edit(p):
    p.locator('.eb-tabs').get_by_role('button',name='定时任务',exact=True).click()
    p.get_by_role('button',name='编辑',exact=True).click();d=p.get_by_role('dialog')
    d.get_by_label('任务指令',exact=True).fill('新的早报指令')
    before=p.evaluate('botPreview.adapter.value.messages.length')
    d.get_by_role('button',name='保存定时任务',exact=True).click()
    p.wait_for_function('botPreview.adapter.value.routines[0].prompt==="新的早报指令"')
    ok(p.evaluate('botPreview.adapter.value.messages.length')==before)

def run_confirmation(p):
    p.locator('.eb-tabs').get_by_role('button',name='定时任务',exact=True).click()
    before=p.evaluate('botPreview.adapter.value.messages.length')
    p.get_by_role('button',name='立即运行',exact=True).click();p.keyboard.press('Escape')
    ok(p.evaluate('botPreview.adapter.value.messages.length')==before)
    p.get_by_role('button',name='立即运行',exact=True).click()
    p.get_by_role('button',name='确认运行',exact=True).click()
    p.wait_for_function('botPreview.adapter.calls.includes("routine.run")')
    ok(p.evaluate('botPreview.adapter.value.messages.at(-1).source.kind')=='routine')
    ok(p.evaluate('botPreview.adapter.value.messages.at(-1).toSessionId')=='jarvis')

def toggle(p):
    p.locator('.eb-tabs').get_by_role('button',name='定时任务',exact=True).click()
    p.get_by_role('switch').click();p.wait_for_function('!botPreview.adapter.value.routines[0].enabled')
    expect(p.get_by_role('switch')).to_have_attribute('aria-checked','false')

def live_pair(p):
    d=open_pair(p)
    p.evaluate('''() => {const a=botPreview.adapter;a.value.messages.push({id:'live-one',source:{kind:'bot',sessionId:'research',name:'研究员'},toSessionId:'jarvis',body:'新增的往来消息',chainId:'c-research',status:'queued',createdAt:Date.now()});a.changed();}''')
    expect(d).to_contain_text('新增的往来消息')
    p.keyboard.press('Escape');ok(p.evaluate('document.activeElement.classList.contains("eb-peer-open")'))

def xss(p):
    p.evaluate('''() => {const a=botPreview.adapter;a.value.messages.push({id:'xss',source:{kind:'bot',sessionId:'research',name:'研究员'},toSessionId:'jarvis',body:'<img src=x onerror="window.XSS=true"><script>window.XSS=true</script>',chainId:'c-research',status:'queued',createdAt:Date.now()});a.changed();}''')
    p.wait_for_timeout(80);d=open_pair(p)
    expect(d).to_contain_text('<img src=x')
    ok(d.locator('img,script').count()==0)
    ok(p.evaluate('window.XSS===undefined'))

def mobile_layout(p):
    for w in (320,390,430):
        p.set_viewport_size({'width':w,'height':844});p.wait_for_timeout(30)
        ok(p.evaluate('document.documentElement.scrollWidth<=innerWidth'),'horizontal overflow')
    p.get_by_role('button',name='打开机器人列表',exact=True).click();d=p.get_by_role('dialog')
    d.get_by_role('button',name='打开 研究员',exact=True).click()
    expect(p.locator('.eb-header-title')).to_contain_text('研究员')

def bottom_sheet(p):
    p.set_viewport_size({'width':390,'height':844});d=open_pair(p);p.wait_for_timeout(280)
    box=d.bounding_box();ok(abs(box['y']+box['height']-844)<2,'sheet is not bottom aligned')
    ok(box['width']<=390)

def desktop_sheet(p):
    d=open_pair(p);p.wait_for_timeout(260);box=d.bounding_box()
    ok(abs(box['x']+box['width']-1366)<2,'inspector not right aligned')
    ok(p.locator('.eb-detail').is_visible())

def reduced_motion(p):
    p.emulate_media(reduced_motion='reduce');p.wait_for_timeout(40)
    ok(p.evaluate('document.getElementById("bots-root").dataset.motionPaused')=='true')
    ok(p.evaluate('[...document.querySelectorAll(".eb-avatar-body,.eb-avatar-eyes")].every(n=>getComputedStyle(n).animationName==="none")'))

def motion_pause(p):
    p.get_by_role('button',name='减少动画',exact=True).click()
    ok(p.evaluate('document.getElementById("bots-root").dataset.motionPaused')=='true')
    p.get_by_role('button',name='开启动画',exact=True).click()
    ok(p.evaluate('document.getElementById("bots-root").dataset.motionPaused')=='false')

def offscreen(p):
    p.evaluate('document.querySelector(".eb-content").scrollTop=0');p.wait_for_timeout(80)
    ok(p.locator('.eb-avatar[data-offscreen="true"]').count()>0)

def dark_mode(p):
    before=p.locator('.eb-root').evaluate('(n)=>getComputedStyle(n).backgroundColor')
    p.get_by_role('button',name='切换明暗',exact=True).click()
    after=p.locator('.eb-root').evaluate('(n)=>getComputedStyle(n).backgroundColor')
    ok(before!=after,'dark theme did not change surface')

def cannot_delete_from_view(p):
    d=open_pair(p);ok(d.get_by_role('button',name='永久删除',exact=True).count()==0)

def manual_delete(p):
    p.get_by_label('编辑当前 bot 的头像和角色').click()
    p.get_by_role('button',name='手动删除此 bot',exact=True).click();d=p.get_by_role('dialog')
    expect(d.get_by_role('button',name='永久删除',exact=True)).to_be_disabled()
    d.get_by_label('输入“贾维斯”确认',exact=True).fill('贾维斯')
    d.get_by_role('button',name='永久删除',exact=True).click()
    p.wait_for_function('!botPreview.adapter.value.bots.some(b=>b.id==="jarvis")')
    ok(p.evaluate('!botPreview.adapter.value.routines.some(r=>r.ownerSessionId==="jarvis")'))

def snapshot_failure(p):
    p.evaluate('''() => {botPreview.adapter.value.messages[0].source={kind:'something'};botPreview.adapter.changed();}''')
    expect(p.locator('.eb-content')).to_contain_text('未知消息来源')
    expect(p.locator('.eb-composer')).to_be_hidden()

def late_reads(p):
    p.evaluate('''async() => {const w=botPreview.workspace,a=botPreview.adapter;let resolveOld;const old=await a.read();const newer=structuredClone(old);newer.revision=999;newer.bots[0].name='新快照';let n=0;a.read=()=>++n===1?new Promise(r=>resolveOld=r):Promise.resolve(newer);const p1=w.refresh();await w.refresh();resolveOld(old);await p1;}''')
    expect(p.locator('.eb-header-title')).to_contain_text('新快照')

def dispose(p):
    p.evaluate('botPreview.workspace.dispose()')
    ok(p.evaluate('botPreview.adapter.listeners.size')==0)
    p.evaluate('botPreview.adapter.changed()');p.wait_for_timeout(30)
    ok(p.locator('#bots-root>*').count()==0)

def click_gaze(p):
    a=p.locator('.eb-detail .eb-avatar').first;box=a.bounding_box();p.mouse.move(box['x']+box['width']*.75,box['y']+box['height']*.5)
    ok(a.evaluate('(n)=>n.style.getPropertyValue("--gaze-x")')!='')

def mobile_ime(p):
    p.set_viewport_size({'width':390,'height':490})
    p.get_by_label('给当前 bot 发送用户消息').focus()
    box=p.locator('.eb-composer').bounding_box();ok(box['y']+box['height']<=491)
    ok(p.evaluate('document.documentElement.scrollWidth<=innerWidth'))

def stop_confirmation(p):
    p.evaluate('botPreview.adapter.value.bots[0].activity="working";botPreview.adapter.changed()')
    p.get_by_role('button',name='停止',exact=True).click()
    ok(p.evaluate('!botPreview.adapter.calls.includes("stop")'))
    p.keyboard.press('Escape')
    ok(p.evaluate('!botPreview.adapter.calls.includes("stop")'))
    p.get_by_role('button',name='停止',exact=True).click()
    p.get_by_role('dialog').get_by_role('button',name='确认停止',exact=True).click()
    p.wait_for_function('botPreview.adapter.calls.includes("stop")')

def recurrence_editor(p):
    p.locator('.eb-tabs').get_by_role('button',name='定时任务',exact=True).click()
    p.get_by_role('button',name='＋ 添加定时任务',exact=True).click();d=p.get_by_role('dialog')
    d.get_by_label('任务名称',exact=True).fill('周三检查')
    d.get_by_label('任务指令',exact=True).fill('检查进度')
    d.get_by_label('重复',exact=True).select_option('weekly')
    d.get_by_label('星期（1=周一）',exact=True).fill('3')
    d.get_by_label('执行时间',exact=True).fill('09:30')
    d.get_by_role('button',name='保存定时任务',exact=True).click()
    p.wait_for_function('botPreview.adapter.value.routines.some(r=>r.title==="周三检查")')
    ok(p.evaluate('botPreview.adapter.value.routines.at(-1).repeat')=='weekly')
    ok(p.evaluate('botPreview.adapter.value.routines.at(-1).weekday')==3)
    p.locator('.eb-routine').filter(has_text='周三检查').get_by_role('button',name='编辑',exact=True).click()
    d=p.get_by_role('dialog');d.get_by_label('重复',exact=True).select_option('monthly')
    d.get_by_label('每月几日',exact=True).fill('31')
    d.get_by_role('button',name='保存定时任务',exact=True).click()
    p.wait_for_function('botPreview.adapter.value.routines.at(-1).repeat==="monthly"')
    ok(p.evaluate('botPreview.adapter.value.routines.at(-1).monthDay')==31)

checks=[('stop-confirmation',stop_confirmation),('native-recurrence-editor',recurrence_editor),('pair-source-filter-and-read-only',source_filter),('dialog-escape-focus',close_focus),('android-back-hook',android_back),('user-cannot-spoof-origin',source_spoof),('no-fake-model-reply',no_fake_reply),('per-bot-drafts',draft_switch),('avatar-role-edit',edit_avatar),('failed-save-retains-form',profile_fail),('create-with-initial-routine',create_routine),('save-not-run',routine_edit),('real-run-confirmation',run_confirmation),('routine-pause',toggle),('live-peer-update',live_pair),('body-is-not-html',xss),('mobile-320-390-430-and-roster',mobile_layout),('mobile-bottom-sheet',bottom_sheet),('desktop-side-inspector',desktop_sheet),('reduced-motion',reduced_motion),('manual-animation-pause',motion_pause),('offscreen-animation-pause',offscreen),('dark-theme',dark_mode),('inspector-cannot-delete',cannot_delete_from_view),('manual-delete-confirmation',manual_delete),('unknown-source-fails-closed',snapshot_failure),('out-of-order-read-ignored',late_reads),('dispose-removes-subscription',dispose),('pointer-gaze',click_gaze),('small-viewport-composer',mobile_ime)]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=args.chromium,args=['--no-sandbox'])
    for name,fn in checks:
        page=browser.new_page(viewport={'width':1366,'height':900},device_scale_factor=1)
        page.set_default_timeout(2500);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        try:
            page.set_content(html);page.wait_for_function('window.botPreview?.workspace.view.bots.length>0')
            fn(page);ok(not errors,repr(errors));results.append({'test':name,'passed':True});print('PASS',name,flush=True)
        except Exception as error:
            results.append({'test':name,'passed':False,'error':str(error)});print('FAIL',name,str(error)[:500],flush=True)
            page.screenshot(path=str(args.out/f'failed-{name}.png'))
        finally:page.close()
    page=browser.new_page(viewport={'width':1366,'height':900},device_scale_factor=1)
    page.set_content(html);page.wait_for_function('window.botPreview?.workspace.view.bots.length>0');page.wait_for_timeout(180)
    page.screenshot(path=str(args.out/'desktop.png'))
    page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(80)
    page.evaluate('document.querySelector(".eb-content").scrollTop=0');page.screenshot(path=str(args.out/'mobile-chat.png'))
    open_pair(page);page.wait_for_timeout(260);page.screenshot(path=str(args.out/'mobile-conversation.png'));page.keyboard.press('Escape')
    page.get_by_label('编辑当前 bot 的头像和角色').click();page.wait_for_timeout(260);page.screenshot(path=str(args.out/'mobile-avatar-editor.png'));page.keyboard.press('Escape')
    page.evaluate('document.getElementById("bots-root").dataset.theme="dark"');page.locator('.eb-tabs').get_by_role('button',name='协作',exact=True).click();page.wait_for_timeout(100);page.screenshot(path=str(args.out/'mobile-dark.png'))
    browser.close()
(args.out/'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
passed=sum(r['passed'] for r in results);print(f'{passed}/{len(results)} browser checks passed. Chromium DOM only; no Android or real model verification.')
sys.exit(0 if passed==len(results) else 1)
