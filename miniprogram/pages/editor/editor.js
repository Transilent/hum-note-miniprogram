const music = require('../../utils/music');
const storage = require('../../utils/storage');
const { viewPatch } = require('../../utils/view-patch');
const copy = value => JSON.parse(JSON.stringify(value));
const ROLL_VIEWPORT_WIDTH = 678;
const ROLL_GUTTER = 68;
const ROLL_NOTE_HEIGHT = 36;
const ROLL_OVERSCAN_X = 160;
const ROLL_OVERSCAN_Y = 88;
const LIST_ROW_HEIGHT = 44;
const LIST_VIEWPORT_HEIGHT = 264;
const LIST_WINDOW_SIZE = 48;
const LIST_OVERSCAN = 8;
const MAX_DURATION = 32;
const MIN_DURATION = music.MIN_DURATION;

function noteWindow(notes, scrollLeft, scrollTop, viewportWidth, viewportHeight, factor, pinnedId) {
  const left = scrollLeft / factor - ROLL_OVERSCAN_X;
  const right = scrollLeft / factor + viewportWidth + ROLL_OVERSCAN_X;
  const top = scrollTop / factor - ROLL_OVERSCAN_Y;
  const bottom = scrollTop / factor + viewportHeight + ROLL_OVERSCAN_Y;
  return notes.filter(note => note.id === pinnedId || note.x + note.width >= left && note.x <= right &&
    note.y + ROLL_NOTE_HEIGHT >= top && note.y <= bottom);
}

function noteListWindow(notes, scrollTop) {
  const firstVisible = music.clamp(Math.floor(scrollTop / LIST_ROW_HEIGHT), 0, Math.max(0, notes.length - 1));
  const first = Math.max(0, firstVisible - LIST_OVERSCAN);
  const end = Math.min(notes.length, first + LIST_WINDOW_SIZE);
  return {
    listNotes: notes.slice(first, end),
    listTopPad: first * LIST_ROW_HEIGHT,
    listBottomPad: Math.max(0, (notes.length - end) * LIST_ROW_HEIGHT)
  };
}

