const core = require('./swift-f0-core');
const features = require('./swift-f0-features');
const metadata = require('../models/swift-f0-meta');
const { prepareModelFile } = require('./swift-f0-model-file');
const { conditionSignal } = require('./swift-f0-preprocess');
const noteTools = require('./swift-f0-notes');
const { onsetStrength, splitRepeatedOnsets } = require('./swift-f0-onsets');
const noteConfig = require('./swift-f0-note-config');
// Source artifact name; native sessions use prepareModelFile().path.
const MODEL_PATH = 'models/swift-f0-cnn.onnx';
const CORE_FRAMES = 128, CONTEXT_FRAMES = 12;
let defaultBackend = null, probeBackend = null, busy = false;

function nativeError(code, value, stage) {
  let detail = value && (value.errMsg || value.message);
  if (!detail) { try { detail = typeof value === 'string' ? value : JSON.stringify(value); } catch (_) {} }
  const result = core.error(code, '当前设备暂时无法运行实验识别。');
  result.detail = String(detail || value || '').slice(0, 1500); result.stage = stage || 'load';
  const nativeCode = value && typeof value === 'object' ? (value.errCode !== undefined ? value.errCode : value.code) : '';
  result.nativeCode = nativeCode === undefined ? '' : String(nativeCode);
  return result;
}

function createBackend(api, options) {
  const config = options || {};
  let slot = null;
  function invalidate(entry, failure) {
    if (slot !== entry) return;
    slot = null;
    if (entry.modelFile) failure.modelFile = entry.modelFile;
    clearTimeout(entry.timer);
    entry.reject(failure);
    if (entry.rejectRun) entry.rejectRun(failure);
    try { if (entry.session) entry.session.destroy(); } catch (_) {}
  }
  function dispose() {
    if (slot) invalidate(slot, core.error('CANCELLED', '已取消识别'));
  }
  function load() {
    if (slot) return slot.promise;
    if (!api || typeof api.createInferenceSession !== 'function')
      return Promise.reject(nativeError('SWIFT_UNAVAILABLE', 'createInferenceSession unavailable'));
    const entry = {};
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    slot = entry;
    entry.timer = setTimeout(() => invalidate(entry, nativeError('SWIFT_LOAD', 'model load timeout')), config.loadTimeout || 20000);
    try {
      entry.modelFile = prepareModelFile(api, !!config.probe);
      entry.session = api.createInferenceSession({ model: entry.modelFile.path, precisionLevel: 4,
        allowNPU: false, allowQuantize: false,
        typicalShape: config.probe ? { input: [1, 2] } : { features: [1, 3, 128, features.FRAMES], frame_mask: [1, 1, 1, features.FRAMES] } });
      entry.session.onError(value => invalidate(entry, nativeError('SWIFT_NATIVE', value, entry.running ? 'run' : 'load')));
      entry.session.onLoad(() => {
        if (slot !== entry) return;
        clearTimeout(entry.timer); entry.resolve(entry);
      });
    } catch (value) { invalidate(entry, value && /^SWIFT_/.test(value.code || '') ? value : nativeError('SWIFT_LOAD', value)); }
    return entry.promise;
  }
  function cancellable(promise, entry, isCancelled, timeout) {
    return new Promise((resolve, reject) => {
      let complete = false, poll, deadline;
      const finish = (failure, result) => {
        if (complete) return;
        complete = true; clearInterval(poll); clearTimeout(deadline);
        if (entry && entry.rejectRun === fail) entry.rejectRun = null;
        if (failure) reject(failure); else resolve(result);
      };
      const fail = failure => finish(failure);
      if (entry) entry.rejectRun = fail;
      poll = setInterval(() => {
        if (isCancelled && isCancelled()) {
          const failure = core.error('CANCELLED', '已取消识别');
          const current = entry || slot;
          if (current) invalidate(current, failure);
          finish(failure);
        }
      }, 40);
      if (timeout) deadline = setTimeout(() => {
        const failure = nativeError('SWIFT_RUN', 'model inference timeout', 'run');
        if (entry) invalidate(entry, failure);
        finish(failure);
      }, timeout);
      Promise.resolve(promise).then(result => finish(null, result), fail);
    });
  }
  async function ready(isCancelled) {
    core.checkCancelled(isCancelled);
    const result = await cancellable(load(), null, isCancelled);
    core.checkCancelled(isCancelled);
    return result;
  }
  async function run(block, isCancelled) {
    const entry = await ready(isCancelled);
    if (slot !== entry) throw core.error('CANCELLED', '已取消识别');
    const tensor = (values, shape) => ({ type: 'float32', data: values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength), shape });
    const input = config.probe ? { input: tensor(block, [1, 2]) } : {
      features: tensor(block.features, [1, 3, 128, features.FRAMES]), frame_mask: tensor(block.mask, [1, 1, 1, features.FRAMES]) };
    let pending;
    entry.running = true;
    try { pending = entry.session.run(input); }
    catch (value) {
      const failure = nativeError('SWIFT_RUN', value, 'run'); invalidate(entry, failure); throw failure;
    }
    let result;
    try { result = await cancellable(pending, entry, isCancelled, config.runTimeout || 15000); }
    catch (value) {
      if (value.code === 'CANCELLED') throw value;
      const failure = value.code ? value : nativeError('SWIFT_RUN', value, 'run');
      invalidate(entry, failure); throw failure;
    }
    core.checkCancelled(isCancelled);
    if (slot !== entry) throw core.error('CANCELLED', '已取消识别');
    entry.running = false;
    function read(name) {
      const value = result && result[name];
      if (!value || value.type !== 'float32' || Object.prototype.toString.call(value.data) !== '[object ArrayBuffer]' || value.data.byteLength % 4)
        throw nativeError('SWIFT_OUTPUT', 'invalid tensor: ' + name, 'output');
      return new Float32Array(value.data);
    }
    return config.probe ? { probe: read('output'), modelFile: entry.modelFile } :
      { pitch: read('pitch_logits'), voicing: read('voicing_logits'), modelFile: entry.modelFile };
  }
  return { api, ready, run, dispose };
}

