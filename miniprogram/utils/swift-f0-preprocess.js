// Signal-only conditioning for SwiftF0; never changes the saved source audio.
const { checkCancelled } = require('./swift-f0-core');
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
async function periodicity(signal, start, isCancelled) {
  const length = Math.min(1024, signal.length - start) - 1;
  if (length < 511) return 0;
  const values = new Float64Array(length), scores = new Float64Array(344);
  let mean = 0;
  for (let i = 0; i < length; i++) { values[i] = signal[start + i + 1] - .85 * signal[start + i]; mean += values[i]; }
  mean /= length; for (let i = 0; i < length; i++) values[i] -= mean;
  let began = Date.now();
  for (let lag = 1; lag < 344; lag++) {
    let dot = 0, left = 0, right = 0;
    for (let i = 0; i < length - lag; i++) { const a = values[i], b = values[i + lag]; dot += a * b; left += a * a; right += b * b; }
    scores[lag] = left * right > 1e-24 ? dot / Math.sqrt(left * right) : 0;
    if ((lag & 15) === 15 && Date.now() - began >= 8) { checkCancelled(isCancelled); await wait(); began = Date.now(); }
  }
  let best = 0;
  for (let lag = 8; lag < 343; lag++) if (scores[lag] > scores[lag - 1] && scores[lag] >= scores[lag + 1]) best = Math.max(best, scores[lag]);
  return best;
}
async function conditionSignal(input, isCancelled) {
  checkCancelled(isCancelled);
  let sum = 0, power = 0;
  for (let i = 0; i < input.length; i++) { sum += input[i]; power += input[i] * input[i]; }
  const mean = sum / input.length, rms = Math.sqrt(power / input.length);
  const dcRemoved = Math.abs(mean) > .001 && Math.abs(mean) > rms * .1;
  const values = dcRemoved ? Float32Array.from(input, value => value - mean) : input;
  let peak = 0;
  for (let i = 0; i < values.length; i++) peak = Math.max(peak, Math.abs(values[i]));
  let gain = 1;
  if (peak >= .0002 && peak < .02 && values.length >= 1024) {
    const windows = []; let began = Date.now();
    for (let start = 0; start + 1024 <= values.length; start += 256) {
      let energy = 0;
      for (let i = start; i < start + 1024; i++) energy += values[i] * values[i];
      windows.push({ start, energy });
      if ((windows.length & 31) === 31 && Date.now() - began >= 8) { checkCancelled(isCancelled); await wait(); began = Date.now(); }
    }
    windows.sort((a, b) => b.energy - a.energy || b.start - a.start);
    const chosen = [];
    for (const window of windows) {
      if (chosen.every(other => Math.abs(window.start - other) >= 2048)) chosen.push(window.start);
      if (chosen.length === 3) break;
    }
    const evidence = [];
    for (const start of chosen) evidence.push(await periodicity(values, start, isCancelled));
    evidence.sort((a, b) => a - b);
    const middle = Math.floor(evidence.length / 2);
    const median = evidence.length % 2 ? evidence[middle] : (evidence[middle - 1] + evidence[middle]) / 2;
    if (evidence.length && median >= .65) gain = Math.min(64, .2 / peak);
  }
  checkCancelled(isCancelled);
  return { samples: gain === 1 ? values : Float32Array.from(values, value => value * gain), gain, dcRemoved };
}
module.exports = { conditionSignal };
