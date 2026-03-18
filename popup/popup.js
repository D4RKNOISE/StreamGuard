let popupState = null;
let monitorInterval = null;

const refreshBtn = document.getElementById("refreshBtn");
const favoritesOnlyInput = document.getElementById("favoritesOnly");
const searchInput = document.getElementById("searchInput");
const injectModulesBtn = document.getElementById("injectModulesBtn");
const copyCurrentPromptBtn = document.getElementById("copyCurrentPromptBtn");
const addLocalDomainBtn = document.getElementById("addLocalDomainBtn");
const suggestCurrentSiteBtn = document.getElementById("suggestCurrentSiteBtn");
const toggleSuggestPanelBtn = document.getElementById("toggleSuggestPanelBtn");
const suggestPanel = document.getElementById("suggestPanel");

refreshBtn.addEventListener("click", async () => {
  const res = await sendMessage({ type: "streamguard:refreshRemoteCache" });
  setLocalMessage(res.ok
    ? { type: "success", title: "Remote data refreshed", body: `${res.count} rows loaded from the live database.` }
    : { type: "error", title: "Refresh failed", body: res.message || "The remote cache could not be refreshed." });
  await loadData();
});

favoritesOnlyInput.addEventListener("change", () => {
  renderGroups();
  renderReviewQueue();
});
searchInput.addEventListener("input", () => {
  renderGroups();
  renderReviewQueue();
  renderSuggestions();
});

toggleSuggestPanelBtn.addEventListener("click", () => {
  suggestPanel.classList.toggle("hidden");
  if (!suggestPanel.classList.contains("hidden")) {
    document.getElementById("localDomainInput").focus();
  }
});

suggestCurrentSiteBtn.addEventListener("click", () => {
  const host = popupState?.currentTab?.hostname || "";
  suggestPanel.classList.remove("hidden");
  if (host) document.getElementById("localDomainInput").value = host;

  const current = popupState?.currentMatch;
  const input = document.getElementById("localGroupInput");
  if (current?.group_name && !input.value.trim()) input.value = current.group_name;

  document.getElementById("localDomainInput").focus();
  setLocalMessage({
    type: "info",
    title: "Current site ready",
    body: "The current hostname was copied into the suggestion form.",
    hint: "When you submit it, StreamGuard will send it to the remote review sheet and also keep a local note in the popup."
  });
});

injectModulesBtn.addEventListener("click", async () => {
  const res = await sendMessage({ type: "streamguard:injectModulesForCurrentTab" });
  if (!res.ok) {
    setLocalMessage({
      type: res.updateRequired ? "info" : "error",
      title: res.updateRequired ? "Update required" : "Module inject failed",
      body: res.message || "This site cannot run modules right now.",
      hint: res.updateRequired ? "Open the GitHub repository, update your local extension files, and reload StreamGuard in Chrome." : ""
    });
    return;
  }

  const failed = (res.results || []).filter((x) => !x.ok);
  if (failed.length === (res.results || []).length) {
    setLocalMessage({ type: "error", title: "No module files injected", body: `Nothing could be injected for ${res.slug}.` });
    return;
  }

  setLocalMessage({ type: "success", title: "Site modules started", body: `Modules were injected for ${res.match?.group_name || res.slug}.` });
});

copyCurrentPromptBtn.addEventListener("click", async () => {
  if (!popupState) return;
  await navigator.clipboard.writeText(buildCurrentPrompt());
  setLocalMessage({ type: "success", title: "GitHub prompt copied", body: "The support prompt is ready to paste into a GitHub issue or note." });
});

