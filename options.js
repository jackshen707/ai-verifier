/* AI 核实器 - 设置页脚本 */

document.addEventListener("DOMContentLoaded", async () => {
  const { provider = "deepseek" } = await chrome.storage.sync.get("provider");
  const radio = document.querySelector('input[value="' + provider + '"]');
  if (radio) radio.checked = true;

  document.getElementById("save").onclick = async () => {
    const sel = document.querySelector('input[name="provider"]:checked');
    await chrome.storage.sync.set({ provider: sel ? sel.value : "deepseek" });
    const s = document.getElementById("saved");
    s.style.opacity = 1;
    setTimeout(() => (s.style.opacity = 0), 1500);
  };

  document.getElementById("openDs").onclick = () =>
    chrome.tabs.create({ url: "https://chat.deepseek.com/" });
  document.getElementById("openDb").onclick = () =>
    chrome.tabs.create({ url: "https://www.doubao.com/chat/" });
});
