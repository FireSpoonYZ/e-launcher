#!/usr/bin/env python3
"""Exercise the built React Bot page with a mocked Capacitor transport, no model calls.

Run after npm run build:
  uv run --with playwright python scripts/check-bot-controls.py --chromium /path/to/chrome
"""
import argparse
import functools
import http.server
import pathlib
import tempfile
import threading
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--chromium', required=True)
parser.add_argument('--dist', type=pathlib.Path, default=pathlib.Path('web/dist'))
parser.add_argument('--out', type=pathlib.Path, default=pathlib.Path(tempfile.gettempdir()) / 'e-launcher-bot-controls')
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)

TRANSPORT = r"""
window.androidBridge = {};
const calls = [], listeners = new Map();
let callbackId = 0;
const emit = (plugin, event, data) => {
  for (const listener of listeners.values()) if (listener.plugin === plugin && listener.event === event) listener.callback(data);
};
const question = {id:'question-b', questions:[
  {questionIndex:0, header:'方向', question:'选择方向？', multiSelect:false, options:[
    {label:'方案 A',description:'第一个方案',preview:'## 方案 A 预览'}, {label:'方案 B',description:'第二个方案'}]},
  {questionIndex:1, header:'内容', question:'需要哪些内容？', multiSelect:true, options:[
    {label:'文档',description:'写文档'}, {label:'测试',description:'写测试'}]},
  {questionIndex:2, header:'备注', question:'补充说明？', multiSelect:false, options:[
    {label:'无需补充',description:'直接继续'}, {label:'稍后再说',description:'以后补充'}]}
]};
const makeBot = (id,name,running) => ({id,name,rolePrompt:'角色',revision:1,archived:false,activity:running?'working':'idle',
  running,needsUser:running,modelLabel:'old-model',piSelection:{provider:'p',model:'old-model',thinkingLevel:'low'},
  askUser:running?question:null,requestId:running?'run-b':null,questionnairePending:false,questionnaireError:''});
const view = {version:1,revision:1,bots:[makeBot('bot-a','助手 A',false),makeBot('bot-b','助手 B',true)],messages:[],routines:[],notice:''};
const schedule = {tasks:[],records:[],exactAlarmGranted:true,schedulingError:'',timeZone:'Asia/Shanghai'};
const device = {launchRoute:'/bots/bot-b',language:'zh',theme:'light'};
const changed = () => { view.revision++; emit('Bots','botsChanged',{}); };
const headers = {
  Device:['state','close','hideKeyboard'], App:[], SystemBars:['setStyle'],
  Chat:['listConversations','submitQuestionnaire','cancelQuestionnaire','selectConversation'],
  Bots:['workspace','uiAction'], Settings:['settings','query'],
  ScheduledTasks:['snapshot','preview','save']
};
window.controlsTest = {calls,view,changed,emit, rejectReply:true};
window.Capacitor = {
  PluginHeaders: Object.entries(headers).map(([name,methods]) => ({name, methods:[
    ...methods.map(name => ({name,rtype:'promise'})), {name:'addListener',rtype:'callback'}, {name:'removeListener',rtype:'promise'}]})),
  nativeCallback(plugin, method, input, callback) {
    if (method !== 'addListener') throw new Error('Unexpected callback: '+method);
    const id = String(++callbackId); listeners.set(id,{plugin,event:input.eventName,callback}); return id;
  },
  async nativePromise(plugin, method, input = {}) {
    calls.push({plugin,method,input});
    if (method === 'removeListener') { listeners.delete(input.callbackId); return {}; }
    if (plugin === 'Device') return method === 'state' ? device : {};
    if (plugin === 'SystemBars') return {};
    if (plugin === 'Bots' && method === 'workspace') return {snapshot:structuredClone(view),capabilities:{send:true,stop:true,selectModel:true}};
    if (plugin === 'Bots' && method === 'uiAction') {
      if (input.action !== 'selectModel') throw new Error('Unexpected bot action');
      const bot = view.bots.find(bot => bot.id === input.input.id);
      if (bot.running) throw new Error('Bot is running');
      bot.piSelection = {provider:input.input.providerId,model:input.input.modelId,thinkingLevel:input.input.thinkingLevel};
      bot.modelLabel = input.input.modelId; changed(); return {id:bot.id,piSelection:bot.piSelection};
    }
    if (plugin === 'Settings' && method === 'settings') return {settings:{defaultProvider:'p',defaultModel:'old-model'}};
    if (plugin === 'Settings' && method === 'query') {
      const id = 'catalog-request';
      setTimeout(() => {
        emit('Settings','settingsEvent',{id,type:'result',result:[{id:'p',name:'Provider',auth:{configured:true},authMethods:[],models:[
          {id:'old-model',name:'旧模型',thinkingLevels:['low','high']},{id:'new-model',name:'新模型',thinkingLevels:['low','high']}]}]});
        emit('Settings','settingsEvent',{id,type:'end',status:'completed'});
      },0);
      return {requestId:id};
    }
    if (plugin === 'Chat' && method === 'listConversations') return {conversations:view.bots.map(bot=>({id:bot.id,title:bot.name,updated:1}))};
    if (plugin === 'Chat' && method === 'selectConversation') throw new Error('Workspace must not switch native active chat');
    if (plugin === 'Chat' && method === 'submitQuestionnaire') {
      if (controlsTest.rejectReply) {
        setTimeout(() => emit('Chat','chatEvent',{type:'questionnaireReply',conversationId:'bot-b',requestId:'run-b',
          payload:{questionnaireId:'question-b',accepted:false,message:'模拟拒绝，请重试'}}),0);
      } else { view.bots[1].askUser=null; view.bots[1].needsUser=false; view.bots[1].running=false; changed(); }
      return {};
    }
    if (plugin === 'Chat' && method === 'cancelQuestionnaire') { view.bots[1].askUser=null; changed(); return {}; }
    if (plugin === 'ScheduledTasks') {
      if (method === 'preview') return {nextRunAt:Date.now()+86400000,timeZone:'Asia/Shanghai'};
      if (method === 'save') schedule.tasks=[{...input,id:'task-one',revision:1,enabled:true,createdAt:Date.now(),nextRunAt:Date.now()+86400000}];
      return structuredClone(schedule);
    }
    throw new Error('Unexpected native call '+plugin+'.'+method);
  }
};
"""

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(args.dist.resolve()))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True)
        page = browser.new_page(viewport={'width':390,'height':844})
        failures = []
        page.on('pageerror', lambda error: failures.append(str(error)))
        page.add_init_script(TRANSPORT)
        page.goto(f'http://127.0.0.1:{server.server_port}/')
        expect(page.locator('.questionnaire')).to_be_visible()
        expect(page.locator('.eb-composer')).to_be_hidden()
        page.get_by_role('button',name='预览 方案 A',exact=True).click()
        expect(page.get_by_role('dialog')).to_contain_text('方案 A 预览')
        page.get_by_role('button',name='关闭预览',exact=True).click()
        page.get_by_role('radio',name='方案 A 第一个方案',exact=True).click()
        page.get_by_role('button',name='下一题',exact=True).click()
        page.get_by_role('checkbox',name='文档 写文档',exact=True).click()
        page.get_by_role('checkbox',name='测试 写测试',exact=True).click()
        page.get_by_role('button',name='下一题',exact=True).click()
        page.get_by_role('radio',name='自定义回答',exact=True).click()
        page.get_by_role('textbox',name='自定义回答',exact=True).fill('用户补充')
        page.get_by_role('button',name='提交回答',exact=True).click()
        expect(page.locator('.questionnaire')).to_contain_text('模拟拒绝，请重试')
        page.evaluate('controlsTest.rejectReply=false')
        page.get_by_role('button',name='提交回答',exact=True).click()
        expect(page.locator('.questionnaire')).to_have_count(0)
        reply = page.evaluate("controlsTest.calls.filter(c=>c.method==='submitQuestionnaire').at(-1).input")
        assert reply == {'conversationId':'bot-b','requestId':'run-b','questionnaireId':'question-b','answers':[
            {'questionIndex':0,'kind':'option','answer':'方案 A'},
            {'questionIndex':1,'kind':'multi','selected':['文档','测试']},
            {'questionIndex':2,'kind':'custom','answer':'用户补充'}]}, reply
        page.get_by_role('button',name='打开机器人列表',exact=True).click()
        page.get_by_role('dialog').get_by_role('button',name='打开 助手 A',exact=True).click()
        page.locator('.eb-model-button').click()
        page.get_by_role('button',name='新模型 new-model',exact=True).click()
        page.get_by_role('button',name='high',exact=True).click()
        page.get_by_role('button',name='完成',exact=True).click()
        expect(page.locator('.eb-model-button')).to_contain_text('new-model')
        selections = page.evaluate("controlsTest.calls.filter(c=>c.plugin==='Bots'&&c.method==='uiAction').map(c=>c.input.input)")
        assert len(selections) == 2 and all(item['id']=='bot-a' for item in selections), selections
        assert selections[-1]['thinkingLevel'] == 'high'
        assert page.evaluate('controlsTest.view.bots[1].modelLabel') == 'old-model'
        assert page.evaluate("controlsTest.calls.some(c=>c.method==='selectConversation')") is False
        for width in (320,390,430):
            page.set_viewport_size({'width':width,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(args.out / 'model-selection.png'))
        page.evaluate("location.hash='#/schedules'")
        page.get_by_role('button',name='新建任务',exact=True).last.click()
        page.get_by_placeholder('例如：早间简报').fill('测试定时任务')
        page.get_by_placeholder('告诉 Pi，这个时间要做什么…').fill('测试指令')
        page.get_by_label('所属 Bot / 会话',exact=True).select_option('bot-a')
        expect(page.get_by_role('dialog')).to_contain_text('继续所属 Bot 的原会话')
        page.get_by_role('button',name='创建任务',exact=True).click()
        expect(page.get_by_role('dialog')).to_have_count(0)
        saved = page.evaluate("controlsTest.calls.filter(c=>c.plugin==='ScheduledTasks'&&c.method==='save').at(-1).input")
        assert saved['conversationId'] == 'bot-a', saved
        assert not failures, failures
        browser.close()
        print('PASS: built Bot page questionnaire preview/single/multi/custom/rejection retry; per-bot model/thinking isolation; explicit routine owner; mobile overflow')
finally:
    server.shutdown()
    server.server_close()
