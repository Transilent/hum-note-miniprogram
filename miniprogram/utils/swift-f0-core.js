// SwiftF0 0.3.0 decoding and note segmentation port, modified for cooperative
// scheduling and HumNote's beat-based editor. Original algorithm: Lars Nieradzik,
// MIT. See models/LICENSE.swift-f0.txt and docs/SwiftF0实验识别.md.
const { clamp, uid } = require('./music');
// WeChat's runtime requires JavaScript modules; JSON is kept for provenance only.
const metadata = require('../models/swift-f0-meta');
const HOP = 256, RATE = 16000, STEP = HOP / RATE;
const CENTERS = metadata.pitchBinCenters;
const LOG_CENTERS = CENTERS.map(hz => Math.log(hz));
const wait = () => new Promise(resolve => setTimeout(resolve, 0));

function error(code, message) { const value = new Error(message); value.code = code; return value; }
function checkCancelled(isCancelled) {
  if (isCancelled && isCancelled()) throw error('CANCELLED', '已取消识别');
}

async function prepareSignal(input, inputRate, isCancelled) {
  if (!input || typeof input.subarray !== 'function' || !Number.isFinite(inputRate) || inputRate < 4000 || inputRate > 192000)
    throw error('INPUT', '录音采样率不受支持。');
  if (input.length < inputRate * .2) throw error('INPUT', '录音太短了，请至少哼唱 1 秒。');
  checkCancelled(isCancelled);
  const source = input.subarray(0, Math.floor(inputRate * 30));
  for (let i = 0; i < source.length; i++) {
    if (!Number.isFinite(source[i])) throw error('INPUT', '录音包含无效的声音数据。');
  }
  if (inputRate === RATE) return source instanceof Float32Array ? source : new Float32Array(source);
  // Polyphase windowed sinc: anti-alias before decimation, with zero extension.
  // RecorderManager normally provides 16 kHz, which skips this entire branch.
  const cutoff = Math.min(1, RATE / inputRate) * .94;
  const radius = Math.ceil(12 / cutoff), width = radius * 2 + 1, phases = 1024;
  const kernels = new Float32Array(phases * width);
  let began = Date.now();
  for (let phase = 0; phase < phases; phase++) {
    const fraction = phase / phases;
    let sum = 0;
    for (let j = 0; j < width; j++) {
      const x = j - radius - fraction;
      const window = Math.abs(x) > radius ? 0 : .5 + .5 * Math.cos(Math.PI * x / radius);
      const value = window * (Math.abs(x) < 1e-12 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x));
      kernels[phase * width + j] = value; sum += value;
    }
    for (let j = 0; j < width; j++) kernels[phase * width + j] /= sum;
    if ((phase & 63) === 63 && Date.now() - began >= 8) {
      checkCancelled(isCancelled); await wait(); began = Date.now();
    }
  }
  const result = new Float32Array(Math.round(source.length * RATE / inputRate));
  for (let i = 0; i < result.length; i++) {
    const position = i * inputRate / RATE, center = Math.floor(position);
    const phase = Math.min(phases - 1, Math.floor((position - center) * phases));
    let sum = 0;
    for (let j = 0; j < width; j++) {
      const at = center + j - radius;
      if (at >= 0 && at < source.length) sum += source[at] * kernels[phase * width + j];
    }
    result[i] = sum;
    if ((i & 2047) === 2047 && Date.now() - began >= 8) {
      checkCancelled(isCancelled); await wait(); began = Date.now();
    }
  }
  checkCancelled(isCancelled);
  return result;
}

function decodeLogits(pitchLogits, voicingLogits, frameCount) {
  if (pitchLogits.length !== frameCount * 95 || voicingLogits.length !== frameCount)
    throw error('SWIFT_OUTPUT', '实验识别返回的数据尺寸异常。');
  const pitch = new Float64Array(frameCount), confidence = new Float64Array(frameCount);
  for (let t = 0; t < frameCount; t++) {
    const offset = t * 95;
    let peak = 0;
    for (let j = 0; j < 95; j++) {
      if (!Number.isFinite(pitchLogits[offset + j])) throw error('SWIFT_OUTPUT', '实验识别返回了无效音高。');
      if (pitchLogits[offset + j] > pitchLogits[offset + peak]) peak = j;
    }
    if (!Number.isFinite(voicingLogits[t])) throw error('SWIFT_OUTPUT', '实验识别返回了无效置信度。');
    let weights = 0, weighted = 0;
    for (let j = Math.max(0, peak - 1); j <= Math.min(94, peak + 1); j++) {
      const weight = Math.exp(pitchLogits[offset + j] - pitchLogits[offset + peak]);
      weights += weight; weighted += weight * LOG_CENTERS[j];
    }
    pitch[t] = Math.exp(weighted / weights);
    confidence[t] = 1 / (1 + Math.exp(-voicingLogits[t]));
  }
  return { pitch, confidence };
}

function levels(signal, confidence) {
  const power = new Float64Array(confidence.length), loudness = new Float64Array(confidence.length);
  for (let t = 0; t < power.length; t++) {
    let peak = 0, sum = 0;
    for (let j = 0; j < HOP; j++) {
      const value = signal[t * HOP + j] || 0;
      sum += value * value; peak = Math.max(peak, Math.abs(value));
    }
    power[t] = sum;
    if (peak < .001) confidence[t] = 0;
    loudness[t] = 20 * Math.log10(Math.max(Math.sqrt((sum + (t ? power[t - 1] : 0)) / 512), 1e-7));
  }
  return loudness;
}

