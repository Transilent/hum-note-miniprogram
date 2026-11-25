'use strict';

const assert = require('node:assert/strict');
const { applyPatch, clone } = require('./page-mock.cjs');
const music = require('../miniprogram/utils/music');
const storage = require('../miniprogram/utils/storage');
const { sourceFingerprint } = require('../miniprogram/utils/creation-session');

const ROOT = '/wx-user/humnote';
const IDEAS_KEY = 'humnote.ideas.v1';
const DRAFT_KEY = 'humnote.drafts.v1';
const INDEX_KEY = 'humnote.idea-summaries.v1';
const DIRTY_KEY = 'humnote.idea-summaries.v1.dirty';

const storageMap = new Map();
const fsState = {
  files: new Map(), copies: [], pendingCopies: [], unlinks: [], writes: [], events: [], holdCopies: false
};
const ui = {
  navigateTo: [], navigateBack: 0, redirects: [], toasts: [], modals: [], loadings: 0, hides: 0,
  shares: [], shareThrows: false
};

function resetEnv() {
  storageMap.clear();
  fsState.files.clear();
  fsState.copies.length = 0;
  fsState.pendingCopies.length = 0;
  fsState.unlinks.length = 0;
  fsState.writes.length = 0;
  fsState.events.length = 0;
  fsState.holdCopies = false;
  Object.keys(ui).forEach(key => {
    if (Array.isArray(ui[key])) ui[key].length = 0;
  });
  ui.navigateBack = 0; ui.loadings = 0; ui.hides = 0; ui.shareThrows = false;
  global.wx = makeWx();
}

function putFile(filePath, size) {
  fsState.files.set(filePath, Buffer.alloc(size || 128, 7));
  return filePath;
}

function finishCopy(entry) {
  const source = fsState.files.get(entry.options.srcPath);
  if (!source) {
    entry.options.fail({ errMsg: 'copyFile:fail no such file' });
    return;
  }
  fsState.files.set(entry.options.destPath, Buffer.from(source));
  entry.options.success({});
}

function makeWx() {
  return {
    env: { USER_DATA_PATH: '/wx-user' },
    getStorageSync(key) { return storageMap.has(key) ? clone(storageMap.get(key)) : ''; },
    setStorageSync(key, value) { storageMap.set(key, clone(value)); },
    removeStorageSync(key) { storageMap.delete(key); },
    getWindowInfo() { return { windowWidth: 375, windowHeight: 760 }; },
    getDeviceInfo() { return { platform: 'iphone' }; },
    getFileSystemManager() {
      return {
        mkdirSync() {},
        copyFile(options) {
          const entry = { options, srcPath: options.srcPath, destPath: options.destPath };
          fsState.copies.push(entry);
          fsState.events.push({ kind: 'copy', path: options.destPath });
          if (fsState.holdCopies) fsState.pendingCopies.push(entry);
          else queueMicrotask(() => finishCopy(entry));
        },
        writeFile(options) {
          fsState.writes.push(options.filePath);
          fsState.events.push({ kind: 'write', path: options.filePath });
          queueMicrotask(() => {
            const bytes = Buffer.from(options.data);
            fsState.files.set(options.filePath, bytes);
            options.success({});
          });
        },
        stat(options) {
          queueMicrotask(() => {
            const bytes = fsState.files.get(options.path);
            if (!bytes) options.fail({ errMsg: 'stat:fail no such file' });
            else options.success({ stats: { size: bytes.length, isFile: () => true } });
          });
        },
        unlinkSync(filePath) {
          fsState.unlinks.push(filePath);
          fsState.events.push({ kind: 'unlink', path: filePath });
          fsState.files.delete(filePath);
        }
      };
    },
    navigateTo(options) { ui.navigateTo.push(options); },
    navigateBack() { ui.navigateBack++; },
    redirectTo(options) { ui.redirects.push(options); },
    showToast(options) { ui.toasts.push(options.title); },
    showModal(options) { ui.modals.push(options); },
    showLoading() { ui.loadings++; },
    hideLoading() { ui.hides++; },
    shareFileMessage(options) {
      if (ui.shareThrows) throw new Error('share unavailable');
      ui.shares.push(options);
    }
  };
}

function releaseCopy() {
  const entry = fsState.pendingCopies.shift();
  assert.ok(entry, 'expected a pending copyFile callback');
  finishCopy(entry);
  return entry;
}

function storageSnapshot() {
  return Array.from(storageMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => [key, clone(value)]);
}

