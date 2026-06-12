/* AI 核实器 - AI 网站自动化脚本 */

/* ── 选择器配置区:网站改版时只需修改这里 ───────────── */
const SEL = {
  input: [
    "textarea#chat-input",                                    // DeepSeek
    'textarea[data-testid="chat_input_input"]',               // 豆包
    'div[contenteditable="true"][data-testid="chat_input_input"]',
    "textarea",                                               // 通用兜底
    'div[contenteditable="true"]'
  ],
  sendBtn: [
    'button[data-testid="chat_input_send_button"]',           // 豆包
    'div[role="button"]:has(svg)',                            // DeepSeek(通用)
    'button[type="submit"]'
  ],
  reply: [
    ".ds-markdown",                                           // DeepSeek 回答
    '[data-testid="message_text_content"]',                   // 豆包回答
    '[class*="markdown"]',
    '[class*="message-content"]',
    '[class*="answer"]'
  ]
};
/* ──────────────────────────────────────────────────── */

let running = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const visible = el => {
  const r = el.getBoundingClientRect();
  return r.width > 40 && r.height > 8 && el.offsetParent !== null;
};

function report(taskId, status, text) {
  chrome.runtime.sendMessage({ type: "taskUpdate", taskId, status, text }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === "runTask") { startTask(msg.task); sendResponse({ ok: true }); }
});

// 页面加载后,认领等待中的任务(用于新开/刷新标签页的场景)
setTimeout(claimPending, 2800);
async function claimPending() {
  try {
    const { pendingTask } = await chrome.storage.session.get("pendingTask");
    if (!pendingTask || pendingTask.claimed) return;
    const isDeepseek = location.hostname.includes("deepseek");
    if ((pendingTask.provider === "deepseek") !== isDeepseek) return;
    await chrome.storage.session.set({ pendingTask: { ...pendingTask, claimed: true } });
    startTask(pendingTask);
  } catch (e) {}
}

function findInput() {
  for (const s of SEL.input) {
    let els = [];
    try { els = [...document.querySelectorAll(s)].filter(visible); } catch (e) {}
    if (els.length) return els[els.length - 1];
  }
  return null;
}

async function waitFor(fn, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = fn();
    if (r) return r;
    await sleep(800);
  }
  return null;
}

async function typeInto(el, text) {
  el.focus();
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false, null);
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
  }
  await sleep(300);
}

function inputIsEmpty(el) {
  const v = (el.value !== undefined ? el.value : el.textContent) || "";
  return v.replace(/[\u200b\s]/g, "") === "";   // 忽略空白和零宽字符
}

// 只找输入框附近、可见且未被禁用的发送按钮(避免误点其他按钮)
function findSendButtons(input) {
  const out = [];
  for (const s of SEL.sendBtn) {
    try { out.push(...document.querySelectorAll(s)); } catch (e) {}
  }
  const ir = input.getBoundingClientRect();
  return out.filter(b => {
    if (!visible(b)) return false;
    if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
    const r = b.getBoundingClientRect();
    return Math.abs(r.top - ir.top) < 220;      // 与输入框垂直距离 220px 内
  });
}

async function pressSend(input) {
  const before = snapshot();
  // 成功判定:输入框被清空 或 页面出现了新消息气泡(双重标准)
  const sentOK = async waitMs => {
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      await sleep(400);
      if (inputIsEmpty(input)) return true;
      if (snapshot().count > before.count) return true;
    }
    return false;
  };
  // 最多重试 3 轮(应对:上一条回答未结束/图片上传中导致按钮暂时禁用)
  for (let attempt = 0; attempt < 3; attempt++) {
    input.focus();
    const fire = type => input.dispatchEvent(new KeyboardEvent(type, {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
    }));
    fire("keydown"); fire("keypress"); fire("keyup");
    if (await sentOK(2500)) return true;
    const btns = findSendButtons(input);
    if (btns.length) {
      btns[btns.length - 1].click();
      if (await sentOK(2500)) return true;
    }
    await sleep(1500);                          // 稍等片刻再重试
  }
  return false;
}

