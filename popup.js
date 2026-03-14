/**
 * Graphic Density - Phase 2 Popup Controller
 * Handles state viewing, action execution, and history.
 */

// ── DOM References ───────────────────────────────────────────────

const output = document.getElementById('output');
const scanBtn = document.getElementById('scanBtn');
const copyBtn = document.getElementById('copyBtn');
const metaTotal = document.getElementById('metaTotal');
const metaInteractive = document.getElementById('metaInteractive');
const metaTokens = document.getElementById('metaTokens');
const metaType = document.getElementById('metaType');
const scrollPos = document.getElementById('scrollPos');
const scrollPage = document.getElementById('scrollPage');
const modeBtns = document.querySelectorAll('.mode-btn');
const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');

// Action tab
const actionType = document.getElementById('actionType');
const actionElement = document.getElementById('actionElement');
const actionValue = document.getElementById('actionValue');
const execBtn = document.getElementById('execBtn');
const actionResults = document.getElementById('actionResults');
const shortcuts = document.querySelectorAll('.shortcut-btn');

// History tab
const refreshHistoryBtn = document.getElementById('refreshHistory');
const clearHistoryBtn = document.getElementById('clearHistory');
const copyHistoryBtn = document.getElementById('copyHistory');
const historyList = document.getElementById('historyList');

let currentMode = 'full';
let lastResult = null;
let actionResultCount = 0;

// ── Tab Switching ────────────────────────────────────────────────

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(tc => tc.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    // Auto-refresh history when switching to that tab
    if (tab.dataset.tab === 'history') {
      loadHistory();
    }
  });
});

// ── Mode Selection ───────────────────────────────────────────────

modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    if (lastResult) doScan();
  });
});

// ── Scan ─────────────────────────────────────────────────────────

scanBtn.addEventListener('click', doScan);

function doScan() {
  scanBtn.disabled = true;
  scanBtn.textContent = 'Scanning...';
  output.textContent = '';
  output.classList.remove('has-content');

  sendToContent({ type: 'GET_STATE', mode: currentMode }, (response) => {
    scanBtn.disabled = false;
    scanBtn.textContent = 'Scan Page';

    if (!response || response.error) {
      output.textContent = `Error: ${response?.error || 'No response from content script.'}\n\nMake sure you're on a regular web page (not chrome:// or extension pages).`;
      return;
    }

    lastResult = response;
    displayResult(response);
  });
}

function displayResult(result) {
  output.classList.add('has-content');

  let displayText = result.map;

  // Registry display for numbered modes
  if (['numbered', 'numbered_v2', 'read'].includes(result.mode) && result.registry) {
    displayText += '\n\n── Element Registry ─────────────────\n';
    result.registry.forEach(entry => {
      const pos = `(${entry.center.x}, ${entry.center.y})`;
      let line = `  [${entry.id}] ${entry.type.padEnd(18)} ${pos.padEnd(14)} ${entry.label}`;

      // v0.2: action hints
      if (entry.actions) {
        line += `  ${entry.actions.join(', ')}`;
      }

      // v0.2: form grouping
      if (entry.form) {
        line += `  {${entry.form}}`;
      }

      // v0.2: layer info
      if (entry.layer) {
        line += `  [${entry.layer.layer}]`;
      }

      // Scroll metadata
      if (entry.type === 'scroll_container' && entry.scrollState) {
        const s = entry.scrollState;
        const arrows = `${s.canScrollUp ? '▲' : '·'}${s.canScrollDown ? '▼' : '·'}`;
        line += ` [${s.scrollPercent}% ${arrows}]`;
      }

      displayText += line + '\n';
    });
  }

  // Read mode: content and tables
  if (result.mode === 'read') {
    if (result.content) {
      displayText += '\n── Page Content ─────────────────────\n';
      displayText += result.content;
    }
    if (result.tables) {
      displayText += '\n── Tables ───────────────────────────\n';
      displayText += result.tables;
    }
  }

  // Modal warning
  if (result.meta?.hasModal) {
    displayText = `⚠ MODAL ACTIVE — interact with elements ${result.meta.modalElements?.join(', ') || '?'} first\n\n` + displayText;
  }

  output.textContent = displayText;

  // Meta
  const charCount = (result.map || '').length + (result.content || '').length + (result.tables || '').length;
  const estimatedTokens = Math.ceil(charCount / 3.5);

  if (result.stats) {
    metaTotal.textContent = result.stats.totalElements;
    metaInteractive.textContent = result.stats.interactiveElements;
  } else if (result.meta) {
    metaTotal.textContent = result.meta.elementCount + ' interactive';
    metaInteractive.textContent = result.meta.elementCount;
    if (result.meta.textBlocks) {
      metaTotal.textContent += ` + ${result.meta.textBlocks} text`;
    }
  }

  metaTokens.textContent = `~${estimatedTokens.toLocaleString()}`;

  // Scroll context
  if (result.scroll) {
    scrollPos.textContent = `${result.scroll.scrollPercent}%`;
    scrollPage.textContent = `${result.scroll.currentPage}/${result.scroll.totalPages}`;
  }

  // Page type
  metaType.textContent = result.pageType || result.meta?.hasModal ? 'modal' : '-';
}

