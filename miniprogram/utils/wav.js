function tag(view, at, s) { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); }
function text(view, at, length) { let s = ''; for (let i = 0; i < length && at + i < view.byteLength; i++) s += String.fromCharCode(view.getUint8(at + i)); return s; }

function createWav(length, sampleRate) {
  const buffer = new ArrayBuffer(44 + length * 2);
  const v = new DataView(buffer);
  tag(v, 0, 'RIFF'); v.setUint32(4, buffer.byteLength - 8, true); tag(v, 8, 'WAVE');
  tag(v, 12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(v, 36, 'data'); v.setUint32(40, length * 2, true);
  return buffer;
}
function fillWav(view, samples, start, end) {
  for (let i = start; i < end; i++) { const x = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + 2 * i, Math.round(x * (x < 0 ? 32768 : 32767)), true); }
}
function encodeWav(samples, sampleRate) {
  const buffer = createWav(samples.length, sampleRate);
  fillWav(new DataView(buffer), samples, 0, samples.length);
  return buffer;
}
async function encodeWavAsync(samples, sampleRate, isCancelled) {
  const buffer = createWav(samples.length, sampleRate), view = new DataView(buffer);
  let began = Date.now();
  for (let at = 0; at < samples.length; at += 16384) {
    if (isCancelled && isCancelled()) return null;
    fillWav(view, samples, at, Math.min(samples.length, at + 16384));
    if (Date.now() - began >= 8 && at + 16384 < samples.length) {
      await new Promise(resolve => setTimeout(resolve, 0)); began = Date.now();
    }
  }
  return buffer;
}

function decodeWav(buffer) {
  const v = new DataView(buffer);
  if (v.byteLength < 12 || text(v, 0, 4) !== 'RIFF' || text(v, 8, 4) !== 'WAVE') return null;
  let format = 0, channels = 0, sampleRate = 0, bits = 0, dataAt = -1, dataSize = 0;
  for (let at = 12; at + 8 <= v.byteLength;) {
    const name = text(v, at, 4), size = v.getUint32(at + 4, true), start = at + 8;
    if (name === 'fmt ' && size >= 16 && start + 16 <= v.byteLength) {
      format = v.getUint16(start, true); channels = v.getUint16(start + 2, true);
      sampleRate = v.getUint32(start + 4, true); bits = v.getUint16(start + 14, true);
    }
    if (name === 'data') { dataAt = start; dataSize = Math.min(size, v.byteLength - start); }
    if (size > v.byteLength) break;
    at = start + size + (size % 2);
  }
  if (dataAt < 0 || !channels || channels > 8 || sampleRate < 4000 || sampleRate > 192000 ||
      !((format === 1 && [8, 16, 24, 32].indexOf(bits) >= 0) || (format === 3 && bits === 32))) {
    throw new Error('录音 WAV 编码暂不支持，请换一台设备试录。');
  }
  const bytes = bits / 8, frames = Math.floor(dataSize / (bytes * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const p = dataAt + (i * channels + ch) * bytes;
      if (format === 3) sum += v.getFloat32(p, true);
      else if (bits === 8) sum += (v.getUint8(p) - 128) / 128;
      else if (bits === 16) sum += v.getInt16(p, true) / 32768;
      else if (bits === 24) { let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16); if (x & 0x800000) x -= 0x1000000; sum += x / 8388608; }
      else sum += v.getInt32(p, true) / 2147483648;
    }
    samples[i] = Number.isFinite(sum) ? sum / channels : 0;
  }
  return { samples, sampleRate };
}

module.exports = { encodeWav, encodeWavAsync, decodeWav };
