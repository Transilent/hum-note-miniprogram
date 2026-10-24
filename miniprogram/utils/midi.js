const { normalizeNotes, assertNoOverlaps, clamp } = require('./music');
const PPQ = 480;
function vlq(n) { n = Math.max(0, Math.round(n)); const bytes = [n & 127]; while ((n = Math.floor(n / 128)) > 0) bytes.unshift((n & 127) | 128); return bytes; }
function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function ascii(s) { return s.split('').map(c => c.charCodeAt(0)); }

function encodeMidi(notes, bpm) {
  const normalized = assertNoOverlaps(normalizeNotes(notes));
  const tempo = Math.round(60000000 / clamp(Number(bpm) || 100, 40, 240));
  const track = [0, 0xff, 0x51, 3, (tempo >>> 16) & 255, (tempo >>> 8) & 255, tempo & 255,
    0, 0xff, 0x58, 4, 4, 2, 24, 8, 0, 0xc0, 0];
  const events = [];
  normalized.forEach(note => {
    const start = Math.round(note.start * PPQ), end = Math.max(start + 1, Math.round((note.start + note.duration) * PPQ));
    events.push({ tick: start, off: false, midi: note.midi, velocity: note.velocity });
    events.push({ tick: end, off: true, midi: note.midi, velocity: 0 });
  });
  events.sort((a, b) => a.tick - b.tick || Number(b.off) - Number(a.off));
  let previous = 0;
  events.forEach(e => { track.push(...vlq(e.tick - previous), e.off ? 0x80 : 0x90, e.midi, e.velocity); previous = e.tick; });
  track.push(0, 0xff, 0x2f, 0);
  const bytes = [...ascii('MThd'), ...u32(6), 0, 0, 0, 1, (PPQ >>> 8) & 255, PPQ & 255, ...ascii('MTrk'), ...u32(track.length), ...track];
  return new Uint8Array(bytes).buffer;
}
module.exports = { encodeMidi, vlq, PPQ };
