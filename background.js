/**
 * Graphic Density — Background Service Worker (Phase 4)
 * 
 * Handles:
 * - Popup ↔ content script message routing
 * - Native messaging bridge ↔ content script API routing
 * - Tab-aware message targeting (not just active tab)
 * - Navigation control
 * - Tab state tracking
 */

// ── State ────────────────────────────────────────────────────────

let nativePort = null;
let bridgeReady = false;
const tabStates = new Map();

// ── Native Messaging Connection ──────────────────────────────────

function connectNativeBridge() {
  try {
    nativePort = chrome.runtime.connectNative('com.graphicdensity.bridge');

    nativePort.onMessage.addListener((msg) => {
      if (msg.type === 'BRIDGE_READY') {
        bridgeReady = true;
        nativePort.postMessage({ type: 'CONNECTED' });
        console.log('[GD] Bridge connected. API available at http://127.0.0.1:7080');
        return;
      }

      // API request from bridge — route to content script
      if (msg.requestId !== undefined) {
        handleApiRequest(msg).then((response) => {
          nativePort.postMessage({ requestId: msg.requestId, response });
        }).catch((err) => {
          nativePort.postMessage({ requestId: msg.requestId, response: { error: err.message } });
        });
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || 'unknown';
      console.log(`[GD] Bridge disconnected: ${err}`);
      nativePort = null;
      bridgeReady = false;
      setTimeout(connectNativeBridge, 5000);
    });

    console.log('[GD] Connecting to native bridge...');
  } catch (err) {
    console.log(`[GD] Native bridge not available: ${err.message}`);
    console.log('[GD] Run bridge/install.sh to set up the API layer.');
    setTimeout(connectNativeBridge, 15000);
  }
}

// ── API Request Router ───────────────────────────────────────────

async function handleApiRequest(msg) {
  switch (msg.type) {
    case 'API_GET_STATE':
      return await sendToTab(msg.tabId, {
        type: 'GET_STATE',
        mode: msg.mode || 'numbered',
      });

    case 'API_GET_ENVIRONMENT':
      return await sendToTab(msg.tabId, { type: 'GET_ENVIRONMENT' });

    case 'API_EXECUTE_ACTION':
      return await sendToTab(msg.tabId, {
        type: 'EXECUTE_ACTION',
        action: msg.action,
      });

    case 'API_EXECUTE_BATCH':
      return await sendToTab(msg.tabId, {
        type: 'EXECUTE_BATCH',
        actions: msg.actions,
      });

    case 'API_GET_HISTORY':
      return await sendToTab(msg.tabId, { type: 'GET_HISTORY' });

    case 'API_CLEAR_HISTORY':
      return await sendToTab(msg.tabId, { type: 'CLEAR_HISTORY' });

    case 'API_NAVIGATE':
      return await navigateTab(msg.url, msg.tabId);

    case 'API_GET_TABS':
      return await getTabList();

    default:
      return { error: `Unknown API request type: ${msg.type}` };
  }
}

// ── Tab-Aware Message Sending ────────────────────────────────────

async function sendToTab(targetTabId, message) {
  const tabId = targetTabId || await getActiveTabId();
  if (!tabId) {
    return { error: 'No active tab found.' };
  }

  await ensureContentScript(tabId);

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { error: 'Empty response from content script.' });
      }
    });
  });
}

async function ensureContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['renderer.js'] },
          () => {
            if (chrome.runtime.lastError) {
              console.log(`[GD] Cannot inject into tab ${tabId}: ${chrome.runtime.lastError.message}`);
            }
            setTimeout(resolve, 200);
          }
        );
      } else {
        resolve();
      }
    });
  });
}

async function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id || null);
    });
  });
}

// ── Navigation ───────────────────────────────────────────────────

async function navigateTab(url, tabId) {
  const targetTabId = tabId || await getActiveTabId();

  if (!targetTabId) {
    return { error: 'No active tab found.' };
  }

  return new Promise((resolve) => {
    chrome.tabs.update(targetTabId, { url }, () => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === targetTabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);

          setTimeout(async () => {
            const state = await sendToTab(targetTabId, {
              type: 'GET_STATE',
              mode: 'numbered',
            });
            resolve({
              success: true,
              tabId: targetTabId,
              url,
              state,
            });
          }, 500);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);

      // Timeout failsafe
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ success: true, tabId: targetTabId, url, state: null, note: 'Page load timeout.' });
      }, 15000);
    });
  });
}

// ── Tab Listing ──────────────────────────────────────────────────

async function getTabList() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      const tabList = tabs.map(tab => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        windowId: tab.windowId,
        index: tab.index,
        lastAccessed: tabStates.get(tab.id)?.lastUpdate || null,
      }));
      resolve({ tabs: tabList, count: tabList.length });
    });
  });
}

// ── Popup Message Routing ────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'content') {
    sendToTab(null, msg.payload).then((response) => {
      sendResponse(response);
    });
    return true;
  }
});

// ── External Connection Handler ──────────────────────────────────

chrome.runtime.onConnectExternal?.addListener((port) => {
  console.log('[GD] External connection from:', port.sender?.origin);

  port.onMessage.addListener(async (msg) => {
    const response = await handleApiRequest(msg);
    port.postMessage(response);
  });
});

// ── Tab State Tracking ───────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    tabStates.set(tabId, {
      url: tab.url,
      title: tab.title,
      lastUpdate: Date.now(),
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

// ── Startup ──────────────────────────────────────────────────────

connectNativeBridge();
console.log('[Graphic Density] Phase 4 service worker started.');
