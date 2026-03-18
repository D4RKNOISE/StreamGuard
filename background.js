importScripts("remote_config.js");

const FAVORITES_KEY = "streamguard_favorites_v1";
const USER_DOMAINS_KEY = "streamguard_user_domains_v1";

const popupMonitoring = {
  active: false,
  tabId: null,
  windowId: null,
  hostname: "",
  startedAt: 0,
  events: []
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get([FAVORITES_KEY, USER_DOMAINS_KEY], (result) => {
    const updates = {};
    if (!Array.isArray(result[FAVORITES_KEY])) updates[FAVORITES_KEY] = [];
    if (!Array.isArray(result[USER_DOMAINS_KEY])) updates[USER_DOMAINS_KEY] = [];
    if (Object.keys(updates).length) chrome.storage.sync.set(updates);
  });
});


async function startMonitoringForTab(tabId, hostname, reason = "Developer overlay opened") {
  if (!tabId) {
    return { ok: false, message: "No active tab to monitor." };
  }

  popupMonitoring.active = true;
  popupMonitoring.tabId = Number(tabId);
  popupMonitoring.windowId = null;
  popupMonitoring.hostname = String(hostname || "");
  popupMonitoring.startedAt = Date.now();
  popupMonitoring.events = [];

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "streamguard:setLiveMonitoring",
      enabled: true,
      startedAt: popupMonitoring.startedAt
    });
  } catch (e) {
  }

  addMonitoringEvent({
    kind: "session",
    title: reason,
    detail: hostname || "Active tab",
    tabId
  });

  return { ok: true, monitoring: getMonitoringState() };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "streamguard:getPopupData") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabUrl = tab?.url || "";
        const hostname = tabUrl ? new URL(tabUrl).hostname : "";

        const remoteRows = await streamguardFetchRemote(false);
        const syncData = await chrome.storage.sync.get([FAVORITES_KEY, USER_DOMAINS_KEY]);
        const favorites = syncData[FAVORITES_KEY] || [];
        const userDomains = syncData[USER_DOMAINS_KEY] || [];
        const combinedRows = streamguardBuildCombinedRows(remoteRows, userDomains);

        const groups = streamguardGroupRows(combinedRows).map((g) => ({
          ...g,
          slug: streamguardSlugFromGroup(g.groupName),
          moduleInfo: streamguardGetModuleInfo(g.groupName),
          isFavorite: favorites.includes(g.groupName)
        }));

        const current = streamguardFindByDomain(combinedRows, hostname);

        sendResponse({
          ok: true,
          apiUrl: STREAMGUARD_API_URL,
          githubUrl: STREAMGUARD_GITHUB_URL,
          currentTab: { url: tabUrl, hostname, id: tab?.id || null },
          currentMatch: current,
          groups,
          favorites,
          userDomains,
          monitoring: getMonitoringState()
        });
        return;
      }

      if (msg.type === "streamguard:startPopupMonitoring") {
        const tabId = Number(msg.tabId || 0);
        const hostname = String(msg.hostname || "");
        const res = await startMonitoringForTab(tabId, hostname, "Developer overlay monitoring started");
        sendResponse(res);
        return;
      }

      if (msg.type === "streamguard:stopPopupMonitoring") {
        await stopPopupMonitoring();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "streamguard:devOverlayState") {
        const tabId = sender?.tab?.id ? Number(sender.tab.id) : 0;
        const hostname = String(msg.hostname || sender?.tab?.url || "");

        if (msg.open) {
          const res = await startMonitoringForTab(tabId, hostname, "Developer overlay monitoring started");
          sendResponse(res);
          return;
        }

        if (popupMonitoring.active && popupMonitoring.tabId === tabId) {
          await stopPopupMonitoring();
        }
        sendResponse({ ok: true, monitoring: getMonitoringState() });
        return;
      }

      if (msg.type === "streamguard:monitorEvent") {
        if (popupMonitoring.active && sender?.tab?.id === popupMonitoring.tabId) {
          addMonitoringEvent({
            ...msg.event,
            tabId: sender.tab.id
          });
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "streamguard:toggleFavorite") {
        const groupName = String(msg.groupName || "");
        const data = await chrome.storage.sync.get([FAVORITES_KEY]);
        let favorites = data[FAVORITES_KEY] || [];
        if (favorites.includes(groupName)) {
          favorites = favorites.filter((x) => x !== groupName);
        } else {
          favorites.push(groupName);
        }
        await chrome.storage.sync.set({ [FAVORITES_KEY]: favorites });
        sendResponse({ ok: true, favorites });
        return;
      }

      if (msg.type === "streamguard:addLocalDomain") {
        const domain = streamguardNormalizeDomain(msg.domain || "");
        const group_name = String(msg.group_name || "").trim() || streamguardGuessGroupNameFromDomain(domain);
        const payload = {
          group_name,
          domain,
          status: String(msg.status || "suggested").trim().toLowerCase(),
          submitted_at: new Date().toISOString().slice(0, 10),
          submitted_note: String(msg.submitted_note || "").trim(),
          review_note: "",
          rejection_reason: "",
          favorite_score: 0,
          delivery_status: "local_only",
          submitted_remote_at: ""
        };

        if (!domain) {
          sendResponse({ ok: false, message: "A domain is required." });
          return;
        }

        const remoteRows = await streamguardFetchRemote(false);
        const data = await chrome.storage.sync.get([USER_DOMAINS_KEY]);
        const rows = data[USER_DOMAINS_KEY] || [];
        const combinedRows = streamguardBuildCombinedRows(remoteRows, rows);
        const duplicate = streamguardFindByDomain(combinedRows, domain);

        if (duplicate) {
          const duplicateSource = duplicate.source === "local" ? "local suggestions" : "remote database";
          sendResponse({
            ok: false,
            message: `Domain already exists in ${duplicateSource}.`,
            duplicate
          });
          return;
        }

        const submitResult = await submitSuggestionToRemote(payload);
        if (!submitResult.ok) {
          sendResponse({
            ok: false,
            message: submitResult.message || "The suggestion could not be sent to the remote database.",
            remoteError: true,
            detail: submitResult.detail || ""
          });
          return;
        }

        payload.delivery_status = submitResult.delivery_status || "submitted";
        payload.submitted_remote_at = new Date().toISOString().slice(0, 10);

        rows.push(payload);
        await chrome.storage.sync.set({ [USER_DOMAINS_KEY]: rows });
        await streamguardClearRemoteCache();
        const freshRows = await streamguardFetchRemote(true);

        sendResponse({
          ok: true,
          rows,
          added: { ...payload, source: "local" },
          submitResult,
          remoteCount: Array.isArray(freshRows) ? freshRows.length : 0
        });
        return;
      }

      if (msg.type === "streamguard:removeLocalDomain") {
        const domain = streamguardNormalizeDomain(msg.domain || "");
        const data = await chrome.storage.sync.get([USER_DOMAINS_KEY]);
        const rows = (data[USER_DOMAINS_KEY] || []).filter(
          (r) => streamguardNormalizeDomain(r.domain) !== domain
        );
        await chrome.storage.sync.set({ [USER_DOMAINS_KEY]: rows });
        sendResponse({ ok: true, rows });
        return;
      }

      if (msg.type === "streamguard:injectModulesForCurrentTab") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab?.url) {
          sendResponse({ ok: false, message: "No active tab." });
          return;
        }

        const remoteRows = await streamguardFetchRemote(false);
        const syncData = await chrome.storage.sync.get([USER_DOMAINS_KEY]);
        const combinedRows = streamguardBuildCombinedRows(remoteRows, syncData[USER_DOMAINS_KEY] || []);
        const match = streamguardFindByDomain(combinedRows, new URL(tab.url).hostname);
        if (!match) {
          sendResponse({ ok: false, message: "Current domain not found in remote or local database." });
          return;
        }

        if (String(match.source || "remote").toLowerCase() !== "remote" || String(match.status || "").toLowerCase() !== "supported") {
          sendResponse({
            ok: false,
            message: "Only remote supported sites can run modules. Local suggestions are stored for developer analysis first.",
            match
          });
          return;
        }

        const slug = streamguardSlugFromGroup(match.group_name);
        const moduleInfo = streamguardGetModuleInfo(slug);

        if (!moduleInfo.available) {
          sendResponse({
            ok: false,
            message: "This site is marked as supported in the remote database, but your current StreamGuard version does not include its module yet. Update from GitHub first.",
            updateRequired: true,
            match,
            slug
          });
          return;
        }

        const filesToTry = [
          `modules/${slug}/adguard.js`,
          `modules/${slug}/fillbrowserscreen.js`
        ];

        const results = [];
        for (const file of filesToTry) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: [file]
            });
            results.push({ file, ok: true });
          } catch (e) {
            results.push({ file, ok: false, error: String(e) });
          }
        }

        sendResponse({ ok: true, slug, match, results });
        return;
      }

      if (msg.type === "streamguard:refreshRemoteCache") {
        const rows = await streamguardFetchRemote(true);
        sendResponse({ ok: true, count: Array.isArray(rows) ? rows.length : 0 });
        return;
      }

      sendResponse({ ok: false, message: "Unknown message type." });
    } catch (e) {
      sendResponse({ ok: false, message: String(e) });
    }
  })();

  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!popupMonitoring.active) return;
  if (!popupMonitoring.tabId) return;
  if (tab.openerTabId !== popupMonitoring.tabId) return;

  addMonitoringEvent({
    kind: "popup_tab",
    title: "New popup/tab opened",
    detail: tab.pendingUrl || tab.url || "(pending URL)",
    tabId: tab.id || null
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (popupMonitoring.active && (tabId === popupMonitoring.tabId || tab.openerTabId === popupMonitoring.tabId)) {
    if (info.url) {
      addMonitoringEvent({
        kind: tabId === popupMonitoring.tabId ? "navigation" : "popup_navigation",
        title: tabId === popupMonitoring.tabId ? "Monitored tab navigated" : "Popup/tab navigated",
        detail: info.url,
        tabId
      });
    }

    if (info.status === "complete" && tab.url && tabId === popupMonitoring.tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "streamguard:setLiveMonitoring",
          enabled: true,
          startedAt: popupMonitoring.startedAt
        });
      } catch (e) {
      }
    }
  }

  if (info.status !== "complete" || !tab.url) return;

  try {
    const remoteRows = await streamguardFetchRemote(false);
    const syncData = await chrome.storage.sync.get([USER_DOMAINS_KEY]);
    const combinedRows = streamguardBuildCombinedRows(remoteRows, syncData[USER_DOMAINS_KEY] || []);
    const match = streamguardFindByDomain(combinedRows, new URL(tab.url).hostname);
    if (!match) return;

    if (String(match.status || "").toLowerCase() !== "supported") return;

    const slug = streamguardSlugFromGroup(match.group_name);
    const moduleInfo = streamguardGetModuleInfo(slug);
    if (!moduleInfo.available) return;

    for (const file of [`modules/${slug}/adguard.js`, `modules/${slug}/fillbrowserscreen.js`]) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [file]
        });
      } catch (e) {
      }
    }
  } catch (e) {
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (popupMonitoring.active && popupMonitoring.tabId === tabId) {
    await stopPopupMonitoring();
  }
});


