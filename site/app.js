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
let events = [];
let filtered = [];
let limit = 25;
let busy = false;
let selectedArticle = null;
let extrasOK = true;
let extrasError = "";
let newsError = "";
let lastLoadedAt = null;

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

function validClaims(articles = state.articles) {
  return articles.flatMap(article => articleReviews(article).map(review => ({article, review})));
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

function renderOverview() {
  const articles = state.articles;
  const recent = articles.filter(article => {
    const added = new Date(article.first_seen_at).getTime();
    return Number.isFinite(added) && Date.now() - added >= 0 && Date.now() - added <= 86400000;
  });
  $("overview-j").textContent = articles.filter(article => article.people.includes("jiang")).length;
  $("overview-s").textContent = articles.filter(article => article.people.includes("shen")).length;
  $("overview-new").textContent = recent.length;
  $("overview-claims").textContent = extrasOK ? validClaims().length : "不可用";
  $("overview-events").textContent = extrasOK ? events.length : "不可用";
  document.querySelector('[data-trace="claims"]').disabled = !extrasOK;
  document.querySelector('[data-trace="events"]').disabled = !extrasOK;

  const latest = [...articles].sort((a, b) => new Date(b.published_at) - new Date(a.published_at)).slice(0, 5);
  $("latest-list").innerHTML = latest.map(article => `
    <article class="latest-item"><p class="tiny muted">${escapeHTML(article.source)} · ${escapeHTML(dateText(article.published_at))}</p>
      <h4>${escapeHTML(article.title)}</h4>${linkHTML(article.url, "閱讀來源")}</article>`).join("") ||
    `<p class="small muted">目前沒有已收錄文章。</p>`;
  $("confirmed-events").innerHTML = extrasOK && events.length ? events.map(event => `
    <article class="latest-item"><h4>${escapeHTML(event.title)}</h4><p>${escapeHTML(event.summary)}</p>
      <p class="tiny muted">人工確認：${escapeHTML(event.reviewer)} · ${escapeHTML(dateText(event.confirmed_at))}</p>
      ${eventReferences(event.article_ids)}
      ${(event.evidence || []).map(url => linkHTML(url, "事件證據來源")).join("")}
      ${event.revisions.length ? `<details><summary>修訂紀錄（${event.revisions.length}）</summary>${event.revisions.map(revision =>
        `<p class="tiny">${escapeHTML(revision.revised_at)} · ${escapeHTML(revision.reviewer)}：${escapeHTML(revision.note)}</p>
          ${(revision.evidence || []).map(url => linkHTML(url, "修訂佐證")).join("")}`).join("")}</details>` : ""}
    </article>`).join("") : `<p class="small muted">${extrasOK ? "尚無人工確認事件；自動收錄或分群不會計入。" : "事件資料載入失敗，暫停顯示。"}</p>`;
}

function filterDescription() {
  const details = [
    $("query").value.trim() ? `搜尋「${$("query").value.trim()}」` : "",
    $("person").value ? `人物：${$("person").selectedOptions[0].textContent}` : "",
    $("source").value ? `媒體：${$("source").value}` : "",
    $("from").value ? `開始日期：${$("from").value}` : "",
    $("to").value ? `結束日期：${$("to").value}` : "",
    $("review-filter").value ? `查核篩選：${$("review-filter").selectedOptions[0].textContent}` : ""
  ].filter(Boolean);
  return details.length ? details.join("；") : "新聞資料桌未設定篩選；使用全部目前保留的文章。";
}

function traceArticle(article) {
  return `<article class="trace-item"><p class="tiny muted">${escapeHTML(article.source)} · ${escapeHTML(dateText(article.published_at))}</p>
    <h3>${escapeHTML(article.title)}</h3><p class="tiny muted">文章 ID：<code>${escapeHTML(article.id)}</code> · 首次收錄：${escapeHTML(dateText(article.first_seen_at))}</p>
    ${linkHTML(article.url, "原始新聞來源")}</article>`;
}

function traceClaim({article, review}) {
  return `<article class="trace-item"><p class="tiny muted">${escapeHTML(article.source)} · ${escapeHTML(dateText(article.published_at))}</p>
    <h3>${escapeHTML(review.claim)}</h3><p>${escapeHTML(review.note)}</p>
    <p class="tiny muted">${escapeHTML(review.reviewer)} · ${escapeHTML(dateText(review.reviewed_at))} · ${escapeHTML(verdicts[review.verdict] || review.verdict)}</p>
    <p class="tiny muted">文章：${escapeHTML(article.title)}（${escapeHTML(article.id)}）</p>
    ${(review.evidence || []).map(url => linkHTML(url, "查核證據來源")).join("")}</article>`;
}

function eventReferences(ids) {
  return ids.map(id => {
    const article = state.articles.find(row => row.id === id);
    return article ? `<p class="tiny muted">${escapeHTML(article.title)}（${escapeHTML(article.source)} · ${escapeHTML(id)}）${linkHTML(article.url, "文章來源")}</p>` :
      `<p class="tiny muted">文章 ID：${escapeHTML(id)}（目前不在保留資料中）</p>`;
  }).join("") || `<p class="tiny muted">未連結文章 ID</p>`;
}

function openTrace(type) {
  const definitions = {
    jiang: ["標題提及蔣萬安的文章", "目前保留的 RSS 文章中，people 欄位包含 jiang 的文章數；只依 RSS 標題標記，不代表事件或支持度。", state.articles.filter(article => article.people.includes("jiang")).map(traceArticle)],
    shen: ["標題提及沈伯洋的文章", "目前保留的 RSS 文章中，people 欄位包含 shen 的文章數；只依 RSS 標題標記，不代表事件或支持度。", state.articles.filter(article => article.people.includes("shen")).map(traceArticle)],
    recent: ["最近 24 小時新增文章", "依 first_seen_at 與目前時間相比，統計首次收錄時間在過去 24 小時內的文章；不是發布時間。", state.articles.filter(article => {
      const added = new Date(article.first_seen_at).getTime();
      return Number.isFinite(added) && Date.now() - added >= 0 && Date.now() - added <= 86400000;
    }).map(traceArticle)],
    claims: ["有效人工查核主張", "每筆目前有效的 published 查核紀錄代表一項具體主張；須連結目前保留文章且 fingerprint 相符。草稿、撤回紀錄及舊指紋不計。", validClaims().map(traceClaim)],
    events: ["人工確認事件", "只計 events.json 中由複核者明確確認、附有證據的事件紀錄。此數不從 RSS 文章、自動分群或查核主張推導。", events.map(event => `
      <article class="trace-item"><h3>${escapeHTML(event.title)}</h3><p>${escapeHTML(event.summary)}</p>
      <p class="tiny muted">確認者：${escapeHTML(event.reviewer)} · ${escapeHTML(dateText(event.confirmed_at))}</p>
      ${eventReferences(event.article_ids)}
      ${(event.evidence || []).map(url => linkHTML(url, "事件證據來源")).join("")}
      ${event.revisions.map(revision => `<p class="tiny muted">修訂 ${escapeHTML(dateText(revision.revised_at))} · ${escapeHTML(revision.reviewer)}：${escapeHTML(revision.note)}</p>
        ${(revision.evidence || []).map(url => linkHTML(url, "修訂佐證")).join("")}`).join("")}</article>`)],
    filtered: ["篩選後文章", "套用下方新聞資料桌篩選條件後的文章數。", filtered.map(traceArticle)],
    "filtered-jiang": ["篩選後提及蔣萬安的文章", "先套用新聞資料桌篩選條件，再計算 people 包含 jiang 的文章數。", filtered.filter(article => article.people.includes("jiang")).map(traceArticle)],
    "filtered-shen": ["篩選後提及沈伯洋的文章", "先套用新聞資料桌篩選條件，再計算 people 包含 shen 的文章數。", filtered.filter(article => article.people.includes("shen")).map(traceArticle)],
    "filtered-reviewed": ["篩選後有有效查核的文章", "先套用新聞資料桌篩選條件，再計算至少有一筆目前有效、已發布查核紀錄的文章數。", filtered.filter(article => articleReviews(article).length).map(traceArticle)]
  };
  if (type.startsWith("source:")) {
    const source = type.slice("source:".length);
    const articles = filtered.filter(article => article.source === source);
    definitions[type] = [`媒體：${source}`, "目前新聞資料桌篩選範圍內，來源名稱相符的 RSS 文章數。", articles.map(traceArticle)];
  }
  if (type.startsWith("analysis-negative:")) {
    const direction = type.slice("analysis-negative:".length);
    const matching = validClaims(filtered).filter(({review}) => review.negative === true &&
      review.speaker_scope === "candidate" && review.direction === direction);
    const grouped = new Map();
    for (const item of matching) {
      if (!grouped.has(item.article.id)) grouped.set(item.article.id, []);
      grouped.get(item.article.id).push(item);
    }
    definitions[type] = [direction === "jiang_to_shen" ? "蔣對沈的有效負面評論文章" : "沈對蔣的有效負面評論文章",
      "符合目前新聞資料桌篩選條件、由候選人本人發言、目前有效且標記為負面的人工查核紀錄；以不同文章去重計數。",
      [...grouped.values()].map(items => `<div class="trace-item">${traceArticle(items[0].article)}
        ${items.map(traceClaim).join("")}</div>`)];
  }
  const selected = definitions[type];
  if (!selected) return;
  $("trace-title").textContent = selected[0];
  $("trace-definition").textContent = selected[1];
  $("trace-filters").textContent = type.startsWith("filtered") || type.startsWith("source:") ||
    type.startsWith("analysis-") ? `計算條件：${filterDescription()}` : "計算範圍：全部目前保留資料；不套用新聞資料桌篩選。";
  $("trace-items").innerHTML = selected[2].join("") || `<p class="small muted">此數字目前沒有構成資料。</p>`;
  $("trace-dialog").showModal();
}

function renderAnalysis() {
  const counts = new Map();
  for (const article of filtered) counts.set(article.source, (counts.get(article.source) || 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(row => row[1]));
  $("sources").innerHTML = entries.slice(0, 10).map(([name, count]) => `
    <div class="bar-row"><span>${escapeHTML(name)}</span><div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${count / max * 100}%"></div></div><button class="bar-value" type="button" data-trace-source="${escapeHTML(name)}" aria-label="查看${escapeHTML(name)}的${count}篇文章">${count}</button></div>`).join("") || `<p class="small muted space-top">目前沒有可統計資料。</p>`;

  const valid = validClaims(filtered);
  if (!extrasOK) {
    $("negative").textContent = "查核資料載入失敗，暫停顯示此統計。";
  } else if (!valid.length) {
    $("negative").textContent = "目前範圍尚無有效人工紀錄，不能估計。";
  } else {
    const count = direction => new Set(valid.filter(({review}) => review.negative === true &&
      review.speaker_scope === "candidate" && review.direction === direction).map(item => item.article.id)).size;
    $("negative").innerHTML = `已複核範圍：蔣對沈 <button class="inline-stat" type="button" data-trace-negative="jiang_to_shen">${count("jiang_to_shen")}</button> 篇；沈對蔣 <button class="inline-stat" type="button" data-trace-negative="shen_to_jiang">${count("shen_to_jiang")}</button> 篇。這不是所有新聞或所有攻擊事件的總數。`;
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
  $("export-json").disabled = filtered.length === 0;

  $("list").innerHTML = filtered.slice(0, limit).map(article => {
    const current = articleReviews(article);
    const currentIds = new Set(current.map(review => review.id));
    const previous = reviews.filter(review => review.article_id === article.id &&
      ["published", "withdrawn"].includes(review.status) && !currentIds.has(review.id));
    const historyCount = Array.isArray(article.history) ? article.history.length : 0;
    return `<article class="article box">
      <p class="tiny muted">${escapeHTML(article.source)} · ${escapeHTML(dateText(article.published_at))}</p>
      <h3>${escapeHTML(article.title)}</h3>
      <div class="badges">${article.people.map(id => `<span class="badge">標題提及 ${names[id]}</span>`).join("")}
        <span class="badge">${current.length ? `有效人工紀錄 ${current.length} 筆` : "尚未有效複核"}</span>
        ${previous.length ? `<span class="badge warning">舊版／撤回查核 ${previous.length} 筆，不計目前統計</span>` : ""}</div>
      <div class="toolbar">${linkHTML(article.url, "閱讀來源／可能經 Google 轉址")}<button type="button" data-review="${escapeHTML(article.id)}">建立查核草稿</button></div>
      <details><summary>文章編號、版本與證據</summary><div class="evidence">
        <p>編號：<code>${escapeHTML(article.id)}</code></p>
        <p>首次收錄：${escapeHTML(dateText(article.first_seen_at))}</p>
        <p>最後見於 RSS：${escapeHTML(dateText(article.last_seen_at))}</p>
        <p>已記錄的舊中繼資料版本：${historyCount}</p>
        ${(article.history || []).map(version => `<div class="evidence"><strong>舊文章中繼資料版本</strong>
          <p>${escapeHTML(version.title)}</p><p class="tiny muted">更換時間：${escapeHTML(dateText(version.replaced_at))}</p>
          <p class="tiny muted">指紋：<code>${escapeHTML(version.fingerprint)}</code></p></div>`).join("")}
        <p class="tiny muted">指紋只涵蓋 RSS 標題、媒體來源與發布時間，不是新聞全文指紋；內文改動可能無法偵測。</p>
        ${current.map(review => `<div class="evidence"><strong>人工判讀：${escapeHTML(verdicts[review.verdict] || review.verdict)}</strong>
          <p>主張：${escapeHTML(review.claim)}</p><p>理由：${escapeHTML(review.note)}</p>
          <p class="tiny muted">${escapeHTML(review.reviewer)} · ${escapeHTML(dateText(review.reviewed_at))}</p>
          ${(review.evidence || []).map(url => linkHTML(url, "查看證據")).join("")}</div>`).join("")}
        ${previous.map(review => `<div class="evidence"><strong>歷史查核紀錄${review.status === "withdrawn" ? "（已撤回）" : "（指紋已過期）"}</strong>
          <p>主張：${escapeHTML(review.claim)}</p><p>理由：${escapeHTML(review.note)}</p>
          <p class="tiny muted">${escapeHTML(review.reviewer)} · ${escapeHTML(dateText(review.reviewed_at))}</p>
          ${(review.evidence || []).map(url => linkHTML(url, "歷史查核證據")).join("")}</div>`).join("")}
      </div></details>
    </article>`;
  }).join("") || `<div class="empty"><h3>目前沒有符合條件的資料</h3><p class="small muted">請清除篩選或查看來源狀態。尚未收錄不等於沒有相關新聞。</p></div>`;
  renderAnalysis();
  renderProfiles();
  renderOverview();
}

async function getJSON(path) {
  const response = await fetch(`${path}?t=${Date.now()}`, {cache: "no-store"});
  if (!response.ok) throw new Error(`${path} 回應 HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${path} 不是有效的 JSON`);
  }
}

function validateNews(next) {
  if (next.version !== 1 || !Array.isArray(next.articles) || !next.feeds ||
      typeof next.feeds !== "object" || !["ok", "partial", "failed"].includes(next.status)) {
    throw new Error("新聞資料格式錯誤");
  }
  for (const article of next.articles) {
    if (!article.id || !article.title || !article.fingerprint || !Array.isArray(article.people) ||
        article.people.some(id => !Object.hasOwn(names, id)) ||
        Number.isNaN(new Date(article.published_at).getTime()) ||
        Number.isNaN(new Date(article.first_seen_at).getTime())) {
      throw new Error("新聞紀錄格式錯誤");
    }
  }
}

function updateHealth() {
  const feeds = Object.values(state.feeds || {});
  if (!feeds.length) {
    $("health-state").textContent = "狀態未知";
    $("health-state").dataset.status = "unknown";
    $("health").textContent = "尚未取得來源執行狀態，沒有即時在線狀態可宣稱。";
    $("feed-health").textContent = [newsError, extrasError].filter(Boolean).join("；");
    return;
  }
  const stale = feeds.some(feed => {
    const lastSuccess = new Date(feed.last_success_at).getTime();
    return !Number.isFinite(lastSuccess) || Date.now() - lastSuccess > 3600000;
  });
  const gap = feeds.some(feed => Boolean(feed.coverage_gap));
  const outcomes = {ok: "蒐集成功", partial: "部分失敗", failed: "全部失敗"};
  const outcome = outcomes[state.status] || "狀態未知";
  const healthLabel = stale ? `${outcome} · 資料過期` : outcome;
  $("health-state").textContent = healthLabel;
  $("health-state").dataset.status = stale ? "stale" : state.status;
  const labels = {ok: "回傳有效文章", ok_empty: "回應成功但未收錄文章", not_modified: "來源未變動", failed: "抓取失敗"};
  $("health").innerHTML = `最近嘗試：${escapeHTML(dateText(state.last_attempt_at))}。${state.status === "failed" ? "本次全部來源失敗，保留既有資料。" : state.status === "partial" ? "本次部分來源失敗。" : "本次來源請求成功。"}${stale ? " <span class=\"warning\">超過 1 小時未成功更新，資料已過期。</span>" : ""}${gap ? " <span class=\"warning\">偵測到超過 7 天的來源中斷，期間文章可能漏收且未回補。</span>" : ""}${newsError ? ` <span class="warning">最新資料重新讀取失敗：${escapeHTML(newsError)}。</span>` : ""}${extrasError ? ` <span class="warning">人工查核、事件或背景資料載入失敗：${escapeHTML(extrasError)}。</span>` : ""}${lastLoadedAt ? ` 上次成功讀取此頁資料：${escapeHTML(dateText(lastLoadedAt))}。` : ""}`;
  $("feed-health").textContent = feeds.map(feed => `${feed.name}：${labels[feed.status] || feed.status}；上次成功 ${dateText(feed.last_success_at)}${feed.coverage_gap ? `；缺口自 ${dateText(feed.coverage_gap.from)}` : ""}`).join(" ｜ ");
}

async function load() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  try {
    const next = await getJSON("./data/news.json");
    validateNews(next);
    state = next;
    newsError = "";
    lastLoadedAt = new Date().toISOString();
    const oldSource = $("source").value;
    try {
      const [reviewPayload, profilePayload, eventPayload] = await Promise.all([
        getJSON("./data/reviews.json"), getJSON("./data/profiles.json"), getJSON("./data/events.json")
      ]);
      if (reviewPayload.version !== 1 || !Array.isArray(reviewPayload.items) ||
          !Array.isArray(profilePayload.people) || eventPayload.version !== 1 ||
          !Array.isArray(eventPayload.items) ||
          reviewPayload.items.some(review => !review || typeof review.article_id !== "string" ||
            typeof review.status !== "string" || typeof review.fingerprint !== "string" ||
            typeof review.claim !== "string" || !Array.isArray(review.evidence)) ||
          profilePayload.people.some(person => !person || !Array.isArray(person.facts)) ||
          eventPayload.items.some(event => !event || typeof event.id !== "string" ||
            typeof event.title !== "string" || typeof event.summary !== "string" ||
            typeof event.reviewer !== "string" || !Array.isArray(event.article_ids) ||
            !Array.isArray(event.evidence) || !Array.isArray(event.revisions) ||
            Number.isNaN(new Date(event.confirmed_at).getTime()) ||
            event.revisions.some(revision => !revision || typeof revision.note !== "string" ||
              typeof revision.reviewer !== "string" ||
              Number.isNaN(new Date(revision.revised_at).getTime())))) {
        throw new Error("人工查核、背景或事件資料格式錯誤");
      }
      reviews = reviewPayload.items;
      profiles = profilePayload.people;
      events = eventPayload.items;
      extrasError = "";
      extrasOK = true;
    } catch (error) {
      extrasOK = false;
      extrasError = error.message;
    }
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
    newsError = error.message;
    updateHealth();
    if (!state.articles.length) $("list").innerHTML = '<div class="empty"><h3>資料尚未載入</h3><p class="small muted">請以 HTTP 網址開啟並確認首次部署完成，不要直接開啟 HTML 檔。</p></div>';
    else render();
  } finally {
    busy = false;
    $("refresh").disabled = false;
  }
}

function showTab(tab) {
  const tabs = ["overview", "news", "analysis", "profiles", "method"];
  const selected = tabs.includes(tab) ? tab : "overview";
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
  const rows = [["文章編號", "標題", "媒體", "發布UTC", "首次收錄UTC", "標題人物", "來源連結", "RSS中繼資料指紋", "查核紀錄JSON", "文章版本紀錄JSON"],
    ...filtered.map(article => [article.id, article.title, article.source, article.published_at, article.first_seen_at,
      article.people.map(id => names[id]).join("、"), article.url, article.fingerprint,
      JSON.stringify(reviews.filter(review => review.article_id === article.id && ["published", "withdrawn"].includes(review.status))),
      JSON.stringify(article.history || [])])];
  download("taipei-news.csv", "\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
});
$("export-json").addEventListener("click", () => {
  const selected = filtered.map(article => ({
    ...article,
    reviews: reviews.filter(review => review.article_id === article.id &&
      ["published", "withdrawn"].includes(review.status))
  }));
  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    filters: {
      query: $("query").value.trim(), person: $("person").value, source: $("source").value,
      from: $("from").value, to: $("to").value, review_status: $("review-filter").value
    },
    definitions: {
      articles: "符合目前新聞資料桌條件的 RSS 文章。",
      valid_claims: "只將目前 fingerprint 相符的 published 人工查核紀錄計為有效具體主張。",
      confirmed_events: "人工確認事件維護於 events.json，不從文章或自動分群推導。"
    },
    articles: selected,
    confirmed_events: extrasOK ? events : [],
    data_warning: extrasError || null
  };
  download("taipei-evidence.json", JSON.stringify(payload, null, 2) + "\n", "application/json;charset=utf-8");
});
document.addEventListener("click", event => {
  const trace = event.target.closest("[data-trace]");
  if (trace) {
    openTrace(trace.dataset.trace);
    return;
  }
  const source = event.target.closest("[data-trace-source]");
  if (source) {
    openTrace(`source:${source.dataset.traceSource}`);
    return;
  }
  const negative = event.target.closest("[data-trace-negative]");
  if (negative) openTrace(`analysis-negative:${negative.dataset.traceNegative}`);
});
$("close-trace").addEventListener("click", () => $("trace-dialog").close());
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
