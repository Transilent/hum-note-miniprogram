const KEY = 'humnote.recognition-mode.v1';
const MODES = ['standard', 'swift-f0'];

function validMode(value) { return MODES.indexOf(value) >= 0; }
function getMode(api) {
  try {
    const value = api.getStorageSync(KEY);
    return validMode(value) ? value : 'standard';
  } catch (_) { return 'standard'; }
}
function setMode(api, value) {
  if (!validMode(value)) return false;
  try { api.setStorageSync(KEY, value); return true; } catch (_) { return false; }
}

module.exports = { KEY, validMode, getMode, setMode };
