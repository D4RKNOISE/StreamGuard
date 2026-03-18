(function () {
  if (window.__streamguard_cinegram_adguard_loaded__) return;
  window.__streamguard_cinegram_adguard_loaded__ = true;

  const ALLOWED_HOSTS = new Set([
    "cinegram.net",
    "www.cinegram.net",
    "vidfast.pro",
    "www.vidfast.pro"
  ]);

  const BLOCKED_SCRIPT_PATTERNS = [
    "warkheels.com",
    "doubleclick.net",
    "googlesyndication.com",
    "adservice.google.com",
    "popads.net",
    "popcash.net",
    "adsterra",
    "histats"
  ];

  const BLOCKED_UI_SELECTORS = [
    "#adsContainer",
    "#settingsBtn",
    "#settingsModal"
  ];

  const BLOCKED_ATTRS = [
    "onclick",
    "onmousedown",
    "onmouseup"
  ];

  const DEBUG = false;

  function log() {
    if (!DEBUG) return;
    try {
      console.log("[StreamGuard][Cinegram AdGuard]", ...arguments);
    } catch (_) {}
  }

  function toUrl(value) {
    try {
      return new URL(String(value || ""), location.href);
    } catch (_) {
      return null;
    }
  }

  function isAllowedUrl(value) {
    const u = toUrl(value);
    if (!u) return true;
    if (u.protocol === "javascript:") return false;
    if (u.protocol === "data:") return false;
    return ALLOWED_HOSTS.has(u.hostname);
  }

  function matchesBlockedPattern(value) {
    const str = String(value || "").toLowerCase();
    return BLOCKED_SCRIPT_PATTERNS.some((p) => str.includes(p));
  }

  function injectStyle() {
    if (document.getElementById("streamguard-cinegram-adguard-style")) return;

    const style = document.createElement("style");
    style.id = "streamguard-cinegram-adguard-style";
    style.textContent = `
      #adsContainer,
      #settingsBtn,
      #settingsModal {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function forceAdsDisabled() {
    try {
      localStorage.setItem(
        "adsSettings",
        JSON.stringify({
          disabled: true,
          savedAt: Date.now()
        })
      );
    } catch (_) {}
  }

  function removeBlockedUi(root = document) {
    BLOCKED_UI_SELECTORS.forEach((selector) => {
      root.querySelectorAll?.(selector).forEach((el) => el.remove());
    });
  }

  function stripDangerousAttributes(root = document) {
    const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    nodes.forEach((el) => {
      BLOCKED_ATTRS.forEach((attr) => {
        const value = el.getAttribute?.(attr);
        if (value && matchesBlockedPattern(value)) {
          el.removeAttribute(attr);
        }
      });

      if (el.tagName === "A") {
        const href = el.getAttribute("href") || "";
        const target = (el.getAttribute("target") || "").toLowerCase();

        if (target === "_blank" && !isAllowedUrl(href)) {
          el.removeAttribute("target");
          el.setAttribute("rel", "noopener noreferrer");
        }

        if (href && !isAllowedUrl(href) && !href.startsWith("#")) {
          el.dataset.streamguardBlockedHref = href;
        }
      }
    });
  }

  function removeBlockedScripts(root = document) {
    root.querySelectorAll?.("script").forEach((script) => {
      const src = script.src || "";
      const inline = script.textContent || "";

      if (matchesBlockedPattern(src) || matchesBlockedPattern(inline)) {
        log("Removed blocked script:", src || "[inline]");
        script.remove();
      }
    });
  }

  function removeBlockedIframes(root = document) {
    root.querySelectorAll?.("iframe").forEach((frame) => {
      const src = frame.getAttribute("src") || "";
      if (src && !isAllowedUrl(src) && matchesBlockedPattern(src)) {
        log("Removed blocked iframe:", src);
        frame.remove();
      }
    });
  }

  function hardenWindowOpen() {
    const originalOpen = window.open;
    if (typeof originalOpen !== "function") return;

    window.open = function (...args) {
      const url = args[0] ? String(args[0]) : "";
      if (!url || !isAllowedUrl(url)) {
        log("Blocked window.open:", url);
        return null;
      }
      return originalOpen.apply(window, args);
    };
  }

  function hardenElementInsertion() {
    const originalAppendChild = Element.prototype.appendChild;
    const originalInsertBefore = Element.prototype.insertBefore;

    function shouldBlockNode(node) {
      if (!(node instanceof Element)) return false;

      if (node.tagName === "SCRIPT") {
        const src = node.getAttribute("src") || "";
        const inline = node.textContent || "";
        return matchesBlockedPattern(src) || matchesBlockedPattern(inline);
      }

      if (node.tagName === "IFRAME") {
        const src = node.getAttribute("src") || "";
        return src && !isAllowedUrl(src) && matchesBlockedPattern(src);
      }

      return false;
    }

    Element.prototype.appendChild = function (node) {
      if (shouldBlockNode(node)) {
        log("Blocked appendChild:", node.tagName, node.getAttribute?.("src") || "");
        return node;
      }
      return originalAppendChild.call(this, node);
    };

    Element.prototype.insertBefore = function (node, ref) {
      if (shouldBlockNode(node)) {
        log("Blocked insertBefore:", node.tagName, node.getAttribute?.("src") || "");
        return node;
      }
      return originalInsertBefore.call(this, node, ref);
    };
  }

  function installGlobalClickBlocker() {
    const blockEvent = (e) => {
      const a = e.target?.closest?.("a");
      if (!a) return;

      const href = a.getAttribute("href") || "";
      const target = (a.getAttribute("target") || "").toLowerCase();

      if (!href || href.startsWith("#")) return;

      if (href.startsWith("javascript:")) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        log("Blocked javascript href");
        return;
      }

      if (!isAllowedUrl(href) || target === "_blank") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        log("Blocked suspicious link:", href);
      }
    };

    document.addEventListener("click", blockEvent, true);
    document.addEventListener("mousedown", blockEvent, true);
    document.addEventListener("mouseup", blockEvent, true);
    document.addEventListener("auxclick", blockEvent, true);
  }

  function installMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          removeBlockedUi(node);
          stripDangerousAttributes(node);
          removeBlockedScripts(node);
          removeBlockedIframes(node);
        });
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function cleanNow() {
    forceAdsDisabled();
    removeBlockedUi(document);
    stripDangerousAttributes(document);
    removeBlockedScripts(document);
    removeBlockedIframes(document);
  }

  function boot() {
    injectStyle();
    forceAdsDisabled();
    hardenWindowOpen();
    hardenElementInsertion();
    installGlobalClickBlocker();
    cleanNow();
    installMutationObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
