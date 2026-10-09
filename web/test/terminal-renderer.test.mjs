import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { attachTerminalRenderer } from '../src/RemoteTerminal/renderer.ts';

function harness({ failCreate = 0, failLoad = 0, failRefresh = false } = {}) {
  const addons = [], events = [];
  let creates = 0, renderer = 'DOM';
  const term = {
    rows: 24,
    loadAddon(addon) {
      events.push('load');
      if (addons.length === failLoad) throw new Error('WebGL2 unavailable');
      renderer = 'WebGL';
    },
    refresh(start, end) {
      events.push(['refresh', start, end]);
      if (failRefresh) throw new Error('surface unavailable');
    },
  };
  const createAddon = () => {
    if (++creates === failCreate) throw new Error('constructor failed');
    const listeners = new Set(), callbacks = [];
    const addon = {
      disposals: 0,
      get listeners() { return listeners.size; },
      onContextLoss(callback) {
        listeners.add(callback); callbacks.push(callback);
        return { dispose() { listeners.delete(callback); events.push('unlisten'); } };
      },
      lose() { for (const callback of [...listeners]) callback(); },
      staleLoss() { for (const callback of callbacks) callback(); },
      dispose() { this.disposals++; renderer = 'DOM'; events.push('dispose'); },
    };
    addons.push(addon);
    return addon;
  };
  const controller = attachTerminalRenderer(term, createAddon);
  return { addons, events, controller, get creates() { return creates; }, get renderer() { return renderer; } };
}

test('terminal renderer initializes WebGL and unload removes listener before disposing addon', () => {
  const h = harness();
  assert.equal(h.renderer, 'WebGL');
  assert.equal(h.addons[0].listeners, 1);
  h.controller.dispose(); h.controller.dispose();
  assert.equal(h.renderer, 'DOM');
  assert.equal(h.addons[0].listeners, 0);
  assert.equal(h.addons[0].disposals, 1);
  assert.deepEqual(h.events, ['load', 'unlisten', 'dispose']);
  h.addons[0].staleLoss();
  assert.equal(h.creates, 1);
});

for (const failure of ['failCreate', 'failLoad']) test('terminal renderer keeps DOM on ' + failure, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ [failure]: 1 });
  assert.equal(h.renderer, 'DOM');
  assert.deepEqual(h.events.at(-1), ['refresh', 0, 23]);
  if (failure === 'failLoad') {
    assert.equal(h.addons[0].disposals, 1);
    assert.equal(h.addons[0].listeners, 0);
  }
  t.mock.timers.tick(1000);
  assert.equal(h.creates, 1, 'initialization failure does not loop');
  h.controller.dispose();
});

test('terminal renderer context loss falls back to DOM, retries once at 100 ms, then stays on DOM', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.addons[0].lose();
  assert.equal(h.renderer, 'DOM');
  assert.equal(h.addons[0].disposals, 1);
  assert.equal(h.addons[0].listeners, 0);
  assert.deepEqual(h.events.slice(1), ['unlisten', 'dispose', ['refresh', 0, 23]]);
  h.addons[0].staleLoss();
  t.mock.timers.tick(99); assert.equal(h.creates, 1);
  t.mock.timers.tick(1); assert.equal(h.creates, 2); assert.equal(h.renderer, 'WebGL');
  h.addons[0].staleLoss(); assert.equal(h.renderer, 'WebGL');
  h.addons[1].lose();
  t.mock.timers.tick(1000);
  assert.equal(h.creates, 2); assert.equal(h.renderer, 'DOM');
  assert.equal(h.addons[1].listeners, 0);
  h.controller.dispose();
  assert.equal(h.addons[1].disposals, 1);
});

test('terminal renderer unload cancels the pending recovery and ignores late loss callbacks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.addons[0].lose(); h.controller.dispose();
  h.addons[0].staleLoss(); t.mock.timers.tick(1000);
  assert.equal(h.creates, 1); assert.equal(h.renderer, 'DOM');
  assert.equal(h.addons[0].disposals, 1);
});

test('terminal renderer failed recovery stays on DOM even if refresh also fails', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ failLoad: 2, failRefresh: true });
  h.addons[0].lose(); t.mock.timers.tick(100);
  assert.equal(h.renderer, 'DOM'); assert.equal(h.creates, 2);
  assert.equal(h.addons[1].disposals, 1); assert.equal(h.addons[1].listeners, 0);
  t.mock.timers.tick(1000); assert.equal(h.creates, 2);
  h.controller.dispose();
});

test('TerminalView opens before attaching official WebGL and cleans it up before xterm', () => {
  const source = readFileSync(new URL('../src/RemoteTerminal/TerminalView.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ WebglAddon \} from '@xterm\/addon-webgl'/);
  assert.match(source, /term\.open\(element\.current!\)/);
  assert.match(source, /attachTerminalRenderer\(term, \(\) => new WebglAddon\(\), applyTheme\)/);
  assert.match(source, /renderer\.dispose\(\); term\.dispose\(\)/);
  assert.match(source, /activateOrcaTerminalUnicodeProvider\(term\)/);
  assert.doesNotMatch(source, /term\.on(Data|Binary)\(/);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@xterm/addon-webgl'], '0.20.0-beta.299');
});

test('pinned official addon custom glyph path covers Powerline separators and box drawing', () => {
  const base = new URL('../../node_modules/@xterm/addon-webgl/', import.meta.url);
  const definitions = readFileSync(new URL('src/customGlyphs/CustomGlyphDefinitions.ts', base), 'utf8');
  for (const code of ['E0B0', 'E0B1', 'E0B4']) {
    assert.ok(definitions.includes('\\u{' + code + '}'), 'custom glyph U+' + code);
  }
  assert.match(definitions, /'─': \{ type: CustomGlyphDefinitionType\.PATH_FUNCTION/);
  const addon = readFileSync(new URL('src/WebglAddon.ts', base), 'utf8');
  assert.match(addon, /this\._customGlyphs = options\?\.customGlyphs \?\? true/);
  assert.match(addon, /renderService\.setRenderer\(\(this\._terminal as any\)\._core\._createRenderer\(\)\)/);
  const atlas = readFileSync(new URL('src/TextureAtlas.ts', base), 'utf8');
  assert.match(atlas, /customGlyph = tryDrawCustomGlyph\(/);
});

test('foreground reapplies theme, clears active atlas, refreshes all rows and detaches visibility listener',()=>{
 const events=[],visibility=new EventTarget();visibility.visibilityState='hidden';
 let contextLoss;
 const addon={clearTextureAtlas(){events.push('atlas');},onContextLoss(fn){contextLoss=fn;return{dispose(){}};},dispose(){}};
 const term={rows:8,loadAddon(){},refresh(a,b){events.push(['refresh',a,b]);}};
 const renderer=attachTerminalRenderer(term,()=>addon,()=>events.push('theme'),visibility);
 visibility.dispatchEvent(new Event('visibilitychange'));assert.deepEqual(events,[]);
 visibility.visibilityState='visible';visibility.dispatchEvent(new Event('visibilitychange'));
 assert.deepEqual(events,['theme','atlas',['refresh',0,7]]);
 renderer.dispose();visibility.dispatchEvent(new Event('visibilitychange'));renderer.resume();
 assert.equal(events.length,3);
});
