const { decodeWav, encodeWavAsync } = require('./wav');
const { frequency, seconds } = require('./music');
const { PlaybackClock } = require('./playback-clock');
let context = null;
function getContext() {
  if (!context && wx.createWebAudioContext) context = wx.createWebAudioContext();
  return context;
}
function readFile(path) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: path, success: res => resolve(res.data), fail: reject }));
}
function writeFile(path, buffer) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath: path, data: buffer, success: () => resolve(path), fail: reject }));
}
async function decodeFile(path, isCancelled) {
  const cancelled = () => isCancelled && isCancelled();
  if (cancelled()) return null;
  const buffer = await readFile(path);
  if (cancelled()) return null;
  let wav, wavError;
  try { wav = decodeWav(buffer); } catch (error) { wavError = error; }
  if (wav) return wav;
  // DevTools can return WebM despite format: 'wav'. Compressed or uncommon
  // WAV encodings can also be supported by the platform decoder.
  const ctx = getContext();
  if (!ctx) throw wavError || new Error('这个环境无法解码录音，请在手机微信中试录。');
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      callback(value);
    };
    const fail = cause => {
      if (cancelled()) return settle(resolve, null);
      const error = new Error('录音解码失败，请在手机微信中试录；也可以先打开示例旋律。');
      error.cause = cause;
      settle(reject, error);
    };
    const began = Date.now();
    const watchdog = setInterval(() => {
      if (cancelled()) settle(resolve, null);
      else if (Date.now() - began >= 12000) fail(new Error('音频解码器未响应'));
    }, 100);
    const done = audio => {
      if (settled) return;
      if (cancelled()) return settle(resolve, null);
      try {
        if (!audio || !Number.isFinite(audio.length) || !Number.isFinite(audio.numberOfChannels) ||
            !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 ||
            audio.length < 0 || audio.numberOfChannels <= 0) {
          throw new Error('解码器返回了无效音频');
        }
        const samples = new Float32Array(audio.length);
        for (let ch = 0; ch < audio.numberOfChannels; ch++) {
          const channel = audio.getChannelData(ch);
          if (!channel || channel.length !== samples.length) throw new Error('解码器返回了不完整声道');
          for (let i = 0; i < samples.length; i++) samples[i] += channel[i] / audio.numberOfChannels;
        }
        settle(resolve, { samples, sampleRate: audio.sampleRate });
      } catch (error) {
        fail(error);
      }
    };
    try {
      const promise = ctx.decodeAudioData(buffer, done, fail);
      if (promise && promise.then) promise.then(done, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function* synthesizeChunks(notes, bpm, tone, sampleRate) {
  const rate = sampleRate || 22050;
  const duration = Math.min(180, Math.max(.25, seconds(notes, bpm)) + .3);
  const samples = new Float32Array(Math.ceil(duration * rate));
  const scale = 60 / bpm;
  for (const note of notes) {
    const start = Math.round(note.start * scale * rate), held = note.duration * scale;
    const length = Math.ceil((held + .08) * rate), hz = frequency(note.midi);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const t = i / rate, attack = Math.min(1, t / .009), release = t < held ? 1 : Math.max(0, 1 - (t - held) / .08);
      const phase = 2 * Math.PI * hz * t;
      const sound = tone === 'soft' ? Math.sin(phase) : (Math.sin(phase) + .28 * Math.sin(phase * 2) * Math.exp(-2 * t) + .1 * Math.sin(phase * 3) * Math.exp(-4 * t));
      const decay = tone === 'soft' ? .85 : .4 + .6 * Math.exp(-2.8 * t);
      samples[start + i] += sound * attack * release * decay * .38 * (note.velocity || 85) / 100;
      if ((i & 2047) === 2047) yield;
    }
    yield;
  }
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.max(-.95, Math.min(.95, samples[i]));
    if ((i & 16383) === 16383) yield;
  }
  return { samples, sampleRate: rate, duration };
}
function synthesize(notes, bpm, tone, sampleRate) {
  const chunks = synthesizeChunks(notes, bpm, tone, sampleRate);
  let step; do { step = chunks.next(); } while (!step.done);
  return step.value;
}
async function synthesizeAsync(notes, bpm, tone, isCancelled, sampleRate) {
  const chunks = synthesizeChunks(notes, bpm, tone, sampleRate);
  let began = Date.now();
  for (;;) {
    if (isCancelled && isCancelled()) return null;
    const step = chunks.next();
    if (step.done) return step.value;
    if (Date.now() - began >= 8) {
      await new Promise(resolve => setTimeout(resolve, 0)); began = Date.now();
    }
  }
}

