// Avoid parsing or initializing either recognizer during homepage startup.
let swift = null;
async function transcribe(input, sampleRate, bpm, onProgress, isCancelled, options) {
  const config = options || {};
  const cancelled = () => isCancelled && isCancelled();
  if (config.mode === 'swift-f0') {
    try {
      if (!swift) swift = require('./swift-f0');
      return await swift.transcribe(input, sampleRate, bpm, onProgress, isCancelled, config);
    } catch (failure) {
      if (cancelled() || failure.code === 'CANCELLED' || !/^SWIFT_/.test(failure.code || '')) throw failure;
      swift.dispose();
      const api = config.api || (typeof wx !== 'undefined' ? wx : null);
      const diagnostic = api ? require('./recognition-diagnostics').recordFailure(api, failure) : null;
      if (config.onStage) config.onStage('实验识别不可用，正在使用标准识别');
      const result = await require('./pitch').transcribe(input, sampleRate, bpm, onProgress, isCancelled);
      return Object.assign({}, result, { engine: 'yin', fallbackFrom: 'swift-f0', fallbackReason: failure.code, fallbackDiagnostic: diagnostic });
    }
  }
  const result = await require('./pitch').transcribe(input, sampleRate, bpm, onProgress, isCancelled);
  return Object.assign({}, result, { engine: 'yin' });
}
function dispose() { if (swift) swift.dispose(); }
function checkCompatibility(api, isCancelled, onStage) {
  if (!swift) swift = require('./swift-f0');
  return swift.checkCompatibility(api, isCancelled, onStage);
}
module.exports = { transcribe, dispose, checkCompatibility };
