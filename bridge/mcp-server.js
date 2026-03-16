#!/usr/bin/env node

/**
 * GDG — MCP Server
 * 
 * Model Context Protocol server that exposes the Graphic Density Grounding
 * browser execution layer as tools any MCP client can use.
 * 
 * Transport: stdio (for Claude Desktop, Cursor, Claude Code, etc.)
 * Talks to the GDG HTTP bridge on localhost:7080.
 * 
 * Setup in Claude Desktop / Cursor / etc:
 * {
 *   "mcpServers": {
 *     "gdg-browser": {
 *       "command": "node",
 *       "args": ["/path/to/mcp-server.js"]
 *     }
 *   }
 * }
 */

const http = require('http');

const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 7080;

// ── Bridge HTTP Client ───────────────────────────────────────────

function bridgeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
    const options = {
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          resolve({ error: 'Failed to parse bridge response' });
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`Bridge not reachable: ${e.message}. Is the GDG extension running?`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Bridge request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ── Tool Definitions ─────────────────────────────────────────────

const TOOLS = [
  {
    name: 'gdg_get_state',
    description: 'Get the current web page state as a spatial text map with numbered interactive elements. The map shows page layout using character density (████ = buttons, ╔══╗ = inputs, ▸ = links). Use mode "numbered" for navigation, "read" for extracting text/table data.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['numbered', 'read', 'actions_only', 'numbered_v2', 'full'],
          description: 'Render mode. "numbered" for navigation (cheap). "read" for text extraction (includes page content and tables). "actions_only" for cheapest scan.',
          default: 'numbered',
        },
      },
    },
  },
  {
    name: 'gdg_click',
    description: 'Click an interactive element by its number from the page state registry.',
    inputSchema: {
      type: 'object',
      properties: {
        element: {
          type: 'integer',
          description: 'Element number from the registry (e.g. 5 for [5])',
        },
      },
      required: ['element'],
    },
  },
  {
    name: 'gdg_fill',
    description: 'Type text into an input field identified by its registry number.',
    inputSchema: {
      type: 'object',
      properties: {
        element: {
          type: 'integer',
          description: 'Input element number from the registry',
        },
        value: {
          type: 'string',
          description: 'Text to type into the field',
        },
      },
      required: ['element', 'value'],
    },
  },
  {
    name: 'gdg_select',
    description: 'Select an option from a dropdown element.',
    inputSchema: {
      type: 'object',
      properties: {
        element: {
          type: 'integer',
          description: 'Select element number from the registry',
        },
        value: {
          type: 'string',
          description: 'Option text or value to select',
        },
      },
      required: ['element', 'value'],
    },
  },
  {
    name: 'gdg_scroll',
    description: 'Scroll the page or a specific scroll container. Use without container to scroll the main page. Provide a container element number to scroll a sidebar, panel, or other scrollable region.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['down', 'up', 'top', 'bottom'],
          description: 'Scroll direction',
          default: 'down',
        },
        container: {
          type: 'integer',
          description: 'Optional: scroll container element number for independent scroll regions (sidebars, panels)',
        },
      },
    },
  },
  {
    name: 'gdg_navigate',
    description: 'Navigate the browser to a URL. Returns the new page state after loading.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to navigate to',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'gdg_keypress',
    description: 'Send a keyboard event. Useful for Enter, Escape, Tab, or keyboard shortcuts.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key name (e.g. "Enter", "Escape", "Tab", "a")',
        },
        ctrl: { type: 'boolean', description: 'Hold Ctrl', default: false },
        shift: { type: 'boolean', description: 'Hold Shift', default: false },
        alt: { type: 'boolean', description: 'Hold Alt', default: false },
        meta: { type: 'boolean', description: 'Hold Meta/Cmd', default: false },
      },
      required: ['key'],
    },
  },
  {
    name: 'gdg_back',
    description: 'Navigate browser back in history.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gdg_hover',
    description: 'Hover over an element to trigger tooltips or dropdown menus.',
    inputSchema: {
      type: 'object',
      properties: {
        element: {
          type: 'integer',
          description: 'Element number to hover over',
        },
      },
      required: ['element'],
    },
  },
  {
    name: 'gdg_tabs',
    description: 'List all open browser tabs with their URLs and titles.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool Execution ───────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {
    case 'gdg_get_state': {
      const mode = args.mode || 'numbered';
      const state = await bridgeRequest('GET', `/state?mode=${mode}`);
      return formatState(state, mode);
    }

    case 'gdg_click': {
      const result = await bridgeRequest('POST', '/action', {
        action: 'click', element: args.element,
      });
      return formatActionResult(result, `Clicked element [${args.element}]`);
    }

    case 'gdg_fill': {
      const result = await bridgeRequest('POST', '/action', {
        action: 'fill', element: args.element, value: args.value,
      });
      return formatActionResult(result, `Filled element [${args.element}] with "${args.value}"`);
    }

    case 'gdg_select': {
      const result = await bridgeRequest('POST', '/action', {
        action: 'select', element: args.element, value: args.value,
      });
      return formatActionResult(result, `Selected "${args.value}" on element [${args.element}]`);
    }

    case 'gdg_scroll': {
      const action = { action: 'scroll', direction: args.direction || 'down' };
      if (args.container !== undefined) action.container = args.container;
      const result = await bridgeRequest('POST', '/action', action);
      const label = args.container
        ? `Scrolled container [${args.container}] ${action.direction}`
        : `Scrolled page ${action.direction}`;
      return formatActionResult(result, label);
    }

    case 'gdg_navigate': {
      const result = await bridgeRequest('POST', '/navigate', { url: args.url });
      if (result.state) {
        return formatState(result.state, 'numbered', `Navigated to ${args.url}`);
      }
      return [{ type: 'text', text: `Navigated to ${args.url}. ${result.error || ''}` }];
    }

    case 'gdg_keypress': {
      const modifiers = {};
      if (args.ctrl) modifiers.ctrl = true;
      if (args.shift) modifiers.shift = true;
      if (args.alt) modifiers.alt = true;
      if (args.meta) modifiers.meta = true;
      const result = await bridgeRequest('POST', '/action', {
        action: 'keypress', key: args.key, modifiers,
      });
      return formatActionResult(result, `Pressed ${args.key}`);
    }

    case 'gdg_back': {
      const result = await bridgeRequest('POST', '/action', { action: 'back' });
      return formatActionResult(result, 'Navigated back');
    }

    case 'gdg_hover': {
      const result = await bridgeRequest('POST', '/action', {
        action: 'hover', element: args.element,
      });
      return formatActionResult(result, `Hovered element [${args.element}]`);
    }

    case 'gdg_tabs': {
      const result = await bridgeRequest('GET', '/tabs');
      const tabList = (result.tabs || [])
        .map(t => `${t.active ? '▸ ' : '  '}[${t.id}] ${t.title || 'Untitled'}\n    ${t.url}`)
        .join('\n');
      return [{ type: 'text', text: `Open tabs (${result.count || 0}):\n${tabList}` }];
    }

    default:
      return [{ type: 'text', text: `Unknown tool: ${name}` }];
  }
}

