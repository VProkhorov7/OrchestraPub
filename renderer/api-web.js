/* Web mode (`orchestra serve`): the same `window.orch` API as the desktop app's preload, over HTTP + server-sent events.
   In the desktop app the preload defines window.orch first and this file does nothing. */
(function () {
  if (window.orch) return;
  const call = async (method, url, data) => {
    const r = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: data !== undefined ? { 'content-type': 'application/json' } : {},
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    const text = await r.text();
    const j = text ? JSON.parse(text) : null;
    if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j;
  };
  const get = (u) => call('GET', u);
  const post = (u, d) => call('POST', u, d ?? {});
  const enc = encodeURIComponent;

  function pickFile() {
    return new Promise((resolve, reject) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.md,.txt,.rst,.json,.yaml,.yml';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return resolve(null);
        if (f.size > 200000) return reject(new Error('Файл слишком большой (лимит 200 КБ)'));
        f.text().then((text) => resolve({ name: f.name, text }), reject);
      };
      inp.click();
    });
  }

  window.orch = {
    isWeb: true,
    getConfig: () => get('/api/config'),
    saveConfig: (cfg) => call('PUT', '/api/config', cfg),
    selectRepo: async () => null, // no native dialog in a browser: the field offers known repositories instead
    listRepos: () => get('/api/repos'),
    checkEnv: () => get('/api/env'),
    triage: (goal) => post('/api/triage', { goal }),
    makePlan: (repo, goal, choice) => post('/api/plan', { repo, goal, choice }),
    start: async (repo, goal, plan, choice) => (await post('/api/runs', { repo, goal, plan, choice })).runId,
    attachGoalFile: pickFile,
    listRoles: () => get('/api/roles'),
    listCatalog: () => get('/api/catalog'),
    getHealth: () => get('/api/health'),
    checkHealth: (id) => post('/api/health', { id }),
    memoryStatus: (repo) => get(`/api/memory?repo=${enc(repo)}`),
    memoryInit: (repo, project) => post('/api/memory/init', { repo, project }),
    memoryDigest: (repo) => post('/api/memory/digest', { repo }),
    memoryChangelog: (repo, release) => post('/api/memory/changelog', { repo, release }),
    doctorReport: () => get('/api/doctor'),
    doctorPlan: (mode) => post('/api/doctor/plan', { mode }),
    doctorApply: (mode) => post('/api/doctor/apply', { mode }),
    doctorUndo: () => post('/api/doctor/undo'),
    doctorProjects: (projects, roots) => post('/api/doctor/projects', { projects, roots }),
    doctorDiscover: (roots) => post('/api/doctor/discover', { roots }),
    tariff: () => get('/api/tariff'),
    report: (days) => get('/api/report?days=' + enc(days)),
    ledger: () => get('/api/ledger'),
    ledgerSnapshot: (id, balance, unitUsd) => post('/api/ledger', { id, balance, unitUsd }),
    freeModels: () => get('/api/free/models'),
    localModels: (id) => get(`/api/local/models?id=${enc(id)}`),
    localPrepare: (id) => post('/api/local/prepare', { id }),
    listAlerts: () => get('/api/alerts'),
    clearAlerts: () => post('/api/alerts/clear'),
    scheduledList: () => get('/api/scheduled'),
    schedule: (repo, goal, plan, choice) => post('/api/schedule', { repo, goal, plan, choice }),
    unschedule: (id) => call('DELETE', `/api/scheduled/${enc(id)}`),
    startScheduledNow: async (id) => (await post(`/api/scheduled/${enc(id)}/now`)).runId,
    listRuns: () => get('/api/runs'),
    loadRun: (id) => get(`/api/runs/${enc(id)}`),
    deleteRun: (id) => call('DELETE', `/api/runs/${enc(id)}`),
    resumeRun: async (id) => (await post(`/api/runs/${enc(id)}/resume`)).runId,
    cancel: (runId) => post(`/api/runs/${enc(runId)}/cancel`),
    getState: (runId) => get(runId ? `/api/runs/${enc(runId)}` : '/api/runs/current'),
    mergeTask: (runId, id) => post(`/api/runs/${enc(runId)}/tasks/${enc(id)}/merge`),
    discardTask: (runId, id) => post(`/api/runs/${enc(runId)}/tasks/${enc(id)}/discard`),
    // The service opens the folder in Finder when this browser is on the same machine; otherwise the path is copied.
    openWorktree: async (runId, id) => {
      let r;
      try {
        r = await post(`/api/runs/${enc(runId)}/tasks/${enc(id)}/open`);
      } catch (e) {
        // A service that is older than this page (not restarted yet) has no «open» address: copy the path as before.
        const path = await get(`/api/runs/${enc(runId)}/tasks/${enc(id)}/worktree`);
        r = { opened: false, path, message: `Worktree на сервере: ${path}` };
      }
      if (r && r.path && !r.opened && !/^(Рабочей папки|The working folder)/.test(r.message)) {
        let copied = '';
        try { await navigator.clipboard.writeText(r.path); copied = ' (путь скопирован)'; } catch (e) { /* not allowed */ }
        return `${r.message}${copied}`;
      }
      return r && r.message;
    },
    info: () => get('/api/info'),
    onEvent: (cb) => {
      let es;
      const connect = () => {
        es = new EventSource('/api/events');
        es.onmessage = (m) => { try { cb(JSON.parse(m.data)); } catch (e) { /* ignore */ } };
        es.onerror = () => { es.close(); setTimeout(connect, 3000); };
      };
      connect();
      return () => es && es.close();
    },
  };
})();
