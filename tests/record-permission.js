const assert = require('node:assert/strict');
const permission = require('../miniprogram/utils/record-permission');

let count = 0;
async function check(name, test) {
  await test();
  count++;
  console.log('ok ' + count + ' - ' + name);
}

function makeWx(overrides) {
  overrides = overrides || {};
  const calls = { authorize: 0, getSetting: 0, getPrivacySetting: 0, requirePrivacyAuthorize: 0, openSetting: 0, openAppAuthorizeSetting: 0 };
  const wx = {
    authorize() { calls.authorize++; throw new Error('wx.authorize must not be used'); },
    getSetting(options) {
      calls.getSetting++;
      if (overrides.getSetting) return overrides.getSetting(options);
      options.success({ authSetting: { 'scope.record': true } });
    },
    getAppAuthorizeSetting() {
      return overrides.microphone || { microphoneAuthorized: 'authorized' };
    },
    getPrivacySetting(options) {
      calls.getPrivacySetting++;
      if (overrides.getPrivacySetting) return overrides.getPrivacySetting(options);
      options.success({ needAuthorization: true, privacyContractName: '《测试隐私保护指引》', errMsg: 'getPrivacySetting:ok' });
    },
    requirePrivacyAuthorize(options) {
      calls.requirePrivacyAuthorize++;
      if (overrides.requirePrivacyAuthorize) return overrides.requirePrivacyAuthorize(options);
      options.success({ errMsg: 'requirePrivacyAuthorize:ok' });
    },
    openSetting(options) {
      calls.openSetting++;
      if (overrides.openSetting) return overrides.openSetting(options);
      options.success({ authSetting: { 'scope.record': true }, errMsg: 'openSetting:ok' });
    },
    openAppAuthorizeSetting(options) {
      calls.openAppAuthorizeSetting++;
      if (overrides.openAppAuthorizeSetting) return overrides.openAppAuthorizeSetting(options);
      options.success({ errMsg: 'openAppAuthorizeSetting:ok' });
    },
    openPrivacyContract(options) {
      if (overrides.openPrivacyContract) return overrides.openPrivacyContract(options);
      options.success({ errMsg: 'openPrivacyContract:ok' });
    }
  };
  return { wx, calls };
}

function makeRecorder(onStart) {
  return {
    starts: [],
    start(options) {
      this.starts.push(options);
      if (onStart) onStart(options);
    }
  };
}

