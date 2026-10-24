const SCOPE_RECORD = 'scope.record';

const DEFAULT_RECORD_OPTIONS = {
  duration: 30000,
  sampleRate: 16000,
  numberOfChannels: 1,
  format: 'wav'
};

function errMsg(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.errMsg || error.message || String(error);
}

function callWx(api, options) {
  return new Promise(resolve => {
    if (typeof api !== 'function') {
      resolve({ ok: false, unsupported: true, error: { errMsg: '当前微信版本不支持该接口' } });
      return;
    }
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      api(Object.assign({}, options || {}, {
        success: value => done({ ok: true, value }),
        fail: error => done({ ok: false, error: error || { errMsg: '接口调用失败' } })
      }));
    } catch (error) {
      done({ ok: false, error: error || { errMsg: '接口同步抛错' } });
    }
  });
}

async function getPrivacySetting(wx) {
  if (!wx || typeof wx.getPrivacySetting !== 'function') {
    return { ok: false, unsupported: true, error: { errMsg: '当前基础库不支持 getPrivacySetting' } };
  }
  return callWx(wx.getPrivacySetting.bind(wx), {});
}

async function getScopeRecordState(wx) {
  if (!wx || typeof wx.getSetting !== 'function') {
    return { state: 'unknown', error: { errMsg: '当前环境不支持 wx.getSetting' }, available: false };
  }
  const result = await callWx(wx.getSetting.bind(wx), {});
  if (!result.ok) return { state: 'unknown', error: result.error, available: true };
  const authSetting = result.value && result.value.authSetting;
  if (!authSetting || !Object.prototype.hasOwnProperty.call(authSetting, SCOPE_RECORD)) {
    return { state: 'unknown', error: null, available: true, authSetting: authSetting || {} };
  }
  return { state: authSetting[SCOPE_RECORD], error: null, available: true, authSetting };
}

function getWechatMicrophoneState(wx) {
  if (!wx || typeof wx.getAppAuthorizeSetting !== 'function') {
    return { state: 'unknown', available: false, error: { errMsg: '当前环境不支持 getAppAuthorizeSetting' } };
  }
  try {
    const setting = wx.getAppAuthorizeSetting();
    return {
      state: setting && setting.microphoneAuthorized ? setting.microphoneAuthorized : 'unknown',
      available: true,
      error: null,
      setting: setting || null
    };
  } catch (error) {
    return { state: 'unknown', available: false, error: error || { errMsg: 'getAppAuthorizeSetting 抛错' } };
  }
}

async function ensurePrivacyAuthorized(wx) {
  if (!wx || typeof wx.requirePrivacyAuthorize !== 'function') {
    return { ok: true, skipped: true, reason: 'unsupported' };
  }
  return callWx(wx.requirePrivacyAuthorize.bind(wx), {});
}

function classifyPrivacyFailure(error, privacySetting) {
  const message = errMsg(error);
  if (/api scope is not declared in the privacy agreement/i.test(message) || /隐私(?:保护指引|协议).*未声明.*(?:接口|类型)/i.test(message)) {
    return 'privacy-undeclared';
  }
  if (/appid privacy api banned|privacy (?:contract|policy|agreement).*(?:not configured|not set|missing|banned)/i.test(message) ||
      /(?:未配置|未发布|未声明).*(?:隐私保护指引|隐私协议)|(?:隐私保护指引|隐私协议).*(?:未配置|未发布|被禁用)/i.test(message)) {
    return 'privacy-config';
  }
  if (/privacy permission is not authorized|privacy authorization.*denied|用户(?:拒绝|未同意).*隐私/i.test(message)) {
    return 'privacy-declined';
  }
  const setting = privacySetting && privacySetting.ok && privacySetting.value;
  if (setting && setting.needAuthorization === false && !setting.privacyContractName && /privacy|隐私/i.test(message)) {
    return 'privacy-config';
  }
  return 'privacy-error';
}

