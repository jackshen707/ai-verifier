/* AI 核实器 - 后台调度中心 */

const PROVIDERS = {
  deepseek: { name: "DeepSeek", url: "https://chat.deepseek.com/", match: "chat.deepseek.com" },
  doubao:   { name: "豆包",     url: "https://www.doubao.com/chat/", match: "doubao.com" }
};

// 允许内容脚本读写 session 存储(用于任务交接)
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "verify-text",  title: "🔍 用 AI 核实选中内容", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "verify-image", title: "🔍 用 AI 核实这张图片", contexts: ["image"] });
    chrome.contextMenus.create({ id: "translate-text", title: "🌐 用 AI 翻译成简体中文", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "summarize-text", title: "📝 用 AI 总结这段话", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "explain-text", title: "💡 用 AI 解释一下", contexts: ["selection"] });
  });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

function buildPrompt(task) {
  if (task.type === "translate") {
    return "请把下面的内容翻译成简体中文。要求:\n" +
      "1. 忠实原意,表达自然流畅,符合中文表达习惯\n" +
      "2. 专业术语、人名、机构名可在译文后用括号标注原文\n" +
      "3. 保留原文的段落结构\n" +
      "4. 只输出译文,不要任何解释或开场白\n\n" +
      "待翻译内容:\n\"\"\"\n" + task.text + "\n\"\"\"";
  }
  if (task.type === "summarize") {
    return "请用简体中文总结下面的内容。要求:\n" +
      "1. 先用一句话概括核心内容\n" +
      "2. 再分点列出 3~5 个要点(内容很短则可省略)\n" +
      "3. 忠于原文,不要添加原文没有的信息\n\n" +
      "待总结内容:\n\"\"\"\n" + task.text + "\n\"\"\"";
  }
  if (task.type === "explain") {
    return "请用通俗易懂的简体中文解释下面的内容,假设我是没有相关背景知识的普通读者。要求:\n" +
      "1. 先用大白话说明它是什么意思\n" +
      "2. 解释其中的专业术语、缩写或难懂的概念\n" +
      "3. 如果有帮助,可以举一个简单的例子或打个比方\n\n" +
      "待解释内容:\n\"\"\"\n" + task.text + "\n\"\"\"\n来源页面:" + task.pageUrl;
  }
  const head =
    "请你作为严谨的事实核查助手,核实下面内容的真实性,并尽量联网检索佐证。请严格按以下格式回答:\n" +
    "【可信度评分】0~100 分\n" +
    "【判定结论】基本属实 / 部分属实 / 存疑 / 基本不实 / 无法判定\n" +
    "【分析理由】列出关键依据\n" +
    "【核实建议】给读者的查证建议\n\n";
  if (task.type === "image") {
    return head +
      "待核实的是一张图片(已随本消息上传,若未收到请用下方链接)。" +
      "请先读出图片中的文字和关键内容,再核实其真实性,并判断是否可能为 AI 生成或移花接木。\n" +
      (task.imageUrl && task.imageUrl.startsWith("http") ? "图片链接:" + task.imageUrl + "\n" : "") +
      "图片所在页面:" + task.pageUrl;
  }
  return head + "待核实内容:\n\"\"\"\n" + task.text + "\n\"\"\"\n来源页面:" + task.pageUrl;
}

// 把图片抓取为 dataURL。关键:临时设置 Referer 请求头,
// 伪装成从原网页正常访问,绕过微博/微信等图床的防盗链(403)
async function fetchAsDataURL(url, pageUrl) {
  const RULE_ID = 9901;
  let referer = "", host = "";
  try { referer = new URL(pageUrl).origin + "/"; } catch (e) {}
  try { host = new URL(url).hostname; } catch (e) {}
  if (referer && host) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [RULE_ID],
        addRules: [{
          id: RULE_ID, priority: 1,
          condition: { requestDomains: [host], resourceTypes: ["xmlhttprequest"] },
          action: { type: "modifyHeaders", requestHeaders: [
            { header: "Referer", operation: "set", value: referer },
            { header: "Origin", operation: "remove" }
          ]}
        }]
      });
    } catch (e) {}
  }
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    if (blob.size > 4 * 1024 * 1024) throw new Error("图片超过 4MB");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return "data:" + (blob.type || "image/png") + ";base64," + btoa(bin);
  } finally {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] }).catch(() => {});
  }
}