addLocalDomainBtn.addEventListener("click", async () => {
  const group_name = document.getElementById("localGroupInput").value.trim();
  const domain = document.getElementById("localDomainInput").value.trim();
  const submitted_note = document.getElementById("localNoteInput").value.trim();

  if (!domain) {
    setLocalMessage({ type: "error", title: "Domain required", body: "Enter a domain first before submitting a suggestion." });
    return;
  }

  const res = await sendMessage({
    type: "streamguard:addLocalDomain",
    group_name,
    domain,
    submitted_note,
    status: "suggested"
  });

  if (!res.ok) {
    const duplicate = res.duplicate;
    if (duplicate) {
      setLocalMessage({
        type: "error",
        title: "Suggestion already known",
        body: `${res.message} Existing match: ${duplicate.group_name || "Unknown group"} / ${duplicate.domain || "unknown domain"}.`
      });
    } else {
      setLocalMessage({
        type: "error",
        title: "Suggestion failed",
        body: res.message || "The domain could not be submitted.",
        hint: res.detail || "Check your Apps Script deployment settings and web app access."
      });
    }
    return;
  }

  setLocalMessage({
    type: "success",
    title: `Suggestion submitted for ${res.added?.group_name || "Suggested Site"}`,
    body: `${res.added?.domain || domain} was sent to the remote sheet and also added to your local suggestions list.`,
    hint: "No automatic features are enabled yet. The domain still needs developer review before support modules are added."
  });

  document.getElementById("localGroupInput").value = "";
  document.getElementById("localDomainInput").value = "";
  document.getElementById("localNoteInput").value = "";
  await loadData();
});

async function loadData() {
  const res = await sendMessage({ type: "streamguard:getPopupData" });
  if (!res.ok) {
    document.getElementById("currentStatus").textContent = "Failed to load remote data";
    document.getElementById("currentDetails").textContent = res.message || "";
    return;
  }

  popupState = res;
  renderCurrent();
  renderUpdatePanel();
  renderGroups();
  renderReviewQueue();
  renderSuggestions();
  renderMonitoring();
  startMonitoringPolling();
}

async function loadDataWithoutRestart() {
  const res = await sendMessage({ type: "streamguard:getPopupData" });
  if (!res.ok) return;
  popupState = res;
  renderCurrent();
  renderUpdatePanel();
  renderGroups();
  renderReviewQueue();
  renderSuggestions();
  renderMonitoring();
}

function startMonitoringPolling() {
  clearInterval(monitorInterval);
  monitorInterval = setInterval(loadDataWithoutRestart, 1500);
}

function getMissingSupportedRows() {
  if (!popupState || !Array.isArray(popupState.groups)) return [];
  const rows = [];
  popupState.groups.forEach((group) => {
    (group.rows || []).forEach((row) => {
      if (row.source === "remote" && String(row.status || "").toLowerCase() === "supported" && row.update_required) {
        rows.push({ ...row, group_slug: row.group_slug || group.slug || streamguardSlugFromGroup(row.group_name || group.groupName || "") });
      }
    });
  });
  rows.sort((a, b) => String(a.group_name || "").localeCompare(String(b.group_name || "")) || String(a.domain || "").localeCompare(String(b.domain || "")));
  return rows;
}

function renderUpdatePanel() {
  const panel = document.getElementById("updatePanel");
  const listEl = document.getElementById("updateList");
  const summaryEl = document.getElementById("updateSummary");
  const leadEl = document.getElementById("updateLead");
  if (!panel || !listEl || !summaryEl || !leadEl) return;

  const missingRows = getMissingSupportedRows();
  if (!missingRows.length) {
    panel.classList.add("hidden");
    listEl.innerHTML = "";
    summaryEl.textContent = "";
    return;
  }

  const grouped = new Map();
  missingRows.forEach((row) => {
    const slug = row.group_slug || streamguardSlugFromGroup(row.group_name || "");
    const key = slug || row.group_name || row.domain || "unknown";
    if (!grouped.has(key)) {
      grouped.set(key, {
        slug,
        title: row.group_name || slug || "Unknown group",
        rows: []
      });
    }
    grouped.get(key).rows.push(row);
  });

  const groups = Array.from(grouped.values()).sort((a, b) => String(a.title).localeCompare(String(b.title)));
  panel.classList.remove("hidden");
  summaryEl.textContent = `${missingRows.length} missing site${missingRows.length === 1 ? "" : "s"} · ${groups.length} group${groups.length === 1 ? "" : "s"}`;
  leadEl.textContent = "The database already knows these supported sites, but your installed StreamGuard version still needs a GitHub update to include their modules.";

  listEl.innerHTML = groups.map((group) => {
    const domainsHtml = group.rows
      .sort((a, b) => String(a.domain || "").localeCompare(String(b.domain || "")))
      .map((row) => `
        <div class="update-domain-row">
          <a class="domain-link" href="https://${escapeHtml(row.domain)}" target="_blank" rel="noreferrer">${escapeHtml(row.domain)}</a>
          <div class="link-row compact-link-row">
            ${badgeHtml("supported")}
            ${badgeHtml("update")}
          </div>
        </div>
      `).join("");

    return `
      <div class="update-card">
        <div class="update-title">${escapeHtml(group.title)}</div>
        <div class="update-sub">Module missing in this installed version: ${escapeHtml(group.slug || streamguardSlugFromGroup(group.title || ""))}</div>
        <div class="update-domain-list">${domainsHtml}</div>
        <div class="update-hint">Update StreamGuard from GitHub, reload the extension in Chrome, and then this group can use its support modules.</div>
      </div>
    `;
  }).join("");
}

