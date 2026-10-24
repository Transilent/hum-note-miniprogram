'use strict';

const { normalizeNotes, uid } = require('./music');

const PRESETS = Object.freeze([
  Object.freeze({ id: 'repeat', title: '重复', subtitle: '整句复述', tip: '把整段旋律原样再演奏一次，保留原有呼吸和留白。' }),
  Object.freeze({ id: 'retrograde', title: '逆行', subtitle: '时间倒序', tip: '从乐句末尾向前演奏，音符时值保持不变。' }),
  Object.freeze({ id: 'inversion', title: '倒影', subtitle: '音高镜像', tip: '以乐句首音为轴，把上行变为下行、下行变为上行。' }),
  Object.freeze({ id: 'retrograde-inversion', title: '逆行倒影', subtitle: '时间与音高双重镜像', tip: '同时倒放时间并镜像音高，适合制造熟悉的陌生感。' }),
  Object.freeze({ id: 'transpose', title: '移调', subtitle: '整体升降音高', tip: '所有音符移动相同半音数，旋律轮廓保持不变。' }),
  Object.freeze({ id: 'augment', title: '增值', subtitle: '放慢两倍', tip: '起点与音符时值都扩大两倍，让旋律更加舒展。' }),
  Object.freeze({ id: 'diminish', title: '减值', subtitle: '加快两倍', tip: '起点与音符时值都缩小一半，让旋律更加紧凑。' }),
  Object.freeze({ id: 'fragment', title: '动机重复', subtitle: '截取开头反复发展', tip: '选取开头 2–8 个音符组成动机，再把动机连续重复 2–4 次。' })
]);

const PRESET_IDS = new Set(PRESETS.map(preset => preset.id));
const MAX_NOTES = 500;
const MAX_SECONDS = 120;
const MIN_MIDI = 21;
const MAX_MIDI = 108;
const MIN_DURATION = 0.125;
const MAX_DURATION = 32;
const INTERVAL_EPSILON = 1e-9;

function round3(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function describeNote(index) {
  return '第 ' + (index + 1) + ' 个音符';
}

function readOptions(options) {
  if (options == null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    fail('INVALID_OPTIONS', 'options 必须是对象；请检查预设参数后再试。');
  }

  const preset = options.preset === undefined ? 'retrograde' : options.preset;
  if (typeof preset !== 'string' || !PRESET_IDS.has(preset)) {
    fail('INVALID_PRESET', '未知的发展手法；preset 必须是 ' + Array.from(PRESET_IDS).join('、') + ' 之一。');
  }

  const mode = options.mode === undefined ? 'append' : options.mode;
  if (mode !== 'append' && mode !== 'replace') {
    fail('INVALID_MODE', 'mode 必须是 append（追加）或 replace（替换）。');
  }

  const bpm = options.bpm === undefined ? 100 : options.bpm;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 40 || bpm > 240) {
    fail('INVALID_BPM', 'bpm 必须是 40 到 240 之间的有限数。');
  }

  const rawGap = options.gap === undefined ? 0 : options.gap;
  if (typeof rawGap !== 'number' || !Number.isFinite(rawGap) || rawGap < 0 || rawGap > 16) {
    fail('INVALID_GAP', 'gap 必须是 0 到 16 拍之间的有限数。');
  }

  let transpose = 2;
  if (preset === 'transpose') {
    transpose = options.transpose === undefined ? 2 : options.transpose;
    if (!Number.isSafeInteger(transpose)) {
      fail('INVALID_TRANSPOSE', 'transpose 必须是整数半音数，例如 +2 或 -3。');
    }
  }

  let fragmentSize = 4;
  let repeatCount = 2;
  if (preset === 'fragment') {
    fragmentSize = options.fragmentSize === undefined ? 4 : options.fragmentSize;
    repeatCount = options.repeatCount === undefined ? 2 : options.repeatCount;
    if (!Number.isInteger(fragmentSize) || fragmentSize < 2 || fragmentSize > 8) {
      fail('INVALID_FRAGMENT_SIZE', 'fragmentSize 必须是 2 到 8 的整数。');
    }
    if (!Number.isInteger(repeatCount) || repeatCount < 2 || repeatCount > 4) {
      fail('INVALID_REPEAT_COUNT', 'repeatCount 必须是 2 到 4 的整数。');
    }
  }

  return { preset, mode, bpm, gap: round3(rawGap), transpose, fragmentSize, repeatCount };
}

function makeIdFactory(usedIds) {
  return function nextId() {
    let candidate;
    let attempt = 0;
    do {
      candidate = uid();
      if (attempt) candidate += '-' + attempt;
      attempt++;
    } while (usedIds.has(String(candidate)));
    usedIds.add(String(candidate));
    return candidate;
  };
}

