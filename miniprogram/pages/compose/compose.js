const music = require('../../utils/music');
const storage = require('../../utils/storage');
const { PRESETS, createVariation } = require('../../utils/composition');
const { sourceFingerprint } = require('../../utils/creation-session');
const copy = value => JSON.parse(JSON.stringify(value));
const COMMON_PRESETS = new Set(['repeat', 'retrograde', 'inversion', 'transpose']);

function contour(notes, low, high, length) {
  const step = Math.max(1, Math.ceil(notes.length / 80));
  return notes.filter((_, i) => i % step === 0 || i === notes.length - 1).map(n => ({
    id: n.id, x: length ? n.start / length * 100 : 0, y: 17 + (high - n.midi) / Math.max(1, high - low) * 71,
    width: Math.max(.4, length ? n.duration / length * 100 : 0)
  }));
}

Page({
  data: { hasSource: false, sources: [], sourceIndex: 0, sourceTitle: '', sourceCount: 0, sourceDuration: '0.0', bpm: 100,
    presets: PRESETS.map(preset => Object.assign({ common: COMMON_PRESETS.has(preset.id) }, preset)),
    morePresets: false, presetId: 'retrograde', activePreset: PRESETS[1], mode: 'append', gap: 0, gaps: [0, .5, 1, 2, 4],
    transpose: 2, transpositions: [-12, -7, -5, -2, 2, 5, 7, 12], fragmentSize: 4, fragmentSizes: [2, 3, 4, 6, 8],
    repeatCount: 2, repeatCounts: [2, 3, 4], resultCount: 0, resultDuration: '0.0', sourceBars: [], resultBars: [], joinX: 0,
    error: '', playing: false, playPreparing: false, playback: '', playTime: '00:00', canApplyToSource: false, applying: false, saving: false,
    creatingDemo: false, toneIndex: 0, toneNames: ['木质琴音', '柔和正弦'], anchorName: '' },
  onLoad(options) {
    options = options || {};
    this.alive = true; this.previewSeq = 0; this.saveSeq = 0; this.leaving = false;
    this.parentId = options.returnToEditor === '1' ? options.id : null;
    this.channel = this.getOpenerEventChannel ? this.getOpenerEventChannel() : null;
    this.handleResult = result => {
      if (!this.alive || this.leaving) return;
      clearTimeout(this.applyTimer);
      this.setData({ applying: false });
      if (result && result.ok) {
        this.leaving = true;
        wx.navigateBack({ delta: 1 });
        if (!result.saved) wx.showToast({ title: '已应用，请在编辑页重试保存', icon: 'none' });
      } else {
        wx.showModal({ title: '暂未应用', content: result && result.message || '请重新打开创作页再试。', showCancel: false });
      }
    };
    if (this.channel && this.channel.on) this.channel.on('compositionResult', this.handleResult);
    if (options.tone === 'soft') this.setData({ toneIndex: 1 });
    this.refreshSources(options.id);
  },
  onShow() { this.leaving = false; },
  onHide() { this.stop(); },
  onUnload() {
    this.alive = false;
    this.previewSeq++;
    this.saveSeq++;
    clearTimeout(this.applyTimer);
    this.stop();
    if (this.player) this.player.destroy();
    if (this.channel && this.channel.off) this.channel.off('compositionResult', this.handleResult);
  },
  refreshSources(preferred) {
    let sources;
    try {
      sources = storage.summaryPage(0, 100).items.filter(i => i.noteCount > 0)
        .map(i => ({ id: i.id, title: i.title, noteCount: i.noteCount }));
    } catch (_) {
      this.setData({ error: '暂时无法读取灵感列表，请返回后重试。' });
      return false;
    }
    if (!sources.length) {
      this.source = null; this.candidate = null; this.sourceKey = null;
      this.setData({ sources: [], hasSource: false, sourceIndex: 0, sourceTitle: '', sourceCount: 0,
        sourceDuration: '0.0', canApplyToSource: false, error: '', resultCount: 0, resultDuration: '0.0',
        sourceBars: [], resultBars: [], joinX: 0 });
      return false;
    }
    const index = Math.max(0, sources.findIndex(i => i.id === preferred));
    return this.loadSource(sources[index].id, index, sources);
  },
  loadSource(id, index, sources) {
    this.stop();
    let source;
    try {
      const saved = storage.get(id), draft = saved && storage.getDraft(id);
      source = storage.canRestoreDraft(saved, draft) ? draft : saved;
    } catch (_) {
      wx.showToast({ title: '暂时无法读取这条灵感，请重试', icon: 'none' });
      return false;
    }
    if (!source) {
      this.source = null; this.candidate = null; this.sourceKey = null;
      this.setData({ sources: sources || this.data.sources, hasSource: false, canApplyToSource: false,
        error: '这条灵感已被移除，请重新选择。' });
      return false;
    }
    this.source = copy(source);
    this.source.notes = music.normalizeNotes(this.source.notes);
    this.sourceKey = sourceFingerprint(this.source);
    return this.rebuild({
      sources: sources || this.data.sources,
      hasSource: true,
      sourceIndex: index,
      sourceTitle: this.source.title,
      sourceCount: this.source.notes.length,
      sourceDuration: music.seconds(this.source.notes, this.source.bpm).toFixed(1),
      bpm: this.source.bpm,
      canApplyToSource: this.parentId === id && !!(this.channel && this.channel.emit)
    });
  },
  chooseSource(event) {
    const raw = event && event.detail && event.detail.value;
    const index = Number(raw);
    const source = Number.isInteger(index) && index >= 0 ? this.data.sources[index] : null;
    if (!source || raw === '' || raw == null || this.data.saving || this.data.applying) return false;
    if (this.source && this.source.id === source.id) return true;
    return this.loadSource(source.id, index, this.data.sources);
  },
  useDemo() {
    if (this.data.creatingDemo || this.data.saving || this.data.applying || this.data.hasSource) return false;
    this.setData({ creatingDemo: true });
    try {
      const summary = storage.summaryPage(0, 100).items.find(i => i.isDemo);
      const id = summary ? summary.id : storage.save(music.demo()).id;
      this.refreshSources(id);
      return this.data.hasSource;
    } catch (error) {
      if (this.alive) wx.showToast({ title: error.message || '无法创建示例', icon: 'none' });
      return false;
    } finally {
      if (this.alive) this.setData({ creatingDemo: false });
    }
  },
  choosePreset(event) {
    if (this.data.saving || this.data.applying) return false;
    const id = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
    if (!PRESETS.some(p => p.id === id)) return false;
    if (this.data.presetId === id) return true;
    this.stop();
    return this.rebuild({ presetId: id });
  },
  togglePresets() { this.setData({ morePresets: !this.data.morePresets }); },
  chooseMode(event) {
    const mode = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.mode;
    if (mode !== 'append' && mode !== 'replace') return false;
    if (this.data.saving || this.data.applying || this.data.mode === mode) return this.data.mode === mode;
    this.stop();
    return this.rebuild({ mode });
  },
  chooseParameter(event) {
    if (this.data.saving || this.data.applying) return false;
    const dataset = event && event.currentTarget && event.currentTarget.dataset;
    if (!dataset || dataset.value === '' || dataset.value == null) return false;
    const key = dataset.key, value = Number(dataset.value);
    const allowed = { gap: this.data.gaps, transpose: this.data.transpositions, fragmentSize: this.data.fragmentSizes, repeatCount: this.data.repeatCounts };
    if (!allowed[key] || allowed[key].indexOf(value) < 0) return false;
    if (this.data[key] === value) return true;
    this.stop();
    return this.rebuild({ [key]: value });
  },
  rebuild(overrides) {
    const patch = overrides || {};
    if (!this.source) {
      this.setData(patch);
      return false;
    }
    const next = Object.assign({}, this.data, patch);
    const activePreset = PRESETS.find(p => p.id === next.presetId);
    try {
      const candidate = createVariation(this.source.notes, { preset: next.presetId, mode: next.mode,
        bpm: this.source.bpm, gap: next.gap, transpose: next.transpose,
        fragmentSize: next.fragmentSize, repeatCount: next.repeatCount });
      const pitches = this.source.notes.concat(candidate.notes).map(n => n.midi);
      const low = Math.min(...pitches), high = Math.max(...pitches);
      const originalLength = music.totalBeats(this.source.notes);
      const length = Math.max(originalLength, music.totalBeats(candidate.notes));
      this.candidate = candidate;
      this.setData(Object.assign({}, patch, {
        activePreset,
        error: '',
        resultCount: candidate.notes.length,
        resultDuration: music.seconds(candidate.notes, this.source.bpm).toFixed(1),
        sourceBars: contour(this.source.notes, low, high, length),
        resultBars: contour(candidate.notes, low, high, length),
        joinX: next.mode === 'append' ? originalLength / length * 100 : 0,
        anchorName: music.noteName(candidate.anchorMidi)
      }));
      return true;
    } catch (error) {
      this.candidate = null;
      const pitches = this.source.notes.map(n => n.midi);
      this.setData(Object.assign({}, patch, {
        activePreset,
        error: error.message || '暂时无法生成，请换一个预设。',
        resultCount: 0,
        resultDuration: '0.0',
        resultBars: [],
        joinX: 0,
        sourceBars: contour(this.source.notes, Math.min(...pitches), Math.max(...pitches), music.totalBeats(this.source.notes))
      }));
      return false;
    }
  },
  getPlayer() {
    if (!this.player) {
      const { Player } = require('../../utils/audio');
      this.player = new Player(() => { if (this.alive) this.setData({ playing: false, playPreparing: false, playback: '', playTime: '00:00' }); },
        time => { const label = music.timeLabel(time); if (this.alive && label !== this.data.playTime) this.setData({ playTime: label }); },
        () => { if (this.alive) { this.setData({ playing: false, playPreparing: false, playback: '' }); wx.showToast({ title: '试听失败，请重试', icon: 'none' }); } },
        () => this.audioStarted());
    }
    return this.player;
  },
  audioStarted() {
    if (this.alive && this.data.playPreparing) this.setData({ playing: true, playPreparing: false });
  },
  stop() {
    this.previewSeq = (this.previewSeq || 0) + 1;
    if (this.player && (this.data.playing || this.data.playPreparing || this.player.requested)) this.player.stop();
    if (this.alive && (this.data.playing || this.data.playPreparing)) this.setData({ playing: false, playPreparing: false, playback: '', playTime: '00:00' });
  },
  async preview(event) {
    const mode = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.mode;
    if (mode !== 'source' && mode !== 'result') return false;
    if (this.data.saving || this.data.applying) return false;
    if (mode === 'result' && !this.candidate) return false;
    if ((this.data.playing || this.data.playPreparing) && this.data.playback === mode) { this.stop(); return false; }
    this.stop();
    const attempt = this.previewSeq;
    this.setData({ playing: false, playPreparing: true, playback: mode, playTime: '00:00' });
    try {
      const started = await this.getPlayer().playNotes(mode === 'source' ? this.source.notes : this.candidate.notes,
        this.source.bpm, this.data.toneIndex ? 'soft' : 'piano');
      if (!this.alive || attempt !== this.previewSeq) return false;
      if (!started) this.setData({ playing: false, playPreparing: false, playback: '', playTime: '00:00' });
      return !!started;
    } catch (_) {
      if (!this.alive || attempt !== this.previewSeq) return false;
      this.stop();
      wx.showToast({ title: '生成试听失败，请重试', icon: 'none' });
      return false;
    }
  },
  changeTone(event) {
    const raw = event && event.detail && event.detail.value;
    const index = Number(raw);
    if (raw === '' || raw == null || (index !== 0 && index !== 1)) return false;
    if (this.data.toneIndex === index) return true;
    this.stop();
    this.setData({ toneIndex: index });
    return true;
  },
  applyToSource() {
    if (!this.candidate || !this.data.canApplyToSource || this.data.applying || this.data.saving) return false;
    this.stop();
    this.setData({ applying: true });
    this.applyTimer = setTimeout(() => {
      if (this.alive && this.data.applying) { this.setData({ applying: false }); wx.showToast({ title: '未收到编辑页回应，请返回后重试', icon: 'none' }); }
    }, 5000);
    try {
      this.channel.emit('applyComposition', { sourceId: this.source.id, sourceKey: this.sourceKey, notes: copy(this.candidate.notes) });
      return true;
    } catch (error) {
      clearTimeout(this.applyTimer);
      this.setData({ applying: false });
      wx.showModal({ title: '没有发送创作结果', content: error.message || '请返回编辑页后重新打开创作。', showCancel: false });
      return false;
    }
  },
  async saveAsNew() {
    if (!this.candidate || this.data.saving || this.data.applying) return false;
    let total;
    try { total = storage.summaryPage(0, 1).total; }
    catch (error) {
      wx.showModal({ title: '无法检查记录本', content: error.message || '请检查存储空间后重试。', showCancel: false });
      return false;
    }
    if (total >= 100) { wx.showToast({ title: '记录本已满，请先整理旧灵感', icon: 'none' }); return false; }
    this.stop();
    const attempt = ++this.saveSeq;
    const current = () => this.alive && attempt === this.saveSeq;
    this.setData({ saving: true });
    const id = music.uid();
    let sourcePath = null, saved = false;
    const candidate = copy(this.candidate.notes), original = copy(this.source), preset = this.data.activePreset, mode = this.data.mode;
    try {
      if (original.source) sourcePath = await storage.saveRecording(original.source, id);
      if (!current()) {
        if (sourcePath) storage.removeFile(sourcePath);
        return false;
      }
      storage.save({ id, title: (original.title + ' · ' + preset.title).slice(0, 40), bpm: original.bpm,
        notes: candidate, source: sourcePath, recordingDuration: original.recordingDuration,
        createdAt: Date.now(), updatedAt: Date.now(), isDemo: false,
        creation: { sourceId: original.id, preset: preset.id, mode } });
      saved = true;
      if (current()) {
        wx.showToast({ title: '已另存为新灵感', icon: 'success' });
        const redirect = { url: '/pages/editor/editor?id=' + id };
        redirect.fail = error => {
          if (!current()) return;
          wx.showModal({ title: '已另存，但未打开', content: error && (error.errMsg || error.message) || '请回到首页打开新灵感。', showCancel: false });
        };
        try { wx.redirectTo(redirect); }
        catch (error) {
          wx.showModal({ title: '已另存，但未打开', content: error.message || '请回到首页打开新灵感。', showCancel: false });
        }
      }
      return true;
    } catch (error) {
      if (!saved && sourcePath) storage.removeFile(sourcePath);
      if (current()) wx.showModal({ title: '另存没有完成', content: error.message || error.errMsg || '请检查存储空间后重试。', showCancel: false });
      return false;
    } finally {
      if (current()) this.setData({ saving: false });
    }
  },
  backToEditor() {
    if (this.data.saving || this.data.applying || this.leaving) return false;
    this.leaving = true;
    try {
      if (this.data.canApplyToSource) wx.navigateBack({ delta: 1 });
      else if (this.source) wx.redirectTo({ url: '/pages/editor/editor?id=' + this.source.id });
      else wx.navigateBack({ delta: 1 });
      return true;
    } catch (_) {
      this.leaving = false;
      return false;
    }
  }
});