function classifyRecordError(error, context) {
  context = context || {};
  const message = errMsg(error);
  if (context.scopeState === false) return 'scope-denied';
  if (context.micState === 'denied') return 'system-denied';

  if (/api scope is not declared in the privacy agreement/i.test(message)) return 'privacy-undeclared';
  if (/appid privacy api banned/i.test(message)) return 'privacy-config';
  if (/privacy permission is not authorized|privacy authorization.*denied/i.test(message)) return 'privacy-declined';
  if (/system permission|microphone.*(?:denied|not authorized|not permitted)|麦克风.*(?:权限|拒绝|未授权)/i.test(message)) return 'system-denied';
  if (/timeout|timed out|onstart.*(?:timeout|未返回)/i.test(message)) return 'record-timeout';
  if (/busy|occupied|in use|interrupt|占用|中断|正在使用/i.test(message)) return 'record-busy';
  return 'record-error';
}
function createIssue(code, meta) {
  meta = meta || {};
  const canOpenScopeSettings = meta.canOpenScopeSettings !== false;
  const canOpenAppSettings = meta.canOpenAppSettings !== false;
  const canOpenPrivacyContract = meta.canOpenPrivacyContract !== false;
  const base = {
    code,
    diagnostic: meta.diagnostic ? String(meta.diagnostic) : '',
    action: 'none',
    context: meta.context || null
  };
  switch (code) {
    case 'scope-denied':
      return Object.assign(base, {
        title: '小程序没有录音权限',
        content: '你之前拒绝过本小程序的录音权限。请在设置中开启麦克风或录音权限，返回后会重新检查。',
        action: canOpenScopeSettings ? 'scope-settings' : 'manual',
        manual: '请在右上角“…”进入“关于”页，再打开“设置”，开启录音权限。'
      });
    case 'system-denied':
      return Object.assign(base, {
        title: '微信没有系统麦克风权限',
        content: '微信本身尚未获得手机麦克风权限。请打开微信权限设置并开启麦克风，返回后会重新检查。',
        action: canOpenAppSettings ? 'app-settings' : 'manual',
        manual: '请到手机系统设置中找到微信，开启“麦克风”权限。'
      });
    case 'privacy-config':
      return Object.assign(base, {
        title: '隐私保护指引未配置或被禁用',
        content: '当前无法完成隐私授权。请管理员在微信公众平台“设置 → 服务内容声明 → 用户隐私保护指引”中发布包含录音用途的指引，并确认提审时未误选“未采集隐私”。配置变更可能需要数分钟生效。',
        action: canOpenPrivacyContract ? 'privacy-contract' : 'none'
      });
    case 'privacy-undeclared':
      return Object.assign(base, {
        title: '隐私指引未声明录音接口',
        content: '请管理员在微信公众平台“设置 → 服务内容声明 → 用户隐私保护指引”中声明麦克风及录音相关隐私类型。补充声明通常需要数分钟生效。',
        action: canOpenPrivacyContract ? 'privacy-contract' : 'none'
      });
    case 'privacy-declined':
      return Object.assign(base, {
        title: '需要同意隐私保护指引',
        content: '你尚未同意录音所需的隐私授权。请重新点击录音，阅读并同意隐私保护指引后再继续。',
        action: canOpenPrivacyContract ? 'privacy-contract' : 'none'
      });
    case 'privacy-error':
      return Object.assign(base, {
        title: '隐私授权调用失败',
        content: '隐私授权没有完成。请重试；若持续失败，请管理员检查已发布的隐私保护指引和录音接口声明。',
        action: canOpenPrivacyContract ? 'privacy-contract' : 'none'
      });
    case 'record-busy':
      return Object.assign(base, {
        title: '麦克风暂时不可用',
        content: '麦克风可能正被通话、语音或其他应用占用。关闭占用后重试；若系统权限已关闭，请开启微信的麦克风权限。',
        action: 'retry'
      });
    case 'record-timeout':
      return Object.assign(base, {
        title: '录音没有启动',
        content: '录音器没有返回开始事件。请关闭其他占用麦克风的应用后重试，并检查微信与手机的系统麦克风权限。',
        action: 'retry'
      });
    case 'api-error':
      return Object.assign(base, {
        title: meta.title || '操作没有完成',
        content: meta.content || '微信接口调用失败，请重试。',
        action: 'none'
      });
    default:
      return Object.assign(base, {
        title: '暂时无法录音',
        content: '录音器返回了错误。请重试；若持续失败，请将下方原始错误信息提供给开发者排查。',
        action: 'retry'
      });
  }
}