function prepareSource(notes) {
  if (!Array.isArray(notes)) {
    fail('INVALID_NOTES', '音符输入必须是数组；请先把灵感保存为音符乐句。');
  }
  if (!notes.length) {
    fail('EMPTY_SOURCE', '当前没有可发展的音符；请先录入或选择一段旋律。');
  }
  if (notes.length > MAX_NOTES) {
    fail('NOTE_COUNT_LIMIT', '原始乐句有 ' + notes.length + ' 个音符，超过 ' + MAX_NOTES + ' 个上限；请先精简或拆分乐句。');
  }

  const usedIds = new Set();
  notes.forEach((note, index) => {
    if (!note || typeof note !== 'object' || Array.isArray(note)) {
      fail('INVALID_NOTE', describeNote(index) + '不是有效音符对象。');
    }
    if (typeof note.midi !== 'number' || !Number.isInteger(note.midi)) {
      fail('INVALID_NOTE', describeNote(index) + '的 midi 必须是整数。');
    }
    if (note.midi < MIN_MIDI || note.midi > MAX_MIDI) {
      fail('PITCH_LIMIT', describeNote(index) + '的音高 ' + note.midi + ' 超出 MIDI ' + MIN_MIDI + '–' + MAX_MIDI + '；请调整音高。');
    }
    if (typeof note.start !== 'number' || !Number.isFinite(note.start) || note.start < 0) {
      fail('INVALID_NOTE', describeNote(index) + '的 start 必须是大于等于 0 的有限数。');
    }
    if (typeof note.duration !== 'number' || !Number.isFinite(note.duration)) {
      fail('INVALID_NOTE', describeNote(index) + '的 duration 必须是有限数。');
    }
    if (note.duration < MIN_DURATION || note.duration > MAX_DURATION) {
      fail('DURATION_LIMIT', describeNote(index) + '的时值为 ' + note.duration + ' 拍，超出 ' + MIN_DURATION + '–' + MAX_DURATION + ' 拍范围。');
    }
    if (note.id != null) {
      const key = String(note.id);
      if (!key || usedIds.has(key)) {
        fail('INVALID_NOTE_ID', describeNote(index) + '的 id 为空或与其他音符重复；请为每个音符保留唯一 id。');
      }
      usedIds.add(key);
    }
  });

  const nextId = makeIdFactory(usedIds);
  const records = notes.map((note, originalIndex) => ({
    id: note.id == null ? nextId() : note.id,
    midi: note.midi,
    start: round3(note.start),
    duration: round3(note.duration),
    velocity: note.velocity,
    confidence: note.confidence,
    original: note,
    originalIndex
  }));

  records.sort((a, b) => a.start - b.start || a.originalIndex - b.originalIndex);
  for (let index = 1; index < records.length; index++) {
    const previous = records[index - 1];
    const current = records[index];
    if (current.start < previous.start + previous.duration - INTERVAL_EPSILON) {
      fail('NOTE_OVERLAP', '原始乐句中的音符发生重叠（' + previous.id + ' 与 ' + current.id + '）；请缩短时值或拉开起点后再发展。');
    }
  }

  const sourceStart = records[0].start;
  const relative = records.map(record => ({
    source: record,
    midi: record.midi,
    start: round3(record.start - sourceStart),
    duration: round3(record.duration)
  }));
  const sourceSpan = round3(Math.max(...relative.map(note => note.start + note.duration)));
  return { records, relative, sourceStart, sourceSpan, anchorMidi: records[0].midi, usedIds, nextId };
}

function cloneTiming(records) {
  return records.map(note => ({ source: note.source, midi: note.midi, start: note.start, duration: note.duration }));
}

function timeSpan(records) {
  const minimum = Math.min(...records.map(note => note.start));
  const end = Math.max(...records.map(note => note.start + note.duration));
  return { minStart: round3(minimum), span: round3(end - minimum) };
}

function makeVariation(source, options) {
  const { preset } = options;
  const { relative, sourceSpan, anchorMidi } = source;

  if (preset === 'repeat') return cloneTiming(relative);

  if (preset === 'retrograde' || preset === 'retrograde-inversion') {
    return relative.map(note => {
      const variant = cloneTiming([note])[0];
      variant.start = round3(sourceSpan - (note.start + note.duration));
      if (preset === 'retrograde-inversion') variant.midi = 2 * anchorMidi - note.midi;
      return variant;
    });
  }

  if (preset === 'inversion') {
    return relative.map(note => Object.assign(cloneTiming([note])[0], {
      midi: 2 * anchorMidi - note.midi
    }));
  }

  if (preset === 'transpose') {
    return relative.map(note => Object.assign(cloneTiming([note])[0], {
      midi: note.midi + options.transpose
    }));
  }

  if (preset === 'augment' || preset === 'diminish') {
    const factor = preset === 'augment' ? 2 : 0.5;
    return relative.map(note => Object.assign(cloneTiming([note])[0], {
      start: round3(note.start * factor),
      duration: round3(note.duration * factor)
    }));
  }

  if (preset === 'fragment') {
    if (relative.length < options.fragmentSize) {
      fail('FRAGMENT_TOO_SHORT', '动机需要前 ' + options.fragmentSize + ' 个音符，但乐句只有 ' + relative.length + ' 个；请少取几个开头音符，或先补充原旋律。');
    }
    const motif = relative.slice(0, options.fragmentSize);
    const motifStart = Math.min(...motif.map(note => note.start));
    const motifEnd = Math.max(...motif.map(note => note.start + note.duration));
    const motifSpan = round3(motifEnd - motifStart);
    const variants = [];
    for (let repetition = 0; repetition < options.repeatCount; repetition++) {
      const offset = round3(repetition * motifSpan);
      motif.forEach(note => {
        variants.push(Object.assign(cloneTiming([note])[0], {
          start: round3(note.start - motifStart + offset)
        }));
      });
    }
    return variants;
  }

  fail('INVALID_PRESET', '无法识别发展手法：' + preset);
}

