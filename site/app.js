"use strict";

const $ = id => document.getElementById(id);
const names = {jiang: "蔣萬安", shen: "沈伯洋"};
const verdicts = {
  supported: "有證據支持", false: "具體主張有誤", misleading: "欠缺脈絡／具誤導性",
  opinion: "屬意見判斷", unresolved: "證據不足"
};
let state = {articles: [], feeds: {}};
let reviews = [];
let profiles = [];
let filtered = [];
let limit = 25;
let busy = false;
let selectedArticle = null;
let extrasOK = true;

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[char]);
}

function safeURL(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function dateText(value) {
  if (!value) return "尚無成功紀錄";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日期無效" : date.toLocaleString("zh-TW", {timeZone: "Asia/Taipei"});
}

function taipeiDay(value) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}

function articleReviews(article, currentOnly = true) {
  return reviews.filter(review => review.article_id === article.id && review.status === "published" &&
    (!currentOnly || review.fingerprint === article.fingerprint));
}

function linkHTML(value, label) {
  const url = safeURL(value);
  return url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)} ↗</a>` : "";
}

function download(filename, content, type) {
  const objectURL = URL.createObjectURL(new Blob([content], {type}));
  const anchor = document.createElement("a");
  anchor.href = objectURL;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}

function renderProfiles() {
  $("profile-list").innerHTML = ["jiang", "shen"].map(id => {
    const person = profiles.find(row => row.id === id);
    const facts = person?.facts || [];
    const content = facts.length ? facts.map(fact => `
      <div class="evidence"><strong>${escapeHTML(fact.label)}</strong>
        <p>${escapeHTML(fact.value)}</p>
        <p class="tiny muted">${escapeHTML(fact.reviewer)} · ${escapeHTML(dateText(fact.reviewed_at))}</p>
        ${(fact.evidence || []).map(url => linkHTML(url, "查核來源")).join("")}
      </div>`).join("") : `<p class="small muted space-top">尚未加入經維護者核對的背景條目。不預填未查證履歷；空白不代表沒有相關經歷。</p>`;
    return `<article class="box"><h3>${names[id]}</h3>${content}</article>`;
  }).join("");
}

function renderAnalysis() {
  const counts = new Map();
  for (const article of filtered) counts.set(article.source, (counts.get(article.source) || 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(row => row[1]));
  $("sources").innerHTML = entries.slice(0, 10).map(([name, count]) => `
    <div class="bar-row"><span>${escapeHTML(name)}</span><div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${count / max * 100}%"></div></div><span class="bar-value">${count}</span></div>`).join("") || `<p class="small muted space-top">目前沒有可統計資料。</p>`;

  const valid = filtered.flatMap(article => articleReviews(article).map(review => ({...review, article_id: article.id})));
  if (!extrasOK) {
    $("negative").textContent = "查核資料載入失敗，暫停顯示此統計。";
  } else if (!valid.length) {
    $("negative").textContent = "目前範圍尚無有效人工紀錄，不能估計。";
  } else {
    const count = direction => new Set(valid.filter(review => review.negative === true &&
      review.speaker_scope === "candidate" && review.direction === direction).map(review => review.article_id)).size;
    $("negative").textContent = `已複核範圍：蔣對沈 ${count("jiang_to_shen")} 篇；沈對蔣 ${count("shen_to_jiang")} 篇。這不是所有新聞或所有攻擊事件的總數。`;
  }
}

