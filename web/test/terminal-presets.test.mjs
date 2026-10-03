import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPresets, savePresets, normalizePresets, mutatePreset, presetInput, DEFAULT_PRESETS, PRESET_STORAGE_KEY } from '../src/RemoteTerminal/presets.ts';
const modes={applicationCursor:false,bracketedPaste:false,kittyFlags:0};
test('editable text/chord presets persist independently, preserve order and require explicit Enter', () => {
  const values=new Map(); const storage={getItem:key => values.get(key) ?? null,setItem:(key,value) => values.set(key,value)};
  let list=loadPresets(storage);
  assert.equal(list.length,DEFAULT_PRESETS.length);
  list=mutatePreset(list,{type:'upsert',command:{id:'agent',label:'My agent',kind:'text',text:'aider',appendEnter:false}});
  assert.equal(presetInput(list.at(-1),modes),'aider');
  list=mutatePreset(list,{type:'upsert',command:{...list.at(-1),appendEnter:true}});
  assert.equal(presetInput(list.at(-1),modes),'aider\r');
  list=mutatePreset(list,{type:'delete',id:'agent-pi'});
  list.reverse(); savePresets(storage,list);
  assert.deepEqual(loadPresets(storage),list);
  assert.deepEqual([...values.keys()],[PRESET_STORAGE_KEY]);
  assert.equal(presetInput({id:'x',label:'Up',kind:'chord',chord:{key:'arrowUp',modifiers:[]}},{...modes,applicationCursor:true}),'\x1bOA');
  savePresets(storage,[]); assert.deepEqual(loadPresets(storage),[]);
});
test('invalid persisted shortcuts fail visibly rather than laundering unsafe values', () => {
  assert.throws(() => normalizePresets([{id:'x',label:'bad',kind:'chord',chord:{key:'c',modifiers:['meta']}}]));
  assert.throws(() => normalizePresets([{id:'x',label:'bad',kind:'text',text:'run',appendEnter:'false'}]));
  assert.throws(() => normalizePresets([DEFAULT_PRESETS[0],DEFAULT_PRESETS[0]]));
  assert.throws(() => loadPresets({getItem:() => '{broken'}));
});