(async () => {
  await check('scope.record 未知时不调用 wx.authorize，直接让录音器发起真实授权', async () => {
    const { wx, calls } = makeWx({
      getSetting(options) { options.success({ authSetting: {} }); },
      microphone: { microphoneAuthorized: 'not determined' }
    });
    const recorder = makeRecorder();
    const result = await permission.prepareRecording(wx, recorder);
    assert.equal(result.ok, true);
    assert.equal(result.scopeState, 'unknown');
    assert.equal(result.microphoneState, 'not determined');
    assert.equal(recorder.starts.length, 1);
    assert.equal(calls.authorize, 0);
    assert.equal(calls.openSetting, 0);
  });

  await check('scope.record 明确为 false 时阻止录音并只提供小程序设置动作', async () => {
    const { wx, calls } = makeWx({ getSetting(options) { options.success({ authSetting: { 'scope.record': false } }); } });
    const recorder = makeRecorder();
    const result = await permission.prepareRecording(wx, recorder);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'scope-denied');
    assert.equal(result.issue.action, 'scope-settings');
    assert.match(permission.formatIssueContent(result.issue), /scope\.record=false/);
    assert.equal(recorder.starts.length, 0);
    assert.equal(calls.openSetting, 0);
  });

  await check('微信系统麦克风明确 denied 时使用微信授权设置，而不是小程序设置', async () => {
    const { wx, calls } = makeWx({ microphone: { microphoneAuthorized: 'denied' } });
    const recorder = makeRecorder();
    const result = await permission.prepareRecording(wx, recorder);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'system-denied');
    assert.equal(result.issue.action, 'app-settings');
    assert.equal(recorder.starts.length, 0);
    assert.equal(calls.openSetting, 0);
    assert.match(permission.formatIssueContent(result.issue), /microphoneAuthorized=denied/);
  });

  await check('隐私接口未声明时按官方错误原文停止并保留完整 errMsg', async () => {
    const raw = { errMsg: 'RecorderManager.start:fail api scope is not declared in the privacy agreement', errno: 112 };
    const { wx } = makeWx({ requirePrivacyAuthorize(options) { options.fail(raw); } });
    const recorder = makeRecorder();
    const result = await permission.prepareRecording(wx, recorder);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'privacy-undeclared');
    assert.equal(recorder.starts.length, 0);
    assert.match(permission.formatIssueContent(result.issue), /api scope is not declared in the privacy agreement/);
  });

  await check('隐私协议未配置或被禁用时给出后台配置分类', async () => {
    const raw = { errMsg: 'A:fail appid privacy api banned' };
    const { wx } = makeWx({ requirePrivacyAuthorize(options) { options.fail(raw); } });
    const result = await permission.prepareRecording(wx, makeRecorder());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'privacy-config');
    assert.match(result.issue.content, /用户隐私保护指引/);
    assert.match(permission.formatIssueContent(result.issue), /appid privacy api banned/);
  });

  await check('用户拒绝隐私协议与后台配置错误分开处理', async () => {
    const raw = { errMsg: 'requirePrivacyAuthorize:fail privacy permission is not authorized' };
    const { wx } = makeWx({ requirePrivacyAuthorize(options) { options.fail(raw); } });
    const result = await permission.prepareRecording(wx, makeRecorder());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'privacy-declined');
    assert.match(permission.formatIssueContent(result.issue), /privacy permission is not authorized/);
  });

  await check('requirePrivacyAuthorize pending 期间不开始录音，success 后才继续', async () => {
    let resolvePrivacy;
    const { wx } = makeWx({
      requirePrivacyAuthorize(options) { resolvePrivacy = options.success; }
    });
    const recorder = makeRecorder();
    const pending = permission.prepareRecording(wx, recorder);
    await Promise.resolve();
    assert.equal(recorder.starts.length, 0);
    resolvePrivacy({ errMsg: 'requirePrivacyAuthorize:ok' });
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(recorder.starts.length, 1);
  });

  await check('读取授权状态失败时保留诊断但继续真实 start，不擅自打开设置', async () => {
    const { wx, calls } = makeWx({
      getSetting(options) { options.fail({ errMsg: 'getSetting:fail mock' }); }
    });
    wx.getAppAuthorizeSetting = () => { throw new Error('getAppAuthorizeSetting mock failure'); };
    const recorder = makeRecorder();
    const result = await permission.prepareRecording(wx, recorder);
    assert.equal(result.ok, true);
    assert.equal(result.scopeState, 'unknown');
    assert.equal(result.microphoneState, 'unknown');
    assert.equal(result.warnings.length, 2);
    assert.equal(recorder.starts.length, 1);
    assert.equal(calls.openSetting, 0);
  });

  await check('录音器同步抛错保留原始 errMsg 并交给通用错误分支', async () => {
    const { wx } = makeWx();
    const recorder = { start() { throw new Error('RecorderManager.start:fail custom'); } };
    const result = await permission.prepareRecording(wx, recorder);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'record-error');
    assert.match(permission.formatIssueContent(result.issue), /RecorderManager\.start:fail custom/);
  });

  await check('异步录音错误可根据状态和 errMsg 区分权限、占用与超时', async () => {
    assert.equal(permission.classifyRecordError({ errMsg: 'anything' }, { scopeState: false }), 'scope-denied');
    assert.equal(permission.classifyRecordError({ errMsg: 'anything' }, { micState: 'denied' }), 'system-denied');
    assert.equal(permission.classifyRecordError({ errMsg: 'start:fail microphone busy' }), 'record-busy');
    assert.equal(permission.classifyRecordError({ errMsg: 'RecorderManager.start:onStart timeout' }), 'record-timeout');
    assert.equal(permission.classifyRecordError({ errMsg: 'unexpected native failure' }), 'record-error');
    assert.equal(permission.classifyRecordError({ errMsg: 'RecorderManager.start:fail auth deny' }), 'record-error');
    assert.equal(permission.classifyRecordError({ errMsg: 'unknown native failure', errno: 112 }), 'record-error');
  });

  await check('设置接口失败返回原始错误，不在模块内自动跳转', async () => {
    const raw = { errMsg: 'openSetting:fail user cancelled' };
    const { wx, calls } = makeWx({ openSetting(options) { options.fail(raw); } });
    const result = await permission.openScopeSetting(wx);
    assert.equal(result.ok, false);
    assert.equal(result.error.errMsg, raw.errMsg);
    assert.equal(calls.openSetting, 1);
  });

  await check('页面按钮不超过 4 字符，同步 onStart/onError 后不再挂启动 watchdog', async () => {
    const pagePath = require.resolve('../miniprogram/pages/index/index.js');
    const oldPage = global.Page;
    const oldWx = global.wx;
    let config;
    global.Page = value => { config = value; };
    global.wx = { showModal() {} };
    delete require.cache[pagePath];
    require(pagePath);

    const makePage = () => Object.assign({}, config, {
      data: Object.assign({}, config.data),
      setData(update) { Object.assign(this.data, update); },
      alive: true,
      visible: true,
      recordAttempt: 0,
      startIssued: false,
      scheduled: 0,
      scheduleStartWatchdog() { this.scheduled++; },
      clearStartWatchdog() {}
    });

    const labels = [];
    global.wx.showModal = options => labels.push(options.confirmText);
    const labelPage = makePage();
    labelPage.showIssue(permission.createIssue('scope-denied'));
    labelPage.showIssue(permission.createIssue('system-denied'));
    labelPage.showIssue(permission.createIssue('privacy-config'));
    assert.deepEqual(labels, ['去设置', '微信权限', '隐私指引']);
    labels.forEach(label => assert.ok(Array.from(label).length <= 4, label));

    const originalPrepare = permission.prepareRecording;
    try {
      for (const event of ['start', 'error']) {
        const page = makePage();
        page.data.starting = true;
        permission.prepareRecording = async () => {
          if (event === 'start') page.setData({ starting: false, recording: true });
          else page.setData({ starting: false, recording: false, processing: false });
          return { ok: true, scopeState: 'unknown', microphoneState: 'not determined', warnings: [] };
        };
        await page.beginRecordAttempt();
        assert.equal(page.scheduled, 0);
        assert.equal(page.startIssued, false);
      }
    } finally {
      permission.prepareRecording = originalPrepare;
      global.Page = oldPage;
      global.wx = oldWx;
      delete require.cache[pagePath];
    }
  });
  console.log('\n' + count + ' record permission checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});