function getBackend(api) {
  if (!defaultBackend || defaultBackend.api !== api) {
    if (defaultBackend) defaultBackend.dispose();
    defaultBackend = createBackend(api);
  }
  return defaultBackend;
}

async function transcribe(input, sampleRate, bpm, onProgress, isCancelled, options) {
  if (busy) throw core.error('BUSY', '上一段旋律还在识别，请稍候。');
  busy = true;
  try {
    if (!Number.isFinite(bpm) || bpm <= 0) throw core.error('INPUT', 'BPM 无效。');
    const stage = options && options.onStage || (() => {});
    let lastProgress = -1;
    const progress = value => {
      const next = Math.max(lastProgress, Math.min(100, Math.round(value)));
      if (next !== lastProgress) { lastProgress = next; if (onProgress) onProgress(next); }
    };
    stage('准备实验识别'); progress(1);
    const requestedProfile = options && options.noteProfile;
    const originalProfile = requestedProfile === 'original';
    const useOnsets = !originalProfile && requestedProfile !== noteConfig.id;
    const prepared = await core.prepareSignal(input, sampleRate, isCancelled);
    stage('准备哼唱音频');
    const conditioned = originalProfile ? { samples: prepared, gain: 1, dcRemoved: false } : await conditionSignal(prepared, isCancelled);
    const signal = conditioned.samples;
    const api = options && options.api || (typeof wx !== 'undefined' ? wx : null);
    const backend = options && options.backend || getBackend(api);
    stage('正在准备本机模型');
    await backend.ready(isCancelled); progress(5);
    const count = Math.floor(signal.length / core.HOP);
    const pitch = new Float64Array(count), confidence = new Float64Array(count);
    stage('正在分析声音频谱');
    const spectral = await features.extract(signal, isCancelled, value => progress(5 + value * 25));
    stage('正在本机识别音高');
    for (let start = 0; start < count; start += CORE_FRAMES) {
      core.checkCancelled(isCancelled);
      const end = Math.min(count, start + CORE_FRAMES);
      const left = Math.max(0, start - CONTEXT_FRAMES);
      const part = features.block(spectral, left, Math.min(count, end + CONTEXT_FRAMES));
      const result = await backend.run(part, isCancelled);
      const decoded = core.decodeLogits(result.pitch, result.voicing, features.FRAMES);
      pitch.set(decoded.pitch.subarray(start - left, end - left), start);
      confidence.set(decoded.confidence.subarray(start - left, end - left), start);
      progress(30 + end / count * 45);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    core.checkCancelled(isCancelled);
    const loudness = core.levels(signal, confidence);
    stage('正在整理音符与时值'); progress(77);
    const frame = { pitch, confidence, loudness };
    const penalties = originalProfile ? null : await noteTools.transitionPenalties(frame, noteConfig.transition, isCancelled);
    let events = await core.segmentPitch(frame, isCancelled, value => progress(77 + value * 17),
      originalProfile ? null : { gapBias: noteConfig.gapBias, penalties });
    if (!originalProfile) events = await noteTools.refineRepeats(events, frame, noteConfig.repeat, isCancelled);
    if (useOnsets) {
      stage('正在核对同音起点'); progress(96);
      const strength = await onsetStrength(spectral, features.BANDS, isCancelled);
      events = splitRepeatedOnsets(events, frame, strength, noteConfig.onsets);
    }
    const converted = core.toEditorNotes(events, confidence, bpm, originalProfile ? null : Object.assign({ pitch }, {
      minimumBeats: noteConfig.shortNotes.minimumBeats, minimumConfidence: noteConfig.shortNotes.minimumConfidence,
      maximumDeviation: noteConfig.shortNotes.maximumDeviation }));
    core.checkCancelled(isCancelled); progress(100);
    let sum = 0, voiced = 0;
    confidence.forEach(value => { if (value >= .5) { sum += value; voiced++; } });
    return { notes: converted.notes, duration: input.length / sampleRate,
      confidence: sum / Math.max(1, voiced), engine: 'swift-f0', engineVersion: metadata.version,
      postprocessVersion: originalProfile ? 'original' : useOnsets ? noteConfig.onsets.id : noteConfig.id,
      conditioning: { gain: conditioned.gain, dcRemoved: conditioned.dcRemoved },
      droppedShortNotes: converted.droppedShort };
  } finally { busy = false; }
}

async function checkCompatibility(api, isCancelled, onStage) {
  if (busy) throw core.error('BUSY', '上一段旋律还在识别，请稍候。');
  busy = true;
  const diagnostics = require('./recognition-diagnostics');
  const report = { version: metadata.version, modelSha256: metadata.modelSha256, date: Date.now(), runtime: diagnostics.runtime(api) };
  let stage = 'engine';
  try {
    if (onStage) onStage('检查微信推理引擎');
    report.environment = await diagnostics.environment(api);
    core.checkCancelled(isCancelled);
    stage = 'files';
    if (onStage) onStage('准备本地模型文件');
    report.probeFile = prepareModelFile(api, true);
    report.modelFile = prepareModelFile(api, false);
    core.checkCancelled(isCancelled);
    stage = 'engine';
    probeBackend = createBackend(api, { probe: true, loadTimeout: 7000, runTimeout: 5000 });
    const output = await probeBackend.run(new Float32Array([1, 2]), isCancelled);
    if (output.probe.length !== 2 || output.probe[0] !== 3 || output.probe[1] !== 4)
      throw nativeError('SWIFT_PROBE', 'basic Add model returned incorrect result', 'engine');
    report.engine = 'passed'; report.probeFile = output.modelFile;
    probeBackend.dispose(); probeBackend = null;
    stage = 'model';
    if (onStage) onStage('检查 SwiftF0 模型');
    const backend = getBackend(api); await backend.ready(isCancelled);
    const signal = Float32Array.from({ length: 16000 }, (_, i) => .2 * Math.sin(2 * Math.PI * 220 * i / 16000));
    const spectral = await features.extract(signal, isCancelled);
    const result = await backend.run(features.block(spectral, 0, spectral.frames), isCancelled);
    core.decodeLogits(result.pitch, result.voicing, features.FRAMES);
    report.model = 'passed'; report.modelFile = result.modelFile; report.ok = true;
    diagnostics.saveReport(api, report); return report;
  } catch (failure) {
    if (failure.code === 'CANCELLED' || failure.code === 'BUSY') throw failure;
    report.ok = false; report.failedCheck = stage;
    report.failure = diagnostics.failureInfo(failure);
    if (stage === 'model' && defaultBackend) defaultBackend.dispose();
    diagnostics.saveReport(api, report); return report;
  } finally {
    if (probeBackend) { probeBackend.dispose(); probeBackend = null; }
    busy = false;
  }
}
function dispose() {
  if (defaultBackend) defaultBackend.dispose();
  if (probeBackend) probeBackend.dispose();
}
module.exports = { transcribe, dispose, createBackend, checkCompatibility, MODEL_PATH, CORE_FRAMES, CONTEXT_FRAMES };
