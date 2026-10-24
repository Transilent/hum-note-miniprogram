// node tools/performance-benchmark.cjs [--root /path/to/miniprogram] [--out report.json]
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { applyPatch, clone } = require('../tests/page-mock.cjs');
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1]; };
const root = path.resolve(option('--root') || path.join(__dirname, '../miniprogram'));
const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const library = Array.from({ length: 100 }, (_, i) => ({ id: 'perf-idea-' + i, title: '性能验证旋律 ' + i, bpm: 100,
  createdAt: 1, updatedAt: 1000 + i, source: '/mock/recording-' + i + '.wav', isDemo: false,
  notes: Array.from({ length: 500 }, (_, j) => ({ id: 'perf-note-' + j, midi: 60 + j % 12,
    start: j * .125, duration: .125, velocity: 85, confidence: .9 })) }));
const values = new Map([['humnote.ideas.v1', library]]);
const reads = [], recorder = {};
for (const e of ['Start', 'Stop', 'Error', 'InterruptionBegin']) recorder['on' + e] = recorder['off' + e] = () => {};
global.wx = { env: { USER_DATA_PATH: '/mock' }, getStorageSync(key) { reads.push(key); return clone(values.get(key) || ''); },
  setStorageSync(key, value) { values.set(key, clone(value)); }, removeStorageSync(key) { values.delete(key); },
  getRecorderManager: () => recorder, getWindowInfo: () => ({ windowWidth: 375, windowHeight: 700 }),
  getDeviceInfo: () => ({ platform: 'devtools' }), getFileSystemManager: () => ({ mkdirSync() {} }),
  createInnerAudioContext: () => Object.fromEntries(['onPlay', 'onPause', 'onWaiting', 'onSeeking', 'onSeeked', 'onEnded', 'onError', 'onTimeUpdate', 'stop', 'destroy'].map(k => [k, () => {}])),
  showToast() {}, pageScrollTo() {} };
let definition;
global.Page = value => { definition = value; };
function loadPage(name) {
  const before = new Set(Object.keys(require.cache));
  const started = performance.now(); require(path.join(root, 'pages', name, name + '.js'));
  const files = Object.keys(require.cache).filter(f => f.startsWith(root + path.sep) && !before.has(f));
  const loading = { ms: performance.now() - started, files: files.map(f => path.relative(root, f).replace(/\\/g, '/')),
    sourceBytes: files.reduce((sum, f) => sum + fs.statSync(f).size, 0) };
  const pageDefinition = definition;
  const create = () => {
    const updates = [];
    const page = Object.assign({}, pageDefinition, { data: clone(pageDefinition.data), setData(patch) {
      updates.push({ bytes: Buffer.byteLength(JSON.stringify(patch)), keys: Object.keys(patch) }); applyPatch(this.data, patch);
    } });
    page.updates = updates; return page;
  };
  return { page: create(), loading, create };
}
function summarize(updates) { return { calls: updates.length, bytes: updates.reduce((n, u) => n + u.bytes, 0), largest: Math.max(0, ...updates.map(u => u.bytes)) }; }
const home = loadPage('index');
const first = performance.now(); home.page.onLoad(); home.page.onShow();
const homepage = { firstModelMs: performance.now() - first, firstTransfer: summarize(home.page.updates), shown: home.page.data.ideas.length };
home.page.updates.length = 0; reads.length = 0;
const tHome = performance.now(); home.page.onShow();
homepage.unchangedReturn = { ms: performance.now() - tHome, ...summarize(home.page.updates), storageKeys: reads.slice() };
home.page.onUnload();
const warm = home.create(), warmStart = performance.now(); warm.onLoad(); warm.onShow();
homepage.cachedStart = { ms: performance.now() - warmStart, ...summarize(warm.updates), shown: warm.data.ideas.length }; warm.onUnload();
const editor = loadPage('editor'); const tEditor = performance.now(); editor.page.onLoad({ id: library[0].id });
const editing = { firstModelMs: performance.now() - tEditor, firstTransfer: summarize(editor.page.updates) };
editor.page.updates.length = 0;
editor.page.onNoteTouchStart({ currentTarget: { dataset: { id: 'perf-note-250' } }, touches: [{ clientX: 100, clientY: 100 }] });
editor.page.updates.length = 0; const times = [];
for (let i = 1; i <= 40; i++) {
  const start = performance.now(); editor.page.applyGesture({ clientX: 100, clientY: 100 - (i % 2 ? 22 : 44) }, true); times.push(performance.now() - start);
}
editing.drag40 = { medianLogicMs: med(times), p95LogicMs: times.slice().sort((a,b) => a-b)[Math.floor(times.length * .95)], ...summarize(editor.page.updates) };
editor.page.onNoteTouchEnd(); editor.page.onUnload();
const report = { runtime: process.version, platform: process.platform + '/' + process.arch, fixture: { ideas: 100, notesPerIdea: 500, moves: 40 },
  caveat: 'Node mocks measure model work and exact bridge payload, not phone cold launch or frame rate.',
  homeModules: home.loading, editorAdditionalModules: editor.loading, homepage, editing };
if (option('--out')) fs.writeFileSync(path.resolve(option('--out')), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
