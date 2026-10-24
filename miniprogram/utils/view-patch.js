const equalItem = (a, b) => a === b || !!(a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => a[key] === b[key]));

// Send only changed view fields through WeChat's logic/view bridge. The render
// snapshot stays outside page.data, so it is never serialized to the view.
function viewPatch(previous, next) {
  const patch = {};
  Object.keys(next).forEach(key => {
    const before = previous && previous[key], after = next[key];
    if (before === after) return;
    if (key === 'notes' && Array.isArray(before) && before.length === after.length) {
      const changed = [];
      for (let i = 0; i < after.length; i++) if (!equalItem(before[i], after[i])) changed.push(i);
      if (changed.length <= after.length / 2) {
        changed.forEach(i => { patch['notes[' + i + ']'] = after[i]; });
        return;
      }
    } else if (key === 'selected' && equalItem(before, after)) return;
    patch[key] = after;
  });
  return patch;
}
module.exports = { viewPatch };
