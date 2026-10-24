'use strict';

const assert = require('node:assert/strict');

const files = new Map();
const counters = { write: 0, copy: 0, stat: 0, mkdir: 0, unlink: 0 };
const fsState = { mkdirThrows: false, failWrite: false, failShareStat: false, onWrite: null };

function bytesOf(data) {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data).slice());
  if (ArrayBuffer.isView(data)) return Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return Buffer.from(String(data));
}

function fileSystemManager() {
  return {
    mkdirSync() {
      counters.mkdir++;
      if (fsState.mkdirThrows) throw new Error('目录已存在');
    },
    writeFile(options) {
      counters.write++;
      files.set(options.filePath, bytesOf(options.data));
      if (fsState.onWrite) fsState.onWrite(options.filePath);
      if (fsState.failWrite) { options.fail({ errMsg: 'writeFile:fail mock' }); return; }
      options.success({ errMsg: 'writeFile:ok' });
    },
    copyFile(options) {
      counters.copy++;
      if (!files.has(options.srcPath)) { options.fail({ errMsg: 'copyFile:fail no such file' }); return; }
      files.set(options.destPath, Buffer.from(files.get(options.srcPath)));
      options.success({ errMsg: 'copyFile:ok' });
    },
    stat(options) {
      counters.stat++;
      if (fsState.failShareStat && options.path.indexOf('/humnote/share-') >= 0) {
        options.fail({ errMsg: 'stat:fail mock' });
        return;
      }
      if (!files.has(options.path)) { options.fail({ errMsg: 'stat:fail no such file' }); return; }
      const size = files.get(options.path).length;
      options.success({
        errMsg: 'stat:ok',
        stats: { size, isFile: () => true, isDirectory: () => false }
      });
    },
    unlinkSync(filePath) {
      counters.unlink++;
      if (!files.delete(filePath)) throw new Error('unlinkSync:fail no such file');
    }
  };
}

function innerAudioContext() {
  return {
    src: '', currentTime: 0, paused: false, duration: 0, startTime: 0,
    onPlay() {}, onPause() {}, onWaiting() {}, onSeeking() {}, onSeeked() {},
    onEnded() {}, onError() {}, onTimeUpdate() {},
    play() { this.paused = false; }, stop() { this.paused = true; }, destroy() {}
  };
}

const originalWx = global.wx;
global.wx = {
  env: { USER_DATA_PATH: '/mock' },
  getFileSystemManager: fileSystemManager,
  createInnerAudioContext: innerAudioContext
};

const audio = require('../miniprogram/utils/audio');
const wav = require('../miniprogram/utils/wav');
const realSynthesizeAsync = audio.synthesizeAsync;
const realEncodeWavAsync = wav.encodeWavAsync;
let synthesizeCalls = 0;
let encodeCalls = 0;
audio.synthesizeAsync = function() {
  synthesizeCalls++;
  return realSynthesizeAsync.apply(this, arguments);
};
wav.encodeWavAsync = function() {
  encodeCalls++;
  return realEncodeWavAsync.apply(this, arguments);
};

const modulePath = require.resolve('../miniprogram/utils/audio-export');
delete require.cache[modulePath];
const { prepareAudioExport, cleanupAudioExport } = require(modulePath);

function assertWav(filePath, byteLength) {
  assert.ok(files.has(filePath), 'WAV 文件应存在');
  const buffer = files.get(filePath);
  assert.equal(buffer.length, byteLength);
  assert.ok(buffer.length > 44);
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.toString('ascii', 12, 16), 'fmt ');
  assert.equal(buffer.toString('ascii', 36, 40), 'data');
  assert.equal(buffer.readUInt32LE(4), buffer.length - 8);
  assert.equal(buffer.readUInt16LE(20), 1);
  assert.equal(buffer.readUInt16LE(22), 1);
  assert.equal(buffer.readUInt32LE(24), 22050);
  assert.equal(buffer.readUInt16LE(34), 16);
  assert.equal(buffer.readUInt32LE(40), buffer.length - 44);
}

