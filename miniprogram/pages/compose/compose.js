const music = require('../../utils/music');
const storage = require('../../utils/storage');
const { PRESETS, createVariation } = require('../../utils/composition');
const { sourceFingerprint } = require('../../utils/creation-session');
const copy = value => JSON.parse(JSON.stringify(value));

function contour(notes, low, high) {
  const length = music.totalBeats(notes), step = Math.max(1, Math.ceil(notes.length / 80));
  return notes.filter((_, i) => i % step === 0 || i === notes.length - 1).map(n => ({
    x: length ? n.start / length * 600 : 0, y: 12 + (high - n.midi) / Math.max(1, high - low) * 68,
    width: Math.max(3, length ? n.duration / length * 600 : 3)
  }));
}

Page({
  data: { hasSource: false, sources: [], sourceIndex: 0, sourceTitle: '', sourceCount: 0, sourceDuration: '0.0', bpm: 100,
    presets: PRESETS, presetId: 'retrograde', activePreset: null, mode: 'append', gap: 0, gaps: [0, .5, 1, 2, 4],
    transpose: 2, transpositions: [-12, -7, -5, -2, 2, 5, 7, 12], fragmentSize: 4, fragmentSizes: [2, 3, 4, 6, 8],
    repeatCount: 2, repeatCounts: [2, 3, 4], resultCount: 0, resultDuration: '0.0', sourceBars: [], resultBars: [], joinX: 0,
    error: '', playing: false, playback: '', playTime: '00:00', canApplyToSource: false, applying: false, saving: false,
    toneIndex: 0, toneNames: ['木质琴音', '柔和正弦'], anchorName: '' },
  onLoad(options) {
    this.alive = true; this.parentId = options.returnToEditor === '1' ? options.id : null;
    this.channel = this.getOpenerEventChannel ? this.getOpenerEventChannel() : null;
    this.handleResult = result => {
      if (!this.alive) return;
      clearTimeout(this.applyTimer); this.setData({ applying: false });
      if (result.ok) {
        wx.navigateBack({ delta: 1 });
        if (!result.saved) wx.showToast({ title: '已应用，请在编辑页重试保存', icon: 'none' });
      } else wx.showModal({ title: '暂未应用', content: result.message || '请重新打开创作页再试。', showCancel: false });
    };
    if (this.channel && this.channel.on) this.channel.on('compositionResult', this.handleResult);
    if (options.tone === 'soft') this.setData({ toneIndex: 1 });
    this.refreshSources(options.id);
  },
  onHide() { this.stop(); },
  onUnload() {
    this.alive = false; clearTimeout(this.applyTimer); if (this.player) this.player.destroy();
    if (this.channel && this.channel.off) this.channel.off('compositionResult', this.handleResult);
  },
  refreshSources(preferred) {
    const sources = storage.summaryPage(0, 100).items.map(i => ({ id: i.id, title: i.title, noteCount: i.noteCount }));
    this.setData({ sources });
    if (!sources.length) return;
    const index = Math.max(0, sources.findIndex(i => i.id === preferred));
    this.loadSource(sources[index].id, index);
  },
  loadSource(id, index) {
    this.stop();
    const saved = storage.get(id), draft = storage.getDraft(id);
    const source = draft && (!saved || draft.draftUpdatedAt >= saved.updatedAt) ? draft : saved;
    if (!source) { this.source = null; this.candidate = null; this.setData({ hasSource: false, error: '这条灵感已被移除，请重新选择。' }); return; }
    this.source = copy(source);
    this.sourceKey = sourceFingerprint(this.source);
    this.setData({ hasSource: true, sourceIndex: index, sourceTitle: this.source.title, sourceCount: this.source.notes.length,
      sourceDuration: music.seconds(this.source.notes, this.source.bpm).toFixed(1), bpm: this.source.bpm,
      canApplyToSource: this.parentId === id && !!(this.channel && this.channel.emit) });
    this.rebuild();
  },
  chooseSource(event) {
    const index = Number(event.detail.value), source = this.data.sources[index];
    if (source && !this.data.saving && !this.data.applying) this.loadSource(source.id, index);
  },
  useDemo() {
    try { const idea = storage.list().find(i => i.isDemo) || storage.save(music.demo()); this.refreshSources(idea.id); }
    catch (error) { wx.showToast({ title: error.message || '无法创建示例', icon: 'none' }); }
  },
  choosePreset(event) {
    if (this.data.saving || this.data.applying) return;
    const id = event.currentTarget.dataset.id;
    if (PRESETS.some(p => p.id === id)) { this.stop(); this.setData({ presetId: id }); this.rebuild(); }
  },
  chooseMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (mode !== 'append' && mode !== 'replace') return;
    if (this.data.saving || this.data.applying) return;
    this.stop(); this.setData({ mode }); this.rebuild();
  },
  chooseParameter(event) {
    if (this.data.saving || this.data.applying) return;
    const key = event.currentTarget.dataset.key, value = Number(event.currentTarget.dataset.value);
    const allowed = { gap: this.data.gaps, transpose: this.data.transpositions, fragmentSize: this.data.fragmentSizes, repeatCount: this.data.repeatCounts };
    if (allowed[key] && allowed[key].indexOf(value) >= 0) { this.stop(); this.setData({ [key]: value }); this.rebuild(); }
  },
  rebuild() {
    if (!this.source) return;
    const activePreset = PRESETS.find(p => p.id === this.data.presetId);
    try {
      this.candidate = createVariation(this.source.notes, { preset: this.data.presetId, mode: this.data.mode,
        bpm: this.source.bpm, gap: this.data.gap, transpose: this.data.transpose,
        fragmentSize: this.data.fragmentSize, repeatCount: this.data.repeatCount });
      const pitches = this.source.notes.concat(this.candidate.notes).map(n => n.midi), low = Math.min(...pitches), high = Math.max(...pitches);
      this.setData({ activePreset, error: '', resultCount: this.candidate.notes.length,
        resultDuration: music.seconds(this.candidate.notes, this.source.bpm).toFixed(1),
        sourceBars: contour(this.source.notes, low, high), resultBars: contour(this.candidate.notes, low, high),
        joinX: this.data.mode === 'append' ? music.totalBeats(this.source.notes) / music.totalBeats(this.candidate.notes) * 600 : 0,
        anchorName: music.noteName(this.candidate.anchorMidi) });
    } catch (error) {
      this.candidate = null;
      const pitches = this.source.notes.map(n => n.midi);
      this.setData({ activePreset, error: error.message || '暂时无法生成，请换一个预设。', resultCount: 0,
        resultDuration: '0.0', resultBars: [], joinX: 0,
        sourceBars: contour(this.source.notes, Math.min(...pitches), Math.max(...pitches)) });
    }
  },
  getPlayer() {
    if (!this.player) {
      const { Player } = require('../../utils/audio');
      this.player = new Player(() => { if (this.alive) this.setData({ playing: false, playback: '', playTime: '00:00' }); },
        time => { const label = music.timeLabel(time); if (this.alive && label !== this.data.playTime) this.setData({ playTime: label }); },
        () => { if (this.alive) { this.setData({ playing: false, playback: '' }); wx.showToast({ title: '试听失败，请重试', icon: 'none' }); } });
    }
    return this.player;
  },
  stop() {
    if (this.player && (this.data.playing || this.player.requested)) this.player.stop();
    if (this.alive && this.data.playing) this.setData({ playing: false, playback: '', playTime: '00:00' });
  },
  async preview(event) {
    const mode = event.currentTarget.dataset.mode;
    if (this.data.saving || this.data.applying) return;
    if (mode !== 'source' && !this.candidate) return;
    if (this.data.playing && this.data.playback === mode) { this.stop(); return; }
    this.stop(); this.setData({ playing: true, playback: mode, playTime: '00:00' });
    try { await this.getPlayer().playNotes(mode === 'source' ? this.source.notes : this.candidate.notes, this.source.bpm, this.data.toneIndex ? 'soft' : 'piano'); }
    catch (_) { this.stop(); if (this.alive) wx.showToast({ title: '生成试听失败，请重试', icon: 'none' }); }
  },
  changeTone(event) { this.stop(); this.setData({ toneIndex: Number(event.detail.value) === 1 ? 1 : 0 }); },
  applyToSource() {
    if (!this.candidate || !this.data.canApplyToSource || this.data.applying || this.data.saving) return;
    this.stop(); this.setData({ applying: true });
    this.applyTimer = setTimeout(() => {
      if (this.alive && this.data.applying) { this.setData({ applying: false }); wx.showToast({ title: '未收到编辑页回应，请返回后重试', icon: 'none' }); }
    }, 5000);
    this.channel.emit('applyComposition', { sourceId: this.source.id, sourceKey: this.sourceKey, notes: copy(this.candidate.notes) });
  },
  async saveAsNew() {
    if (!this.candidate || this.data.saving || this.data.applying) return;
    if (storage.summaryPage(0, 1).total >= 100) { wx.showToast({ title: '记录本已满，请先整理旧灵感', icon: 'none' }); return; }
    this.stop(); this.setData({ saving: true });
    const id = music.uid(); let sourcePath = null, saved = false;
    const candidate = copy(this.candidate.notes), original = copy(this.source), preset = this.data.activePreset, mode = this.data.mode;
    try {
      if (original.source) sourcePath = await storage.saveRecording(original.source, id);
      if (!this.alive) { if (sourcePath) storage.removeFile(sourcePath); return; }
      storage.save({ id, title: (original.title + ' · ' + preset.title).slice(0, 40), bpm: original.bpm,
        notes: candidate, source: sourcePath, recordingDuration: original.recordingDuration,
        createdAt: Date.now(), updatedAt: Date.now(), isDemo: false,
        creation: { sourceId: original.id, preset: preset.id, mode } });
      saved = true; wx.showToast({ title: '已另存为新灵感', icon: 'success' });
      wx.redirectTo({ url: '/pages/editor/editor?id=' + id });
    } catch (error) {
      if (!saved && sourcePath) storage.removeFile(sourcePath);
      if (this.alive) wx.showModal({ title: '另存没有完成', content: error.message || error.errMsg || '请检查存储空间后重试。', showCancel: false });
    } finally { if (this.alive) this.setData({ saving: false }); }
  },
  backToEditor() {
    if (this.data.saving || this.data.applying) return;
    if (this.data.canApplyToSource) wx.navigateBack({ delta: 1 });
    else if (this.source) wx.redirectTo({ url: '/pages/editor/editor?id=' + this.source.id });
    else wx.navigateBack({ delta: 1 });
  }
});
