const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const core = require('../miniprogram/utils/swift-f0-core');
const swift = require('../miniprogram/utils/swift-f0');
const recognition = require('../miniprogram/utils/recognition');
const settings = require('../miniprogram/utils/recognition-settings');
const music = require('../miniprogram/utils/music');
const metadata = require('../miniprogram/models/swift-f0-meta.json');
const featureTools = require('../miniprogram/utils/swift-f0-features');
const diagnostics = require('../miniprogram/utils/recognition-diagnostics');
const { prepareModelFile } = require('../miniprogram/utils/swift-f0-model-file');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
async function test(label, action) { await action(); passed++; console.log('PASS ' + label); }
function tone(rate = 16000, seconds = 1, hz = 220) {
  return Float32Array.from({ length: rate * seconds }, (_, i) => .2 * Math.sin(2 * Math.PI * hz * i / rate));
}
function featureWindow() {
  return { features: new Float32Array(3 * 128 * featureTools.FRAMES), mask: new Float32Array(featureTools.FRAMES).fill(1), validFrames: featureTools.FRAMES };
}
function tensors(frames) {
  const logits = new Float32Array(frames * 95).fill(-20), confidence = new Float32Array(frames).fill(6);
  for (let i = 0; i < frames; i++) logits[i * 95 + 38] = 8;
  return { pitch_logits: { type: 'float32', data: logits.buffer, shape: [1, frames, 95] },
    voicing_logits: { type: 'float32', data: confidence.buffer, shape: [1, frames] } };
}
function apiMock(config = {}) {
  const state = { sessions: [], runs: [], values: new Map(), toasts: [], navigation: [], modals: [], files: new Map(), fileWrites: [], reads: [] };
  const fileSystem = {
    copyFile({ srcPath, destPath, success, fail }) {
      const bytes = state.files.get(srcPath);
      if (!bytes) { fail(Error('copyFile:fail source not found')); return; }
      state.files.set(destPath, bytes.slice(0));
      success();
    },
    readFileSync(name) {
      state.reads.push(name);
      if (!state.files.has(name)) throw Error('ENOENT: ' + name);
      const bytes = state.files.get(name).slice(0);
      if (!config.foreignBuffers) return bytes;
      const foreign = vm.runInNewContext('new ArrayBuffer(size)', { size: bytes.byteLength });
      new Uint8Array(foreign).set(new Uint8Array(bytes)); return foreign;
    },
    mkdirSync() { if (config.mkdirError) throw Error('mkdir permission denied'); },
    writeFileSync(name, bytes) {
      if (config.writeError) throw Error('writeFileSync:fail no space left');
      state.fileWrites.push(name); state.files.set(name, bytes.slice(0));
    },
    renameSync(from, to) {
      if (config.renameError) throw Error('renameSync:fail denied');
      if (!state.files.has(from)) throw Error('ENOENT: ' + from);
      state.files.set(to, state.files.get(from)); state.files.delete(from);
    },
    unlinkSync(name) { state.files.delete(name); }
  };
  const api = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    base64ToArrayBuffer(value) { const bytes = Buffer.from(value, 'base64'); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); },
    getFileSystemManager() { return fileSystem; },
    getStorageSync(key) { return state.values.get(key) || ''; },
    setStorageSync(key, value) { state.values.set(key, value); },
    showToast(value) { state.toasts.push(value); },
    showModal(value) { state.modals.push(value); },
    showLoading() {}, hideLoading() {},
    setClipboardData(value) { state.clipboard = value.data; },
    navigateTo(value) { state.navigation.push(value); },
    createInferenceSession(options) {
      if (config.createThrows) throw Error('create failed');
      const session = {
        options, destroyed: 0,
        onError(fn) { this.error = fn; if (config.loadError || config.loadErrorOnCnn && !options.model.includes('probe')) setTimeout(() => fn({ errMsg: 'unsupported', errCode: 1001 }), 0); },
        onLoad(fn) { this.load = fn; if (!config.holdLoad && !config.loadError && !(config.loadErrorOnCnn && !options.model.includes('probe'))) setTimeout(fn, 0); },
        run(input) {
          state.runs.push(input);
          if (config.runThrows) throw Error('run failed');
          if (config.holdRun) return new Promise((resolve, reject) => { this.resolveRun = resolve; this.rejectRun = reject; });
          if (config.badOutput) return Promise.resolve({});
          if (input.input) return Promise.resolve({ output: { type: 'float32', data: new Float32Array([3, 4]).buffer, shape: [1, 2] } });
          const result = tensors(input.features.shape[3]);
          if (config.foreignBuffers) for (const value of Object.values(result)) {
            const foreign = vm.runInNewContext('new ArrayBuffer(size)', { size: value.data.byteLength });
            new Uint8Array(foreign).set(new Uint8Array(value.data)); value.data = foreign;
          }
          return Promise.resolve(result);
        },
        destroy() { this.destroyed++; }
      };
      state.sessions.push(session); return session;
    }
  };
  return { api, state };
}

