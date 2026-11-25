const music = require('../../utils/music');
const storage = require('../../utils/storage');
const recognitionSettings = require('../../utils/recognition-settings');

const START_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 6000;
const DEFAULT_PRIVACY_NAME = '哼记隐私保护指引';
const LIBRARY_PAGE_SIZE = 20;
let permissionModule = null;
let audioModule = null;
let recognitionModule = null;

function getPermission() {
  if (!permissionModule) permissionModule = require('../../utils/record-permission');
  return permissionModule;
}

function recognitionTools() {
  if (!audioModule) audioModule = require('../../utils/audio');
  if (!recognitionModule) recognitionModule = require('../../utils/recognition');
  return { audio: audioModule, transcribe: recognitionModule.transcribe };
}

function privacyNameLabel(name) {
  return String(name || DEFAULT_PRIVACY_NAME).replace(/^《/, '').replace(/》$/, '');
}

Page({
  data: { ideas: [], ideaTotal: 0, hasMore: false, recording: false, starting: false, stopping: false, processing: false, progress: 0, elapsed: '00:00',
    recordSeconds: 0, privacyVisible: false, privacyName: DEFAULT_PRIVACY_NAME, settingsVisible: false,
    pendingVisible: false, pendingCount: 0, pendingRecordings: [],
    recognitionMode: 'standard', processingLabel: '正在本机识别音高与音符', checkingRecognition: false,
  },
  onLoad() {
    this.alive = true;
    this.navigationPending = false;
    this.recordAttempt = 0;
    const recognitionMode = recognitionSettings.getMode(wx);
    if (recognitionMode !== this.data.recognitionMode) this.setData({ recognitionMode });
    this.recorder = wx.getRecorderManager();
    this.handleStart = () => {
      if (!this.alive || this.data.recording) return;
      this.clearStartWatchdog();
      clearTimeout(this.stopWatchdog);
      this.startIssued = false;
      if (!this.visible || !this.data.starting) {
        this.cancelled = true;
        this.setData({ recording: false, starting: false, stopping: false });
        try { this.recorder.stop(); } catch (_) {}
        return;
      }
      this.startedAt = Date.now();
      this.recordingSecond = 0;
      this.setData({ recording: true, starting: false, elapsed: '00:00', recordSeconds: 0 });
      this.timer = setInterval(() => {
        const value = Math.min(30, (Date.now() - this.startedAt) / 1000);
        const second = Math.floor(value);
        if (second !== this.recordingSecond) {
          this.recordingSecond = second;
          this.setData({ recordSeconds: second, elapsed: music.timeLabel(value) });
        }
      }, 200);
    };
    this.handleStop = res => {
      if (!this.alive || (!this.data.recording && !this.startIssued)) return;
      this.clearStartWatchdog();
      clearTimeout(this.stopWatchdog);
      this.startIssued = false;
      clearInterval(this.timer);
      if (this.cancelled) {
        this.setData({ recording: false, starting: false, stopping: false });
        return;
      }
      this.finishRecording(res);
    };
    this.handleError = error => this.handleRecordError(error);
    this.handleInterruption = () => {
      if (this.data.recording) {
        this.wasInterrupted = true;
        this.requestRecordingStop();
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
    this.navigationPending = false;
    this.refresh();
    this.refreshPendingRecordings();
    if (!this.alive || !this.awaitingSettings) return;
    const target = this.awaitingSettings;
    clearTimeout(this.foregroundTimer);
    this.foregroundTimer = setTimeout(() => {
      if (!this.alive || !this.visible || this.awaitingSettings !== target) return;
      this.awaitingSettings = null;
      this.retryRecordAfterSettings(target);
    }, 250);
  },
  onReachBottom() { this.loadMore(); },
  onHide() {
    this.visible = false;
    if (this.data.recording) this.requestRecordingStop();
  },
  onUnload() {
    this.alive = false;
    this.cancelled = true;
    this.navigationPending = false;
    this.recordAttempt++;
    if (recognitionModule) recognitionModule.dispose();
    clearInterval(this.timer);
    clearTimeout(this.startWatchdog);
    clearTimeout(this.stopWatchdog);
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
    // Keep the user's loaded depth when they return from an editor. Reloading
    // only the first page made a library jump after editing any old idea.
    const loaded = Array.isArray(this.data.ideas) ? this.data.ideas.length : 0;
    const limit = Math.min(100, Math.max(LIBRARY_PAGE_SIZE, loaded));
    let page;
    try { page = storage.summaryPage(0, limit); }
    catch (_) {
      if (this.alive && this.visible !== false) wx.showToast({ title: '暂时无法读取灵感列表，请重试', icon: 'none' });
      return false;
    }
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
    let page;
    try { page = storage.summaryPage(offset, LIBRARY_PAGE_SIZE); }
    catch (_) {
      wx.showToast({ title: '暂时无法读取更多灵感', icon: 'none' });
      return 0;
    }
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
    if (!this.alive || this.visible === false || this.navigationPending || this.processingJob ||
        this.data.processing || this.data.starting || this.data.checkingRecognition) return false;
    if (this.data.recording) return this.requestRecordingStop();
    this.cancelled = false;
    this.wasInterrupted = false;
    this.setData({ starting: true });
    this.beginRecordAttempt();
    return true;
  },
  requestRecordingStop() {
    if (this.data.stopping) return false;
    this.setData({ stopping: true });
    try { this.recorder.stop(); }
    catch (error) { this.handleRecordError(error); return false; }
    if (this.data.stopping) {
      this.stopWatchdog = setTimeout(() => {
        if (!this.alive || !this.data.stopping) return;
        this.setData({ stopping: false });
        if (this.visible) wx.showToast({ title: '结束录音超时，请再点一次', icon: 'none' });
      }, STOP_TIMEOUT_MS);
    }
    return true;
  },
  openSettings() {
    if (this.data.recording || this.data.starting || this.data.processing) return false;
    this.setData({ settingsVisible: true });
    return true;
  },
  closeSettings() { this.setData({ settingsVisible: false }); },
  refreshPendingRecordings() {
    try {
      const recordings = storage.pendingRecordings();
      const patch = {};
      if (this.data.pendingCount !== recordings.length) patch.pendingCount = recordings.length;
      if (this.data.pendingVisible) patch.pendingRecordings = recordings.map(({ id, title, duration }) => ({
        id, title, seconds: duration ? (duration / 1000).toFixed(1) + ' 秒' : '本地录音'
      }));
      if (Object.keys(patch).length) this.setData(patch);
    } catch (_) {
      // A transient storage error must not prevent the library from opening.
    }
  },
  openPendingRecordings() {
    if (this.data.recording || this.data.starting || this.data.processing || this.data.checkingRecognition) return;
    this.setData({ pendingVisible: true });
    this.refreshPendingRecordings();
  },
  closePendingRecordings() { this.setData({ pendingVisible: false, pendingRecordings: [] }); },
  retryPendingRecording(event) {
    if (this.data.recording || this.data.starting || this.data.processing || this.data.checkingRecognition || this.navigationPending) return false;
    try {
      const id = event.currentTarget.dataset.id;
      const recording = storage.pendingRecordings().find(item => item.id === id);
      if (!recording) { this.refreshPendingRecordings(); return false; }
      this.closePendingRecordings();
      this.wasInterrupted = false;
      return this.processRecording(recording);
    } catch (_) {
      wx.showToast({ title: '无法读取本地录音，请重试', icon: 'none' });
      return false;
    }
  },
  deletePendingRecording(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: '删除这段待识别录音？', content: '删除后无法恢复。', confirmColor: '#a53734',
      success: result => {
        if (!result.confirm || !this.alive || this.data.processing) return;
        try { storage.removePendingRecording(id); this.refreshPendingRecordings(); }
        catch (_) { wx.showToast({ title: '删除失败，请重试', icon: 'none' }); }
      }
    });
  },
  changeRecognitionMode(event) {
    if (this.data.recording || this.data.starting || this.data.processing || this.data.checkingRecognition) return false;
    const mode = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.mode;
    if (!recognitionSettings.validMode(mode) || mode === this.data.recognitionMode) return false;
    this.setData({ recognitionMode: mode });
    if (!recognitionSettings.setMode(wx, mode)) wx.showToast({ title: '本次已切换，设置未能保存', icon: 'none' });
    return true;
  },
  async checkRecognitionCompatibility() {
    if (this.data.recording || this.data.starting || this.data.processing || this.data.checkingRecognition) return false;
    this.setData({ checkingRecognition: true });
    const diagnostics = require('../../utils/recognition-diagnostics');
    try {
      if (!recognitionModule) recognitionModule = require('../../utils/recognition');
      const report = await recognitionModule.checkCompatibility(wx, () => this.alive === false || this.visible === false,
        title => { if (this.alive) wx.showLoading({ title, mask: true }); });
      if (!this.alive || this.visible === false) return false;
      wx.hideLoading();
      wx.showModal({ title: report.ok ? '兼容性检查通过' : '兼容性检查未通过',
        content: diagnostics.explanation(report) + (report.failure ? '\n\n' + report.failure.code + ' · ' + report.failure.detail : ''),
        confirmText: '复制报告', cancelText: '关闭',
        success: result => { if (result.confirm) diagnostics.copyReport(wx, report); } });
      return report.ok;
    } catch (error) {
      if (this.alive && error.code !== 'CANCELLED') wx.showToast({ title: error.message || '暂时无法完成检查', icon: 'none' });
      return false;
    } finally {
      wx.hideLoading();
      if (this.alive) this.setData({ checkingRecognition: false });
    }
  },
  cancelRecognition() {
    if (!this.data.processing || this.cancelled) return false;
    this.cancelled = true;
    if (recognitionModule) recognitionModule.dispose();
    this.setData({ processingLabel: '正在取消识别…' });
    return true;
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
    const attempt = this.recordAttempt;
    this.startWatchdog = setTimeout(async () => {
      if (!this.alive || attempt !== this.recordAttempt || !this.data.starting) return;
      const scope = await getPermission().getScopeRecordState(wx);
      const microphone = getPermission().getWechatMicrophoneState(wx);
      if (!this.alive || attempt !== this.recordAttempt || !this.data.starting) return;
      const code = scope.state === false ? 'scope-denied' : microphone.state === 'denied' ? 'system-denied' : 'record-timeout';
      const diagnostic = 'RecorderManager.start:onStart timeout after ' + START_TIMEOUT_MS + 'ms';
      console.error('[record-permission] ' + diagnostic);
      this.startIssued = false;
      this.cancelled = true;
      this.setData({ recording: false, starting: false, stopping: false });
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
    if (!this.alive || (!this.data.recording && !this.data.starting && !this.startIssued)) return;
    const attempt = this.recordAttempt;
    this.clearStartWatchdog();
    clearTimeout(this.stopWatchdog);
    this.startIssued = false;
    console.error('[record-permission] RecorderManager.onError', getPermission().errMsg(error), error);
    clearInterval(this.timer);
    this.setData({ recording: false, starting: false, stopping: false });
    const scope = await getPermission().getScopeRecordState(wx);
    const microphone = getPermission().getWechatMicrophoneState(wx);
    if (!this.alive || attempt !== this.recordAttempt || this.data.recording) return;
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
    if (!this.alive || this.visible === false || !issue) return;
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
      success: res => { if (res.confirm && action && this.alive && this.visible !== false) this.runIssueAction(issue); }
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
    else if (issue.action === 'retry' && !this.data.recording) this.recordTap();
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
    if (!this.data.recording) this.recordTap();
  },
  finishRecording(result) {
    clearInterval(this.timer);
    if (!this.alive || this.cancelled) return false;
    return this.processRecording(null, result);
  },
  async processRecording(recording, result) {
    if (!this.alive || this.processingJob) return false;
    this.processingJob = true;
    this.cancelled = false;
    const recognitionMode = this.data.recognitionMode;
    this.setData({ recording: false, starting: false, stopping: false, processing: true, progress: 0,
      processingLabel: recording ? '读取本地录音' : '保存本地录音' });
    const cancelled = () => !this.alive || this.cancelled;
    let lastProgressAt = 0;
    let source = null;
    try {
      if (recording && storage.get(recording.id)) {
        // The idea can be committed before metadata cleanup if WeChat is interrupted.
        try { storage.removePendingRecording(recording.id); } catch (_) {}
        return this.openRecognized(recording.id);
      }
      if (!recording) {
        const { tempFilePath, duration } = result || {};
        recording = await storage.stageRecording(tempFilePath, duration);
      }
      if (cancelled()) return false;
      this.setData({ processingLabel: '读取本地录音' });
      const tools = recognitionTools();
      const decoded = await tools.audio.decodeFile(recording.path, cancelled);
      if (cancelled()) return false;
      if (decoded.samples.length / decoded.sampleRate < .7) throw new Error('这段录音太短，建议连续哼唱 2 到 15 秒。');
      const bpm = 100;
      this.setData({ processingLabel: '正在本机识别音高与音符' });
      const recognized = await tools.transcribe(decoded.samples, decoded.sampleRate, bpm,
        progress => {
          const now = Date.now();
          if (!cancelled() && (progress === 100 || now - lastProgressAt >= 70)) {
            this.setData({ progress });
            lastProgressAt = now;
          }
        }, cancelled,
        { mode: recognitionMode, onStage: processingLabel => {
          if (!cancelled() && processingLabel !== this.data.processingLabel) this.setData({ processingLabel });
        } });
      if (cancelled()) return false;
      const { id, title, createdAt } = recording;
      this.setData({ processingLabel: '保存旋律与录音' });
      source = await storage.saveRecording(recording.path, id, decoded);
      if (cancelled()) return false;
      storage.save({ id, title, bpm,
        createdAt, updatedAt: Date.now(), notes: recognized.notes, source,
        confidence: recognized.confidence, recordingDuration: recognized.duration, isDemo: false,
        recognitionEngine: recognized.engine || 'yin', recognitionVersion: recognized.engineVersion || null,
        recognitionProfile: recognized.postprocessVersion || null, recognitionConditioning: recognized.conditioning || null,
        recognitionFallback: recognized.fallbackFrom || null, recognitionFallbackReason: recognized.fallbackReason || null,
        recognitionDiagnostic: recognized.fallbackDiagnostic || null });
      source = null;
      try { storage.removePendingRecording(id); } catch (_) {}
      if (recognized.fallbackFrom) {
        this.setData({ recognitionMode: 'standard' });
        recognitionSettings.setMode(wx, 'standard');
        if (this.visible !== false) wx.showToast({ title: '实验识别不可用，已切回标准', icon: 'none', duration: 3500 });
      } else if (this.wasInterrupted && this.visible !== false) wx.showToast({ title: '已保存中断前的旋律', icon: 'none' });
      return this.openRecognized(id);
    } catch (err) {
      if (!cancelled() && this.visible !== false) {
        const message = err && (err.message || err.errMsg) || '请检查本机存储空间。';
        wx.showModal({ title: recording ? '这次没有识别成功' : '录音未能保存',
          content: recording ? message + '\n录音已保留，可从「待识别录音」重试。' : message, showCancel: false });
      }
      return false;
    } finally {
      if (source) storage.removeFile(source);
      this.processingJob = false;
      if (this.alive) {
        this.setData({ processing: false, progress: 0, elapsed: '00:00', recordSeconds: 0 });
        this.refreshPendingRecordings();
      }
    }
  },
  openRecognized(id) {
    this.refresh();
    if (this.visible === false) return true;
    this.navigationPending = true;
    return this.navigateToPage('/pages/editor/editor?id=' + id, '旋律已保存，请从灵感列表打开');
  },
  navigateToPage(url, failureTitle) {
    const attempt = (this.navigationAttempt || 0) + 1;
    this.navigationAttempt = attempt;
    const fail = error => {
      if (attempt !== this.navigationAttempt) return;
      this.navigationPending = false;
      console.warn('[navigation]', failureTitle, error && (error.errMsg || error.message));
      if (this.alive) wx.showToast({ title: failureTitle, icon: 'none' });
    };
    try {
      if (!wx || typeof wx.navigateTo !== 'function') throw new Error('navigateTo unavailable');
      wx.navigateTo({ url, fail });
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  },
  openCreation() {
    if (this.data.recording || this.data.starting || this.data.processing || this.data.checkingRecognition || this.navigationPending) return false;
    // Keep this guard until the page is shown again. It absorbs a second tap
    // queued before the first navigation starts hiding the page.
    this.navigationPending = true;
    return this.navigateToPage('/pages/compose/compose', '暂时无法打开创作页');
  },
  openDemo() {
    if (this.data.recording || this.data.starting || this.data.processing || this.data.checkingRecognition || this.navigationPending) return false;
    this.navigationPending = true;
    try {
      let idea = storage.summaryPage(0, 100).items.find(i => i.isDemo);
      if (!idea) idea = storage.save(music.demo());
      return this.navigateToPage('/pages/editor/editor?id=' + idea.id, '暂时无法打开示例');
    } catch (err) {
      this.navigationPending = false;
      wx.showToast({ title: err.message || '保存失败，请检查存储空间', icon: 'none' });
      return false;
    }
  },
  openIdea(event) {
    if (this.data.recording || this.data.starting || this.data.processing || this.data.checkingRecognition || this.navigationPending) return false;
    const id = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
    if (!id) return false;
    this.navigationPending = true;
    return this.navigateToPage('/pages/editor/editor?id=' + id, '暂时无法打开这条灵感');
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