function symmetricIndex(index, length) {
  while (index < 0 || index >= length) {
    if (index < 0) index = -index - 1;
    if (index >= length) index = 2 * length - index - 1;
  }
  return index;
}

async function segmentPitch(result, isCancelled, onProgress, options) {
  const config = options || {};
  const pitch = result.pitch, confidence = result.confidence, level = result.loudness;
  const n = pitch.length, m = new Float64Array(n), w = new Float64Array(n), q = new Float64Array(n);
  const values = new Set();
  for (let t = 0; t < n; t++) {
    if (Number.isFinite(pitch[t]) && pitch[t] > 0) {
      m[t] = 69 + 12 * Math.log2(pitch[t] / 440); w[t] = confidence[t];
      values.add(Math.floor(m[t] * 100 + .5) / 100);
    }
    const c = clamp(w[t], .01, .99);
    let left = -Infinity, right = -Infinity;
    for (let j = -4; j <= 0; j++) left = Math.max(left, level[symmetricIndex(t + j, n)]);
    for (let j = 0; j <= 4; j++) right = Math.max(right, level[symmetricIndex(t + j, n)]);
    q[t] = -Math.log(c / (1 - c)) + Math.max(0, Math.min(left, right) - level[t] - 10 * Math.log10(2)) + (config.gapBias || 0);
  }
  if (!values.size) return [];
  const mu = Array.from(values).sort((a, b) => a - b), cost = new Float64Array(mu.length);
  cost.fill(Infinity);
  const starts = new Int32Array(mu.length), back = new Int32Array(n + 1), kind = new Int32Array(n + 1);
  kind.fill(-1);
  let best = 0, began = Date.now();
  for (let t = 0; t < n; t++) {
    const startCost = best + (config.penalties ? config.penalties[t] : 5); // Default pitch_hold_ms=80 / frame_period_ms=16.
    let lowest = Infinity, index = 0;
    for (let j = 0; j < mu.length; j++) {
      if (startCost < cost[j]) { cost[j] = startCost; starts[j] = t; }
      cost[j] += Math.min(Math.abs(mu[j] - m[t]), 2) * w[t] + q[t];
      if (cost[j] < lowest) { lowest = cost[j]; index = j; }
    }
    if (lowest < best) { best = lowest; back[t + 1] = starts[index]; kind[t + 1] = index; }
    else back[t + 1] = t;
    if ((t & 7) === 7 && Date.now() - began >= 8) {
      checkCancelled(isCancelled);
      if (onProgress) onProgress((t + 1) / n);
      await wait(); began = Date.now();
    }
  }
  checkCancelled(isCancelled);
  const notes = [];
  for (let end = n; end > 0;) {
    const start = back[end];
    if (kind[end] >= 0) notes.push({ start: start * STEP, end: end * STEP, pitch: mu[kind[end]], firstFrame: start, endFrame: end });
    end = start;
  }
  return notes.reverse();
}

function toEditorNotes(events, confidence, bpm, options) {
  const config = options || {}, minimumBeats = config.minimumBeats || .125;
  const notes = [];
  let droppedShort = 0;
  for (const event of events) {
    const start = Math.round(event.start * bpm / 60 * 1000) / 1000;
    const end = Math.round(event.end * bpm / 60 * 1000) / 1000;
    if (end - start < minimumBeats - 1e-9) { droppedShort++; continue; }
    let sum = 0;
    for (let i = event.firstFrame; i < event.endFrame; i++) sum += confidence[i];
    const certainty = sum / Math.max(1, event.endFrame - event.firstFrame);
    if (end - start < .125 - 1e-9 && config.pitch) {
      const deviations = [];
      for (let i = event.firstFrame; i < event.endFrame; i++) deviations.push(Math.abs(69 + 12 * Math.log2(config.pitch[i] / 440) - Math.floor(event.pitch + .5)));
      deviations.sort((a, b) => a - b); const center = Math.floor(deviations.length / 2);
      const deviation = deviations.length % 2 ? deviations[center] : (deviations[center - 1] + deviations[center]) / 2;
      if (certainty < config.minimumConfidence || deviation > config.maximumDeviation) { droppedShort++; continue; }
    }
    const pieces = Math.ceil((end - start) / 32);
    for (let piece = 0; piece < pieces; piece++) {
      const from = Math.round((start + (end - start) * piece / pieces) * 1000) / 1000;
      const to = Math.round((start + (end - start) * (piece + 1) / pieces) * 1000) / 1000;
      notes.push({ id: uid(), midi: clamp(Math.floor(event.pitch + .5), 21, 108), start: from,
        duration: Math.round((to - from) * 1000) / 1000, velocity: 85, confidence: clamp(certainty, 0, 1) });
    }
  }
  if (notes.length > 500) throw error('RESULT', '这段旋律的音符太密了，请缩短录音后重试。');
  if (!notes.length) throw error('NO_NOTES', '没有找到稳定的旋律。请清晰地哼唱一小段后重试。');
  return { notes, droppedShort };
}

module.exports = { HOP, RATE, STEP, error, checkCancelled, prepareSignal, decodeLogits, levels, segmentPitch, toEditorNotes };
