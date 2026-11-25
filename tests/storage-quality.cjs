const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { encodeWav } = require('../miniprogram/utils/wav');
const storage = require('../miniprogram/utils/storage');

async function main() {
  const sampleRate = 48000;
  const samples = Float32Array.from({length:sampleRate*30},(_,i)=>Math.sin(i*.04)*.3);
  const expected = Buffer.from(encodeWav(samples,sampleRate));
  let wrote=0, ticks=0, writtenPath;
  const files = new Map(), values = new Map();
  global.wx={env:{USER_DATA_PATH:'/quality-only'},getStorageSync:k=>values.get(k)||'',setStorageSync:(k,v)=>values.set(k,v),
    getFileSystemManager:()=>({mkdirSync(){},writeFile({filePath,data,success}){wrote++;writtenPath=filePath;files.set(filePath,Buffer.from(data));success();}})};
  const timer=setInterval(()=>ticks++,0);
  const started=performance.now();
  const path=await storage.saveRecording('/unused','synthetic-30s',{samples,sampleRate});
  clearInterval(timer);
  assert.equal(path,'/quality-only/humnote/recording-synthetic-30s.wav');
  assert.equal(wrote,1);assert.equal(path,writtenPath);assert.deepEqual(files.get(path),expected);
  assert.ok(ticks>0,'30-second recording encoding must yield before writing the file');
  console.log('PASS 30-second original recording saves byte-identical WAV while yielding to UI ('+ticks+' ticks, '+(performance.now()-started).toFixed(1)+' ms desktop)');

  global.wx.getFileSystemManager=()=>({mkdirSync(){},writeFile({fail}){fail(new Error('simulated disk full'));}});
  await assert.rejects(storage.saveRecording('/unused','failed',{samples:new Float32Array(16),sampleRate}),/simulated disk full/);
  assert.equal(values.size,0,'saving audio must not create a partial idea record');
  console.log('PASS recording write failure remains observable and does not create an idea');
  let copied;
  global.wx.getFileSystemManager=()=>({mkdirSync(){},copyFile(options){copied=[options.srcPath,options.destPath];options.success();}});
  assert.equal(await storage.saveRecording('/provided-source','copy-only'),'/quality-only/humnote/recording-copy-only.wav');
  assert.deepEqual(copied,['/provided-source','/quality-only/humnote/recording-copy-only.wav']);
  console.log('PASS original-file copy path remains available without decoding');
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
