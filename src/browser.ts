import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as relay from "./relay-server";

// Start the relay server immediately on import so the extension has time to connect
relay.startRelayServer().catch(() => {});

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

interface ElementRef {
  role: string;
  name: string;
  index: number; // nth match (0-based) when multiple elements share role+name
}

/** For relay mode: ref maps to a CDP backendNodeId */
interface RelayElementRef {
  backendNodeId: number;
  role: string;
  name: string;
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "option", "menuitem", "tab", "switch", "slider", "spinbutton",
  "searchbox", "treeitem", "select", "listbox"
]);

const MAX_SNAPSHOT_CHARS = 15_000;
const DOWNLOADS_DIR = path.join(process.cwd(), ".patric-downloads");
const SCREENSHOTS_DIR = path.join(process.cwd(), ".patric-screenshots");

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let activePage: Page | null = null;
let connectedViaCdp = false;
let connectedViaRelay = false;
let refMap = new Map<number, ElementRef>();
let relayRefMap = new Map<number, RelayElementRef>();
let nextRef = 1;
// Track the active tab ID when in relay mode
let relayActiveTabId: number | null = null;

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

const CDP_ENDPOINT = "http://localhost:9222";
const PATRIC_PROFILE_DIR = path.join(os.homedir(), ".config", "patric", "browser-profile");

async function tryConnectCdp(): Promise<boolean> {
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    const pages = context.pages();
    activePage = pages.length > 0 ? pages[pages.length - 1] : await context.newPage();
    connectedViaCdp = true;
    return true;
  } catch {
    browser = null;
    context = null;
    activePage = null;
    return false;
  }
}

async function launchPersistent(): Promise<void> {
  fs.mkdirSync(PATRIC_PROFILE_DIR, { recursive: true });
  try {
    context = await chromium.launchPersistentContext(PATRIC_PROFILE_DIR, {
      headless: false,
      acceptDownloads: true,
      args: ["--no-sandbox"],
    });
  } catch (err: any) {
    throw new Error(
      `Failed to launch browser.\n` +
      `Make sure Playwright browsers are installed: bunx playwright install chromium\n\n` +
      `Original error: ${err.message || String(err)}`
    );
  }
  const pages = context.pages();
  activePage = pages.length > 0 ? pages[0] : await context.newPage();
  connectedViaCdp = false;
}

async function tryConnectRelay(): Promise<boolean> {
  try {
    // Relay server is already started on import. Just check if extension connected.
    if (!relay.isExtensionConnected()) {
      // Give it a few more seconds in case it's still connecting
      const deadline = Date.now() + 3000;
      while (!relay.isExtensionConnected() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!relay.isExtensionConnected()) {
      return false;
    }
    connectedViaRelay = true;
    // Get the active tab
    try {
      const tabs = await relay.listTabs();
      const activeTab = tabs.find((t: any) => t.active);
      if (activeTab) {
        relayActiveTabId = activeTab.tabId;
      }
    } catch {
      // listTabs failed but extension is connected — we can still proceed
    }
    return true;
  } catch {
    // Never kill the relay server — it should stay alive for the extension to reconnect
    return false;
  }
}

async function ensureBrowser(): Promise<void> {
  if (connectedViaRelay && relay.isExtensionConnected()) return;
  if (context) return;

  // 1. Try direct CDP connection (Chrome with --remote-debugging-port)
  const connected = await tryConnectCdp();
  if (!connected) {
    // 2. Try extension relay (Patric Browser Relay extension)
    const relayed = await tryConnectRelay();
    if (!relayed) {
      // 3. Fall back to Patric's own persistent profile
      await launchPersistent();
    }
  }
}

export async function closeBrowser(): Promise<void> {
  if (connectedViaRelay) {
    // Don't stop relay server — keep it alive so extension can reconnect
  } else if (connectedViaCdp && browser) {
    await browser.close().catch(() => {});
  } else if (context) {
    await context.close().catch(() => {});
  }
  browser = null;
  context = null;
  activePage = null;
  connectedViaCdp = false;
  connectedViaRelay = false;
  relayActiveTabId = null;
  refMap.clear();
  relayRefMap.clear();
}

// ---------------------------------------------------------------------------
// ARIA snapshot parser & ref system (Playwright mode)
// ---------------------------------------------------------------------------

interface ParsedAriaLine {
  indent: string;
  role: string;
  name: string;
  attributes: string;
}

function parseAriaLine(line: string): ParsedAriaLine | null {
  const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+(\[.*\]))?/);
  if (match) {
    return {
      indent: match[1],
      role: match[2],
      name: match[3] || "",
      attributes: match[4] || "",
    };
  }
  const textMatch = line.match(/^(\s*)-\s+(text):\s*(.*)/);
  if (textMatch) {
    return { indent: textMatch[1], role: "text", name: textMatch[3], attributes: "" };
  }
  return null;
}

