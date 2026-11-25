const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { applyPatch, clone } = require('./page-mock.cjs');

// Dense notes cover the editor's full supported range, with a 79.875-beat rest
// between the two dense halves. The first selected note at MIDI 21 is far from
// the top of the roll, so this also catches a viewport stuck at scrollTop 0.
const notes = Array.from({ length: 500 }, (_, i) => ({
  id: 'n' + i, midi: 21 + (i * 37) % 88,
  start: i < 250 ? i * .125 : 80 + (i - 250) * .125,
  duration: .125, velocity: 85, confidence: 1
}));
const idea = { id: 'stress', title: '压力测试', bpm: 100, notes, updatedAt: 1 };
const store = new Map([['humnote.ideas.v1', [idea]]]), updates = [], toasts = [];
let definition, players = 0;

global.wx = {
  env: { USER_DATA_PATH: '/mock' }, getWindowInfo: () => ({ windowWidth: 375, windowHeight: 700 }), getDeviceInfo: () => ({ platform: 'devtools' }),
  getStorageSync: key => clone(store.get(key) || ''), setStorageSync: (key, data) => store.set(key, clone(data)), removeStorageSync: key => store.delete(key),
  getFileSystemManager: () => ({ mkdirSync() {} }), createInnerAudioContext() { players++; throw new Error('audio must stay lazy'); },
  showToast: value => toasts.push(value.title)
};
global.Page = page => { definition = page; };
require('../miniprogram/pages/editor/editor');

const page = Object.assign({}, definition, {
  data: clone(definition.data),
  setData(patch) { updates.push(patch); applyPatch(this.data, patch); }
});

