// InnerAudioContext's progress events are sparse on phones. Interpolate between
// real audio timestamps; never start the clock while the WAV is being prepared.
class PlaybackClock {
  constructor(readTime, emit, now) {
    this.readTime = readTime; this.emit = emit; this.now = now || Date.now;
    this.reset();
  }
  reset() { this.running = false; this.position = 0; this.nativeTime = 0; this.at = this.now(); this.duration = 0; }
  sample(force) {
    const value = Number(this.readTime());
    if (Number.isFinite(value) && value >= 0 && (force || Math.abs(value - this.nativeTime) > .001)) {
      this.position = value; this.nativeTime = value; this.at = this.now();
    }
  }
  start() { this.sample(true); this.running = true; this.at = this.now(); this.tick(); }
  hold() { this.sample(false); this.position = this.value(); this.at = this.now(); this.running = false; this.emit(this.position); }
  value() {
    const value = this.position + (this.running ? Math.max(0, this.now() - this.at) / 1000 : 0);
    return this.duration > 0 ? Math.min(value, this.duration) : value;
  }
  tick() { if (!this.running) return; this.sample(false); this.emit(this.value()); }
}
module.exports = { PlaybackClock };