async function buildSnapshot(page: Page): Promise<string> {
  const yaml = await page.locator("body").ariaSnapshot();
  refMap.clear();
  nextRef = 1;

  const lines = yaml.split("\n");
  const outputLines: string[] = [];
  const roleCounts = new Map<string, number>();

  for (const line of lines) {
    const parsed = parseAriaLine(line);
    if (!parsed) {
      outputLines.push(line);
      continue;
    }

    const { indent, role, name, attributes } = parsed;
    const nameStr = name ? ` "${name}"` : "";
    const attrStr = attributes ? ` ${attributes}` : "";

    if (INTERACTIVE_ROLES.has(role)) {
      const key = `${role}::${name}`;
      const count = roleCounts.get(key) || 0;
      roleCounts.set(key, count + 1);

      const ref = nextRef++;
      refMap.set(ref, { role, name, index: count });

      outputLines.push(`${indent}[${ref}] ${role}${nameStr}${attrStr}`);
    } else {
      outputLines.push(`${indent}${role}${nameStr}${attrStr}`);
    }
  }

  const title = await page.title();
  const url = page.url();
  let result = `Page: ${title} (${url})\n\n${outputLines.join("\n")}`;

  if (result.length > MAX_SNAPSHOT_CHARS) {
    result = result.slice(0, MAX_SNAPSHOT_CHARS) + "\n\n[...TRUNCATED - page too large]";
  }

  return result;
}

function resolveRef(page: Page, ref: number): Locator {
  const entry = refMap.get(ref);
  if (!entry) {
    throw new Error(
      `Invalid element reference [${ref}]. Take a new snapshot to get current refs.`
    );
  }

  const locator = page.getByRole(entry.role as any, {
    name: entry.name || undefined,
    exact: true,
  });

  return entry.index > 0 ? locator.nth(entry.index) : locator.first();
}

// ===========================================================================
// Relay-mode action implementations (no Playwright, raw CDP via extension)
// ===========================================================================

async function relayNavigate(args: Record<string, any>): Promise<string> {
  const url = args.url || "";
  if (!url) return "Error: 'url' is required for navigate action.";
  const finalUrl = url.startsWith("http") ? url : `https://${url}`;

  if (!relayActiveTabId) {
    // No active tab — create one with the URL (Chrome navigates natively)
    const result = await relay.createTab(finalUrl);
    relayActiveTabId = result.tabId;
  } else {
    // Active tab exists — use chrome.tabs.update to navigate (no debugger needed)
    await relay.navigateTab(relayActiveTabId, finalUrl);
  }

  // Wait for page to load
  await new Promise((r) => setTimeout(r, 2500));

  relayRefMap.clear();
  nextRef = 1;

  // Re-attach debugger after navigation (it may have detached)
  let title = "";
  let currentUrl = finalUrl;
  try {
    const titleResult = await relay.sendCommand(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      relayActiveTabId
    );
    const urlResult = await relay.sendCommand(
      "Runtime.evaluate",
      { expression: "window.location.href", returnByValue: true },
      relayActiveTabId
    );
    title = titleResult?.result?.value || "";
    currentUrl = urlResult?.result?.value || finalUrl;
  } catch {
    // Page may still be loading — that's ok
  }

  return `Navigated to: ${currentUrl}\nTitle: ${title}\n\nUse action 'snapshot' to see interactive elements on the page.`;
}

