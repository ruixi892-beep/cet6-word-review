"use strict";
const dataset = window.CET6;
const view = document.querySelector("#view");
const key = "cet6-field-notes-v1";
const pageSize = 20;
const day = 86400000;
const gaps = [1, 3, 7, 14, 30, 60];
let tab = "", reveal = false, group = null, detail = null, result = "";
let filter = { query: "", level: "", status: "", page: 0 };
let noticeTimer;
let records = Object.create(null);
let syncClient;

function safe(text) {
  return String(text ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}
function notice(message) {
  const el = document.querySelector("#notice");
  el.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.textContent = ""; }, 3200);
}
function button(action, label, type = "", extra = "") {
  return '<button type="button" class="btn ' + type + '" data-action="' + action + '" ' + extra + '>' + label + '</button>';
}
function box(title, badge, content, className = "") {
  view.innerHTML = '<article class="card ' + className + '"><header class="card-head"><h2>' + title + '</h2>' +
    (badge ? '<span class="pill">' + badge + '</span>' : '') + '</header>' + content + '</article>';
}
function readRecords(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("invalid progress");
  const clean = Object.create(null);
  for (const [word, item] of Object.entries(raw)) {
    if (!byWord.has(word) || !item || !["known","saved"].includes(item.status) ||
        !Number.isFinite(item.updated) || !Number.isFinite(item.due) ||
        !Number.isInteger(item.stage) || item.stage < 0 || item.stage > gaps.length) continue;
    clean[word] = {status: item.status, updated: item.updated, due: item.due, stage: item.stage};
  }
  return clean;
}
function persist(fromCloud = false) {
  try { localStorage.setItem(key, JSON.stringify(records)); }
  catch { notice("当前浏览器无法保存进度，请导出备份。"); }
  if (!fromCloud) syncClient?.changed();
}

function receiveSyncedRecords(merged) {
  const previous = records;
  const previousCard = tab === "screen" ? screenWord()?.w : null;
  records = merged;
  persist(true);
  if (group?.words.some(({w}) => CET6Sync.recordKey(previous[w]) !== CET6Sync.recordKey(records[w]))) {
    group = null;
    reveal = false;
    result = "学习记录已更新，可以开始下一组。";
  }
  refreshStats();
  if (tab === "notes" || (tab === "screen" && previousCard === screenWord()?.w) ||
      (tab === "review" && group)) return;
  if (tab === "words" && !detail) { listRows(); return; }
  reveal = false;
  render();
}

function syncSettings() {
  if (!syncClient) return '<p>学习进度保存在当前浏览器。</p>';
  return '<section class="sync-settings" aria-labelledby="sync-heading">' +
    '<h3 id="sync-heading">跨设备同步</h3>' +
    '<p id="sync-status" role="status">未连接同步</p>' +
    '<form id="sync-connect" class="sync-connect" hidden>' +
      '<p>每台设备连接一次，之后打开网页就能接着背。首次连接会合并这台设备已有的进度。</p>' +
      '<p><a target="_blank" rel="noopener noreferrer" href="' + safe(CET6Sync.tokenLink) + '">打开 GitHub 生成细粒度授权码 ↗</a>。' +
      '在 Repository access 选 <strong>Only select repositories</strong>，只勾选 <strong>' +
      safe(CET6Sync.repository) + '</strong>，并确认 Contents 为 <strong>Read and write</strong>。</p>' +
      '<div class="sync-fields"><label for="sync-token">GitHub 授权码</label>' +
      '<input class="input" id="sync-token" type="password" maxlength="261" autocomplete="off" autocapitalize="none" spellcheck="false" required>' +
      '<button class="btn primary" type="submit">连接并同步</button></div>' +
      '<p class="muted">请把授权码填在这里。手机和电脑可以用同一串码连接。</p>' +
    '</form>' +
    '<div id="sync-actions" class="controls" hidden>' + button("sync-now", "立即同步", "quiet") +
      button("sync-disconnect", "解除本机连接", "quiet") + '</div></section>';
}

