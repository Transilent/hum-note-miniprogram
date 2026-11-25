// Materialize packaged JS model bytes into WeChat's native local filesystem.
// Model content is SwiftF0 (MIT); see models/LICENSE.swift-f0.txt.
const metadata = require('../models/swift-f0-meta');
function sameBytes(actual, expected) {
  // Native FileSystemManager buffers may originate in a different JS realm.
  if (!actual || Object.prototype.toString.call(actual) !== '[object ArrayBuffer]' || actual.byteLength !== expected.byteLength) return false;
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function prepareModelFile(api, probe) {
  let temporary = '', files;
  try {
    if (!api || !api.env || typeof api.env.USER_DATA_PATH !== 'string' || !api.env.USER_DATA_PATH ||
        typeof api.getFileSystemManager !== 'function' || typeof api.base64ToArrayBuffer !== 'function')
      throw Error('当前环境无法准备本地模型文件。');
    // Ordinary JS modules are included independently of .onnx resource rules.
    const asset = probe ? require('../models/inference-probe-data') : require('../models/swift-f0-cnn-data');
    const expectedHash = probe ? metadata.probeSha256 : metadata.modelSha256;
    if (asset.sha256 !== expectedHash) throw Error('内置模型与版本信息不一致，请重新编译预览。');
    const bytes = api.base64ToArrayBuffer(asset.base64);
    if (!bytes || Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]' || bytes.byteLength !== asset.bytes || !bytes.byteLength)
      throw Error('内置模型数据不完整，请重新编译预览。');
    files = api.getFileSystemManager();
    const directory = api.env.USER_DATA_PATH + '/humnote-models';
    const path = directory + '/' + (probe ? 'probe-' : 'swift-f0-cnn-') + asset.sha256.slice(0, 16) + '.onnx';
    const result = { path, source: 'embedded-js', sha256: asset.sha256, bytes: bytes.byteLength, cacheHit: false };
    let invalidCachedFile = false;
    try {
      const cached = files.readFileSync(path);
      if (sameBytes(cached, bytes)) { result.cacheHit = true; return result; }
      invalidCachedFile = true;
    } catch (_) {}
    try { files.mkdirSync(directory, true); }
    catch (failure) { if (!/exist/i.test(failure.errMsg || failure.message || String(failure))) throw failure; }
    temporary = path + '.part';
    files.writeFileSync(temporary, bytes);
    if (invalidCachedFile) files.unlinkSync(path);
    files.renameSync(temporary, path); temporary = '';
    if (!sameBytes(files.readFileSync(path), bytes)) throw Error('本地模型文件校验失败，请重试。');
    return result;
  } catch (failure) {
    if (temporary && files) { try { files.unlinkSync(temporary); } catch (_) {} }
    const error = new Error('本地模型文件准备失败。');
    error.code = 'SWIFT_FILE'; error.stage = 'file';
    error.detail = String(failure && (failure.errMsg || failure.message) || failure || '').slice(0, 1500);
    throw error;
  }
}
module.exports = { prepareModelFile };
