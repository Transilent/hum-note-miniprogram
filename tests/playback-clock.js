const assert = require('node:assert/strict');
const { PlaybackClock } = require('../miniprogram/utils/playback-clock');
const { Player } = require('../miniprogram/utils/audio');

module.exports = async function(check, asyncCheck) {
  check('音频进度在稀疏回调之间连续前进，并用实际音频时间校准', () => {
    let now = 0, audio = 0; const output = [];
    const clock = new PlaybackClock(() => audio, t => output.push(t), () => now);
    clock.start(); now = 100; clock.tick(); assert.equal(output.at(-1), .1);
    now = 200; clock.tick(); assert.equal(output.at(-1), .2);
    audio = .24; now = 250; clock.tick(); assert.equal(output.at(-1), .24);
    now = 350; clock.tick(); assert.ok(Math.abs(output.at(-1) - .34) < 1e-9);
    audio = .18; now = 360; clock.tick(); assert.ok(output.at(-1) >= .34, 'late lower timestamp must not rewind');
    clock.hold(); now = 4000; clock.tick(); assert.ok(clock.value() >= .34);
    audio = .34; clock.start(); now += 100; clock.tick(); assert.ok(Math.abs(output.at(-1) - .44) < 1e-9);
    clock.duration = .4; assert.equal(clock.value(), .4);
  });

  check('音频时钟停滞时游标停止外推，普通回调不会倒走，主动定位可以回退', () => {
    let now = 0, audio = 0;
    const output = [], clock = new PlaybackClock(() => audio, time => output.push(time), () => now);
    clock.start();
    now = 700; clock.tick();
    const limit = output.at(-1);
    assert.ok(limit > .25 && limit < .4);
    now = 2000; clock.tick();
    assert.equal(output.at(-1), limit);
    audio = .24; clock.tick();
    assert.equal(output.at(-1), limit);
    audio = .42; clock.tick();
    assert.equal(output.at(-1), .42);
    clock.hold(); audio = .1;
    clock.start(false);
    assert.equal(output.at(-1), .42, '恢复播放不会回退');
    clock.start();
    assert.equal(output.at(-1), .1, '主动跳转可以回退');
  });
  await asyncCheck('真实播放器在音频开始后才计时，缓冲、结束和销毁清理计时器', async () => {
    const saved = { wx: global.wx, interval: global.setInterval, clear: global.clearInterval, now: Date.now };
    let now = 0, nextTimer = 0, plays = 0, ended = 0, write;
    const listeners = {}, timers = new Map(), progress = [];
    const inner = { currentTime: 0, duration: 5, paused: false,
      play() { plays++; }, stop() {}, destroy() {} };
    for (const event of ['Ended', 'Error', 'TimeUpdate', 'Play', 'Pause', 'Waiting', 'Seeking', 'Seeked']) inner['on' + event] = cb => { listeners[event] = cb; };
    global.wx = { env: { USER_DATA_PATH: '/mock' }, createInnerAudioContext: () => inner,
      getFileSystemManager: () => ({ writeFile(options) { write = options; } }) };
    Date.now = () => now;
    global.setInterval = cb => { timers.set(++nextTimer, cb); return nextTimer; };
    global.clearInterval = id => timers.delete(id);
    const player = new Player(() => ended++, t => progress.push(t));
    try {
      const pending = player.playNotes([{ midi: 60, start: 0, duration: 1 }], 100, 'piano');
      now = 500; assert.equal(timers.size, 0); assert.equal(progress.at(-1), 0);
      await Promise.resolve(); await Promise.resolve();
      write.success(); await pending; assert.equal(plays, 1); assert.equal(timers.size, 0);
      listeners.Play(); now = 600; for (const cb of timers.values()) cb(); assert.equal(progress.at(-1), .1);
      listeners.Waiting(); assert.equal(timers.size, 0); const held = progress.at(-1);
      now = 3000; assert.equal(progress.at(-1), held);
      inner.currentTime = .15; listeners.TimeUpdate(); assert.equal(timers.size, 1);
      now = 3100; for (const cb of timers.values()) cb(); assert.equal(progress.at(-1), .25);
      listeners.Ended(); assert.equal(timers.size, 0); assert.equal(progress.at(-1), 0); assert.equal(ended, 1);
      const stale = player.playNotes([{ midi: 62, start: 0, duration: 1 }], 100, 'piano');
      await Promise.resolve(); await Promise.resolve();
      player.stop(); write.success(); assert.equal(await stale, false); assert.equal(plays, 1);
      player.playFile('/example.wav'); listeners.Play(); player.destroy(); assert.equal(timers.size, 0);
    } finally {
      player.destroy(); Date.now = saved.now; global.setInterval = saved.interval; global.clearInterval = saved.clear;
      if (saved.wx === undefined) delete global.wx; else global.wx = saved.wx;
    }
  });
  await asyncCheck('进度回调重入停止后不会留下僵尸定时器', async () => {
    const saved = { wx: global.wx, interval: global.setInterval, clear: global.clearInterval, now: Date.now };
    let now = 0, nextTimer = 0, pendingWrite, armed = false, player, progress = 0;
    const timers = new Map(), listeners = {};
    const inner = { currentTime: 0, duration: 2, paused: true,
      play() { this.paused = false; }, stop() { this.paused = true; }, destroy() {} };
    for (const event of ['Ended', 'Error', 'TimeUpdate', 'Play', 'Pause', 'Waiting', 'Seeking', 'Seeked']) inner['on' + event] = cb => { listeners[event] = cb; };
    global.wx = { env: { USER_DATA_PATH: '/mock' }, createInnerAudioContext: () => inner,
      getFileSystemManager: () => ({ writeFile(options) { pendingWrite = options; } }) };
    Date.now = () => now;
    global.setInterval = cb => { timers.set(++nextTimer, cb); return nextTimer; };
    global.clearInterval = id => timers.delete(id);
    player = new Player(() => {}, () => {
      progress++;
      if (armed) {
        armed = false;
        player.stop();
      }
    });
    try {
      const pending = player.playNotes([{ midi: 60, start: 0, duration: .25 }], 100, 'piano');
      await Promise.resolve(); await Promise.resolve();
      pendingWrite.success(); await pending;
      armed = true;
      listeners.Play();
      assert.equal(player.requested, false);
      assert.equal(player.waiting, false);
      assert.equal(timers.size, 0, 'stop from the first progress callback must clear the newly installed interval');
      assert.ok(progress >= 2);
    } finally {
      player.destroy(); Date.now = saved.now; global.setInterval = saved.interval; global.clearInterval = saved.clear;
      if (saved.wx === undefined) delete global.wx; else global.wx = saved.wx;
    }
  });
};