// ── Response Formatters ──────────────────────────────────────────

function formatState(state, mode, prefix = '') {
  const parts = [];

  if (prefix) parts.push(prefix);
  parts.push(`URL: ${state.url || '?'}`);
  parts.push(`Title: ${state.title || '?'}`);

  if (state.scroll) {
    const s = state.scroll;
    parts.push(`Scroll: ${s.scrollPercent}% | Page ${s.currentPage}/${s.totalPages}`);
  }

  if (state.meta?.hasModal) {
    parts.push(`\n⚠ MODAL ACTIVE — interact with modal elements first`);
  }

  parts.push('');
  if (state.map) parts.push(state.map);

  if (state.registry) {
    parts.push('\n── Elements ──');
    for (const e of state.registry) {
      let line = `  [${e.id}] ${(e.type || '').padEnd(15)} ${e.label || ''}`;
      if (e.actions) line += `  ${e.actions.join(', ')}`;
      if (e.form) line += `  {${e.form}}`;
      if (e.layer) line += `  [${e.layer.layer}]`;
      if (e.scrollState) line += `  [scroll:${e.scrollState.scrollPercent}%]`;
      parts.push(line);
    }
  }

  if (mode === 'read') {
    if (state.content) {
      parts.push('\n── Page content ──');
      parts.push(state.content);
    }
    if (state.tables) {
      parts.push('\n── Tables ──');
      parts.push(state.tables);
    }
  }

  return [{ type: 'text', text: parts.join('\n') }];
}

function formatActionResult(result, label) {
  const parts = [label];

  if (!result.success) {
    parts.push(`✗ Failed: ${result.error || 'Unknown error'}`);
    if (result.available) {
      parts.push(`Available elements: ${result.available.map(e => `[${e.id}] ${e.label}`).join(', ')}`);
    }
    return [{ type: 'text', text: parts.join('\n') }];
  }

  parts.push('✓ OK');

  // Include new state if returned
  if (result.newState) {
    const stateLines = formatState(result.newState, result.newState.mode || 'numbered');
    parts.push('');
    parts.push(stateLines[0].text);
  } else if (result.scroll) {
    parts.push(`Scroll: ${result.scroll.scrollPercent}% | Page ${result.scroll.currentPage}/${result.scroll.totalPages}`);
  }

  return [{ type: 'text', text: parts.join('\n') }];
}

// ── JSON-RPC / MCP Protocol Handler ──────────────────────────────

function handleMessage(msg) {
  const { method, id, params } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'gdg-browser',
            version: '0.2.0',
          },
        },
      };

    case 'initialized':
      // Notification — no response needed
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS,
        },
      };

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      // Return a promise-based response
      return executeTool(toolName, toolArgs)
        .then((content) => ({
          jsonrpc: '2.0',
          id,
          result: { content },
        }))
        .catch((err) => ({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          },
        }));
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

// ── stdio Transport ──────────────────────────────────────────────

let inputBuffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', async (chunk) => {
  inputBuffer += chunk;

  // Process complete lines (newline-delimited JSON)
  const lines = inputBuffer.split('\n');
  inputBuffer = lines.pop(); // Keep incomplete line in buffer

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const msg = JSON.parse(trimmed);
      const response = handleMessage(msg);

      if (response === null) continue; // Notification, no response

      // Handle async responses (tool calls)
      const resolved = await Promise.resolve(response);
      sendResponse(resolved);
    } catch (e) {
      // Parse error
      sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${e.message}` },
      });
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

function sendResponse(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + '\n');
}

// Suppress unhandled rejection crashes
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[GDG MCP] Unhandled: ${err.message}\n`);
});

process.stderr.write('[GDG MCP] Server started. Waiting for messages...\n');
