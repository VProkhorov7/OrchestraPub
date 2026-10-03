/* Orchestra — live task for the big central field.
   A tiny UMD-style module: `module.exports` in Node, `window.BigField` in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BigField = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The single task of `run.tasks` with status 'running', or null unless there is exactly one. */
  function pickLiveTask(run) {
    if (!run || !Array.isArray(run.tasks)) return null;
    const running = run.tasks.filter((t) => t.status === 'running');
    return running.length === 1 ? running[0] : null;
  }

  /** Last `n` lines of a task's `log` array (default 40; fewer if shorter; [] on a missing log). */
  function tailLines(log, n) {
    const arr = Array.isArray(log) ? log : [];
    const k = n === undefined ? 40 : n;
    return k ? arr.slice(-k) : [];
  }

  return { pickLiveTask: pickLiveTask, tailLines: tailLines };
});
