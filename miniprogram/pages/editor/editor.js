const music = require('../../utils/music');
const storage = require('../../utils/storage');
const { viewPatch } = require('../../utils/view-patch');
const copy = value => JSON.parse(JSON.stringify(value));

Page({
  data: { title: '', bpm: 100, notes: [], selected: null, selectedId: '', tone: 'piano',
    toneNames: ['木质琴音', '柔和正弦'], toneIndex: 0, playing: false, playbackMode: '',
    durationLabel: '0.0', playTime: '00:00', playhead: 68, rollWidth: 680, rollHeight: 420,
    rows: [], ticks: [], canUndo: false, canRedo: false, saveState: '已保存',
    source: null, isDemo: false, isDevtools: false, exportVisible: false, exportedName: '', exportedSize: '', exporting: false,
    hasOverlaps: false, overlapCount: 0, draftState: '', expanded: false, zoom: 1,
    audioPreparing: false, audioVisible: false, audioInfo: null, audioSharing: false,
    beatWidth: 80, rowHeight: 44, rollScrollLeft: 0, rollScrollTop: 0 },
  onLoad(options) {
    this.alive = true; this.history = []; this.future = [];
    const saved = storage.get(options.id), draft = storage.getDraft(options.id);
    const restoreDraft = draft && (!saved || draft.draftUpdatedAt >= saved.updatedAt);
    this.idea = restoreDraft ? draft : saved;
    if (!this.idea) { wx.showToast({ title: '这条灵感不存在', icon: 'none' }); setTimeout(() => wx.navigateBack(), 900); return; }
    this.idea = copy(this.idea);
    this.idea.notes = music.normalizeNotes(this.idea.notes); this.dirty = !!restoreDraft;
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.factor = windowInfo.windowWidth / 750;
    this.windowHeight = windowInfo.windowHeight || 700;
    const platform = wx.getDeviceInfo ? wx.getDeviceInfo().platform : wx.getSystemInfoSync().platform;
    this.setData({ isDevtools: platform === 'devtools' });
    this.selectedId = this.idea.notes[0] && this.idea.notes[0].id;
    this.render();
    if (restoreDraft) {
      this.setData({ saveState: this.data.hasOverlaps ? '重叠，无法保存' : '待保存', draftState: '草稿已暂存' });
      if (!this.data.hasOverlaps) this.scheduleSave();
    }
  },
  onHide() { this.cancelAudioPreparation(); this.stop(); this.flushSave(); },
  onUnload() {
    this.cancelAudioPreparation(); this.flushSave(); this.alive = false;
    if (this.player) this.player.destroy(); clearTimeout(this.saveTimer);
    if (this.audioExport) require('../../utils/audio-export').cleanupAudioExport(this.audioExport);
  },
  openComposer() {
    if (!this.idea || this.data.audioPreparing) return false;
    this.stop();
    if (!this.flushSave()) {
      wx.showToast({ title: this.data.hasOverlaps ? '先解决音符重叠，再进入创作' : '请先保存成功再进入创作', icon: 'none' }); return false;
    }
    wx.navigateTo({ url: '/pages/compose/compose?id=' + this.idea.id + '&returnToEditor=1&tone=' + this.data.tone,
      events: { applyComposition: payload => {
        const result = this.applyComposition(payload);
        if (this.compositionChannel && this.compositionChannel.emit) this.compositionChannel.emit('compositionResult', result);
      } },
      success: result => { this.compositionChannel = result.eventChannel; }
    });
    return true;
  },
  applyComposition(payload) {
    const { sourceFingerprint } = require('../../utils/creation-session');
    if (!this.alive || !payload || payload.sourceId !== this.idea.id || payload.sourceKey !== sourceFingerprint(this.idea))
      return { ok: false, message: '原旋律已变化，请重新打开创作页，避免覆盖新的编辑。' };
    if (!Array.isArray(payload.notes) || !payload.notes.length || payload.notes.length > 500)
      return { ok: false, message: '创作结果需在 1 到 500 个音符以内。' };
    const ids = new Set();
    if (!payload.notes.every(n => {
      if (!n || !n.id || ids.has(String(n.id)) || !Number.isInteger(n.midi) || n.midi < 21 || n.midi > 108 ||
        !Number.isFinite(n.start) || n.start < 0 || !Number.isFinite(n.duration) || n.duration < .125 || n.duration > 32) return false;
      ids.add(String(n.id)); return true;
    })) return { ok: false, message: '创作结果中有无效音符，请重新生成后再应用。' };
    try { music.assertNoOverlaps(payload.notes); }
    catch (error) { return { ok: false, message: error.message }; }
    if (!this.replaceNotes(payload.notes)) return { ok: false, message: '创作结果超过旋律时长限制，请缩短后再应用。' };
    return { ok: true, saved: this.flushSave() };
  },
  getPlayer() {
    if (!this.player) {
      const { Player } = require('../../utils/audio');
      this.player = new Player(() => { if (this.alive) this.setData({ playing: false, playbackMode: '', playhead: 68, playTime: '00:00' }); },
        time => this.updatePlayback(time),
        () => { if (this.alive) { this.setData({ playing: false, playbackMode: '' }); wx.showToast({ title: '试听失败，请检查音量后重试', icon: 'none' }); } });
    }
    return this.player;
  },
  updatePlayback(time) {
    if (!this.alive || this.data.playbackMode !== 'melody') return;
    const x = 68 + Math.min(time * this.idea.bpm / 60, this.totalBeats) * this.data.beatWidth;
    const patch = {}, playhead = Math.round(x * 10) / 10;
    if (playhead !== this.data.playhead) patch.playhead = playhead;
    const label = music.timeLabel(time);
    if (label !== this.data.playTime) patch.playTime = label;
    // Follow once per screen rather than sending a scroll command every frame.
    const screen = 678 * this.factor;
    if (x * this.factor > (this.rollScrollX || 0) + screen - 30) {
      patch.rollScrollLeft = Math.max(0, (x - 68) * this.factor);
    }
    if (Object.keys(patch).length) this.setData(patch);
  },
  render() {
    if (!this.idea) return;
    const notes = this.idea.notes, pitches = notes.map(n => n.midi);
    if (!notes.some(n => n.id === this.selectedId)) this.selectedId = notes[0] && notes[0].id;
    const beatWidth = 80 * this.data.zoom, rowHeight = 44;
    const low = this.gesture ? this.gesture.low : Math.max(21, Math.min(57, ...pitches) - 2);
    const high = this.gesture ? this.gesture.high : Math.min(108, Math.max(69, ...pitches) + 2);
    this.rollHigh = high; this.rollLow = low;
    const overlaps = music.getOverlaps(notes), conflictIds = new Set(overlaps.ids);
    this.totalBeats = music.totalBeats(notes);
    const total = Math.max(8, Math.ceil(this.totalBeats) + 1), gridKey = [low, high, total, beatWidth].join(':');
    if (!this.grid || this.grid.key !== gridKey) {
      const rows = [], ticks = [];
      for (let midi = high; midi >= low; midi--) rows.push({ midi, name: music.noteName(midi), black: [1, 3, 6, 8, 10].indexOf(midi % 12) >= 0, y: 44 + (high - midi) * rowHeight });
      for (let i = 0; i <= total; i++) ticks.push({ beat: i, label: i % 4 === 0 ? String(i / 4 + 1) : '·', x: 68 + i * beatWidth, bar: i % 4 === 0 });
      this.grid = { key: gridKey, rows, ticks };
    }
    const { rows, ticks } = this.grid;
    const noteViews = notes.map((n, i) => Object.assign({}, n, { label: music.noteName(n.midi), number: String(i + 1).padStart(2, '0'),
      x: 68 + n.start * beatWidth, y: 44 + (high - n.midi) * rowHeight + 4, width: Math.max(10, n.duration * beatWidth - 2),
      startLabel: (n.start + 1).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''),
      durationLabel: n.duration.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''), uncertain: n.confidence < .8, overlapping: conflictIds.has(n.id), selected: n.id === this.selectedId }));
    let selected = noteViews.find(n => n.id === this.selectedId);
    if (!selected && noteViews.length) { selected = noteViews[0]; this.selectedId = selected.id; }
    if (selected) {
      const before = notes.slice(0, notes.findIndex(n => n.id === selected.id));
      const previousEnd = before.reduce((end, n) => Math.max(end, n.start + n.duration), 0);
      selected = Object.assign({}, selected, { gapBefore: music.round(Math.max(0, selected.start - previousEnd)) });
    }
    const status = overlaps.ids.length ? { saveState: '重叠，无法保存' } : this.data.hasOverlaps ? { saveState: '待保存', draftState: '' } : {};
    const next = { title: this.idea.title, bpm: this.idea.bpm, notes: noteViews,
      selected: selected || null, selectedId: this.selectedId || '', rows, ticks, beatWidth, rowHeight,
      rollWidth: Math.max(678, 68 + total * beatWidth), rollContentHeight: 44 + rows.length * rowHeight,
      rollHeight: this.data.expanded ? Math.max(280, (this.windowHeight - 235) / this.factor) : Math.min(44 + rows.length * rowHeight, Math.max(600, Math.min(900, this.windowHeight * .56 / this.factor))),
      durationLabel: music.seconds(notes, this.idea.bpm).toFixed(1), source: this.idea.source || null, isDemo: !!this.idea.isDemo,
      canUndo: !!this.history.length, canRedo: !!this.future.length,
      hasOverlaps: !!overlaps.ids.length, overlapCount: overlaps.ids.length, ...status };
    const patch = viewPatch(this.rendered, next);
    this.rendered = next;
    if (Object.keys(patch).length) this.setData(patch);
  },
  snapshot() { return { notes: copy(this.idea.notes), bpm: this.idea.bpm }; },
  remember(snapshot) { this.history.push(snapshot || this.snapshot()); if (this.history.length > 40) this.history.shift(); this.future = []; },
  replaceNotes(notes, recordHistory) {
    const normalized = music.normalizeNotes(notes);
    if (music.seconds(normalized, this.idea.bpm) > 120) { wx.showToast({ title: '编辑后的旋律最长 2 分钟', icon: 'none' }); return false; }
    if (recordHistory !== false) this.remember();
    this.stop(); this.idea.notes = normalized; this.render(); this.scheduleSave(); return true;
  },
  selectNote(event) { this.selectedId = event.currentTarget.dataset.id; this.render(); },
  selectFromList(event) {
    this.selectNote(event); this.focusSelected();
    wx.pageScrollTo({ selector: '#note-editor', offsetTop: -92 * this.factor, duration: 250 });
  },
  focusSelected() {
    const note = this.data.selected;
    if (!note) return;
    const left = Math.max(0, (note.x - 140) * this.factor);
    const top = Math.max(0, (note.y - this.data.rollHeight / 2) * this.factor);
    this.rollScrollX = left; this.rollScrollY = top;
    this.setData({ rollScrollLeft: left, rollScrollTop: top });
  },
  changeZoom(event) {
    if (this.gesture) return;
    const zoom = music.clamp(this.data.zoom + Number(event.currentTarget.dataset.delta), .5, 2);
    this.stop(); this.setData({ zoom }); this.render(); this.focusSelected();
  },
  toggleExpanded() {
    this.setData({ expanded: !this.data.expanded }); this.render(); this.focusSelected();
  },
  editSelected() {
    this.setData({ expanded: false }); this.render();
    wx.pageScrollTo({ selector: '#note-editor', offsetTop: -92 * this.factor, duration: 250 });
  },
  shiftPitch(event) {
    const delta = Number(event.currentTarget.dataset.delta);
    this.replaceNotes(this.idea.notes.map(n => Object.assign({}, n, n.id === this.selectedId ? { midi: music.clamp(n.midi + delta, 21, 108) } : {})));
  },
  shiftAll(event) {
    const delta = Number(event.currentTarget.dataset.delta);
    if (this.idea.notes.some(n => n.midi + delta < 21 || n.midi + delta > 108)) { wx.showToast({ title: '已经到音域边界了', icon: 'none' }); return; }
    this.replaceNotes(this.idea.notes.map(n => Object.assign({}, n, { midi: n.midi + delta })));
  },
  nudgeStart(event) {
    const note = this.idea.notes.find(n => n.id === this.selectedId);
    if (note) this.replaceNotes(music.moveNote(this.idea.notes, note.id, note.start + Number(event.currentTarget.dataset.delta)));
  },
  startInput(event) {
    const value = Number(event.detail.value), note = this.idea.notes.find(n => n.id === this.selectedId);
    if (!Number.isFinite(value) || value < 1) { wx.showToast({ title: '起始拍从第 1 拍开始', icon: 'none' }); this.render(); return; }
    if (note && Math.abs(note.start - (value - 1)) >= .0005) this.replaceNotes(music.moveNote(this.idea.notes, note.id, value - 1));
  },
  setDuration(event) { this.replaceNotes(music.changeDuration(this.idea.notes, this.selectedId, Number(event.currentTarget.dataset.value))); },
  nudgeDuration(event) {
    const note = this.idea.notes.find(n => n.id === this.selectedId);
    if (note) this.replaceNotes(music.changeDuration(this.idea.notes, this.selectedId, note.duration + Number(event.currentTarget.dataset.delta)));
  },
  durationInput(event) {
    const value = Number(event.detail.value);
    if (!Number.isFinite(value) || value < .125 || value > 32) { wx.showToast({ title: '时值范围为 0.125 到 32 拍', icon: 'none' }); this.render(); return; }
    const note = this.idea.notes.find(n => n.id === this.selectedId);
    if (note && Math.abs(note.duration - value) < .0005) return;
    this.replaceNotes(music.changeDuration(this.idea.notes, this.selectedId, value));
  },
  onNoteTouchStart(event) {
    if (!event.touches || !event.touches.length) return;
    if (!Number.isFinite(event.touches[0].clientX) || !Number.isFinite(event.touches[0].clientY)) return;
    const id = event.currentTarget.dataset.id, note = this.idea.notes.find(n => n.id === id);
    if (!note) return;
    this.selectedId = id; this.stop(); clearTimeout(this.saveTimer);
    this.gesture = { id, mode: event.currentTarget.dataset.mode || 'move', x: event.touches[0].clientX, y: event.touches[0].clientY,
      scrollX: this.rollScrollX || 0, scrollY: this.rollScrollY || 0, high: this.rollHigh, low: this.rollLow,
      snapshot: this.snapshot(), note: copy(note), changed: false, last: 0 };
    this.render();
  },
  onNoteTouchMove(event) {
    if (event.touches && event.touches.length) this.applyGesture(event.touches[0], false);
  },
  applyGesture(touch, force) {
    const g = this.gesture;
    if (!g || !touch || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY)) return;
    const dx = touch.clientX - g.x + (this.rollScrollX || 0) - g.scrollX;
    const dy = touch.clientY - g.y + (this.rollScrollY || 0) - g.scrollY;
    if ((!g.changed && Math.abs(dx) + Math.abs(dy) < 6) || (!force && Date.now() - g.last < 40)) return;
    g.last = Date.now();
    if (!g.axis && g.mode !== 'duration') g.axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'time' : Math.abs(dy) > Math.abs(dx) * 1.5 ? 'pitch' : 'both';
    let start = g.note.start, midi = g.note.midi, duration = g.note.duration;
    if (g.mode === 'duration') duration = music.round(music.clamp(Math.round((g.note.duration + dx / this.factor / this.data.beatWidth) * 8) / 8, .125, 16));
    else {
      start = music.round(Math.max(0, g.note.start + (g.axis === 'pitch' ? 0 : Math.round(dx / this.factor / this.data.beatWidth * 8) / 8)));
      midi = music.clamp(g.note.midi - (g.axis === 'time' ? 0 : Math.round(dy / this.factor / this.data.rowHeight)), 21, 108);
    }
    const current = this.idea.notes.find(n => n.id === g.id);
    if (current.start === start && current.midi === midi && current.duration === duration) return;
    const notes = g.snapshot.notes.map(n => n.id === g.id ? Object.assign({}, n, { start, midi, duration }) : n).sort((a, b) => a.start - b.start);
    if (music.seconds(notes, this.idea.bpm) > 120) return;
    if (!g.changed) { this.remember(g.snapshot); g.changed = true; }
    this.idea.notes = notes; this.dirty = true; this.render();
    this.setData({ saveState: this.data.hasOverlaps ? '重叠，无法保存' : '编辑中…', draftState: '' });
  },
  onNoteTouchEnd(event) {
    if (event && event.changedTouches && event.changedTouches.length) this.applyGesture(event.changedTouches[0], true);
    const changed = this.gesture && this.gesture.changed;
    this.gesture = null;
    this.render();
    if (changed || this.dirty) this.scheduleSave();
  },
  onRollScroll(event) { this.rollScrollX = event.detail.scrollLeft; this.rollScrollY = event.detail.scrollTop; },
  addNote() {
    if (this.idea.notes.length >= 500) { wx.showToast({ title: '一段灵感最多 500 个音符', icon: 'none' }); return; }
    const note = { id: music.uid(), midi: this.data.selected ? this.data.selected.midi : 60, start: music.totalBeats(this.idea.notes), duration: 1, velocity: 85, confidence: 1 };
    this.selectedId = note.id; this.replaceNotes(this.idea.notes.concat([note]));
  },
  deleteNote() {
    if (this.idea.notes.length <= 1) { wx.showToast({ title: '至少保留一个音符', icon: 'none' }); return; }
    this.replaceNotes(this.idea.notes.filter(n => n.id !== this.selectedId));
  },
  quantize() { this.replaceNotes(music.quantize(this.idea.notes, .25)); wx.showToast({ title: '已对齐到 1/4 拍', icon: 'none' }); },
  undo() {
    if (!this.history.length) return;
    this.future.push(this.snapshot()); const state = this.history.pop();
    this.stop(); this.idea.notes = state.notes; this.idea.bpm = state.bpm; this.render(); this.scheduleSave();
  },
  redo() {
    if (!this.future.length) return;
    this.history.push(this.snapshot()); const state = this.future.pop();
    this.stop(); this.idea.notes = state.notes; this.idea.bpm = state.bpm; this.render(); this.scheduleSave();
  },
  changeTitle(event) { this.idea.title = event.detail.value.slice(0, 40); this.scheduleSave(); },
  changeBpm(event) {
    const value = Number(event.detail.value);
    if (!Number.isFinite(value) || value < 40 || value > 240 || music.seconds(this.idea.notes, value) > 120) { wx.showToast({ title: '速度需在 40–240，旋律不超过 2 分钟', icon: 'none' }); this.render(); return; }
    if (value !== this.idea.bpm) { this.remember(); this.stop(); this.idea.bpm = Math.round(value); this.render(); this.scheduleSave(); }
  },
  changeTone(event) { this.stop(); this.setData({ toneIndex: Number(event.detail.value), tone: Number(event.detail.value) === 1 ? 'soft' : 'piano' }); },
  stop() {
    if (this.player && (this.data.playing || this.player.requested)) this.player.stop();
    if (this.alive && (this.data.playing || this.data.playbackMode || this.data.playhead !== 68 || this.data.playTime !== '00:00')) this.setData({ playing: false, playbackMode: '', playhead: 68, playTime: '00:00' });
  },
  async play() {
    if (this.data.playing && this.data.playbackMode === 'melody') { this.stop(); return; }
    this.rollScrollX = 0;
    this.setData({ playing: true, playbackMode: 'melody', rollScrollLeft: 0 });
    try { await this.getPlayer().playNotes(this.idea.notes, this.idea.bpm, this.data.tone); }
    catch (_) { this.stop(); wx.showToast({ title: '生成试听失败，请检查存储空间', icon: 'none' }); }
  },
  playOriginal() {
    if (!this.idea.source) return;
    if (this.data.playing && this.data.playbackMode === 'original') { this.stop(); return; }
    this.getPlayer().playFile(this.idea.source); this.setData({ playing: true, playbackMode: 'original' });
  },
  async previewNote() {
    const note = this.idea.notes.find(n => n.id === this.selectedId);
    if (!note) return;
    this.stop(); this.setData({ playing: true, playbackMode: 'note' });
    try { await this.getPlayer().playNotes([Object.assign({}, note, { start: 0, duration: Math.min(1.5, note.duration) })], this.idea.bpm, this.data.tone); }
    catch (_) { this.stop(); wx.showToast({ title: '音符试听失败', icon: 'none' }); }
  },
  scheduleSave() {
    this.dirty = true;
    this.setData({ saveState: this.data.hasOverlaps ? '重叠，无法保存' : '保存中…', draftState: this.data.hasOverlaps ? '草稿暂存中…' : '' });
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.flushSave(), 450);
  },
  flushSave() {
    clearTimeout(this.saveTimer);
    if (!this.idea) return true;
    if (music.getOverlaps(this.idea.notes).ids.length) {
      this.dirty = true;
      try {
        storage.saveDraft(this.idea);
        if (this.alive) this.setData({ saveState: '重叠，无法保存', draftState: '草稿已暂存，重新进入可继续编辑' });
      } catch (_) { if (this.alive) this.setData({ saveState: '重叠，无法保存', draftState: '草稿暂存失败，请点击右上角重试' }); }
      return false;
    }
    if (!this.dirty) return true;
    try {
      this.idea.title = this.idea.title.trim() || '未命名的灵感';
      this.idea = storage.save(this.idea); this.dirty = false;
      if (this.alive) this.setData({ saveState: '已保存', title: this.idea.title, draftState: '' });
      return true;
    } catch (_) { if (this.alive) this.setData({ saveState: '保存失败，点击重试' }); return false; }
  },
  saveNow() {
    if (!this.flushSave() && this.data.hasOverlaps) wx.showToast({ title: '音符有重叠，调整后才能保存', icon: 'none' });
  },
  async exportMidi() {
    if (this.data.exporting) return;
    if (music.getOverlaps(this.idea.notes).ids.length) {
      this.flushSave(); wx.showToast({ title: '音符有重叠，调整后才能导出', icon: 'none' }); return false;
    }
    this.stop(); this.flushSave(); this.setData({ exporting: true });
    try {
      const { encodeMidi } = require('../../utils/midi');
      const { writeFile } = require('../../utils/audio');
      const buffer = encodeMidi(this.idea.notes, this.idea.bpm);
      this.exportedPath = await writeFile(storage.midiPath(this.idea.id), buffer);
      this.setData({ exportVisible: true, exportedName: (this.idea.title || '灵感旋律').replace(/[\\/:*?"<>|]/g, '_') + '.mid', exportedSize: buffer.byteLength + ' 字节' });
    } catch (_) { wx.showToast({ title: '导出失败，请检查存储空间', icon: 'none' }); }
    finally { if (this.alive) this.setData({ exporting: false }); }
  },
  shareMidi() {
    if (!this.exportedPath) return;
    if (!wx.shareFileMessage || this.data.isDevtools) { wx.showToast({ title: '文件转发请在手机微信中使用', icon: 'none' }); return; }
    wx.shareFileMessage({ filePath: this.exportedPath, fileName: this.data.exportedName,
      success: () => this.setData({ exportVisible: false }), fail: error => { if (!/cancel/i.test(error.errMsg || '')) wx.showToast({ title: '发送失败，文件已保留，可重试', icon: 'none' }); } });
  },
  chooseAudio() {
    if (this.data.audioPreparing || this.data.audioSharing) return;
    const kinds = ['melody'], itemList = ['当前旋律音频（WAV）'];
    if (this.idea.source) { kinds.push('original'); itemList.push('原始哼唱录音（WAV）'); }
    wx.showActionSheet({ itemList, success: result => { const kind = kinds[result.tapIndex]; if (kind) this.prepareAudio(kind); } });
  },
  cancelAudioPreparation() {
    this.audioExportToken = (this.audioExportToken || 0) + 1;
    if (this.data.audioPreparing) {
      if (wx.hideLoading) wx.hideLoading();
      if (this.alive) this.setData({ audioPreparing: false });
    }
  },
  async prepareAudio(kind) {
    if (!this.alive || this.data.audioPreparing || this.data.audioSharing || (kind !== 'melody' && kind !== 'original')) return false;
    if (kind === 'melody' && music.getOverlaps(this.idea.notes).ids.length) {
      wx.showToast({ title: '先解决音符重叠，再分享旋律音频', icon: 'none' }); return false;
    }
    this.stop();
    const token = this.audioExportToken = (this.audioExportToken || 0) + 1;
    this.setData({ audioPreparing: true });
    if (wx.showLoading) wx.showLoading({ title: '正在准备音频', mask: true });
    const { prepareAudioExport, cleanupAudioExport } = require('../../utils/audio-export');
    try {
      const result = await prepareAudioExport({ kind, notes: copy(this.idea.notes), bpm: this.idea.bpm,
        tone: this.data.tone, title: this.idea.title, source: this.idea.source,
        recordingDuration: this.idea.recordingDuration, cachedPreview: this.player && this.player.previewCache,
        isCancelled: () => !this.alive || token !== this.audioExportToken });
      if (!result) return false;
      if (!this.alive || token !== this.audioExportToken) { cleanupAudioExport(result); return false; }
      if (this.audioExport) cleanupAudioExport(this.audioExport);
      this.audioExport = result;
      this.setData({ audioVisible: true, audioInfo: { name: result.fileName, kind: result.kind, bpm: result.bpm,
        duration: result.duration.toFixed(1), size: result.byteLength >= 1048576 ? (result.byteLength / 1048576).toFixed(1) + ' MB' : Math.ceil(result.byteLength / 1024) + ' KB',
        tone: this.data.toneNames[this.data.toneIndex] } });
      return true;
    } catch (error) {
      if (this.alive && token === this.audioExportToken) wx.showModal({ title: '音频准备没有完成', content: error.message || error.errMsg || '请检查存储空间后重试。', showCancel: false });
      return false;
    } finally {
      if (token === this.audioExportToken) {
        if (wx.hideLoading) wx.hideLoading();
        if (this.alive) this.setData({ audioPreparing: false });
      }
    }
  },
  shareAudio() {
    if (!this.audioExport || this.data.audioSharing) return;
    if (!wx.shareFileMessage || this.data.isDevtools) { wx.showToast({ title: '音频文件转发请在手机微信中使用', icon: 'none' }); return; }
    const exported = this.audioExport;
    this.setData({ audioSharing: true });
    try {
      wx.shareFileMessage({ filePath: exported.filePath, fileName: exported.fileName,
        success: () => { if (this.alive) { this.setData({ audioSharing: false }); this.closeAudio(); } },
        fail: error => {
          if (!this.alive) return; this.setData({ audioSharing: false });
          if (!/cancel/i.test(error.errMsg || '')) wx.showToast({ title: '发送失败，音频已保留，可重试', icon: 'none' });
        }
      });
    } catch (_) { this.setData({ audioSharing: false }); wx.showToast({ title: '发送没有完成，请重试', icon: 'none' }); }
  },
  closeAudio() {
    if (this.data.audioSharing) return;
    if (this.audioExport) require('../../utils/audio-export').cleanupAudioExport(this.audioExport);
    this.audioExport = null; this.setData({ audioVisible: false, audioInfo: null });
  },
  closeExport() { this.setData({ exportVisible: false }); }
});
