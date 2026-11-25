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
    this.navigateCalls = [];
    this.toasts = [];
    this.failNavigations = 0;
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
      copyFile({ success }) { success(); },
      unlinkSync(filePath) { mockWx.unlinked.push(filePath); }
    };
  }
  getRecorderManager() {
    return { onStart() {}, onStop() {}, onError() {}, onInterruptionBegin() {}, stop() {} };
  }
  navigateTo(options) {
    this.navigateCalls.push(options.url);
    if (this.failNavigations) {
      this.failNavigations--;
      if (options.fail) options.fail({ errMsg: 'mock navigateTo failure' });
    }
  }
  showToast(options) { this.toasts.push(options.title); }
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
    assert.equal(page.items[0].preview.length, 8);
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

  test('同一毫秒重存时，清理失败的旧草稿不会覆盖已保存的版本', () => {
    setMock({});
    const now = Date.now;
    Date.now = () => BASE_TIME;
    try {
      const first = storage.save(makeIdea(0, 1));
      const draft = storage.saveDraft(Object.assign({}, first, { title: '旧草稿' }));
      assert.equal(storage.canRestoreDraft(first, draft), true);
      mockWx.failWrites[DRAFTS_KEY] = 1;
      const second = storage.save(Object.assign({}, first, { title: '已修正' }));
      assert.equal(second.updatedAt, draft.draftUpdatedAt);
      assert.equal(storage.getDraft(second.id).title, draft.title);
      assert.equal(storage.canRestoreDraft(second, draft), false);
      assert.equal(storage.summaryPage(0, 20).items[0].hasDraft, false);
      assert.equal(storage.canRestoreDraft(null, draft), false);
    } finally { Date.now = now; }
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
    assert.equal(patch.ideas.reduce((sum, item) => sum + item.preview.length, 0), 160);
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

    const loadedCalls = calls.length;
    page.onShow();
    assert.equal(calls.length, loadedCalls, 'returning with loaded pages and no data change must not setData');
    const changed = clone(ideas[80]);
    changed.title = '远离首屏的更新';
    changed.notes = [changed.notes[0]];
    storage.save(changed);
    page.onShow();
    assert.equal(page.data.ideas.length, 40, 'returning from an old idea must preserve loaded pagination depth');
    assert.equal(page.data.ideas[0].title, changed.title);
    assert.ok(!('notes' in calls.at(-1).ideas[0]));

    page.onReachBottom();
    page.onReachBottom();
    page.onReachBottom();
    assert.equal(page.data.ideas.length, 100);
    assert.equal(page.data.hasMore, false);
  });

  test('空记录本只发送一次空态，离页返回不变时不重复渲染', () => {
    setMock({});
    const { page, calls } = callPage(pageDefinition);
    page.alive = true;
    page.onShow();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].ideas, []);
    assert.equal(calls[0].ideaTotal, 0);
    assert.equal(calls[0].hasMore, false);
    const emptyCalls = calls.length;
    page.onShow();
    assert.equal(calls.length, emptyCalls);
    const wxml = fs.readFileSync(path.join(APP, 'miniprogram/pages/index/index.wxml'), 'utf8');
    assert.match(wxml, /wx:if="{{!ideaTotal}}" class="empty"/);
  });

  test('首页示例与创作入口快速连点只导航一次，失败后可重试', () => {
    setMock({});
    let built = callPage(pageDefinition).page;
    built.alive = true;
    built.onShow();
    assert.equal(built.openCreation(), true);
    assert.equal(built.openCreation(), false);
    assert.equal(mockWx.navigateCalls.length, 1);
    built.onShow();
    assert.equal(built.openCreation(), true);
    assert.equal(mockWx.navigateCalls.length, 2);

    setMock({});
    built = callPage(pageDefinition).page;
    built.alive = true;
    built.onShow();
    assert.equal(built.openDemo(), true);
    assert.equal(built.openDemo(), false);
    assert.equal(mockWx.navigateCalls.length, 1);
    assert.equal(storage.list().length, 1, 'double tap must create only one example');

    setMock({});
    mockWx.failNavigations = 1;
    built = callPage(pageDefinition).page;
    built.alive = true;
    built.onShow();
    const warn = console.warn;
    console.warn = () => {};
    try {
      built.openCreation();
      built.openCreation();
    } finally { console.warn = warn; }
    assert.equal(mockWx.navigateCalls.length, 2, 'failed navigation must release the guard');
    assert.ok(mockWx.toasts.some(title => /无法打开创作页/.test(title)));
  });

  test('长标题使用可收缩容器与省略号，窄屏不挤压旋律缩略图', () => {
    const wxml = fs.readFileSync(path.join(APP, 'miniprogram/pages/index/index.wxml'), 'utf8');
    const wxss = fs.readFileSync(path.join(APP, 'miniprogram/pages/index/index.wxss'), 'utf8');
    assert.match(wxml, /class="idea-main"/);
    assert.ok(wxss.includes('.idea-main { flex: 1; min-width: 0;'));
    assert.ok(wxss.includes('.idea-title { width: 100%;') && wxss.includes('overflow: hidden; text-overflow: ellipsis;'));
    assert.match(wxss, /\.mini-melody\s*\{[^}]*flex: 0 0 76rpx/);
  });

  test('录音时钟与状态只在跨秒时更新，减少视图通信', () => {
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
      page.data.starting = true;
      page.handleStart();
      calls.length = 0;
      now = BASE_TIME + 100;
      tick();
      now = BASE_TIME + 900;
      tick();
      now = BASE_TIME + 1100;
      tick();
      assert.deepEqual(calls, [{ recordSeconds: 1, elapsed: '00:01' }]);
      const wxml = fs.readFileSync(path.join(APP, 'miniprogram/pages/index/index.wxml'), 'utf8');
      assert.ok(wxml.includes('recordSeconds / 30 * 100'), 'record progress still consumes recordSeconds');
    } finally {
      Date.now = realNow;
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    }
  });

  test('权限等待中离页时，晚到的录音 onStart 会停止录音器', () => {
    const { page, calls } = callPage(pageDefinition);
    let stops = 0;
    page.onLoad();
    page.recorder = { stop() { stops++; } };
    page.visible = false;
    page.data.starting = true;
    page.handleStart();
    assert.equal(stops, 1);
    assert.equal(page.cancelled, true);
    assert.equal(page.data.starting, false);
    assert.equal(page.data.recording, false);
    assert.ok(calls.length >= 1);
  });

  test('一次录音只请求一次停止，重复 onStop 不会重复进入识别', () => {
    const { page } = callPage(pageDefinition);
    page.onLoad();
    page.visible = true;
    page.data.starting = true;
    let stopCalls = 0, finished = 0;
    page.recorder = { stop() { stopCalls++; } };
    page.finishRecording = () => {
      finished++;
      page.setData({ recording: false, stopping: false, processing: true });
    };
    try {
      page.handleStart();
      assert.equal(page.recordTap(), true);
      assert.equal(page.recordTap(), false);
      assert.equal(stopCalls, 1);
      page.handleStop({ tempFilePath: '/test.wav' });
      page.handleStop({ tempFilePath: '/test.wav' });
      assert.equal(finished, 1);
      assert.equal(page.data.processing, true);
      assert.equal(page.data.stopping, false);
    } finally { page.onUnload(); }
  });

  test('摘要暂时读取失败时，已提交的灵感仍正常打开', () => {
    setMock({ [IDEAS_KEY]: [makeIdea(0, 3)] });
    mockWx.failReads[IDEAS_KEY] = 1;
    const { page } = callPage(pageDefinition);
    page.onLoad();
    page.visible = true;
    assert.equal(page.openRecognized('idea-0'), true);
    assert.deepEqual(mockWx.navigateCalls, ['/pages/editor/editor?id=idea-0']);
    assert.equal(page.refresh(), true);
    assert.equal(page.data.ideaTotal, 1);
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

  await asyncTest('原音写入 await 返回前离页时，删除本次文件且不保存或导航', async () => {
    setMock({});
    const audio = require('../miniprogram/utils/audio');
    const pitch = require('../miniprogram/utils/pitch');
    const originalDecode = audio.decodeFile, originalTranscribe = pitch.transcribe;
    const originalSaveRecording = storage.saveRecording, originalSave = storage.save;
    let resolveCopy, sourcePath = '/mock-only/humnote/recording-cancelled.wav', saveCalls = 0, copyCalls = 0;
    audio.decodeFile = async () => ({ samples: new Float32Array(16000), sampleRate: 16000 });
    pitch.transcribe = async () => ({ notes: [{ id: 'cancelled-note', midi: 60, start: 0, duration: 1 }], confidence: 0.9, duration: 1 });
    storage.saveRecording = () => {
      copyCalls++;
      return new Promise(resolve => { resolveCopy = () => resolve(sourcePath); });
    };
    storage.save = () => { saveCalls++; throw new Error('must not save after leave'); };
    try {
      const { page } = callPage(pageDefinition);
      page.alive = true;
      page.cancelled = false;
      const pending = page.finishRecording({ duration: 1000, tempFilePath: '/tmp/cancelled.wav' });
      for (let i = 0; i < 40 && !resolveCopy; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(copyCalls, 1);
      assert.ok(resolveCopy, 'saveRecording should be pending');
      page.alive = false;
      page.cancelled = true;
      resolveCopy();
      await pending;
      assert.equal(saveCalls, 0);
      assert.equal(mockWx.navigateCalls.length, 0);
      assert.ok(mockWx.unlinked.includes(sourcePath));
      const pendingRecordings = storage.pendingRecordings();
      assert.equal(pendingRecordings.length, 1);
      assert.ok(!mockWx.unlinked.includes(pendingRecordings[0].path));
    } finally {
      audio.decodeFile = originalDecode;
      pitch.transcribe = originalTranscribe;
      storage.saveRecording = originalSaveRecording;
      storage.save = originalSave;
    }
  });

  console.log('\n' + passed + ' library performance checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