(async () => {
  try {
    page.onLoad({ id: idea.id });
    assert.equal(players, 0, 'loading a dense score must not create audio');
    assert.equal(page.noteViews.length, 500, 'logic-layer views retain the complete score');
    assert.equal(page.idea.notes.length, 500);
    assert.equal(page.data.noteCount, 500);
    assert.equal(page.data.notes, undefined, 'the full score must not be duplicated in WebView data');
    assert.ok(updates.reduce((sum, patch) => sum + Buffer.byteLength(JSON.stringify(patch)), 0) < 50000,
      'opening 500 notes must only transfer the visible windows and grid');

    const factor = page.factor;
    const selected = page.data.selected;
    const viewportTop = page.data.rollScrollTop / factor;
    assert.ok(page.data.rollScrollTop > 0, 'wide-range score must start below the empty top rows');
    assert.ok(selected.y >= viewportTop && selected.y <= viewportTop + page.data.rollHeight,
      'initially selected pitch must be visible: y=' + selected.y + ', viewport=' + viewportTop + '..' + (viewportTop + page.data.rollHeight));
    assert.ok(page.data.rollNotes.some(n => n.id === selected.id));
    assert.ok(page.data.rollNotes.length < 120, 'roll must only mount a bounded pitch/time window: ' + page.data.rollNotes.length);
    assert.equal(page.data.listNotes.length, 0, 'opening the editor must leave the closed note list unloaded');
    page.openNoteList();
    assert.ok(page.data.listNotes.length <= 48, 'list must only mount a bounded row window: ' + page.data.listNotes.length);
    const initialWindow = { roll: page.data.rollNotes.length, list: page.data.listNotes.length, scrollTop: page.data.rollScrollTop };

    updates.length = 0;
    page.render();
    assert.equal(updates.length, 0, 'unchanged render must not cross the bridge');

    // A virtual list still reaches every note: scroll to the final row and
    // reconstruct the library length from the two spacers.
    page.onNoteListScroll({ detail: { scrollTop: 492 * 44 } });
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.ok(page.data.listNotes.some(n => n.id === 'n499'), 'virtual list must expose the 500th note');
    const mountedRows = page.data.listTopPad / 44 + page.data.listNotes.length + page.data.listBottomPad / 44;
    assert.equal(mountedRows, 500, 'top window and bottom spacer must preserve the complete list range');
    page.closeNoteList();
    page.openNoteList();
    assert.equal(page.data.listScrollTop, 492 * 44);
    assert.ok(page.data.listNotes.some(n => n.id === 'n499'), 'reopening must restore the corresponding list window');

    // Keep sending scroll events faster than the refresh budget. Debouncing
    // would leave the window blank until a long fling finally stopped.
    updates.length = 0;
    for (let i = 0; i < 9; i++) {
      page.onNoteListScroll({ detail: { scrollTop: (100 + i * 10) * 44 } });
      page.onRollScroll({ detail: { scrollLeft: (i + 1) * 30, scrollTop: page.rollScrollY } });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(updates.some(patch => patch.listNotes || Object.keys(patch).some(key => key.startsWith('listNotes['))),
      'list window must update while a continuous scroll is still in progress');
    assert.ok(updates.some(patch => patch.rollNotes || Object.keys(patch).some(key => key.startsWith('rollNotes['))),
      'piano roll must update while a continuous scroll is still in progress');
    await new Promise(resolve => setTimeout(resolve, 50));
    page.closeNoteList();
    page.rollScrollX = 0;

    // Long rests remain navigable without materializing their off-screen notes.
    page.rollScrollX = 80 * page.data.beatWidth * factor;
    page.refreshRollWindow();
    assert.ok(page.data.rollNotes.some(n => n.id === 'n250'), 'window after a long rest must show its first notes');
    assert.equal(page.data.rollNotes.some(n => n.id === 'n0'), false);
    assert.equal(page.noteViews.length, 500);

    page.selectNote({ currentTarget: { dataset: { id: 'n250' } } });
    page.focusSelected();
    assert.equal(page.noteViews.filter(n => n.selected).length, 1);
    assert.equal(page.noteViews[250].selected, true);
    assert.ok(page.data.rollNotes.some(n => n.id === 'n250'), 'focusing a list selection must bring it into the roll window');

    updates.length = 0;
    const dragBegan = performance.now();
    page.onNoteTouchStart({ currentTarget: { dataset: { id: 'n250' } }, touches: [{ clientX: 100, clientY: 100 }] });
    for (let i = 1; i <= 40; i++) page.applyGesture({ clientX: 100, clientY: 100 - (i % 2 ? 22 : 44) }, true);
    const dragMs = performance.now() - dragBegan;
    const dragUpdates = updates.length;
    const bytes = updates.reduce((sum, patch) => sum + Buffer.byteLength(JSON.stringify(patch)), 0);
    assert.ok(dragUpdates <= 43, '40 drag frames should use at most one bridge call per frame: ' + dragUpdates);
    assert.ok(bytes < 35000, '500-note drag must use bounded incremental patches: ' + bytes);
    assert.ok(updates.every(patch => Object.keys(patch).every(key => !/^notes(?:\[|$)/.test(key))),
      'dragging must not serialize the complete score or off-screen note array');
    assert.equal(page.data.rollNotes.find(note => note.id === 'n250').midi, page.idea.notes[250].midi,
      'the mounted note must reflect the actual edit');
    for (let i = 0; i < 500; i++) {
      assert.equal(page.noteViews[i].midi, page.idea.notes[i].midi);
      assert.equal(page.noteViews[i].start, page.idea.notes[i].start);
    }
    page.applyGesture({ clientX: 100, clientY: -5000 }, true);
    assert.ok(page.data.rollNotes.some(n => n.id === 'n250'), 'active drag must stay mounted when it leaves the old window');
    page.onNoteTouchEnd();

    page.changeZoom({ currentTarget: { dataset: { delta: 1 } } });
    assert.equal(page.noteViews[250].x, 68 + page.idea.notes[250].start * 160);
    assert.equal(page.data.ticks[1].x, 228);
    page.deleteNote(); assert.equal(page.noteViews.length, 499);
    assert.equal(page.noteViews.filter(n => n.selected).length, 1);
    assert.equal(page.noteViews.find(n => n.selected).id, page.data.selectedId);

    page.replaceNotes([{ id: 'long', midi: 60, start: 0, duration: 1 }]);
    page.selectNote({ currentTarget: { dataset: { id: 'long' } } });
    page.onNoteTouchStart({ currentTarget: { dataset: { id: 'long', mode: 'duration' } }, touches: [{ clientX: 100, clientY: 100 }] });
    page.onNoteTouchEnd({ changedTouches: [{ clientX: 20000, clientY: 100 }] });
    assert.equal(page.idea.notes[0].duration, 32, 'duration drag must stop at the same 32-beat model limit as numeric input');
    assert.equal(page.data.selected.durationLabel, '32');
    assert.equal(page.data.durationInput, '32');

    page.onDurationDraftInput({ detail: { value: '33' } });
    updates.length = 0;
    page.durationInput({ detail: { value: '33' } });
    assert.equal(page.idea.notes[0].duration, 32);
    assert.equal(page.data.durationInput, '32', 'invalid duration must visibly restore the last valid value');
    assert.ok(updates.some(patch => patch.durationInput === '32'));

    page.onStartDraftInput({ detail: { value: 'not-a-number' } });
    page.startInput({ detail: { value: 'not-a-number' } });
    assert.equal(page.data.startInput, '1', 'invalid start must visibly restore the selected note value');
    page.onBpmDraftInput({ detail: { value: '999' } });
    page.changeBpm({ detail: { value: '999' } });
    assert.equal(page.idea.bpm, 100);
    assert.equal(page.data.bpmInput, '100', 'invalid BPM must visibly restore the stored value');
    assert.ok(toasts.some(message => message.includes('起始拍')));
    assert.ok(toasts.some(message => message.includes('时值范围')));
    assert.ok(toasts.some(message => message.includes('速度需在')));

    page.replaceNotes([{ id: 'slow-boundary', midi: 60, start: 48.3, duration: 32 }]);
    page.changeBpm({ detail: { value: '40.4' } });
    assert.equal(page.idea.bpm, 100, 'rounded BPM must not allow a clip longer than 120 seconds');

    // Preparation is explicit and re-entrant clicks cancel the one pending job.
    const pendingPlayback = [], player = {
      requested: false, stopCalls: 0,
      playNotes() { return new Promise(resolve => pendingPlayback.push(resolve)); },
      stop() { this.stopCalls++; }, playFile() {}, destroy() {}
    };
    page.getPlayer = () => player;
    page.onRollScroll({ detail: { scrollLeft: 400, scrollTop: page.rollScrollY } });
    const firstPlay = page.play();
    assert.equal(pendingPlayback.length, 1);
    assert.equal(page.data.playPreparing, true);
    assert.equal(page.data.playing, false, 'preparation must not claim playback already started');
    assert.equal(page.data.rollScrollLeft, 0, 'starting playback must return the roll to time zero');
    assert.equal(await page.play(), false);
    assert.equal(pendingPlayback.length, 1, 'second tap must not start a duplicate synthesis');
    assert.equal(page.data.playPreparing, false);
    pendingPlayback[0](true);
    assert.equal(await firstPlay, false, 'cancelled preparation must ignore its late completion');
    assert.equal(page.data.playing, false);
    const secondPlay = page.play();
    assert.equal(page.data.playPreparing, true);
    assert.equal(pendingPlayback.length, 2);
    pendingPlayback[1](true);
    assert.equal(await secondPlay, true);
    assert.equal(page.data.playPreparing, true, 'file activation waits for the native playback event');
    page.audioStarted();
    assert.equal(page.data.playPreparing, false);
    assert.equal(page.data.playing, true);
    page.stop();

    page.replaceNotes([
      { id: 'split', midi: 60, start: 0, duration: 1.25 },
      { id: 'repeat', midi: 60, start: 1.5, duration: .75 },
      { id: 'fast', midi: 62, start: 2.3, duration: .1 }
    ]);
    page.setCue(.5);
    assert.equal(page.data.canSplit, true);
    assert.equal(page.splitSelected(), true);
    assert.deepEqual(page.idea.notes.map(note => [note.start, note.duration]), [[0, .5], [.5, .75], [1.5, .75], [2.3, .1]]);
    assert.equal(page.mergeSelected(), true);
    assert.equal(page.idea.notes[0].duration, 1.25);
    let confirmation;
    wx.showModal = value => { confirmation = value; };
    assert.equal(page.mergeSelected(), true);
    assert.match(confirmation.content, /0.25 拍休止/);
    assert.equal(page.idea.notes.length, 3, 'the rest is preserved until the merge is confirmed');
    confirmation.success({ confirm: true });
    assert.deepEqual(page.idea.notes.map(note => [note.start, note.duration]), [[0, 2.25], [2.3, .1]]);
    page.undo();
    assert.equal(page.idea.notes[1].start, 1.5);
    console.log('PASS ruler split and same-pitch merge preserve a separate short note and confirm consuming a rest');

    let playedFile, sought;
    player.playFile = (...args) => { playedFile = args; return true; };
    player.seek = seconds => { sought = seconds; return true; };
    page.idea.source = '/mock/source.wav';
    page.commitView({ originalSeconds: 6 });
    page.changeListenSource({ currentTarget: { dataset: { source: 'original' } } });
    page.seekOriginal({ detail: { value: 250 } });
    assert.equal(page.playCurrent(), true);
    assert.deepEqual(playedFile, ['/mock/source.wav', 1.5, 6]);
    page.updatePlayback(1.8);
    assert.equal(page.data.originalProgress, 250);
    page.audioStarted();
    page.updatePlayback(1.8);
    assert.equal(page.data.originalProgress, 300);
    page.seekOriginal({ detail: { value: 500 } });
    assert.equal(sought, 3);
    assert.equal(page.cueBeat, .5, 'scrubbing the original must preserve the independent melody cue');
    page.changeListenSource({ currentTarget: { dataset: { source: 'melody' } } });
    assert.equal(page.data.playing, false);
    assert.equal(page.data.playhead, page.cursorX(.5));
    console.log('PASS original audio starts at the scrubber position and leaves the melody cue independent');

    // Edits retain the 40-step contract even under the virtualized view.
    page.history = []; page.future = [];
    for (let i = 0; i < 45; i++) page.nudgeDuration({ currentTarget: { dataset: { delta: i % 2 ? -.125 : .125 } } });
    assert.equal(page.history.length, 40);
    for (let i = 0; i < 40; i++) page.undo();
    assert.equal(page.history.length, 0);
    assert.equal(page.future.length, 40);
    const atOldestRetained = page.idea.notes[0].duration;
    page.undo();
    assert.equal(page.idea.notes[0].duration, atOldestRetained, 'undo must stop after the retained 40 edits');

    const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/editor/editor.wxml'), 'utf8');
    page.replaceNotes(notes);
    page.openNoteList();
    page.onNoteListScroll({ detail: { scrollTop: 492 * 44 } });
    page.onRollScroll({ detail: { scrollLeft: 7000, scrollTop: 3000 } });
    await new Promise(resolve => setTimeout(resolve, 50));
    page.replaceNotes(Array.from({ length: 8 }, (_, i) => ({ id: 'short-' + i, midi: 60 + i, start: i, duration: .5 })));
    assert.equal(page.data.noteCount, 8);
    assert.equal(page.data.listNotes.length, 8, 'shrinking the score must not retain an out-of-range list window');
    assert.equal(page.data.listTopPad, 0);
    assert.equal(page.data.listBottomPad, 0);
    assert.ok(page.data.rollNotes.length > 0, 'shrinking must leave visible roll notes without a native scroll event');
    assert.ok(page.rollScrollX <= Math.max(0, (page.data.rollWidth - 678) * factor));
    assert.ok(page.rollScrollY <= Math.max(0, (page.data.rollContentHeight - page.data.rollHeight) * factor));
    assert.ok(page.noteListScrollY <= 8 * 44 - 264);
    console.log('PASS scrolled 500-note score shrinks to 8 notes without empty windows or oversized spacers');
    assert.match(template, /wx:for="\{\{rollNotes\}\}"/);
    assert.match(template, /wx:for="\{\{listNotes\}\}"/);
    assert.doesNotMatch(template, /wx:for="\{\{notes\}\}"/);
    const loopRowsBefore = 1000, loopRowsAfter = initialWindow.roll + initialWindow.list;
    console.log('PASS 500 dense/wide/rest editor: ' + loopRowsBefore + ' -> ' + loopRowsAfter + ' note loops (' +
      initialWindow.roll + ' roll + ' + initialWindow.list + ' list), ' + bytes + ' bytes and ' + dragUpdates +
      ' setData calls / 40 moves in ' + dragMs.toFixed(1) + ' ms (Node harness), initial rollTop=' + initialWindow.scrollTop.toFixed(1) + 'px');
  } finally {
    page.onUnload();
  }
})().catch(error => { page.onUnload(); console.error(error); process.exitCode = 1; });
