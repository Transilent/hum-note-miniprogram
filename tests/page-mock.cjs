const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function applyPatch(data, patch) {
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let target = data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (target[keys[i]] == null) target[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      target = target[keys[i]];
    }
    target[keys.at(-1)] = clone(value);
  }
}
module.exports = { applyPatch, clone };