function render() {
  const query = $("query").value.trim().toLowerCase();
  const person = $("person").value;
  const source = $("source").value;
  const start = $("from").value;
  const end = $("to").value;
  const mode = $("review-filter").value;
  const invalid = Boolean(start && end && start > end);
  $("filter-error").hidden = !invalid;
  $("filter-error").textContent = invalid ? "開始日期不能晚於結束日期。" : "";

  filtered = invalid ? [] : state.articles.filter(article => {
    const current = articleReviews(article);
    const stale = articleReviews(article, false).some(review => review.fingerprint !== article.fingerprint);
    const text = [article.title, article.source, article.id].join(" ").toLowerCase();
    const date = taipeiDay(article.published_at);
    return (!query || text.includes(query)) &&
      (!person || (person === "both" ? article.people.length === 2 : article.people.includes(person))) &&
      (!source || article.source === source) && (!start || date >= start) && (!end || date <= end) &&
      (!mode || (mode === "reviewed" && current.length > 0) ||
        (mode === "pending" && current.length === 0) || (mode === "changed" && stale));
  });

  $("count").textContent = filtered.length;
  $("count-j").textContent = filtered.filter(a => a.people.includes("jiang")).length;
  $("count-s").textContent = filtered.filter(a => a.people.includes("shen")).length;
  $("count-r").textContent = extrasOK ? filtered.filter(a => articleReviews(a).length).length : "不可用";
  $("result-count").textContent = `顯示 ${Math.min(limit, filtered.length)}／${filtered.length} 篇；目前累積 ${state.articles.length} 篇。兩人人名計數可能重疊。`;
  $("more").hidden = filtered.length <= limit;
  $("export").disabled = filtered.length === 0;

  $("list").innerHTML = filtered.slice(0, limit).map(article => {
    const current = articleReviews(article);
    const stale = articleReviews(article, false).filter(review => review.fingerprint !== article.fingerprint);
    const historyCount = Array.isArray(article.history) ? article.history.length : 0;
    return `<article class="article box">
      <p class="tiny muted">${escapeHTML(article.source)} · ${escapeHTML(dateText(article.published_at))}</p>
      <h3>${escapeHTML(article.title)}</h3>
      <div class="badges">${article.people.map(id => `<span class="badge">標題提及 ${names[id]}</span>`).join("")}
        <span class="badge">${current.length ? `有效人工紀錄 ${current.length} 筆` : "尚未有效複核"}</span>
        ${stale.length ? `<span class="badge warning">過期紀錄 ${stale.length} 筆，不計目前統計</span>` : ""}</div>
      <div class="toolbar">${linkHTML(article.url, "閱讀來源／可能經 Google 轉址")}<button type="button" data-review="${escapeHTML(article.id)}">建立查核草稿</button></div>
      <details><summary>文章編號、版本與證據</summary><div class="evidence">
        <p>編號：<code>${escapeHTML(article.id)}</code></p>
        <p>首次收錄：${escapeHTML(dateText(article.first_seen_at))}</p>
        <p>最後見於 RSS：${escapeHTML(dateText(article.last_seen_at))}</p>
        <p>已記錄的舊中繼資料版本：${historyCount}</p>
        <p class="tiny muted">指紋只涵蓋 RSS 標題、媒體來源與發布時間，不是新聞全文指紋；內文改動可能無法偵測。</p>
        ${current.map(review => `<div class="evidence"><strong>人工判讀：${escapeHTML(verdicts[review.verdict] || review.verdict)}</strong>
          <p>主張：${escapeHTML(review.claim)}</p><p>理由：${escapeHTML(review.note)}</p>
          <p class="tiny muted">${escapeHTML(review.reviewer)} · ${escapeHTML(dateText(review.reviewed_at))}</p>
          ${(review.evidence || []).map(url => linkHTML(url, "查看證據")).join("")}</div>`).join("")}
        ${stale.length ? `<p class="small muted">舊版本查核保留於資料檔，但不套用至目前中繼資料。</p>` : ""}
      </div></details>
    </article>`;
  }).join("") || `<div class="empty"><h3>目前沒有符合條件的資料</h3><p class="small muted">請清除篩選或查看來源狀態。尚未收錄不等於沒有相關新聞。</p></div>`;
  renderAnalysis();
  renderProfiles();
}

async function getJSON(path) {
  const response = await fetch(`${path}?t=${Date.now()}`, {cache: "no-store"});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function validateNews(next) {
  if (next.version !== 1 || !Array.isArray(next.articles) || !next.feeds || typeof next.feeds !== "object") throw new Error("新聞資料格式錯誤");
  for (const article of next.articles) {
    if (!article.id || !article.title || !article.fingerprint || !Array.isArray(article.people) ||
        article.people.some(id => !Object.hasOwn(names, id)) || Number.isNaN(new Date(article.published_at).getTime())) {
      throw new Error("新聞紀錄格式錯誤");
    }
  }
}

function updateHealth() {
  const feeds = Object.values(state.feeds || {});
  if (!feeds.length) {
    $("health").textContent = "尚未完成第一次蒐集，沒有即時在線狀態可宣稱。";
    $("feed-health").textContent = "";
    return;
  }
  const stale = feeds.some(feed => !feed.last_success_at || Date.now() - new Date(feed.last_success_at).getTime() > 3600000);
  const gap = feeds.some(feed => Boolean(feed.coverage_gap));
  const labels = {ok: "回傳有效文章", ok_empty: "回應成功但未收錄文章", not_modified: "來源未變動", failed: "抓取失敗"};
  $("health").innerHTML = `最近嘗試：${escapeHTML(dateText(state.last_attempt_at))}。${state.status === "failed" ? "本次全部失敗，保留既有資料。" : state.status === "partial" ? "本次部分來源失敗。" : "本次來源請求成功。"}${stale ? " <span class=\"warning\">注意：至少一組來源超過 1 小時未成功。</span>" : ""}${gap ? " <span class=\"warning\">偵測到超過 7 天的來源中斷，期間文章可能漏收且未回補。</span>" : ""}${!extrasOK ? " <span class=\"warning\">人工查核或背景檔案載入失敗。</span>" : ""}`;
  $("feed-health").textContent = feeds.map(feed => `${feed.name}：${labels[feed.status] || feed.status}；上次成功 ${dateText(feed.last_success_at)}${feed.coverage_gap ? `；缺口自 ${dateText(feed.coverage_gap.from)}` : ""}`).join(" ｜ ");
}

async function load() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  try {
    const next = await getJSON("./data/news.json");
    validateNews(next);
    let nextReviews = [];
    let nextProfiles = [];
    extrasOK = true;
    try {
      const [reviewPayload, profilePayload] = await Promise.all([getJSON("./data/reviews.json"), getJSON("./data/profiles.json")]);
      if (!Array.isArray(reviewPayload.items) || !Array.isArray(profilePayload.people)) throw new Error("附加資料格式錯誤");
      nextReviews = reviewPayload.items;
      nextProfiles = profilePayload.people;
    } catch {
      extrasOK = false;
    }
    state = next;
    reviews = nextReviews;
    profiles = nextProfiles;
    const oldSource = $("source").value;
    const sources = [...new Set(state.articles.map(article => article.source))].sort();
    $("source").innerHTML = '<option value="">所有媒體</option>' + sources.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join("");
    if (sources.includes(oldSource)) $("source").value = oldSource;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(state.repository || "")) {
      $("runs").href = `https://github.com/${state.repository}/actions`;
      $("runs").hidden = false;
    }
    updateHealth();
    render();
  } catch (error) {
    $("health").textContent = `無法取得最新發布資料：${error.message}。若仍有畫面，內容可能已過期；不能視為追蹤正常。`;
    if (!state.articles.length) $("list").innerHTML = '<div class="empty"><h3>資料尚未載入</h3><p class="small muted">請以 HTTP 網址開啟並確認首次部署完成，不要直接開啟 HTML 檔。</p></div>';
  } finally {
    busy = false;
    $("refresh").disabled = false;
  }
}

