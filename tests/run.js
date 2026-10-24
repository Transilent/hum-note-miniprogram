const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const music = require('../miniprogram/utils/music');
const { transcribe, framesToNotes } = require('../miniprogram/utils/pitch');
const { encodeMidi, vlq } = require('../miniprogram/utils/midi');
const { encodeWav, decodeWav } = require('../miniprogram/utils/wav');
const { synthesize } = require('../miniprogram/utils/audio');
let count = 0;
function check(label, fn) { fn(); count++; console.log('PASS  ' + label); }
async function asyncCheck(label, fn) { await fn(); count++; console.log('PASS  ' + label); }

function hum(pitches, sampleRate, options) {
  const opts = Object.assign({ seconds: .6, gap: .13, lead: .15, noise: .002, vibrato: .12, dc: 0 }, options);
  const duration = opts.lead + pitches.length * (opts.seconds + opts.gap) + .15;
  const samples = new Float32Array(Math.ceil(duration * sampleRate));
  let seed = 91;
  for (let i = 0; i < samples.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; samples[i] = (seed / 4294967296 * 2 - 1) * opts.noise + opts.dc; }
  pitches.forEach((midi, index) => {
    const first = Math.round((opts.lead + index * (opts.seconds + opts.gap)) * sampleRate);
    let phase = 0;
    for (let i = 0; i < Math.round(opts.seconds * sampleRate); i++) {
      const t = i / sampleRate, f = music.frequency(midi + opts.vibrato * Math.sin(2 * Math.PI * 5 * t));
      phase += 2 * Math.PI * f / sampleRate;
      const envelope = Math.min(1, t / .025, (opts.seconds - t) / .03);
      samples[first + i] += envelope * .35 * (Math.sin(phase) + .35 * Math.sin(2 * phase) + .12 * Math.sin(3 * phase));
    }
  });
  return samples;
}

function parseMidi(buffer) {
  const b = Buffer.from(buffer);
  assert.equal(b.toString('ascii', 0, 4), 'MThd'); assert.equal(b.readUInt32BE(4), 6);
  assert.equal(b.readUInt16BE(8), 0); assert.equal(b.readUInt16BE(10), 1); assert.equal(b.readUInt16BE(12), 480);
  assert.equal(b.toString('ascii', 14, 18), 'MTrk'); assert.equal(b.readUInt32BE(18), b.length - 22);
  let at = 22, tick = 0; const notes = [], active = new Map(); let tempo;
  const variable = () => { let n = 0, value; do { value = b[at++]; n = n * 128 + (value & 127); } while (value & 128); return n; };
  while (at < b.length) {
    tick += variable(); const status = b[at++];
    if (status === 0xff) {
      const type = b[at++], size = variable();
      if (type === 0x51) tempo = b.readUIntBE(at, 3);
      if (type === 0x2f) { assert.equal(active.size, 0); break; }
      at += size;
    } else if ((status & 0xf0) === 0xc0) at++;
    else {
      const pitch = b[at++], velocity = b[at++];
      if ((status & 0xf0) === 0x90 && velocity > 0) { assert.ok(!active.has(pitch)); active.set(pitch, { midi: pitch, start: tick / 480, velocity }); }
      else { const note = active.get(pitch); assert.ok(note, 'note-off must have a matching note-on'); note.duration = tick / 480 - note.start; notes.push(note); active.delete(pitch); }
    }
  }
  return { notes, tempo, bpm: 60000000 / tempo };
}

