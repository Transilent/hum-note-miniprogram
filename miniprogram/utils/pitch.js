// YIN: difference function + cumulative mean normalization, followed by
// parabolic lag interpolation. No service, model download, or native plugin.
const { midiPitch, clamp } = require('./music');
const { segmentFrames } = require('./pitch-segmentation');
const config = require('./pitch-config');

function downsample(input, inputRate, targetRate) {
  if (inputRate <= targetRate) return { samples: input, sampleRate: inputRate };
  const ratio = inputRate / targetRate, output = new Float32Array(Math.floor(input.length / ratio));
  // Area averaging also attenuates high frequencies before decimation.
  for (let i = 0; i < output.length; i++) {
    const begin = i * ratio, end = (i + 1) * ratio;
    let sum = 0;
    for (let j = Math.floor(begin); j < Math.ceil(end); j++) sum += (input[j] || 0) * Math.max(0, Math.min(end, j + 1) - Math.max(begin, j));
    output[i] = sum / ratio;
  }
  return { samples: output, sampleRate: targetRate };
}

function yin(samples, offset, rate, gate, work) {
  const size = 512, minTau = Math.max(2, Math.floor(rate / config.maxFrequency)), maxTau = Math.min(work.length - 2, Math.ceil(rate / config.minFrequency));
  // A complete typed-array frame needs no per-sample zero fallback. Frames
  // whose lagged window reaches the end keep the original padded semantics.
  const complete = samples instanceof Float32Array && offset >= 0 && offset + size + maxTau < samples.length;
  let mean = 0, power = 0;
  if (complete) {
    for (let i = 0; i < size; i++) mean += samples[offset + i];
    mean /= size;
    for (let i = 0; i < size; i++) { const x = samples[offset + i] - mean; power += x * x; }
  } else {
    for (let i = 0; i < size; i++) mean += samples[offset + i] || 0;
    mean /= size;
    for (let i = 0; i < size; i++) { const x = (samples[offset + i] || 0) - mean; power += x * x; }
  }
  const rms = Math.sqrt(power / size);
  if (rms < gate) return { midi: null, confidence: 0, rms };
  work[0] = 1;
  let running = 0, best = -1, found = false;
  // Normalization depends only on preceding lags. Once the first sub-.16
  // valley and its right neighbor exist, later lags cannot affect the result.
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    if (complete) {
      for (let i = 0; i < size; i++) { const d = samples[offset + i] - samples[offset + i + tau]; sum += d * d; }
    } else {
      for (let i = 0; i < size; i++) { const d = (samples[offset + i] || 0) - (samples[offset + i + tau] || 0); sum += d * d; }
    }
    running += sum; work[tau] = running ? sum * tau / running : 1;
    if (found) {
      if (tau < maxTau && work[tau] < work[best]) best = tau;
      else break;
    } else if (tau >= minTau && tau < maxTau && work[tau] < .16) {
      best = tau; found = true;
    }
  }
  if (!found) {
    for (let tau = minTau; tau < maxTau; tau++) if (best < 0 || work[tau] < work[best]) best = tau;
    if (work[best] > .28) return { midi: null, confidence: 0, rms };
  }
  const left = work[best - 1], mid = work[best], right = work[best + 1];
  const denominator = 2 * (2 * mid - right - left);
  const period = best + (denominator ? (right - left) / denominator : 0);
  const hz = rate / period;
  if (hz < config.minFrequency || hz > config.maxFrequency) return { midi: null, confidence: 0, rms };
  return { midi: midiPitch(hz), confidence: clamp(1 - mid, 0, 1), rms };
}

function framesToNotes(frames, hopSeconds, bpm) {
  return segmentFrames(frames, hopSeconds, bpm, config.segmentation);
}

async function transcribe(input, sampleRate, bpm, onProgress, isCancelled) {
  if (!input || input.length < sampleRate * .2) throw new Error('录音太短了，请至少哼唱 1 秒。');
  if (sampleRate < 4000 || sampleRate > 192000) throw new Error('录音采样率不受支持。');
  const down = downsample(input.subarray(0, Math.floor(sampleRate * 30.2)), sampleRate, 8000);
  const data = down.samples, rate = down.sampleRate, hop = Math.round(rate * .015), frameCount = Math.max(0, Math.floor((data.length - 700) / hop));
  let maxRms = 0;
  for (let i = 0; i + 512 < data.length; i += 512) {
    let power = 0, mean = 0;
    for (let j = 0; j < 512; j++) mean += data[i + j];
    mean /= 512;
    for (let j = 0; j < 512; j++) power += Math.pow(data[i + j] - mean, 2);
    maxRms = Math.max(maxRms, Math.sqrt(power / 512));
  }
  const gate = Math.max(config.rmsFloor, maxRms * config.relativeRmsGate), frames = [], work = new Float32Array(205);
  let lastProgress = -1, sliceStart = Date.now();
  for (let index = 0; index < frameCount; index++) {
    if (isCancelled && isCancelled()) throw new Error('已取消识别');
    frames.push(yin(data, index * hop, rate, gate, work));
    if ((index & 7) === 7) {
      const progress = Math.round(index / frameCount * 100);
      if (progress !== lastProgress) {
        if (onProgress) onProgress(progress);
        lastProgress = progress;
      }
      if (Date.now() - sliceStart >= 10) {
        await new Promise(resolve => setTimeout(resolve, 0));
        sliceStart = Date.now();
      }
    }
  }
  const notes = framesToNotes(frames, hop / rate, bpm);
  if (!notes.length) throw new Error('没有找到稳定的旋律。请靠近麦克风，在安静的环境里清楚地哼一遍。');
  if (onProgress) onProgress(100);
  const voiced = frames.filter(f => f.midi != null);
  return { notes, duration: input.length / sampleRate, confidence: voiced.reduce((sum, f) => sum + f.confidence, 0) / Math.max(1, voiced.length) };
}

module.exports = { transcribe, yin, downsample, framesToNotes };
