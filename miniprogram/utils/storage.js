const { normalizeNotes, assertNoOverlaps, clamp } = require('./music');
const KEY = 'humnote.ideas.v1';
const DRAFT_KEY = 'humnote.drafts.v1';
const SUMMARY_KEY = 'humnote.idea-summaries.v1';
const SUMMARY_DIRTY_KEY = 'humnote.idea-summaries.v1.dirty';
const SUMMARY_SCHEMA = 1;
const PREVIEW_NOTES = 18;
const ROOT = () => wx.env.USER_DATA_PATH + '/humnote';

function initDir() { try { wx.getFileSystemManager().mkdirSync(ROOT(), true); } catch (_) {} }
function list() { const value = wx.getStorageSync(KEY); return Array.isArray(value) ? value : []; }
function get(id) { return list().find(idea => idea.id === id); }
function listDrafts() { const value = wx.getStorageSync(DRAFT_KEY); return Array.isArray(value) ? value : []; }
function getDraft(id) { return listDrafts().find(idea => idea.id === id); }

function ideaNotes(idea) { return idea && Array.isArray(idea.notes) ? idea.notes : []; }
function draftApplies(idea, drafts) {
  return drafts.some(draft => draft && draft.id === idea.id && draft.draftUpdatedAt >= idea.updatedAt);
}
function secondsOf(notes, bpm) {
  let beats = 0;
  notes.forEach(note => {
    const end = Number(note.start) + Number(note.duration);
    if (Number.isFinite(end) && end > beats) beats = end;
  });
  return beats * 60 / (Number(bpm) || 100);
}
function summaryFrom(idea, drafts) {
  const notes = ideaNotes(idea);
  const pitches = notes.map(note => Number(note.midi)).filter(Number.isFinite);
  const min = pitches.length ? Math.min.apply(null, pitches) : 0;
  const max = pitches.length ? Math.max.apply(null, pitches) : 0;
  const span = Math.max(1, max - min);
  return {
    id: idea.id,
    title: String(idea.title || '未命名的灵感'),
    updatedAt: Number(idea.updatedAt) || 0,
    noteCount: notes.length,
    seconds: Math.round(secondsOf(notes, idea.bpm) * 10) / 10,
    preview: notes.slice(0, PREVIEW_NOTES).map(note => {
      const midi = Number(note.midi), duration = Number(note.duration);
      return {
        height: Math.round((18 + ((Number.isFinite(midi) ? midi : min) - min) / span * 39) * 10) / 10,
        width: Math.round(clamp((Number.isFinite(duration) ? duration : 0) * 12, 7, 22) * 10) / 10
      };
    }),
    hasDraft: draftApplies(idea, drafts),
    isDemo: !!idea.isDemo
  };
}
function sortSummaries(items) {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => (Number(b.item.updatedAt) || 0) - (Number(a.item.updatedAt) || 0) || a.index - b.index)
    .map(entry => entry.item);
}
function makeIndex(items) {
  const ordered = sortSummaries(items);
  return { schema: SUMMARY_SCHEMA, count: ordered.length, items: ordered };
}
function buildIndex(ideas, drafts) {
  return makeIndex(ideas.filter(idea => idea && idea.id != null).map(idea => summaryFrom(idea, drafts)));
}
function validPreview(preview) {
  return Array.isArray(preview) && preview.length <= PREVIEW_NOTES && preview.every(bar =>
    bar && Number.isFinite(bar.height) && Number.isFinite(bar.width));
}
function validIndex(index) {
  return !!index && index.schema === SUMMARY_SCHEMA && Array.isArray(index.items) &&
    Number.isInteger(index.count) && index.count === index.items.length &&
    index.items.every(item => item && item.id != null && typeof item.title === 'string' &&
      Number.isFinite(item.updatedAt) && Number.isInteger(item.noteCount) && item.noteCount >= 0 &&
      Number.isFinite(item.seconds) && validPreview(item.preview) &&
      typeof item.hasDraft === 'boolean' && typeof item.isDemo === 'boolean');
}
function isDirty() {
  try {
    const value = wx.getStorageSync(SUMMARY_DIRTY_KEY);
    return value === true || value === 1 || value === '1';
  } catch (_) { return true; }
}
function cleanIndex() {
  if (isDirty()) return null;
  try {
    const index = wx.getStorageSync(SUMMARY_KEY);
    return validIndex(index) ? index : null;
  } catch (_) { return null; }
}
function markDirty() { wx.setStorageSync(SUMMARY_DIRTY_KEY, 1); }
function clearDirty() {
  try {
    if (wx.removeStorageSync) wx.removeStorageSync(SUMMARY_DIRTY_KEY);
    else wx.setStorageSync(SUMMARY_DIRTY_KEY, 0);
  } catch (_) {}
}
function writeIndex(index) { wx.setStorageSync(SUMMARY_KEY, index); }
function rebuildIndex(ideas, drafts, alreadyDirty) {
  const index = buildIndex(ideas, drafts);
  let flagged = !!alreadyDirty;
  if (!flagged) {
    try { markDirty(); flagged = true; } catch (_) {}
  }
  try {
    writeIndex(index);
    if (flagged) clearDirty();
  } catch (_) {}
  return index;
}
function ensureIndex() {
  return cleanIndex() || rebuildIndex(list(), listDrafts(), false);
}
function indexMatchesIdeas(index, ideas) {
  if (!index || index.count !== ideas.length) return false;
  const byId = {};
  index.items.forEach(item => { byId[item.id] = item; });
  return ideas.every(idea => {
    const item = byId[idea.id];
    return !!item && item.updatedAt === (Number(idea.updatedAt) || 0) && item.noteCount === ideaNotes(idea).length;
  });
}
function revisionOf(index) {
  let hash = 2166136261;
  const add = value => {
    const text = String(value == null ? '' : value);
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    hash = Math.imul(hash ^ 31, 16777619);
  };
  index.items.forEach(item => {
    add(item.id); add(item.updatedAt); add(item.title); add(item.noteCount);
    add(item.seconds); add(item.hasDraft); add(item.isDemo); add(item.preview.length);
    item.preview.forEach(bar => { add(bar.height); add(bar.width); });
  });
  return (hash >>> 0).toString(36);
}
function summaryPage(offset, limit) {
  const index = ensureIndex();
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const items = index.items.slice(start, start + size).map(item => {
    const date = new Date(item.updatedAt);
    return {
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      dateLabel: (date.getMonth() + 1) + '月' + date.getDate() + '日',
      secondsLabel: item.seconds.toFixed(1),
      noteCount: item.noteCount,
      preview: item.preview,
      hasDraft: item.hasDraft,
      isDemo: item.isDemo
    };
  });
  return { items, total: index.count, revision: revisionOf(index) };
}
function updatedIndex(cached, ideas, drafts, update) {
  if (!cached) return buildIndex(ideas, drafts);
  const items = update(cached.items.slice());
  return makeIndex(items);
}
function beginMutation() { const wasDirty = isDirty(); markDirty(); return wasDirty; }
function finishMutation(ok) { if (ok) clearDirty(); }
function applyDraftState(items, id, hasDraft) {
  return items.map(item => item.id === id ? Object.assign({}, item, { hasDraft }) : item);
}

