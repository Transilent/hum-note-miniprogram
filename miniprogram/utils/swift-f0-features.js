// SwiftF0 0.3.0 feature extraction, adapted to cooperative JavaScript (MIT).
// Same Hann windows and log-frequency filters; native CNN weights are unchanged.
const data = require('../models/swift-f0-features-data');
const { HOP, checkCancelled } = require('./swift-f0-core');
const plans = new Map();
function plan(size) {
  if (plans.has(size)) return plans.get(size);
  const bits = Math.round(Math.log2(size)), reverse = new Uint16Array(size);
  const window = new Float32Array(size), cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < size; i++) {
    let value = i, flipped = 0;
    for (let b = 0; b < bits; b++) { flipped = flipped * 2 + (value & 1); value >>>= 1; }
    reverse[i] = flipped; window[i] = .5 - .5 * Math.cos(2 * Math.PI * i / size);
    if (i < size / 2) { cos[i] = Math.cos(-2 * Math.PI * i / size); sin[i] = Math.sin(-2 * Math.PI * i / size); }
  }
  const value = { reverse, window, cos, sin, real: new Float64Array(size), imaginary: new Float64Array(size), magnitude: new Float32Array(size / 2 + 1) };
  plans.set(size, value); return value;
}
function spectrum(signal, frame, size, p) {
  const real = p.real, imaginary = p.imaginary;
  imaginary.fill(0);
  const start = frame * HOP - size / 2;
  for (let i = 0; i < size; i++) {
    const at = start + i;
    real[p.reverse[i]] = at < 0 || at >= signal.length ? 0 : Math.fround(signal[at] * p.window[i]);
  }
  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2, step = size / width;
    for (let base = 0; base < size; base += width) {
      for (let j = 0; j < half; j++) {
        const left = base + j, right = left + half, angle = j * step;
        const re = real[right] * p.cos[angle] - imaginary[right] * p.sin[angle];
        const im = real[right] * p.sin[angle] + imaginary[right] * p.cos[angle];
        real[right] = real[left] - re; imaginary[right] = imaginary[left] - im;
        real[left] += re; imaginary[left] += im;
      }
    }
  }
  for (let i = 0; i < p.magnitude.length; i++) p.magnitude[i] = Math.sqrt(real[i] * real[i] + imaginary[i] * imaginary[i]);
  return p.magnitude;
}
async function extract(signal, isCancelled, onProgress) {
  const frames = Math.floor(signal.length / HOP), values = new Float32Array(3 * data.bands * frames);
  let began = Date.now();
  for (let channel = 0; channel < data.windows.length; channel++) {
    const settings = data.windows[channel], p = plan(settings.size);
    for (let frame = 0; frame < frames; frame++) {
      const magnitude = spectrum(signal, frame, settings.size, p);
      for (let band = 0; band < data.bands; band++) {
        const filter = settings.filters[band]; let sum = 0;
        for (let k = 0; k < filter.weights.length; k++) sum += magnitude[filter.start + k] * filter.weights[k];
        values[(channel * data.bands + band) * frames + frame] = Math.log(Math.fround(Math.fround(sum) + 1e-8));
      }
      if ((frame & 3) === 3 && Date.now() - began >= 8) {
        checkCancelled(isCancelled);
        if (onProgress) onProgress((channel * frames + frame + 1) / (data.windows.length * frames));
        await new Promise(resolve => setTimeout(resolve, 0)); began = Date.now();
      }
    }
  }
  checkCancelled(isCancelled);
  if (onProgress) onProgress(1);
  return { values, frames };
}
function block(features, left, end) {
  const count = end - left;
  if (count < 1 || count > data.frames || left < 0 || end > features.frames) throw Error('Invalid feature window');
  const values = new Float32Array(3 * data.bands * data.frames), mask = new Float32Array(data.frames);
  mask.fill(1, 0, count);
  for (let band = 0; band < 3 * data.bands; band++)
    values.set(features.values.subarray(band * features.frames + left, band * features.frames + end), band * data.frames);
  return { features: values, mask, validFrames: count };
}
module.exports = { extract, block, FRAMES: data.frames, BANDS: data.bands };