function formatIssueContent(issue) {
  const content = issue && issue.content ? issue.content : '操作没有完成，请重试。';
  const diagnostic = issue && issue.diagnostic ? String(issue.diagnostic).trim() : '';
  return diagnostic ? content + '\n\n诊断信息：' + diagnostic : content;
}

function failure(code, error, wx, context) {
  const issue = createIssue(code, {
    diagnostic: errMsg(error),
    context,
    canOpenScopeSettings: !wx || typeof wx.openSetting === 'function',
    canOpenAppSettings: !wx || typeof wx.openAppAuthorizeSetting === 'function',
    canOpenPrivacyContract: !wx || typeof wx.openPrivacyContract === 'function'
  });
  return { ok: false, cancelled: false, code, issue, error, context };
}

async function prepareRecording(wx, recorder, options) {
  options = options || {};
  const privacy = await ensurePrivacyAuthorized(wx);
  if (!privacy.ok) {
    const setting = await getPrivacySetting(wx);
    const code = classifyPrivacyFailure(privacy.error, setting);
    const diagnostics = [errMsg(privacy.error)];
    if (!setting.ok) diagnostics.push('getPrivacySetting: ' + errMsg(setting.error));
    return failure(code, diagnostics.filter(Boolean).join('\n'), wx, {
      privacySkipped: false,
      privacySetting: setting.ok ? setting.value : null,
      privacySettingError: setting.ok ? null : setting.error
    });
  }

  const scope = await getScopeRecordState(wx);
  if (scope.state === false) {
    return failure('scope-denied', 'scope.record=false', wx, { scopeState: scope.state, privacy: privacy.value || null });
  }

  const microphone = getWechatMicrophoneState(wx);
  if (microphone.state === 'denied') {
    return failure('system-denied', 'microphoneAuthorized=denied', wx, {
      scopeState: scope.state,
      microphoneState: microphone.state,
      microphoneSetting: microphone.setting || null
    });
  }

  if (typeof options.canStart === 'function' && !options.canStart()) {
    return { ok: false, cancelled: true, code: 'cancelled', context: { scopeState: scope.state, microphoneState: microphone.state } };
  }
  if (!recorder || typeof recorder.start !== 'function') {
    return failure('record-error', { errMsg: 'RecorderManager.start 不可用' }, wx, {
      scopeState: scope.state,
      microphoneState: microphone.state
    });
  }

  try {
    recorder.start(options.recordOptions || DEFAULT_RECORD_OPTIONS);
  } catch (error) {
    const code = classifyRecordError(error, { scopeState: scope.state, micState: microphone.state });
    return failure(code, error, wx, {
      scopeState: scope.state,
      microphoneState: microphone.state,
      scopeError: scope.error || null,
      microphoneError: microphone.error || null
    });
  }

  return {
    ok: true,
    privacySkipped: !!privacy.skipped,
    scopeState: scope.state,
    microphoneState: microphone.state,
    warnings: [scope.error, microphone.error].filter(Boolean)
  };
}

function openScopeSetting(wx) {
  if (!wx || typeof wx.openSetting !== 'function') {
    return Promise.resolve({ ok: false, unsupported: true, error: { errMsg: '当前微信版本不支持 wx.openSetting' } });
  }
  return callWx(wx.openSetting.bind(wx), {});
}

function openAppSetting(wx) {
  if (!wx || typeof wx.openAppAuthorizeSetting !== 'function') {
    return Promise.resolve({ ok: false, unsupported: true, error: { errMsg: '当前微信版本不支持 wx.openAppAuthorizeSetting' } });
  }
  return callWx(wx.openAppAuthorizeSetting.bind(wx), {});
}

function openPrivacyContract(wx) {
  if (!wx || typeof wx.openPrivacyContract !== 'function') {
    return Promise.resolve({ ok: false, unsupported: true, error: { errMsg: '当前微信版本不支持 wx.openPrivacyContract' } });
  }
  return callWx(wx.openPrivacyContract.bind(wx), {});
}

module.exports = {
  DEFAULT_RECORD_OPTIONS,
  SCOPE_RECORD,
  errMsg,
  callWx,
  getPrivacySetting,
  getScopeRecordState,
  getWechatMicrophoneState,
  ensurePrivacyAuthorized,
  classifyPrivacyFailure,
  classifyRecordError,
  createIssue,
  formatIssueContent,
  prepareRecording,
  openScopeSetting,
  openAppSetting,
  openPrivacyContract
};


