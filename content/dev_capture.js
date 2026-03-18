(function () {
  const OVERLAY_ID = "streamguard-dev-capture-overlay";

  const liveMonitor = {
    enabled: false,
    startedAt: 0,
    listenersAttached: false,
    events: []
  };

  document.addEventListener("keydown", async (e) => {
    if (!(e.shiftKey && e.altKey && String(e.key).toLowerCase() === "s")) return;
    e.preventDefault();
    e.stopPropagation();

    const existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      existing.remove();
      chrome.runtime.sendMessage({
        type: "streamguard:devOverlayState",
        open: false,
        hostname: location.hostname
      });
      return;
    }

    const data = collectPageData();
    const overlay = buildOverlay(data);
    document.documentElement.appendChild(overlay);
    chrome.runtime.sendMessage({
      type: "streamguard:devOverlayState",
      open: true,
      hostname: location.hostname
    });
    renderLiveMonitorEvents();
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "streamguard:setLiveMonitoring") {
      liveMonitor.enabled = Boolean(msg.enabled);
      liveMonitor.startedAt = Number(msg.startedAt || Date.now());

      if (liveMonitor.enabled) {
        liveMonitor.events = [];
        attachLiveMonitor();
        pushLiveEvent({
          title: "Live monitoring enabled",
          detail: location.hostname
        });
      } else {
        pushLiveEvent({
          title: "Live monitoring disabled",
          detail: location.hostname,
          skipRemote: true
        });
        liveMonitor.events = [];
      }

      renderLiveMonitorEvents();
      sendResponse({ ok: true });
      return true;
    }
  });

  function attachLiveMonitor() {
    if (liveMonitor.listenersAttached) return;
    liveMonitor.listenersAttached = true;

    document.addEventListener("click", handleClickEvent, true);
    document.addEventListener("auxclick", handleClickEvent, true);
    document.addEventListener("submit", handleSubmitEvent, true);

    const observer = new MutationObserver((mutations) => {
      if (!liveMonitor.enabled) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;

          if (node.matches?.("iframe")) {
            pushLiveEvent({
              kind: "iframe",
              title: "New iframe added",
              detail: node.src || "(empty iframe src)"
            });
            return;
          }

          const iframe = node.querySelector?.("iframe");
          if (iframe) {
            pushLiveEvent({
              kind: "iframe",
              title: "New iframe added",
              detail: iframe.src || "(empty iframe src)"
            });
            return;
          }
        }
      }
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  function handleClickEvent(event) {
    if (!liveMonitor.enabled) return;

    const target = event.target instanceof Element ? event.target.closest("a, button, [role='button']") : null;
    if (!target) return;

    const href = target.getAttribute("href") || target.href || "";
    const targetAttr = target.getAttribute("target") || "";
    const text = (target.innerText || target.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);

    pushLiveEvent({
      kind: "click",
      title: target.tagName === "A" ? "Clicked link" : "Clicked button/trigger",
      detail: [text && `text=${text}`, href && `href=${href}`, targetAttr && `target=${targetAttr}`].filter(Boolean).join(" · ") || target.tagName
    });
  }

  function handleSubmitEvent(event) {
    if (!liveMonitor.enabled) return;
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;

    pushLiveEvent({
      kind: "submit",
      title: "Form submitted",
      detail: form.action || location.href
    });
  }

  function pushLiveEvent(event) {
    const item = {
      ts: Date.now(),
      kind: event.kind || "event",
      title: event.title || "Monitoring event",
      detail: event.detail || ""
    };

    liveMonitor.events.unshift(item);
    liveMonitor.events = liveMonitor.events.slice(0, 12);
    renderLiveMonitorEvents();

    if (!event.skipRemote && liveMonitor.enabled) {
      chrome.runtime.sendMessage({
        type: "streamguard:monitorEvent",
        event: item
      });
    }
  }

  function collectPageData() {
    const iframes = Array.from(document.querySelectorAll("iframe")).map((el) => ({
      src: el.src || "",
      id: el.id || "",
      cls: el.className || ""
    }));

    const players = [
      "video",
      "iframe",
      ".player",
      ".video-player",
      ".jwplayer",
      ".plyr",
      "#player",
      "#video"
    ].filter((selector) => document.querySelector(selector));

    const suspiciousLinks = Array.from(document.querySelectorAll('a[target="_blank"], a[href^="javascript:"]'))
      .slice(0, 20)
      .map((el) => el.href || el.getAttribute("href") || "");

    return {
      url: location.href,
      title: document.title,
      hostname: location.hostname,
      iframes,
      players,
      suspiciousLinks
    };
  }

  function buildOverlay(data) {
    const wrap = document.createElement("div");
    wrap.id = OVERLAY_ID;
    wrap.style.position = "fixed";
    wrap.style.top = "16px";
    wrap.style.right = "16px";
    wrap.style.width = "460px";
    wrap.style.maxHeight = "80vh";
    wrap.style.overflow = "auto";
    wrap.style.zIndex = "2147483647";
    wrap.style.background = "rgba(10,12,18,.96)";
    wrap.style.color = "#fff";
    wrap.style.border = "1px solid rgba(255,255,255,.12)";
    wrap.style.borderRadius = "14px";
    wrap.style.boxShadow = "0 16px 40px rgba(0,0,0,.35)";
    wrap.style.fontFamily = "Inter, Arial, sans-serif";

    const prompt = [
      "New streaming domain debug capture:",
      "",
      `URL: ${data.url}`,
      `Title: ${data.title}`,
      `Hostname: ${data.hostname}`,
      "",
      "Detected player selectors:",
      ...data.players.map((x) => `- ${x}`),
      "",
      "Detected iframes:",
      ...data.iframes.map((x) => `- ${x.src || "(empty src)"} | id=${x.id} | class=${x.cls}`),
      "",
      "Suspicious links:",
      ...data.suspiciousLinks.map((x) => `- ${x}`)
    ].join("\n");

    wrap.innerHTML = `
      <div style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div style="font-weight:800;">StreamGuard Dev Capture</div>
        <button id="sg-dev-close" style="border:none;background:transparent;color:#fff;font-size:18px;cursor:pointer;">×</button>
      </div>
      <div style="padding:12px 14px;font-size:12px;line-height:1.45;">
        <div><b>Host:</b> ${escapeHtml(data.hostname)}</div>
        <div><b>Title:</b> ${escapeHtml(data.title)}</div>
        <div style="margin-top:10px;"><b>Player selectors</b><br>${data.players.map(escapeHtml).join("<br>") || "(none)"}</div>
        <div style="margin-top:10px;"><b>Iframes</b><br>${data.iframes.map((x) => escapeHtml(x.src || "(empty src)")).join("<br>") || "(none)"}</div>
        <div style="margin-top:10px;"><b>Live monitor</b><br><span id="sg-dev-live-state">${liveMonitor.enabled ? "Active while this developer overlay is open" : "Toggle this developer overlay on to start live monitoring"}</span></div>
        <div id="sg-dev-live-events" style="margin-top:8px;display:grid;gap:6px;"></div>
        <div style="margin-top:10px;"><b>Prompt</b></div>
        <textarea id="sg-dev-prompt" style="width:100%;min-height:220px;background:#0f141d;color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px;margin-top:6px;">${prompt}</textarea>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button id="sg-dev-copy" style="border:none;background:#2c78ff;color:#fff;border-radius:10px;padding:10px 12px;cursor:pointer;font-weight:700;">Copy Prompt</button>
          <button id="sg-dev-refresh" style="border:none;background:rgba(255,255,255,.08);color:#fff;border-radius:10px;padding:10px 12px;cursor:pointer;font-weight:700;">Refresh Capture</button>
        </div>
      </div>
    `;

    wrap.querySelector("#sg-dev-close").addEventListener("click", () => {
      wrap.remove();
      chrome.runtime.sendMessage({
        type: "streamguard:devOverlayState",
        open: false,
        hostname: location.hostname
      });
    });
    wrap.querySelector("#sg-dev-copy").addEventListener("click", async () => {
      const text = wrap.querySelector("#sg-dev-prompt").value;
      await navigator.clipboard.writeText(text);
      wrap.querySelector("#sg-dev-copy").textContent = "Copied";
      setTimeout(() => wrap.querySelector("#sg-dev-copy").textContent = "Copy Prompt", 1200);
    });
    wrap.querySelector("#sg-dev-refresh").addEventListener("click", () => {
      const next = collectPageData();
      const replacement = buildOverlay(next);
      wrap.replaceWith(replacement);
      renderLiveMonitorEvents();
    });

    return wrap;
  }

  function renderLiveMonitorEvents() {
    const wrap = document.getElementById(OVERLAY_ID);
    if (!wrap) return;

    const stateEl = wrap.querySelector("#sg-dev-live-state");
    const eventsEl = wrap.querySelector("#sg-dev-live-events");
    if (!stateEl || !eventsEl) return;

    stateEl.textContent = liveMonitor.enabled ? "Active while this developer overlay is open" : "Toggle this developer overlay on to start live monitoring";

    if (!liveMonitor.events.length) {
      eventsEl.innerHTML = `<div style="padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.08);color:#9fa9b9;">No live events yet.</div>`;
      return;
    }

    eventsEl.innerHTML = liveMonitor.events.map((event) => `
      <div style="padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);">
        <div style="font-weight:700;">${escapeHtml(event.title)}</div>
        <div style="color:#a9b5c7;margin-top:3px;word-break:break-word;">${escapeHtml(event.detail || "")}</div>
      </div>
    `).join("");
  }

  function escapeHtml(str) {
    return String(str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
