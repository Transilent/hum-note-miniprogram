// Verify that the deployed recognizer is the recognizer evaluated offline.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const options = {}; for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!options.root || !options.cache || !options.selection) throw Error('Required: --root DATA --cache CACHE --selection RESULTS/selection.json [--out RESULTS]');
const current = require('../miniprogram/utils/pitch'), music = require('../miniprogram/utils/music');
const { predict } = require('./humtrans-evaluate.cjs'), { decodeWav } = require('../miniprogram/utils/wav');
const selected = JSON.parse(fs.readFileSync(options.selection, 'utf8')).selected;
const records = fs.readdirSync(options.cache).filter(n => /^[FM]\d\d_.*\.json$/.test(n))
  .map(n => JSON.parse(fs.readFileSync(path.join(options.cache, n), 'utf8')));
const report = { passed: true, cached_postprocess_recordings: records.length, full_audio_train_stems: [] };
for (const x of records) {
  const notes = music.normalizeNotes(current.framesToNotes(x[selected.source].frames, x.hop, 100));
  assert.deepEqual(notes.map(n => ({ start: n.start * .6, end: (n.start + n.duration) * .6, midi: n.midi })), predict(x, selected));
}
(async () => {
  console.log('PASS deployed postprocessor:', records.length, 'recordings');
  for (const group of [['female','D'],['male','D'],['male','DD'],['male','DDD']]) {
    const x = records.find(x => x.row.split === 'TRAIN' && x.row.sex === group[0] && x.row.octave_tag === group[1]);
    if (!x) continue;
    const bytes = fs.readFileSync(path.join(options.root, x.row.wav_path));
    const audio = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    let result = [];
    try { result = (await current.transcribe(audio.samples, audio.sampleRate, 100)).notes; } catch (error) { if (predict(x, selected).length) throw error; }
    assert.deepEqual(music.normalizeNotes(result).map(n => ({ start: n.start * .6, end: (n.start + n.duration) * .6, midi: n.midi })), predict(x, selected));
    report.full_audio_train_stems.push(x.row.stem); console.log('PASS deployed full audio:', x.row.stem);
  }
  if (options.out) { fs.mkdirSync(options.out, { recursive: true }); fs.writeFileSync(path.join(options.out, 'runtime-parity.json'), JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
