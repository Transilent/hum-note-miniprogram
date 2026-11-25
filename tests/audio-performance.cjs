const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const audio = require('../miniprogram/utils/audio');
const { synthesize, synthesizeAsync, Player } = audio;
const { encodeWav, encodeWavAsync } = require('../miniprogram/utils/wav');

const EVENT_NAMES = ['Play', 'Pause', 'Waiting', 'Seeking', 'Seeked', 'Canplay', 'Ended', 'Error', 'TimeUpdate'];

function bufferOf(value) {
  return Buffer.from(new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength || value.length));
}

function createPlayerHarness() {
  const files = new Map([['/user-recording.wav', Buffer.from('user-recording')]]);
  const contexts = [];
  const pendingWrites = [];
  let writeMode = 'success';
  let writeCount = 0;
  let playThrows = false;

  function createContext() {
    const listeners = {};
    const inner = {
      src: '', currentTime: 0, duration: 0, paused: true, startTime: 0,
      playCalls: 0, stopCalls: 0, destroyed: false,
      play() {
        this.playCalls++;
        if (playThrows) throw new Error('mock play failure');
        this.paused = false;
      },
      stop() { this.stopCalls++; this.paused = true; },
      destroy() { this.destroyed = true; }
    };
    for (const event of EVENT_NAMES) inner['on' + event] = callback => { listeners[event] = callback; };
    inner.listeners = listeners;
    contexts.push(inner);
    return inner;
  }

  const fs = {
    writeFile(options) {
      writeCount++;
      if (writeMode === 'throw') throw new Error('mock write throw');
      if (writeMode === 'pending') {
        pendingWrites.push({
          path: options.filePath,
          success() { files.set(options.filePath, bufferOf(options.data)); options.success(); },
          fail(error) { options.fail(error || { errMsg: 'writeFile:fail mock' }); }
        });
        return;
      }
      if (writeMode === 'fail') {
        options.fail({ errMsg: 'writeFile:fail mock' });
        return;
      }
      files.set(options.filePath, bufferOf(options.data));
      options.success();
    },
    unlinkSync(path) { files.delete(path); },
    readFile(options) {
      if (!files.has(options.filePath)) { options.fail({ errMsg: 'readFile:fail mock' }); return; }
      options.success({ data: files.get(options.filePath) });
    }
  };

  global.wx = {
    env: { USER_DATA_PATH: '/mock' },
    createInnerAudioContext: createContext,
    getFileSystemManager: () => fs
  };

  return {
    files, contexts, pendingWrites,
    current() { return contexts[contexts.length - 1]; },
    get writes() { return writeCount; },
    setWriteMode(mode) { writeMode = mode; },
    setPlayThrows(value) { playThrows = value; }
  };
}

async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    if ((i & 7) === 7) await new Promise(resolve => setTimeout(resolve, 0));
    else await Promise.resolve();
  }
  throw new Error('Timed out waiting for ' + label);
}