function clearDraft(id) {
  const drafts = listDrafts();
  if (!drafts.some(draft => draft.id === id)) return;
  const cached = cleanIndex();
  const next = drafts.filter(draft => draft.id !== id);
  const wasDirty = beginMutation();
  try { wx.setStorageSync(DRAFT_KEY, next); } catch (error) { if (!wasDirty) clearDirty(); throw error; }
  let ok = true;
  try {
    let index;
    if (cached) index = updatedIndex(cached, null, next, items => applyDraftState(items, id, false));
    else index = buildIndex(list(), next);
    writeIndex(index);
  } catch (_) { ok = false; }
  finishMutation(ok);
}
function saveDraft(idea) {
  const drafts = listDrafts(), at = drafts.findIndex(draft => draft.id === idea.id);
  const data = Object.assign({}, idea, { notes: normalizeNotes(idea.notes), draftUpdatedAt: Date.now() });
  if (at >= 0) drafts[at] = data; else drafts.push(data);
  const cached = cleanIndex();
  const wasDirty = beginMutation();
  try { wx.setStorageSync(DRAFT_KEY, drafts); } catch (error) { if (!wasDirty) clearDirty(); throw error; }
  let ok = true;
  try {
    let index;
    if (cached && cached.items.some(item => item.id === idea.id)) {
      index = updatedIndex(cached, null, drafts, items => applyDraftState(items, idea.id, true));
    } else index = buildIndex(list(), drafts);
    writeIndex(index);
  } catch (_) { ok = false; }
  finishMutation(ok);
  return data;
}
function save(idea) {
  initDir();
  const notes = normalizeNotes(idea.notes);
  if (!notes.length) throw new Error('请先添加至少一个音符。');
  assertNoOverlaps(notes);
  const data = Object.assign({}, idea, { title: String(idea.title || '未命名的灵感').trim().slice(0, 40),
    notes, bpm: clamp(Number(idea.bpm) || 100, 40, 240), updatedAt: Date.now() });
  delete data.draftUpdatedAt;
  const ideas = list(), at = ideas.findIndex(item => item.id === data.id);
  const cached = cleanIndex(), cacheMatches = indexMatchesIdeas(cached, ideas);
  if (at >= 0) ideas[at] = data;
  else {
    if (ideas.length >= 100) throw new Error('记录本已经有 100 条灵感，请先导出并整理旧记录。');
    ideas.unshift(data);
  }
  const wasDirty = beginMutation();
  try { wx.setStorageSync(KEY, ideas); } catch (error) { if (!wasDirty) clearDirty(); throw error; }

  let nextDrafts = null, metadataOk = true;
  try {
    const drafts = listDrafts();
    nextDrafts = drafts.filter(draft => draft.id !== data.id);
    if (nextDrafts.length !== drafts.length) {
      try { wx.setStorageSync(DRAFT_KEY, nextDrafts); } catch (_) { metadataOk = false; }
    }
  } catch (_) { metadataOk = false; }

  // Draft cleanup is part of the summary transaction. If it cannot be read or
  // written, leave the sentinel in place and rebuild from canonical data later.
  if (metadataOk) {
    try {
      let index;
      if (cacheMatches) {
        let found = false;
        const items = cached.items.map(item => {
          if (item.id !== data.id) return item;
          found = true;
          return summaryFrom(data, nextDrafts);
        });
        if (!found) items.unshift(summaryFrom(data, nextDrafts));
        index = makeIndex(items);
      } else index = buildIndex(ideas, nextDrafts);
      writeIndex(index);
    } catch (_) { metadataOk = false; }
  }
  finishMutation(metadataOk);
  return data;
}
async function saveRecording(tempPath, id, decoded) {
  initDir();
  const filePath = ROOT() + '/recording-' + id + '.wav';
  if (decoded) {
    const buffer = require('./wav').encodeWav(decoded.samples, decoded.sampleRate);
    await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: buffer, success: resolve, fail: reject }));
  } else {
    await new Promise((resolve, reject) => wx.getFileSystemManager().copyFile({ srcPath: tempPath, destPath: filePath, success: resolve, fail: reject }));
  }
  return filePath;
}
function removeFile(path) {
  if (path && path.indexOf(ROOT() + '/') === 0) { try { wx.getFileSystemManager().unlinkSync(path); } catch (_) {} }
}
function remove(id) {
  const ideas = list(), idea = ideas.find(item => item.id === id);
  const cached = cleanIndex(), cacheMatches = indexMatchesIdeas(cached, ideas);
  const nextIdeas = ideas.filter(item => item.id !== id);
  const wasDirty = beginMutation();
  try { wx.setStorageSync(KEY, nextIdeas); } catch (error) { if (!wasDirty) clearDirty(); throw error; }

  let drafts;
  try { drafts = listDrafts(); } catch (_) { drafts = []; }
  const nextDrafts = drafts.filter(draft => draft.id !== id);
  if (nextDrafts.length !== drafts.length) {
    try { wx.setStorageSync(DRAFT_KEY, nextDrafts); } catch (_) {}
  }
  let ok = true;
  try {
    const index = cacheMatches ? makeIndex(cached.items.filter(item => item.id !== id)) : buildIndex(nextIdeas, nextDrafts);
    writeIndex(index);
  } catch (_) { ok = false; }
  finishMutation(ok);
  if (idea) removeFile(idea.source);
  removeFile(ROOT() + '/melody-' + id + '.mid');
}
function midiPath(id) { initDir(); return ROOT() + '/melody-' + id + '.mid'; }

module.exports = { list, get, listDrafts, getDraft, saveDraft, clearDraft, save, saveRecording, remove, removeFile, midiPath, summaryPage };