(async () => {
  await test('实验设置可持久化，损坏值或存储读取失败安全返回标准模式', () => {
    const { api } = apiMock();
    assert.equal(settings.getMode(api), 'standard');
    assert.equal(settings.setMode(api, 'swift-f0'), true);
    assert.equal(settings.getMode(api), 'swift-f0');
    assert.equal(settings.setMode(api, 'unknown'), false);
    assert.equal(settings.getMode({ getStorageSync() { throw Error('unavailable'); } }), 'standard');
  });
  await test('首页和路由启动不加载神经实现、模型常量或 YIN', () => {
    const script = "global.Page=function(){};require('./miniprogram/pages/index/index');require('./miniprogram/utils/recognition');const bad=Object.keys(require.cache).filter(p=>/utils[\\\\/](swift-f0|pitch)/.test(p)||/models[\\\\/]/.test(p));if(bad.length)throw Error(bad.join(','));";
    execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
  });
  await test('随包模型与元数据 SHA256 一致且附带 MIT 许可', () => {
    const bytes = fs.readFileSync(path.resolve(__dirname, '../miniprogram/models/swift-f0-cnn.onnx'));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), metadata.modelSha256);
    assert.deepEqual(require('../miniprogram/models/swift-f0-meta'), metadata);
    const coefficients = fs.readFileSync(path.resolve(__dirname, '../miniprogram/models/swift-f0-features-data.js'));
    assert.equal(crypto.createHash('sha256').update(coefficients).digest('hex'), metadata.featuresSha256);
    for (const name of ['swift-f0-cnn', 'inference-probe']) {
      const asset = require('../miniprogram/models/' + name + '-data');
      const embedded = Buffer.from(asset.base64, 'base64');
      assert.equal(embedded.length, asset.bytes); assert.equal(crypto.createHash('sha256').update(embedded).digest('hex'), asset.sha256);
      assert.deepEqual(embedded, fs.readFileSync(path.resolve(__dirname, '../miniprogram/models/' + name + '.onnx')));
    }
    assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, '../miniprogram/utils/swift-f0-core.js'), 'utf8'), /require\([^)]*\.json['"]\)/);
    assert.ok(bytes.length < 120000);
    assert.match(fs.readFileSync(path.resolve(__dirname, '../miniprogram/models/LICENSE.swift-f0.txt'), 'utf8'), /MIT License/);
  });
  await test('8k/44.1k/48k 重采样保留 440 Hz，降采样抑制带外混叠', async () => {
    for (const rate of [8000, 44100, 48000]) {
      const signal = await core.prepareSignal(tone(rate, 1, 440), rate);
      assert.equal(signal.length, 16000);
      let real = 0, imaginary = 0;
      for (let i = 1600; i < 14400; i++) {
        real += signal[i] * Math.cos(2 * Math.PI * 440 * i / 16000);
        imaginary += signal[i] * Math.sin(2 * Math.PI * 440 * i / 16000);
      }
      const amplitude = 2 * Math.hypot(real, imaginary) / 12800;
      assert.ok(Math.abs(amplitude - .2) < .003, rate + ': amplitude ' + amplitude);
    }
    const alias = await core.prepareSignal(tone(48000, 1, 12000), 48000);
    const rms = Math.sqrt(alias.subarray(1600, 14400).reduce((sum, v) => sum + v * v, 0) / 12800);
    assert.ok(rms < .002, 'alias RMS ' + rms);
  });
  await test('无效输入拒绝，准备信号和分割都能取消', async () => {
    await assert.rejects(core.prepareSignal(new Float32Array(100), 16000), e => e.code === 'INPUT');
    await assert.rejects(core.prepareSignal(new Float32Array(16000).fill(NaN), 16000), e => e.code === 'INPUT');
    await assert.rejects(core.prepareSignal(tone(), 16000, () => true), e => e.code === 'CANCELLED');
    const result = { pitch: new Float64Array(100).fill(220), confidence: new Float64Array(100).fill(.99), loudness: new Float64Array(100).fill(-10) };
    await assert.rejects(core.segmentPitch(result, () => true), e => e.code === 'CANCELLED');
  });
  await test('置信度与三格音高解码正确，静音门控且无效输出拒绝', () => {
    const native = tensors(8);
    const result = core.decodeLogits(new Float32Array(native.pitch_logits.data), new Float32Array(native.voicing_logits.data), 8);
    assert.ok(Math.abs(result.pitch[0] - metadata.pitchBinCenters[38]) < .001);
    assert.ok(result.confidence[0] > .99);
    const level = core.levels(new Float32Array(2048), result.confidence);
    assert.ok(result.confidence.every(v => v === 0) && level.every(v => v === -140));
    assert.throws(() => core.decodeLogits(new Float32Array(1), new Float32Array(8), 8), e => e.code === 'SWIFT_OUTPUT');
  });
  await test('全局分割保留换音与休止，同音间清晰休止分成两个音符', async () => {
    const pitch = Float64Array.from({ length: 200 }, (_, i) => 440 * 2 ** (((i < 100 ? 60 : 64) - 69) / 12));
    const confidence = new Float64Array(200).fill(.99), loudness = new Float64Array(200).fill(-10);
    const notes = await core.segmentPitch({ pitch, confidence, loudness });
    assert.equal(notes.length, 2); assert.equal(notes[0].start, 0); assert.equal(notes[0].end, 1.6);
    assert.equal(notes[1].start, 1.6); assert.equal(Math.round(notes[1].pitch), 64);
    pitch.fill(220); confidence.fill(0, 95, 105); loudness.fill(-100, 95, 105);
    const repeated = await core.segmentPitch({ pitch, confidence, loudness });
    assert.equal(repeated.length, 2); assert.ok(repeated[0].end < repeated[1].start);
  });
  await test('极短片段丢弃而非拉长覆盖邻音，长持续音拆分且不丢时长', () => {
    const events = [{ start: 0, end: .032, pitch: 60, firstFrame: 0, endFrame: 2 },
      { start: .032, end: .512, pitch: 64, firstFrame: 2, endFrame: 32 },
      { start: 1, end: 30, pitch: 67, firstFrame: 62, endFrame: 1875 }];
    const result = core.toEditorNotes(events, new Float64Array(1875).fill(.99), 100);
    assert.equal(result.droppedShort, 1); assert.equal(result.notes.length, 3);
    music.assertNoOverlaps(result.notes);
    assert.deepEqual(music.normalizeNotes(result.notes), result.notes);
    const final = result.notes[result.notes.length - 1];
    assert.equal(final.start + final.duration, 50);
  });
  await test('原生 session 复用、CPU 全精度配置及数据类型验证', async () => {
    const { api, state } = apiMock(); const backend = swift.createBackend(api);
    await backend.run(featureWindow()); await backend.run(featureWindow());
    assert.equal(state.sessions.length, 1); assert.equal(state.runs.length, 2);
    assert.equal(state.sessions[0].options.precisionLevel, 4);
    assert.equal(state.sessions[0].options.allowNPU, false);
    assert.equal(state.runs[0].features.type, 'float32');
    backend.dispose(); assert.equal(state.sessions[0].destroyed, 1);
  });
  await test('模型由内置 JS 写入本地绝对路径，校验缓存且不读取代码包路径', async () => {
    const { api, state } = apiMock();
    const backend = swift.createBackend(api); await backend.run(featureWindow());
    const model = state.sessions[0].options.model;
    assert.match(model, /^wxfile:\/\/usr\/humnote-models\/swift-f0-cnn-[0-9a-f]+\.onnx$/);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(state.files.get(model))).digest('hex'), metadata.modelSha256);
    assert.ok(state.reads.every(name => name.startsWith('wxfile://usr/')));
    backend.dispose(); const writes = state.fileWrites.length;
    const cached = prepareModelFile(api, false);
    assert.equal(cached.path, model); assert.equal(cached.cacheHit, true); assert.equal(state.fileWrites.length, writes);
  });
  await test('同长度损坏缓存被发现并重建，保留其余本地文件', () => {
    const { api, state } = apiMock(); const file = prepareModelFile(api, false);
    const corrupted = state.files.get(file.path).slice(0); new Uint8Array(corrupted)[20] ^= 255;
    state.files.set(file.path, corrupted); state.files.set('wxfile://usr/recording.wav', new ArrayBuffer(3));
    const repaired = prepareModelFile(api, false);
    assert.equal(repaired.cacheHit, false); assert.equal(state.files.get('wxfile://usr/recording.wav').byteLength, 3);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(state.files.get(file.path))).digest('hex'), metadata.modelSha256);
    assert.ok(Array.from(state.files.keys()).every(name => !name.endsWith('.part')));
  });
  await test('微信跨运行环境缓冲区可回读校验和推理，不依赖 instanceof', async () => {
    const { api } = apiMock({ foreignBuffers: true }); const prepared = prepareModelFile(api, false);
    assert.equal(prepareModelFile(api, false).cacheHit, true);
    const backend = swift.createBackend(api); const result = await backend.run(featureWindow());
    assert.equal(result.pitch.length, 152 * 95); assert.equal(result.modelFile.path, prepared.path); backend.dispose();
  });
  await test('写模型失败明确报 file 阶段，不继续调用原生模型加载', async () => {
    const { api, state } = apiMock({ writeError: true });
    await assert.rejects(swift.createBackend(api).ready(), e => e.code === 'SWIFT_FILE' && e.stage === 'file' && /no space left/.test(e.detail));
    assert.equal(state.sessions.length, 0); assert.equal(state.files.size, 0);
  });
  await test('模型展开截断会在写入前拒绝，不被误诊为硬件不支持', async () => {
    const { api, state } = apiMock(); api.base64ToArrayBuffer = () => new ArrayBuffer(1);
    await assert.rejects(swift.createBackend(api).ready(), e => e.code === 'SWIFT_FILE' && /不完整/.test(e.detail));
    assert.equal(state.fileWrites.length, 0); assert.equal(state.sessions.length, 0);
    assert.match(diagnostics.explanation({ failure: { code: 'SWIFT_NATIVE', detail: 'createInferenceSession:fail:model path invalid : %s' } }), /文件准备或路径解析/);
  });
  await test('原子重命名失败清理临时模型，后续重试可恢复', async () => {
    const config = { renameError: true }; const { api, state } = apiMock(config); const backend = swift.createBackend(api);
    await assert.rejects(backend.ready(), e => e.code === 'SWIFT_FILE' && /renameSync/.test(e.detail));
    assert.equal(state.files.size, 0); config.renameError = false;
    await backend.ready(); assert.equal(state.sessions.length, 1); backend.dispose();
  });
  await test('同步建模异常和异步不支持错误都可观察并释放资源', async () => {
    const a = apiMock({ createThrows: true });
    await assert.rejects(swift.createBackend(a.api).ready(), e => e.code === 'SWIFT_LOAD');
    const b = apiMock({ loadError: true });
    await assert.rejects(swift.createBackend(b.api).ready(), e => e.code === 'SWIFT_NATIVE');
    assert.equal(b.state.sessions[0].destroyed, 1);
  });
  await test('模型加载超时后可重建，旧 onLoad 不污染新 session', async () => {
    const config = { holdLoad: true }; const { api, state } = apiMock(config);
    const backend = swift.createBackend(api, { loadTimeout: 5 });
    await assert.rejects(backend.ready(), e => e.code === 'SWIFT_LOAD');
    config.holdLoad = false;
    const next = await backend.ready();
    state.sessions[0].load();
    assert.equal(next.session, state.sessions[1]); assert.equal(state.sessions[0].destroyed, 1);
    await backend.run(featureWindow()); backend.dispose();
  });
  await test('推理超时释放 session，晚到结果不会恢复已销毁资源', async () => {
    const { api, state } = apiMock({ holdRun: true });
    const backend = swift.createBackend(api, { runTimeout: 5 });
    await assert.rejects(backend.run(featureWindow()), e => e.code === 'SWIFT_RUN');
    state.sessions[0].resolveRun(tensors(62)); await tick(0);
    assert.equal(state.sessions[0].destroyed, 1);
  });
  await test('推理中原生 onError 拒绝等待者，异常尺寸输出拒绝', async () => {
    const { api, state } = apiMock({ holdRun: true }); const backend = swift.createBackend(api);
    const pending = backend.run(featureWindow());
    await tick(2); state.sessions[0].error({ errMsg: 'native failed' });
    await assert.rejects(pending, e => e.code === 'SWIFT_NATIVE');
    const bad = swift.createBackend(apiMock({ badOutput: true }).api);
    await assert.rejects(bad.run(featureWindow()), e => e.code === 'SWIFT_OUTPUT'); bad.dispose();
  });
  await test('模型等待可取消并释放，取消不进入标准回退', async () => {
    const { api, state } = apiMock({ holdLoad: true }); let cancelled = false;
    const pending = recognition.transcribe(tone(), 16000, 100, null, () => cancelled, { mode: 'swift-f0', api });
    setTimeout(() => { cancelled = true; }, 3);
    await assert.rejects(pending, e => e.code === 'CANCELLED');
    assert.equal(state.sessions[0].destroyed, 1);
  });
  await test('运行失败可回退到真实 YIN，结果保留实际引擎与回退原因', async () => {
    const stages = [], api = apiMock({ loadError: true }).api;
    const result = await recognition.transcribe(tone(), 16000, 100, null, null, { mode: 'swift-f0', api, onStage: s => stages.push(s) });
    assert.equal(result.engine, 'yin'); assert.equal(result.fallbackFrom, 'swift-f0');
    assert.equal(result.fallbackReason, 'SWIFT_NATIVE'); assert.ok(result.notes.length);
    assert.ok(stages.some(s => s.includes('标准识别')));
  });
  await test('静音 NO_NOTES 与无效输入不被掩盖为标准识别', async () => {
    const { api } = apiMock();
    await assert.rejects(recognition.transcribe(new Float32Array(16000), 16000, 100, null, null, { mode: 'swift-f0', api }), e => e.code === 'NO_NOTES');
    await assert.rejects(recognition.transcribe(new Float32Array(10), 16000, 100, null, null, { mode: 'swift-f0', api }), e => e.code === 'INPUT');
    recognition.dispose();
  });
  await test('实验完整流程分块进度单调且不超过 100，结果满足编辑器约束', async () => {
    const { api, state } = apiMock(); const progress = [];
    const result = await recognition.transcribe(tone(16000, 5), 16000, 100, p => progress.push(p), null, { mode: 'swift-f0', api });
    assert.equal(result.engine, 'swift-f0'); assert.ok(state.runs.length > 1);
    assert.ok(progress.every((v, i) => v >= 0 && v <= 100 && (!i || v >= progress[i - 1])));
    assert.equal(progress.at(-1), 100); music.assertNoOverlaps(result.notes);
    assert.deepEqual(music.normalizeNotes(result.notes), result.notes); recognition.dispose();
  });
  await test('频谱静音值正确，固定窗口零填充与有效帧 mask 不延长录音', async () => {
    const spectral = await featureTools.extract(new Float32Array(16000));
    assert.equal(spectral.frames, 62);
    assert.ok(spectral.values.every(v => Math.abs(v - Math.log(1e-8)) < 1e-6));
    const part = featureTools.block(spectral, 0, spectral.frames);
    assert.equal(part.features.length, 3 * 128 * 152); assert.equal(part.validFrames, 62);
    assert.ok(part.mask.subarray(0, 62).every(v => v === 1)); assert.ok(part.mask.subarray(62).every(v => v === 0));
    for (let band = 0; band < 3 * 128; band++) assert.ok(part.features.subarray(band * 152 + 62, (band + 1) * 152).every(v => v === 0));
    await assert.rejects(featureTools.extract(tone(16000, 2), () => true), e => e.code === 'CANCELLED');
  });
  await test('诊断只保留机型和版本等必要信息，不含设备标识和录音', () => {
    const runtime = diagnostics.runtime({ createInferenceSession() {}, getDeviceInfo: () => ({ model: 'test', deviceId: 'private', system: 'Android' }),
      getAppBaseInfo: () => ({ version: '8.x', SDKVersion: '3.x', privateToken: 'secret' }) });
    assert.equal(runtime.model, 'test'); assert.equal(runtime.wechat, '8.x');
    assert.doesNotMatch(JSON.stringify(runtime), /private|secret|deviceId|recording|audio/);
  });
  await test('兼容性检查区分基础接口缺失并保存具体阶段，不标记硬件不支持', async () => {
    const { api } = apiMock(); delete api.createInferenceSession;
    const report = await swift.checkCompatibility(api);
    assert.equal(report.ok, false); assert.equal(report.failedCheck, 'engine'); assert.equal(report.failure.code, 'SWIFT_UNAVAILABLE');
    assert.equal(diagnostics.lastReport(api), report); assert.match(diagnostics.explanation(report), /不能判定手机硬件不支持/);
  });
  await test('基础 Add 通过而 CNN 加载失败时定位模型，不混淆成接口缺失', async () => {
    const { api, state } = apiMock({ loadErrorOnCnn: true });
    const report = await swift.checkCompatibility(api);
    assert.equal(report.engine, 'passed'); assert.equal(report.failedCheck, 'model'); assert.equal(report.failure.stage, 'load');
    assert.match(report.failure.detail, /unsupported/); assert.equal(report.failure.nativeCode, '1001');
    assert.match(report.failure.modelFile.path, /^wxfile:\/\/usr\//);
    assert.equal(report.modelSha256, metadata.modelSha256); assert.equal(state.sessions.length, 2); swift.dispose();
  });
  await test('兼容性检查真实执行两个模型，成功不宣称真人录音准确度', async () => {
    const { api, state } = apiMock();
    const report = await swift.checkCompatibility(api);
    assert.equal(report.ok, true); assert.equal(report.engine, 'passed'); assert.equal(report.model, 'passed');
    assert.equal(state.runs.length, 2); assert.match(diagnostics.explanation(report), /准确度仍需/); swift.dispose();
  });
  await test('取消兼容性检查释放 probe，不覆盖上一次可用诊断', async () => {
    const { api, state } = apiMock({ holdLoad: true }); const previous = { old: true }; diagnostics.saveReport(api, previous);
    let cancelled = false; const pending = swift.checkCompatibility(api, () => cancelled);
    setTimeout(() => { cancelled = true; }, 3);
    await assert.rejects(pending, e => e.code === 'CANCELLED');
    assert.equal(state.sessions[0].destroyed, 1); assert.equal(diagnostics.lastReport(api), previous);
  });
  let pageDefinition;
  global.Page = value => { pageDefinition = value; };
  require('../miniprogram/pages/index/index');
  function page() {
    return Object.assign({}, pageDefinition, { alive: true, cancelled: false,
      data: JSON.parse(JSON.stringify(pageDefinition.data)), setData(value) { Object.assign(this.data, value); }, refresh() {} });
  }
  await test('页面模式选择持久化，录音与识别期间无法切换', () => {
    const { api } = apiMock(); global.wx = api; const instance = page();
    assert.equal(instance.changeRecognitionMode({ currentTarget: { dataset: { mode: 'swift-f0' } } }), true);
    assert.equal(settings.getMode(api), 'swift-f0');
    for (const key of ['recording', 'starting', 'processing', 'checkingRecognition']) {
      instance.data[key] = true;
      assert.equal(instance.changeRecognitionMode({ currentTarget: { dataset: { mode: 'standard' } } }), false);
      instance.data[key] = false;
    }
  });
  await test('页面兼容性检查防重入，复制报告由用户确认触发', async () => {
    const { api, state } = apiMock({ loadError: true }); global.wx = api; const instance = page();
    instance.data.checkingRecognition = true;
    assert.equal(await instance.checkRecognitionCompatibility(), false); assert.equal(state.sessions.length, 0);
    instance.data.checkingRecognition = false;
    assert.equal(await instance.checkRecognitionCompatibility(), false); assert.equal(instance.data.checkingRecognition, false);
    assert.equal(state.clipboard, undefined); assert.equal(state.modals.length, 1);
    state.modals[0].success({ confirm: true });
    assert.equal(JSON.parse(state.clipboard).failure.code, 'SWIFT_NATIVE');
  });
  const audio = require('../miniprogram/utils/audio'), storage = require('../miniprogram/utils/storage');
  const originals = { decode: audio.decodeFile, recording: storage.saveRecording, save: storage.save, remove: storage.removeFile };
  try {
    audio.decodeFile = async () => ({ samples: tone(), sampleRate: 16000 });
    storage.saveRecording = async () => '/mock-only/source.wav';
    storage.removeFile = () => {};
    await test('实验成功保存引擎标记、原音和音符，正常进入编辑页', async () => {
      const { api, state } = apiMock(); global.wx = api; let saved;
      state.files.set('/mock-only/input.wav', new Uint8Array([1, 2, 3]).buffer);
      storage.save = idea => { saved = idea; return idea; };
      const instance = page(); instance.data.recognitionMode = 'swift-f0';
      await instance.finishRecording({ duration: 1000, tempFilePath: '/mock-only/input.wav' });
      assert.equal(saved.recognitionEngine, 'swift-f0'); assert.equal(saved.source, '/mock-only/source.wav');
      assert.equal(saved.recognitionProfile, 'humming-notes-v3');
      assert.equal(saved.recognitionFallback, null); assert.equal(state.navigation.length, 1);
      assert.equal(storage.pendingRecordings().length, 0);
      assert.equal(instance.data.processing, false); recognition.dispose();
    });
    await test('回退保存标准标记且切回标准模式，提示与实际结果一致', async () => {
      const { api, state } = apiMock({ loadError: true }); global.wx = api; let saved;
      state.files.set('/mock-only/input.wav', new Uint8Array([1, 2, 3]).buffer);
      storage.save = idea => { saved = idea; return idea; };
      const instance = page(); instance.data.recognitionMode = 'swift-f0';
      await instance.finishRecording({ duration: 1000, tempFilePath: '/mock-only/input.wav' });
      assert.equal(saved.recognitionEngine, 'yin'); assert.equal(saved.recognitionFallback, 'swift-f0');
      assert.equal(saved.recognitionDiagnostic.failure.stage, 'load'); assert.match(saved.recognitionDiagnostic.failure.detail, /unsupported/);
      assert.equal(instance.data.recognitionMode, 'standard'); assert.equal(settings.getMode(api), 'standard');
      assert.ok(state.toasts.some(v => v.title.includes('切回标准'))); assert.equal(state.navigation.length, 1);
    });
    await test('取消模型加载会保留待识别录音，结束后可从原文件重试', async () => {
      const { api, state } = apiMock({ holdLoad: true }); global.wx = api; let saved = 0;
      const original = new Uint8Array([1, 2, 3]).buffer;
      state.files.set('/mock-only/input.wav', original);
      storage.save = idea => { saved++; return idea; };
      const instance = page(); instance.data.recognitionMode = 'swift-f0';
      const pending = instance.finishRecording({ duration: 1000, tempFilePath: '/mock-only/input.wav' });
      await tick(2); assert.equal(instance.cancelRecognition(), true); await pending;
      assert.equal(saved, 0); assert.equal(state.navigation.length, 0); assert.equal(instance.data.processing, false);
      const [recording] = storage.pendingRecordings();
      assert.deepEqual(state.files.get(recording.path), original);
      instance.data.recognitionMode = 'standard';
      assert.equal(await instance.retryPendingRecording({ currentTarget: { dataset: { id: recording.id } } }), true);
      assert.equal(saved, 1); assert.equal(state.navigation.length, 1);
      assert.equal(storage.pendingRecordings().length, 0);
      assert.equal(state.files.has(recording.path), false);
    });
  } finally {
    audio.decodeFile = originals.decode; storage.saveRecording = originals.recording;
    storage.save = originals.save; storage.removeFile = originals.remove; recognition.dispose(); delete global.Page; delete global.wx;
  }
  console.log('\n' + passed + ' SwiftF0 experimental checks passed. Native mobile inference is covered by an adapter mock, not real-device validation.');
})().catch(error => { recognition.dispose(); console.error(error); process.exitCode = 1; });
