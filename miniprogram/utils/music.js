const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round = n => Math.round(n * 1000) / 1000;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const noteName = midi => NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
const frequency = midi => 440 * Math.pow(2, (midi - 69) / 12);
const midiPitch = hz => 69 + 12 * Math.log2(hz / 440);
const totalBeats = notes => notes.reduce((n, note) => Math.max(n, note.start + note.duration), 0);
const seconds = (notes, bpm) => totalBeats(notes) * 60 / bpm;
const timeLabel = value => Math.floor(value / 60).toString().padStart(2, '0') + ':' + Math.floor(value % 60).toString().padStart(2, '0');

function normalizeNotes(notes) {
  return (notes || []).filter(n => Number.isFinite(n.start) && Number.isFinite(n.duration) && Number.isFinite(n.midi))
    .slice(0, 500).sort((a, b) => a.start - b.start).map(n => ({
        id: n.id || uid(), midi: clamp(Math.round(n.midi), 21, 108),
        start: round(Math.max(n.start, 0)), duration: round(clamp(n.duration, .125, 32)),
        velocity: clamp(Math.round(n.velocity || 85), 1, 127),
        confidence: Number.isFinite(n.confidence) ? clamp(n.confidence, 0, 1) : 1
    }));
}

function getOverlaps(notes) {
  const ordered = notes.slice().sort((a, b) => a.start - b.start);
  const ids = new Set(); let pairCount = 0;
  for (let i = 0; i < ordered.length; i++) {
    const end = ordered[i].start + ordered[i].duration;
    for (let j = i + 1; j < ordered.length && ordered[j].start < end - .000001; j++) {
      ids.add(ordered[i].id); ids.add(ordered[j].id); pairCount++;
    }
  }
  return { ids: Array.from(ids), pairCount };
}

function assertNoOverlaps(notes) {
  const overlaps = getOverlaps(notes);
  if (overlaps.ids.length) {
    const error = new Error('音符存在重叠，请调整后再保存或导出。');
    error.code = 'NOTE_OVERLAP'; error.noteIds = overlaps.ids;
    throw error;
  }
  return notes;
}

function moveNote(notes, id, start, midi) {
  return normalizeNotes(notes.map(n => n.id === id ? Object.assign({}, n, { start, midi: midi == null ? n.midi : midi }) : n));
}

function changeDuration(notes, id, duration) {
  const next = notes.map(n => Object.assign({}, n));
  const index = next.findIndex(n => n.id === id);
  if (index < 0) return next;
  // Free editing: resizing a note leaves every other onset unchanged.
  next[index].duration = round(clamp(duration, .125, 32));
  return normalizeNotes(next);
}

function quantize(notes, grid) {
  return normalizeNotes(notes.map(n => Object.assign({}, n, {
    start: Math.round(n.start / grid) * grid,
    duration: Math.max(grid, Math.round(n.duration / grid) * grid)
  })));
}

function demo(bpm) {
  const pitches = [60, 64, 67, 69, 67, 64, 62, 60];
  const lengths = [.75, .75, 1, .5, 1, .75, .75, 1.5];
  let beat = 0;
  return { id: uid(), title: '窗边的一小段旋律', bpm: bpm || 100, isDemo: true, createdAt: Date.now(), updatedAt: Date.now(),
    notes: pitches.map((midi, i) => { const n = { id: uid(), midi, start: beat, duration: lengths[i], velocity: 85, confidence: 1 }; beat += lengths[i]; return n; }), source: null };
}

module.exports = { clamp, round, uid, noteName, frequency, midiPitch, totalBeats, seconds, timeLabel, normalizeNotes, getOverlaps, assertNoOverlaps, moveNote, changeDuration, quantize, demo };
