const assert = require('node:assert/strict');
const { synthesize, synthesizeAsync, Player } = require('../miniprogram/utils/audio');
const { encodeWav, encodeWavAsync } = require('../miniprogram/utils/wav');

(async () => {
  const notes = [{ midi: 60, start: 0, duration: .125, velocity: 85 }, { midi: 64, start: .3, duration: 1.5, velocity: 75 }, { midi: 67, start: 1.75, duration: 3 }];
  for (const tone of ['piano', 'soft']) {
    const a = synthesize(notes, 100, tone), b = await synthesizeAsync(notes, 100, tone);
    assert.deepEqual(b.samples, a.samples); assert.equal(b.duration, a.duration);
    assert.deepEqual(await encodeWavAsync(a.samples, a.sampleRate), encodeWav(a.samples, a.sampleRate));
  }
  console.log('PASS async synthesis/WAV match synchronous samples and bytes for both tones');
  let cancelled = false, heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; cancelled = true; }, 0);
  const many = Array.from({ length: 500 }, (_, i) => ({ midi: 60, start: i * .125, duration: .125 }));
  assert.equal(await synthesizeAsync(many, 100, 'piano', () => cancelled), null);
  clearTimeout(timer); assert.equal(heartbeat, true);
  assert.equal(await encodeWavAsync(new Float32Array(100), 22050, () => true), null);
  console.log('PASS 500 short notes yield to UI and cancellation stops synthesis/encoding');
  const files = new Map([['/user.wav', true]]), listeners = {};
  let writes = 0, plays = 0;
  const inner = { src: '', stop() {}, destroy() {}, play() { plays++; } };
  for (const event of ['Play', 'Pause', 'Waiting', 'Seeking', 'Seeked', 'Ended', 'Error', 'TimeUpdate']) inner['on' + event] = callback => { listeners[event] = callback; };
  global.wx = { env: { USER_DATA_PATH: '/mock' }, createInnerAudioContext: () => inner,
    getFileSystemManager: () => ({ writeFile(options) { writes++; files.set(options.filePath, options.data); options.success(); }, unlinkSync(file) { files.delete(file); } }) };
  const player = new Player();
  try {
    await player.playNotes(notes, 100, 'piano'); const firstPath = inner.src;
    await player.playNotes(notes, 100, 'piano'); assert.equal(writes, 1); assert.equal(plays, 2); assert.equal(inner.src, firstPath);
    await player.playNotes(notes, 120, 'piano'); assert.equal(writes, 2); assert.notEqual(inner.src, firstPath); assert.equal(files.has(firstPath), false);
    await player.playNotes(notes, 120, 'soft'); assert.equal(writes, 3);
    listeners.Error({ errMsg: 'mock failure' }); await player.playNotes(notes, 120, 'soft'); assert.equal(writes, 4);
    const obsolete = player.playNotes(many, 100, 'piano'); player.stop(); assert.equal(await obsolete, false); assert.equal(writes, 4);
  } finally { player.destroy(); }
  assert.deepEqual([...files.keys()], ['/user.wav']); assert.equal(await player.playNotes(notes, 100, 'piano'), false);
  console.log('PASS preview cache, BPM/tone invalidation, error recovery, cancellation and owned-file cleanup');
  const pendingWrites = [];
  global.wx.getFileSystemManager = () => ({ writeFile(options) { pendingWrites.push(options); }, unlinkSync(file) { files.delete(file); } });
  const racing = new Player();
  try {
    const a = racing.playNotes([{ midi: 60, start: 0, duration: .125 }], 100, 'piano');
    await Promise.resolve(); await Promise.resolve();
    const b = racing.playNotes([{ midi: 62, start: 0, duration: .125 }], 100, 'piano');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(pendingWrites.length, 2);
    files.set(pendingWrites[1].filePath, true); pendingWrites[1].success(); assert.equal(await b, true);
    const newest = inner.src;
    files.set(pendingWrites[0].filePath, true); pendingWrites[0].success(); assert.equal(await a, false);
    assert.equal(inner.src, newest); assert.equal(files.has(pendingWrites[0].filePath), false);
  } finally { racing.destroy(); }
  assert.deepEqual([...files.keys()], ['/user.wav']);
  console.log('PASS out-of-order file writes cannot replace a newer preview or leave stale files');
})().catch(error => { console.error(error); process.exitCode = 1; });
