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
async function decodeFile(path) {
  const buffer = await readFile(path);
  const wav = decodeWav(buffer);
  if (wav) return wav;
  // Some DevTools versions return WebM despite format: 'wav'. Use the actual
  // decoder's sample rate; never interpret compressed bytes as raw PCM.
  const ctx = getContext();
  if (!ctx) throw new Error('这个环境无法解码录音，请在手机微信中试录。');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = audio => {
      if (settled) return; settled = true;
      const samples = new Float32Array(audio.length);
      for (let ch = 0; ch < audio.numberOfChannels; ch++) {
        const channel = audio.getChannelData(ch);
        for (let i = 0; i < samples.length; i++) samples[i] += channel[i] / audio.numberOfChannels;
      }
      resolve({ samples, sampleRate: audio.sampleRate });
    };
    const fail = () => { if (!settled) { settled = true; reject(new Error('录音解码失败，请在手机微信中试录；也可以先打开示例旋律。')); } };
    try { const promise = ctx.decodeAudioData(buffer, done, fail); if (promise && promise.then) promise.then(done, fail); } catch (_) { fail(); }
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

class Player {
  constructor(onEnded, onProgress, onError) {
    this.onEnded = onEnded || (() => {}); this.onProgress = onProgress || (() => {}); this.onError = onError || (() => {});
    this.inner = wx.createInnerAudioContext(); this.inner.obeyMuteSwitch = false;
    this.clock = new PlaybackClock(() => this.inner.currentTime, time => this.onProgress(time));
    this.token = 0; this.requested = false; this.waiting = false;
    this.previewId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    this.previewFiles = new Set(); this.previewCache = null; this.destroyed = false;
    this.inner.onPlay(() => { if (this.requested) this.startClock(); });
    this.inner.onPause(() => this.holdClock());
    this.inner.onWaiting(() => { this.waiting = true; this.holdClock(); });
    this.inner.onSeeking(() => this.holdClock());
    this.inner.onSeeked(() => { if (this.requested && !this.inner.paused) this.startClock(); });
    this.inner.onEnded(() => this.finish());
    this.inner.onError(error => {
      if (this.previewCache && this.inner.src === this.previewCache.path) { this.removePreview(this.previewCache.path); this.previewCache = null; }
      this.stop(); this.onError(error);
    });
    this.inner.onTimeUpdate(() => {
      if (!this.requested) return;
      // Some clients resume after buffering with timeupdate instead of play.
      if (this.waiting && !this.inner.paused && this.inner.currentTime > this.clock.nativeTime) this.startClock();
      if (this.inner.duration > 0) this.clock.duration = this.inner.duration;
      this.clock.tick();
    });
  }
  startClock() {
    this.waiting = false; clearInterval(this.progressTimer);
    this.clock.start(); this.progressTimer = setInterval(() => this.clock.tick(), 33);
  }
  holdClock() { clearInterval(this.progressTimer); this.progressTimer = null; this.clock.hold(); }
  async playNotes(notes, bpm, tone) {
    if (this.destroyed) return false;
    this.stop(); const token = this.token;
    const key = JSON.stringify([bpm, tone, notes.map(n => [n.midi, n.start, n.duration, n.velocity || 85])]);
    let cached = this.previewCache;
    if (!cached || cached.key !== key) {
      const audio = await synthesizeAsync(notes, bpm, tone, () => token !== this.token);
      if (!audio || token !== this.token) return false;
      const buffer = await encodeWavAsync(audio.samples, audio.sampleRate, () => token !== this.token);
      if (!buffer || token !== this.token) return false;
      const path = wx.env.USER_DATA_PATH + '/preview-' + this.previewId + '-' + token + '.wav';
      this.previewFiles.add(path);
      try { await writeFile(path, buffer); }
      catch (error) { this.removePreview(path); throw error; }
      if (token !== this.token) { this.removePreview(path); return false; }
      cached = { key, path, duration: audio.duration };
      if (this.previewCache) this.removePreview(this.previewCache.path);
      this.previewCache = cached;
    }
    this.clock.duration = cached.duration;
    this.inner.startTime = 0; this.inner.src = cached.path; this.requested = true; this.inner.play(); return true;
  }
  removePreview(path) {
    try { const fs = wx.getFileSystemManager(); if (fs.unlinkSync) fs.unlinkSync(path); } catch (_) {}
    this.previewFiles.delete(path);
  }
  playFile(path) { this.stop(); this.inner.src = path; this.requested = true; this.inner.play(); }
  finish() { this.requested = false; this.waiting = false; clearInterval(this.progressTimer); this.progressTimer = null; this.clock.reset(); this.onProgress(0); this.onEnded(); }
  stop() { this.token++; this.requested = false; this.waiting = false; clearInterval(this.progressTimer); this.progressTimer = null; this.clock.reset(); this.inner.stop(); this.onProgress(0); }
  destroy() { this.destroyed = true; this.stop(); this.inner.destroy(); for (const path of this.previewFiles) this.removePreview(path); this.previewCache = null; }
}

module.exports = { readFile, writeFile, decodeFile, synthesize, synthesizeAsync, Player };
