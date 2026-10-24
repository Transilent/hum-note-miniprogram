const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const IDEAS_KEY = 'humnote.ideas.v1';
const DRAFTS_KEY = 'humnote.drafts.v1';
const SUMMARY_KEY = 'humnote.idea-summaries.v1';
const DIRTY_KEY = 'humnote.idea-summaries.v1.dirty';
const BASE_TIME = 1700000000000;
// Measured before this change with 100 ideas x 500 notes: refresh sent 50,000
// note objects / 5,002,881 bytes and eagerly loaded audio, pitch,
// pitch-segmentation and pitch-config. record-permission also added about 14 KB;
// this test recreates the old payload and verifies all four stay lazy.
const LEGACY_BYTES = 5002881;
const music = require('../miniprogram/utils/music');
const clone = value => JSON.parse(JSON.stringify(value));
let passed = 0;
let pageDefinition;

function test(label, fn) {
  fn();
  passed++;
  console.log('PASS  ' + label);
}
async function asyncTest(label, fn) {
  await fn();
  passed++;
  console.log('PASS  ' + label);
}

class MemoryWx {
  constructor(values) {
    this.values = new Map(Object.keys(values || {}).map(key => [key, clone(values[key])]));
    this.reads = [];
    this.writes = [];
    this.failWrites = {};
    this.failReads = {};
    this.unlinked = [];
    this.env = { USER_DATA_PATH: '/mock-only' };
  }
  getStorageSync(key) {
    this.reads.push(key);
    if (this.failReads[key]) { this.failReads[key]--; throw new Error('mock read failed: ' + key); }
    return this.values.has(key) ? clone(this.values.get(key)) : '';
  }
  setStorageSync(key, value) {
    this.writes.push(key);
    if (this.failWrites[key]) {
      this.failWrites[key]--;
      throw new Error('mock write failed: ' + key);
    }
    this.values.set(key, clone(value));
  }
  removeStorageSync(key) {
    this.values.delete(key);
  }
  getFileSystemManager() {
    return {
      mkdirSync() {},
      unlinkSync(filePath) { mockWx.unlinked.push(filePath); }
    };
  }
  getRecorderManager() {
    return { onStart() {}, onStop() {}, onError() {}, onInterruptionBegin() {}, stop() {} };
  }
  showModal() {}
}

let mockWx;
function setMock(values) {
  mockWx = new MemoryWx(values);
  global.wx = mockWx;
  return mockWx;
}
function makeIdea(index, noteCount) {
  const count = noteCount == null ? 500 : noteCount;
  const at = BASE_TIME - index * 1000;
  return {
    id: 'idea-' + index,
    title: '灵感 ' + index,
    bpm: 100,
    createdAt: at,
    updatedAt: at,
    notes: Array.from({ length: count }, (_, note) => ({
      id: 'n' + index + '-' + note,
      midi: 48 + note % 24,
      start: note * 0.03125,
      duration: 0.025,
      velocity: 85,
      confidence: 0.987654321
    })),
    source: 'wxfile://usr/humnote/recording-' + index + '.wav',
    confidence: 0.87654321,
    recordingDuration: 15.6,
    isDemo: false
  };
}
function legacyPayload(ideas) {
  const drafts = [];
  const views = ideas.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(idea => {
    const date = new Date(idea.updatedAt);
    const pitches = idea.notes.map(note => note.midi);
    const min = Math.min(...pitches), max = Math.max(...pitches);
    return Object.assign({}, idea, {
      dateLabel: (date.getMonth() + 1) + '月' + date.getDate() + '日',
      hasDraft: drafts.some(draft => draft.id === idea.id && draft.draftUpdatedAt >= idea.updatedAt),
      secondsLabel: music.seconds(idea.notes, idea.bpm).toFixed(1),
      noteCount: idea.notes.length,
      preview: idea.notes.slice(0, 18).map(note => ({
        height: 18 + (note.midi - min) / Math.max(1, max - min) * 39,
        width: music.clamp(note.duration * 12, 7, 22)
      }))
    });
  });
  return JSON.stringify({ ideas: views });
}
function callPage(definition) {
  const calls = [];
  const page = Object.assign({}, definition, {
    data: clone(definition.data),
    setData(patch) { calls.push(clone(patch)); Object.assign(this.data, clone(patch)); }
  });
  return { page, calls };
}
function ensureNoFullResolution(dependencies) {
  const bad = dependencies.filter(file => /(^|[\\/])(audio|pitch|pitch-segmentation|pitch-config)\.js$/.test(file));
  assert.deepEqual(bad, [], 'recognition modules must stay out of startup dependencies');
}

