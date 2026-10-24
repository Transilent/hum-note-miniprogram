App({
  onLaunch() {
    if (wx.setInnerAudioOption) {
      wx.setInnerAudioOption({ obeyMuteSwitch: false, fail() {} });
    }
  }
});