async function submitSuggestionToRemote(payload) {
  const body = {
    group_name: String(payload.group_name || "").trim(),
    domain: streamguardNormalizeDomain(payload.domain || ""),
    submitted_note: String(payload.submitted_note || "").trim()
  };

  try {
    const res = await fetch(STREAMGUARD_API_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(body),
      redirect: "follow"
    });

    const rawText = await res.text();
    let json = {};
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch (e) {
      json = { ok: false, error: `Invalid JSON response: ${rawText.slice(0, 180)}` };
    }

    if (!res.ok) {
      return {
        ok: false,
        message: json.error || `Remote submit failed with status ${res.status}.`,
        detail: rawText.slice(0, 300)
      };
    }

    if (json && json.ok === false) {
      return {
        ok: false,
        message: json.error || json.message || "Remote submit was rejected.",
        detail: rawText.slice(0, 300)
      };
    }

    return {
      ok: true,
      message: json.message || "Suggestion submitted to remote database.",
      delivery_status: json.delivery_status || "submitted",
      remote: json
    };
  } catch (error) {
    return {
      ok: false,
      message: "Could not reach the Apps Script web app.",
      detail: String(error)
    };
  }
}

function addMonitoringEvent(event) {
  popupMonitoring.events.unshift({
    ts: Date.now(),
    kind: event.kind || "event",
    title: event.title || "Monitoring event",
    detail: event.detail || "",
    tabId: event.tabId || null
  });
  popupMonitoring.events = popupMonitoring.events.slice(0, 25);
}

function getMonitoringState() {
  return {
    active: popupMonitoring.active,
    tabId: popupMonitoring.tabId,
    hostname: popupMonitoring.hostname,
    startedAt: popupMonitoring.startedAt,
    events: popupMonitoring.events.slice(0, 25)
  };
}

async function stopPopupMonitoring() {
  const oldTabId = popupMonitoring.tabId;

  popupMonitoring.active = false;
  popupMonitoring.tabId = null;
  popupMonitoring.windowId = null;
  popupMonitoring.hostname = "";
  popupMonitoring.startedAt = 0;
  popupMonitoring.events = [];

  if (oldTabId) {
    try {
      await chrome.tabs.sendMessage(oldTabId, {
        type: "streamguard:setLiveMonitoring",
        enabled: false
      });
    } catch (e) {
    }
  }
}
