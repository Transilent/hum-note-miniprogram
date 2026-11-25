const assert = require('node:assert/strict');
const core = require('../miniprogram/utils/swift-f0-core');
const notes = require('../miniprogram/utils/swift-f0-notes');
const features = require('../miniprogram/utils/swift-f0-features');
const { onsetStrength, splitRepeatedOnsets } = require('../miniprogram/utils/swift-f0-onsets');
const profile = require('../miniprogram/utils/swift-f0-note-config');
const { conditionSignal } = require('../miniprogram/utils/swift-f0-preprocess');
const music = require('../miniprogram/utils/music');
const { encodeMidi } = require('../miniprogram/utils/midi');
const { readMidi } = require('../tools/humtrans-metrics.cjs');
const { createVariation } = require('../miniprogram/utils/composition');
const { synthesize } = require('../miniprogram/utils/audio');
let passed = 0;
async function test(name, action) { await action(); console.log('PASS ' + name); passed++; }
function frame(midis, confidence = .98) {
  return { pitch: Float64Array.from(midis, midi => 440 * 2 ** ((midi - 69) / 12)),
    confidence: new Float64Array(midis.length).fill(confidence), loudness: new Float64Array(midis.length).fill(-20) };
}
function tone(amplitude = .2, seconds = 1) { return Float32Array.from({ length: 16000 * seconds }, (_, i) => amplitude * Math.sin(2 * Math.PI * 220 * i / 16000)); }
async function refined(frame) {
  const penalties = await notes.transitionPenalties(frame, profile.transition);
  const events = await core.segmentPitch(frame, null, null, { penalties, gapBias: profile.gapBias });
  return notes.refineRepeats(events, frame, profile.repeat);
}
const convert = (events, values) => core.toEditorNotes(events, values.confidence, 100, {
  pitch: values.pitch, minimumBeats: .0625, minimumConfidence: .85, maximumDeviation: .4 });