// ── Action Execution ─────────────────────────────────────────────

execBtn.addEventListener('click', executeFromUI);

// Also execute on Enter in value field
actionValue.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') executeFromUI();
});

function executeFromUI() {
  const action = buildActionFromUI();
  if (!action) return;
  executeAndDisplay(action);
}

function buildActionFromUI() {
  const type = actionType.value;
  const element = actionElement.value ? parseInt(actionElement.value) : undefined;
  const value = actionValue.value || undefined;

  const action = { action: type };

  // Element-targeted actions
  if (['click', 'fill', 'clear', 'select', 'hover', 'focus'].includes(type)) {
    if (!element && element !== 0) {
      addActionResult({ error: 'Element number required for this action.' }, action);
      return null;
    }
    action.element = element;
  }

  // Scroll with an element ID → container scroll
  if (type === 'scroll' && element !== undefined) {
    action.container = element;
  }

  // Value-required actions
  if (type === 'fill' || type === 'select') {
    action.value = value || '';
  }

  // Scroll direction
  if (type === 'scroll') {
    action.direction = value || 'down';
  }

  // Keypress
  if (type === 'keypress') {
    action.key = value || 'Enter';
  }

  return action;
}

function executeAndDisplay(action) {
  execBtn.disabled = true;
  execBtn.textContent = 'Running...';

  sendToContent({ type: 'EXECUTE_ACTION', action }, (response) => {
    execBtn.disabled = false;
    execBtn.textContent = 'Execute';

    if (!response) {
      addActionResult({ error: 'No response from content script.' }, action);
      return;
    }

    addActionResult(response, action);

    // If action returned new state, update our state tab too
    if (response.newState) {
      lastResult = response.newState;
    }
  });
}

