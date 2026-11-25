const { midiPitch } = require('./music');
const { STEP, checkCancelled } = require('./swift-f0-core');

// The 512-sample spectrum has the shortest time window. Comparing a band to
// the adjacent prior bands reduces peaks caused by pitch motion or vibrato.
async function onsetStrength(spectral, bands, isCancelled) {
  const { values, frames } = spectral;
  const offset = (values.length / frames - bands) * frames;
  const strength = new Float32Array(frames);
  let began = Date.now();
  for (let frame = 1; frame < frames; frame++) {
    let rise = 0;
    for (let band = 1; band < bands - 1; band++) {
      const index = offset + band * frames + frame;
      const reference = Math.max(values[index - 1 - frames], values[index - 1], values[index - 1 + frames]);
      rise += Math.min(4, Math.max(0, values[index] - reference));
    }
    strength[frame] = rise / (bands - 2);
    if ((frame & 31) === 31 && Date.now() - began >= 8) {
      checkCancelled(isCancelled);
      await new Promise(resolve => setTimeout(resolve, 0));
      began = Date.now();
    }
  }
  checkCancelled(isCancelled);
  return strength;
}

function levelPeak(level, start, end) {
  let peak = -Infinity;
  for (let i = start; i < end; i++) peak = Math.max(peak, level[i]);
  return peak;
}

function stablePitch(pitch, confidence, start, midi) {
  let stable = 0;
  for (let i = start; i < start + 3; i++) {
    if (confidence[i] >= .8 && Math.abs(pitch[i] - midi) <= .6) stable++;
  }
  return stable >= 2;
}

// A sustained tone can have regular loudness valleys without a new articulation.
// Compare two cycles with their shifted copies for roughly 4–8 Hz modulation.
function repeatingEnvelope(level, confidence, valley, first, end) {
  if (confidence[valley] < .8) return false;
  for (let period = 8; period <= 17 && period * 3 <= end - first; period++) {
    const start = Math.max(first, Math.min(valley - period, end - period * 3));
    const length = period * 2;
    let left = 0, right = 0, squaresLeft = 0, squaresRight = 0, product = 0, voiced = 0;
    for (let i = start; i < start + length; i++) {
      const a = level[i], b = level[i + period];
      left += a; right += b; squaresLeft += a * a; squaresRight += b * b; product += a * b;
      if (confidence[i] >= .8 && confidence[i + period] >= .8) voiced++;
    }
    const varianceLeft = squaresLeft - left * left / length;
    const varianceRight = squaresRight - right * right / length;
    const covariance = product - left * right / length;
    if (voiced >= length * .9 && varianceLeft >= length && varianceRight >= length &&
        covariance >= .92 * Math.sqrt(varianceLeft * varianceRight)) return true;
  }
  return false;
}

// Split only inside a single already-voiced note. A strong attack and
// a local dip/recovery must both be present, with the same pitch on each side.
function splitRepeatedOnsets(events, frame, strength, config) {
  const pitch = Float64Array.from(frame.pitch, midiPitch);
  const confidence = frame.confidence, level = frame.loudness;
  const output = [];
  for (const event of events) {
    const first = event.firstFrame, end = event.endFrame, midi = Math.round(event.pitch);
    let last = first;
    for (let t = first + config.minFrames; t <= end - config.minFrames; t++) {
      const peak = strength[t];
      if (peak < config.flux || peak <= strength[t - 1] || peak < strength[t + 1]) continue;
      if (peak < 1.15 * Math.max(strength[t - 3], strength[t + 3])) continue;
      let valley = t - 2;
      for (let i = t - 1; i <= t + 1; i++) if (level[i] < level[valley]) valley = i;
      const before = levelPeak(level, Math.max(last, valley - 8), valley);
      const after = levelPeak(level, t + 2, Math.min(end, t + 8));
      const depth = Math.min(before, after) - level[valley];
      if (depth < config.depth || !stablePitch(pitch, confidence, t - 4, midi) ||
          !stablePitch(pitch, confidence, t + 1, midi)) continue;
      const boundary = Math.max(valley, t - 1);
      if (boundary - last < config.minFrames) continue;
      if (repeatingEnvelope(level, confidence, valley, first, end)) continue;
      const release = depth >= 8 && confidence[valley] < .7 && valley - last >= config.minFrames ? valley : boundary;
      output.push(Object.assign({}, event, { firstFrame: last, endFrame: release, start: last * STEP, end: release * STEP }));
      last = boundary;
      t = last + config.minFrames - 1;
    }
    output.push(last === first ? event : Object.assign({}, event, { firstFrame: last, start: last * STEP }));
  }
  return output;
}

module.exports = { onsetStrength, splitRepeatedOnsets };
