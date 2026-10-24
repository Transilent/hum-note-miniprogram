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
  shares: [], actionSheets: [], shareThrows: false
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
    showActionSheet(options) { ui.actionSheets.push(options); },
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
  page.setData = function setData(patch) {
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

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for ' + label);
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

    wx.showActionSheet = options => {
      ui.actionSheets.push(options);
      options.success({ tapIndex: 0 });
    };
    editor.chooseAudio();
    assert.match(ui.actionSheets.at(-1).itemList[0], /WAV/);
    await waitFor(() => editor.audioExport && !editor.data.audioPreparing, 'melody WAV preparation');
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