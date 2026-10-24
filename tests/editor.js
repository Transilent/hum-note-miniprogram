const assert = require('node:assert/strict');
const { applyPatch } = require('./page-mock.cjs');
const clone = value => JSON.parse(JSON.stringify(value));

module.exports = async function(check, asyncCheck) {
  const originalWx = global.wx, originalPage = global.Page, values = new Map(), pages = [], toasts = [];
  let definition, fileWrites = 0;
  global.wx = {
    env: { USER_DATA_PATH: '/mock-only' }, getWindowInfo: () => ({ windowWidth: 375 }), getDeviceInfo: () => ({ platform: 'devtools' }),
    getStorageSync: key => values.has(key) ? clone(values.get(key)) : '', setStorageSync: (key, value) => values.set(key, clone(value)),
    getFileSystemManager: () => ({ mkdirSync() {}, writeFile() { fileWrites++; } }),
    createInnerAudioContext: () => ({ onEnded() {}, onError() {}, onTimeUpdate() {}, onPlay() {}, onPause() {}, onWaiting() {}, onSeeking() {}, onSeeked() {}, stop() {}, destroy() {} }),
    showToast: data => toasts.push(data.title), pageScrollTo: options => { global.lastEditorScroll = options; }
  };
  global.Page = value => { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/editor/editor'); delete require.cache[modulePath];
  const storage = require('../miniprogram/utils/storage');
  const music = require('../miniprogram/utils/music');
  try {
    require(modulePath);
    const fixture = { id: 'free-edit-test', title: 'test', bpm: 100, createdAt: 1, notes: [
      { id: 'a', midi: 60, start: 0, duration: 1 }, { id: 'b', midi: 64, start: 2, duration: 1 }, { id: 'c', midi: 67, start: 4, duration: 1 }
    ] };
    storage.save(fixture);
    const createPage = () => {
      const page = Object.assign({}, definition, { data: clone(definition.data), setData(patch) { applyPatch(this.data, patch); } });
      pages.push(page); page.onLoad({ id: fixture.id }); return page;
    };
    const touchStart = (page, id, mode) => page.onNoteTouchStart({ currentTarget: { dataset: { id, mode: mode || 'move' } }, touches: [{ clientX: 100, clientY: 100 }] });
    const touchEnd = (page, x, y) => page.onNoteTouchEnd({ changedTouches: [{ clientX: x, clientY: y }] });
    const note = (page, id) => page.idea.notes.find(n => n.id === id);
    let page = createPage();

    check('真实编辑处理函数：横拖调整留白，不移动其他音符', () => {
      touchStart(page, 'b'); page.onNoteTouchMove({ touches: [{ clientX: 80, clientY: 100 }] }); touchEnd(page, 80, 100);
      assert.equal(note(page, 'b').start, 1.5); assert.equal(note(page, 'b').midi, 64); assert.equal(note(page, 'c').start, 4);
      assert.equal(page.flushSave(), true); assert.equal(storage.get(fixture.id).notes[1].start, 1.5);
    });
    check('拖入重叠后仍保留位置，只保存草稿并保留上次有效版本', () => {
      touchStart(page, 'b'); page.onNoteTouchMove({ touches: [{ clientX: 60, clientY: 100 }] }); touchEnd(page, 60, 100);
      assert.equal(note(page, 'b').start, .5); assert.equal(page.data.hasOverlaps, true); assert.equal(page.data.overlapCount, 2);
      assert.equal(page.flushSave(), false); assert.equal(storage.get(fixture.id).notes[1].start, 1.5);
      assert.equal(storage.getDraft(fixture.id).notes[1].start, .5);
      assert.throws(() => storage.save(page.idea), error => error.code === 'NOTE_OVERLAP');
      page.saveNow(); assert.ok(toasts.at(-1).includes('重叠'));
    });
    await asyncCheck('编辑中允许重叠，但实际导出入口不会写文件或显示成功', async () => {
      const before = fileWrites; assert.equal(await page.exportMidi(), false); assert.equal(fileWrites, before);
      assert.equal(page.data.exportVisible, false); assert.ok(toasts.at(-1).includes('重叠'));
    });
    check('离开并重进时恢复重叠草稿，不丢失横拖结果', () => {
      page.onHide(); page.onUnload(); page = createPage();
      assert.equal(note(page, 'b').start, .5); assert.equal(page.data.hasOverlaps, true); assert.ok(page.data.draftState.includes('草稿'));
    });
    check('修正起始拍后恢复保存，撤销重做也能跨越重叠状态', () => {
      page.selectNote({ currentTarget: { dataset: { id: 'b' } } }); page.startInput({ detail: { value: '3' } });
      assert.equal(note(page, 'b').start, 2); assert.equal(page.data.hasOverlaps, false); assert.equal(page.flushSave(), true);
      assert.equal(storage.getDraft(fixture.id), undefined); assert.equal(storage.get(fixture.id).notes[1].start, 2);
      page.undo(); assert.equal(page.data.hasOverlaps, true); assert.equal(page.flushSave(), false);
      page.redo(); assert.equal(page.data.hasOverlaps, false); assert.equal(page.flushSave(), true);
    });
    check('上下拖动仍只改音高，拉长时值不带动下一音符', () => {
      touchStart(page, 'b'); touchEnd(page, 100, 78);
      assert.equal(note(page, 'b').midi, 65); assert.equal(note(page, 'b').start, 2);
      page.flushSave(); touchStart(page, 'a', 'duration'); touchEnd(page, 160, 100);
      assert.equal(note(page, 'a').duration, 2.5); assert.equal(note(page, 'b').start, 2); assert.equal(page.data.hasOverlaps, true);
      page.undo(); assert.equal(page.data.hasOverlaps, false); page.flushSave();
    });
    check('快速松手采用最终触点，精确起始拍不强制吸附网格', () => {
      touchStart(page, 'b'); page.onNoteTouchMove({ touches: [{ clientX: 110, clientY: 100 }] }); touchEnd(page, 140, 100);
      assert.equal(note(page, 'b').start, 3); assert.equal(music.getOverlaps(page.idea.notes).pairCount, 0);
      page.startInput({ detail: { value: '3.333' } }); assert.equal(note(page, 'b').start, 2.333); page.flushSave();
    });
    check('缺少有效坐标的触摸事件不会删除或移动音符', () => {
      const before = clone(page.idea.notes);
      page.onNoteTouchStart({ currentTarget: { dataset: { id: 'b' } }, touches: [{}] });
      page.onNoteTouchMove({ touches: [{}] }); page.onNoteTouchEnd({ changedTouches: [{}] });
      assert.deepEqual(page.idea.notes, before);
    });
    check('放大卷帘仍按显示网格拖动，展开与清单跳转不改音符', () => {
      page.startInput({ detail: { value: '3' } });
      page.changeZoom({ currentTarget: { dataset: { delta: 1 } } });
      assert.equal(page.data.zoom, 2); assert.equal(page.data.beatWidth, 160);
      touchStart(page, 'b'); touchEnd(page, 180, 100);
      assert.equal(note(page, 'b').start, 3);
      const before = clone(page.idea.notes);
      page.toggleExpanded(); assert.equal(page.data.expanded, true); assert.ok(page.data.rollHeight > 490);
      page.editSelected(); assert.equal(page.data.expanded, false);
      page.selectFromList({ currentTarget: { dataset: { id: 'c' } } });
      assert.equal(page.data.selectedId, 'c'); assert.equal(global.lastEditorScroll.selector, '#note-editor');
      assert.deepEqual(page.idea.notes, before); delete global.lastEditorScroll;
    });
  } finally {
    for (const page of pages) { clearTimeout(page.saveTimer); if (page.player) page.player.destroy(); }
    delete require.cache[modulePath];
    if (originalWx === undefined) delete global.wx; else global.wx = originalWx;
    if (originalPage === undefined) delete global.Page; else global.Page = originalPage;
  }
};
