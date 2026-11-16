// Open an icon preview in `npm run dev -- --automation`, then run this file.
// The agent API has no pinch input; CDP drives that existing app's image view.
// No provider calls, editor changes, or History writes are made.
import assert from 'node:assert/strict';

const targets = await (await fetch(`${process.env.MOICONS_CDP_URL || 'http://127.0.0.1:9222'}/json/list`)).json();
const target = targets.find(item => item.url.startsWith('moicons-preview:'));
assert.ok(target, 'Open an icon preview before running this test.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = event => {
  const response = JSON.parse(event.data);
  if (!pending.has(response.id)) return;
  const { resolve, reject, timer } = pending.get(response.id);
  pending.delete(response.id); clearTimeout(timer);
  response.error ? reject(new Error(response.error.message)) : resolve(response.result);
};
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(fn, ...args) {
  const result = await send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`,
    awaitPromise: true, returnByValue: true,
  });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
  return result.result.value;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(action, factor = 1) {
  await evaluate((action, factor) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'command?' + new URLSearchParams({ action, factor, t: Date.now() }));
    xhr.onload = () => xhr.status === 200 ? resolve(true) : reject(new Error(xhr.responseText));
    xhr.onerror = reject; xhr.send();
  }), action, factor);
  await pause(180); // Includes the viewer's state poll and native layout.
}
async function pointerAt(x, y) {
  return evaluate((x, y) => {
    const image = document.querySelector('#icon').getBoundingClientRect();
    const screen = { x: innerWidth * devicePixelRatio * x, y: innerHeight * devicePixelRatio * y };
    return { screen, image: { x: (screen.x / devicePixelRatio - image.left) / image.width, y: (screen.y / devicePixelRatio - image.top) / image.height } };
  }, x, y);
}
async function pinch(screen, deltaY) {
  // CDP coordinates are CSS pixels. A physical pointer stays in the same place
  // while native browser zoom changes CSS pixels and devicePixelRatio.
  const point = await evaluate(screen => ({ x: screen.x / devicePixelRatio, y: screen.y / devicePixelRatio }), screen);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY, modifiers: 2 });
}
async function drift(point, displayDpr) {
  return evaluate((point, displayDpr) => {
    const image = document.querySelector('#icon').getBoundingClientRect();
    return Math.hypot(
      (image.left + point.image.x * image.width) * devicePixelRatio - point.screen.x,
      (image.top + point.image.y * image.height) * devicePixelRatio - point.screen.y,
    ) / displayDpr;
  }, point, displayDpr);
}

try {
  await command('actual');
  const displayDpr = await evaluate(() => devicePixelRatio);
  for (const scenario of [
    { name: 'zoom in from Fit, off center', mode: 'fit', x: .65, y: .45, delta: -8, count: 12 },
    { name: 'zoom out below Fit', mode: 'fit', x: .4, y: .65, delta: 8, count: 6 },
    { name: 'rapid pinch after panning', mode: 'actual', x: .7, y: .3, delta: -6, count: 16, pan: true },
    { name: 'zoom out after panning', mode: 'actual', x: .3, y: .7, delta: 6, count: 10, pan: true },
  ]) {
    await command(scenario.mode);
    if (scenario.pan) {
      await evaluate(() => { const view = document.querySelector('#viewport'); view.scrollBy(90, -60); });
      await pause(30);
    }
    const point = await pointerAt(scenario.x, scenario.y);
    for (let i = 0; i < scenario.count; i++) {
      await pinch(point.screen, scenario.delta);
      await pause(8);
    }
    await pause(180);
    const movement = await drift(point, displayDpr);
    assert.ok(movement < 3, `${scenario.name}: image point moved ${movement.toFixed(2)} screen pixels`);
    assert.equal(await evaluate(() => visualViewport.scale), 1, 'no second visual-viewport zoom');
    console.log(`PASS: ${scenario.name} (${movement.toFixed(2)} px drift)`);
    const center = await pointerAt(.5, .5);
    await command('in');
    assert.ok(await drift(center, displayDpr) < 3, 'toolbar zoom retains the viewport center after a pinch');
  }
  await command('fit');
} finally {
  socket.close();
}