async function relaySnapshot(): Promise<string> {
  if (!relayActiveTabId) return "Error: No active tab. Use 'navigate' first.";

  // Enable accessibility domain
  await relay.sendCommand("Accessibility.enable", {}, relayActiveTabId).catch(() => {});

  // Get the full accessibility tree
  const axTree = await relay.sendCommand(
    "Accessibility.getFullAXTree",
    {},
    relayActiveTabId
  );

  const nodes: any[] = axTree?.nodes || [];
  relayRefMap.clear();
  nextRef = 1;

  const outputLines: string[] = [];
  const roleCounts = new Map<string, number>();

  // Build a parent→children map
  const childrenMap = new Map<string, string[]>();
  const nodeMap = new Map<string, any>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
    if (node.childIds) {
      childrenMap.set(node.nodeId, node.childIds);
    }
  }

  // DFS to build the tree output
  function getPropertyValue(node: any, propName: string): string {
    if (node.properties) {
      for (const p of node.properties) {
        if (p.name === propName) return p.value?.value || "";
      }
    }
    return "";
  }

  function walkNode(nodeId: string, depth: number) {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = node.role?.value || "";
    const name = node.name?.value || "";
    const indent = "  ".repeat(depth);

    // Skip ignored nodes
    if (node.ignored) {
      // Still walk children
      const children = childrenMap.get(nodeId) || [];
      for (const childId of children) {
        walkNode(childId, depth);
      }
      return;
    }

    // Skip empty generic/none roles but walk children
    if (!role || role === "none" || role === "generic" || role === "GenericContainer") {
      const children = childrenMap.get(nodeId) || [];
      for (const childId of children) {
        walkNode(childId, depth);
      }
      return;
    }

    const normalizedRole = role.replace(/([A-Z])/g, (m: string) => m.toLowerCase());

    if (role === "StaticText" || role === "InlineTextBox") {
      if (name.trim()) {
        outputLines.push(`${indent}- text: ${name}`);
      }
      return;
    }

    const nameStr = name ? ` "${name}"` : "";

    if (INTERACTIVE_ROLES.has(normalizedRole)) {
      const key = `${normalizedRole}::${name}`;
      const count = roleCounts.get(key) || 0;
      roleCounts.set(key, count + 1);

      const ref = nextRef++;
      relayRefMap.set(ref, {
        backendNodeId: node.backendDOMNodeId || 0,
        role: normalizedRole,
        name,
      });

      outputLines.push(`${indent}[${ref}] ${normalizedRole}${nameStr}`);
    } else {
      outputLines.push(`${indent}- ${normalizedRole}${nameStr}`);
    }

    const children = childrenMap.get(nodeId) || [];
    for (const childId of children) {
      walkNode(childId, depth + 1);
    }
  }

  // Find root and walk
  if (nodes.length > 0) {
    walkNode(nodes[0].nodeId, 0);
  }

  // Get page title and URL
  const titleResult = await relay.sendCommand(
    "Runtime.evaluate",
    { expression: "document.title", returnByValue: true },
    relayActiveTabId
  );
  const urlResult = await relay.sendCommand(
    "Runtime.evaluate",
    { expression: "window.location.href", returnByValue: true },
    relayActiveTabId
  );

  const title = titleResult?.result?.value || "";
  const currentUrl = urlResult?.result?.value || "";

  let result = `Page: ${title} (${currentUrl})\n\n${outputLines.join("\n")}`;
  if (result.length > MAX_SNAPSHOT_CHARS) {
    result = result.slice(0, MAX_SNAPSHOT_CHARS) + "\n\n[...TRUNCATED - page too large]";
  }
  return result;
}