(async () => {
  const notes = [
    { midi: 60, start: 0, duration: .25, velocity: 85 },
    { midi: 64, start: .5, duration: .5, velocity: 75 }
  ];
  const original = '/mock/humnote/recording-user.wav';
  const unrelatedExport = '/mock/humnote/share-existing.wav';
  files.set(original, Buffer.from('RIFF-user-recording'));
  files.set(unrelatedExport, Buffer.from('unrelated-export'));

  let player;
  let staleResult;
  let statFallback;
  try {
    fsState.mkdirThrows = true;
    const [piano, soft] = await Promise.all([
      prepareAudioExport({ kind: 'melody', notes, bpm: 100, tone: 'piano', title: '我的/旋律:*?' }),
      prepareAudioExport({ kind: 'melody', notes, bpm: 100, tone: 'soft', title: '柔和' })
    ]);
    assert.notEqual(piano.filePath, soft.filePath, '并发导出路径必须唯一');
    assert.match(piano.filePath, /^\/mock\/humnote\/share-[a-z0-9-]+\.wav$/);
    assert.equal(piano.fileName, '我的_旋律（旋律）.wav');
    assert.equal(soft.fileName, '柔和（旋律）.wav');
    assert.equal(piano.owned, true);
    assert.equal(piano.kind, 'melody');
    assert.equal(piano.format, 'WAV');
    assert.equal(piano.bpm, 100);
    assert.ok(Math.abs(piano.duration - .9) < .000001);
    assert.ok(Math.abs(soft.duration - .9) < .000001);
    assertWav(piano.filePath, piano.byteLength);
    assertWav(soft.filePath, soft.byteLength);
    assert.notDeepEqual(files.get(piano.filePath), files.get(soft.filePath), '两种音色应生成不同 PCM');
    assert.equal(cleanupAudioExport(piano), true);
    assert.equal(files.has(piano.filePath), false);
    assert.equal(files.has(soft.filePath), true);
    assert.equal(cleanupAudioExport(soft), true);
    console.log('PASS 旋律 WAV：文件头、长度、时长、两种音色、文件名、并发唯一路径与清理');

    const beforeOriginal = Object.assign({}, counters);
    const originalResult = await prepareAudioExport({
      kind: 'original', notes: '不合法也可以', bpm: 'bad', tone: 'bad', title: '录音/原始',
      source: original, recordingDuration: 2.5
    });
    assert.equal(originalResult.filePath, original);
    assert.equal(originalResult.fileName, '录音_原始（原始哼唱）.wav');
    assert.equal(originalResult.byteLength, files.get(original).length);
    assert.equal(originalResult.duration, 2.5);
    assert.equal(originalResult.kind, 'original');
    assert.equal(originalResult.owned, false);
    assert.equal(originalResult.format, 'WAV');
    assert.equal(counters.write, beforeOriginal.write);
    assert.equal(counters.copy, beforeOriginal.copy);
    assert.equal(counters.mkdir, beforeOriginal.mkdir);
    assert.equal(counters.stat, beforeOriginal.stat + 1);
    assert.equal(cleanupAudioExport(originalResult), false);
    assert.ok(files.has(original));
    assert.equal(cleanupAudioExport(Object.assign({}, originalResult, { owned: true, kind: 'melody' })), false);
    assert.ok(files.has(original));
    console.log('PASS 原始哼唱：仅 stat、零写入、不要求音符、cleanup 不删原录音');

    let cancel = false;
    fsState.onWrite = () => { cancel = true; };
    const cancelledResult = await prepareAudioExport({
      kind: 'melody', notes, bpm: 100, tone: 'piano', title: '取消', isCancelled: () => cancel
    });
    fsState.onWrite = null;
    assert.equal(cancelledResult, null);
    assert.equal([...files.keys()].some(path => path.indexOf('/mock/humnote/share-') === 0 && path !== unrelatedExport), false);
    assert.ok(files.has(original));
    console.log('PASS 取消：写入后取消返回 null，并删除本次临时文件');

    player = new audio.Player();
    assert.equal(await player.playNotes(notes, 100, 'piano'), true);
    assert.ok(player.previewCache && files.has(player.previewCache.path));
    const previewPath = player.previewCache.path;
    const previewBytes = Buffer.from(files.get(previewPath));
    synthesizeCalls = 0;
    encodeCalls = 0;
    const cachedResult = await prepareAudioExport({
      kind: 'melody', notes, bpm: 100, tone: 'piano', title: '缓存旋律', cachedPreview: player.previewCache
    });
    assert.equal(synthesizeCalls, 0);
    assert.equal(encodeCalls, 0);
    assert.notEqual(cachedResult.filePath, previewPath);
    assert.deepEqual(files.get(cachedResult.filePath), previewBytes);
    assert.equal(cachedResult.byteLength, previewBytes.length);
    assertWav(cachedResult.filePath, cachedResult.byteLength);
    assert.equal(cleanupAudioExport(cachedResult), true);
    assert.ok(files.has(previewPath), '清理自己的副本不能删除 Player 缓存');
    console.log('PASS 缓存复用：同 key 复制到独立路径，跳过合成，cleanup 保留 Player 缓存');

    files.delete(previewPath);
    synthesizeCalls = 0;
    staleResult = await prepareAudioExport({
      kind: 'melody', notes, bpm: 100, tone: 'piano', title: '失效缓存', cachedPreview: player.previewCache
    });
    assert.equal(synthesizeCalls, 1, '已删除缓存应降级重新合成');
    assert.ok(files.has(staleResult.filePath));

    fsState.failShareStat = true;
    synthesizeCalls = 0;
    statFallback = await prepareAudioExport({
      kind: 'melody', notes, bpm: 100, tone: 'piano', title: 'stat 降级',
      cachedPreview: { key: player.previewCache.key, path: staleResult.filePath, duration: player.previewCache.duration }
    });
    fsState.failShareStat = false;
    assert.equal(synthesizeCalls, 1, '缓存副本 stat 失败应清理副本并重新合成');
    assertWav(statFallback.filePath, statFallback.byteLength);
    console.log('PASS 缓存失效：复制失败或副本 stat 失败会安全降级，不复用缺失文件');

    const beforeErrorFiles = new Set(files.keys());
    fsState.failWrite = true;
    await assert.rejects(
      prepareAudioExport({ kind: 'melody', notes, bpm: 100, tone: 'piano', title: '错误' }),
      error => error.code === 'WRITE_FAILED' && /写入失败/.test(error.message)
    );
    fsState.failWrite = false;
    assert.ok(files.has(original));
    assert.ok(files.has(unrelatedExport));
    assert.equal([...files.keys()].filter(path => path.indexOf('/mock/humnote/share-') === 0 && path !== unrelatedExport)
      .every(path => beforeErrorFiles.has(path)), true);
    console.log('PASS 真实错误：抛出中文错误，失败文件被清理，原录音与其它导出保留');

    const writeBeforeOverlap = counters.write;
    const synthBeforeOverlap = synthesizeCalls;
    await assert.rejects(
      prepareAudioExport({ kind: 'melody', notes: [{ midi: 60, start: 0, duration: 1 }, { midi: 64, start: .5, duration: 1 }], bpm: 100 }),
      error => error.code === 'NOTE_OVERLAP' && /重叠/.test(error.message)
    );
    assert.equal(counters.write, writeBeforeOverlap);
    assert.equal(synthesizeCalls, synthBeforeOverlap);
    await assert.rejects(
      prepareAudioExport({ kind: 'melody', notes: Array.from({ length: 501 }, (_, i) => ({ midi: 60, start: i * .125, duration: .125 })), bpm: 100 }),
      /500/
    );
    await assert.rejects(
      prepareAudioExport({ kind: 'melody', notes: [{ midi: 60, start: 0, duration: 121 }], bpm: 60 }),
      /120 秒/
    );
    console.log('PASS 规则：重叠、500 音符与 120 秒均在合成前拒绝，不静默截断');
  } finally {
    fsState.onWrite = null;
    fsState.failWrite = false;
    fsState.failShareStat = false;
    if (staleResult) cleanupAudioExport(staleResult);
    if (statFallback) cleanupAudioExport(statFallback);
    if (player) player.destroy();
    if (originalWx === undefined) delete global.wx; else global.wx = originalWx;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