Page({
  data: { title: '', bpm: 100, noteCount: 0, selected: null, selectedId: '', tone: 'piano',
    toneNames: ['木质琴音', '柔和正弦'], toneIndex: 0, playing: false, playbackMode: '',
    durationLabel: '0.0', playTime: '00:00', playhead: ROLL_GUTTER, rollWidth: 680, rollHeight: 600,
    listenSource: 'melody', originalProgress: 0, originalSeconds: 0, originalDurationLabel: '',
    rulerScroll: 0, cueVisible: false, canSplit: false, canMerge: false, listVisible: false, toolsVisible: false, shareVisible: false,
    rows: [], ticks: [], canUndo: false, canRedo: false, saveState: '已保存',
    source: null, isDemo: false, isDevtools: false, exportVisible: false, exportedName: '', exportedSize: '',
    exportedBpm: 0, exporting: false, midiSharing: false,
    recognitionLabel: '', recognitionNotice: '',
    hasOverlaps: false, overlapCount: 0, draftState: '', expanded: false, zoom: 1,
    audioPreparing: false, audioVisible: false, audioInfo: null, audioSharing: false,
    beatWidth: 80, rowHeight: 44, rollScrollLeft: 0, rollScrollTop: 0, rollNotes: [], listNotes: [],
    listTopPad: 0, listBottomPad: 0, listScrollTop: 0, playPreparing: false, bpmInput: '100', startInput: '', midiInput: '', durationInput: '' },
  onLoad(options = {}) {
    this.alive = true; this.history = []; this.future = []; this.cueBeat = 0; this.originalCue = 0;
    this.lastOriginalProgressAt = 0;
    let saved, draft;
    try {
      saved = storage.get(options.id);
      if (saved) draft = storage.getDraft(options.id);
    } catch (_) { this.leaveMissingIdea('无法读取本地灵感，请重试'); return; }
    if (!saved) { this.leaveMissingIdea('这条灵感不存在'); return; }
    const restoreDraft = storage.canRestoreDraft(saved, draft);
    this.idea = restoreDraft ? draft : saved;
    this.idea = copy(this.idea);
    this.idea.notes = music.normalizeNotes(this.idea.notes);
    if (!this.idea.notes.length) { this.leaveMissingIdea('这条灵感没有可编辑的音符'); return; }
    this.idea.title = String(this.idea.title || '未命名的灵感');
    this.idea.bpm = music.clamp(Number(this.idea.bpm) || 100, 40, 240);
    this.dirty = restoreDraft;
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.factor = windowInfo.windowWidth / 750;
    this.windowHeight = windowInfo.windowHeight || 700;
    const platform = wx.getDeviceInfo ? wx.getDeviceInfo().platform : wx.getSystemInfoSync().platform;
    this.setData({ isDevtools: platform === 'devtools',
      originalSeconds: Math.max(0, Number(this.idea.recordingDuration) || 0),
      originalDurationLabel: this.idea.recordingDuration > 0 ? music.timeLabel(this.idea.recordingDuration) : '',
      recognitionLabel: this.idea.recognitionEngine === 'swift-f0' ? 'SwiftF0 实验' : this.idea.recognitionEngine === 'yin' ? '标准识别' : '',
      recognitionNotice: this.idea.recognitionFallback ? '实验识别在此设备未能运行，本次已使用标准模式保留旋律。' : '' });
    this.selectedId = this.idea.notes[0] && this.idea.notes[0].id;
    this.render();
    if (restoreDraft) {
      this.setData({ saveState: this.data.hasOverlaps ? '重叠，无法保存' : '待保存', draftState: '草稿已暂存' });
      if (!this.data.hasOverlaps) this.scheduleSave();
    }
  },
  leaveMissingIdea(title) {
    this.idea = null;
    wx.showToast({ title, icon: 'none' });
    this.loadFailureTimer = setTimeout(() => {
      if (this.alive) wx.navigateBack();
    }, 900);
  },
  onShow() { this.openingComposer = false; },
  onHide() { this.cancelAudioPreparation(); this.stop(); this.flushSave(); },
  showRecognitionDiagnostic() {
    const diagnostics = require('../../utils/recognition-diagnostics');
    const report = this.idea && this.idea.recognitionDiagnostic;
    if (!report || !report.failure) {
      wx.showModal({ title: '旧记录未保留诊断', content: '请在首页选择 SwiftF0 实验模式，点击“检查实验识别兼容性”，获取完整设备和错误报告。', showCancel: false });
      return false;
    }
    wx.showModal({ title: '本次实验识别诊断',
      content: diagnostics.explanation(report) + '\n\n' + report.failure.code + ' · ' + report.failure.detail,
      confirmText: '复制报告', cancelText: '关闭',
      success: result => { if (result.confirm) diagnostics.copyReport(wx, report); } });
    return true;
  },
  onUnload() {
    this.cancelAudioPreparation(); this.flushSave(); this.alive = false;
    clearTimeout(this.loadFailureTimer);
    if (this.player) this.player.destroy(); clearTimeout(this.saveTimer); clearTimeout(this.rollWindowTimer); clearTimeout(this.listWindowTimer);
    if (this.audioExport) require('../../utils/audio-export').cleanupAudioExport(this.audioExport);
  },
  openComposer() {
    if (!this.alive || !this.idea || this.openingComposer || this.data.audioPreparing) return false;
    this.stop();
    if (!this.flushSave()) {
      wx.showToast({ title: this.data.hasOverlaps ? '先解决音符重叠，再进入创作' : '请先保存成功再进入创作', icon: 'none' }); return false;
    }
    this.openingComposer = true;
    this.compositionChannel = null;
    const fail = () => {
      this.openingComposer = false;
      if (this.alive) wx.showToast({ title: '暂时无法打开创作页，请重试', icon: 'none' });
    };
    try {
      wx.navigateTo({ url: '/pages/compose/compose?id=' + this.idea.id + '&returnToEditor=1&tone=' + this.data.tone,
        events: { applyComposition: payload => {
          if (this.compositionChannel && this.compositionChannel.emit) {
            this.compositionChannel.emit('compositionResult', this.applyComposition(payload));
          } else if (typeof getCurrentPages === 'function') {
            // Some runtimes deliver the child's event without returning an
            // opener channel. Reply to this editor's active composer directly.
            const stack = getCurrentPages(), composer = stack[stack.length - 1];
            if (stack[stack.length - 2] === this && composer.route === 'pages/compose/compose' &&
                typeof composer.handleResult === 'function') composer.handleResult(this.applyComposition(payload));
          }
        } },
        success: result => { this.compositionChannel = result && result.eventChannel; },
        fail
      });
      return true;
    } catch (_) { fail(); return false; }
  },
  applyComposition(payload) {
    const { sourceFingerprint } = require('../../utils/creation-session');
    if (!this.alive || !this.idea || !payload || payload.sourceId !== this.idea.id || payload.sourceKey !== sourceFingerprint(this.idea))
      return { ok: false, message: '原旋律已变化，请重新打开创作页，避免覆盖新的编辑。' };
    if (!Array.isArray(payload.notes) || !payload.notes.length || payload.notes.length > 500)
      return { ok: false, message: '创作结果需在 1 到 500 个音符以内。' };
    const ids = new Set();
    if (!payload.notes.every(n => {
      if (!n || !n.id || ids.has(String(n.id)) || !Number.isInteger(n.midi) || n.midi < 21 || n.midi > 108 ||
        !Number.isFinite(n.start) || n.start < 0 || !Number.isFinite(n.duration) || n.duration < MIN_DURATION || n.duration > 32) return false;
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
      this.player = new Player(() => { if (this.alive) this.finishPlaybackView(); },
        time => this.updatePlayback(time),
        () => { if (this.alive) { this.finishPlaybackView(); wx.showToast({ title: '试听失败，请检查音量后重试', icon: 'none' }); } },
        () => this.audioStarted());
    }
    return this.player;
  },
  audioStarted() {
    if (this.alive && this.data.playPreparing) this.commitView({ playing: true, playPreparing: false });
  },
  commitView(patch) {
    if (!this.alive) return;
    if (this.rendered) Object.assign(this.rendered, patch);
    this.setData(patch);
  },
  finishPlaybackView() {
    this.playbackToken = (this.playbackToken || 0) + 1;
    this.restoreTransport();
  },
  cursorX(beat) { return ROLL_GUTTER + beat * this.data.beatWidth; },
  activeBeat() {
    if (this.data.playing && this.data.playbackMode === 'melody' && Number.isFinite(this.playingBeat)) return this.playingBeat;
    return this.cueBeat || 0;
  },
  canSplitAt(note, beat) {
    return !!note && this.idea.notes.length < 500 && music.round(beat - note.start) >= MIN_DURATION &&
      music.round(note.start + note.duration - beat) >= MIN_DURATION;
  },
  restoreTransport() {
    const cue = this.cueBeat || 0, seconds = this.data.originalSeconds;
    this.playingBeat = null;
    this.followScrollTarget = null;
    this.lastOriginalProgressAt = 0;
    this.commitView({ playing: false, playPreparing: false, playbackMode: '', playhead: this.cursorX(cue),
      cueVisible: !!cue, canSplit: this.canSplitAt(this.data.selected, cue),
      playTime: music.timeLabel(this.data.listenSource === 'original' ? this.originalCue : cue * 60 / this.idea.bpm),
      originalProgress: seconds > 0 ? Math.round(this.originalCue / seconds * 1000) : 0 });
  },
  updatePlayback(time) {
    if (!this.alive || this.suppressProgress || !this.data.playing || this.data.playbackMode === 'note') return;
    if (this.data.playbackMode === 'original') {
      this.updateOriginalPlayback(time);
      return;
    }
    const beat = this.playingBeat = Math.min(time * this.idea.bpm / 60, this.totalBeats);
    const x = this.cursorX(beat), patch = {}, playhead = Math.round(x * 10) / 10;
    if (playhead !== this.data.playhead) patch.playhead = playhead;
    const label = music.timeLabel(time);
    if (label !== this.data.playTime) patch.playTime = label;
    const canSplit = this.canSplitAt(this.data.selected, beat);
    if (canSplit !== this.data.canSplit) patch.canSplit = canSplit;
    // Follow once per screen. Keep a pending target until native scroll reports back.
    const screen = ROLL_VIEWPORT_WIDTH * this.factor;
    if (x * this.factor > Math.max(this.rollScrollX || 0, this.followScrollTarget || 0) + screen - 30) {
      const target = music.clamp((x - ROLL_GUTTER) * this.factor, 0, (this.data.rollWidth - ROLL_VIEWPORT_WIDTH) * this.factor);
      if (Math.abs(target - this.data.rollScrollLeft) > 1) {
        this.followScrollTarget = target;
        patch.rollScrollLeft = target;
      }
    }
    if (Object.keys(patch).length) this.commitView(patch);
  },
  updateOriginalPlayback(time) {
    const seconds = this.player && this.player.clock && this.player.clock.duration || this.data.originalSeconds;
    const patch = {}, label = music.timeLabel(time);
    if (seconds > 0 && seconds !== this.data.originalSeconds) {
      patch.originalSeconds = seconds;
      patch.originalDurationLabel = music.timeLabel(seconds);
    }
    if (label !== this.data.playTime) patch.playTime = label;
    if (!this.scrubbingOriginal && seconds > 0 && Date.now() - this.lastOriginalProgressAt >= 100) {
      this.lastOriginalProgressAt = Date.now();
      patch.originalProgress = Math.round(music.clamp(time / seconds, 0, 1) * 1000);
    }
    if (Object.keys(patch).length) this.commitView(patch);
  },
  render(options) {
    if (!this.idea) return;
    options = options || {};
    if (Number.isFinite(options.scrollLeft)) this.rollScrollX = options.scrollLeft;
    if (Number.isFinite(options.scrollTop)) this.rollScrollY = options.scrollTop;
    const notes = this.idea.notes, pitches = notes.map(n => n.midi);
    const factor = this.factor || 1;
    if (!notes.some(n => n.id === this.selectedId)) this.selectedId = notes[0] && notes[0].id;
    const beatWidth = 80 * this.data.zoom, rowHeight = 44;
    const low = this.gesture ? this.gesture.low : Math.max(21, Math.min(57, ...pitches) - 2);
    const high = this.gesture ? this.gesture.high : Math.min(108, Math.max(69, ...pitches) + 2);
    this.rollHigh = high; this.rollLow = low;
    const overlaps = options.overlaps || music.getOverlaps(notes), conflictIds = new Set(overlaps.ids);
    this.totalBeats = music.totalBeats(notes);
    this.cueBeat = Math.min(this.cueBeat || 0, this.totalBeats);
    const total = Math.max(8, Math.ceil(this.totalBeats) + 1), gridKey = [low, high, total, beatWidth].join(':');
    if (!this.grid || this.grid.key !== gridKey) {
      const rows = [], ticks = [];
      for (let midi = high; midi >= low; midi--) rows.push({ midi, name: music.noteName(midi), black: [1, 3, 6, 8, 10].indexOf(midi % 12) >= 0, y: (high - midi) * rowHeight });
      for (let i = 0; i < total; i++) ticks.push({ beat: i, label: i + 1, x: ROLL_GUTTER + i * beatWidth, bar: i % 4 === 0 });
      this.grid = { key: gridKey, rows, ticks };
    }
    const { rows, ticks } = this.grid;
    const noteViews = notes.map((n, i) => Object.assign({}, n, { label: music.noteName(n.midi), number: String(i + 1).padStart(2, '0'),
      x: ROLL_GUTTER + n.start * beatWidth, y: (high - n.midi) * rowHeight + 4, width: Math.max(10, n.duration * beatWidth - 2),
      startLabel: (n.start + 1).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''),
      durationLabel: n.duration.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''), uncertain: n.confidence < .8, overlapping: conflictIds.has(n.id), selected: n.id === this.selectedId }));
    let selected = noteViews.find(n => n.id === this.selectedId);
    if (!selected && noteViews.length) { selected = noteViews[0]; this.selectedId = selected.id; }
    if (selected) {
      const before = notes.slice(0, notes.findIndex(n => n.id === selected.id));
      const previousEnd = before.reduce((end, n) => Math.max(end, n.start + n.duration), 0);
      selected = Object.assign({}, selected, { gapBefore: music.round(Math.max(0, selected.start - previousEnd)) });
    }
    const contentHeight = rows.length * rowHeight;
    const rollHeight = this.data.expanded ? Math.max(280, (this.windowHeight - 209) / factor) :
      Math.min(contentHeight, music.clamp(this.windowHeight * .50 / factor, 540, 810));
    let scrollPatch = null;
    if (!this.viewportInitialized && noteViews.length) {
      const centerX = selected ? selected.x + 20 : 68;
      const centerY = selected ? selected.y + ROLL_NOTE_HEIGHT / 2 : contentHeight / 2;
      this.rollScrollX = music.clamp((centerX - 150) * factor, 0, Math.max(0, (Math.max(ROLL_VIEWPORT_WIDTH, 68 + total * beatWidth) - ROLL_VIEWPORT_WIDTH) * factor));
      this.rollScrollY = music.clamp((centerY - rollHeight / 2) * factor, 0, Math.max(0, (contentHeight - rollHeight) * factor));
      this.viewportInitialized = true;
      scrollPatch = { rollScrollLeft: this.rollScrollX, rollScrollTop: this.rollScrollY };
    } else if (Number.isFinite(options.scrollLeft) || Number.isFinite(options.scrollTop)) {
      scrollPatch = {};
      if (Number.isFinite(options.scrollLeft)) scrollPatch.rollScrollLeft = this.rollScrollX;
      if (Number.isFinite(options.scrollTop)) scrollPatch.rollScrollTop = this.rollScrollY;
    }
    const oldLeft = this.rollScrollX || 0, oldTop = this.rollScrollY || 0, oldListTop = this.noteListScrollY || 0;
    const scrollLeft = music.clamp(oldLeft, 0, Math.max(0, (Math.max(ROLL_VIEWPORT_WIDTH, 68 + total * beatWidth) - ROLL_VIEWPORT_WIDTH) * factor));
    const scrollTop = music.clamp(oldTop, 0, Math.max(0, (contentHeight - rollHeight) * factor));
    const listScrollTop = music.clamp(oldListTop, 0, Math.max(0, notes.length * LIST_ROW_HEIGHT - LIST_VIEWPORT_HEIGHT));
    const reset = {};
    // Native scrolling can differ from the last bound property. If the target
    // equals that property, a one-pixel intermediate value forces a real reset.
    if (scrollLeft !== oldLeft) {
      if (this.data.rollScrollLeft === scrollLeft) reset.rollScrollLeft = scrollLeft + 1;
      scrollPatch = Object.assign({}, scrollPatch, { rollScrollLeft: scrollLeft });
    }
    if (scrollTop !== oldTop) {
      if (this.data.rollScrollTop === scrollTop) reset.rollScrollTop = scrollTop + 1;
      scrollPatch = Object.assign({}, scrollPatch, { rollScrollTop: scrollTop });
    }
    if (listScrollTop !== oldListTop && this.data.listScrollTop === listScrollTop) reset.listScrollTop = listScrollTop + 1;
    if (Object.keys(reset).length) this.commitView(reset);
    this.rollScrollX = scrollLeft; this.rollScrollY = scrollTop; this.noteListScrollY = listScrollTop;
    const rollNotes = noteWindow(noteViews, scrollLeft, scrollTop, ROLL_VIEWPORT_WIDTH, rollHeight, factor, this.gesture && this.gesture.id);
    const listWindow = this.data.listVisible ? noteListWindow(noteViews, listScrollTop) : null;
    const status = overlaps.ids.length ? { saveState: '重叠，无法保存' } : this.data.hasOverlaps ? { saveState: '待保存', draftState: '' } : {};
    // Full note views belong to the logic layer. Only the two visible windows
    // cross the WebView bridge; the score itself remains intact in idea.notes.
    this.noteViews = noteViews;
    const next = Object.assign({ title: this.idea.title, bpm: this.idea.bpm, noteCount: notes.length, rollNotes,
      selected: selected || null, selectedId: this.selectedId || '', rows, ticks, beatWidth, rowHeight, rulerScroll: scrollLeft,
      rollWidth: Math.max(ROLL_VIEWPORT_WIDTH, 68 + total * beatWidth), rollContentHeight: contentHeight, rollHeight,
      durationLabel: music.seconds(notes, this.idea.bpm).toFixed(1), source: this.idea.source || null, isDemo: !!this.idea.isDemo,
      canUndo: !!this.history.length, canRedo: !!this.future.length, hasOverlaps: !!overlaps.ids.length, overlapCount: overlaps.ids.length,
      bpmInput: String(this.idea.bpm), startInput: selected ? selected.startLabel : '',
      midiInput: selected ? String(selected.midi) : '', durationInput: selected ? selected.durationLabel : '',
      playhead: ROLL_GUTTER + this.activeBeat() * beatWidth, cueVisible: !!this.cueBeat,
      canSplit: this.canSplitAt(selected, this.activeBeat()), canMerge: !!music.nextSamePitch(notes, this.selectedId),
      playing: this.data.playing, playPreparing: this.data.playPreparing, playbackMode: this.data.playbackMode,
    }, listWindow, { listScrollTop }, scrollPatch, status, options.patch || {});
    const previous = this.rendered;
    const patch = viewPatch(previous, next);
    this.rendered = next;
    if (Object.keys(patch).length) this.setData(patch);
  },
  snapshot() { return { notes: copy(this.idea.notes), bpm: this.idea.bpm }; },
  remember(snapshot) { this.history.push(snapshot || this.snapshot()); if (this.history.length > 40) this.history.shift(); this.future = []; },
  replaceNotes(notes, recordHistory) {
    const normalized = music.normalizeNotes(notes);
    if (music.seconds(normalized, this.idea.bpm) > 120) { wx.showToast({ title: '编辑后的旋律最长 2 分钟', icon: 'none' }); return false; }
    if (recordHistory !== false) this.remember();
    this.stop(); this.idea.notes = normalized;
    this.cueBeat = Math.min(this.cueBeat || 0, music.totalBeats(normalized));
    this.render(); this.scheduleSave(); return true;
  },
  selectNote(event) { this.selectedId = event.currentTarget.dataset.id; this.render(); },
  selectFromList(event) {
    this.closeNoteList();
    this.selectedId = event.currentTarget.dataset.id;
    this.editSelected();
    this.focusSelected();
  },
  openNoteList() {
    const scrollTop = this.noteListScrollY || 0;
    this.commitView(Object.assign({ listVisible: true, listScrollTop: scrollTop }, noteListWindow(this.noteViews, scrollTop)));
  },
  closeNoteList() {
    this.commitView({ listVisible: false, listNotes: [], listTopPad: 0, listBottomPad: 0 });
  },
  openEditorTools() { this.setData({ toolsVisible: true }); },
  closeEditorTools() { if (this.data.toolsVisible) this.setData({ toolsVisible: false }); },
  focusSelected() {
    const note = this.data.selected;
    if (!note) return;
    const factor = this.factor || 1;
    const left = music.clamp((note.x - 140) * factor, 0, Math.max(0, (this.data.rollWidth - ROLL_VIEWPORT_WIDTH) * factor));
    const top = music.clamp((note.y - this.data.rollHeight / 2) * factor, 0, Math.max(0, (this.data.rollContentHeight - this.data.rollHeight) * factor));
    this.rollScrollX = left; this.rollScrollY = top;
    this.render({ scrollLeft: left, scrollTop: top });
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
  setCue(beat) {
    if (!Number.isFinite(beat)) return;
    const next = this.cueBeat = music.round(music.clamp(beat, 0, this.totalBeats));
    const seconds = next * 60 / this.idea.bpm;
    if (this.data.playbackMode === 'melody') {
      if (this.data.playing && this.player && this.player.seek(seconds)) this.playingBeat = next;
      else this.stop();
    }
    const patch = { playhead: this.cursorX(next), cueVisible: true, canSplit: this.canSplitAt(this.data.selected, next) };
    if (this.data.listenSource === 'melody') patch.playTime = music.timeLabel(seconds);
    this.commitView(patch);
  },
  seekFromRuler(event) {
    const x = event && event.detail && Number(event.detail.x);
    if (!Number.isFinite(x) || !wx.createSelectorQuery) return;
    wx.createSelectorQuery().select('#roll-ruler').boundingClientRect(rect => {
      if (!rect || !this.alive) return;
      this.setCue(((x - rect.left + (this.rollScrollX || 0)) / this.factor - ROLL_GUTTER) / this.data.beatWidth);
    }).exec();
  },
  splitSelected() {
    const result = music.splitNote(this.idea.notes, this.selectedId, this.activeBeat());
    if (!result) { wx.showToast({ title: '点时间尺，把播放线放在音符内', icon: 'none' }); return false; }
    return this.replaceNotes(result);
  },
  mergeSelected() {
    const pair = music.nextSamePitch(this.idea.notes, this.selectedId);
    if (!pair) return false;
    const apply = () => {
      if (!this.alive) return false;
      const result = music.mergeNotes(this.idea.notes, pair.first.id, pair.second.id);
      if (!result) return false;
      return this.replaceNotes(result);
    };
    if (pair.gap > 0) {
      wx.showModal({ title: '合并两个同音？', content: '中间的 ' + pair.gap + ' 拍休止会并入时值。', confirmText: '合并',
        success: res => { if (res.confirm) apply(); } });
      return true;
    }
    return apply();
  },
  shiftPitch(event) {
    const delta = Number(event.currentTarget.dataset.delta);
    this.replaceNotes(this.idea.notes.map(n => Object.assign({}, n, n.id === this.selectedId ? { midi: music.clamp(n.midi + delta, 21, 108) } : {})));
  },
  shiftAll(event) {
    this.closeEditorTools();
    const delta = Number(event.currentTarget.dataset.delta);
    if (this.idea.notes.some(n => n.midi + delta < 21 || n.midi + delta > 108)) { wx.showToast({ title: '已经到音域边界了', icon: 'none' }); return; }
    this.replaceNotes(this.idea.notes.map(n => Object.assign({}, n, { midi: n.midi + delta })));
  },
  nudgeStart(event) {
    const note = this.idea.notes.find(n => n.id === this.selectedId);
    if (note) this.replaceNotes(music.moveNote(this.idea.notes, note.id, note.start + Number(event.currentTarget.dataset.delta)));
  },
  restoreNumericInputs() {
    if (!this.alive) return;
    const selected = this.data.selected;
    this.commitView({ bpmInput: String(this.idea.bpm), startInput: selected ? selected.startLabel : '',
      midiInput: selected ? String(selected.midi) : '', durationInput: selected ? selected.durationLabel : '' });
  },
  onBpmDraftInput(event) { this.commitView({ bpmInput: String(event.detail.value) }); },
  onStartDraftInput(event) { this.commitView({ startInput: String(event.detail.value) }); },
  onMidiDraftInput(event) { this.commitView({ midiInput: String(event.detail.value) }); },
  onDurationDraftInput(event) { this.commitView({ durationInput: String(event.detail.value) }); },
  pitchInput(event) {
    const midi = Number(event.detail.value), note = this.idea.notes.find(n => n.id === this.selectedId);
    if (!Number.isInteger(midi) || midi < 21 || midi > 108) {
      wx.showToast({ title: 'MIDI 音高范围为 21 到 108', icon: 'none' });
      this.restoreNumericInputs();
      return;
    }
    if (note && note.midi !== midi) this.replaceNotes(music.moveNote(this.idea.notes, note.id, note.start, midi));
    else this.restoreNumericInputs();
  },
  startInput(event) {
    const value = Number(event.detail.value), note = this.idea.notes.find(n => n.id === this.selectedId);
    if (!String(event.detail.value).trim() || !Number.isFinite(value) || value < 1) {
      wx.showToast({ title: '起始拍需是不小于 1 的数字', icon: 'none' }); this.restoreNumericInputs(); return;
    }
    if (!note || music.round(value - 1) === note.start) { this.restoreNumericInputs(); return; }
    if (!this.replaceNotes(music.moveNote(this.idea.notes, note.id, value - 1))) this.restoreNumericInputs();
  },
  setDuration(event) {
    const value = Number(event.currentTarget.dataset.value);
    if (!Number.isFinite(value) || value < MIN_DURATION || value > MAX_DURATION) {
      wx.showToast({ title: '时值范围为 0.0625 到 32 拍', icon: 'none' }); this.restoreNumericInputs(); return;
    }
    this.replaceNotes(music.changeDuration(this.idea.notes, this.selectedId, value));
  },
  nudgeDuration(event) {
    const note = this.idea.notes.find(n => n.id === this.selectedId);
    if (!note) return;
    const value = music.round(note.duration + Number(event.currentTarget.dataset.delta));
    if (value < MIN_DURATION || value > MAX_DURATION) {
      wx.showToast({ title: '时值范围为 0.0625 到 32 拍', icon: 'none' }); this.restoreNumericInputs(); return;
    }
    this.replaceNotes(music.changeDuration(this.idea.notes, this.selectedId, value));
  },
  durationInput(event) {
    const value = Number(event.detail.value);
    if (!String(event.detail.value).trim() || !Number.isFinite(value) || value < MIN_DURATION || value > MAX_DURATION) {
      wx.showToast({ title: '时值范围为 0.0625 到 32 拍', icon: 'none' }); this.restoreNumericInputs(); return;
    }
    const note = this.idea.notes.find(n => n.id === this.selectedId);
    if (!note || music.round(value) === note.duration) { this.restoreNumericInputs(); return; }
    if (!this.replaceNotes(music.changeDuration(this.idea.notes, this.selectedId, value))) this.restoreNumericInputs();
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
    if ((!g.changed && Math.abs(dx) + Math.abs(dy) < 6) || (!force && Date.now() - g.last < 32)) return;
    g.last = Date.now();
    if (!g.axis && g.mode !== 'duration') g.axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'time' : Math.abs(dy) > Math.abs(dx) * 1.5 ? 'pitch' : 'both';
    let start = g.note.start, midi = g.note.midi, duration = g.note.duration;
    if (g.mode === 'duration') duration = music.round(music.clamp(Math.round((g.note.duration + dx / this.factor / this.data.beatWidth) * 8) / 8, MIN_DURATION, MAX_DURATION));
    else {
      start = music.round(Math.max(0, g.note.start + (g.axis === 'pitch' ? 0 : Math.round(dx / this.factor / this.data.beatWidth * 8) / 8)));
      midi = music.clamp(g.note.midi - (g.axis === 'time' ? 0 : Math.round(dy / this.factor / this.data.rowHeight)), 21, 108);
    }
    const current = this.idea.notes.find(n => n.id === g.id);
    if (current.start === start && current.midi === midi && current.duration === duration) return;
    const notes = g.snapshot.notes.map(n => n.id === g.id ? Object.assign({}, n, { start, midi, duration }) : n).sort((a, b) => a.start - b.start);
    if (music.seconds(notes, this.idea.bpm) > 120) return;
    if (!g.changed) { this.remember(g.snapshot); g.changed = true; }
    this.idea.notes = notes; this.dirty = true;
    const overlaps = music.getOverlaps(notes);
    this.render({ overlaps, patch: { saveState: overlaps.ids.length ? '重叠，无法保存' : '编辑中…', draftState: '' } });
  },
  onNoteTouchEnd(event) {
    if (event && event.changedTouches && event.changedTouches.length) this.applyGesture(event.changedTouches[0], true);
    const changed = this.gesture && this.gesture.changed;
    this.gesture = null;
    this.render();
    if (changed || this.dirty) this.scheduleSave();
  },
  refreshRollWindow() {
    if (!this.alive || !this.rendered || !this.noteViews) return;
    const nextRollNotes = noteWindow(this.noteViews, this.rollScrollX || 0, this.rollScrollY || 0,
      ROLL_VIEWPORT_WIDTH, this.rendered.rollHeight, this.factor || 1, this.gesture && this.gesture.id);
    const next = Object.assign({}, this.rendered, { rollNotes: nextRollNotes, rulerScroll: this.rollScrollX || 0 });
    const previous = this.rendered, patch = viewPatch(previous, next);
    this.rendered = next;
    if (Object.keys(patch).length) this.setData(patch);
  },
  refreshListWindow() {
    if (!this.alive || !this.data.listVisible || !this.rendered || !this.noteViews) return;
    const next = Object.assign({}, this.rendered, noteListWindow(this.noteViews, this.noteListScrollY || 0));
    const previous = this.rendered, patch = viewPatch(previous, next);
    this.rendered = next;
    if (Object.keys(patch).length) this.setData(patch);
  },
  onRollScroll(event) {
    this.rollScrollX = event.detail.scrollLeft; this.rollScrollY = event.detail.scrollTop;
    if (this.followScrollTarget != null && Math.abs(this.followScrollTarget - this.rollScrollX) < 2) this.followScrollTarget = null;
    // Refresh during a continuous fling, rather than waiting for it to stop.
    if (this.rollWindowTimer == null)
      this.rollWindowTimer = setTimeout(() => { this.rollWindowTimer = null; this.refreshRollWindow(); }, 32);
  },
  onNoteListScroll(event) {
    this.noteListScrollY = event.detail.scrollTop;
    if (this.listWindowTimer == null)
      this.listWindowTimer = setTimeout(() => { this.listWindowTimer = null; this.refreshListWindow(); }, 32);
  },
  addNote() {
    this.closeEditorTools();
    if (this.idea.notes.length >= 500) { wx.showToast({ title: '一段灵感最多 500 个音符', icon: 'none' }); return; }
    const note = { id: music.uid(), midi: this.data.selected ? this.data.selected.midi : 60, start: music.totalBeats(this.idea.notes), duration: 1, velocity: 85, confidence: 1 };
    this.selectedId = note.id; this.replaceNotes(this.idea.notes.concat([note]));
  },
  deleteNote() {
    this.closeEditorTools();
    if (this.idea.notes.length <= 1) { wx.showToast({ title: '至少保留一个音符', icon: 'none' }); return; }
    this.replaceNotes(this.idea.notes.filter(n => n.id !== this.selectedId));
  },
  quantize() {
    this.closeEditorTools();
    if (this.replaceNotes(music.quantize(this.idea.notes, .25))) wx.showToast({ title: '已对齐到 1/4 拍', icon: 'none' });
  },
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
    const value = Number(event.detail.value), bpm = Math.round(value);
    if (!String(event.detail.value).trim() || !Number.isFinite(value) || value < 40 || value > 240 || music.seconds(this.idea.notes, bpm) > 120) {
      wx.showToast({ title: '速度需在 40–240，旋律不超过 2 分钟', icon: 'none' }); this.restoreNumericInputs(); return;
    }
    if (bpm !== this.idea.bpm) { this.remember(); this.stop(); this.idea.bpm = bpm; this.render(); this.scheduleSave(); }
    else this.restoreNumericInputs();
  },
  changeTone(event) { this.stop(); this.setData({ toneIndex: Number(event.detail.value), tone: Number(event.detail.value) === 1 ? 'soft' : 'piano' }); },
  changeListenSource(event) {
    const source = event.currentTarget.dataset.source;
    if ((source !== 'melody' && source !== 'original') || source === this.data.listenSource ||
        (source === 'original' && !this.idea.source)) return;
    this.stop();
    this.commitView({ listenSource: source });
    this.restoreTransport();
  },
  playCurrent() { return this.data.listenSource === 'original' ? this.playOriginal() : this.play(); },
  scrubOriginal() { this.scrubbingOriginal = true; },
  seekOriginal(event) {
    this.scrubbingOriginal = false;
    const seconds = this.data.originalSeconds, value = Number(event.detail.value);
    if (!(seconds > 0) || !Number.isFinite(value) || this.data.listenSource !== 'original') return;
    this.originalCue = Math.min(seconds * music.clamp(value, 0, 1000) / 1000, Math.max(0, seconds - .02));
    this.commitView({ originalProgress: Math.round(this.originalCue / seconds * 1000), playTime: music.timeLabel(this.originalCue) });
    if (this.data.playbackMode === 'original' && (this.data.playPreparing || this.data.playing) &&
        (!this.data.playing || !this.getPlayer().seek(this.originalCue))) {
      this.stop();
      this.playOriginal();
    }
  },
  stop() {
    this.playbackToken = (this.playbackToken || 0) + 1;
    this.scrubbingOriginal = false;
    this.suppressProgress = true;
    if (this.player && (this.data.playing || this.data.playPreparing || this.data.playbackMode || this.player.requested)) this.player.stop();
    this.suppressProgress = false;
    if (this.alive && this.idea && (this.data.playing || this.data.playPreparing || this.data.playbackMode)) {
      this.restoreTransport();
    }
  },
  resetRollToStart() {
    if ((this.rollScrollX || 0) > 0 && Math.abs(this.data.rollScrollLeft || 0) < .5) this.commitView({ rollScrollLeft: 1 });
    this.rollScrollX = 0;
  },
  async play() {
    if (!this.alive) return false;
    if (this.data.playPreparing && this.data.playbackMode === 'melody') { this.stop(); return false; }
    if (this.data.playing && this.data.playbackMode === 'melody') { this.stop(); return false; }
    this.stop();
    const token = this.playbackToken;
    const cue = this.cueBeat >= this.totalBeats ? 0 : this.cueBeat;
    const start = cue * 60 / this.idea.bpm;
    if (!cue) this.resetRollToStart();
    this.render({ scrollLeft: cue ? this.rollScrollX : 0, patch: {
      playing: false, playPreparing: true, playbackMode: 'melody', playhead: this.cursorX(cue), playTime: music.timeLabel(start)
    } });
    try {
      const started = await this.getPlayer().playNotes(this.idea.notes, this.idea.bpm, this.data.tone, start);
      if (!this.alive || token !== this.playbackToken) return false;
      if (!started) { this.finishPlaybackView(); return false; }
      return true;
    } catch (_) {
      if (this.alive && token === this.playbackToken) {
        this.finishPlaybackView();
        wx.showToast({ title: '生成试听失败，请检查存储空间', icon: 'none' });
      }
      return false;
    }
  },
  playOriginal() {
    if (!this.alive || !this.idea.source) return false;
    if ((this.data.playing || this.data.playPreparing) && this.data.playbackMode === 'original') { this.stop(); return false; }
    this.stop();
    this.commitView({ playing: false, playPreparing: true, playbackMode: 'original', playTime: music.timeLabel(this.originalCue) });
    return this.getPlayer().playFile(this.idea.source, this.originalCue, this.data.originalSeconds);
  },
  async previewNote() {
    const note = this.idea.notes.find(n => n.id === this.selectedId);
    if (!note || !this.alive) return false;
    if ((this.data.playPreparing || this.data.playing) && this.data.playbackMode === 'note') { this.stop(); return false; }
    this.stop();
    const token = this.playbackToken;
    this.commitView({ playing: false, playPreparing: true, playbackMode: 'note' });
    try {
      const started = await this.getPlayer().playNotes([Object.assign({}, note, { start: 0, duration: Math.min(1.5, note.duration) })], this.idea.bpm, this.data.tone);
      if (!this.alive || token !== this.playbackToken) return false;
      if (!started) { this.finishPlaybackView(); return false; }
      return true;
    } catch (_) {
      if (this.alive && token === this.playbackToken) { this.finishPlaybackView(); wx.showToast({ title: '音符试听失败', icon: 'none' }); }
      return false;
    }
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
      } catch (_) { if (this.alive) this.setData({ saveState: '重叠，无法保存', draftState: '草稿暂存失败，请点保存状态重试' }); }
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
  openShareMenu() {
    if (this.data.exporting || this.data.midiSharing || this.data.audioPreparing || this.data.audioSharing) return;
    this.setData({ shareVisible: true });
  },
  closeShareMenu() { this.setData({ shareVisible: false }); },
  shareFormat(event) {
    const kind = event.currentTarget.dataset.kind;
    this.closeShareMenu();
    if (kind === 'midi') return this.exportMidi();
    return this.prepareAudio(kind);
  },
  async exportMidi() {
    if (!this.alive || !this.idea || this.data.exporting || this.data.midiSharing || this.data.audioPreparing || this.data.audioSharing) return false;
    if (music.getOverlaps(this.idea.notes).ids.length) {
      this.flushSave(); wx.showToast({ title: '音符有重叠，调整后才能导出', icon: 'none' }); return false;
    }
    this.stop(); this.flushSave(); this.setData({ exporting: true });
    try {
      const { encodeMidi } = require('../../utils/midi');
      const { writeFile } = require('../../utils/audio');
      const { notes, bpm, title, id } = this.idea;
      const buffer = encodeMidi(notes, bpm);
      const name = (title || '灵感旋律').replace(/[\\/:*?"<>|]/g, '_') + '.mid';
      const path = await writeFile(storage.midiPath(id), buffer);
      if (!this.alive) return false;
      this.exportedPath = path;
      this.setData({ exportVisible: true, exportedName: name, exportedBpm: bpm, exportedSize: buffer.byteLength + ' 字节' });
      return true;
    } catch (_) {
      if (this.alive) wx.showToast({ title: '导出失败，请检查存储空间', icon: 'none' });
      return false;
    }
    finally { if (this.alive) this.setData({ exporting: false }); }
  },
  shareMidi() {
    if (!this.alive || !this.exportedPath || !this.data.exportVisible || this.data.midiSharing) return false;
    if (!wx.shareFileMessage || this.data.isDevtools) { wx.showToast({ title: '文件转发请在手机微信中使用', icon: 'none' }); return; }
    this.setData({ midiSharing: true });
    const fail = error => {
      if (!this.alive) return;
      this.setData({ midiSharing: false });
      if (!/cancel/i.test(error && error.errMsg || '')) wx.showToast({ title: '发送失败，文件已保留，可重试', icon: 'none' });
    };
    try {
      wx.shareFileMessage({ filePath: this.exportedPath, fileName: this.data.exportedName,
        success: () => { if (this.alive) this.setData({ exportVisible: false, midiSharing: false }); }, fail });
      return true;
    } catch (error) { fail(error); return false; }
  },
  cancelAudioPreparation() {
    this.audioExportToken = (this.audioExportToken || 0) + 1;
    if (this.data.audioPreparing) {
      if (wx.hideLoading) wx.hideLoading();
      if (this.alive) this.setData({ audioPreparing: false });
    }
  },
  async prepareAudio(kind) {
    if (!this.alive || this.data.exporting || this.data.midiSharing || this.data.audioPreparing ||
        this.data.audioSharing || (kind !== 'melody' && kind !== 'original')) return false;
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
          if (!/cancel/i.test(error && error.errMsg || '')) wx.showToast({ title: '发送失败，音频已保留，可重试', icon: 'none' });
        }
      });
    } catch (_) { this.setData({ audioSharing: false }); wx.showToast({ title: '发送没有完成，请重试', icon: 'none' }); }
  },
  closeAudio() {
    if (this.data.audioSharing) return;
    if (this.audioExport) require('../../utils/audio-export').cleanupAudioExport(this.audioExport);
    this.audioExport = null; this.setData({ audioVisible: false, audioInfo: null });
  },
  closeExport() { if (!this.data.midiSharing) this.setData({ exportVisible: false }); }
});