(async () => {
  setMock({});
  const storage = require('../miniprogram/utils/storage');

  test('旧格式无摘要索引可读取，损坏索引会从原始记录重建', () => {
    const ideas = [makeIdea(0, 500), makeIdea(1, 4)];
    setMock({ [IDEAS_KEY]: ideas });
    let page = storage.summaryPage(0, 20);
    assert.equal(page.total, 2);
    assert.equal(page.items[0].preview.length, 18);
    assert.equal(page.items[0].noteCount, 500);
    assert.ok(!('notes' in page.items[0]) && !('source' in page.items[0]));
    assert.equal(storage.list()[0].notes.length, 500);
    assert.ok(mockWx.values.has(SUMMARY_KEY));

    mockWx.values.set(SUMMARY_KEY, 'corrupt-index');
    page = storage.summaryPage(0, 20);
    assert.equal(page.total, 2);
    assert.equal(page.items[1].id, 'idea-1');
    assert.equal(storage.get('idea-0').notes.length, 500);
  });

  test('saveDraft/clearDraft/save/remove 同步摘要且保留完整记录与录音字段', () => {
    const ideas = [makeIdea(0, 4), makeIdea(1, 3)];
    ideas[0].source = '/mock-only/humnote/recording-idea-0.wav';
    setMock({ [IDEAS_KEY]: ideas });
    storage.summaryPage(0, 20);
    const draft = clone(ideas[0]);
    draft.notes[1].start = 0;
    storage.saveDraft(draft);
    let item = storage.summaryPage(0, 20).items.find(entry => entry.id === draft.id);
    assert.equal(item.hasDraft, true);

    storage.clearDraft(draft.id);
    item = storage.summaryPage(0, 20).items.find(entry => entry.id === draft.id);
    assert.equal(item.hasDraft, false);

    storage.saveDraft(draft);
    const saved = storage.save(Object.assign({}, draft, { notes: [draft.notes[0]], title: '已保存' }));
    item = storage.summaryPage(0, 20).items.find(entry => entry.id === saved.id);
    assert.equal(item.hasDraft, false);
    assert.equal(storage.getDraft(saved.id), undefined);
    assert.equal(storage.get(saved.id).source, draft.source);
    assert.equal(storage.get(saved.id).notes.length, 1);

    storage.remove(saved.id);
    assert.equal(storage.get(saved.id), undefined);
    assert.ok(!storage.summaryPage(0, 20).items.some(entry => entry.id === saved.id));
    assert.ok(mockWx.unlinked.some(file => file.endsWith('recording-idea-0.wav')));
  });

  test('摘要索引写失败保留 dirty sentinel，下一次读取集合并重建', () => {
    const ideas = [makeIdea(0, 5), makeIdea(1, 5)];
    setMock({ [IDEAS_KEY]: ideas });
    storage.summaryPage(0, 20);
    mockWx.failWrites[SUMMARY_KEY] = 1;
    const added = storage.save(Object.assign(makeIdea(2, 1), { updatedAt: Date.now() }));
    assert.equal(storage.list().length, 3);
    assert.equal(mockWx.getStorageSync(DIRTY_KEY), 1);
    assert.equal(storage.summaryPage(0, 20).items[0].id, added.id);
    assert.ok(mockWx.reads.includes(IDEAS_KEY));
    assert.ok(!mockWx.getStorageSync(DIRTY_KEY));

    // Simulate a crash after the canonical write but before the index write.
    const crashIdea = Object.assign(makeIdea(3, 1), { updatedAt: Date.now() + 1 });
    mockWx.values.set(IDEAS_KEY, storage.list().concat([crashIdea]));
    mockWx.values.set(DIRTY_KEY, 1);
    assert.ok(storage.summaryPage(0, 20).items.some(entry => entry.id === crashIdea.id));
    assert.ok(!mockWx.getStorageSync(DIRTY_KEY));

    // A failed retry must preserve an older dirty marker so the crashed write
    // still forces a rebuild rather than trusting the stale summary cache.
    const hiddenIdea = Object.assign(makeIdea(4, 1), { updatedAt: Date.now() + 2 });
    mockWx.values.set(IDEAS_KEY, storage.list().concat([hiddenIdea]));
    mockWx.values.set(DIRTY_KEY, 1);
    mockWx.failWrites[IDEAS_KEY] = 1;
    assert.throws(() => storage.save(makeIdea(5, 1)));
    assert.equal(mockWx.getStorageSync(DIRTY_KEY), 1);
    assert.ok(storage.summaryPage(0, 20).items.some(entry => entry.id === hiddenIdea.id));
  });

  test('save 的草稿读取失败保留 dirty 和摘要记录可见性', () => {
    const idea = makeIdea(0, 2);
    setMock({ [IDEAS_KEY]: [idea] });
    storage.summaryPage(0, 20);
    const staleIndex = clone(mockWx.getStorageSync(SUMMARY_KEY));
    mockWx.failReads[DRAFTS_KEY] = 1;
    const saved = storage.save(Object.assign({}, idea, { title: '已更新', notes: [idea.notes[0]] }));
    assert.equal(saved.title, '已更新');
    assert.equal(mockWx.getStorageSync(DIRTY_KEY), 1);
    assert.deepEqual(mockWx.getStorageSync(SUMMARY_KEY), staleIndex);
    assert.equal(storage.summaryPage(0, 20).items[0].title, '已更新');
    assert.ok(!mockWx.getStorageSync(DIRTY_KEY));
  });

  test('save 的草稿清理写失败保留 dirty，旧摘要不会假装已清草稿', () => {
    const idea = makeIdea(0, 2);
    setMock({ [IDEAS_KEY]: [idea], [DRAFTS_KEY]: [Object.assign(clone(idea), { draftUpdatedAt: idea.updatedAt + 1 })] });
    storage.summaryPage(0, 20);
    assert.equal(storage.summaryPage(0, 20).items[0].hasDraft, true);
    const staleIndex = clone(mockWx.getStorageSync(SUMMARY_KEY));
    mockWx.failWrites[DRAFTS_KEY] = 1;
    const saved = storage.save(Object.assign({}, idea, { title: '脏写测试', notes: [idea.notes[0]] }));
    assert.equal(saved.title, '脏写测试');
    assert.equal(mockWx.getStorageSync(DIRTY_KEY), 1);
    assert.deepEqual(mockWx.getStorageSync(SUMMARY_KEY), staleIndex);
    const rebuilt = storage.summaryPage(0, 20).items[0];
    assert.equal(rebuilt.title, '脏写测试');
    assert.equal(rebuilt.hasDraft, false);
    assert.equal(storage.getDraft(idea.id).id, idea.id);
    assert.ok(!mockWx.getStorageSync(DIRTY_KEY));
  });

  test('相同 updatedAt 下 preview 高度或宽度变化会更新 revision', () => {
    const idea = makeIdea(0, 1);
    setMock({ [IDEAS_KEY]: [idea] });
    const before = storage.summaryPage(0, 1);
    const originalNow = Date.now;
    Date.now = () => idea.updatedAt;
    try {
      const changed = clone(idea);
      changed.notes[0].midi += 1;
      changed.notes[0].duration = 1;
      storage.save(changed);
    } finally { Date.now = originalNow; }
    const after = storage.summaryPage(0, 1);
    assert.equal(after.items[0].updatedAt, before.items[0].updatedAt);
    assert.notDeepEqual(after.items[0].preview, before.items[0].preview);
    assert.notEqual(after.revision, before.revision);
  });

  test('首页 refresh 仅发送摘要，100×500 音符 payload 显著缩小', () => {
    const ideas = Array.from({ length: 100 }, (_, index) => makeIdea(index, 500));
    const baseline = Buffer.byteLength(legacyPayload(ideas));
    assert.equal(baseline, LEGACY_BYTES, 'pre-change payload baseline changed');
    setMock({ [IDEAS_KEY]: ideas });
    global.Page = value => { pageDefinition = value; };
    for (const file of [path.join(APP, 'miniprogram/pages/index/index.js'), path.join(APP, 'miniprogram/utils/audio.js'),
      path.join(APP, 'miniprogram/utils/pitch.js'), path.join(APP, 'miniprogram/utils/pitch-segmentation.js'),
      path.join(APP, 'miniprogram/utils/pitch-config.js')]) {
      delete require.cache[file];
    }
    require('../miniprogram/pages/index/index');
    ensureNoFullResolution(Object.keys(require.cache).filter(file => file.startsWith(APP)));
    const { page, calls } = callPage(pageDefinition);
    page.alive = true;
    assert.ok(!require.cache[require.resolve(path.join(APP, 'miniprogram/utils/record-permission.js'))],
      'permission must stay lazy after page load');
    page.onShow();
    assert.equal(calls.length, 1);
    const patch = calls[0];
    assert.equal(patch.ideas.length, 20);
    assert.equal(patch.ideaTotal, 100);
    assert.equal(patch.hasMore, true);
    assert.equal(patch.ideas.reduce((sum, item) => sum + item.preview.length, 0), 360);
    for (const item of patch.ideas) {
      assert.ok(!('notes' in item) && !('source' in item) && !('confidence' in item));
      assert.equal(item.preview.every(bar => Number.isFinite(bar.height) && Number.isFinite(bar.width)), true);
    }
    const optimized = Buffer.byteLength(JSON.stringify(patch));
    assert.ok(optimized < baseline / 50, optimized + ' is not at least 50x smaller than ' + baseline);
    console.log('PAYLOAD  ' + baseline + ' bytes -> ' + optimized + ' bytes (' +
      (baseline / optimized).toFixed(1) + 'x smaller)');

    const callCount = calls.length;
    mockWx.reads = [];
    page.onShow();
    assert.equal(calls.length, callCount, 'unchanged onShow must not repeat setData');
    assert.ok(!mockWx.reads.includes(IDEAS_KEY), 'clean summary reads must not load full notes');

    page.onReachBottom();
    assert.equal(page.data.ideas.length, 40);
    assert.ok(!('notes' in calls.at(-1).ideas[0]));
    page.onReachBottom();
    page.onReachBottom();
    page.onReachBottom();
    assert.equal(page.data.ideas.length, 100);
    assert.equal(page.data.hasMore, false);
  });

  test('handleStart 每 150ms 更新 recordSeconds，elapsed 仅在跨秒时写入', () => {
    const { page, calls } = callPage(pageDefinition);
    const realNow = Date.now, realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
    let now = BASE_TIME, tick;
    Date.now = () => now;
    global.setInterval = fn => { tick = fn; return 1; };
    global.clearInterval = () => {};
    try {
      page.visible = true;
      page.onLoad();
      assert.ok(!require.cache[require.resolve(path.join(APP, 'miniprogram/utils/record-permission.js'))],
        'onLoad may register callbacks without loading permission');
      page.handleStart();
      calls.length = 0;
      now = BASE_TIME + 100;
      tick();
      now = BASE_TIME + 900;
      tick();
      now = BASE_TIME + 1100;
      tick();
      assert.equal(calls.length, 3);
      assert.ok(calls[0].recordSeconds > 0 && calls[1].recordSeconds > calls[0].recordSeconds);
      assert.ok(!('elapsed' in calls[0]) && !('elapsed' in calls[1]));
      assert.equal(calls[2].elapsed, '00:01');
      const wxml = fs.readFileSync(path.join(APP, 'miniprogram/pages/index/index.wxml'), 'utf8');
      assert.ok(wxml.includes('recordSeconds / 30 * 100'), 'record progress still consumes recordSeconds');
    } finally {
      Date.now = realNow;
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    }
  });

  await asyncTest('permission 首次使用时加载，并复用可 mock 的同一 CJS 实例', async () => {
    const permissionPath = require.resolve(path.join(APP, 'miniprogram/utils/record-permission.js'));
    assert.ok(!require.cache[permissionPath]);
    const permission = require(permissionPath);
    const original = permission.prepareRecording;
    let calls = 0;
    permission.prepareRecording = async () => { calls++; return { cancelled: true }; };
    const { page } = callPage(pageDefinition);
    page.alive = true;
    page.visible = true;
    page.recordAttempt = 0;
    page.recorder = {};
    page.data.starting = true;
    try {
      await page.beginRecordAttempt();
      assert.equal(calls, 1);
      assert.equal(require.cache[permissionPath].exports, permission);
    } finally {
      permission.prepareRecording = original;
    }
  });

  console.log('\n' + passed + ' library performance checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});