async function relayClick(args: Record<string, any>): Promise<string> {
  const ref = args.ref;
  if (ref === undefined) return "Error: 'ref' is required. Take a snapshot first to get element refs.";
  if (!relayActiveTabId) return "Error: No active tab.";

  const entry = relayRefMap.get(ref);
  if (!entry) {
    return `Error: Invalid element reference [${ref}]. Take a new snapshot to get current refs.`;
  }

  if (entry.backendNodeId) {
    // Resolve the DOM node to a JS object and click it
    const resolved = await relay.sendCommand(
      "DOM.resolveNode",
      { backendNodeId: entry.backendNodeId },
      relayActiveTabId
    );
    const objectId = resolved?.object?.objectId;
    if (objectId) {
      await relay.sendCommand(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: "function() { this.scrollIntoViewIfNeeded?.(); this.click(); }",
          returnByValue: true,
        },
        relayActiveTabId
      );
    }
  }

  return `Clicked element [${ref}]. Page may have changed -- take a new snapshot to see current state.`;
}

async function relayType(args: Record<string, any>): Promise<string> {
  const ref = args.ref;
  const text = args.text;
  if (ref === undefined) return "Error: 'ref' is required for type action.";
  if (text === undefined) return "Error: 'text' is required for type action.";
  if (!relayActiveTabId) return "Error: No active tab.";

  const entry = relayRefMap.get(ref);
  if (!entry) {
    return `Error: Invalid element reference [${ref}]. Take a new snapshot to get current refs.`;
  }

  if (entry.backendNodeId) {
    const resolved = await relay.sendCommand(
      "DOM.resolveNode",
      { backendNodeId: entry.backendNodeId },
      relayActiveTabId
    );
    const objectId = resolved?.object?.objectId;
    if (objectId) {
      await relay.sendCommand(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function(v) {
            this.focus();
            this.value = v;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }`,
          arguments: [{ value: String(text) }],
          returnByValue: true,
        },
        relayActiveTabId
      );
    }
  }

  const preview = String(text).length > 50 ? String(text).slice(0, 50) + "..." : String(text);
  return `Typed "${preview}" into element [${ref}].`;
}

async function relaySelect(args: Record<string, any>): Promise<string> {
  const ref = args.ref;
  const text = args.text;
  if (ref === undefined) return "Error: 'ref' is required for select action.";
  if (!text) return "Error: 'text' (option value or label) is required for select action.";
  if (!relayActiveTabId) return "Error: No active tab.";

  const entry = relayRefMap.get(ref);
  if (!entry) {
    return `Error: Invalid element reference [${ref}]. Take a new snapshot to get current refs.`;
  }

  if (entry.backendNodeId) {
    const resolved = await relay.sendCommand(
      "DOM.resolveNode",
      { backendNodeId: entry.backendNodeId },
      relayActiveTabId
    );
    const objectId = resolved?.object?.objectId;
    if (objectId) {
      await relay.sendCommand(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function(label) {
            for (const opt of this.options) {
              if (opt.text === label || opt.value === label) {
                this.value = opt.value;
                this.dispatchEvent(new Event('change', { bubbles: true }));
                break;
              }
            }
          }`,
          arguments: [{ value: text }],
          returnByValue: true,
        },
        relayActiveTabId
      );
    }
  }

  return `Selected "${text}" in element [${ref}].`;
}

