const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const tabsInfo = document.getElementById("tabsInfo");
const relayUrlInput = document.getElementById("relayUrl");
const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");

function updateUI(status) {
  if (status.connected) {
    dot.className = "dot on";
    statusText.textContent = "Connected";
  } else {
    dot.className = "dot off";
    statusText.textContent = "Disconnected";
  }
  const count = status.attachedTabs?.length || 0;
  tabsInfo.textContent = count > 0
    ? `Debugging ${count} tab${count > 1 ? "s" : ""}`
    : "No tabs attached";
  relayUrlInput.value = status.relayUrl || "http://localhost:9223";
}

// Get initial status — also trigger a connect attempt just by opening the popup
chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
  if (resp) {
    updateUI(resp);
    // Auto-connect if not already connected
    if (!resp.connected) {
      chrome.runtime.sendMessage({ type: "connect" });
    }
  }
});

// Listen for status updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") updateUI(msg);
});

btnConnect.addEventListener("click", () => {
  const url = relayUrlInput.value.trim();
  if (url) {
    chrome.runtime.sendMessage({ type: "setRelayUrl", url });
  }
  chrome.runtime.sendMessage({ type: "connect" });
});

btnDisconnect.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "disconnect" });
});

relayUrlInput.addEventListener("change", () => {
  const url = relayUrlInput.value.trim();
  if (url) {
    chrome.runtime.sendMessage({ type: "setRelayUrl", url });
  }
});