function renderCurrent() {
  const statusEl = document.getElementById("currentStatus");
  const detailsEl = document.getElementById("currentDetails");
  const actionsEl = document.getElementById("currentActions");

  const current = popupState.currentMatch;
  const host = popupState.currentTab.hostname || "(unknown host)";
  const canRunModules = Boolean(current && current.source === "remote" && String(current.status || "").toLowerCase() === "supported" && current.module_available);

  injectModulesBtn.classList.toggle("hidden", !canRunModules);

  if (!current) {
    statusEl.textContent = "Current domain not in database";
    detailsEl.innerHTML = `Host: <a class="domain-link" href="${escapeAttr(buildSiteUrl(host))}" target="_blank" rel="noreferrer">${escapeHtml(host)}</a><div class="info-note">You can suggest it now for developer review and later support work.</div>`;
    actionsEl.classList.remove("hidden");
    return;
  }

  const badge = badgeHtml(current.status || "known");
  const sourceBadge = sourceBadgeHtml(current.source || "remote");
  statusEl.innerHTML = `Matched <b>${escapeHtml(current.group_name || "Unknown group")}</b> ${badge} ${sourceBadge}`;
  let details = `Host: <a class="domain-link" href="${escapeAttr(buildSiteUrl(host))}" target="_blank" rel="noreferrer">${escapeHtml(host)}</a><br>Domain: <a class="domain-link" href="${escapeAttr(buildSiteUrl(current.domain))}" target="_blank" rel="noreferrer">${escapeHtml(current.domain)}</a>`;

  if (current.status === "reviewing") {
    details += `<div class="info-note">This domain already exists and is currently under review.</div>`;
  }

  if (current.status === "suggested") {
    details += `<div class="info-note">This domain is in the review queue, but not supported yet.</div>`;
  }

  if (current.source === "local") {
    details += `<div class="info-note">This entry is your local submission record. Support modules are only added after developer review.</div>`;
  }

  if (current.status === "rejected") {
    details += `<div class="danger-note">This domain was rejected.${current.rejection_reason ? " Reason: " + escapeHtml(current.rejection_reason) : ""}</div>`;
  }

  if (current.review_note) details += `<div class="domain-meta">Review note: ${escapeHtml(current.review_note)}</div>`;
  if (current.submitted_note) details += `<div class="domain-meta">Submitted note: ${escapeHtml(current.submitted_note)}</div>`;

  if (current.status === "supported" && current.source === "remote") {
    if (current.update_required) {
      details += `<div class="warning-note">This domain is already supported in the remote database, but your current StreamGuard version does not include the <b>${escapeHtml(current.group_slug || streamguardSlugFromGroup(current.group_name || ""))}</b> module yet.</div>`;
      details += `<div class="github-note">Update required before features can run. <a href="${escapeHtml(popupState.githubUrl || STREAMGUARD_GITHUB_URL)}" target="_blank" rel="noreferrer">Open StreamGuard on GitHub</a></div>`;
    } else {
      details += `<div class="github-note">There is an update on GitHub… <a href="${escapeHtml(popupState.githubUrl || STREAMGUARD_GITHUB_URL)}" target="_blank" rel="noreferrer">Open StreamGuard on GitHub</a></div>`;
    }
  }

  detailsEl.innerHTML = details;
  actionsEl.classList.remove("hidden");
}