function resetStorage(ideas) {
  storageMap.set(IDEAS_KEY, clone(ideas));
  storageMap.delete(DRAFT_KEY);
  storageMap.delete(INDEX_KEY);
  storageMap.delete(DIRTY_KEY);
}

function note(id, midi, start, duration) {
  return { id, midi, start, duration, velocity: 84, confidence: 0.93 };
}

function makeIdea(id, notes, options) {
  const opts = options || {};
  return {
    id,
    title: opts.title || ('灵感 ' + id),
    bpm: opts.bpm || 100,
    notes: clone(notes),
    source: opts.source || null,
    recordingDuration: opts.recordingDuration == null ? 2.5 : opts.recordingDuration,
    createdAt: opts.createdAt || 100,
    updatedAt: opts.updatedAt || 200,
    isDemo: false
  };
}

function capturePage(relativePath) {
  let definition;
  const previous = global.Page;
  global.Page = page => { definition = page; };
  const resolved = require.resolve('../miniprogram/' + relativePath);
  delete require.cache[resolved];
  require(resolved);
  global.Page = previous;
  assert.ok(definition && definition.data, 'Page definition missing for ' + relativePath);
  return definition;
}

function makePage(definition, overrides) {
  const page = Object.assign({}, definition, overrides || {});
  page.data = clone(definition.data);
  page.setDataCalls = [];
  page.setData = function setData(patch) {
    this.setDataCalls.push(clone(patch));
    applyPatch(this.data, patch);
  };
  return page;
}

function createEventChannel(editorEvents) {
  const handlers = new Map();
  const emissions = [];
  return {
    emissions,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
    },
    off(name, handler) {
      const set = handlers.get(name);
      if (set) set.delete(handler);
    },
    emit(name, payload) {
      emissions.push({ name, payload: clone(payload) });
      if (name === 'applyComposition' && editorEvents && editorEvents[name]) {
        return editorEvents[name](clone(payload));
      }
      const set = handlers.get(name);
      if (set) Array.from(set).forEach(handler => handler(clone(payload)));
    }
  };
}

const composeDefinition = capturePage('pages/compose/compose.js');
const editorDefinition = capturePage('pages/editor/editor.js');

function loadCompose(options, channel) {
  const page = makePage(composeDefinition);
  if (channel !== undefined) page.getOpenerEventChannel = channel ? () => channel : undefined;
  page.onLoad(Object.assign({}, options));
  return page;
}

function loadEditor(id) {
  const page = makePage(editorDefinition);
  page.onLoad({ id });
  return page;
}

function openComposer(editor) {
  let navigation;
  const original = wx.navigateTo;
  wx.navigateTo = options => {
    navigation = options;
    const channel = createEventChannel(options.events);
    if (options.success) options.success({ eventChannel: channel });
  };
  let opened;
  try { opened = editor.openComposer(); }
  finally { wx.navigateTo = original; }
  return { opened, navigation, channel: editor.compositionChannel };
}

function loadComposerForEditor(editor, channel) {
  return loadCompose({ id: editor.idea.id, returnToEditor: '1', tone: editor.data.tone }, channel);
}

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log('PASS  ' + label);
}

