'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readMidi, scoreNotes, aggregate } = require('../tools/humtrans-metrics.cjs');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

function u16(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function vlq(value) {
  const bytes = [value & 0x7f];
  value >>>= 7;
  while (value) {
    bytes.unshift(0x80 | (value & 0x7f));
    value >>>= 7;
  }
  return bytes;
}

function event(delta, ...bytes) {
  return [...vlq(delta), ...bytes];
}

function meta(delta, type, data = []) {
  return event(delta, 0xff, type, ...vlq(data.length), ...data);
}

function midiFile(tracks, ppq = 480) {
  const format = tracks.length === 1 ? 0 : 1;
  const header = [...Buffer.from('MThd'), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(ppq)];
  const chunks = tracks.map(track => {
    const body = [].concat(...track);
    return [...Buffer.from('MTrk'), ...u32(body.length), ...body];
  });
  return Buffer.from([...header, ...[].concat(...chunks)]);
}

function tempo(microseconds) {
  return [(microseconds >> 16) & 0xff, (microseconds >> 8) & 0xff, microseconds & 0xff];
}

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

check('MIDI PPQ、多轨 tempo 变化、running status 和 velocity=0', () => {
  const conductor = [
    meta(0, 0x51, tempo(500000)),
    meta(480, 0x51, tempo(1000000)),
    meta(960, 0x2f)
  ];
  const notes = [
    event(0, 0x90, 60, 100),
    event(480, 64, 100),               // running note-on
    event(0, 0x80, 60, 0),
    event(480, 64, 0),                 // running note-off
    event(0, 0x90, 60, 100),
    event(480, 0x90, 60, 0),           // note-on velocity zero closes it
    meta(0, 0x2f)
  ];
  const parsed = readMidi(midiFile([conductor, notes], 480));
  assert.deepEqual(parsed.map(note => note.midi), [60, 64, 60]);
  close(parsed[0].start, 0);
  close(parsed[0].end, 0.5);
  close(parsed[1].start, 0.5);
  close(parsed[1].end, 1.5);
  close(parsed[2].start, 1.5);
  close(parsed[2].end, 2.5);
});

check('MIDI 多个 MTrk 排序且忽略通道 10 打击乐', () => {
  const conductor = [meta(0, 0x2f)];
  const melody = [
    event(0, 0x90, 60, 90),
    event(480, 60, 0),
    meta(0, 0x2f)
  ];
  const percussion = [
    event(0, 0x99, 36, 120),
    event(480, 36, 0),
    meta(0, 0x2f)
  ];
  const parsed = readMidi(midiFile([conductor, melody, percussion]));
  assert.deepEqual(parsed, [{ start: 0, end: 0.5, midi: 60 }]);
});

check('最大二分图匹配而非贪心匹配', () => {
  const ref = [
    { start: 0, end: 1, midi: 60 },
    { start: 0.02, end: 1, midi: 60 }
  ];
  const pred = [
    { start: 0.03, end: 1, midi: 60 },
    { start: 0.05, end: 1, midi: 60 }
  ];
  const metrics = scoreNotes(ref, pred, { duration: 1 });
  assert.equal(metrics.note_p50, 1);
  assert.equal(metrics.note_r50, 1);
  assert.equal(metrics.note_f50, 1);
});

check('全局八度平移、绝对音高和纯 onset 指标相互独立', () => {
  const ref = [{ start: 0, end: 1, midi: 60 }];
  const pred = [{ start: 0, end: 1, midi: 72 }];
  const metrics = scoreNotes(ref, pred, { duration: 1 });
  assert.equal(metrics.note_f50, 1);
  assert.equal(metrics.note_f100, 1);
  assert.equal(metrics.absolute_f100, 0);
  assert.equal(metrics.onset_f100, 1);
  assert.equal(metrics.global_shift, 12);
});

check('休止区的错误音符会降低帧 precision 和 voiced_f1', () => {
  const ref = [
    { start: 0, end: 0.5, midi: 60 },
    { start: 1.5, end: 2, midi: 60 }
  ];
  const pred = [
    { start: 0, end: 0.5, midi: 60 },
    { start: 0.5, end: 1, midi: 62 }
  ];
  const metrics = scoreNotes(ref, pred, { duration: 2, hop: 0.5 });
  assert.equal(metrics.frame_pc_precision, 0.5);
  assert.equal(metrics.frame_pc_recall, 0.5);
  assert.equal(metrics.frame_pc_accuracy, metrics.frame_pc_recall);
  assert.equal(metrics.voiced_f1, 0.5);
});

check('没有共同有声帧时不会误报帧召回或 precision', () => {
  const ref = [{ start: 0, end: 1, midi: 60 }];
  const pred = [{ start: 1, end: 2, midi: 60 }];
  const metrics = scoreNotes(ref, pred, { duration: 2, hop: 1 });
  assert.equal(metrics.frame_pc_precision, 0);
  assert.equal(metrics.frame_pc_recall, 0);
  assert.equal(metrics.frame_pc_accuracy, 0);
  assert.equal(metrics.voiced_f1, 0);
});

check('帧 pitch class 使用圆周半音距离并包含 0.5 半音边界', () => {
  const ref = [{ start: 0, end: 1, midi: 60 }];
  const pred = [{ start: 0, end: 1, midi: 60.5 }];
  const metrics = scoreNotes(ref, pred, { duration: 1 });
  assert.equal(metrics.frame_pc_accuracy, 1);
  assert.equal(metrics.frame_pc_precision, 1);
  assert.equal(metrics.frame_pc_recall, 1);
});

check('旋律 LCS 保留连续重复音符的出现次数', () => {
  const ref = [
    { start: 0, end: 1, midi: 60 },
    { start: 1, end: 2, midi: 60 },
    { start: 2, end: 3, midi: 62 }
  ];
  const pred = [
    { start: 0, end: 1, midi: 60 },
    { start: 1, end: 2, midi: 62 }
  ];
  const metrics = scoreNotes(ref, pred, { duration: 3 });
  close(metrics.melody_lcs_f1, 4 / 5); // LCS=2, 2*2/(3+2)
});

check('聚合先按 take 求 composition 均值，再按 composition 宏平均', () => {
  const result = aggregate([
    { composition_id: 'A', metrics: { note_f50: 1, ref_count: 1 } },
    { composition_id: 'A', metrics: { note_f50: 0, ref_count: 2 } },
    { composition_id: 'B', note_f50: 0, ref_count: 3 }
  ]);
  assert.equal(result.count, 3);
  assert.equal(result.compositions, 2);
  close(result.metrics.note_f50, 0.25);
  close(result.metrics.ref_count, 2.25); // (mean(1,2) + 3) / 2
  const shifts = aggregate([{ composition_id: 'A', global_shift: -12 }, { composition_id: 'B', global_shift: 12 }]);
  assert.equal(Object.hasOwn(shifts.metrics, 'global_shift'), false);
  assert.deepEqual(shifts.global_shift_counts, { '-12': 1, '12': 1 });
});

check('真正需要增广路径的最大匹配反例', () => {
  const ref = [{ start: .04, end: .08, midi: 60 }, { start: .10, end: .14, midi: 60 }];
  const pred = [{ start: 0, end: .03, midi: 60 }, { start: .055, end: .09, midi: 60 }];
  close(scoreNotes(ref, pred, { duration: .2 }).note_f50, 1);
});

check('49/51 ms 边界和不检查 offset 的定义', () => {
  const ref = [{ start: .2, end: .4, midi: 60 }];
  close(scoreNotes(ref, [{ start: .249, end: .9, midi: 60 }], { duration: 1 }).note_f50, 1);
  close(scoreNotes(ref, [{ start: .251, end: .9, midi: 60 }], { duration: 1 }).note_f50, 0);
});

check('八度平移必须全片一致，空输入返回有限零值', () => {
  const ref = [{ start: 0, end: .5, midi: 60 }, { start: 1, end: 1.5, midi: 64 }];
  const pred = [{ start: 0, end: .5, midi: 72 }, { start: 1, end: 1.5, midi: 64 }];
  close(scoreNotes(ref, pred).note_f50, .5);
  const empty = scoreNotes([], [], { duration: 1 });
  assert.ok(Object.values(empty).every(v => Number.isFinite(v) && v === 0));
});

check('HumTrans 样例 MIDI 与 metadata 音符数和时间范围一致', () => {
  const dataset = 'C:/Users/DevWind/Documents/Codex/2026-10-24/b/outputs/HumTrans';
  const csvPath = path.join(dataset, 'metadata', 'pairs.csv');
  if (!fs.existsSync(csvPath)) return; // Keep the unit suite portable; this workspace exercises it.
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  const index = Object.fromEntries(headers.map((name, i) => [name, i]));
  const wanted = new Set([
    'F01_0001_0001_1_D', 'F01_0002_0001_1',
    'F01_0003_0001_1_D', 'F01_0024_0001_1'
  ]);
  const rows = lines.slice(1).map(line => line.split(',')).filter(row => wanted.has(row[index.stem]));
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const midi = readMidi(fs.readFileSync(path.join(dataset, row[index.midi_path])));
    assert.equal(midi.length, Number(row[index.midi_notes]), row[index.stem]);
    close(midi[0].start, Number(row[index.midi_start_s]), 1e-6);
    close(Math.max(...midi.map(note => note.end)), Number(row[index.midi_end_s]), 1e-6);
    assert.equal(Math.min(...midi.map(note => note.midi)), Number(row[index.midi_pitch_min]));
    assert.equal(Math.max(...midi.map(note => note.midi)), Number(row[index.midi_pitch_max]));
  }
});

console.log(`\n${passed} tests passed`);