function showTab(tab) {
  const tabs = ["news", "analysis", "profiles", "method"];
  const selected = tabs.includes(tab) ? tab : "news";
  for (const id of tabs) $(id).hidden = id !== selected;
  document.querySelectorAll("[data-tab]").forEach(link => {
    if (link.dataset.tab === selected) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

document.querySelectorAll("[data-tab]").forEach(link => link.addEventListener("click", () => showTab(link.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
["query", "person", "source", "from", "to", "review-filter"].forEach(id => $(id).addEventListener(id === "query" ? "input" : "change", () => {limit = 25; render();}));
$("reset").addEventListener("click", () => {for (const id of ["query", "person", "source", "from", "to", "review-filter"]) $(id).value = ""; limit = 25; render();});
$("more").addEventListener("click", () => {limit += 25; render();});
$("refresh").addEventListener("click", load);
$("export").addEventListener("click", () => {
  const cell = value => {let text = String(value ?? ""); if (/^[=+@\-\t\r]/.test(text)) text = "'" + text; return `"${text.replace(/"/g, '""')}"`;};
  const rows = [["文章編號", "標題", "媒體", "發布UTC", "首次收錄UTC", "標題人物", "來源連結", "RSS中繼資料指紋"], ...filtered.map(article => [article.id, article.title, article.source, article.published_at, article.first_seen_at, article.people.map(id => names[id]).join("、"), article.url, article.fingerprint])];
  download("taipei-news.csv", "\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
});
$("list").addEventListener("click", event => {
  const button = event.target.closest("[data-review]");
  if (!button) return;
  selectedArticle = state.articles.find(article => article.id === button.dataset.review);
  if (!selectedArticle) return;
  $("review-form").reset();
  $("review-title").textContent = selectedArticle.title;
  $("review-error").textContent = "";
  $("review-dialog").showModal();
});
$("close-dialog").addEventListener("click", () => $("review-dialog").close());
$("review-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!selectedArticle) return;
  const form = new FormData(event.currentTarget);
  const evidence = String(form.get("evidence")).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!evidence.length || evidence.some(url => !safeURL(url))) {$("review-error").textContent = "請提供有效的 HTTP 或 HTTPS 證據網址。"; return;}
  const item = {
    id: `review-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    article_id: selectedArticle.id, fingerprint: selectedArticle.fingerprint, status: "draft",
    claim: String(form.get("claim")).trim(), speaker_scope: String(form.get("speaker_scope")),
    direction: String(form.get("direction")), negative: form.get("negative") === "true",
    verdict: String(form.get("verdict")), note: String(form.get("note")).trim(), evidence,
    reviewer: String(form.get("reviewer")).trim(), reviewed_at: new Date().toISOString()
  };
  download(`review-${selectedArticle.id}.json`, JSON.stringify(item, null, 2) + "\n", "application/json;charset=utf-8");
  $("review-error").textContent = "草稿已產生；請加入 reviews.json 並複核後再發布。";
});

let theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.dataset.theme = theme;
$("theme").addEventListener("click", () => {theme = theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = theme;});
showTab(location.hash.slice(1));
load();
setInterval(() => {if (!document.hidden) load();}, 60000);
document.addEventListener("visibilitychange", () => {if (!document.hidden) load();});
