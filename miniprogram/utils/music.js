const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const MIN_DURATION = .0625;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
// The shortest editable note is exactly one sixteenth of a beat.
const round = n => Math.round(n * 10000 + 1e-9) / 10000;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const noteName = midi => NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
const frequency = midi => 440 * Math.pow(2, (midi - 69) / 12);
const midiPitch = hz => 69 + 12 * Math.log2(hz / 440);
const totalBeats = notes => notes.reduce((n, note) => Math.max(n, note.start + note.duration), 0);
const seconds = (notes, bpm) => totalBeats(notes) * 60 / bpm;
const timeLabel = value => Math.floor(value / 60).toString().padStart(2, '0') + ':' + Math.floor(value % 60).toString().padStart(2, '0');

function normalizeNotes(notes) {
  return (Array.isArray(notes) ? notes : []).filter(n => n && Number.isFinite(n.start) && Number.isFinite(n.duration) && Number.isFinite(n.midi))
    .slice(0, 500).sort((a, b) => a.start - b.start).map(n => ({
        id: n.id || uid(), midi: clamp(Math.round(n.midi), 21, 108),
        start: round(Math.max(n.start, 0)), duration: round(clamp(n.duration, MIN_DURATION, 32)),
        velocity: clamp(Math.round(n.velocity || 85), 1, 127),
        confidence: Number.isFinite(n.confidence) ? clamp(n.confidence, 0, 1) : 1
    }));
}

function getOverlaps(notes) {
  const ordered = notes.slice().sort((a, b) => a.start - b.start);
  const ids = new Set(); let pairCount = 0, previousEnd = -Infinity;
  for (let i = 0; i < ordered.length; i++) {
    const end = ordered[i].start + ordered[i].duration;
    // Count following starts with binary search instead of visiting every
    // overlapping pair. Dense temporary layouts can contain 124,750 pairs.
    let low = i + 1, high = low < ordered.length && ordered[low].start < end - .000001 ? ordered.length : low;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ordered[middle].start < end - .000001) low = middle + 1;
      else high = middle;
    }
    const following = low - i - 1;
    pairCount += following;
    if (following || ordered[i].start < previousEnd - .000001) ids.add(ordered[i].id);
    previousEnd = Math.max(previousEnd, end);
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
  next[index].duration = round(clamp(duration, MIN_DURATION, 32));
  return normalizeNotes(next);
}

function splitNote(notes, id, at) {
  const index = notes.findIndex(note => note.id === id), point = round(at);
  if (index < 0 || notes.length >= 500 || !Number.isFinite(point)) return null;
  const note = notes[index], left = round(point - note.start), right = round(note.start + note.duration - point);
  if (left < MIN_DURATION || right < MIN_DURATION) return null;
  const result = notes.slice();
  result.splice(index, 1, Object.assign({}, note, { duration: left }),
    Object.assign({}, note, { id: uid(), start: point, duration: right }));
  return result;
}

function nextSamePitch(notes, id) {
  const index = notes.findIndex(note => note.id === id);
  const first = notes[index], second = notes[index + 1];
  if (!first || !second || first.midi !== second.midi) return null;
  const length = round(Math.max(first.start + first.duration, second.start + second.duration) - first.start);
  if (length > 32) return null;
  return { first, second, length, gap: round(Math.max(0, second.start - first.start - first.duration)) };
}

function mergeNotes(notes, firstId, secondId) {
  const pair = nextSamePitch(notes, firstId);
  if (!pair || pair.second.id !== secondId) return null;
  return notes.filter(note => note.id !== secondId).map(note =>
    note.id === firstId ? Object.assign({}, note, { duration: pair.length }) : note);
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

module.exports = { MIN_DURATION, clamp, round, uid, noteName, frequency, midiPitch, totalBeats, seconds,
  timeLabel, normalizeNotes, getOverlaps, assertNoOverlaps, moveNote, changeDuration, splitNote, nextSamePitch, mergeNotes, quantize, demo };