(async () => {
  await test('稳定高置信度的 64ms 短促换音独立保留，原版会合并', async () => {
    const values = frame([...Array(40).fill(69), ...Array(4).fill(71), ...Array(40).fill(69)]);
    const original = await core.segmentPitch(values), after = await refined(values);
    assert.equal(original.length, 1); assert.equal(after.length, 3);
    const result = convert(after, values); assert.equal(result.notes.length, 3); assert.equal(result.notes[1].midi, 71);
    assert.ok(result.notes[1].duration < .125); music.assertNoOverlaps(result.notes);
    assert.deepEqual(music.normalizeNotes(result.notes), result.notes);
  });
  await test('清晰半音短回转可分开，原音高与休止不被整体量化', async () => {
    const values = frame([...Array(40).fill(69), ...Array(8).fill(70), ...Array(40).fill(69)]);
    const original = await core.segmentPitch(values), after = await refined(values);
    assert.equal(original.length, 1); assert.equal(after.length, 3); assert.equal(Math.round(after[1].pitch), 70);
  });
  await test('连续滑音不会被稳定换音检测当成一串新起音', async () => {
    const values = frame(Array.from({ length: 100 }, (_, i) => 60 + i * .04));
    const penalties = await notes.transitionPenalties(values, profile.transition);
    assert.ok(penalties.every(v => v === 5));
  });
  await test('自然颤音和单纯音量起伏保持一个连续长音', async () => {
    const values = frame(Array.from({ length: 200 }, (_, i) => 69 + .3 * Math.sin(i * .016 * 2 * Math.PI * 5.5)));
    values.loudness = Float64Array.from({ length: 200 }, (_, i) => -30 + 3 * Math.cos(i * .016 * 2 * Math.PI * 4));
    const after = await refined(values); assert.equal(after.length, 1); assert.equal(after[0].end, 3.2);
    values.loudness = Float64Array.from({ length: 200 }, (_, i) => -30 + 12 * Math.cos(i * .016 * 2 * Math.PI * 4));
    const unchanged = await notes.refineRepeats([{ start: 0, end: 3.2, firstFrame: 0, endFrame: 200, pitch: 69 }], values, profile.repeat);
    assert.equal(unchanged.length, 1, 'extra repeat detector must require more than amplitude fluctuation');
  });
  await test('同音重起需音量谷与置信度回落共同支持，并保留小休止', async () => {
    const values = frame(Array(100).fill(69)); values.confidence[50] = .65; values.loudness[50] = -35;
    const event = { firstFrame: 0, endFrame: 100, start: 0, end: 1.6, pitch: 69 };
    const after = await notes.refineRepeats([event], values, profile.repeat);
    assert.equal(after.length, 2); assert.ok(after[0].end < after[1].start); assert.equal(after[1].end, event.end);
  });
  await test('频谱起音保留孤立的同音重唱，并避开有周期的强弱和音高颤动', async () => {
    for (const [hz, rate] of [[165, 6], [220, 8], [330, 4], [220, 0]]) {
      const signal = Float32Array.from({ length: 32000 }, (_, i) => {
        const t = i / 16000, modulation = 2 * Math.PI * rate * t;
        const phase = t * 2 * Math.PI * hz + (rate ? hz * .025 / rate * Math.sin(modulation) : 0);
        const dip = (t - .94) ** 2 / .0005;
        const gain = rate ? .24 * (1 + .75 * Math.sin(modulation)) : .3 - .26 * Math.exp(-dip);
        return gain * (Math.sin(phase) + .35 * Math.sin(phase * 2));
      });
      const spectral = await features.extract(signal);
      const strength = await onsetStrength(spectral, features.BANDS);
      const confidence = new Float64Array(spectral.frames).fill(.96);
      const pitch = Float64Array.from(confidence,
        (_, index) => hz * (rate ? 1 + .025 * Math.cos(index * core.STEP * 2 * Math.PI * rate) : 1));
      const event = { firstFrame: 0, endFrame: spectral.frames, start: 0, end: 2, pitch: music.midiPitch(hz) };
      const values = { pitch, confidence, loudness: core.levels(signal, confidence) };
      const result = splitRepeatedOnsets([event], values, strength, profile.onsets);
      assert.equal(result.length, rate ? 1 : 2, hz + ' Hz');
      if (!rate) {
        assert.ok(Math.abs(result[1].start - .94) < .05);
        assert.deepEqual(convert(result, values).notes.map(note => note.midi), [57, 57]);
      }
    }
  });
  await test('48ms 稳定短音可保存，不稳定或不足两帧的片段仍拒绝', () => {
    const values = frame(Array(10).fill(69)); const event = { firstFrame: 0, endFrame: 3, start: 0, end: .048, pitch: 69 };
    assert.equal(convert([event], values).notes[0].duration, .08);
    values.confidence.fill(.6); assert.throws(() => convert([event], values), e => e.code === 'NO_NOTES');
    values.confidence.fill(.98); assert.throws(() => convert([Object.assign({}, event, { end: .032, endFrame: 2 })], values), e => e.code === 'NO_NOTES');
  });
  await test('短音经规范化和独立 MIDI 回读仍保留原起点与长度', () => {
    const source = [{ id: 'short', midi: 69, start: .123, duration: .08, velocity: 85 }];
    const normalized = music.normalizeNotes(source); assert.equal(normalized[0].duration, .08);
    const decoded = readMidi(Buffer.from(encodeMidi(normalized, 100)));
    assert.equal(decoded.length, 1); assert.ok(Math.abs(decoded[0].start - .123 * .6) <= .6 / 480);
    assert.ok(Math.abs(decoded[0].end - .203 * .6) <= .6 / 480);
  });
  await test('创作复制和逆行保留短音，减值越过新下限仍明确拒绝', () => {
    const source = [{ id: 'a', midi: 69, start: 0, duration: .08 }, { id: 'b', midi: 72, start: .2, duration: .1 }];
    const repeated = createVariation(source, { preset: 'repeat', mode: 'append' });
    assert.equal(repeated.notes.length, 4); assert.equal(repeated.notes[0].duration, .08);
    const reversed = createVariation(source, { preset: 'retrograde', mode: 'replace' });
    assert.deepEqual(reversed.notes.map(n => n.duration), [.1, .08]);
    assert.throws(() => createVariation(source, { preset: 'diminish', mode: 'replace' }), /0.0625/);
  });
  await test('连续三个短音在试听合成中各自发声，并保留音间留白', () => {
    const source = [{ midi: 69, start: 0, duration: .08 }, { midi: 71, start: .3, duration: .107 }, { midi: 69, start: .6, duration: .08 }];
    const rendered = synthesize(source, 100, 'piano', 16000);
    function rms(start, end) { const part = rendered.samples.subarray(Math.round(start * 16000), Math.round(end * 16000));
      return Math.sqrt(part.reduce((sum, value) => sum + value * value, 0) / part.length); }
    for (const n of source) assert.ok(rms(n.start * .6 + .01, n.start * .6 + .03) > .001);
    assert.ok(rms(.145, .165) < .00001);
  });
  await test('有周期性的轻声得到有上限的补偿，原始样本不被修改', async () => {
    const source = tone(.001), before = source.slice(); const result = await conditionSignal(source);
    assert.ok(result.gain > 1 && result.gain <= 64); assert.ok(Math.max(...result.samples) > .05);
    assert.deepEqual(source, before);
  });
  await test('正常音量不额外归一化，直流静音会被去除', async () => {
    const source = tone(); const normal = await conditionSignal(source); assert.equal(normal.samples, source); assert.equal(normal.gain, 1);
    const constant = new Float32Array(16000).fill(.01); const result = await conditionSignal(constant);
    assert.equal(result.dcRemoved, true); assert.equal(result.gain, 1); assert.ok(result.samples.every(v => Math.abs(v) < 1e-8));
  });
  await test('低音量随机噪声不因电平小而自动被放大', async () => {
    let seed = 123456; const signal = Float32Array.from({ length: 32000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 2 ** 32 - .5) * .002;
    });
    const result = await conditionSignal(signal); assert.equal(result.gain, 1); assert.deepEqual(result.samples, signal);
  });
  await test('新增音量处理和音符修整均响应取消', async () => {
    await assert.rejects(conditionSignal(tone(.001), () => true), e => e.code === 'CANCELLED');
    const values = frame(Array(100).fill(69));
    await assert.rejects(notes.transitionPenalties(values, profile.transition, () => true), e => e.code === 'CANCELLED');
    await assert.rejects(notes.refineRepeats([], values, profile.repeat, () => true), e => e.code === 'CANCELLED');
  });
  console.log('\n' + passed + ' SwiftF0 accuracy checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
