const music = require('../../utils/music');
const storage = require('../../utils/storage');

const START_TIMEOUT_MS = 15000;
const DEFAULT_PRIVACY_NAME = '哼记隐私保护指引';
const LIBRARY_PAGE_SIZE = 20;
let permissionModule = null;
let audioModule = null;
let transcribeFn = null;

function getPermission() {
  if (!permissionModule) permissionModule = require('../../utils/record-permission');
  return permissionModule;
}

function recognitionTools() {
  if (!audioModule) audioModule = require('../../utils/audio');
  if (!transcribeFn) transcribeFn = require('../../utils/pitch').transcribe;
  return { audio: audioModule, transcribe: transcribeFn };
}

function privacyNameLabel(name) {
  return String(name || DEFAULT_PRIVACY_NAME).replace(/^《/, '').replace(/》$/, '');
}

Page({
  data: { ideas: [], ideaTotal: 0, hasMore: false, recording: false, starting: false, processing: false, progress: 0, elapsed: '00:00',
    recordSeconds: 0, privacyVisible: false, privacyName: DEFAULT_PRIVACY_NAME,
    bars: [18, 31, 23, 43, 56, 37, 65, 47, 77, 57, 88, 63, 96, 67, 83, 48, 68, 39, 55, 33, 43, 25, 32, 18] },
  onLoad() {
    this.alive = true;
    this.recordAttempt = 0;
    this.recorder = wx.getRecorderManager();
    this.handleStart = () => {
      this.clearStartWatchdog();
      this.startIssued = false;
      if (!this.alive) return;
      if (!this.visible) {
        this.cancelled = true;
        this.setData({ recording: false, starting: false });
        try { recorder.stop(); } catch (_) {}
        return;
      }
      this.startedAt = Date.now();
      this.recordingSecond = 0;
      this.setData({ recording: true, starting: false, elapsed: '00:00', recordSeconds: 0 });
      this.timer = setInterval(() => {
        const value = Math.min(30, (Date.now() - this.startedAt) / 1000);
        const second = Math.floor(value);
        const patch = { recordSeconds: value };
        if (second !== this.recordingSecond) {
          this.recordingSecond = second;
          patch.elapsed = music.timeLabel(value);
        }
        this.setData(patch);
      }, 150);
    };
    this.handleStop = res => {
      this.clearStartWatchdog();
      if (this.cancelled) {
        if (this.alive) this.setData({ recording: false, starting: false, processing: false });
        return;
      }
      this.finishRecording(res);
    };
    this.handleError = error => this.handleRecordError(error);
    this.handleInterruption = () => {
      if (this.data.recording) {
        this.wasInterrupted = true;
        this.recorder.stop();
      }
    };
    this.handlePrivacyNeed = (resolve, eventInfo) => {
      if (!this.alive) {
        resolve({ event: 'disagree' });
        return;
      }
      if (this.privacyResolve) this.privacyResolve({ event: 'disagree' });
      this.privacyResolve = resolve;
      this.privacyContext = eventInfo || {};
      this.setData({ privacyVisible: true, starting: true });
      if (wx.getPrivacySetting) {
        wx.getPrivacySetting({
          success: res => {
            if (this.alive) this.setData({ privacyName: privacyNameLabel(res.privacyContractName) });
          },
          fail: error => console.warn('[record-permission] getPrivacySetting', getPermission().errMsg(error))
        });
      }
    };
    this.recorder.onStart(this.handleStart);
    this.recorder.onStop(this.handleStop);
    this.recorder.onError(this.handleError);
    this.recorder.onInterruptionBegin(this.handleInterruption);
    if (wx.onNeedPrivacyAuthorization) wx.onNeedPrivacyAuthorization(this.handlePrivacyNeed);
  },
  onShow() {
    this.visible = true;
    this.refresh();
    if (!this.alive || !this.awaitingSettings) return;
    const target = this.awaitingSettings;
    clearTimeout(this.foregroundTimer);
    this.foregroundTimer = setTimeout(() => {
      if (!this.alive || this.awaitingSettings !== target) return;
      this.awaitingSettings = null;
      this.retryRecordAfterSettings(target);
    }, 250);
  },
  onReachBottom() { this.loadMore(); },
  onHide() {
    this.visible = false;
    if (this.data.recording) this.recorder.stop();
  },
  onUnload() {
    this.alive = false;
    this.cancelled = true;
    this.recordAttempt++;
    clearInterval(this.timer);
    clearTimeout(this.startWatchdog);
    clearTimeout(this.foregroundTimer);
    if (this.data.recording || this.startIssued) {
      try { this.recorder.stop(); } catch (_) {}
    }
    if (this.recorder.offStart) this.recorder.offStart(this.handleStart);
    if (this.recorder.offStop) this.recorder.offStop(this.handleStop);
    if (this.recorder.offError) this.recorder.offError(this.handleError);
    if (this.recorder.offInterruptionBegin) this.recorder.offInterruptionBegin(this.handleInterruption);
    if (wx.offNeedPrivacyAuthorization) wx.offNeedPrivacyAuthorization(this.handlePrivacyNeed);
    if (this.privacyResolve) {
      this.privacyResolve({ event: 'disagree' });
      this.privacyResolve = null;
    }
  },
  refresh() {
    const page = storage.summaryPage(0, LIBRARY_PAGE_SIZE);
    const signature = page.revision + ':' + page.total;
    if (this.librarySignature === signature && Array.isArray(this.data.ideas)) return false;
    this.librarySignature = signature;
    this.libraryOffset = page.items.length;
    this.setData({ ideas: page.items, ideaTotal: page.total, hasMore: this.libraryOffset < page.total });
    return true;
  },
  loadMore() {
    if (!this.data.hasMore) return 0;
    const offset = this.libraryOffset || this.data.ideas.length;
    const page = storage.summaryPage(offset, LIBRARY_PAGE_SIZE);
    const signature = page.revision + ':' + page.total;
    if (this.librarySignature && signature !== this.librarySignature) {
      this.refresh();
      return 0;
    }
    const known = {};
    this.data.ideas.forEach(idea => { known[idea.id] = true; });
    const incoming = page.items.filter(idea => !known[idea.id]);
    this.libraryOffset = offset + page.items.length;
    this.setData({ ideas: this.data.ideas.concat(incoming), ideaTotal: page.total,
      hasMore: this.libraryOffset < page.total });
    return incoming.length;
  },
  recordTap() {
    if (this.data.processing || this.data.starting) return;
    if (this.data.recording) { this.recorder.stop(); return; }
    this.cancelled = false;
    this.wasInterrupted = false;
    this.setData({ starting: true });
    this.beginRecordAttempt();
  },
  async beginRecordAttempt() {
    const attempt = ++this.recordAttempt;
    let result;
    try {
      result = await getPermission().prepareRecording(wx, this.recorder, {
        recordOptions: getPermission().DEFAULT_RECORD_OPTIONS,
        canStart: () => this.alive && this.visible
      });
    } catch (error) {
      if (!this.alive || attempt !== this.recordAttempt) return;
      this.setData({ starting: false });
      this.showIssue(getPermission().createIssue('privacy-error', {
        diagnostic: getPermission().errMsg(error),
        canOpenPrivacyContract: typeof wx.openPrivacyContract === 'function'
      }));
      return;
    }
    if (!this.alive || attempt !== this.recordAttempt) return;
    if (result.cancelled) {
      if (!this.data.recording && !this.data.privacyVisible) this.setData({ starting: false });
      return;
    }
    if (!result.ok) {
      this.setData({ starting: false });
      this.showIssue(result.issue);
      return;
    }
    this.lastPermissionContext = {
      scopeState: result.scopeState,
      microphoneState: result.microphoneState,
      warnings: result.warnings
    };
    if (!this.data.starting || this.data.recording) {
      this.startIssued = false;
      this.clearStartWatchdog();
      return;
    }
    this.startIssued = true;
    this.scheduleStartWatchdog();
  },
  scheduleStartWatchdog() {
    this.clearStartWatchdog();
    this.startWatchdog = setTimeout(async () => {
      if (!this.alive || this.data.recording || !this.data.starting) return;
      const scope = await getPermission().getScopeRecordState(wx);
      const microphone = getPermission().getWechatMicrophoneState(wx);
      if (!this.alive || this.data.recording) return;
      const code = scope.state === false ? 'scope-denied' : microphone.state === 'denied' ? 'system-denied' : 'record-timeout';
      const diagnostic = 'RecorderManager.start:onStart timeout after ' + START_TIMEOUT_MS + 'ms';
      console.error('[record-permission] ' + diagnostic);
      this.startIssued = false;
      this.setData({ recording: false, starting: false });
      this.showIssue(getPermission().createIssue(code, {
        diagnostic,
        context: { scopeState: scope.state, microphoneState: microphone.state },
        canOpenScopeSettings: typeof wx.openSetting === 'function',
        canOpenAppSettings: typeof wx.openAppAuthorizeSetting === 'function'
      }));
    }, START_TIMEOUT_MS);
  },
  clearStartWatchdog() {
    clearTimeout(this.startWatchdog);
    this.startWatchdog = null;
  },
  async handleRecordError(error) {
    this.clearStartWatchdog();
    this.startIssued = false;
    console.error('[record-permission] RecorderManager.onError', getPermission().errMsg(error), error);
    if (!this.alive) return;
    clearInterval(this.timer);
    this.setData({ recording: false, starting: false, processing: false });
    const scope = await getPermission().getScopeRecordState(wx);
    const microphone = getPermission().getWechatMicrophoneState(wx);
    if (!this.alive) return;
    const code = getPermission().classifyRecordError(error, { scopeState: scope.state, micState: microphone.state });
    this.showIssue(getPermission().createIssue(code, {
      diagnostic: getPermission().errMsg(error),
      context: { scopeState: scope.state, microphoneState: microphone.state, scopeError: scope.error, microphoneError: microphone.error },
      canOpenScopeSettings: typeof wx.openSetting === 'function',
      canOpenAppSettings: typeof wx.openAppAuthorizeSetting === 'function',
      canOpenPrivacyContract: typeof wx.openPrivacyContract === 'function'
    }));
  },
  showIssue(issue) {
    if (!this.alive || !issue) return;
    console.error('[record-permission] issue', issue.code, issue.diagnostic, issue.context);
    const actionLabels = {
      'scope-settings': '去设置',
      'app-settings': '微信权限',
      'privacy-contract': '隐私指引',
      retry: '重试'
    };
    let content = getPermission().formatIssueContent(issue);
    if (issue.action === 'manual' && issue.manual) content += '\n\n' + issue.manual;
    const action = issue.action && issue.action !== 'none' && issue.action !== 'manual';
    wx.showModal({
      title: issue.title,
      content,
      showCancel: action,
      confirmText: actionLabels[issue.action] || '知道了',
      cancelText: '稍后',
      success: res => { if (res.confirm && action) this.runIssueAction(issue); }
    });
  },
  showApiIssue(title, error, content) {
    this.showIssue(getPermission().createIssue('api-error', {
      title,
      content,
      diagnostic: getPermission().errMsg(error)
    }));
  },
  runIssueAction(issue) {
    if (issue.action === 'scope-settings') this.openScopeSettings();
    else if (issue.action === 'app-settings') this.openAppSettings();
    else if (issue.action === 'privacy-contract') this.openPrivacy();
    else if (issue.action === 'retry' && !this.data.starting && !this.data.recording) {
      this.setData({ starting: true });
      this.beginRecordAttempt();
    }
  },
  async openScopeSettings() {
    if (!this.alive) return;
    this.awaitingSettings = 'scope';
    const result = await getPermission().openScopeSetting(wx);
    if (!this.alive) return;
    if (!result.ok) {
      this.awaitingSettings = null;
      this.showApiIssue('无法打开小程序设置', result.error, '请改从右上角“…”进入“关于”页，再打开“设置”，开启录音权限。');
      return;
    }
    this.awaitingSettings = null;
    if (!this.visible) this.awaitingSettings = 'scope';
    else this.retryRecordAfterSettings('scope');
  },
  async openAppSettings() {
    if (!this.alive) return;
    this.awaitingSettings = 'app';
    const result = await getPermission().openAppSetting(wx);
    if (!this.alive) return;
    if (!result.ok) {
      this.awaitingSettings = null;
      this.showApiIssue('无法打开微信权限设置', result.error, '请到手机系统设置中找到微信，开启“麦克风”权限。');
    }
  },
  retryRecordAfterSettings() {
    if (!this.alive || this.data.recording || this.data.processing) return;
    this.setData({ starting: true });
    this.beginRecordAttempt();
  },
  async finishRecording(result) {
    clearInterval(this.timer);
    if (!this.alive) return;
    this.setData({ recording: false, starting: false, processing: true, progress: 0 });
    let source = null;
    try {
      if (result.duration && result.duration < 700) throw new Error('再多哼一会儿吧，建议录制 2 到 15 秒。');
      const tools = recognitionTools();
      const decoded = await tools.audio.decodeFile(result.tempFilePath);
      const bpm = 100;
      const recognized = await tools.transcribe(decoded.samples, decoded.sampleRate, bpm,
        progress => { if (this.alive) this.setData({ progress }); }, () => !this.alive || this.cancelled);
      if (!this.alive || this.cancelled) return;
      const id = music.uid(); source = await storage.saveRecording(result.tempFilePath, id, decoded);
      const date = new Date();
      storage.save({ id, title: (date.getMonth() + 1) + '月' + date.getDate() + '日的旋律', bpm,
        createdAt: Date.now(), updatedAt: Date.now(), notes: recognized.notes, source,
        confidence: recognized.confidence, recordingDuration: recognized.duration, isDemo: false });
      this.refresh();
      if (this.wasInterrupted) wx.showToast({ title: '已保存中断前的旋律', icon: 'none' });
      wx.navigateTo({ url: '/pages/editor/editor?id=' + id });
    } catch (err) {
      if (source) storage.removeFile(source);
      if (this.alive && !this.cancelled) wx.showModal({ title: '这次没有识别成功', content: err.message || err.errMsg || '请重新录制一小段清晰的哼唱。', showCancel: false });
    } finally {
      if (this.alive) this.setData({ processing: false, progress: 0, elapsed: '00:00', recordSeconds: 0 });
    }
  },
  openCreation() {
    if (!this.data.recording && !this.data.starting && !this.data.processing) wx.navigateTo({ url: '/pages/compose/compose' });
  },
  openDemo() {
    if (this.data.recording || this.data.starting || this.data.processing) return;
    try {
      let idea = storage.summaryPage(0, 100).items.find(i => i.isDemo);
      if (!idea) idea = storage.save(music.demo());
      wx.navigateTo({ url: '/pages/editor/editor?id=' + idea.id });
    } catch (err) { wx.showToast({ title: err.message || '保存失败，请检查存储空间', icon: 'none' }); }
  },
  openIdea(event) {
    if (!this.data.recording && !this.data.starting && !this.data.processing) {
      wx.navigateTo({ url: '/pages/editor/editor?id=' + event.currentTarget.dataset.id });
    }
  },
  ideaMenu(event) {
    const id = event.currentTarget.dataset.id;
    wx.showActionSheet({ itemList: ['删除这条灵感'], success: () => wx.showModal({ title: '删除这条灵感？', content: '录音和音符都会从本机移除，删除后无法恢复。', confirmColor: '#b75b49',
      success: res => { if (res.confirm) { try { storage.remove(id); this.refresh(); } catch (_) { wx.showToast({ title: '删除失败，请重试', icon: 'none' }); } } } }) });
  },
  agreePrivacy() {
    this.setData({ privacyVisible: false, starting: true });
    const resolve = this.privacyResolve;
    this.privacyResolve = null;
    if (resolve) resolve({ event: 'agree', buttonId: 'privacy-agree' });
  },
  disagreePrivacy() {
    this.setData({ privacyVisible: false, starting: false });
    const resolve = this.privacyResolve;
    this.privacyResolve = null;
    if (resolve) resolve({ event: 'disagree' });
  },
  async openPrivacy() {
    const result = await getPermission().openPrivacyContract(wx);
    if (this.alive && !result.ok) this.showApiIssue('无法打开隐私保护指引', result.error, '请管理员检查隐私保护指引是否已在微信公众平台发布。');
  }
});

