"use strict";

window.CET6Sync = (() => {
  const owner = "ruixi892-beep";
  const repository = "cet6-word-review-progress";
  const fullName = owner + "/" + repository;
  const api = "https://api.github.com/repos/" + fullName;
  const file = api + "/contents/progress.json";
  const storageKey = "cet6-sync-access-v1";
  const tokenLink = "https://github.com/settings/personal-access-tokens/new?" + new URLSearchParams({
    name: "CET6 study progress", target_name: owner, contents: "write", expires_in: "365"
  });

  const tokenFormat = /^github_pat_[A-Za-z0-9_]{30,250}$/;

  function recordKey(row) {
    return row ? [row.updated, row.status, row.due, row.stage].join("|") : "";
  }

  function sameRecords(left, right) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every(word => recordKey(left[word]) === recordKey(right[word]));
  }

  function merge(left, right) {
    const result = Object.assign(Object.create(null), left);
    for (const [word, other] of Object.entries(right)) {
      const local = result[word];
      if (!local || other.updated > local.updated ||
          (other.updated === local.updated && recordKey(other) > recordKey(local))) {
        result[word] = other;
      }
    }
    return result;
  }

  class SyncError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }

  async function request(url, token, body) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 12000);
    try {
      const headers = {Authorization: "Bearer " + token, Accept: "application/vnd.github+json"};
      if (body) headers["Content-Type"] = "application/json";
      const response = await fetch(url, {
        method: body ? "PUT" : "GET", headers, body: body ? JSON.stringify(body) : undefined,
        credentials: "omit", cache: "no-store", redirect: "error", signal: abort.signal
      });
      if (response.ok) return await response.json();
      if (response.status === 409 && body) throw new SyncError("conflict", "设备同时更新");
      if (response.status === 422 && body) {
        const problem = await response.json();
        if (/sha|conflict/i.test(problem.message ?? "")) {
          throw new SyncError("conflict", "设备同时更新");
        }
      }
      if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")) {
        throw new SyncError("retry", "GitHub 暂时限制了请求，稍后自动重试。");
      }
      if ([401, 403, 404].includes(response.status)) {
        throw new SyncError("access", "请检查授权码是否有效，并确认它仅选中了专用仓库，且 Contents 为可读写。");
      }
      throw new SyncError("retry", "GitHub 暂时无法同步，稍后自动重试。");
    } finally {
      clearTimeout(timeout);
    }
  }

  function decodeProgress(remote, clean) {
    try {
      if (remote.encoding !== "base64" || typeof remote.sha !== "string") throw Error();
      const bytes = Uint8Array.from(atob(remote.content.replace(/\s+/g, "")), c => c.charCodeAt(0));
      const document = JSON.parse(new TextDecoder().decode(bytes));
      if (document.version !== 1) throw Error();
      const records = clean(document.records);
      if (Object.keys(records).length !== Object.keys(document.records).length) throw Error();
      return records;
    } catch {
      throw new SyncError("format", "云端进度文件格式异常，请检查专用仓库中的 progress.json。");
    }
  }

  function encodeProgress(records) {
    const bytes = new TextEncoder().encode(JSON.stringify({version: 1, records}) + "\n");
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  }

  function create({getRecords, applyRecords, cleanRecords, onStatus}) {
    let token = "";
    try {
      const stored = localStorage.getItem(storageKey) ?? "";
      if (tokenFormat.test(stored)) token = stored;
    } catch { /* Private browsing may disable storage. */ }

    let busy = false;
    let pending = false;
    let timer;
    let paused = false;
    let lastSync = 0;
    let transientFailures = 0;
    let status = {phase: token ? "queued" : "off", message: ""};

    function show(phase, message = "") {
      status = {phase, message, lastSync};
      onStatus();
    }

    function queue(delay = 800) {
      if (!token || paused) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void syncNow(); }, delay);
    }

    function clearToken() {
      token = "";
      try { localStorage.removeItem(storageKey); } catch { /* Keep progress in memory. */ }
    }

    async function exchange(code) {
      const repo = await request(api, code);
      if (repo.private !== true || repo.full_name?.toLowerCase() !== fullName) {
        throw new SyncError("format", "专用仓库必须保持私有，云端同步已暂停。");
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await request(file, code);
        const cloud = decodeProgress(response, cleanRecords);
        const current = getRecords();
        const merged = merge(current, cloud);
        if (!sameRecords(merged, current)) applyRecords(merged);
        if (sameRecords(merged, cloud)) return;
        try {
          await request(file, code, {
            message: "Sync vocabulary progress", sha: response.sha, content: encodeProgress(merged)
          });
          return;
        } catch (error) {
          if (error.kind !== "conflict") throw error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      throw new SyncError("retry", "两台设备正在同时保存，稍后自动重试。");
    }

    async function run(code, connecting) {
      if (busy) return false;
      clearTimeout(timer);
      busy = true;
      pending = false;
      show(connecting ? "connecting" : "syncing");
      try {
        await exchange(code);
        let message = "";
        if (connecting) {
          token = code;
          paused = false;
          try { localStorage.setItem(storageKey, token); }
          catch { message = "当前浏览器无法记住授权，下次打开时需重新连接。"; }
        }
        transientFailures = 0;
        lastSync = Date.now();
        show(pending ? "queued" : "synced", message);
        return true;
      } catch (error) {
        if (error.kind === "access") {
          if (!connecting) clearToken();
          show("off", error.message);
        } else if (error.kind === "format") {
          paused = Boolean(token);
          show(paused ? "paused" : "off", error.message);
        } else {
          transientFailures++;
          show(token ? "queued" : "off", error.kind === "retry" ? error.message :
            "暂时无法连接 GitHub，本机进度已保留。");
        }
        return false;
      } finally {
        busy = false;
        if (token && !paused && status.phase === "queued") {
          queue(transientFailures ? Math.min(120000, 15000 * 2 ** (transientFailures - 1)) : 800);
        }
        onStatus();
      }
    }

    async function connect(value) {
      if (busy) return false;
      const code = value.trim();
      if (!tokenFormat.test(code)) {
        show("off", "请粘贴以 github_pat_ 开头的 GitHub 细粒度授权码。");
        return false;
      }
      return run(code, true);
    }

    function syncNow() {
      if (!token || busy || paused) return Promise.resolve(false);
      return run(token, false);
    }

    function changed() {
      if (busy) pending = true;
      if (!token || paused || busy) return;
      show("queued");
      queue();
    }

    function disconnect() {
      if (busy) return;
      clearTimeout(timer);
      clearToken();
      paused = false;
      lastSync = 0;
      show("off");
    }

    return {
      connect, syncNow, changed, disconnect,
      get connected() { return Boolean(token); },
      get busy() { return busy; },
      get status() { return status; }
    };
  }

  return {create, merge, recordKey, repository, tokenLink: String(tokenLink)};
})();
