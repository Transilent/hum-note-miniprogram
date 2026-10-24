'use strict';

const audio = require('./audio');
const wav = require('./wav');

const MAX_NOTES = 500;
const MAX_SECONDS = 120;
const DEFAULT_TITLE = '未命名旋律';
let sequence = 0;

function files() {
  return wx.getFileSystemManager();
}

function exportDir() {
  return wx.env.USER_DATA_PATH + '/humnote';
}

function exportPath() {
  sequence = (sequence + 1) % 1679616;
  const unique = Date.now().toString(36) + '-' + sequence.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  return exportDir() + '/share-' + unique + '.wav';
}

function cancelled(isCancelled) {
  return typeof isCancelled === 'function' && !!isCancelled();
}

function invalid(message, code) {
  const error = new Error(message);
  error.code = code || 'INVALID_AUDIO_EXPORT';
  return error;
}

function friendly(message, cause, code) {
  const error = new Error(message);
  error.code = (cause && cause.code) || code || 'AUDIO_EXPORT_FAILED';
  error.cause = cause;
  if (cause && cause.errMsg) error.errMsg = cause.errMsg;
  return error;
}

function safeTitle(title) {
  const cleaned = String(title == null ? '' : title)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\s.]+|[_\s.]+$/g, '')
    .trim();
  return (cleaned || DEFAULT_TITLE).slice(0, 80);
}

function fileName(title, kind) {
  return safeTitle(title) + (kind === 'melody' ? '（旋律）.wav' : '（原始哼唱）.wav');
}

function isOwnedExportPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const prefix = exportDir() + '/share-';
  if (filePath.indexOf(prefix) !== 0) return false;
  return /^[a-z0-9-]+\.wav$/i.test(filePath.slice(prefix.length));
}