(async () => {
  resetEnv();

  await check('compose 控件只重建 candidate，不改 source 或 storage', () => {
    resetEnv();
    const source = makeIdea('source-controls', [
      note('a', 60, 0, 1), note('b', 64, 1.5, 0.5), note('c', 67, 3, 1)
    ]);
    resetStorage([source]);
    const page = loadCompose({ id: source.id }, null);
    assert.ok(page.candidate);
    const storedBefore = clone(storage.get(source.id));
    const mapBefore = storageSnapshot();
    const sourceBefore = clone(page.source);
    const initialNotes = clone(page.candidate.notes);

    page.choosePreset({ currentTarget: { dataset: { id: 'transpose' } } });
    assert.equal(page.data.presetId, 'transpose');
    assert.notDeepEqual(page.candidate.notes.map(item => item.midi), initialNotes.map(item => item.midi));
    assert.deepEqual(storageSnapshot(), mapBefore);
    assert.deepEqual(page.source, sourceBefore);

    page.chooseParameter({ currentTarget: { dataset: { key: 'transpose', value: 5 } } });
    assert.equal(page.data.transpose, 5);
    assert.ok(page.candidate.notes.some(item => item.midi === source.notes[0].midi + 5));
    assert.deepEqual(storageSnapshot(), mapBefore);
    assert.deepEqual(page.source, sourceBefore);

    page.chooseMode({ currentTarget: { dataset: { mode: 'replace' } } });
    assert.equal(page.data.mode, 'replace');
    assert.equal(page.candidate.mode, 'replace');
    assert.equal(page.candidate.notes.length, source.notes.length);
    assert.deepEqual(storageSnapshot(), mapBefore);
    assert.deepEqual(storage.get(source.id), storedBefore);
    page.onUnload();
  });

  await check('空库示例、100×500 摘要和长标题窄屏只发送有界页面数据', () => {
    resetEnv();
    resetStorage([]);
    const empty = loadCompose({}, null);
    assert.equal(empty.data.hasSource, false);
    assert.deepEqual(empty.data.sources, []);
    assert.equal(empty.useDemo(), true);
    assert.equal(empty.data.hasSource, true);
    assert.equal(empty.useDemo(), false, 'rapid example taps must not create another example');
    assert.equal(storage.list().length, 1);
    empty.onUnload();

    resetEnv();
    const ideas = Array.from({ length: 100 }, (_, index) => {
      const notes = Array.from({ length: 500 }, (__, noteIndex) => note('bulk-' + index + '-' + noteIndex,
        60 + noteIndex % 24, noteIndex * 0.125, 0.125));
      return makeIdea('bulk-' + index, notes, { title: index === 0
        ? '这是一段用于检查窄屏溢出与省略效果的非常非常长的灵感标题'.repeat(3)
        : '灵感 ' + index, bpm: 240, updatedAt: 1000 - index });
    });
    resetStorage(ideas);
    const started = process.hrtime.bigint();
    const page = loadCompose({ id: 'bulk-0' }, null);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(page.data.sources.length, 100);
    assert.equal(page.data.sourceCount, 500);
    assert.equal(page.data.sourceTitle.length > 40, true);
    assert.ok(page.setDataCalls.length <= 1, 'source list and selected summary should cross the bridge together');
    for (const patch of page.setDataCalls) {
      assert.equal(Object.prototype.hasOwnProperty.call(patch, 'notes'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(patch, 'source'), false);
      const nodes = patch.sources || [];
      assert.equal(nodes.every(item => !('notes' in item) && !('source' in item)), true);
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(page.setDataCalls));
    assert.ok(payloadBytes < 100000, 'compose UI payload must stay bounded: ' + payloadBytes);
    assert.ok(elapsedMs < 2500, 'desktop compose fixture unexpectedly slow: ' + elapsedMs.toFixed(1) + 'ms');
    console.log('COMPOSE ' + elapsedMs.toFixed(1) + ' ms / ' + payloadBytes + ' bytes for 100×500 notes');
    const wxml = require('node:fs').readFileSync(require('node:path').join(__dirname, '../miniprogram/pages/compose/compose.wxml'), 'utf8');
    const wxss = require('node:fs').readFileSync(require('node:path').join(__dirname, '../miniprogram/pages/compose/compose.wxss'), 'utf8');
    assert.ok(wxml.includes('class="source-title"'));
    assert.match(wxss, /\.source-title\s*\{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/);
    assert.match(wxss, /\.source-row \.caption\s*\{[^}]*flex-shrink: 0;[^}]*white-space: nowrap;/);
    page.onUnload();
  });

  await check('八预设快速切换、非法输入、500 音符与 120 秒边界保持非破坏预览', () => {
    resetEnv();
    const sourceNotes = Array.from({ length: 250 }, (_, index) => note('limit-' + index, 60 + index % 12, index * .25, .25));
    const source = makeIdea('preset-limit', sourceNotes, { bpm: 100 });
    resetStorage([source]);
    const page = loadCompose({ id: source.id }, null);
    const sourceBefore = clone(page.source);
    const storageBefore = storageSnapshot();
    assert.equal(page.data.presets.length, 8);
    assert.equal(page.candidate.notes.length, 500);
    assert.equal(page.candidate.totalNotes, 500);
    for (let pass = 0; pass < 4; pass++) {
      for (const preset of page.data.presets) page.choosePreset({ currentTarget: { dataset: { id: preset.id } } });
    }
    assert.equal(page.data.presetId, 'fragment');
    assert.equal(page.candidate.presetId, 'fragment');
    assert.ok(page.setDataCalls.every(patch => !Object.prototype.hasOwnProperty.call(patch, 'notes')));
    assert.deepEqual(page.source, sourceBefore);
    assert.deepEqual(storageSnapshot(), storageBefore);

    const stableId = page.data.presetId;
    assert.equal(page.choosePreset({ currentTarget: { dataset: { id: 'not-a-preset' } } }), false);
    assert.equal(page.chooseMode({ currentTarget: { dataset: { mode: 'overwrite' } } }), false);
    assert.equal(page.chooseParameter({ currentTarget: { dataset: { key: 'gap', value: 3 } } }), false);
    assert.equal(page.changeTone({ detail: { value: '2' } }), false);
    assert.equal(page.data.presetId, stableId);
    assert.equal(page.data.mode, 'append');
    page.onUnload();

    resetEnv();
    const tooManyNotes = Array.from({ length: 251 }, (_, index) => note('many-' + index, 60, index * .125, .125));
    const tooMany = makeIdea('too-many', tooManyNotes, { bpm: 240 });
    resetStorage([tooMany]);
    const overflow = loadCompose({ id: tooMany.id }, null);
    assert.equal(overflow.candidate, null);
    assert.match(overflow.data.error, /500/);
    assert.equal(overflow.data.resultCount, 0);
    overflow.chooseMode({ currentTarget: { dataset: { mode: 'replace' } } });
    assert.ok(overflow.candidate && overflow.candidate.notes.length === 251);
    overflow.onUnload();

    resetEnv();
    const boundary = makeIdea('time-limit', [
      note('t1', 60, 0, 20), note('t2', 62, 20, 20),
      note('t3', 64, 40, 20), note('t4', 65, 60, 20)
    ], { bpm: 40 });
    resetStorage([boundary]);
    const slow = loadCompose({ id: boundary.id }, null);
    assert.equal(slow.candidate, null);
    assert.match(slow.data.error, /120/);
    slow.chooseMode({ currentTarget: { dataset: { mode: 'replace' } } });
    assert.ok(slow.candidate);
    assert.equal(slow.data.resultDuration, '120.0');
    assert.deepEqual(storage.get(boundary.id), boundary);
    slow.onUnload();
  });

  await check('快速切换试听时，过期异步失败不会停止当前播放或误报', async () => {
    resetEnv();
    const source = makeIdea('preview-race', [note('p1', 60, 0, 1), note('p2', 64, 1, 1)], { bpm: 100 });
    resetStorage([source]);
    const page = loadCompose({ id: source.id }, null);
    const calls = [], stops = [];
    page.player = {
      requested: false,
      stop() { this.requested = false; stops.push('stop'); },
      destroy() { this.requested = false; },
      playNotes(notes) {
        let resolve, reject;
        const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
        calls.push({ notes: clone(notes), resolve, reject });
        return promise;
      }
    };
    const first = page.preview({ currentTarget: { dataset: { mode: 'source' } } });
    assert.equal(page.data.playPreparing, true);
    assert.equal(page.data.playing, false, 'preparing a composition must not claim audio is already playing');
    const second = page.preview({ currentTarget: { dataset: { mode: 'result' } } });
    assert.equal(calls.length, 2);
    calls[1].resolve(true);
    assert.equal(await second, true);
    assert.equal(page.data.playPreparing, true);
    page.audioStarted();
    assert.equal(page.data.playback, 'result');
    calls[0].reject(new Error('stale synthesis failure'));
    assert.equal(await first, false);
    assert.equal(page.data.playing, true, 'stale failure must not stop the current result preview');
    assert.equal(page.data.playback, 'result');
    assert.equal(ui.toasts.some(text => /生成试听失败/.test(text)), false);

    const third = page.preview({ currentTarget: { dataset: { mode: 'source' } } });
    const fourth = page.preview({ currentTarget: { dataset: { mode: 'source' } } });
    assert.equal(await fourth, false, 'second tap on the same preview stops it');
    calls[2].reject(new Error('cancelled synthesis'));
    assert.equal(await third, false);
    assert.equal(page.data.playing, false);
    assert.equal(ui.toasts.some(text => /生成试听失败/.test(text)), false);

    const before = calls.length;
    assert.equal(page.changeTone({ detail: { value: 'bad' } }), false);
    assert.equal(page.changeTone({}), false);
    assert.equal(await page.preview({ currentTarget: { dataset: { mode: 'invalid' } } }), false);
    assert.equal(calls.length, before, 'invalid preview mode must not reach the player');
    page.onUnload();
  });

  await check('另存满额与复制失败有反馈，离页时清理本次副本并保留原录音', async () => {
    resetEnv();
    const originalSource = putFile(ROOT + '/recording-pending.wav', 72);
    const source = makeIdea('save-pending', [note('s1', 60, 0, 1)], { source: originalSource });
    resetStorage([source]);
    const page = loadCompose({ id: source.id }, null);
    fsState.holdCopies = true;
    const pending = page.saveAsNew();
    assert.equal(page.data.saving, true);
    assert.equal(fsState.pendingCopies.length, 1);
    const copyPath = fsState.pendingCopies[0].destPath;
    page.onUnload();
    releaseCopy();
    assert.equal(await pending, false);
    assert.equal(fsState.files.has(copyPath), false);
    assert.equal(fsState.files.has(originalSource), true);
    assert.equal(storage.list().length, 1);
    assert.equal(ui.redirects.length, 0);

    resetEnv();
    const missingSource = ROOT + '/recording-missing.wav';
    const copyFail = makeIdea('save-copy-fail', [note('cf', 60, 0, 1)], { source: missingSource });
    resetStorage([copyFail]);
    const failed = loadCompose({ id: copyFail.id }, null);
    assert.equal(await failed.saveAsNew(), false);
    assert.match(ui.modals.at(-1).content, /no such file/);
    assert.equal(storage.list().length, 1);
    assert.equal(failed.data.saving, false);
    failed.onUnload();

    resetEnv();
    const fullIdeas = Array.from({ length: 100 }, (_, index) => makeIdea('full-' + index,
      [note('full-note-' + index, 60, 0, 1)], { updatedAt: 1000 - index }));
    resetStorage(fullIdeas);
    const full = loadCompose({ id: fullIdeas[0].id }, null);
    assert.equal(await full.saveAsNew(), false);
    assert.ok(ui.toasts.some(text => /记录本已满/.test(text)));
    assert.equal(fsState.copies.length, 0);
    assert.equal(storage.list().length, 100);
    full.onUnload();
  });

  await check('editor 阻止重叠进入 composer，通道正向上报并拒绝过期指纹', () => {
    resetEnv();
    const source = makeIdea('source-events', [note('e1', 60, 0, 1), note('e2', 64, 1, 1)]);
    resetStorage([source]);

    const overlapEditor = loadEditor(source.id);
    overlapEditor.idea.notes = [note('o1', 60, 0, 2), note('o2', 64, 1, 1)];
    overlapEditor.dirty = true;
    overlapEditor.render();
    assert.equal(overlapEditor.openComposer(), false);
    assert.ok(ui.toasts.some(text => /重叠/.test(text)));
    assert.equal(ui.navigateTo.length, 0);

    resetEnv();
    resetStorage([source]);
    const editor = loadEditor(source.id);
    const opened = openComposer(editor);
    assert.equal(opened.opened, true);
    assert.match(opened.navigation.url, /returnToEditor=1/);
    assert.equal(editor.openComposer(), false, 'a second tap must not open a competing composition channel');
    const compose = loadComposerForEditor(editor, opened.channel);
    const candidate = clone(compose.candidate.notes);
    compose.applyToSource();
    assert.deepEqual(editor.idea.notes, candidate);
    assert.equal(editor.history.length, 1);
    assert.deepEqual(opened.channel.emissions.map(item => item.name), ['applyComposition', 'compositionResult']);
    assert.equal(opened.channel.emissions[1].payload.ok, true);
    assert.equal(ui.navigateBack, 1);
    assert.equal(compose.data.applying, false);

    resetEnv();
    resetStorage([source]);
    const staleEditor = loadEditor(source.id);
    const staleOpened = openComposer(staleEditor);
    const staleCompose = loadComposerForEditor(staleEditor, staleOpened.channel);
    const oldKey = sourceFingerprint(staleEditor.idea);
    staleEditor.idea.notes[0] = Object.assign({}, staleEditor.idea.notes[0], { midi: staleEditor.idea.notes[0].midi + 1 });
    const editedNotes = clone(staleEditor.idea.notes);
    staleOpened.channel.emit('applyComposition', {
      sourceId: staleEditor.idea.id, sourceKey: oldKey, notes: clone(staleCompose.candidate.notes)
    });
    assert.deepEqual(staleEditor.idea.notes, editedNotes);
    assert.equal(ui.navigateBack, 0);
    assert.equal(staleCompose.data.applying, false);
    assert.match(ui.modals.at(-1).content, /已变化/);
    assert.equal(staleOpened.channel.emissions.at(-1).payload.ok, false);
  });

  await check('500 音符应用完整进入 history，undo 恢复原始音符', () => {
    resetEnv();
    const originalNotes = [note('h1', 60, 0, 1), note('h2', 64, 1.5, 1)];
    const source = makeIdea('source-history', originalNotes, { bpm: 240 });
    resetStorage([source]);
    const editor = loadEditor(source.id);
    const payload = Array.from({ length: 500 }, (_, index) =>
      note('bulk-' + index, 60 + index % 12, index * 0.125, 0.125));
    const result = editor.applyComposition({
      sourceId: source.id, sourceKey: sourceFingerprint(editor.idea), notes: payload
    });
    assert.equal(result.ok, true);
    assert.equal(result.saved, true);
    assert.equal(editor.history.length, 1);
    assert.equal(editor.idea.notes.length, 500);
    assert.equal(storage.get(source.id).notes.length, 500);
    assert.equal(editor.history[0].notes.length, originalNotes.length);

    editor.undo();
    assert.deepEqual(editor.idea.notes, music.normalizeNotes(originalNotes));
    assert.equal(editor.future.at(-1).notes.length, 500);
    editor.flushSave();
    assert.equal(storage.get(source.id).notes.length, originalNotes.length);
    editor.onUnload();
  });

  await check('applyToSource 仅在同一 returnToEditor 来源且 channel 可用时 emit', () => {
    resetEnv();
    const first = makeIdea('gate-a', [note('ga', 60, 0, 1)], { updatedAt: 300 });
    const second = makeIdea('gate-b', [note('gb', 62, 0, 1)], { updatedAt: 200 });
    resetStorage([first, second]);

    const channel = createEventChannel({});
    const parent = loadCompose({ id: first.id, returnToEditor: '1' }, channel);
    assert.equal(parent.data.canApplyToSource, true);
    parent.applyToSource();
    assert.equal(channel.emissions.length, 1);
    assert.equal(channel.emissions[0].payload.sourceId, first.id);
    parent.onUnload();

    const otherChannel = createEventChannel({});
    const otherPage = loadCompose({ id: first.id, returnToEditor: '1' }, otherChannel);
    const otherIndex = otherPage.data.sources.findIndex(item => item.id === second.id);
    assert.ok(otherIndex >= 0);
    otherPage.chooseSource({ detail: { value: String(otherIndex) } });
    assert.equal(otherPage.data.canApplyToSource, false);
    otherPage.applyToSource();
    assert.equal(otherChannel.emissions.length, 0);
    otherPage.onUnload();

    const noChannel = loadCompose({ id: first.id, returnToEditor: '1' }, null);
    assert.equal(noChannel.data.canApplyToSource, false);
    noChannel.applyToSource();
    assert.equal(noChannel.data.applying, false);
    noChannel.onUnload();

    const plainChannel = createEventChannel({});
    const notReturning = loadCompose({ id: first.id }, plainChannel);
    assert.equal(notReturning.data.canApplyToSource, false);
    notReturning.applyToSource();
    assert.equal(plainChannel.emissions.length, 0);
    notReturning.onUnload();
  });

  await check('saveAsNew 先复制自己的录音，再保存新 id/new notes 且原记录不变', async () => {
    resetEnv();
    const originalSource = putFile(ROOT + '/recording-original.wav', 96);
    const source = makeIdea('source-copy', [note('c1', 60, 0, 1), note('c2', 64, 1, 1)], { source: originalSource });
    resetStorage([source]);
    const page = loadCompose({ id: source.id }, null);
    page.choosePreset({ currentTarget: { dataset: { id: 'transpose' } } });
    const candidate = clone(page.candidate.notes);
    const sourceBefore = clone(storage.get(source.id));
    const originalSave = storage.save;
    const saveCalls = [];
    storage.save = function wrappedSave(idea) {
      const copied = Array.from(fsState.files.keys()).find(filePath => filePath.endsWith('/recording-' + idea.id + '.wav'));
      saveCalls.push({ notes: clone(idea.notes), source: idea.source, copied: !!copied });
      fsState.events.push({ kind: 'save', path: copied || '' });
      return originalSave.call(storage, idea);
    };
    try { await page.saveAsNew(); }
    finally { storage.save = originalSave; }

    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0].copied, true);
    assert.deepEqual(saveCalls[0].notes, candidate);
    assert.deepEqual(fsState.events.map(item => item.kind), ['copy', 'save']);
    const ideas = storage.list();
    assert.equal(ideas.length, 2);
    const created = ideas.find(item => item.id !== source.id);
    assert.ok(created && created.id !== source.id);
    assert.notEqual(created.source, originalSource);
    assert.equal(created.source, ROOT + '/recording-' + created.id + '.wav');
    assert.deepEqual(created.notes, candidate);
    assert.equal(created.creation.sourceId, source.id);
    assert.equal(created.creation.preset, 'transpose');
    assert.deepEqual(storage.get(source.id), sourceBefore);
    assert.equal(fsState.files.has(originalSource), true);
    assert.equal(fsState.files.has(created.source), true);
    assert.match(ui.redirects.at(-1).url, new RegExp('id=' + created.id));
    assert.equal(page.data.saving, false);
    page.onUnload();
  });

  await check('saveAsNew 保存失败只清理自己的录音副本，原 source 和其他文件保留', async () => {
    resetEnv();
    const originalSource = putFile(ROOT + '/recording-original.wav', 80);
    const unrelated = putFile(ROOT + '/another.wav', 40);
    const source = makeIdea('source-copy-fail', [note('f1', 60, 0, 1)], { source: originalSource });
    resetStorage([source]);
    const page = loadCompose({ id: source.id }, null);
    const originalSave = storage.save;
    storage.save = function failingSave() {
      fsState.events.push({ kind: 'save', path: '' });
      throw new Error('mock save failure');
    };
    try { await page.saveAsNew(); }
    finally { storage.save = originalSave; }

    assert.equal(fsState.copies.length, 1);
    const copiedPath = fsState.copies[0].destPath;
    assert.notEqual(copiedPath, originalSource);
    assert.equal(fsState.files.has(copiedPath), false);
    assert.equal(fsState.files.has(originalSource), true);
    assert.equal(fsState.files.has(unrelated), true);
    assert.deepEqual(fsState.events.map(item => item.kind), ['copy', 'save', 'unlink']);
    assert.equal(fsState.events.at(-1).path, copiedPath);
    assert.equal(storage.list().length, 1);
    assert.equal(storage.list()[0].source, originalSource);
    assert.match(ui.modals.at(-1).content, /mock save failure/);
    assert.equal(ui.redirects.length, 0);
    assert.equal(page.data.saving, false);
    page.onUnload();
  });

  await check('导航成功回调缺少 eventChannel 时，仍应用结果并返回正确的编辑器', () => {
    resetEnv();
    const source = makeIdea('fallback-channel', [note('x1', 60, 0, .5), note('x2', 64, .5, .5)]);
    resetStorage([source]);
    const editor = loadEditor(source.id), opened = openComposer(editor);
    const composer = loadComposerForEditor(editor, opened.channel);
    composer.route = 'pages/compose/compose';
    editor.compositionChannel = undefined;
    const existing = global.getCurrentPages;
    global.getCurrentPages = () => [editor, composer];
    try {
      assert.equal(composer.applyToSource(), true);
      assert.equal(editor.idea.notes.length, 4);
      assert.equal(composer.data.applying, false);
      assert.equal(ui.navigateBack, 1);
    } finally {
      global.getCurrentPages = existing;
      composer.onUnload();
      editor.onUnload();
    }
  });

  await check('MIDI 文件信息随导出快照固定，发送只开一次且取消或异常后可重试', async () => {
    resetEnv();
    const source = makeIdea('midi-share', [note('m1', 60, 0, 1), note('m2', 64, 1, .75)], { title: '导出快照', bpm: 100 });
    resetStorage([source]);
    const editor = loadEditor(source.id);
    const writing = editor.exportMidi();
    editor.changeTitle({ detail: { value: '编辑新名字' } });
    editor.changeBpm({ detail: { value: '120' } });
    assert.equal(await writing, true);
    assert.equal(editor.data.exportedName, '导出快照.mid');
    assert.equal(editor.data.exportedBpm, 100);
    assert.equal(fsState.files.get(editor.exportedPath).subarray(0, 4).toString(), 'MThd');
    assert.equal(editor.shareMidi(), true);
    assert.equal(editor.shareMidi(), false);
    editor.closeExport();
    assert.equal(editor.data.exportVisible, true);
    assert.equal(ui.shares.length, 1);
    ui.shares[0].fail({ errMsg: 'shareFileMessage:fail cancel' });
    assert.equal(editor.data.midiSharing, false);
    ui.shareThrows = true;
    assert.equal(editor.shareMidi(), false);
    assert.equal(editor.data.exportVisible, true);
    ui.shareThrows = false;
    assert.equal(editor.shareMidi(), true);
    ui.shares[1].success();
    assert.equal(editor.data.exportVisible, false);
    editor.onUnload();
  });

  await check('音频入口准备 WAV，取消清理临时文件，分享 cancel 可重试且 devtools 不调用 API', async () => {
    resetEnv();
    const originalSource = putFile(ROOT + '/recording-audio.wav', 144);
    const source = makeIdea('source-audio', [note('a1', 60, 0, 1), note('a2', 64, 1.25, 0.75)], {
      title: '分层灵感', source: originalSource
    });
    resetStorage([source]);
    const editor = loadEditor(source.id);
    const cachePath = putFile(ROOT + '/preview-cache.wav', 256);
    const previewKey = JSON.stringify([
      editor.idea.bpm, editor.data.tone,
      editor.idea.notes.map(item => [item.midi, item.start, item.duration, item.velocity || 85])
    ]);
    editor.player = {
      requested: false,
      previewCache: { key: previewKey, path: cachePath, duration: 1.8 },
      destroy() {}
    };

    editor.openShareMenu();
    assert.equal(editor.data.shareVisible, true);
    assert.equal(await editor.shareFormat({ currentTarget: { dataset: { kind: 'melody' } } }), true);
    assert.equal(editor.data.shareVisible, false);
    assert.equal(editor.audioExport.kind, 'melody');
    assert.equal(editor.audioExport.owned, true);
    assert.match(editor.audioExport.fileName, /（旋律）\.wav$/);
    assert.match(editor.audioExport.filePath, /\/share-[a-z0-9-]+\.wav$/i);
    assert.equal(fsState.files.has(editor.audioExport.filePath), true);
    assert.equal(fsState.files.has(cachePath), true);
    assert.match(editor.data.audioInfo.name, /\.wav$/);
    editor.closeAudio();
    assert.equal(fsState.files.has(cachePath), true);

    fsState.holdCopies = true;
    const pending = editor.prepareAudio('melody');
    assert.equal(fsState.pendingCopies.length, 1);
    editor.cancelAudioPreparation();
    assert.equal(editor.data.audioPreparing, false);
    assert.ok(ui.hides >= 1);
    const cancelledCopy = fsState.pendingCopies[0];
    releaseCopy();
    assert.equal(await pending, false);
    assert.equal(fsState.files.has(cancelledCopy.destPath), false);
    assert.equal(fsState.files.has(cachePath), true);
    assert.equal(editor.audioExport, null);
    fsState.holdCopies = false;

    assert.equal(await editor.prepareAudio('original'), true);
    assert.equal(editor.audioExport.filePath, originalSource);
    assert.equal(editor.audioExport.owned, false);
    assert.match(editor.audioExport.fileName, /（原始哼唱）\.wav$/);
    editor.data.isDevtools = true;
    const devtoolsShares = ui.shares.length;
    editor.shareAudio();
    assert.equal(ui.shares.length, devtoolsShares);
    assert.ok(ui.toasts.some(text => /手机微信/.test(text)));
    editor.data.isDevtools = false;

    editor.shareAudio();
    assert.equal(ui.shares.length, devtoolsShares + 1);
    assert.equal(ui.shares.at(-1).filePath, originalSource);
    assert.match(ui.shares.at(-1).fileName, /\.wav$/);
    ui.shares.at(-1).fail({ errMsg: 'shareFileMessage:fail cancel' });
    assert.equal(editor.data.audioSharing, false);
    assert.equal(editor.audioExport.filePath, originalSource);
    assert.equal(fsState.files.has(originalSource), true);
    editor.shareAudio();
    assert.equal(ui.shares.length, devtoolsShares + 2);
    ui.shares.at(-1).success();
    assert.equal(editor.audioExport, null);
    assert.equal(fsState.files.has(originalSource), true);

    assert.equal(await editor.prepareAudio('melody'), true);
    const ownedPath = editor.audioExport.filePath;
    editor.shareAudio();
    assert.equal(ui.shares.at(-1).filePath, ownedPath);
    ui.shares.at(-1).fail({ errMsg: 'shareFileMessage:fail cancel' });
    assert.equal(editor.audioExport.filePath, ownedPath);
    assert.equal(fsState.files.has(ownedPath), true);
    editor.shareAudio();
    assert.equal(ui.shares.length, devtoolsShares + 4);
    ui.shares.at(-1).success();
    assert.equal(editor.audioExport, null);
    assert.equal(fsState.files.has(ownedPath), false);
    assert.equal(fsState.files.has(cachePath), true);
    editor.onUnload();
  });

  console.log('\n' + passed + ' creation UI integration checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
