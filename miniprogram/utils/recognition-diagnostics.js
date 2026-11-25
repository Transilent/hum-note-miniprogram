const KEY = 'humnote.recognition-diagnostics.v1';
function runtime(api) {
  let device = {}, app = {};
  try { device = api.getDeviceInfo ? api.getDeviceInfo() : api.getSystemInfoSync ? api.getSystemInfoSync() : {}; } catch (_) {}
  try { app = api.getAppBaseInfo ? api.getAppBaseInfo() : device; } catch (_) {}
  return { brand: device.brand || '', model: device.model || '', system: device.system || '', platform: device.platform || '',
    wechat: app.version || '', sdk: app.SDKVersion || '', createInferenceSession: typeof api.createInferenceSession === 'function' };
}
function failureInfo(value) {
  return { code: String(value && value.code || 'UNKNOWN'), stage: String(value && value.stage || ''),
    nativeCode: String(value && value.nativeCode || ''),
    modelFile: value && value.modelFile || null,
    detail: String(value && (value.detail || value.errMsg || value.message) || value || '').slice(0, 1500) };
}
function saveReport(api, report) { try { api.setStorageSync(KEY, report); } catch (_) {} return report; }
function lastReport(api) { try { return api.getStorageSync(KEY) || null; } catch (_) { return null; } }
function recordFailure(api, value) {
  const meta = require('../models/swift-f0-meta');
  return saveReport(api, { date: Date.now(), version: meta.version, modelSha256: meta.modelSha256, runtime: runtime(api),
    ok: false, failedCheck: 'recognition', failure: failureInfo(value) });
}
function environment(api) {
  return new Promise(resolve => {
    if (typeof api.getInferenceEnvInfo !== 'function') { resolve({ status: 'api-missing' }); return; }
    let finished = false;
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish({ status: 'timeout' }), 3000);
    try { api.getInferenceEnvInfo({ success: value => finish({ status: 'available', info: value }),
      fail: value => finish({ status: 'failed', error: failureInfo(value) }) }); }
    catch (value) { finish({ status: 'failed', error: failureInfo(value) }); }
  });
}
function explanation(report) {
  if (report && report.ok) return '基础推理和 SwiftF0 模型均通过检查。可以尝试录音；识别准确度仍需用实际哼唱判断。';
  if (report && report.failure && (report.failure.code === 'SWIFT_FILE' || /model path invalid/i.test(report.failure.detail || '')))
    return '实验识别停在模型文件准备或路径解析阶段，尚未完成模型加载。请复制报告定位文件问题；本次不能据此判断设备或算子不支持。';
  if (report && report.failedCheck === 'engine') return '微信基础推理检查未通过。请保留具体错误，更新微信后重试；这还不能判定手机硬件不支持。';
  return 'SwiftF0 模型未能运行。原生推理接口与模型兼容性需要进一步定位，可复制报告查看具体阶段和错误。';
}
function copyReport(api, report) {
  if (!api.setClipboardData) return false;
  api.setClipboardData({ data: JSON.stringify(report, null, 2) }); return true;
}
module.exports = { KEY, runtime, failureInfo, saveReport, lastReport, recordFailure, environment, explanation, copyReport };
