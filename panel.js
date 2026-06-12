/* AI 核实器 - 结果悬浮面板(全站注入) */

(function () {
  // 防止重复注入产生多个面板
  if (window.__aiVerifierPanelLoaded) return;
  window.__aiVerifierPanelLoaded = true;

  let host = null, els = {}, aiTabId = null;

  function ensurePanel() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement("div");
    host.id = "__ai_verifier_panel__";
    host.style.cssText = "all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .box{width:380px;max-width:92vw;background:#fff;border-radius:14px;
          box-shadow:0 8px 32px rgba(0,0,0,.25);font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;
          color:#222;overflow:hidden;border:1px solid #e5e5e5}
        .hd{display:flex;align-items:center;gap:8px;padding:10px 14px;
          background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700}
        .hd .x{margin-left:auto;cursor:pointer;border:none;background:rgba(255,255,255,.2);
          color:#fff;border-radius:6px;width:24px;height:24px;font-size:14px}
        .bd{padding:14px;max-height:55vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
        .spin{display:inline-block;width:14px;height:14px;border:2px solid #2563eb;
          border-top-color:transparent;border-radius:50%;animation:r 1s linear infinite;
          vertical-align:-2px;margin-right:8px}
        @keyframes r{to{transform:rotate(360deg)}}
        .ft{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #eee;align-items:center}
        .btn{cursor:pointer;border:none;border-radius:8px;padding:6px 12px;font-size:12px;
          background:#f1f5f9;color:#333}
        .btn:hover{background:#e2e8f0}
        .note{margin-left:auto;font-size:11px;color:#999}
        .err{color:#dc2626}
      </style>
      <div class="box">
        <div class="hd">🔍 AI 核实器 <button class="x" title="关闭">✕</button></div>
        <div class="bd"></div>
        <div class="ft">
          <button class="btn copy">复制结果</button>
          <button class="btn view">查看 AI 页面</button>
          <span class="note">AI 生成,仅供参考</span>
        </div>
      </div>`;
    els.bd = root.querySelector(".bd");
    root.querySelector(".x").onclick = () => { host.remove(); host = null; };
    root.querySelector(".copy").onclick = () => {
      navigator.clipboard.writeText(els.bd.textContent || "").catch(() => {});
    };
    root.querySelector(".view").onclick = () => {
      if (aiTabId != null) chrome.runtime.sendMessage({ type: "focusAiTab", tabId: aiTabId }).catch(() => {});
    };
    document.documentElement.appendChild(host);
  }

  // 备用抓图:后台抓取失败时,把页面里已显示的图片画到 canvas 取出数据
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || msg.type !== "grabImage") return;
    (async () => {
      const draw = el => {
        const c = document.createElement("canvas");
        c.width = el.naturalWidth; c.height = el.naturalHeight;
        c.getContext("2d").drawImage(el, 0, 0);
        return c.toDataURL("image/png");  // 跨域受限图片这里会抛错,由 catch 接住
      };
      try {
        const img = [...document.images].find(i => i.src === msg.srcUrl || i.currentSrc === msg.srcUrl);
        if (img && img.complete && img.naturalWidth) {
          try { sendResponse({ dataUrl: draw(img) }); return; } catch (e) {}
        }
        const im2 = new Image();
        im2.crossOrigin = "anonymous";
        im2.src = msg.srcUrl;
        await new Promise((res, rej) => {
          im2.onload = res; im2.onerror = rej; setTimeout(rej, 8000);
        });
        sendResponse({ dataUrl: draw(im2) });
      } catch (e) { sendResponse({ dataUrl: null }); }
    })();
    return true;  // 异步响应
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (!msg || msg.type !== "panel") return;
    ensurePanel();
    if (msg.aiTabId != null) aiTabId = msg.aiTabId;
    if (msg.status === "loading" || msg.status === "update") {
      els.bd.innerHTML = '<span class="spin"></span>' + escapeHtml(msg.text || "处理中...");
    } else if (msg.status === "done") {
      els.bd.textContent = msg.text || "";
    } else if (msg.status === "error") {
      els.bd.innerHTML = '<div class="err">⚠️ ' + escapeHtml(msg.text || "出错了") + "</div>";
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
})();
