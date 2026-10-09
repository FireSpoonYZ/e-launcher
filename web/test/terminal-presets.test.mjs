import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPresets, savePresets, normalizePresets, mutatePreset, presetInput, DEFAULT_PRESETS, PRESET_STORAGE_KEY } from '../src/RemoteTerminal/presets.ts';
const modes={applicationCursor:false,bracketedPaste:false,kittyFlags:0};
test('editable text/chord presets persist independently, preserve order and require explicit Enter', () => {
  const values=new Map(); const storage={getItem:key => values.get(key) ?? null,setItem:(key,value) => values.set(key,value)};
  let list=loadPresets(storage);
  assert.deepEqual(DEFAULT_PRESETS,[]);
  assert.deepEqual(list,[]);
  list=mutatePreset(list,{type:'upsert',command:{id:'agent',label:'My agent',kind:'text',text:'aider',appendEnter:false}});
  assert.equal(presetInput(list.at(-1),modes),'aider');
  list=mutatePreset(list,{type:'upsert',command:{...list.at(-1),appendEnter:true}});
  assert.equal(presetInput(list.at(-1),modes),'aider\r');
  list=mutatePreset(list,{type:'upsert',command:{id:'interrupt',label:'Ctrl+C',kind:'chord',chord:{key:'c',modifiers:['ctrl']}}});
  list=mutatePreset(list,{type:'upsert',command:{id:'remove-me',label:'Temporary',kind:'text',text:'temp',appendEnter:false}});
  list=mutatePreset(list,{type:'delete',id:'remove-me'});
  assert.deepEqual(list.map(p=>p.id),['agent','interrupt']);
  list.reverse(); savePresets(storage,list);
  assert.deepEqual(loadPresets(storage),list);
  assert.deepEqual([...values.keys()],[PRESET_STORAGE_KEY]);
  assert.equal(presetInput({id:'x',label:'Up',kind:'chord',chord:{key:'arrowUp',modifiers:[]}},{...modes,applicationCursor:true}),'\x1bOA');
  savePresets(storage,[]); assert.deepEqual(loadPresets(storage),[]);
});
test('empty defaults do not replace or rewrite previously saved custom shortcuts', () => {
  const saved=[
    {id:'interrupt',label:'My interrupt',kind:'chord',chord:{key:'c',modifiers:['ctrl']}},
    {id:'agent-pi',label:'My Pi',kind:'text',text:'pi --continue',appendEnter:false},
    {id:'status',label:'My status',kind:'text',text:'git status --short',appendEnter:true},
  ];
  const value=JSON.stringify(saved);
  const storage={getItem:key=>{assert.equal(key,PRESET_STORAGE_KEY);return value;}};
  assert.deepEqual(loadPresets(storage),saved);
});
test('invalid persisted shortcuts fail visibly rather than laundering unsafe values', () => {
  assert.throws(() => normalizePresets([{id:'x',label:'bad',kind:'chord',chord:{key:'c',modifiers:['meta']}}]));
  assert.throws(() => normalizePresets([{id:'x',label:'bad',kind:'text',text:'run',appendEnter:'false'}]));
  const duplicate={id:'duplicate',label:'Ctrl+C',kind:'chord',chord:{key:'c',modifiers:['ctrl']}};
  assert.deepEqual(normalizePresets([duplicate]),[duplicate]);
  assert.throws(() => normalizePresets([duplicate,duplicate]),/Duplicate shortcut ID/);
  assert.throws(() => loadPresets({getItem:() => '{broken'}));
});