function addActionResult(response, action) {
  // Clear placeholder
  if (actionResultCount === 0) {
    actionResults.innerHTML = '';
  }
  actionResultCount++;

  const entry = document.createElement('div');
  entry.className = 'result-entry';

  const isSuccess = response.success;
  const statusClass = isSuccess ? 'success' : 'failure';
  const statusIcon = isSuccess ? '✓' : '✗';
  const actionLabel = `${action.action}${action.element !== undefined ? ` [${action.element}]` : ''}`;

  let html = `<span class="action-label">${actionLabel}</span> `;
  html += `<span class="${statusClass}">${statusIcon} ${isSuccess ? 'OK' : response.error || 'Failed'}</span>`;

  if (response.label) {
    html += `<span style="color:#8b949e;"> — "${response.label}"</span>`;
  }

  if (response.scroll) {
    html += `<br><span style="color:#484f58; font-size:9px;">Scroll: ${response.scroll.scrollPercent}% · Page ${response.scroll.currentPage}/${response.scroll.totalPages}</span>`;
  }

  // Expandable new state preview
  if (response.newState) {
    const stateId = `state-preview-${actionResultCount}`;
    html += `<br><span class="new-state-toggle" onclick="document.getElementById('${stateId}').classList.toggle('open')">▸ Show new state</span>`;

    let statePreview = response.newState.map || '';
    if (response.newState.registry) {
      statePreview += '\n\n── Registry ──\n';
      response.newState.registry.forEach(e => {
        statePreview += `[${e.id}] ${e.type.padEnd(12)} ${e.label}\n`;
      });
    }
    html += `<div class="state-preview" id="${stateId}">${escapeHtml(statePreview)}</div>`;
  }

  // Error details
  if (!isSuccess && response.available) {
    html += `<div class="detail">Available elements: ${response.available.map(e => `[${e.id}] ${e.label}`).join(', ')}</div>`;
  }

  entry.innerHTML = html;
  actionResults.insertBefore(entry, actionResults.firstChild);
}

// ── Shortcut Buttons ─────────────────────────────────────────────

shortcuts.forEach(btn => {
  btn.addEventListener('click', () => {
    const action = JSON.parse(btn.dataset.action);
    executeAndDisplay(action);
  });
});

// ── History Tab ──────────────────────────────────────────────────

refreshHistoryBtn.addEventListener('click', loadHistory);

clearHistoryBtn.addEventListener('click', () => {
  sendToContent({ type: 'CLEAR_HISTORY' }, () => {
    historyList.innerHTML = '<div style="color: #484f58; font-size: 10px; padding: 20px 0; text-align: center;">History cleared.</div>';
  });
});

copyHistoryBtn.addEventListener('click', () => {
  sendToContent({ type: 'GET_HISTORY' }, (response) => {
    if (response) {
      navigator.clipboard.writeText(JSON.stringify(response, null, 2)).then(() => {
        copyHistoryBtn.textContent = 'Copied!';
        setTimeout(() => { copyHistoryBtn.textContent = 'Copy JSON'; }, 1500);
      });
    }
  });
});

function loadHistory() {
  sendToContent({ type: 'GET_HISTORY' }, (response) => {
    if (!response || !response.actions || response.actions.length === 0) {
      historyList.innerHTML = '<div style="color: #484f58; font-size: 10px; padding: 20px 0; text-align: center;">No actions recorded yet.</div>';
      return;
    }

    historyList.innerHTML = '';
    response.actions.forEach((a, i) => {
      const entry = document.createElement('div');
      entry.className = 'result-entry';
      const time = new Date(a.timestamp).toLocaleTimeString();
      let desc = `${a.action}`;
      if (a.element) desc += ` [${a.element}]`;
      if (a.label) desc += ` "${a.label}"`;
      if (a.value) desc += ` = "${a.value}"`;
      if (a.direction) desc += ` ${a.direction}`;
      entry.innerHTML = `<span style="color:#484f58;">${i + 1}.</span> <span class="action-label">${desc}</span> <span style="color:#484f58; font-size:9px;">${time}</span>`;
      historyList.appendChild(entry);
    });
  });
}

// ── Copy State ───────────────────────────────────────────────────

copyBtn.addEventListener('click', () => {
  if (!lastResult) return;

  let copyText;
  if (currentMode === 'numbered') {
    const { map, registry, meta, scroll } = lastResult;
    copyText = JSON.stringify({ map, registry, meta, scroll }, null, 2);
  } else {
    copyText = lastResult.map;
  }

  navigator.clipboard.writeText(copyText).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });
});

// ── Communication Helper ─────────────────────────────────────────

function sendToContent(payload, callback) {
  chrome.runtime.sendMessage(
    { target: 'content', payload },
    (response) => {
      if (chrome.runtime.lastError) {
        callback({ error: chrome.runtime.lastError.message });
      } else {
        callback(response);
      }
    }
  );
}

// ── Utility ──────────────────────────────────────────────────────

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
