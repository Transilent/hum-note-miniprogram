const { checkCancelled } = require('./swift-f0-core');
const median3 = (a, b, c) => a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
function pitches(frame) { return Float64Array.from(frame.pitch, hz => hz > 0 ? 69 + 12 * Math.log2(hz / 440) : NaN); }
async function transitionPenalties(frame, config, isCancelled) {
  const m = pitches(frame), c = frame.confidence, result = new Float64Array(m.length).fill(5);
  let began = Date.now();
  for (let t = 4; t < m.length - 4; t++) {
    const left = median3(m[t - 4], m[t - 3], m[t - 2]), right = median3(m[t + 1], m[t + 2], m[t + 3]);
    if (Math.min(c[t - 4], c[t - 3], c[t - 2], c[t + 1], c[t + 2], c[t + 3]) >= .85 &&
        Math.abs(left - right) >= config.jump && Math.abs(m[t + 1] - m[t - 1]) >= config.jump * .7 &&
        Math.max(Math.abs(m[t - 4] - left), Math.abs(m[t - 3] - left), Math.abs(m[t - 2] - left),
          Math.abs(m[t + 1] - right), Math.abs(m[t + 2] - right), Math.abs(m[t + 3] - right)) <= config.spread) {
      for (let j = t - 1; j <= t + 1; j++) result[j] = Math.min(result[j], config.penalty);
    }
    if ((t & 127) === 127 && Date.now() - began >= 8) { checkCancelled(isCancelled); await new Promise(resolve => setTimeout(resolve, 0)); began = Date.now(); }
  }
  checkCancelled(isCancelled); return result;
}
async function refineRepeats(events, frame, config, isCancelled) {
  const level = frame.loudness, c = frame.confidence, m = pitches(frame), result = [];
  let began = Date.now();
  for (const event of events) {
    const a = event.firstFrame, b = event.endFrame, candidates = [], midi = Math.floor(event.pitch + .5);
    for (let t = a + config.minimumFrames; t < b - config.minimumFrames; t++) {
      if (level[t] > level[t - 1] || level[t] >= level[t + 1]) continue;
      let before = -Infinity, after = -Infinity, beforeConfidence = 0, afterConfidence = 0;
      for (let j = Math.max(a, t - 8); j < t; j++) before = Math.max(before, level[j]);
      for (let j = t + 1; j < Math.min(b, t + 9); j++) after = Math.max(after, level[j]);
      for (let j = t - 4; j < t; j++) beforeConfidence = Math.max(beforeConfidence, c[j]);
      for (let j = t + 1; j < Math.min(b, t + 5); j++) afterConfidence = Math.max(afterConfidence, c[j]);
      const depth = Math.min(before, after) - level[t];
      if (depth < config.depthDb || Math.min(beforeConfidence, afterConfidence) - c[t] < config.confidenceDrop) continue;
      const beforePitch = median3(m[t - 4], m[t - 3], m[t - 2]), afterPitch = median3(m[t + 2], m[t + 3], m[t + 4]);
      if (!Number.isFinite(beforePitch) || !Number.isFinite(afterPitch) || Math.abs(beforePitch - midi) > .5 || Math.abs(afterPitch - midi) > .5) continue;
      candidates.push({ t, depth });
    }
    candidates.sort((x, y) => y.depth - x.depth || y.t - x.t);
    const chosen = [];
    for (const candidate of candidates) if (chosen.every(t => Math.abs(candidate.t - t) >= 7)) chosen.push(candidate.t);
    chosen.sort((x, y) => x - y); let start = a;
    for (const t of chosen) {
      if (t - start < config.minimumFrames) continue;
      result.push(Object.assign({}, event, { firstFrame: start, endFrame: t, start: start * .016, end: t * .016 })); start = t + 1;
    }
    result.push(Object.assign({}, event, { firstFrame: start, start: start * .016 }));
    if (Date.now() - began >= 8) { checkCancelled(isCancelled); await new Promise(resolve => setTimeout(resolve, 0)); began = Date.now(); }
  }
  checkCancelled(isCancelled); return result;
}
module.exports = { transitionPenalties, refineRepeats };