function renderGroups() {
  if (!popupState) return;

  const groupsEl = document.getElementById("groups");
  const summaryEl = document.getElementById("groupsSummary");
  groupsEl.innerHTML = "";

  const query = searchInput.value.trim().toLowerCase();
  const favoritesOnly = favoritesOnlyInput.checked;

  let groups = popupState.groups
    .map((group) => {
      const remoteRows = (group.rows || []).filter((row) => row.source !== "local" && row.status === "supported");
      return {
        ...group,
        rows: remoteRows,
        domains: remoteRows.map((row) => row.domain),
        counts: {
          supported: remoteRows.length,
          reviewing: 0,
          rejected: 0,
          suggested: 0,
          local: 0
        }
      };
    })
    .filter((group) => group.rows.length);

  groups.sort(sortGroups);
  groups = groups.filter((group) => filterGroup(group, query, favoritesOnly));

  const totalDomains = groups.reduce((sum, group) => sum + group.rows.length, 0);
  summaryEl.textContent = `${groups.length} groups · ${totalDomains} supported domains`;

  if (!groups.length) {
    groupsEl.innerHTML = `<div class="monitor-empty">No supported groups match the current filter.</div>`;
    return;
  }

  groups.forEach((group) => groupsEl.appendChild(buildGroupCard(group)));
}

function renderReviewQueue() {
  if (!popupState) return;

  const wrap = document.getElementById("reviewGroups");
  const summaryEl = document.getElementById("reviewSummary");
  const leadEl = document.getElementById("reviewLead");
  wrap.innerHTML = "";

  const query = searchInput.value.trim().toLowerCase();
  const favoritesOnly = favoritesOnlyInput.checked;

  let groups = popupState.groups
    .map((group) => {
      const reviewRows = (group.rows || []).filter((row) => row.source !== "local" && row.status !== "supported");
      return {
        ...group,
        rows: reviewRows,
        domains: reviewRows.map((row) => row.domain),
        counts: {
          supported: 0,
          reviewing: reviewRows.filter((row) => row.status === "reviewing").length,
          rejected: reviewRows.filter((row) => row.status === "rejected").length,
          suggested: reviewRows.filter((row) => row.status === "suggested").length,
          local: 0
        }
      };
    })
    .filter((group) => group.rows.length);

  groups.sort(sortGroups);
  groups = groups.filter((group) => filterGroup(group, query, favoritesOnly));

  const totalDomains = groups.reduce((sum, group) => sum + group.rows.length, 0);
  summaryEl.textContent = `${groups.length} groups · ${totalDomains} queued domains`;
  leadEl.textContent = groups.length
    ? "Suggested, reviewing, and rejected remote domains stay here until they are fully supported."
    : "Nothing is waiting in the remote review queue right now.";

  if (!groups.length) {
    wrap.innerHTML = `<div class="monitor-empty">No remote review items match the current filter.</div>`;
    return;
  }

  groups.forEach((group) => wrap.appendChild(buildReviewCard(group)));
}