function renderSyncState() {
  if (!syncClient) return;
  const {phase, message, lastSync} = syncClient.status;
  const labels = {off: "未连接同步", connecting: "正在连接", syncing: "正在同步",
    queued: "待同步", synced: "已同步", paused: "同步暂停"};
  const summary = document.getElementById("sync-summary");
  if (summary) {
    summary.textContent = labels[phase];
    summary.dataset.phase = phase;
  }
  const status = document.getElementById("sync-status");
  if (!status) return;
  status.textContent = labels[phase] +
    (phase === "synced" && lastSync ? " · " + new Date(lastSync).toLocaleTimeString("zh-CN", {hour:"2-digit",minute:"2-digit"}) : "") +
    (message ? "。 " + message : "");
  const form = document.getElementById("sync-connect");
  form.hidden = syncClient.connected;
  for (const control of form.elements) control.disabled = syncClient.busy;
  const actions = document.getElementById("sync-actions");
  actions.hidden = !syncClient.connected;
  actions.querySelector('[data-action="sync-now"]').disabled = syncClient.busy || phase === "paused";
  actions.querySelector('[data-action="sync-disconnect"]').disabled = syncClient.busy;
}
function classify(word, status) {
  if (group?.words.some(w => w.w === word)) group = null;
  records[word] = { status, updated: Date.now(), due: status === "saved" ? Date.now() : 0, stage: 0 };
  persist();
}
function schedule(word, passed) {
  const item = records[word];
  const stage = passed ? Math.min(gaps.length, item.stage + 1) : 0;
  records[word] = { status: "saved", updated: Date.now(), stage,
    due: Date.now() + (passed ? gaps[stage - 1] * day : 10 * 60000) };
  persist();
}
function dueWords() {
  const now = Date.now();
  return words.filter(w => records[w.w]?.status === "saved" && records[w.w].due <= now)
    .sort((a, b) => records[a.w].due - records[b.w].due || a.rank - b.rank);
}
function counts() {
  const vals = Object.values(records);
  return { all: vals.length, known: vals.filter(x => x.status === "known").length,
    saved: vals.filter(x => x.status === "saved").length, due: dueWords().length };
}
function refreshStats() {
  const c = counts();
  for (const [id, value] of Object.entries({screened:c.all, known:c.known, saved:c.saved, due:c.due})) {
    document.getElementById(id).textContent = value.toLocaleString("zh-CN");
  }
}
function speak(text) {
  if (!("speechSynthesis" in window)) return notice("当前浏览器不支持发音。");
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = .9;
  const voice = speechSynthesis.getVoices().find(v => v.lang === "en-US" && v.localService);
  if (voice) utterance.voice = voice;
  utterance.onerror = e => { if (e.error !== "interrupted" && e.error !== "canceled") notice("发音暂不可用，请检查设备语音设置。"); };
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}
function term(w) {
  return '<h3 class="word" lang="en">' + safe(w.w) + '</h3><div class="term-meta">' +
    (w.ipa ? '<span lang="en">/' + safe(w.ipa) + '/</span>' : '') +
    '<span class="chip">' + safe(w.level) + '</span><span>真题出现 ' + w.n + ' 次 · ' + w.s.length + ' 场</span>' +
    button("say", "▶ 发音", "quiet") + '</div>';
}
function meaning(w) {
  return '<div class="meaning">' + safe(w.zh) + '</div>' +
    (w.collocation ? '<p class="muted">真题常见连用　<span lang="en">' + safe(w.collocation) + '</span></p>' : '');
}
function example(w, blank = false) {
  if (!w.ex) return "";
  const parts = [w.ex.text.slice(0,w.ex.start),w.ex.text.slice(w.ex.start,w.ex.end),w.ex.text.slice(w.ex.end)];
  return '<div class="feature"><blockquote class="example" lang="en">' + safe(parts[0]) +
    '<mark>' + (blank ? '______' : safe(parts[1])) + '</mark>' + safe(parts[2]) + '</blockquote>' +
    (blank ? "" : '<div class="example-source">' +
    (w.ex.id ? '<a target="_blank" rel="noopener" href="https://tatoeba.org/en/sentences/show/' + Number(w.ex.id) +
    '">例句：' + safe(w.ex.author ? w.ex.author + " · " : "") + 'Tatoeba</a> · ' + safe(w.ex.license) : '学习例句') +
    '　' + button("say-example", "▶ 读例句", "quiet") + '</div>') + '</div>';
}
function screenWord() {
  return words.find(w => !records[w.w]);
}
function screen() {
  const w = screenWord(), done = counts().all;
  if (!w) {
    box("高频筛词", "完成", '<p class="section-gap">你已经筛完词库，可以开始复习生词。</p><div class="controls"><a class="btn primary" href="#review">前往今日复习</a></div>');
    return;
  }
  box("高频筛词", "词频排名 #" + w.rank, '<div class="progress" aria-hidden="true"><span style="width:' +
    (100 * done / words.length) + '%"></span></div><p class="muted">已筛 ' + done + ' / ' + words.length +
    '　·　先回想这个词的意思</p>' + term(w) +
    (reveal ? meaning(w) + example(w) : '') +
    '<div class="controls">' + button("known","会","primary") + button("save","不会 · 加入生词库","dark") +
    button("reveal", reveal ? "收起释义" : "查看释义","quiet") +
    '</div><p class="shortcut"><kbd>1</kbd> 会　<kbd>2</kbd> 不会　<kbd>空格</kbd> 查看释义</p>');
}
function startReview() {
  const next = dueWords().slice(0, 6);
  if (!next.length) return;
  result = "";
  group = {words: next, phase: "recall", index: 0, recall: [], feedback: null, correct: 0};
  reveal = false;
  render();
}
function review() {
  if (!group) {
    const c = counts();
    const next = words.filter(w => records[w.w]?.status === "saved").map(w => records[w.w].due)
      .filter(t => t > Date.now()).sort((a,b) => a-b)[0];
    box("今日复习", c.due + " 词待复习",
      '<p class="section-gap">' + (result || (c.due ? "每组最多 6 个词。先读例句回想词义，随后做一组拼写。" :
        c.saved ? "当前到期的生词已复习完。" : "筛词时点「不会」，该词就会出现在这里。")) + '</p>' +
      (!c.due && next ? '<p class="muted">下次复习：' + safe(new Date(next).toLocaleString("zh-CN", {dateStyle:"medium",timeStyle:"short"})) + '</p>' : '') +
      '<div class="controls">' + (c.due ? button("start", "开始一组", "primary") :
        '<a class="btn primary" href="#screen">继续筛词</a>') + '</div>');
    return;
  }
  const w = group.words[group.index];
  const badge = (group.index + 1) + " / " + group.words.length;
  if (group.phase === "recall") {
    box("语境回想", badge, term(w) + example(w) +
      '<p class="muted section-gap">' + (w.ex ? '在这个语境里，单词是什么意思？' : '先回想这个词的常用意思。') + '</p>' +
      (reveal ? meaning(w) : '') + '<div class="controls">' +
      (reveal ? button("recall-yes","想起来了","primary") + button("recall-no","没想起来","dark") :
        button("reveal","揭晓释义","primary")) + '</div>');
    return;
  }
  const feedback = group.feedback;
  box("拼写测试", badge, '<p class="meaning">' + safe(w.zh) + '</p>' + example(w, true) +
    (feedback ? '<p class="feedback ' + (feedback.correct ? '' : 'wrong') + '">' +
      (feedback.correct ? '拼写正确：' : '正确拼写：') + '<strong lang="en">' + safe(w.w) + '</strong></p>' +
      '<div class="controls">' + button("next", group.index + 1 === group.words.length ? "查看本组结果" : "下一个词","primary") + '</div>' :
      '<form class="spelling" id="spelling"><label class="sr" for="answer">英文拼写</label>' +
      '<input class="input" id="answer" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="输入英文单词" required>' +
      '<button class="btn primary" type="submit">检查拼写</button>' + button("skip","记不起来","quiet") + '</form>'));
}
function settle(correct) {
  if (!group || group.phase !== "spell" || group.feedback) return;
  const w = group.words[group.index];
  const passed = correct && group.recall[group.index];
  if (passed) group.correct++;
  schedule(w.w, passed);
  group.feedback = {correct};
  render("next");
}
function matches() {
  const q = filter.query.trim().toLowerCase();
  return words.filter(w => (!q || w.w.includes(q) || w.zh.includes(q)) &&
    (!filter.level || w.level === filter.level) &&
    (!filter.status || (records[w.w]?.status ?? "new") === filter.status));
}
function listRows() {
  const filtered = matches(), start = filter.page * pageSize;
  const selected = filtered.slice(start,start+pageSize);
  document.querySelector("#entries").innerHTML = selected.length ?
    selected.map(w => '<li><button type="button" data-action="open" data-word="' + safe(w.w) +
      '"><small>#' + w.rank + '</small><b lang="en">' + safe(w.w) + '</b><span class="badges"><small>' + w.n +
      ' 次</small> <span class="chip">' + safe(w.level) + '</span>' + (records[w.w]?.status === "saved" ? '<span class="chip">生词</span>' : '') +
      '</span></button></li>').join("") : '<li><p class="section-gap muted">没有符合条件的词。</p></li>';
  document.querySelector("#pager").innerHTML = button("prev-page","上一页","quiet",start ? "" : "disabled") +
    '<small>' + (selected.length ? start+1 : 0) + '–' + (start+selected.length) + ' / ' + filtered.length + '</small>' +
    button("next-page","下一页","quiet",start+pageSize < filtered.length ? "" : "disabled");
}
function library() {
  if (detail) {
    const w = byWord.get(detail);
    const item = records[w.w];
    box("词条", "词频排名 #" + w.rank, term(w) + meaning(w) + example(w) +
      '<p class="muted section-gap">收录考期：' + w.s.join("、") + '</p>' +
      (item?.status === "saved" ? '<p class="muted">下次复习：' + safe(new Date(item.due).toLocaleString("zh-CN")) + '</p>' : '') +
      '<div class="controls">' + button("list","返回词库","quiet") + button("known","标为已掌握","primary") +
      button("save","加入生词库","dark",item?.status === "saved" ? "disabled" : "") + '</div>');
    return;
  }
  const option = (v, name, current) => '<option value="' + v + '"' + (v === current ? " selected" : "") + '>' + name + '</option>';
  box("查词", "按真题词频排序", '<div class="tools"><label class="sr" for="query">查找单词</label>' +
    '<input class="input" id="query" placeholder="输入英文或中文" type="search" value="' + safe(filter.query) + '">' +
    '<label class="sr" for="level">词汇级别</label><select class="input" id="level">' + option("","全部级别",filter.level) +
    ["高考","四级","六级"].map(x => option(x,x,filter.level)).join("") + '</select>' +
    '<label class="sr" for="status">学习状态</label><select class="input" id="status">' +
    [["","全部状态"],["saved","生词库"],["known","已掌握"],["new","未筛词"]].map(([v,n])=>option(v,n,filter.status)).join("") +
    '</select></div><ol class="entries" id="entries"></ol><div class="pager" id="pager"></div>');
  listRows();
}
function notes() {
  const meta = dataset.meta;
  box("资料与进度", "", syncSettings() + '<h3>词库统计</h3><p>词库统计来自已核验的 ' + meta.paperCount + ' 份六级试卷，覆盖 ' +
    meta.sessions.length + ' 个考期。收录试卷数、缺卷和听力情况见桌面资料包的清单。</p>' +
    '<p>参与统计的考期：' + meta.sessions.join("、") + '。</p>' +
    '<p>计入可提取的题干、选项和阅读材料（含已识别扫描页），合并常见词形，跳过答题说明与重复材料。听力词频仅包含卷面可读文字。' +
    '词汇级别和中文释义来自 <a href="https://github.com/skywind3000/ECDICT">ECDICT</a>，是备考标签。</p>' +
    '<p>有例句的词条：' + words.filter(w => w.ex).length.toLocaleString("zh-CN") + ' / ' + words.length.toLocaleString("zh-CN") + '。学习例句来自 <a href="https://tatoeba.org/en/terms_of_use">Tatoeba</a> 或本页自编。' +
    'Tatoeba 例句按卡片标注的 <a href="https://creativecommons.org/licenses/by/2.0/fr/">CC BY 2.0 FR</a> 或 <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a> 使用。</p>' +
    '<h3>手动备份</h3><p>需要留存备份时可以导出。导入会保留每个词时间较新的记录。</p>' +
    '<div class="controls">' + button("export","导出进度","primary") +
    '<label class="btn quiet" for="restore" tabindex="0">导入进度</label><input class="sr" id="restore" type="file" accept=".json,application/json"></div>' +
    '<p><a href="./ECDICT-LICENSE.txt">ECDICT 许可</a> · <a href="./coverage.json">语料统计明细</a></p>', "support");
  renderSyncState();
}
function render(focus) {
  refreshStats();
  for (const link of document.querySelectorAll("[data-tab]")) {
    if (link.dataset.tab === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  ({screen, review, words:library, notes})[tab]();
  if (focus === "answer") document.querySelector("#answer")?.focus();
  else if (focus) view.querySelector('[data-action="' + focus + '"]')?.focus();
}
function navigate() {
  const page = location.hash.slice(1);
  const next = ["screen","review","words","notes"].includes(page) ? page : "screen";
  if (next !== tab) {
    tab = next;
    reveal = false;
    detail = null;
  }
  render();
}
function current() {
  return tab === "screen" ? screenWord() : tab === "review" ? group?.words[group.index] : byWord.get(detail);
}
function exportProgress() {
  const blob = new Blob([JSON.stringify({version:1,records},null,2)],{type:"application/json"});
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = "cet6-progress.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(href),1000);
}
if (!dataset?.words.length) {
  box("暂时无法读取词库", "", '<p class="section-gap">请重新加载页面。</p>');
} else {
  initialize();
}
var words, byWord;
function initialize() {
  words = dataset.words.map((word,index) => ({...word,rank:index+1}));
  byWord = new Map(words.map(w => [w.w,w]));
  try {
    const stored = localStorage.getItem(key);
    if (stored) records = readRecords(JSON.parse(stored));
  } catch { notice("暂时无法读取浏览器进度。"); }
  if (window.CET6Sync) {
    syncClient = CET6Sync.create({getRecords: () => records, applyRecords: receiveSyncedRecords,
      cleanRecords: readRecords, onStatus: renderSyncState});
    const syncOnReturn = () => { if (!document.hidden) void syncClient.syncNow(); };
    window.addEventListener("focus", syncOnReturn);
    window.addEventListener("online", syncOnReturn);
    document.addEventListener("visibilitychange", syncOnReturn);
    setInterval(syncOnReturn, 45000);
  }
  document.getElementById("coverage").textContent = "真题语料 " + dataset.meta.sessions.length +
    " 个考期 · " + dataset.meta.paperCount + " 份试卷 · " + words.length.toLocaleString("zh-CN") + " 个备考词";
  navigate();
  renderSyncState();
  void syncClient?.syncNow();
  window.addEventListener("hashchange",navigate);
  view.addEventListener("click",e => {
    const button = e.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action, w = current();
    if (action === "known" || action === "save") {
      if (!w) return;
      classify(w.w,action === "known" ? "known" : "saved");
      notice(action === "known" ? "已掌握 · " + w.w : "已加入生词库 · " + w.w);
      reveal = false;
      render(tab === "screen" ? action : undefined);
    } else if (action === "reveal") { reveal = !reveal; render(tab === "review" ? "recall-yes" : "reveal"); }
    else if (action === "say" && w) speak(w.w);
    else if (action === "say-example" && w?.ex) speak(w.ex.text);
    else if (action === "start") startReview();
    else if (action.startsWith("recall-") && group?.phase === "recall") {
      group.recall.push(action === "recall-yes");
      group.index++;
      if (group.index === group.words.length) { group.index = 0; group.phase = "spell"; }
      reveal = false;
      render(group.phase === "spell" ? "answer" : "reveal");
    } else if (action === "skip") settle(false);
    else if (action === "next" && group?.feedback) {
      group.index++;
      group.feedback = null;
      if (group.index === group.words.length) {
        result = "本组完成。词义和拼写都答对 " + group.correct + " / " + group.words.length + " 个。";
        group = null;
      }
      render(group ? "answer" : undefined);
    } else if (action === "open") { detail = button.dataset.word; render("list"); }
    else if (action === "list") { detail = null; render(); document.querySelector("#query")?.focus(); }
    else if (action.endsWith("-page")) { filter.page += action === "prev-page" ? -1 : 1; listRows(); }
    else if (action === "export") exportProgress();
    else if (action === "sync-now") void syncClient.syncNow();
    else if (action === "sync-disconnect") syncClient.disconnect();
  });
  view.addEventListener("submit", async e => {
    if (e.target.id === "sync-connect") {
      e.preventDefault();
      const input = e.target.querySelector("#sync-token");
      if (await syncClient.connect(input.value)) input.value = "";
      return;
    }
    if (e.target.id !== "spelling") return;
    e.preventDefault();
    settle(document.querySelector("#answer").value.trim().toLowerCase() === current()?.w);
  });
  view.addEventListener("input",e => {
    if (e.target.id === "query") { filter.query = e.target.value; filter.page = 0; listRows(); }
  });
  view.addEventListener("change", async e => {
    if (["level","status"].includes(e.target.id)) {
      filter[e.target.id] = e.target.value;
      filter.page = 0;
      listRows();
    }
    if (e.target.id !== "restore" || !e.target.files?.[0]) return;
    try {
      const file = e.target.files[0];
      if (file.size > 3000000) throw Error("file too large");
      const data = JSON.parse(await file.text());
      if (data.version !== 1) throw Error("invalid version");
      let merged = 0;
      for (const [word,item] of Object.entries(readRecords(data.records))) {
        if ((records[word]?.updated ?? 0) < item.updated) { records[word] = item; merged++; }
      }
      group = null;
      persist();
      render();
      notice("已导入 " + merged + " 条更新。");
    } catch { notice("无法导入，请选择本站导出的进度文件。"); }
    finally { e.target.value = ""; }
  });
  document.addEventListener("keydown",e => {
    if (e.target.matches("label[for='restore']") && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault(); document.getElementById("restore").click(); return;
    }
    if (tab !== "screen" || e.repeat || e.altKey || e.ctrlKey || e.metaKey || (e.target.closest("input,select,textarea") || (e.key === " " && e.target.closest("button,a")))) return;
    const action = {"1":"known","2":"save"," ":"reveal"}[e.key];
    if (action) { e.preventDefault(); view.querySelector('[data-action="' + action + '"]')?.click(); }
  });
  setInterval(() => {
    refreshStats();
    if (tab === "review" && !group) review();
  },60000);
}