async function tryAttachImage(input, dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const file = new File([blob], "verify." + ext, { type: blob.type || "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.focus();
    // 方式1:模拟粘贴
    let pasteEvt;
    try { pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }); }
    catch (e) {
      pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvt, "clipboardData", { value: dt });
    }
    input.dispatchEvent(pasteEvt);
    await sleep(1500);
    // 方式2:直接塞给文件选择框
    const fi = [...document.querySelectorAll('input[type="file"]')].find(f => !f.disabled);
    if (fi) {
      fi.files = dt.files;
      fi.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(1500);
    }
    // 方式3:模拟拖放
    const dropEvt = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvt, "dataTransfer", { value: dt });
    input.dispatchEvent(dropEvt);
    await sleep(1000);
    return true;
  } catch (e) { return false; }
}

function getReplyEls() {
  for (const s of SEL.reply) {
    let els = [];
    try { els = [...document.querySelectorAll(s)].filter(visible); } catch (e) {}
    if (els.length) return els;
  }
  return [];
}

function snapshot() {
  const els = getReplyEls();
  return { count: els.length, lastText: els.length ? (els[els.length - 1].innerText || "").trim() : "" };
}

async function waitForReply(baseline, prompt, taskId, timeout) {
  const start = Date.now();
  const promptHead = prompt.slice(0, 40);
  let lastText = "", stable = 0, notified = false;
  while (Date.now() - start < timeout) {
    await sleep(1500);
    const els = getReplyEls();
    if (!els.length) continue;
    const t = (els[els.length - 1].innerText || "").trim();
    const isNew = els.length > baseline.count || t !== baseline.lastText;
    if (!isNew || !t) continue;
    if (t.startsWith(promptHead.slice(0, 20))) continue; // 跳过自己发的消息气泡
    if (!notified) { report(taskId, "update", "AI 正在回答中,请稍候..."); notified = true; }
    if (t === lastText) {
      stable++;
      if (stable >= 3 && t.length > 2) return t;         // 内容 4.5 秒未变 = 回答完毕
    } else { stable = 0; lastText = t; }
  }
  return lastText.length > 2 ? lastText : null;          // 阈值放宽,兼容短译文(如单词翻译)
}

async function startTask(task) {
  if (running) { report(task.id, "error", "已有一个核实任务正在进行,请稍后再试。"); return; }
  running = true;
  try {
    await chrome.storage.session.set({ pendingTask: { ...task, claimed: true } }).catch(() => {});
    report(task.id, "update", "已连接 AI 页面,正在查找聊天输入框...");
    const input = await waitFor(findInput, 25000);
    if (!input) {
      report(task.id, "error", "未找到聊天输入框。最可能的原因是【尚未登录】——请点击下方「查看 AI 页面」按钮,登录后再重新核实一次。");
      return;
    }
    let attached = false;
    if (task.type === "image" && task.imageData) {
      report(task.id, "update", "正在尝试自动上传图片...");
      attached = await tryAttachImage(input, task.imageData);
      await sleep(4000);                       // 给图片上传留足时间
    }
    let prompt = task.prompt;
    if (task.type === "image" && !attached && task.imageUrl.startsWith("http")) {
      prompt += "\n(图片自动上传失败,请通过上面的图片链接分析)";
    }
    report(task.id, "update", "正在发送请求...");
    const baseline = snapshot();
    await typeInto(input, prompt);
    const sent = await pressSend(input);
    if (!sent) {
      report(task.id, "error", "发送未成功。常见原因:① AI 还在回答上一条消息 ② 图片仍在上传 ③ 网站登录已过期。请点「查看 AI 页面」检查状态后,稍等几秒重新核实;若反复失败,可能是网站改版,需更新 ai-runner.js 顶部的选择器配置。");
      return;
    }
    report(task.id, "update", "已发送,等待 AI 回答(通常 10~60 秒)...");
    const reply = await waitForReply(baseline, prompt, task.id, 180000);
    if (reply) report(task.id, "done", reply);
    else report(task.id, "error", "等待回答超时。AI 可能仍在生成,请点击「查看 AI 页面」直接查看。");
  } catch (e) {
    report(task.id, "error", "执行出错:" + (e && e.message ? e.message : e));
  } finally {
    running = false;
  }
}