function removeOwnedFile(filePath) {
  if (!isOwnedExportPath(filePath)) return false;
  try {
    files().unlinkSync(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function ensureExportDir() {
  try { files().mkdirSync(exportDir(), true); } catch (_) {}
}

function statFile(filePath) {
  return new Promise((resolve, reject) => {
    try {
      files().stat({
        path: filePath,
        success: result => resolve(result && result.stats),
        fail: reject
      });
    } catch (error) {
      reject(error);
    }
  });
}

function copyFile(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    try {
      files().copyFile({ srcPath, destPath, success: resolve, fail: reject });
    } catch (error) {
      reject(error);
    }
  });
}

function writeFile(filePath, data) {
  return new Promise((resolve, reject) => {
    try {
      files().writeFile({ filePath, data, success: resolve, fail: reject });
    } catch (error) {
      reject(error);
    }
  });
}

function isFileStats(stats) {
  if (!stats || Array.isArray(stats) || !Number.isFinite(stats.size) || stats.size <= 0) return false;
  if (typeof stats.isFile === 'function' && !stats.isFile()) return false;
  return true;
}

function validateMelody(options) {
  const notes = options.notes;
  if (!Array.isArray(notes) || notes.length === 0) throw invalid('当前旋律没有可导出的音符。', 'INVALID_NOTES');
  if (notes.length > MAX_NOTES) {
    throw invalid('当前旋律有 ' + notes.length + ' 个音符，超过 500 个上限，请精简后再分享。', 'AUDIO_EXPORT_LIMIT');
  }

  const bpm = Number(options.bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) throw invalid('BPM 无效，请调整后再分享。', 'INVALID_BPM');
  const tone = options.tone || 'piano';
  if (tone !== 'piano' && tone !== 'soft') throw invalid('音色无效，请选择钢琴或柔和音色。', 'INVALID_TONE');

  const spans = [];
  let furthestBeat = 0;
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (!note || !Number.isFinite(note.midi) || !Number.isFinite(note.start) ||
        !Number.isFinite(note.duration) || note.start < 0 || note.duration <= 0) {
      throw invalid('旋律中有无效音符，请调整后再分享。', 'INVALID_NOTES');
    }
    if (note.velocity != null && (!Number.isFinite(note.velocity) || note.velocity <= 0)) {
      throw invalid('旋律中有无效力度，请调整后再分享。', 'INVALID_NOTES');
    }
    const end = note.start + note.duration;
    spans.push({ index: i, start: note.start, end });
    if (end > furthestBeat) furthestBeat = end;
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  let reached = -Infinity;
  for (const span of spans) {
    if (span.start < reached - .000001) {
      const error = invalid('音符有重叠，调整后才能分享音频。', 'NOTE_OVERLAP');
      error.noteIndexes = spans.filter(item => item.start < reached - .000001 || item.end > span.start + .000001).map(item => item.index);
      throw error;
    }
    reached = Math.max(reached, span.end);
  }

  const musicDuration = furthestBeat * 60 / bpm;
  if (musicDuration > MAX_SECONDS + .000000001) {
    throw invalid('旋律时长约 ' + musicDuration.toFixed(1) + ' 秒，超过 120 秒上限，请精简后再分享。', 'AUDIO_EXPORT_LIMIT');
  }
  return { notes, bpm, tone, musicDuration };
}

function previewKey(notes, bpm, tone) {
  return JSON.stringify([bpm, tone, notes.map(note =>
    [note.midi, note.start, note.duration, note.velocity || 85]
  )]);
}

function previewCacheOf(cachedPreview) {
  if (!cachedPreview) return null;
  if (Object.prototype.hasOwnProperty.call(cachedPreview, 'previewCache')) return cachedPreview.previewCache;
  return cachedPreview;
}

function synthesizedDuration(notes, bpm, musicDuration) {
  return Math.min(180, Math.max(.25, musicDuration) + .3);
}

function exportResult(filePath, title, kind, byteLength, duration, bpm) {
  return {
    filePath,
    fileName: fileName(title, kind),
    byteLength,
    duration,
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    kind,
    owned: true,
    format: 'WAV'
  };
}

async function prepareOriginal(options) {
  const isCancelled = options.isCancelled;
  if (typeof options.source !== 'string' || !options.source) {
    throw invalid('找不到原始录音，请重新录制后再分享。', 'MISSING_SOURCE');
  }
  if (cancelled(isCancelled)) return null;

  let stats;
  try {
    stats = await statFile(options.source);
  } catch (error) {
    if (cancelled(isCancelled)) return null;
    throw friendly('原始录音不存在或无法读取，请重新录制后再分享。', error, 'SOURCE_STAT_FAILED');
  }
  if (cancelled(isCancelled)) return null;
  if (!isFileStats(stats)) {
    throw invalid('原始录音不存在或无法读取，请重新录制后再分享。', 'INVALID_SOURCE');
  }

  const recordingDuration = Number(options.recordingDuration);
  const bpm = Number(options.bpm);
  return {
    filePath: options.source,
    fileName: fileName(options.title, 'original'),
    byteLength: stats.size,
    duration: Number.isFinite(recordingDuration) && recordingDuration >= 0 ? recordingDuration : 0,
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    kind: 'original',
    owned: false,
    format: 'WAV'
  };
}

async function prepareMelody(options) {
  const isCancelled = options.isCancelled;
  const melody = validateMelody(options);
  if (cancelled(isCancelled)) return null;

  const destPath = exportPath();
  const cache = previewCacheOf(options.cachedPreview);
  const key = previewKey(melody.notes, melody.bpm, melody.tone);
  const fallbackDuration = synthesizedDuration(melody.notes, melody.bpm, melody.musicDuration);

  if (cache && cache.key === key && typeof cache.path === 'string' && cache.path) {
    ensureExportDir();
    if (cancelled(isCancelled)) return null;
    let copied = false;
    try {
      await copyFile(cache.path, destPath);
      copied = true;
    } catch (_) {
      removeOwnedFile(destPath);
      if (cancelled(isCancelled)) return null;
    }

    if (copied) {
      if (cancelled(isCancelled)) {
        removeOwnedFile(destPath);
        return null;
      }
      try {
        const stats = await statFile(destPath);
        if (cancelled(isCancelled)) {
          removeOwnedFile(destPath);
          return null;
        }
        if (!isFileStats(stats)) throw new Error('缓存文件为空或不可读');
        const cachedDuration = Number(cache.duration);
        const duration = Number.isFinite(cachedDuration) && cachedDuration >= 0 ? cachedDuration : fallbackDuration;
        return exportResult(destPath, options.title, 'melody', stats.size, duration, melody.bpm);
      } catch (error) {
        removeOwnedFile(destPath);
        if (cancelled(isCancelled)) return null;
      }
    }
  }

  if (cancelled(isCancelled)) return null;
  let synthesized;
  try {
    synthesized = await audio.synthesizeAsync(melody.notes, melody.bpm, melody.tone, isCancelled);
  } catch (error) {
    removeOwnedFile(destPath);
    if (cancelled(isCancelled)) return null;
    throw friendly('旋律音频生成失败，请检查存储空间后重试。', error, 'SYNTHESIZE_FAILED');
  }
  if (!synthesized) {
    removeOwnedFile(destPath);
    return null;
  }
  if (cancelled(isCancelled)) {
    removeOwnedFile(destPath);
    return null;
  }

  let buffer;
  try {
    buffer = await wav.encodeWavAsync(synthesized.samples, synthesized.sampleRate, isCancelled);
  } catch (error) {
    removeOwnedFile(destPath);
    if (cancelled(isCancelled)) return null;
    throw friendly('旋律 WAV 编码失败，请检查存储空间后重试。', error, 'ENCODE_FAILED');
  }
  if (!buffer) {
    removeOwnedFile(destPath);
    return null;
  }
  if (cancelled(isCancelled)) {
    removeOwnedFile(destPath);
    return null;
  }

  ensureExportDir();
  if (cancelled(isCancelled)) return null;
  try {
    await writeFile(destPath, buffer);
  } catch (error) {
    removeOwnedFile(destPath);
    if (cancelled(isCancelled)) return null;
    throw friendly('音频文件写入失败，请检查存储空间后重试。', error, 'WRITE_FAILED');
  }
  if (cancelled(isCancelled)) {
    removeOwnedFile(destPath);
    return null;
  }

  const actualDuration = Number(synthesized.duration);
  return exportResult(destPath, options.title, 'melody', buffer.byteLength,
    Number.isFinite(actualDuration) && actualDuration >= 0 ? actualDuration : fallbackDuration, melody.bpm);
}

async function prepareAudioExport(options) {
  if (!options || typeof options !== 'object') throw invalid('音频导出参数无效。', 'INVALID_OPTIONS');
  if (options.kind === 'original') return prepareOriginal(options);
  if (options.kind === 'melody') return prepareMelody(options);
  throw invalid('不支持的音频分享类型。', 'INVALID_KIND');
}

function cleanupAudioExport(result) {
  if (!result || result.owned !== true || result.kind === 'original') return false;
  return removeOwnedFile(result.filePath);
}

module.exports = { prepareAudioExport, cleanupAudioExport };
