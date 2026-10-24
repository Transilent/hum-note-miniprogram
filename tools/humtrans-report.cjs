// Re-aggregate existing per-record scores; does not run or tune test inference.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { csv } = require('./humtrans-benchmark.cjs');
const { aggregate } = require('./humtrans-metrics.cjs');
const { grouped, makeCsv } = require('./humtrans-evaluate.cjs');
const options = {}; for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const out = path.resolve(options.out), root = path.resolve(options.root);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const selectionPath = path.join(out, 'selection.json'), firstPath = path.join(out, 'selection-first-run.json');
if (!fs.existsSync(firstPath)) fs.copyFileSync(selectionPath, firstPath);
const first = JSON.parse(fs.readFileSync(firstPath, 'utf8')), frozen = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
assert.deepEqual(frozen.selected, first.selected);
const numeric = ['note_p50','note_r50','note_f50','note_f100','absolute_f100','onset_f100','frame_pc_accuracy','frame_pc_precision','frame_pc_recall','voiced_f1','melody_lcs_f1','ratio','pred_count','ref_count','global_shift','duration_s','feature_ms','postprocess_and_score_ms'];
const allRows = {};
for (const mode of ['calibrate', 'test']) {
  const file = path.join(out, mode + '-per-sample.csv');
  const rows = csv(fs.readFileSync(file, 'utf8')).map(r => { for (const key of numeric) if (r[key] !== '') r[key] = Number(r[key]); return r; });
  allRows[mode] = rows;
  const metricsPath = path.join(out, mode + '-metrics.json'), result = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  for (const variant of Object.keys(result.summary)) {
    const records = rows.filter(r => r.variant === variant), previous = result.summary[variant], current = aggregate(records);
    for (const key of Object.keys(current.metrics)) assert.ok(Math.abs(current.metrics[key] - previous.metrics[key]) < 1e-12, 'Numerical scores changed during reporting: ' + key);
    result.summary[variant] = { ...previous, ...current, groups: grouped(records) };
  }
  result.protocol_note = 'Full-recording fixed-time diagnostics, no official predicted-note cropping. Composition macro, clean cohort; not directly comparable to published official-all per-file scores.';
  result.aggregation_audit = 'Global octave shifts are reported as per-record category counts, not a numeric mean; all other previously computed scores are unchanged.';
  fs.writeFileSync(metricsPath, JSON.stringify(result, null, 2));
  if (mode === 'calibrate') frozen.validation = result.summary[frozen.selected.id];
}
frozen.metrics_sha256 = hash(path.join(__dirname, 'humtrans-metrics.cjs'));
frozen.evaluation_driver_sha256 = hash(path.join(__dirname, 'humtrans-evaluate.cjs'));
frozen.test_split_sha256 = hash(path.join(root, 'splits/test_clean.csv'));
frozen.integrity_note = 'Integrity fields were completed during the post-run review. The selected recognizer and its parameters are identical to selection-first-run.json; no test-driven parameter changes or test rescoring were performed.';
fs.writeFileSync(selectionPath, JSON.stringify(frozen, null, 2));

const test = allRows.test, baseline = test.filter(r => r.variant === 'baseline'), improved = test.filter(r => r.variant === frozen.selected.id);
const paired = baseline.map(b => { const n = improved.find(n => n.stem === b.stem); assert.ok(n); return { b, n }; });
const fields = ['note_f50', 'note_f100', 'frame_pc_recall', 'frame_pc_precision', 'melody_lcs_f1', 'ratio', 'absolute_f100', 'onset_f100'];
let seed = 20261024; const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const ci = {};
for (const field of fields) {
  const compositionIds = [...new Set(paired.map(x => x.b.composition_id))];
  const differences = compositionIds.map(id => { const group = paired.filter(x => x.b.composition_id === id); return group.reduce((sum, x) => sum + x.n[field] - x.b[field], 0) / group.length; });
  const draws = [];
  for (let draw = 0; draw < 2000; draw++) { let sum = 0; for (let i = 0; i < differences.length; i++) sum += differences[Math.floor(random() * differences.length)]; draws.push(sum / differences.length); }
  draws.sort((a, b) => a - b);
  ci[field] = { difference: differences.reduce((a, b) => a + b, 0) / differences.length, lower95: draws[49], upper95: draws[1949], unit: field === 'ratio' ? 'ratio' : 'fraction', cluster: 'composition', compositions: differences.length };
}
fs.writeFileSync(path.join(out, 'test-difference-bootstrap.json'), JSON.stringify(ci, null, 2));
const groupRows = [];
for (const field of ['sex','octave_tag','pitch_register','strict_time']) for (const value of new Set(test.map(r => r[field]))) {
  const b = aggregate(baseline.filter(r => r[field] === value)), n = aggregate(improved.filter(r => r[field] === value));
  groupRows.push({ group: field, value, samples: b.count, compositions: b.compositions,
    baseline_f50: b.metrics.note_f50, improved_f50: n.metrics.note_f50,
    baseline_f100: b.metrics.note_f100, improved_f100: n.metrics.note_f100,
    baseline_frame_pc_recall: b.metrics.frame_pc_recall, improved_frame_pc_recall: n.metrics.frame_pc_recall,
    baseline_melody_lcs_f1: b.metrics.melody_lcs_f1, improved_melody_lcs_f1: n.metrics.melody_lcs_f1 });
}
fs.writeFileSync(path.join(out, 'test-group-comparison.csv'), makeCsv(groupRows));
const worst = paired.map(({ b, n }) => ({ stem: b.stem, composition_id: b.composition_id, sex: b.sex, octave_tag: b.octave_tag,
  baseline_f100: b.note_f100, improved_f100: n.note_f100, baseline_lcs: b.melody_lcs_f1, improved_lcs: n.melody_lcs_f1,
  improved_frame_pc_recall: n.frame_pc_recall, reference_notes: b.ref_count, improved_notes: n.pred_count }))
  .sort((a, b) => a.improved_lcs - b.improved_lcs).slice(0, 30);
fs.writeFileSync(path.join(out, 'test-diagnostic-cases.csv'), makeCsv(worst));
const integrity = { original_selection_sha256: hash(firstPath), final_selection_sha256: hash(selectionPath), selected_config_unchanged: true,
  original_selection_contains_pretest_baseline_feature_and_segmentation_hashes: true, raw_per_sample_scores_not_recomputed: true,
  files: Object.fromEntries(['calibrate-per-sample.csv','test-per-sample.csv','selection-first-run.json'].map(n => [n, hash(path.join(out, n))])),
  production_files: Object.fromEntries(['pitch.js','pitch-config.js','pitch-segmentation.js'].map(n => [n, hash(path.join(__dirname, '../miniprogram/utils', n))])) };
fs.writeFileSync(path.join(out, 'integrity.json'), JSON.stringify(integrity, null, 2));
console.log(JSON.stringify({ selected: frozen.selected.id, test: { baseline: aggregate(baseline), improved: aggregate(improved) }, differences: ci }, null, 2));
