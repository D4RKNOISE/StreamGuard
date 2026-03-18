(function () {
  if (window.__streamguard_cinegram_fill_loaded__) return;
  window.__streamguard_cinegram_fill_loaded__ = true;

  const BTN_ID = "cg-browserfs-toggle";
  const STYLE_ID = "cg-browserfs-style";
  const ROOT_CLASS = "cg-browserfs";
  const TARGET_CLASS = "cg-player-target";
  const UI_HIDDEN_CLASS = "cg-ui-hidden";

  let activeTarget = null;
  let patched = [];
  let observerStarted = false;
  let uiHideTimer = null;

  function boot() {
    injectStyle();
    createButton();
    updateButton();
    startObserver();
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BTN_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(15, 19, 31, 0.92);
        color: #fff;
        border-radius: 10px;
        padding: 10px 14px;
        font: 600 13px/1.2 Inter, Segoe UI, Arial, sans-serif;
        cursor: pointer;
        box-shadow: 0 14px 35px rgba(0,0,0,.35);
        backdrop-filter: blur(8px);
      }

      html.${ROOT_CLASS},
      html.${ROOT_CLASS} body {
        overflow: hidden !important;
        background: #000 !important;
      }

      html.${ROOT_CLASS} #${BTN_ID} {
        bottom: 18px;
      }

      html.${ROOT_CLASS}.${UI_HIDDEN_CLASS} #${BTN_ID},
      body.${ROOT_CLASS}.${UI_HIDDEN_CLASS} #${BTN_ID} {
        opacity: 0;
        pointer-events: none;
        transition: opacity .22s ease;
      }

      html.${ROOT_CLASS} .mynav,
      html.${ROOT_CLASS} .bottom-menu-nav,
      html.${ROOT_CLASS} #sidebar,
      html.${ROOT_CLASS} footer,
      html.${ROOT_CLASS} .undertop > :not(#player),
      html.${ROOT_CLASS} .container2,
      html.${ROOT_CLASS} #scrolltocomments,
      html.${ROOT_CLASS} .main-content > :not(.undertop),
      html.${ROOT_CLASS} .undertop > :not(.btn-group):not(#player),
      html.${ROOT_CLASS} #comments-icon,
      html.${ROOT_CLASS} #shareButton,
      html.${ROOT_CLASS} .watch-trailer-btn,
      html.${ROOT_CLASS} .btns-under-jumbo,
      html.${ROOT_CLASS} .ploting,
      html.${ROOT_CLASS} .drop-bounce,
      html.${ROOT_CLASS} .swiper-container-featured,
      html.${ROOT_CLASS} .swiper-button-next-featured,
      html.${ROOT_CLASS} .swiper-button-prev-featured,
      html.${ROOT_CLASS} .undervidbtns:not(.streamguard-allow-visible) {
        display: none !important;
      }

      html.${ROOT_CLASS} ${''/* current player root */}.${TARGET_CLASS} {
        box-sizing: border-box !important;
      }

      html.${ROOT_CLASS}.${UI_HIDDEN_CLASS} .streamguard-allow-visible,
      body.${ROOT_CLASS}.${UI_HIDDEN_CLASS} .streamguard-allow-visible {
        opacity: 0 !important;
        pointer-events: none !important;
        transition: opacity .22s ease !important;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function createButton() {
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "Browser Fullscreen";
    btn.title = "Toggle browser fullscreen";
    btn.addEventListener("click", toggleMode);
    document.body.appendChild(btn);
  }

  function updateButton() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.textContent = document.body.classList.contains(ROOT_CLASS)
      ? "Exit Browser Fullscreen"
      : "Browser Fullscreen";
  }

  function showUiTemporarily() {
    document.documentElement.classList.remove(UI_HIDDEN_CLASS);
    document.body.classList.remove(UI_HIDDEN_CLASS);

    clearTimeout(uiHideTimer);
    uiHideTimer = setTimeout(function () {
      if (document.body.classList.contains(ROOT_CLASS)) {
        document.documentElement.classList.add(UI_HIDDEN_CLASS);
        document.body.classList.add(UI_HIDDEN_CLASS);
      }
    }, 2200);
  }

  function stopUiTimer() {
    clearTimeout(uiHideTimer);
    document.documentElement.classList.remove(UI_HIDDEN_CLASS);
    document.body.classList.remove(UI_HIDDEN_CLASS);
  }

  function isVisible(el) {
    if (!el) return false;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function findPlayer() {
    const selectors = [
      "#player.watchbox.total",
      "#player.watchbox",
      "#player"
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }

    return null;
  }

  function remember(el) {
    if (!el || el.dataset.cgSavedStyle === "1") return;

    el.dataset.cgSavedStyle = "1";
    patched.push({
      el,
      style: el.getAttribute("style"),
      className: el.className
    });
  }

  function setImportant(el, styles) {
    if (!el) return;
    remember(el);
    for (const key in styles) {
      el.style.setProperty(key, styles[key], "important");
    }
  }

  function firstDirectChildByClass(parent, className) {
    if (!parent) return null;
    for (const child of parent.children) {
      if (child.classList && child.classList.contains(className)) {
        return child;
      }
    }
    return null;
  }

  function markVisibleChrome(el) {
    if (!el) return;
    el.classList.add("streamguard-allow-visible");
  }

  function patchPlayer(root) {
    if (!root) return;

    const topBar = root.children.length ? root.children[0] : null;
    const videomp4 = firstDirectChildByClass(root, "videomp4");
    const middleWrap = videomp4 && videomp4.children.length ? videomp4.children[0] : null;
    const loader = root.querySelector(".loader");
    const iframe = root.querySelector("iframe.img-responsing, iframe[src*='vidfast.pro'], iframe[src*='autoPlay=true']");
    const underBar = root.querySelector(".undervidbtns");

    setImportant(root, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      margin: "0",
      padding: "0",
      overflow: "hidden",
      background: "#000",
      "z-index": "2147483646"
    });

    root.classList.add(TARGET_CLASS);

    if (topBar) {
      setImportant(topBar, {
        display: "none"
      });
    }

    if (videomp4) {
      setImportant(videomp4, {
        width: "100%",
        height: "100vh",
        "max-height": "100vh",
        overflow: "hidden",
        background: "#000"
      });
    }

    if (middleWrap) {
      setImportant(middleWrap, {
        width: "100%",
        height: "100%"
      });
    }

    if (loader) {
      setImportant(loader, {
        width: "100%",
        height: "100%"
      });
    }

    if (iframe) {
      setImportant(iframe, {
        width: "100%",
        height: "100%",
        display: "block",
        border: "0",
        "max-width": "none",
        "max-height": "none"
      });
    }

    if (underBar) {
      setImportant(underBar, {
        position: "absolute",
        left: "0",
        right: "0",
        bottom: "0",
        width: "100%",
        margin: "0",
        "z-index": "2147483647"
      });
      markVisibleChrome(underBar);
    }
  }

  function restoreAll() {
    for (let i = patched.length - 1; i >= 0; i--) {
      const item = patched[i];
      if (!item || !item.el) continue;

      if (item.style === null) {
        item.el.removeAttribute("style");
      } else {
        item.el.setAttribute("style", item.style);
      }

      if (typeof item.className === "string") {
        item.el.className = item.className;
      }

      delete item.el.dataset.cgSavedStyle;
    }

    patched = [];
  }

  function enableMode() {
    const player = findPlayer();
    if (!player) {
      alert("No Cinegram player found.");
      return;
    }

    activeTarget = player;
    document.documentElement.classList.add(ROOT_CLASS);
    document.body.classList.add(ROOT_CLASS);

    patchPlayer(activeTarget);
    updateButton();
    showUiTemporarily();
  }

  function disableMode() {
    document.documentElement.classList.remove(ROOT_CLASS);
    document.documentElement.classList.remove(UI_HIDDEN_CLASS);
    document.body.classList.remove(ROOT_CLASS, UI_HIDDEN_CLASS);

    stopUiTimer();
    restoreAll();
    activeTarget = null;
    updateButton();
  }

  function toggleMode() {
    if (document.body.classList.contains(ROOT_CLASS)) {
      disableMode();
    } else {
      enableMode();
    }
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : "";
    return tag === "input" || tag === "textarea" || target.isContentEditable;
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;

    const observer = new MutationObserver(function () {
      createButton();

      if (!document.body.classList.contains(ROOT_CLASS)) return;
      if (!activeTarget || !document.contains(activeTarget)) {
        disableMode();
        return;
      }

      patchPlayer(activeTarget);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  document.addEventListener("mousemove", function () {
    if (document.body.classList.contains(ROOT_CLASS)) {
      showUiTemporarily();
    }
  });

  document.addEventListener("mouseenter", function () {
    if (document.body.classList.contains(ROOT_CLASS)) {
      showUiTemporarily();
    }
  });

  document.addEventListener("keydown", function (e) {
    const key = (e.key || "").toLowerCase();

    if (key === "t" && !isTypingTarget(e.target)) {
      e.preventDefault();
      toggleMode();
      return;
    }

    if (document.body.classList.contains(ROOT_CLASS)) {
      showUiTemporarily();
    }

    if (e.key === "Escape" && document.body.classList.contains(ROOT_CLASS)) {
      e.preventDefault();
      disableMode();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