function pitchError(preset, midi) {
  if (preset === 'inversion' || preset === 'retrograde-inversion') {
    return '倒影后的音高 ' + midi + ' 超出 MIDI ' + MIN_MIDI + '–' + MAX_MIDI + '；请先调整过低或过高音符，系统不会自动夹音。';
  }
  return '移调后的音高 ' + midi + ' 超出 MIDI ' + MIN_MIDI + '–' + MAX_MIDI + '；请减小移调半音数，系统不会自动夹音。';
}

function validateVariant(variant, options) {
  variant.forEach((note, index) => {
    if (!Number.isInteger(note.midi) || note.midi < MIN_MIDI || note.midi > MAX_MIDI) {
      fail('PITCH_LIMIT', pitchError(options.preset, note.midi));
    }
    if (!Number.isFinite(note.start) || note.start < 0) {
      fail('START_LIMIT', '变形后第 ' + (index + 1) + ' 个音符起点为 ' + note.start + '；请调整原旋律或两段之间的留白。');
    }
    if (!Number.isFinite(note.duration) || note.duration < MIN_DURATION || note.duration > MAX_DURATION) {
      fail('DURATION_LIMIT', '变形后第 ' + (index + 1) + ' 个音符时值为 ' + note.duration + ' 拍，超出 ' + MIN_DURATION + '–' + MAX_DURATION + ' 拍范围；请先调整原音符时值，或换一种预设。');
    }
  });
}

function outputNote(note, id, offset) {
  const result = {
    id,
    midi: note.midi,
    start: round3(note.start + offset),
    duration: round3(note.duration)
  };
  if (Number.isFinite(note.source.velocity)) result.velocity = note.source.velocity;
  if (Number.isFinite(note.source.confidence)) result.confidence = note.source.confidence;
  return result;
}

function assertNoResultOverlaps(notes) {
  for (let index = 1; index < notes.length; index++) {
    const previous = notes[index - 1];
    if (notes[index].start < previous.start + previous.duration - INTERVAL_EPSILON) {
      fail('OUTPUT_OVERLAP', '变形结果出现重叠；请增加两段之间的留白后重试。');
    }
  }
}

function createVariation(notes, options) {
  const parsed = readOptions(options);
  const source = prepareSource(notes);
  const variant = makeVariation(source, parsed);
  validateVariant(variant, parsed);
  const dimensions = timeSpan(variant);

  let offset;
  let assembled;
  if (parsed.mode === 'append') {
    offset = round3(source.sourceStart + source.sourceSpan + parsed.gap);
    assembled = source.records.map(record => Object.assign({}, record.original, {
      id: record.id,
      midi: record.midi,
      start: record.start,
      duration: record.duration
    }));
  } else {
    offset = round3(source.sourceStart - dimensions.minStart);
    assembled = [];
  }

  const variantNotes = variant.map(note => outputNote(note, source.nextId(), offset));
  assembled = assembled.concat(variantNotes);

  if (assembled.length > MAX_NOTES) {
    fail('NOTE_COUNT_LIMIT', '发展后将有 ' + assembled.length + ' 个音符，超过 ' + MAX_NOTES + ' 个上限；请缩短乐句，或选择“只保留变化后的整段”。');
  }

  const resultNotes = normalizeNotes(assembled);
  if (resultNotes.length !== assembled.length) {
    fail('INVALID_OUTPUT', '生成结果中有无效音符，未保存任何改动；请检查原始音符。');
  }
  assertNoResultOverlaps(resultNotes);

  const totalBeats = round3(resultNotes.reduce((end, note) => Math.max(end, note.start + note.duration), 0));
  const totalSeconds = totalBeats * 60 / parsed.bpm;
  if (totalSeconds > MAX_SECONDS + INTERVAL_EPSILON) {
    fail('TIME_LIMIT', '发展后的总时长为 ' + totalSeconds.toFixed(2) + ' 秒（含原前导空白，' + parsed.bpm + ' BPM），超过 ' + MAX_SECONDS + ' 秒上限；请缩短乐句、减少两段间留白，或回编辑页提高 BPM。');
  }

  return {
    notes: resultNotes,
    presetId: parsed.preset,
    mode: parsed.mode,
    sourceStart: source.sourceStart,
    sourceSpan: source.sourceSpan,
    variantSpan: dimensions.span,
    anchorMidi: source.anchorMidi,
    added: variantNotes.length,
    totalNotes: resultNotes.length,
    totalBeats
  };
}

module.exports = { PRESETS, createVariation };
