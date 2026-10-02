import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const translate = (zh, _en) => zh;
function load(hooks = {}, native = {}) {
  const source = readFileSync(new URL('../src/Schedules.tsx', import.meta.url), 'utf8')
    + '\nexport {repeatLabel, countdown, TimeWheel, useNextRun};';
  const {outputText} = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }});
  const module = {exports: {}};
  const mocks = {
    react: {...require('react'), ...hooks},
    './native': {ScheduledTasks: native},
    './Settings': {}, './ui': {}, './components/ui/dialog': {}, './schedules.css': {},
    './latestRequest': {},
  };
  new Function('require', 'module', 'exports', outputText)(
    name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports);
  return module.exports;
}

test('Schedules repeat summaries keep legacy weekly and monthly and distinguish note from time', () => {
  const {repeatLabel, countdown} = load();
  const rule = {repeat: 'weekly', weekday: 5, time: '08:00', monthDay: 31};
  assert.equal(repeatLabel(rule, translate), '每周 五');
  assert.equal(repeatLabel({...rule, weekdays: [1, 2, 3, 4, 5]}, translate), '工作日');
  assert.equal(repeatLabel({...rule, weekdays: [6, 7]}, translate), '周末');
  assert.equal(repeatLabel({...rule, weekdays: [1, 2, 3, 4, 5, 6, 7]}, translate), '每天');
  assert.equal(repeatLabel({...rule, repeat: 'once'}, translate), '只执行一次');
  assert.equal(repeatLabel({...rule, repeat: 'monthly'}, translate), '每月 31 日');
  assert.equal(countdown(90061000, 0, translate), '距执行还有 1 天 1 小时 2 分钟');
  assert.equal(countdown(1000, 0, translate), '距执行还有 1 分钟');
});

test('Schedules wheel keyboard wraps and scroll settles to a clamped integral value', () => {
  const previousWindow = globalThis.window;
  let idle, changed, moving, wheel;
  globalThis.window = {clearTimeout() {}, setTimeout(fn) { idle = fn; return 1; }};
  const ref = {current: {scrollTop: 0, scrollTo({top}) { this.scrollTop = top; }}};
  const render = (value = 23, disabled = false) => {
    let refs = 0;
    const {TimeWheel} = load({
      useRef(initial) { return refs++ === 0 ? ref : {current: initial}; },
      useEffect(effect) { effect(); },
    });
    wheel = TimeWheel({label: '小时', count: 24, value, disabled, onChange: value => { changed = value; }, onMoving: value => { moving = value; }});
  };
  try {
    render();
    assert.equal(wheel.props.role, 'spinbutton');
    assert.equal(wheel.props['aria-valuemax'], 23);
    let prevented = false;
    wheel.props.onKeyDown({key: 'ArrowDown', preventDefault() { prevented = true; }});
    assert.equal(changed, 0); assert.ok(prevented);
    render(0);
    wheel.props.onKeyDown({key: 'ArrowUp', preventDefault() {}});
    assert.equal(changed, 23);
    wheel.props.onKeyDown({key: 'Home', preventDefault() {}});
    assert.equal(changed, 0);
    wheel.props.onKeyDown({key: 'End', preventDefault() {}});
    assert.equal(changed, 23);
    ref.current.scrollTop = 10.6 * 48;
    wheel.props.onScroll(); assert.equal(moving, true); idle();
    assert.equal(changed, 11); assert.equal(ref.current.scrollTop, 11 * 48); assert.equal(moving, false);
    ref.current.scrollTop = 9999; wheel.props.onScroll(); idle();
    assert.equal(changed, 23);
    render(3, true); changed = undefined;
    wheel.props.onKeyDown({key: 'ArrowDown', preventDefault() {}});
    assert.equal(changed, undefined); assert.equal(wheel.props.tabIndex, -1);
  } finally { globalThis.window = previousWindow; }
});

test('Schedules monthly preview timer is bounded and empty custom days never call the bridge', () => {
  const previousWindow = globalThis.window;
  const delays = [], calls = [];
  globalThis.window = {setTimeout(_fn, delay) { delays.push(delay); return 1; }, clearTimeout() {}};
  const preview = {nextRunAt: Date.now() + 35 * 86400000, timeZone: 'UTC'};
  function run(rule, value) {
    const values = [value, '', 0];
    const {useNextRun} = load({
      useState() { return [values.shift(), () => {}]; },
      useEffect(effect) { effect(); },
    }, {preview(rule) { calls.push(rule); return Promise.resolve(preview); }});
    useNextRun(rule);
  }
  try {
    run({repeat: 'monthly', time: '08:00', monthDay: 31}, preview);
    assert.equal(delays[0], 2147483647);
    const count = calls.length;
    run({repeat: 'weekly', time: '08:00', weekdays: [], weekday: 1}, undefined);
    assert.equal(calls.length, count);
  } finally { globalThis.window = previousWindow; }
});
