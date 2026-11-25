// InnerAudioContext's progress events are sparse on phones. Interpolate between
// real audio timestamps; never start the clock while the WAV is being prepared.
class PlaybackClock {
  constructor(readTime, emit, now) {
    this.readTime = readTime; this.emit = emit; this.now = now || Date.now;
    this.reset();
  }
  reset() { this.running = false; this.position = 0; this.nativeTime = 0; this.shown = 0; this.at = this.now(); this.duration = 0; }
  sample(force) {
    const value = Number(this.readTime());
    const changed = Number.isFinite(value) && value >= 0 && (force || Math.abs(value - this.nativeTime) > .001);
    // A delayed timeupdate may arrive after a newer one on the same source.
    // Only an explicit start (for example after a seek) may move time backward.
    if (changed && (force || value >= this.nativeTime - .001)) {
      this.position = value; this.nativeTime = value; this.at = this.now();
    }
  }
  start(reposition = true) {
    this.sample(reposition);
    if (reposition) this.shown = this.position;
    this.running = true;
    this.at = this.now();
    this.tick();
  }
  hold() {
    this.sample(false);
    const shown = this.shown = this.value();
    this.running = false;
    this.emit(shown);
  }
  value() {
    const elapsed = this.running ? Math.min(MAX_INTERPOLATION_SECONDS, Math.max(0, this.now() - this.at) / 1000) : 0;
    const value = Math.max(this.shown, this.position + elapsed);
    return this.duration > 0 ? Math.min(value, this.duration) : value;
  }
  publish() { this.shown = this.value(); this.emit(this.shown); }
  tick() { if (!this.running) return; this.sample(false); this.publish(); }
}
module.exports = { PlaybackClock };
const MAX_INTERPOLATION_SECONDS = .32;
