'use strict';

const assert = require('node:assert/strict');
const { PRESETS, createVariation } = require('../miniprogram/utils/composition');
const { normalizeNotes } = require('../miniprogram/utils/music');
const { encodeMidi } = require('../miniprogram/utils/midi');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log('PASS  ' + label);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function musical(notes) {
  return notes.map(note => ({ midi: note.midi, start: note.start, duration: note.duration }));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function note(id, midi, start, duration) {
  return { id, midi, start, duration, velocity: 85, confidence: 0.9 };
}

function midiNoteOnCount(buffer) {
  const bytes = Buffer.from(buffer);
  assert.equal(bytes.toString('ascii', 0, 4), 'MThd');
  assert.equal(bytes.toString('ascii', 14, 18), 'MTrk');
  let at = 22;
  let running = 0;
  let count = 0;
  const variable = () => {
    let value = 0;
    let byte;
    do {
      byte = bytes[at++];
      value = value * 128 + (byte & 0x7f);
    } while (byte & 0x80);
    return value;
  };
  while (at < bytes.length) {
    variable();
    let status = bytes[at++];
    if (status < 0x80) {
      status = running;
      at--;
    } else {
      running = status;
    }
    const kind = status & 0xf0;
    if (status === 0xff) {
      const type = bytes[at++];
      const length = variable();
      at += length;
      if (type === 0x2f) break;
    } else if (kind === 0xc0 || kind === 0xd0) {
      at++;
    } else {
      const velocity = bytes[at + 1];
      at += 2;
      if (kind === 0x90 && velocity > 0) count++;
    }
  }
  return count;
}

const example = [
  note('source-a', 60, 1, 1),
  note('source-b', 67, 3, 0.5),
  note('source-c', 64, 5, 2)
];

check('PRESETS 固定为八种手法且每项契约完整', () => {
  assert.deepEqual(PRESETS.map(preset => preset.id), [
    'repeat', 'retrograde', 'inversion', 'retrograde-inversion',
    'transpose', 'augment', 'diminish', 'fragment'
  ]);
  for (const preset of PRESETS) {
    assert.deepEqual(Object.keys(preset).sort(), ['id', 'subtitle', 'tip', 'title']);
    assert.ok(preset.title && preset.subtitle && preset.tip);
  }
  assert.ok(Object.isFrozen(PRESETS));
});

check('默认 preset=retrograde、mode=append，并返回完整元数据', () => {
  const source = [note('one-source', 60, 1, 1)];
  const result = createVariation(source);
  assert.equal(result.presetId, 'retrograde');
  assert.equal(result.mode, 'append');
  assert.equal(result.notes.length, 2);
  assert.equal(result.added, 1);
  assert.equal(result.totalNotes, 2);
  assert.equal(result.sourceStart, 1);
  assert.equal(result.sourceSpan, 1);
  assert.equal(result.variantSpan, 1);
  assert.equal(result.anchorMidi, 60);
  assert.equal(result.totalBeats, 3);
  assert.deepEqual(musical(result.notes), [
    { midi: 60, start: 1, duration: 1 },
    { midi: 60, start: 2, duration: 1 }
  ]);
});

check('已知不等时值休止例子：append 逆行按时间映射且从原末尾加 gap', () => {
  const source = clone(example);
  const before = clone(source);
  const options = { preset: 'retrograde', mode: 'append', gap: 0.75, bpm: 100, fragmentSize: 99, repeatCount: 99 };
  const optionsBefore = clone(options);
  const result = createVariation(source, options);

  assert.deepEqual(source, before);
  assert.deepEqual(options, optionsBefore);
  assert.equal(result.sourceStart, 1);
  assert.equal(result.sourceSpan, 6);
  assert.equal(result.variantSpan, 6);
  assert.equal(result.anchorMidi, 60);
  assert.equal(result.added, 3);
  assert.equal(result.totalNotes, 6);
  assert.equal(result.totalBeats, 13.75);

  const original = result.notes.filter(item => item.id.startsWith('source-'));
  assert.deepEqual(original.map(item => [item.id, item.midi, item.start, item.duration]), [
    ['source-a', 60, 1, 1], ['source-b', 67, 3, 0.5], ['source-c', 64, 5, 2]
  ]);
  const variants = result.notes.filter(item => !item.id.startsWith('source-'));
  assert.deepEqual(musical(variants), [
    { midi: 64, start: 7.75, duration: 2 },
    { midi: 67, start: 11.25, duration: 0.5 },
    { midi: 60, start: 12.75, duration: 1 }
  ]);
  assert.equal(variants.length, new Set(variants.map(item => item.id)).size);
});

check('逆行两次还原音高、起点与时值，replace 保留最初首音起点', () => {
  const first = createVariation(example, { preset: 'retrograde', mode: 'replace' });
  const second = createVariation(first.notes, { preset: 'retrograde', mode: 'replace' });
  assert.deepEqual(musical(second.notes), musical(example));
  assert.equal(first.notes[0].start, 1);
  assert.equal(second.notes[0].start, 1);
  assert.equal(first.notes.length, 3);
});

check('倒影以源首音为轴，两次倒影精确还原且不夹音', () => {
  const source = [note('i-a', 60, 1, 1), note('i-b', 64, 2, 0.5), note('i-c', 67, 4, 2)];
  const first = createVariation(source, { preset: 'inversion', mode: 'replace' });
  assert.equal(first.anchorMidi, 60);
  assert.deepEqual(first.notes.map(item => item.midi), [60, 56, 53]);
  const second = createVariation(first.notes, { preset: 'inversion', mode: 'replace' });
  assert.deepEqual(second.notes.map(item => item.midi), [60, 64, 67]);
  assert.deepEqual(musical(second.notes), musical(source));
});

check('逆行倒影同时映射时间和音高轴', () => {
  const result = createVariation(example, { preset: 'retrograde-inversion', mode: 'replace' });
  assert.equal(result.anchorMidi, 60);
  assert.equal(result.notes[0].start, 1);
  assert.deepEqual(musical(result.notes), [
    { midi: 56, start: 1, duration: 2 },
    { midi: 53, start: 4.5, duration: 0.5 },
    { midi: 60, start: 6, duration: 1 }
  ]);
});

check('BPM 只影响秒数上限，不误改拍点和音高', () => {
  const slow = createVariation(example, { preset: 'retrograde-inversion', mode: 'replace', bpm: 40 });
  const fast = createVariation(example, { preset: 'retrograde-inversion', mode: 'replace', bpm: 240 });
  assert.deepEqual(musical(slow.notes), musical(fast.notes));
  assert.equal(slow.totalBeats, fast.totalBeats);
});

check('增值和减值同时缩放归零后的起点与时值', () => {
  const source = [note('scale-a', 60, 1, 1), note('scale-b', 64, 4, 2)];
  const augmented = createVariation(source, { preset: 'augment', mode: 'replace' });
  const diminished = createVariation(source, { preset: 'diminish', mode: 'replace' });
  assert.deepEqual(musical(augmented.notes), [
    { midi: 60, start: 1, duration: 2 },
    { midi: 64, start: 7, duration: 4 }
  ]);
  assert.equal(augmented.sourceSpan, 5);
  assert.equal(augmented.variantSpan, 10);
  assert.deepEqual(musical(diminished.notes), [
    { midi: 60, start: 1, duration: 0.5 },
    { midi: 64, start: 2.5, duration: 1 }
  ]);
  assert.equal(diminished.variantSpan, 2.5);
});

check('动机按前 N 音实际跨度重复，段内休止保留且 repeatCount 只作用于 fragment', () => {
  const source = [
    note('frag-a', 60, 0, 1), note('frag-b', 64, 3, 1),
    note('frag-c', 67, 5, 0.5), note('frag-d', 69, 8, 1),
    note('frag-e', 72, 10, 1)
  ];
  const result = createVariation(source, {
    preset: 'fragment', mode: 'append', fragmentSize: 3, repeatCount: 2, gap: 0.25
  });
  assert.equal(result.sourceSpan, 11);
  assert.equal(result.variantSpan, 11);
  assert.equal(result.added, 6);
  assert.deepEqual(musical(result.notes.slice(5)), [
    { midi: 60, start: 11.25, duration: 1 },
    { midi: 64, start: 14.25, duration: 1 },
    { midi: 67, start: 16.25, duration: 0.5 },
    { midi: 60, start: 16.75, duration: 1 },
    { midi: 64, start: 19.75, duration: 1 },
    { midi: 67, start: 21.75, duration: 0.5 }
  ]);
  assert.equal(midiNoteOnCount(encodeMidi(result.notes, 100)), 11);

  assert.doesNotThrow(() => createVariation(example, {
    preset: 'repeat', mode: 'replace', fragmentSize: 1, repeatCount: 99
  }));
});

check('500 音符可恰好达到，超过时抛出可操作错误而不截断', () => {
  const exact = Array.from({ length: 250 }, (_, index) =>
    note('exact-' + index, 60, index * 0.125, 0.125));
  const allowed = createVariation(exact, { preset: 'repeat', mode: 'append', bpm: 240 });
  assert.equal(allowed.totalNotes, 500);
  const tooMany = Array.from({ length: 251 }, (_, index) =>
    note('many-' + index, 60, index * 0.125, 0.125));
  assert.throws(
    () => createVariation(tooMany, { preset: 'repeat', mode: 'append', bpm: 240 }),
    /超过 500/
  );
});

check('120 秒上限包含原 leading；replace 可保留恰好 120 秒', () => {
  const source = [note('late-note', 60, 79, 1)];
  const replacement = createVariation(source, { preset: 'repeat', mode: 'replace', bpm: 40 });
  assert.equal(replacement.totalBeats, 80);
  assert.throws(
    () => createVariation(source, { preset: 'repeat', mode: 'append', bpm: 40 }),
    /120 秒/
  );
});

check('音高、时值越界和输入重叠都拒绝，绝不静默夹音或裁剪', () => {
  assert.throws(
    () => createVariation([note('high', 100, 0, 1)], { preset: 'transpose', mode: 'replace', transpose: 20 }),
    /超出 MIDI 21–108/
  );
  assert.throws(
    () => createVariation([note('axis', 30, 0, 1), note('low-result', 40, 1, 1)], {
      preset: 'inversion', mode: 'replace'
    }),
    /倒影后的音高 20 超出/
  );
  assert.throws(
    () => createVariation([note('augment-limit', 60, 0, 32)], { preset: 'augment', mode: 'replace' }),
    /超出 0.125–32/
  );
  assert.throws(
    () => createVariation([note('diminish-limit', 60, 0, 0.125)], { preset: 'diminish', mode: 'replace' }),
    /超出 0.125–32/
  );
  assert.throws(
    () => createVariation([note('overlap-a', 60, 0, 2), note('overlap-b', 64, 1, 1)], {
      preset: 'repeat', mode: 'append'
    }),
    /重叠/
  );
});

check('preset、mode、有限数、整数与范围参数得到中文校验', () => {
  assert.throws(() => createVariation(example, { preset: 'unknown' }), /未知的发展手法/);
  assert.throws(() => createVariation(example, { mode: 'insert' }), /append.*replace/);
  assert.throws(() => createVariation(example, { bpm: Infinity }), /bpm.*40 到 240/);
  assert.throws(() => createVariation(example, { gap: -0.001 }), /gap.*0 到 16/);
  assert.throws(() => createVariation(example, { preset: 'transpose', transpose: 1.5 }), /整数半音/);
  assert.throws(() => createVariation(example, { preset: 'fragment', fragmentSize: 9 }), /2 到 8/);
  assert.throws(() => createVariation(example, { preset: 'fragment', repeatCount: 5 }), /2 到 4/);
  assert.doesNotThrow(() => createVariation(example, { unexpected: NaN }));
});

check('纯函数冻结输入不变、ID 全局唯一、输出兼容 normalizeNotes 并可导出 MIDI', () => {
  const source = deepFreeze([
    note('frozen-a', 60, 0.001, 0.875),
    note('frozen-b', 64, 2.125, 0.5),
    note('frozen-c', 67, 3.001, 1.125)
  ]);
  const options = deepFreeze({ preset: 'fragment', mode: 'append', fragmentSize: 2, repeatCount: 3, gap: 0.333 });
  const before = clone(source);
  const result = createVariation(source, options);

  assert.deepEqual(source, before);
  assert.equal(new Set(result.notes.map(item => String(item.id))).size, result.notes.length);
  assert.deepEqual(normalizeNotes(result.notes), result.notes);
  result.notes.forEach(item => {
    assert.ok(item.midi >= 21 && item.midi <= 108);
    assert.ok(item.duration >= 0.125 && item.duration <= 32);
    assert.ok(item.start >= 0);
    assert.equal(Math.round(item.start * 1000) / 1000, item.start);
    assert.equal(Math.round(item.duration * 1000) / 1000, item.duration);
  });
  const midi = encodeMidi(result.notes, 120);
  assert.equal(midiNoteOnCount(midi), result.totalNotes);
});

console.log('\n' + passed + ' composition checks passed.');