(async () => {
  check('音高命名和标准 A4 调音', () => { assert.equal(music.noteName(60), 'C4'); assert.equal(music.frequency(69), 440); assert.equal(music.midiPitch(440), 69); });
  check('延长音符只改自身，后续起点和临时重叠均保留', () => {
    const notes = [{ id: 'a', midi: 60, start: 0, duration: 1 }, { id: 'b', midi: 64, start: 1.5, duration: 1 }];
    const edited = music.changeDuration(notes, 'a', 2);
    assert.equal(edited[0].duration, 2); assert.equal(edited[1].start, 1.5); assert.equal(notes[0].duration, 1);
    assert.deepEqual(music.getOverlaps(edited).ids.sort(), ['a', 'b']);
  });
  check('不重叠输入的量化与最短时值', () => {
    const notes = music.quantize([{ midi: 60, start: .1, duration: .14 }, { midi: 62, start: .29, duration: .19 }], .25);
    assert.equal(notes[0].start, 0); assert.equal(notes[0].duration, .25); assert.ok(notes[1].start >= .25);
  });
  check('横移可以调整空拍、穿过其他音符，其他起点不会被改写', () => {
    const source = [{ id: 'a', midi: 60, start: 0, duration: 1 }, { id: 'b', midi: 64, start: 2, duration: 1 }, { id: 'c', midi: 67, start: 4, duration: 1 }];
    const moved = music.moveNote(source, 'b', .5);
    assert.equal(moved.find(n => n.id === 'b').start, .5); assert.equal(moved.find(n => n.id === 'c').start, 4);
    assert.equal(source[1].start, 2); assert.equal(music.getOverlaps(moved).pairCount, 1);
    assert.equal(music.moveNote(source, 'b', -1).find(n => n.id === 'b').start, 0);
  });
  check('重叠检测包含嵌套和不同音高，首尾相接不算重叠', () => {
    const source = [{ id: 'a', midi: 60, start: 0, duration: 4 }, { id: 'b', midi: 64, start: 1, duration: .5 }, { id: 'c', midi: 67, start: 2, duration: .5 }];
    assert.deepEqual(music.getOverlaps(source).ids.sort(), ['a', 'b', 'c']); assert.equal(music.getOverlaps(source).pairCount, 2);
    assert.equal(music.getOverlaps([{ id: 'a', start: 0, duration: .3 }, { id: 'b', start: .3, duration: 1 }]).pairCount, 0);
  });
  check('量化产生的临时重叠会被标出，而不会偷偷移动音符', () => {
    const source = [{ id: 'a', midi: 60, start: .13, duration: .38 }, { id: 'b', midi: 64, start: .52, duration: .3 }];
    assert.equal(music.getOverlaps(source).pairCount, 0);
    const notes = music.quantize(source, .25);
    assert.equal(notes[0].start, .25); assert.equal(notes[1].start, .5); assert.equal(music.getOverlaps(notes).pairCount, 1);
  });
  check('有重叠时 MIDI 写出明确拒绝，原始起点不被更改', () => {
    const notes = [{ id: 'a', midi: 60, start: 0, duration: 2 }, { id: 'b', midi: 64, start: 1, duration: 1 }];
    assert.throws(() => encodeMidi(notes, 100), error => error.code === 'NOTE_OVERLAP'); assert.equal(notes[1].start, 1);
  });
  check('真人式半音边界抖动保持为一个稳定音符', () => {
    const frames = Array.from({ length: 80 }, (_, i) => ({ midi: i < 10 ? 60 : i % 2 ? 60.55 : 60.45, confidence: .98, rms: .2 }));
    const notes = framesToNotes(frames, .015, 100);
    assert.equal(notes.length, 1); assert.equal(notes[0].midi, 60); assert.ok(notes[0].duration > 1.9);
  });
  check('两帧有声漏检可以桥接，不会截断持续音', () => {
    const frames = Array.from({ length: 50 }, (_, i) => ({ midi: i === 24 || i === 25 ? null : 60, confidence: i === 24 || i === 25 ? 0 : .98, rms: .2 }));
    assert.equal(framesToNotes(frames, .015, 100).length, 1);
  });
  check('清晰休止保留为留白，不因前后同音被连起来', () => {
    const frames = Array.from({ length: 50 }, (_, i) => ({ midi: i >= 23 && i < 27 ? null : 60, confidence: i >= 23 && i < 27 ? 0 : .98, rms: i >= 23 && i < 27 ? 0 : .2 }));
    const notes = framesToNotes(frames, .015, 100);
    assert.equal(notes.length, 2); assert.ok(notes[1].start - (notes[0].start + notes[0].duration) >= .099);
  });
  check('同音中的明显音量谷和恢复能分出重复起音', () => {
    const frames = Array.from({ length: 60 }, (_, i) => ({ midi: 60, confidence: .98, rms: i === 30 ? .03 : .2 }));
    const notes = framesToNotes(frames, .015, 100);
    assert.equal(notes.length, 2); assert.ok(notes.every(n => n.midi === 60)); assert.equal(music.getOverlaps(notes).pairCount, 0);
  });
  check('MIDI 变长整数编码边界', () => { assert.deepEqual(vlq(0), [0]); assert.deepEqual(vlq(127), [127]); assert.deepEqual(vlq(128), [129, 0]); assert.deepEqual(vlq(16384), [129, 128, 0]); });
  check('MIDI 文件可独立解析，音高、起点、时值和速度一致', () => {
    const source = music.demo(100), result = parseMidi(encodeMidi(source.notes, source.bpm));
    assert.equal(result.bpm, 100); assert.equal(result.notes.length, source.notes.length);
    result.notes.forEach((note, i) => { assert.equal(note.midi, source.notes[i].midi); assert.equal(note.start, source.notes[i].start); assert.equal(note.duration, source.notes[i].duration); });
  });
  check('同音相邻时，前一音符结束后才开始下一个', () => {
    const source = [{ midi: 60, start: 0, duration: 1 }, { midi: 60, start: 1, duration: 1 }];
    assert.equal(parseMidi(encodeMidi(source, 120)).notes.length, 2);
  });
  check('WAV 16-bit 编解码和实际采样率', () => {
    const data = new Float32Array([-.9, -.2, 0, .3, .9]);
    const result = decodeWav(encodeWav(data, 48000)); assert.equal(result.sampleRate, 48000);
    data.forEach((value, i) => assert.ok(Math.abs(result.samples[i] - value) < .00004));
    assert.equal(decodeWav(new Uint8Array([1, 2, 3]).buffer), null);
  });
  check('试听合成时长跟随 BPM，空白和起音无削波', () => {
    const source = [{ midi: 69, start: 1, duration: 1, velocity: 90 }];
    const audio = synthesize(source, 120, 'piano', 22050);
    assert.ok(Math.abs(audio.duration - 1.3) < .001); assert.equal(audio.samples[0], 0);
    assert.ok(audio.samples.every(v => Number.isFinite(v) && Math.abs(v) <= 1));
    assert.equal(audio.samples[Math.round(.2 * audio.sampleRate)], 0);
  });
  for (const rate of [16000, 44100, 48000]) {
    await asyncCheck(rate + ' Hz 合成哼唱：带谐波、轻颤音、噪声与音间休止', async () => {
      const pitches = [48, 52, 55, 60, 64, 69, 72, 76];
      const signal = hum(pitches, rate);
      const result = await transcribe(signal, rate, 100);
      assert.deepEqual(result.notes.map(n => n.midi), pitches);
      result.notes.forEach((n, i) => { assert.ok(Math.abs(n.start * .6 - (.15 + i * .73)) < .1); assert.ok(n.duration * .6 > .45 && n.duration * .6 < .72); });
      assert.ok(result.confidence > .9);
    });
  }
  await asyncCheck('低音 A1 与高音 B5 的音域边界', async () => {
    for (const pitch of [33, 83]) {
      const result = await transcribe(hum([pitch], 16000, { vibrato: 0 }), 16000, 100);
      assert.ok(result.notes.some(n => n.midi === pitch), JSON.stringify(result.notes));
    }
  });
  await asyncCheck('扩展音域覆盖 41 Hz 低哼与 1245 Hz 高哼', async () => {
    for (const pitch of [28, 87]) {
      const result = await transcribe(hum([pitch], 16000, { vibrato: 0 }), 16000, 100);
      assert.ok(result.notes.some(n => n.midi === pitch), JSON.stringify(result.notes));
    }
  });
  await asyncCheck('轻声哼唱不会被旧的固定音量门限全部丢弃', async () => {
    const signal = hum([60, 64, 67], 16000, { vibrato: 0 });
    for (let i = 0; i < signal.length; i++) signal[i] *= .01;
    const result = await transcribe(signal, 16000, 100); assert.deepEqual(result.notes.map(n => n.midi), [60, 64, 67]);
  });
  await asyncCheck('有直流偏移的静音不会变成音符', async () => {
    await assert.rejects(() => transcribe(new Float32Array(16000).fill(.05), 16000, 100), /没有找到/);
  });
  await asyncCheck('安静背景噪声不会变成旋律', async () => {
    const signal = hum([], 16000, { lead: 1, noise: .002 });
    await assert.rejects(() => transcribe(signal, 16000, 100), /没有找到/);
  });
  await asyncCheck('识别能够被取消', async () => {
    await assert.rejects(() => transcribe(hum([60], 16000), 16000, 100, null, () => true), /已取消/);
  });
  await asyncCheck('完整链路：哼唱音频→识别→改音高时值→MIDI', async () => {
    const decoded = decodeWav(encodeWav(hum([60, 64, 67], 16000), 16000));
    const result = await transcribe(decoded.samples, decoded.sampleRate, 100);
    result.notes[0].midi += 2;
    let edited = music.changeDuration(result.notes, result.notes[0].id, 2);
    assert.throws(() => encodeMidi(edited, 90), error => error.code === 'NOTE_OVERLAP');
    const delta = 2 - result.notes[0].duration;
    edited = edited.map((n, i) => i ? Object.assign({}, n, { start: n.start + delta }) : n);
    const roundtrip = parseMidi(encodeMidi(edited, 90));
    assert.equal(roundtrip.notes[0].midi, 62); assert.ok(Math.abs(roundtrip.notes[0].duration - 2) < 1 / 480);
    assert.ok(Math.abs(roundtrip.bpm - 90) < .001); assert.equal(roundtrip.notes.length, 3);
  });
  await require('./editor')(check, asyncCheck);
  await require('./playback-clock')(check, asyncCheck);
  const begin = performance.now();
  await asyncCheck('30 秒录音长度与异步进度回调', async () => {
    const signal = hum(Array.from({ length: 40 }, (_, i) => [60, 64, 67, 69][i % 4]), 16000);
    const progress = [];
    const result = await transcribe(signal, 16000, 100, p => progress.push(p));
    assert.equal(result.notes.length, 40); assert.equal(progress.at(-1), 100); assert.ok(progress.length > 10);
  });
  console.log('\n' + count + ' checks passed. 30-second transcription: ' + ((performance.now() - begin) / 1000).toFixed(2) + ' s (desktop Node; phone performance may differ).');
})().catch(err => { console.error(err); process.exitCode = 1; });