async function notifySource(tabId, payload) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "panel", ...payload });
  } catch (e) {
    // 页面里没有面板脚本(常见于插件更新后未刷新的页面)→ 自动注入后重试
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["panel.js"] });
      await chrome.tabs.sendMessage(tabId, { type: "panel", ...payload });
    } catch (e2) {
      // chrome:// 内部页面、应用商店等特殊页面无法注入,只能忽略
    }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const { provider = "deepseek" } = await chrome.storage.sync.get("provider");
  const P = PROVIDERS[provider] || PROVIDERS.deepseek;

  const task = {
    id: Date.now() + "_" + Math.floor(Math.random() * 1e4),
    provider,
    type: info.menuItemId === "verify-image" ? "image"
        : info.menuItemId === "translate-text" ? "translate"
        : info.menuItemId === "summarize-text" ? "summarize"
        : info.menuItemId === "explain-text" ? "explain" : "text",
    text: info.selectionText || "",
    imageUrl: info.srcUrl || "",
    pageUrl: info.pageUrl || (tab && tab.url) || "",
    sourceTabId: tab ? tab.id : null,
    claimed: false
  };

  notifySource(task.sourceTabId, { status: "loading", text: "正在连接 " + P.name + "...", taskId: task.id });

  if (task.type === "image" && task.imageUrl) {
    try {
      task.imageData = await fetchAsDataURL(task.imageUrl, task.pageUrl);
    } catch (e) {
      // 后台抓取仍失败 → 备用方案:让来源页面用 canvas 把已显示的图片"画"下来
      try {
        const resp = await chrome.tabs.sendMessage(task.sourceTabId, { type: "grabImage", srcUrl: task.imageUrl });
        if (resp && resp.dataUrl) task.imageData = resp.dataUrl;
      } catch (e2) { /* 两种方式都失败,只能发链接 */ }
    }
  }
  task.prompt = buildPrompt(task);

  await chrome.storage.session.set({ ["task_" + task.id]: { sourceTabId: task.sourceTabId }, pendingTask: task });

  // 找已打开的 AI 标签页,没有就新建(后台打开,不打扰当前浏览)
  const tabs = await chrome.tabs.query({});
  const aiTab = tabs.find(t => t.url && t.url.includes(P.match));
  if (aiTab) {
    chrome.tabs.sendMessage(aiTab.id, { type: "runTask", task }).catch(() => {
      chrome.tabs.reload(aiTab.id); // 脚本未就绪 → 刷新后会自动认领 pendingTask
    });
  } else {
    chrome.tabs.create({ url: P.url, active: false });
  }
});

// 转发 AI 页面的进度/结果给来源页面
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "taskUpdate") {
    (async () => {
      const key = "task_" + msg.taskId;
      const o = await chrome.storage.session.get(key);
      if (!o[key]) return;
      notifySource(o[key].sourceTabId, {
        status: msg.status, text: msg.text, taskId: msg.taskId,
        aiTabId: sender.tab ? sender.tab.id : null
      });
      if (msg.status === "done" || msg.status === "error") {
        chrome.storage.session.remove(key);
        chrome.storage.session.get("pendingTask").then(({ pendingTask }) => {
          if (pendingTask && pendingTask.id === msg.taskId) chrome.storage.session.remove("pendingTask");
        });
      }
    })();
  }
  if (msg.type === "focusAiTab" && msg.tabId != null) {
    chrome.tabs.update(msg.tabId, { active: true });
    chrome.tabs.get(msg.tabId, t => t && chrome.windows.update(t.windowId, { focused: true }));
  }
  if (msg.type === "openOptions") chrome.runtime.openOptionsPage();
});
