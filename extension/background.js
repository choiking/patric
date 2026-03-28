// Patric Browser Relay — MV3 Service Worker
// Uses HTTP long-polling instead of WebSocket to stay alive.
// fetch() is a Chrome API that keeps the service worker active.

const DEFAULT_RELAY_URL = "http://localhost:9223";
const CDP_VERSION = "1.3";

let relayUrl = DEFAULT_RELAY_URL;
let connected = false;

// Track which tabs have the debugger attached
const attachedTabs = new Set();
let activeTabId = null;

// ---------------------------------------------------------------------------
// Long-polling loop
// ---------------------------------------------------------------------------

async function pollOnce() {
  const stored = await chrome.storage.local.get(["relayUrl"]);
  const storedUrl = stored.relayUrl || "";
  // Ignore stale ws:// URLs from previous version
  relayUrl = storedUrl.startsWith("http") ? storedUrl : DEFAULT_RELAY_URL;

  try {
    // Long-poll: GET /poll — server holds connection until it has a command
    const resp = await fetch(`${relayUrl}/poll`, {
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      throw new Error(`Poll failed: ${resp.status}`);
    }

    if (!connected) {
      connected = true;
      updateBadge("ON", "#4CAF50");
      broadcastStatus();
      console.log("[Patric] Connected to relay server");
    }

    const msg = await resp.json();

    if (msg.type !== "noop") {
      // Process the command
      console.log("[Patric] Received command:", msg.type, msg.id);
      let result, error;
      try {
        result = await handleMessage(msg);
      } catch (err) {
        error = { message: err.message || String(err) };
        console.error("[Patric] Command error:", error.message);
      }

      // Post result back
      console.log("[Patric] Sending result for:", msg.id, error ? "ERROR" : "OK");
      await fetch(`${relayUrl}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: msg.id, result: result ?? {}, error }),
        signal: AbortSignal.timeout(5000),
      });
    }

    // Immediately poll again
    pollOnce();

  } catch (err) {
    // Connection failed — server not running or network error
    if (connected) {
      connected = false;
      updateBadge("OFF", "#F44336");
      broadcastStatus();
      console.log("[Patric] Disconnected:", err.message);
    }
    // Retry after 2 seconds
    setTimeout(() => pollOnce(), 2000);
  }
}

let stopped = false;

function stopPolling() {
  stopped = true;
  connected = false;
  detachAll();
  updateBadge("OFF", "#F44336");
  broadcastStatus();
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  const { type } = msg;

  switch (type) {
    case "command":
      return await handleCommand(msg.method, msg.params, msg.tabId);
    case "listTabs":
      return await handleListTabs();
    case "createTab":
      return await handleCreateTab(msg.url);
    case "closeTab":
      return await handleCloseTab(msg.tabId);
    case "activateTab":
      return await handleActivateTab(msg.tabId);
    case "navigateTab":
      return await handleNavigateTab(msg.tabId, msg.url);
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

async function handleListTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    tabId: tab.id,
    title: tab.title || "",
    url: tab.url || "",
    active: tab.active,
  }));
}

async function handleCreateTab(url) {
  console.log("[Patric] Creating tab:", url);
  const tab = await chrome.tabs.create({ url: url || "about:blank" });
  console.log("[Patric] Tab created:", tab.id);
  activeTabId = tab.id;
  return { tabId: tab.id };
}

async function handleCloseTab(tabId) {
  await chrome.tabs.remove(tabId);
  attachedTabs.delete(tabId);
  if (activeTabId === tabId) activeTabId = null;
}

async function handleActivateTab(tabId) {
  await chrome.tabs.update(tabId, { active: true });
  activeTabId = tabId;
}

async function handleNavigateTab(tabId, url) {
  // Detach debugger before navigation to avoid conflicts
  if (attachedTabs.has(tabId)) {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        attachedTabs.delete(tabId);
        resolve();
      });
    });
  }
  await chrome.tabs.update(tabId, { url });
  activeTabId = tabId;
}

// ---------------------------------------------------------------------------
// CDP command execution
// ---------------------------------------------------------------------------

async function handleCommand(method, params, tabId) {
  let targetTabId = tabId || activeTabId;
  if (!targetTabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab available");
    targetTabId = tab.id;
    activeTabId = targetTabId;
  }

  if (!attachedTabs.has(targetTabId)) {
    await attachDebugger(targetTabId);
  }

  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: targetTabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result ?? {});
      }
    });
  });
}

// ---------------------------------------------------------------------------
// chrome.debugger helpers
// ---------------------------------------------------------------------------

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message;
        if (msg.includes("Another debugger") || msg.includes("already attached")) {
          // Detach first, then retry
          chrome.debugger.detach({ tabId }, () => {
            chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                attachedTabs.add(tabId);
                resolve();
              }
            });
          });
        } else {
          reject(new Error(msg));
        }
      } else {
        attachedTabs.add(tabId);
        resolve();
      }
    });
  });
}

function detachAll() {
  for (const tabId of attachedTabs) {
    chrome.debugger.detach({ tabId }, () => {});
  }
  attachedTabs.clear();
  activeTabId = null;
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    if (activeTabId === source.tabId) activeTabId = null;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  if (activeTabId === tabId) activeTabId = null;
});

// ---------------------------------------------------------------------------
// Badge & status
// ---------------------------------------------------------------------------

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: "status",
    connected,
    attachedTabs: Array.from(attachedTabs),
    relayUrl,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Message handling from popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getStatus") {
    sendResponse({ connected, attachedTabs: Array.from(attachedTabs), relayUrl });
    return true;
  }
  if (msg.type === "connect") {
    stopped = false;
    pollOnce();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "disconnect") {
    stopPolling();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "setRelayUrl") {
    relayUrl = msg.url;
    chrome.storage.local.set({ relayUrl: msg.url });
    sendResponse({ ok: true });
    return true;
  }
});

// ---------------------------------------------------------------------------
// Keepalive alarm — restart poll loop if service worker was killed
// ---------------------------------------------------------------------------

chrome.alarms.create("patric-keepalive", { periodInMinutes: 0.5 }); // 30s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "patric-keepalive") {
    if (!stopped) {
      console.log("[Patric] Alarm: restarting poll");
      pollOnce();
    }
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

console.log("[Patric] Browser Relay service worker started");
// Clear any stale ws:// URL from previous version
chrome.storage.local.get(["relayUrl"], (stored) => {
  if (stored.relayUrl && !stored.relayUrl.startsWith("http")) {
    chrome.storage.local.remove("relayUrl");
  }
});
pollOnce();