function buildGroupCard(group) {
  const card = document.createElement("div");
  card.className = "group-card";

  const header = document.createElement("div");
  header.className = "group-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "group-title-wrap";
  titleWrap.innerHTML = `
    <div class="group-title">${escapeHtml(group.groupName)}</div>
    <div class="group-sub">${escapeHtml(group.slug)} · ${group.rows.length} supported domains${group.updateRequiredCount ? ` · ${escapeHtml(String(group.updateRequiredCount))} need update` : ""}${Number(group.favoriteScore || 0) ? ` · score ${escapeHtml(String(group.favoriteScore))}` : ""}</div>
  `;

  const counts = document.createElement("div");
  counts.className = "group-counts";
  appendCountBadge(counts, group.counts.supported, "supported");
  appendCountBadge(counts, group.updateRequiredCount, "update");
  titleWrap.appendChild(counts);

  const favoriteBtn = document.createElement("button");
  favoriteBtn.className = "favorite-btn";
  favoriteBtn.textContent = group.isFavorite ? "★" : "☆";
  favoriteBtn.title = "Toggle favorite";
  favoriteBtn.addEventListener("click", async () => {
    await sendMessage({ type: "streamguard:toggleFavorite", groupName: group.groupName });
    await loadDataWithoutRestart();
  });

  header.appendChild(titleWrap);
  header.appendChild(favoriteBtn);
  card.appendChild(header);

  group.rows.forEach((row) => card.appendChild(buildDomainRow(row)));
  return card;
}

function buildReviewCard(group) {
  const card = document.createElement("div");
  card.className = "review-card";

  const header = document.createElement("div");
  header.className = "review-header";
  header.innerHTML = `
    <div>
      <div class="review-title">${escapeHtml(group.groupName)}</div>
      <div class="review-sub">${escapeHtml(group.slug)} · ${group.rows.length} queued domains</div>
    </div>
  `;

  const counts = document.createElement("div");
  counts.className = "group-counts";
  appendCountBadge(counts, group.counts.reviewing, "reviewing");
  appendCountBadge(counts, group.counts.suggested, "suggested");
  appendCountBadge(counts, group.counts.rejected, "rejected");
  header.appendChild(counts);
  card.appendChild(header);

  group.rows.forEach((row) => card.appendChild(buildDomainRow(row)));
  return card;
}

function buildDomainRow(row) {
  const rowEl = document.createElement("div");
  rowEl.className = "domain-row";

  const left = document.createElement("div");
  left.className = "domain-main";
  left.innerHTML = `
    <div class="domain-name"><a class="domain-link" href="${escapeAttr(buildSiteUrl(row.domain))}" target="_blank" rel="noreferrer">${escapeHtml(row.domain)}</a></div>
    ${row.submitted_at ? `<div class="domain-meta">Added: ${escapeHtml(row.submitted_at)}</div>` : ""}
    ${row.submitted_note ? `<div class="domain-meta">Note: ${escapeHtml(row.submitted_note)}</div>` : ""}
    ${row.review_note ? `<div class="domain-meta">Review: ${escapeHtml(row.review_note)}</div>` : ""}
    ${row.rejection_reason ? `<div class="danger-note">Rejected: ${escapeHtml(row.rejection_reason)}</div>` : ""}
  `;

  const right = document.createElement("div");
  right.className = "row-right";
  right.innerHTML = `${badgeHtml(row.status || "known")}${row.update_required ? badgeHtml("update") : ""}${sourceBadgeHtml(row.source || "remote")}`;

  if (row.update_required) {
    const updateNote = document.createElement('div');
    updateNote.className = 'warning-note';
    updateNote.innerHTML = `Supported remotely, but this StreamGuard version does not include the <b>${escapeHtml(row.group_slug || streamguardSlugFromGroup(row.group_name || ""))}</b> module yet. Update from GitHub first.`;
    left.insertAdjacentElement('beforeend', updateNote);
  }

  rowEl.appendChild(left);
  rowEl.appendChild(right);
  return rowEl;
}