(async () => {
  const notes = [{ midi: 60, start: 0, duration: .125, velocity: 85 }, { midi: 64, start: .3, duration: 1.5, velocity: 75 }, { midi: 67, start: 1.75, duration: 3 }];
  let freshNotes;
  for (const tone of ['piano', 'soft']) {
    const a = synthesize(notes, 100, tone), b = await synthesizeAsync(notes, 100, tone);
    assert.deepEqual(b.samples, a.samples); assert.equal(b.duration, a.duration);
    const encodedWithoutCancellation = await encodeWavAsync(a.samples, a.sampleRate);
    assert.ok(encodedWithoutCancellation instanceof ArrayBuffer, 'no-cancel encoding must return ArrayBuffer');
    assert.equal(encodedWithoutCancellation.byteLength, 44 + a.samples.length * 2);
    assert.deepEqual(encodedWithoutCancellation, encodeWav(a.samples, a.sampleRate));
  }
  console.log('PASS async synthesis/WAV match synchronous samples and bytes for both tones');

  let cancelled = false, heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; cancelled = true; }, 0);
  const many = Array.from({ length: 500 }, (_, i) => ({ midi: 60, start: i * .125, duration: .125 }));
  assert.equal(await synthesizeAsync(many, 100, 'piano', () => cancelled), null);
  clearTimeout(timer); assert.equal(heartbeat, true);
  assert.equal(await encodeWavAsync(new Float32Array(100), 22050, () => true), null);
  console.log('PASS 500 short notes yield to UI and cancellation stops synthesis/encoding');

  const stressNotes = [];
  for (let i = 0; i < 400; i++) stressNotes.push({ midi: 60 + (i % 12), start: i * .001, duration: .5, velocity: 80 });
  for (let i = 0; i < 99; i++) stressNotes.push({ midi: 67, start: 5 + i * 1.15, duration: .125, velocity: 80 });
  stressNotes.push({ midi: 72, start: 119.75, duration: .25, velocity: 80 });
  assert.equal(stressNotes.length, 500);
  const stressStarted = performance.now();
  const syncStress = synthesize(stressNotes, 60, 'piano', 22050);
  let stressHeartbeat = false;
  const stressTimer = setTimeout(() => { stressHeartbeat = true; }, 0);
  const asyncStress = await synthesizeAsync(stressNotes, 60, 'piano', null, 22050);
  clearTimeout(stressTimer);
  assert.equal(stressHeartbeat, true, 'two-minute synthesis must yield to the event loop');
  assert.equal(syncStress.duration, 120.3);
  assert.equal(asyncStress.duration, syncStress.duration);
  assert.equal(asyncStress.samples.length, 2652615);
  assert.equal(Buffer.compare(bufferOf(asyncStress.samples), bufferOf(syncStress.samples)), 0);
  assert.equal(syncStress.samples[Math.round(60 * syncStress.sampleRate)], 0, 'long silent span must remain silent');
  let largest = 0;
  for (const sample of syncStress.samples) { assert.ok(Number.isFinite(sample)); largest = Math.max(largest, Math.abs(sample)); }
  assert.ok(largest <= .9500001, 'dense overlap must stay clipped and finite');
  const syncWavStress = encodeWav(syncStress.samples, syncStress.sampleRate);
  const asyncWavStress = await encodeWavAsync(asyncStress.samples, asyncStress.sampleRate);
  assert.equal(Buffer.compare(bufferOf(asyncWavStress), bufferOf(syncWavStress)), 0);
  assert.equal(syncWavStress.byteLength, 5305274);
  const stressMs = performance.now() - stressStarted;
  assert.ok(stressMs < 15000, 'desktop stress fixture took ' + stressMs.toFixed(0) + ' ms');
  console.log('PASS 120 s / 500 notes / dense overlap / long silence: exact samples+WAV, ' + stressMs.toFixed(0) + ' ms');

  const savedWx = global.wx;
  let stalledCallback;
  global.wx = {
    getFileSystemManager: () => ({
      readFile(options) {
        const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        options.success({ data: data.buffer });
      }
    }),
    createWebAudioContext: () => ({
      decodeAudioData(_buffer, done) {
        if (stalledCallback !== undefined) { stalledCallback = done; return; }
        setTimeout(() => done({
          length: 4, numberOfChannels: 1, sampleRate: 8000,
          getChannelData() { throw new Error('mock channel failure'); }
        }), 0);
      }
    })
  };
  await assert.rejects(audio.decodeFile('/compressed-audio'), error => /录音解码失败/.test(error.message));
  console.log('PASS decoder callback exceptions reject safely instead of escaping asynchronously');
  stalledCallback = null;
  let cancelDecode = false;
  const stalledDecode = audio.decodeFile('/stalled-audio', () => cancelDecode);
  await Promise.resolve();
  assert.equal(typeof stalledCallback, 'function');
  cancelDecode = true;
  assert.equal(await stalledDecode, null, 'cancellation must resolve when the native decoder never calls back');
  stalledCallback({ length: 1, numberOfChannels: 1, sampleRate: 8000, getChannelData() { throw new Error('late callback'); } });
  console.log('PASS stalled platform audio decoder can be cancelled and ignores late completion');

  const harness = createPlayerHarness();
  let ended = 0, errors = [];
  const player = new Player(() => ended++, () => {}, error => errors.push(error));
  try {
    assert.equal(harness.contexts.length, 0, 'Player construction must not allocate an audio context');
    assert.equal(await player.playNotes(notes, 100, 'piano'), true);
    const firstPath = harness.current().src;
    assert.equal(harness.writes, 1);
    await player.playNotes(notes, 100, 'piano');
    assert.equal(harness.writes, 1); assert.equal(harness.contexts.length, 2);
    assert.equal(harness.contexts[0].destroyed, true); assert.equal(harness.current().src, firstPath);
    await player.playNotes(notes, 120, 'piano');
    assert.equal(harness.writes, 2); assert.notEqual(harness.current().src, firstPath);
    assert.equal(harness.files.has(firstPath), false);
    await player.playNotes(notes, 120, 'soft');
    assert.equal(harness.writes, 3);
    const failedPath = harness.current().src;
    harness.current().listeners.Error({ errMsg: 'mock playback failure' });
    assert.equal(errors.length, 1); assert.equal(player.requested, false);
    assert.equal(player.previewCache, null); assert.equal(harness.files.has(failedPath), false);
    await player.playNotes(notes, 120, 'soft'); assert.equal(harness.writes, 4);

    const oldPreviewContext = harness.current();
    freshNotes = [{ midi: 69, start: 0, duration: .25 }];
    await player.playNotes(freshNotes, 100, 'piano');
    assert.equal(harness.writes, 5);
    const freshPath = harness.current().src, freshDuration = player.previewCache.duration;
    oldPreviewContext.duration = 999;
    oldPreviewContext.listeners.TimeUpdate();
    oldPreviewContext.listeners.Ended();
    oldPreviewContext.listeners.Error({ errMsg: 'stale error' });
    assert.equal(player.requested, true);
    assert.equal(player.clock.duration, freshDuration, 'new source must not inherit old duration');
    assert.equal(ended, 0); assert.equal(errors.length, 1);
    assert.equal(player.previewCache.path, freshPath); assert.ok(harness.files.has(freshPath));

    player.playFile('/user-recording.wav');
    const originalContext = harness.current();
    assert.equal(player.requested, true); assert.equal(player.previewCache.path, freshPath);
    originalContext.duration = 9;
    originalContext.listeners.TimeUpdate();
    assert.equal(player.clock.duration, 0, 'duration metadata is ignored until this source is loaded');
    originalContext.duration = 2.75;
    originalContext.listeners.Canplay();
    assert.equal(player.clock.duration, 2.75);
    await player.playNotes(freshNotes, 100, 'piano');
    assert.equal(harness.writes, 5);
    originalContext.duration = 500;
    originalContext.listeners.TimeUpdate();
    originalContext.listeners.Ended();
    originalContext.listeners.Error({ errMsg: 'stale original error' });
    assert.equal(player.requested, true); assert.equal(ended, 0); assert.equal(errors.length, 1);
    assert.equal(player.clock.duration, freshDuration);
    harness.current().listeners.Ended();
    assert.equal(player.requested, false); assert.equal(ended, 1);
  } finally { player.destroy(); }
  assert.deepEqual([...harness.files.keys()], ['/user-recording.wav']);
  assert.equal(await player.playNotes(notes, 100, 'piano'), false);
  console.log('PASS per-source contexts isolate duration/end/error events, cache, and destroy cleanup');

  const race = createPlayerHarness();
  const raceErrors = [];
  const racing = new Player(() => {}, () => {}, error => raceErrors.push(error));
  try {
    race.setWriteMode('pending');
    const staleFailure = racing.playNotes(freshNotes, 100, 'piano');
    await waitFor(() => race.pendingWrites.length === 1, 'stale write');
    racing.stop();
    race.pendingWrites[0].fail({ errMsg: 'late write failure' });
    assert.equal(await staleFailure, false);
    assert.equal(raceErrors.length, 0);

    const currentFailure = racing.playNotes(freshNotes, 100, 'piano');
    await waitFor(() => race.pendingWrites.length === 2, 'current write');
    race.pendingWrites[1].fail({ errMsg: 'current write failure' });
    await assert.rejects(currentFailure, error => error && error.errMsg === 'current write failure');
    assert.equal(racing.requested, false);

    race.setWriteMode('success');
    assert.equal(await racing.playNotes(freshNotes, 100, 'piano'), true);
    const beforeRace = race.writes;
    race.setWriteMode('pending');
    const first = racing.playNotes([{ midi: 60, start: 0, duration: .125 }], 100, 'piano');
    await waitFor(() => race.pendingWrites.length === 3, 'old write');
    const second = racing.playNotes([{ midi: 62, start: 0, duration: .125 }], 100, 'piano');
    await waitFor(() => race.pendingWrites.length === 4, 'new write');
    const oldWrite = race.pendingWrites[2], newWrite = race.pendingWrites[3];
    newWrite.success(); assert.equal(await second, true);
    const newestPath = race.current().src;
    oldWrite.success(); assert.equal(await first, false);
    assert.equal(race.current().src, newestPath);
    assert.equal(race.files.has(oldWrite.path), false);
    assert.equal(race.writes, beforeRace + 2);
  } finally { racing.destroy(); }
  assert.deepEqual([...race.files.keys()], ['/user-recording.wav']);

  const closed = createPlayerHarness();
  const closeErrors = [];
  const closingPlayer = new Player(() => {}, () => {}, error => closeErrors.push(error));
  try {
    closed.setWriteMode('pending');
    const pendingAtLeave = closingPlayer.playNotes(freshNotes, 100, 'piano');
    await waitFor(() => closed.pendingWrites.length === 1, 'write before page leave');
    closingPlayer.destroy();
    closed.pendingWrites[0].fail({ errMsg: 'write failed after leave' });
    assert.equal(await pendingAtLeave, false);
    assert.equal(closeErrors.length, 0);
    assert.equal(closed.contexts.length, 0, 'leaving before file readiness must not recreate audio');
  } finally { closingPlayer.destroy(); }
  assert.deepEqual([...closed.files.keys()], ['/user-recording.wav']);
  console.log('PASS late write success/failure/leave is ignored after stop or replacement; current failure still rejects');

  const switching = createPlayerHarness();
  const switchErrors = [];
  const switchPlayer = new Player(() => {}, () => {}, error => switchErrors.push(error));
  const switchStarted = performance.now();
  try {
    for (let i = 0; i < 100; i++) {
      assert.equal(switchPlayer.playFile('/user-recording.wav'), true);
      switching.current().listeners.Play();
      assert.notEqual(switchPlayer.progressTimer, null);
    }
    switchPlayer.stop();
    assert.equal(switchPlayer.progressTimer, null);
    assert.equal(switchPlayer.requested, false);
    assert.equal(switching.contexts.length, 100);
    assert.equal(switching.contexts.every(context => context.destroyed), true);
    assert.equal(switchErrors.length, 0);
  } finally { switchPlayer.destroy(); }
  const switchMs = performance.now() - switchStarted;
  assert.ok(switchMs < 3000, '100 source switches took ' + switchMs.toFixed(0) + ' ms');
  console.log('PASS 100 rapid source switches destroy every old context/timer without stale errors, ' + switchMs.toFixed(0) + ' ms');

  const playFailure = createPlayerHarness();
  playFailure.setPlayThrows(true);
  const playErrors = [];
  const failedPlayer = new Player(() => {}, () => {}, error => playErrors.push(error));
  try {
    assert.equal(failedPlayer.playFile('/user-recording.wav'), false);
    assert.equal(playErrors.length, 0, 'error callback must run after the page call stack');
    await Promise.resolve();
    assert.equal(failedPlayer.requested, false);
    assert.equal(playErrors.length, 1);
  } finally { failedPlayer.destroy(); }
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
  console.log('PASS synchronous native play failure is contained and reported once');
  const notesFailure = createPlayerHarness();
  notesFailure.setPlayThrows(true);
  const notesFailurePlayer = new Player();
  await assert.rejects(notesFailurePlayer.playNotes(notes, 100, 'soft'), /mock play failure/);
  assert.equal(notesFailurePlayer.requested, false, 'synchronous melody start failure must reset the request');
  assert.equal(notesFailurePlayer.inner, null, 'failed melody context must not be retained');
  assert.ok(notesFailure.contexts.every(context => context.destroyed), 'failed native context must be destroyed immediately');
  assert.equal(notesFailurePlayer.progressTimer, null);
  notesFailurePlayer.destroy();
  console.log('PASS synchronous melody start rejection immediately releases its context and timer');
})().catch(error => { console.error(error); process.exitCode = 1; });
