const assert = require('node:assert/strict');
const { applyPatch, clone } = require('./page-mock.cjs');
const notes = Array.from({ length: 500 }, (_, i) => ({ id: 'n' + i, midi: 60 + i % 12, start: i * .125, duration: .125, velocity: 85, confidence: 1 }));
const idea = { id: 'stress', title: '压力测试', bpm: 100, notes, updatedAt: 1 };
const store = new Map([['humnote.ideas.v1', [idea]]]), updates = [];
let definition, players = 0;
global.wx = { env: { USER_DATA_PATH: '/mock' }, getWindowInfo: () => ({ windowWidth: 375, windowHeight: 700 }), getDeviceInfo: () => ({ platform: 'devtools' }),
  getStorageSync: key => clone(store.get(key) || ''), setStorageSync: (key, data) => store.set(key, clone(data)), removeStorageSync: key => store.delete(key),
  getFileSystemManager: () => ({ mkdirSync() {} }), createInnerAudioContext() { players++; throw new Error('audio must stay lazy'); }, showToast() {} };
global.Page = page => { definition = page; };
require('../miniprogram/pages/editor/editor');
const page = Object.assign({}, definition, { data: clone(definition.data), setData(patch) { updates.push(patch); applyPatch(this.data, patch); } });
try {
  page.onLoad({ id: idea.id }); assert.equal(players, 0); assert.equal(page.data.notes.length, 500);
  updates.length = 0; page.render(); assert.equal(updates.length, 0, 'unchanged render must not cross the bridge');
  page.selectNote({ currentTarget: { dataset: { id: 'n250' } } });
  assert.equal(page.data.notes.filter(n => n.selected).length, 1);
  assert.equal(page.data.notes[250].selected, true);
  updates.length = 0;
  page.onNoteTouchStart({ currentTarget: { dataset: { id: 'n250' } }, touches: [{ clientX: 100, clientY: 100 }] });
  for (let i = 1; i <= 40; i++) page.applyGesture({ clientX: 100, clientY: 100 - (i % 2 ? 22 : 44) }, true);
  const bytes = updates.reduce((sum, p) => sum + Buffer.byteLength(JSON.stringify(p)), 0);
  assert.ok(bytes < 50000, '500-note drag must use bounded incremental patches: ' + bytes);
  assert.ok(updates.some(p => p['notes[250]']), 'changed note index must be updated');
  for (let i = 0; i < 500; i++) {
    assert.equal(page.data.notes[i].midi, page.idea.notes[i].midi);
    assert.equal(page.data.notes[i].start, page.idea.notes[i].start);
  }
  page.onNoteTouchEnd();
  page.changeZoom({ currentTarget: { dataset: { delta: 1 } } });
  assert.equal(page.data.notes[250].x, 68 + page.idea.notes[250].start * 160);
  assert.equal(page.data.ticks[1].x, 228);
  page.deleteNote(); assert.equal(page.data.notes.length, 499);
  assert.equal(page.data.notes.filter(n => n.selected).length, 1);
  assert.equal(page.data.notes.find(n => n.selected).id, page.data.selectedId);
  page.replaceNotes([{ id: 'long', midi: 60, start: 0, duration: 32 }]);
  page.durationInput({ detail: { value: '32' } });
  page.nudgeDuration({ currentTarget: { dataset: { delta: -.125 } } });
  assert.equal(page.idea.notes[0].duration, 31.875, 'long augmented notes must remain precisely editable');
  console.log('PASS 500-note editor: lazy audio, no-op render, selection, incremental drag, view/model agreement, zoom grid (' + bytes + ' bytes / 40 moves)');
} finally { page.onUnload(); }