function renderSuggestions() {
  if (!popupState) return;

  const listEl = document.getElementById("suggestionsList");
  const summaryEl = document.getElementById("suggestionsSummary");
  const leadEl = document.getElementById("suggestionsLead");
  listEl.innerHTML = "";

  const query = searchInput.value.trim().toLowerCase();
  let suggestions = (popupState.userDomains || []).slice();

  suggestions.sort((a, b) => {
    const da = String(a.submitted_at || "");
    const db = String(b.submitted_at || "");
    return db.localeCompare(da) || String(a.domain || "").localeCompare(String(b.domain || ""));
  });

  suggestions = suggestions.filter((row) => {
    if (!query) return true;
    return [row.group_name, row.domain, row.status, row.submitted_note, row.review_note, row.rejection_reason, row.delivery_status]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  summaryEl.textContent = `${suggestions.length} submitted suggestion${suggestions.length === 1 ? "" : "s"}`;
  leadEl.textContent = suggestions.length
    ? "Submitted suggestions stay visible here while waiting for developer analysis."
    : "No submitted suggestions saved locally yet.";

  if (!suggestions.length) {
    listEl.innerHTML = `<div class="monitor-empty">Nothing to review here yet. Use “Suggest current site” or “Suggest new site...” above.</div>`;
    return;
  }

  suggestions.forEach((row) => {
    const card = document.createElement("div");
    card.className = "suggestion-card";

    const header = document.createElement("div");
    header.className = "suggestion-header";
    header.innerHTML = `
      <div>
        <div class="suggestion-title">${escapeHtml(row.group_name || streamguardGuessGroupNameFromDomain(row.domain || "suggested.site"))}</div>
        <div class="suggestion-sub"><a class="domain-link" href="${escapeAttr(buildSiteUrl(row.domain || ""))}" target="_blank" rel="noreferrer">${escapeHtml(row.domain || "")}</a></div>
      </div>
      <div class="row-right">${badgeHtml(row.status || "suggested")}${sourceBadgeHtml("local")}</div>
    `;

    const body = document.createElement("div");
    body.className = "suggestion-row";
    body.innerHTML = `
      <div class="domain-main">
        ${row.submitted_at ? `<div class="domain-meta">Saved: ${escapeHtml(row.submitted_at)}</div>` : ""}
        ${row.submitted_remote_at ? `<div class="domain-meta">Submitted to sheet: ${escapeHtml(row.submitted_remote_at)}</div>` : ""}
        ${row.delivery_status === "submitted" ? `<div class="domain-meta">Delivery: Submitted to remote sheet</div>` : ""}
        ${row.submitted_note ? `<div class="domain-meta">Note: ${escapeHtml(row.submitted_note)}</div>` : ""}
        ${row.review_note ? `<div class="domain-meta">Review: ${escapeHtml(row.review_note)}</div>` : ""}
        ${row.rejection_reason ? `<div class="danger-note">Rejected: ${escapeHtml(row.rejection_reason)}</div>` : `<div class="info-note">Submitted for review. No automatic features yet. This suggestion still needs developer analysis.</div>`}
      </div>
    `;

    const actions = document.createElement("div");
    actions.className = "domain-actions";
    const removeBtn = document.createElement("button");
    removeBtn.className = "mini-btn danger";
    removeBtn.textContent = "Remove from popup";
    removeBtn.addEventListener("click", async () => {
      const res = await sendMessage({ type: "streamguard:removeLocalDomain", domain: row.domain });
      setLocalMessage(res.ok
        ? { type: "success", title: "Suggestion removed", body: `${row.domain} was removed from your local popup list.` }
        : { type: "error", title: "Remove failed", body: res.message || "Failed to remove local suggestion." });
      if (res.ok) await loadDataWithoutRestart();
    });

    actions.appendChild(removeBtn);
    body.querySelector(".domain-main").appendChild(actions);
    card.appendChild(header);
    card.appendChild(body);
    listEl.appendChild(card);
  });
}

function renderMonitoring() {
  const badgeEl = document.getElementById("monitorStatusBadge");
  const statusEl = document.getElementById("monitorStatusText");
  const eventsEl = document.getElementById("monitorEvents");
  const monitoring = popupState?.monitoring || { active: false, events: [] };

  badgeEl.textContent = monitoring.active ? "Active" : "Idle";
  badgeEl.classList.toggle("active", Boolean(monitoring.active));
  statusEl.textContent = monitoring.active
    ? `Watching ${monitoring.hostname || popupState?.currentTab?.hostname || "active tab"} while the Developer Capture overlay stays open.`
    : "Open the Developer Capture overlay on the page to start live monitoring.";

  const events = Array.isArray(monitoring.events) ? monitoring.events : [];
  if (!events.length) {
    eventsEl.innerHTML = `<div class="monitor-empty">No live events yet. Open the Developer Capture overlay first, then try clicks, player actions, or popup traps.</div>`;
    return;
  }

  eventsEl.innerHTML = events.map((event) => `
    <div class="monitor-event">
      <div class="monitor-event-title">${escapeHtml(event.title || event.kind || "Event")}</div>
      <div class="monitor-event-meta">${escapeHtml(event.detail || "")}</div>
      <div class="monitor-event-meta">${formatTime(event.ts)}${event.tabId ? ` · tab ${escapeHtml(String(event.tabId))}` : ""}</div>
    </div>
  `).join("");
}

function sortGroups(a, b) {
  if (a.isFavorite && !b.isFavorite) return -1;
  if (!a.isFavorite && b.isFavorite) return 1;
  if (Number(b.favoriteScore || 0) !== Number(a.favoriteScore || 0)) {
    return Number(b.favoriteScore || 0) - Number(a.favoriteScore || 0);
  }
  return a.groupName.localeCompare(b.groupName);
}

function filterGroup(group, query, favoritesOnly) {
  if (favoritesOnly && !group.isFavorite) return false;
  if (!query) return true;
  const haystack = [
    group.groupName,
    ...group.domains,
    ...group.rows.map((r) => r.status || ""),
    ...group.rows.map((r) => r.source || "")
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function appendCountBadge(container, value, label) {
  if (!value) return;
  const el = document.createElement("span");
  el.className = `badge badge-${label}`;
  el.textContent = `${label} ${value}`;
  container.appendChild(el);
}

function buildCurrentPrompt() {
  const host = popupState?.currentTab?.hostname || "";
  const match = popupState?.currentMatch;
  return [
    "New streaming domain support request:",
    "",
    `Current host: ${host}`,
    `Matched group: ${match?.group_name || "none"}`,
    `Matched domain: ${match?.domain || "none"}`,
    `Current status: ${match?.status || "unknown"}`,
    `Current source: ${match?.source || "unknown"}`,
    match?.review_note ? `Review note: ${match.review_note}` : null,
    match?.rejection_reason ? `Rejection reason: ${match.rejection_reason}` : null,
    "",
    "Please help me:",
    "1. verify whether this domain should stay in the current group",
    "2. add or improve an adguard module",
    "3. add or improve a fillbrowserscreen module",
    "4. suggest any extra selectors or popup traps to target"
  ].filter(Boolean).join("\n");
}

function badgeHtml(status) {
  const s = String(status || "").toLowerCase();
  let cls = "badge-local";
  if (s === "supported") cls = "badge-supported";
  else if (s === "reviewing") cls = "badge-reviewing";
  else if (s === "rejected") cls = "badge-rejected";
  else if (s === "suggested") cls = "badge-suggested";
  else if (s === "update") cls = "badge-update";
  return `<span class="badge ${cls}">${escapeHtml(s || "known")}</span>`;
}

function sourceBadgeHtml(source) {
  const s = String(source || "remote").toLowerCase();
  return `<span class="badge badge-${s === "local" ? "local" : "remote"}">${escapeHtml(s)}</span>`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function buildSiteUrl(domainOrHost) {
  const value = String(domainOrHost || "").trim();
  if (!value) return "#";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setLocalMessage(message) {
  const el = document.getElementById("localMessage");
  if (!message) {
    el.innerHTML = "";
    el.className = "feedback-message hidden";
    return;
  }

  if (typeof message === "string") {
    el.textContent = message;
    el.className = "feedback-message";
    return;
  }

  const type = message.type || "info";
  const title = message.title ? `<div class="feedback-title">${escapeHtml(message.title)}</div>` : "";
  const body = message.body ? `<div class="feedback-sub">${escapeHtml(message.body)}</div>` : "";
  const hint = message.hint ? `<div class="feedback-hint">${escapeHtml(message.hint)}</div>` : "";

  el.innerHTML = `${title}${body}${hint}`;
  el.className = `feedback-message ${type}`;
}

function sendMessage(payload) {
  return chrome.runtime.sendMessage(payload);
}

loadData();