function invoke(callback, value) {
  try { callback(value); return null; }
  catch (error) { return error || new Error('音频回调执行失败'); }
}

class Player {
  constructor(onEnded, onProgress, onError, onStarted) {
    this.onEnded = onEnded || (() => {}); this.onProgress = onProgress || (() => {}); this.onError = onError || (() => {});
    this.onStarted = onStarted || (() => {});
    this.clock = new PlaybackClock(() => this.inner && this.inner.currentTime, time => this.reportProgress(time));
    this.token = 0; this.requested = false; this.waiting = false; this.inner = null;
    this.sourcePath = ''; this.sourceDuration = 0; this.mediaLoaded = false; this.progressTimer = null;
    this.previewId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    this.previewFiles = new Set(); this.previewCache = null; this.destroyed = false; this.failing = false;
  }
  isCurrent(inner, token) {
    return !this.destroyed && token === this.token && inner === this.inner && this.requested;
  }
  clearProgress() {
    if (this.progressTimer != null) clearInterval(this.progressTimer);
    this.progressTimer = null;
  }
  destroyInner() {
    const inner = this.inner;
    this.inner = null; this.sourcePath = ''; this.sourceDuration = 0; this.mediaLoaded = false;
    if (!inner) return;
    try { inner.stop(); } catch (_) {}
    try { inner.destroy(); } catch (_) {}
  }
  resetPlayback() {
    this.token++; this.requested = false; this.waiting = false;
    this.clearProgress(); this.clock.reset(); this.destroyInner();
  }
  reportProgress(time) {
    const error = invoke(this.onProgress, time);
    if (error) this.failPlayback(error);
  }
  reportError(error) { invoke(this.onError, error); }
  failPlayback(error) {
    if (this.failing) return;
    this.failing = true;
    try { this.resetPlayback(); } finally { this.failing = false; }
    invoke(this.onProgress, 0);
    this.reportError(error);
  }
  invalidateCurrentCache() {
    if (this.previewCache && this.sourcePath && this.previewCache.path === this.sourcePath) {
      this.removePreview(this.previewCache.path);
      this.previewCache = null;
    }
  }
  sourceFailed(error, inner, token) {
    if (!this.isCurrent(inner, token)) return;
    this.invalidateCurrentCache();
    this.failPlayback(error);
  }
  syncDuration(inner) {
    if (this.sourceDuration > 0 || !this.mediaLoaded) return;
    const duration = Number(inner.duration);
    if (Number.isFinite(duration) && duration > 0) this.clock.duration = duration;
  }
  startClock(inner, token, reposition = false) {
    if (!this.isCurrent(inner, token)) return;
    this.waiting = false; this.clearProgress();
    const timer = setInterval(() => {
      if (!this.isCurrent(inner, token)) {
        clearInterval(timer);
        if (this.progressTimer === timer) this.progressTimer = null;
        return;
      }
      try { this.clock.tick(); }
      catch (error) { this.failPlayback(error); }
    }, 33);
    this.progressTimer = timer;
    try { this.clock.start(reposition); }
    catch (error) { this.failPlayback(error); }
  }
  holdClock(inner, token) {
    if (!this.isCurrent(inner, token)) return;
    this.clearProgress();
    try { this.clock.hold(); }
    catch (error) { this.failPlayback(error); }
  }
  bind(inner, token) {
    const on = (name, callback) => {
      if (typeof inner['on' + name] === 'function') inner['on' + name](callback);
    };
    const active = () => this.isCurrent(inner, token);
    on('Play', () => {
      if (!active()) return;
      this.mediaLoaded = true;
      this.syncDuration(inner);
      const error = invoke(this.onStarted);
      if (error) this.failPlayback(error);
      else this.startClock(inner, token);
    });
    on('Pause', () => { if (active()) this.holdClock(inner, token); });
    on('Waiting', () => { if (active()) { this.waiting = true; this.holdClock(inner, token); } });
    on('Seeking', () => { if (active()) this.holdClock(inner, token); });
    on('Seeked', () => { if (active() && !inner.paused) this.startClock(inner, token, true); });
    on('Canplay', () => { if (active()) { this.mediaLoaded = true; this.syncDuration(inner); } });
    on('Ended', () => { if (active()) this.finish(inner, token); });
    on('Error', error => { if (active()) this.sourceFailed(error, inner, token); });
    on('TimeUpdate', () => {
      if (!active()) return;
      // Some clients resume after buffering with timeupdate instead of play.
      if (this.waiting && !inner.paused && inner.currentTime > this.clock.nativeTime) this.startClock(inner, token);
      this.syncDuration(inner);
      try { this.clock.tick(); }
      catch (error) { this.failPlayback(error); }
    });
  }
  activateSource(path, duration, token, startAt) {
    if (this.destroyed || token !== this.token) return false;
    this.destroyInner();
    const inner = wx.createInnerAudioContext();
    this.inner = inner; inner.obeyMuteSwitch = false;
    this.sourcePath = path; this.sourceDuration = Number.isFinite(duration) && duration > 0 ? duration : 0; this.mediaLoaded = false;
    this.bind(inner, token);
    this.clock.reset(); this.clock.duration = this.sourceDuration;
    this.requested = true;
    const start = Number.isFinite(startAt) && startAt > 0 ? startAt : 0;
    inner.startTime = this.sourceDuration ? Math.min(start, Math.max(0, this.sourceDuration - .02)) : start;
    inner.src = path;
    if (!this.isCurrent(inner, token)) return false;
    inner.play();
    return true;
  }
  tokenCurrent(token) { return !this.destroyed && token === this.token; }
  async playNotes(notes, bpm, tone, startAt) {
    if (this.destroyed) return false;
    this.stop();
    const token = this.token;
    const snapshot = notes.map(note => ({ midi: note.midi, start: note.start, duration: note.duration, velocity: note.velocity || 85 }));
    const key = JSON.stringify([bpm, tone, snapshot.map(n => [n.midi, n.start, n.duration, n.velocity])]);
    let path = null;
    try {
      let cached = this.previewCache;
      if (!cached || cached.key !== key) {
        const audio = await synthesizeAsync(snapshot, bpm, tone, () => !this.tokenCurrent(token));
        if (!audio || !this.tokenCurrent(token)) return false;
        const buffer = await encodeWavAsync(audio.samples, audio.sampleRate, () => !this.tokenCurrent(token));
        if (!buffer || !this.tokenCurrent(token)) return false;
        path = wx.env.USER_DATA_PATH + '/preview-' + this.previewId + '-' + token + '.wav';
        this.previewFiles.add(path);
        await writeFile(path, buffer);
        if (!this.tokenCurrent(token)) { this.removePreview(path); return false; }
        cached = { key, path, duration: audio.duration };
        if (this.previewCache) this.removePreview(this.previewCache.path);
        this.previewCache = cached;
      }
      if (!this.tokenCurrent(token)) return false;
      return this.activateSource(cached.path, cached.duration, token, startAt);
    } catch (error) {
      if (path && (!this.previewCache || this.previewCache.path !== path)) this.removePreview(path);
      if (!this.tokenCurrent(token)) return false;
      this.resetPlayback();
      throw error;
    }
  }
  removePreview(path) {
    try { const fs = wx.getFileSystemManager(); if (fs.unlinkSync) fs.unlinkSync(path); } catch (_) {}
    this.previewFiles.delete(path);
  }
  playFile(path, startAt, duration) {
    if (this.destroyed) return false;
    this.stop();
    const token = this.token;
    try { return this.activateSource(path, duration, token, startAt); }
    catch (error) {
      // Report after the page's preparation call returns, while this source is current.
      Promise.resolve().then(() => {
        if (this.tokenCurrent(token)) this.failPlayback(error);
      });
      return false;
    }
  }
  seek(seconds) {
    const inner = this.inner;
    if (!inner || !this.requested || !this.mediaLoaded || typeof inner.seek !== 'function' || !Number.isFinite(seconds)) return false;
    const limit = this.clock.duration > 0 ? Math.max(0, this.clock.duration - .02) : Infinity;
    try { inner.seek(Math.max(0, Math.min(seconds, limit))); return true; }
    catch (_) { return false; }
  }
  finish(inner, token) {
    if (!this.isCurrent(inner, token)) return;
    this.resetPlayback();
    const progressError = invoke(this.onProgress, 0);
    if (progressError) { this.reportError(progressError); return; }
    const endedError = invoke(this.onEnded);
    if (endedError) this.reportError(endedError);
  }
  stop() {
    this.resetPlayback();
    const error = invoke(this.onProgress, 0);
    if (error) this.failPlayback(error);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.previewCache = null;
    for (const path of [...this.previewFiles]) this.removePreview(path);
  }
}

module.exports = { readFile, writeFile, decodeFile, synthesize, synthesizeAsync, Player };
