// Open Chat's thinking panel with the IME visible, then forward its WebView CDP port:
// adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
// node scripts/check-thinking-slider.mjs [http://localhost:9223]
// Exercises the real mounted control, saves twice (restoring the original level), then dismisses.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const pages = await (await fetch(`${process.argv[2] ?? 'http://localhost:9223'}/json`)).json();
const page = pages.find(page => page.url.includes('/chat'));
assert.ok(page, 'Open Chat in the debug WebView first');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = ({data}) => {
  const message = JSON.parse(data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
};
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const touch = (type, x, y) => call('Input.dispatchTouchEvent', {
  type, touchPoints: ['touchCancel', 'touchEnd'].includes(type) ? [] : [{x, y, id: 1}],
});
async function waitForSaved() {
  await evaluate(`new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(new Error('Saving did not finish')), 10000);
    function finish(error) { clearTimeout(timer); observer.disconnect(); error ? reject(error) : resolve(true); }
    function check() {
      const picker = document.querySelector('.reasoning-picker');
      if (!picker) return finish(new Error('Panel closed after saving'));
      const error = picker.querySelector('.inline-error');
      if (error) return finish(new Error(error.textContent));
      const label = picker.querySelector('[role="slider"]').getAttribute('aria-valuetext');
      if (picker.getAttribute('aria-busy') === 'false' && document.querySelector('.reasoning-button').getAttribute('aria-label').endsWith(label)) finish();
    }
    observer.observe(document.body, {subtree:true, childList:true, attributes:true});
    check();
  })`);
}
let touching = false;
try {
  const initial = await evaluate(`(() => {
    const slider = document.querySelector('.reasoning-slider');
    const rail = slider.querySelector('.reasoning-rail').getBoundingClientRect();
    return {touchAction: getComputedStyle(slider).touchAction,
      value: Number(slider.getAttribute('aria-valuenow')),
      max: Number(slider.getAttribute('aria-valuemax')),
      x: rail.left, width: rail.width, y: rail.top + rail.height / 2,
      focused: document.activeElement?.tagName};
  })()`);
  assert.equal(initial.touchAction, 'none', 'Browser scrolling must not cancel slider drags');
  assert.equal(initial.focused, 'TEXTAREA', 'Start with the composer focused and IME visible');
  const start = initial.x + initial.width * initial.value / initial.max;
  const targetValue = initial.value === initial.max ? 0 : initial.max;
  const end = initial.x + initial.width * targetValue / initial.max;
  await touch('touchStart', start, initial.y);
  touching = true;
  for (let step = 1; step <= 12; step++) {
    await touch('touchMove', start + (end - start) * step / 12, initial.y);
  }
  assert.equal(await evaluate(`Number(document.querySelector('.reasoning-slider').getAttribute('aria-valuenow'))`), targetValue, 'Dragging must reach the visible rail endpoint');
  await touch('touchCancel');
  touching = false;
  assert.equal(await evaluate(`Number(document.querySelector('.reasoning-slider').getAttribute('aria-valuenow'))`), initial.value, 'Cancellation must restore the saved level');
  assert.equal(await evaluate('document.activeElement?.tagName'), 'TEXTAREA', 'Dragging must preserve composer focus');
  for (const [from, to] of [[start, end], [end, start]]) {
    await touch('touchStart', from, initial.y);
    touching = true;
    for (let step = 1; step <= 12; step++) await touch('touchMove', from + (to - from) * step / 12, initial.y);
    await touch('touchEnd');
    touching = false;
    await waitForSaved();
  }
  assert.equal(await evaluate(`Number(document.querySelector('.reasoning-slider').getAttribute('aria-valuenow'))`), initial.value, 'Two consecutive saves must restore the original level');
  const layout = await evaluate(`(() => {
    const panel = document.querySelector('.composer-popover');
    const rect = panel.getBoundingClientRect();
    const labels = [...panel.querySelectorAll('.reasoning-labels > span')];
    const ticks = [...panel.querySelectorAll('.reasoning-ticks i')];
    return {height: rect.height, overflow: panel.scrollHeight - panel.clientHeight,
      hasHeader: !!panel.querySelector('header'), hasHint: !!panel.querySelector('.reasoning-hint'),
      alignment: labels.map((label, index) => {
        const a = label.getBoundingClientRect(), b = ticks[index].getBoundingClientRect();
        return Math.abs(a.left + a.width/2 - b.left - b.width/2);
      }),
      bottom: rect.bottom, viewport: visualViewport.height,
      pixelRatio: devicePixelRatio, outsideX: rect.left + rect.width / 2, outsideY: rect.top - 16};
  })()`);
  assert.ok(layout.height < 200, `Panel should be compact: ${layout.height}px`);
  assert.ok(layout.overflow <= 1, 'Panel content must fit without internal scrolling');
  assert.ok(layout.bottom <= layout.viewport, 'Panel must fit above the keyboard');
  assert.ok(!layout.hasHeader && !layout.hasHint, 'Redundant header and hint must be removed');
  assert.ok(layout.alignment.every(error => error < 1), 'Labels must align with rail ticks');
  // CDP touch events do not synthesize Android's tap click after preventDefault; use a device tap.
  execFileSync('adb', ['shell', 'input', 'tap',
    String(Math.round(layout.outsideX * layout.pixelRatio)),
    String(Math.round(layout.outsideY * layout.pixelRatio))]);
  await evaluate(`new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Tapping outside did not dismiss the panel')); }, 3000);
    function check() {
      if (!document.querySelector('.composer-popover')) { clearTimeout(timer); observer.disconnect(); resolve(true); }
    }
    observer.observe(document.body, {subtree:true, childList:true});
    check();
  })`);
  assert.equal(await evaluate('document.activeElement?.tagName'), 'TEXTAREA', 'Dismissal must preserve composer focus');
  console.log(`PASS: drag/cancel, two saves keep panel open, original level restored, outside tap dismisses; panel ${layout.height}px, no overflow, labels aligned`);
} finally {
  try { if (touching) await touch('touchCancel'); }
  finally { socket.close(); }
}