async function relayCheck(args: Record<string, any>, checked: boolean): Promise<string> {
  const ref = args.ref;
  if (ref === undefined) return `Error: 'ref' is required for ${checked ? "check" : "uncheck"} action.`;
  if (!relayActiveTabId) return "Error: No active tab.";

  const entry = relayRefMap.get(ref);
  if (!entry) {
    return `Error: Invalid element reference [${ref}]. Take a new snapshot to get current refs.`;
  }

  if (entry.backendNodeId) {
    const resolved = await relay.sendCommand(
      "DOM.resolveNode",
      { backendNodeId: entry.backendNodeId },
      relayActiveTabId
    );
    const objectId = resolved?.object?.objectId;
    if (objectId) {
      await relay.sendCommand(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function(checked) {
            if (this.checked !== checked) {
              this.checked = checked;
              this.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }`,
          arguments: [{ value: checked }],
          returnByValue: true,
        },
        relayActiveTabId
      );
    }
  }

  return `${checked ? "Checked" : "Unchecked"} element [${ref}].`;
}

async function relayEvaluate(args: Record<string, any>): Promise<string> {
  const expression = args.expression || "";
  if (!expression) return "Error: 'expression' is required for evaluate action.";
  if (!relayActiveTabId) return "Error: No active tab.";

  const result = await relay.sendCommand(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    relayActiveTabId
  );

  const val = result?.result?.value;
  const output = typeof val === "string" ? val : JSON.stringify(val, null, 2);
  return output.length > 10_000 ? output.slice(0, 10_000) + "\n... [truncated]" : output;
}

async function relayText(): Promise<string> {
  if (!relayActiveTabId) return "Error: No active tab.";

  const result = await relay.sendCommand(
    "Runtime.evaluate",
    { expression: "document.body.innerText", returnByValue: true },
    relayActiveTabId
  );

  const text = result?.result?.value || "";
  const truncated = text.length > 15_000 ? text.slice(0, 15_000) + "\n... [truncated]" : text;

  const urlResult = await relay.sendCommand(
    "Runtime.evaluate",
    { expression: "window.location.href", returnByValue: true },
    relayActiveTabId
  );
  const currentUrl = urlResult?.result?.value || "";

  return `Page text content (${currentUrl}):\n\n${truncated}`;
}

async function relayScreenshot(): Promise<string> {
  if (!relayActiveTabId) return "Error: No active tab.";

  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const result = await relay.sendCommand(
    "Page.captureScreenshot",
    { format: "png" },
    relayActiveTabId
  );

  const data = result?.data;
  if (!data) return "Error: Failed to capture screenshot.";

  const filename = `screenshot-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  fs.writeFileSync(filepath, Buffer.from(data, "base64"));
  return `Screenshot saved to: ${filepath}\nUse open_file to view it.`;
}

async function relayWait(args: Record<string, any>): Promise<string> {
  const timeout = Math.min(args.timeout || 10_000, 30_000);
  const waitMs = Math.min(timeout, 10_000);
  await new Promise((r) => setTimeout(r, waitMs));
  return `Waited ${waitMs}ms.`;
}

async function relayTabList(): Promise<string> {
  const tabs = await relay.listTabs();
  if (tabs.length === 0) return "No tabs open.";
  const lines: string[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    const marker = t.tabId === relayActiveTabId ? " (active)" : "";
    lines.push(`[${i}] ${t.url} - ${t.title}${marker}`);
  }
  return `Open tabs:\n${lines.join("\n")}`;
}

async function relayTabNew(args: Record<string, any>): Promise<string> {
  const url = args.url
    ? (args.url.startsWith("http") ? args.url : `https://${args.url}`)
    : undefined;
  const result = await relay.createTab(url);
  relayActiveTabId = result.tabId;
  relayRefMap.clear();
  nextRef = 1;
  return `Opened new tab${url ? ` at ${url}` : ""}. Tab ID: ${result.tabId}`;
}

async function relayTabSwitch(args: Record<string, any>): Promise<string> {
  const idx = args.tab_index;
  if (idx === undefined) return "Error: 'tab_index' is required for tab_switch.";
  const tabs = await relay.listTabs();
  if (idx < 0 || idx >= tabs.length) {
    return `Error: tab index ${idx} out of range (0-${tabs.length - 1}).`;
  }
  const tab = tabs[idx];
  await relay.activateTab(tab.tabId);
  relayActiveTabId = tab.tabId;
  relayRefMap.clear();
  nextRef = 1;
  return `Switched to tab [${idx}]: ${tab.url}`;
}

async function relayTabClose(): Promise<string> {
  if (!relayActiveTabId) return "Error: No active tab.";
  const tabs = await relay.listTabs();
  if (tabs.length <= 1) {
    return "Cannot close the last tab. Use 'close' action to close the browser.";
  }
  const closedTab = tabs.find((t: any) => t.tabId === relayActiveTabId);
  const closedUrl = closedTab?.url || "";
  await relay.closeTab(relayActiveTabId);
  relayActiveTabId = null;
  relayRefMap.clear();
  // Switch to the last remaining tab
  const remaining = await relay.listTabs();
  if (remaining.length > 0) {
    const last = remaining[remaining.length - 1];
    relayActiveTabId = last.tabId;
    await relay.activateTab(last.tabId);
  }
  return `Closed tab (${closedUrl}). Now on: ${remaining.length > 0 ? remaining[remaining.length - 1].url : "no tabs"}`;
}

async function relayBack(): Promise<string> {
  if (!relayActiveTabId) return "Error: No active tab.";
  await relay.sendCommand(
    "Runtime.evaluate",
    { expression: "history.back()", returnByValue: true },
    relayActiveTabId
  );
  await new Promise((r) => setTimeout(r, 1500));
  relayRefMap.clear();
  const urlResult = await relay.sendCommand(
    "Runtime.evaluate",
    { expression: "window.location.href", returnByValue: true },
    relayActiveTabId
  );
  return `Went back to: ${urlResult?.result?.value || "unknown"}`;
}

async function relayForward(): Promise<string> {
  if (!relayActiveTabId) return "Error: No active tab.";
  await relay.sendCommand(
    "Runtime.evaluate",
    { expression: "history.forward()", returnByValue: true },
    relayActiveTabId
  );
  await new Promise((r) => setTimeout(r, 1500));
  relayRefMap.clear();
  const urlResult = await relay.sendCommand(
    "Runtime.evaluate",
    { expression: "window.location.href", returnByValue: true },
    relayActiveTabId
  );
  return `Went forward to: ${urlResult?.result?.value || "unknown"}`;
}

async function relayReload(): Promise<string> {
  if (!relayActiveTabId) return "Error: No active tab.";
  await relay.sendCommand("Page.reload", {}, relayActiveTabId);
  await new Promise((r) => setTimeout(r, 2000));
  relayRefMap.clear();
  const urlResult = await relay.sendCommand(
    "Runtime.evaluate",
    { expression: "window.location.href", returnByValue: true },
    relayActiveTabId
  );
  return `Reloaded: ${urlResult?.result?.value || "unknown"}`;
}

// ===========================================================================
// Playwright-mode action implementations (unchanged from original)
// ===========================================================================

async function actionNavigate(page: Page, args: Record<string, any>): Promise<string> {
  const url = args.url || "";
  if (!url) return "Error: 'url' is required for navigate action.";
  const finalUrl = url.startsWith("http") ? url : `https://${url}`;
  await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  refMap.clear();
  const title = await page.title();
  return `Navigated to: ${page.url()}\nTitle: ${title}\n\nUse action 'snapshot' to see interactive elements on the page.`;
}

async function actionSnapshot(page: Page): Promise<string> {
  return await buildSnapshot(page);
}

async function actionScreenshot(page: Page): Promise<string> {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const filename = `screenshot-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  return `Screenshot saved to: ${filepath}\nUse open_file to view it.`;
}

async function actionClick(page: Page, args: Record<string, any>): Promise<string> {
  const ref = args.ref;
  if (ref === undefined) return "Error: 'ref' is required. Take a snapshot first to get element refs.";
  const locator = resolveRef(page, ref);
  await locator.click({ timeout: 10_000 });
  return `Clicked element [${ref}]. Page may have changed -- take a new snapshot to see current state.`;
}

async function actionType(page: Page, args: Record<string, any>): Promise<string> {
  const ref = args.ref;
  const text = args.text;
  if (ref === undefined) return "Error: 'ref' is required for type action.";
  if (text === undefined) return "Error: 'text' is required for type action.";
  const locator = resolveRef(page, ref);
  await locator.fill(String(text), { timeout: 10_000 });
  const preview = String(text).length > 50 ? String(text).slice(0, 50) + "..." : String(text);
  return `Typed "${preview}" into element [${ref}].`;
}

async function actionSelect(page: Page, args: Record<string, any>): Promise<string> {
  const ref = args.ref;
  const text = args.text;
  if (ref === undefined) return "Error: 'ref' is required for select action.";
  if (!text) return "Error: 'text' (option value or label) is required for select action.";
  const locator = resolveRef(page, ref);
  await locator.selectOption({ label: text }, { timeout: 10_000 });
  return `Selected "${text}" in element [${ref}].`;
}

async function actionCheck(page: Page, args: Record<string, any>): Promise<string> {
  const ref = args.ref;
  if (ref === undefined) return "Error: 'ref' is required for check action.";
  const locator = resolveRef(page, ref);
  await locator.check({ timeout: 10_000 });
  return `Checked element [${ref}].`;
}

async function actionUncheck(page: Page, args: Record<string, any>): Promise<string> {
  const ref = args.ref;
  if (ref === undefined) return "Error: 'ref' is required for uncheck action.";
  const locator = resolveRef(page, ref);
  await locator.uncheck({ timeout: 10_000 });
  return `Unchecked element [${ref}].`;
}

async function actionEvaluate(page: Page, args: Record<string, any>): Promise<string> {
  const expression = args.expression || "";
  if (!expression) return "Error: 'expression' is required for evaluate action.";
  const result = await page.evaluate(expression);
  const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return output.length > 10_000 ? output.slice(0, 10_000) + "\n... [truncated]" : output;
}

async function actionWait(page: Page, args: Record<string, any>): Promise<string> {
  const timeout = Math.min(args.timeout || 10_000, 30_000);

  if (args.selector) {
    await page.waitForSelector(args.selector, { timeout });
    return `Element matching "${args.selector}" appeared.`;
  }

  if (args.text) {
    await page.getByText(args.text).waitFor({ timeout });
    return `Text "${args.text}" appeared on page.`;
  }

  await page.waitForTimeout(Math.min(timeout, 10_000));
  return `Waited ${Math.min(timeout, 10_000)}ms.`;
}

async function actionText(page: Page): Promise<string> {
  const text = await page.innerText("body");
  const truncated = text.length > 15_000 ? text.slice(0, 15_000) + "\n... [truncated]" : text;
  return `Page text content (${page.url()}):\n\n${truncated}`;
}

async function actionTabList(ctx: BrowserContext): Promise<string> {
  const pages = ctx.pages();
  if (pages.length === 0) return "No tabs open.";
  const lines: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const marker = p === activePage ? " (active)" : "";
    const title = await p.title();
    lines.push(`[${i}] ${p.url()} - ${title}${marker}`);
  }
  return `Open tabs:\n${lines.join("\n")}`;
}

async function actionTabNew(ctx: BrowserContext, args: Record<string, any>): Promise<string> {
  const newPage = await ctx.newPage();
  activePage = newPage;
  refMap.clear();
  if (args.url) {
    const url = args.url.startsWith("http") ? args.url : `https://${args.url}`;
    await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  const idx = ctx.pages().indexOf(newPage);
  return `Opened new tab${args.url ? ` at ${newPage.url()}` : ""}. Tab index: ${idx}`;
}

async function actionTabSwitch(ctx: BrowserContext, args: Record<string, any>): Promise<string> {
  const idx = args.tab_index;
  if (idx === undefined) return "Error: 'tab_index' is required for tab_switch.";
  const pages = ctx.pages();
  if (idx < 0 || idx >= pages.length) {
    return `Error: tab index ${idx} out of range (0-${pages.length - 1}).`;
  }
  activePage = pages[idx];
  refMap.clear();
  await activePage.bringToFront();
  return `Switched to tab [${idx}]: ${activePage.url()}`;
}

async function actionTabClose(ctx: BrowserContext, page: Page): Promise<string> {
  const pages = ctx.pages();
  if (pages.length <= 1) {
    return "Cannot close the last tab. Use 'close' action to close the browser.";
  }
  const closedUrl = page.url();
  await page.close();
  const remaining = ctx.pages();
  activePage = remaining[remaining.length - 1];
  refMap.clear();
  return `Closed tab (${closedUrl}). Now on: ${activePage.url()}`;
}

async function actionDownload(page: Page, args: Record<string, any>): Promise<string> {
  const url = args.url || "";
  if (!url) return "Error: 'url' is required for download action.";

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.evaluate((u: string) => {
    const a = document.createElement("a");
    a.href = u;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, url);

  const download = await downloadPromise;
  const suggestedName = download.suggestedFilename();
  const savePath = path.join(DOWNLOADS_DIR, suggestedName);
  await download.saveAs(savePath);
  return `Downloaded: ${savePath} (${suggestedName})`;
}

async function actionBack(page: Page): Promise<string> {
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
  refMap.clear();
  return `Went back to: ${page.url()}`;
}

async function actionForward(page: Page): Promise<string> {
  await page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 });
  refMap.clear();
  return `Went forward to: ${page.url()}`;
}

async function actionReload(page: Page): Promise<string> {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  refMap.clear();
  return `Reloaded: ${page.url()}`;
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function executeBrowserAction(args: Record<string, any>): Promise<string> {
  const action = (args.action || "").trim();

  if (action === "close") {
    await closeBrowser();
    return "Browser closed.";
  }

  await ensureBrowser();

  // Relay mode — use direct CDP commands via extension
  if (connectedViaRelay) {
    switch (action) {
      case "navigate":   return await relayNavigate(args);
      case "snapshot":   return await relaySnapshot();
      case "screenshot": return await relayScreenshot();
      case "click":      return await relayClick(args);
      case "type":       return await relayType(args);
      case "select":     return await relaySelect(args);
      case "check":      return await relayCheck(args, true);
      case "uncheck":    return await relayCheck(args, false);
      case "evaluate":   return await relayEvaluate(args);
      case "wait":       return await relayWait(args);
      case "text":       return await relayText();
      case "tab_list":   return await relayTabList();
      case "tab_new":    return await relayTabNew(args);
      case "tab_switch": return await relayTabSwitch(args);
      case "tab_close":  return await relayTabClose();
      case "back":       return await relayBack();
      case "forward":    return await relayForward();
      case "reload":     return await relayReload();
      case "download":   return "Error: Download is not supported in relay mode.";
      default:
        return (
          `Unknown browser action: "${action}". Valid actions: ` +
          `navigate, snapshot, screenshot, click, type, select, check, uncheck, ` +
          `evaluate, wait, text, tab_list, tab_new, tab_switch, tab_close, ` +
          `back, forward, reload, close.`
        );
    }
  }

  // Playwright mode (CDP or persistent)
  const ctx = context!;
  const page = activePage!;

  switch (action) {
    case "navigate":   return await actionNavigate(page, args);
    case "snapshot":   return await actionSnapshot(page);
    case "screenshot": return await actionScreenshot(page);
    case "click":      return await actionClick(page, args);
    case "type":       return await actionType(page, args);
    case "select":     return await actionSelect(page, args);
    case "check":      return await actionCheck(page, args);
    case "uncheck":    return await actionUncheck(page, args);
    case "evaluate":   return await actionEvaluate(page, args);
    case "wait":       return await actionWait(page, args);
    case "text":       return await actionText(page);
    case "tab_list":   return await actionTabList(ctx);
    case "tab_new":    return await actionTabNew(ctx, args);
    case "tab_switch": return await actionTabSwitch(ctx, args);
    case "tab_close":  return await actionTabClose(ctx, page);
    case "download":   return await actionDownload(page, args);
    case "back":       return await actionBack(page);
    case "forward":    return await actionForward(page);
    case "reload":     return await actionReload(page);
    default:
      return (
        `Unknown browser action: "${action}". Valid actions: ` +
        `navigate, snapshot, screenshot, click, type, select, check, uncheck, ` +
        `evaluate, wait, text, tab_list, tab_new, tab_switch, tab_close, ` +
        `download, back, forward, reload, close.`
      );
  }
}
