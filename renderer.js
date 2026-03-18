/**
 * Graphic Density Renderer v0.3
 * Converts live DOM into spatial text representations for AI consumption.
 * 
 * Render modes:
 *   - "full"         → complete page with density-based element typing
 *   - "actions_only" → sparse map showing only interactive elements
 *   - "numbered"     → interactive elements labeled with numbers + coordinate registry
 *   - "numbered_v2"  → numbered + interaction hints, form groups, layer info
 *   - "read"         → numbered_v2 + readable text content + table extraction
 *   - "oneshot"      → full page scan (beyond viewport) with section markers
 *   - "flow"         → scan hidden DOM elements for multi-step form detection
 *   - "diff"         → only return what changed since last scan
 */

(() => {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────
  const CONFIG = {
    // Grid resolution: each cell represents this many pixels
    cellWidth: 16,
    cellHeight: 16,
    // Maximum grid dimensions (prevents runaway on huge pages)
    maxCols: 140,
    maxRows: 80,
    // For oneshot mode: max page height in viewports (prevents infinite scroll explosion)
    maxPageViewports: 6,
    // Minimum element size to include (pixels)
    minElementWidth: 8,
    minElementHeight: 8,
  };

  // ── Density Characters ─────────────────────────────────────────
  // Ordered by visual weight: heaviest = most interactive
  const DENSITY = {
    empty:        ' ',
    background:   '░',
    text:         '·',
    heading:      '▪',
    image:        '◻',
    container:    '│',
    containerH:   '─',
    cornerTL:     '┌',
    cornerTR:     '┐',
    cornerBL:     '└',
    cornerBR:     '┘',
    inputFill:    '▒',
    inputBorderH: '═',
    inputBorderV: '║',
    inputTL:      '╔',
    inputTR:      '╗',
    inputBL:      '╚',
    inputBR:      '╝',
    link:         '▸',
    buttonFill:   '█',
    buttonActive: '▓',
    select:       '▼',
    checkbox:     '☐',
    checked:      '☑',
    radio:        '○',
    radioChecked: '●',
    nav:          '━',
  };

  // ── Element Classification ─────────────────────────────────────

  function classifyElement(el) {
    const tag = el.tagName?.toLowerCase();
    const role = el.getAttribute('role');
    const type = el.getAttribute('type');

    // Buttons
    if (tag === 'button' || role === 'button' || type === 'submit' || type === 'button') {
      return 'button';
    }

    // Text inputs
    if (tag === 'input' && (!type || ['text','email','password','search','tel','url','number','date','time','datetime-local'].includes(type))) {
      return 'input';
    }
    if (tag === 'textarea') return 'input';

    // Contenteditable elements (rich text editors, custom inputs)
    if (el.isContentEditable && el.getAttribute('contenteditable') === 'true') {
      return 'input';
    }

    // Checkboxes and radios
    if (tag === 'input' && type === 'checkbox') {
      return el.checked ? 'checkbox_checked' : 'checkbox';
    }
    if (tag === 'input' && type === 'radio') {
      return el.checked ? 'radio_checked' : 'radio';
    }

    // Select dropdowns
    if (tag === 'select') return 'select';

    // Links
    if (tag === 'a' && el.href) return 'link';

    // Dialog / modal detection
    if (tag === 'dialog') return 'container';

    // Clickable elements — expanded detection
    if (role === 'tab' || role === 'menuitem' || role === 'option' || role === 'switch'
      || role === 'combobox' || role === 'listbox' || role === 'treeitem'
      || role === 'gridcell' || role === 'link') {
      return role === 'link' ? 'link' : 'button';
    }
    if (role === 'searchbox' || role === 'textbox') return 'input';

    // Elements with click handlers or cursor pointer
    if (el.tabIndex >= 0 && el.onclick) return 'button';
    if (el.tabIndex >= 0 && tag !== 'div' && tag !== 'span') return 'button';

    // Detect click-styled elements (cursor pointer + non-generic tag or with aria)
    try {
      const computed = window.getComputedStyle(el);
      if (computed.cursor === 'pointer') {
        if (el.getAttribute('aria-label') || el.getAttribute('data-action')
          || el.getAttribute('data-testid') || role) {
          return 'button';
        }
        // Pointer cursor on elements with short text = likely a clickable control
        const text = el.innerText?.trim();
        if (text && text.length < 40 && !el.querySelector('a, button, input')) {
          return 'button';
        }
      }
    } catch (e) { /* getComputedStyle can throw on some elements */ }

    // Summary/details (collapsible)
    if (tag === 'summary') return 'button';
    if (tag === 'details') return 'container';

    // Headings
    if (/^h[1-6]$/.test(tag)) return 'heading';

    // Images
    if (tag === 'img' || tag === 'svg' || role === 'img') return 'image';
    if (tag === 'picture' || tag === 'video') return 'image';

    // Navigation
    if (tag === 'nav' || role === 'navigation') return 'nav';

    // Generic containers we might want to outline
    if (['div','section','article','main','aside','header','footer','form'].includes(tag)) {
      return 'container';
    }

    // Text nodes / paragraphs / spans with visible text
    if (['p','span','label','li','td','th','dt','dd','figcaption','blockquote','pre','code'].includes(tag)) {
      return 'text';
    }

    return 'unknown';
  }

  function isInteractive(type) {
    return ['button','input','select','link','checkbox','checkbox_checked','radio','radio_checked','scroll_container'].includes(type);
  }

  // ── Visibility Checks ──────────────────────────────────────────

  function isVisible(el) {
    if (!el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < CONFIG.minElementWidth || rect.height < CONFIG.minElementHeight) return false;
    return true;
  }

  function isInViewport(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  }

  // ── DOM Scanner (Enhanced) ────────────────────────────────────
  // Traverses: regular DOM, shadow DOMs, open dialogs, React portals,
  // popover/top-layer elements, and same-origin iframes.
  // Also detects scrollable containers as first-class elements.

  function scanElements(viewportOnly = true) {
    const elements = [];
    const seen = new Set();

    // Collect all root nodes to scan
    const roots = collectRoots();

    for (const root of roots) {
      deepWalk(root, elements, seen, viewportOnly);
    }

    // Detect scroll containers
    detectScrollContainers(elements, seen, viewportOnly);

    // Sort by z-index so higher elements render on top
    elements.sort((a, b) => a.zIndex - b.zIndex);
    return elements;
  }

  // ── Root Collection ────────────────────────────────────────────
  // Gathers all DOM roots that need scanning beyond document.body

  function collectRoots() {
    const roots = [document.body];

    // Open <dialog> elements (native HTML dialog, used by GitHub etc.)
    document.querySelectorAll('dialog[open]').forEach(d => {
      if (!roots.includes(d)) roots.push(d);
    });

    // Elements with popover attribute that are showing
    document.querySelectorAll('[popover]:popover-open').forEach(p => {
      if (!roots.includes(p)) roots.push(p);
    });

    // React portals and generic overlay containers
    // These commonly live as direct children of document.body with high z-index
    // or in known portal container patterns
    const portalSelectors = [
      '[data-portal]',
      '[data-radix-portal]',
      '[data-headlessui-portal]',
      '[data-reach-portal]',
      '[data-overlay-container]',
      '[class*="portal"]',
      '[class*="Portal"]',
      '[class*="overlay"]',
      '[class*="Overlay"]',
      '[class*="modal"]',
      '[class*="Modal"]',
      '[class*="dialog"]',
      '[class*="Dialog"]',
      '[class*="dropdown"]',
      '[class*="Dropdown"]',
      '[class*="popover"]',
      '[class*="Popover"]',
      '[class*="tooltip"]',
      '[class*="Tooltip"]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[role="menu"]',
      '[role="listbox"]',
      '[role="combobox"]',
      '[aria-modal="true"]',
    ];

    for (const sel of portalSelectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          // Only add if it has visible content and isn't already under body walk
          if (el.offsetParent !== null || el.getBoundingClientRect().height > 0) {
            if (!roots.includes(el)) roots.push(el);
          }
        });
      } catch (e) { /* selector might be invalid in some browsers */ }
    }

    return roots;
  }

  // ── Deep Walk ──────────────────────────────────────────────────
  // Recursively walks a DOM subtree, entering shadow roots and
  // same-origin iframes

  function deepWalk(root, elements, seen, viewportOnly) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          // Don't reject invisible nodes outright — we need to enter them
          // to find shadow roots and portals inside
          if (!node.getBoundingClientRect) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node = root;
    // Process root itself if it's not document.body
    if (root !== document.body) {
      processNode(root, elements, seen, viewportOnly);
    }

    while (node = walker.nextNode()) {
      // Enter shadow DOM
      if (node.shadowRoot) {
        deepWalk(node.shadowRoot, elements, seen, viewportOnly);
      }

      // Enter same-origin iframes
      if (node.tagName?.toLowerCase() === 'iframe') {
        try {
          const iframeDoc = node.contentDocument;
          if (iframeDoc?.body) {
            deepWalk(iframeDoc.body, elements, seen, viewportOnly);
          }
        } catch (e) { /* cross-origin iframe, skip */ }
      }

      processNode(node, elements, seen, viewportOnly);
    }
  }

  function processNode(node, elements, seen, viewportOnly) {
    if (!isVisible(node)) return;

    const type = classifyElement(node);
    if (type === 'unknown' || type === 'container') return;

    const rect = node.getBoundingClientRect();
    if (viewportOnly && !isInViewport(rect)) return;

    // Deduplicate: skip elements that occupy nearly the same rect
    const key = `${Math.round(rect.left/8)},${Math.round(rect.top/8)},${Math.round(rect.width/8)},${Math.round(rect.height/8)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const label = getElementLabel(node, type);

    elements.push({
      node,
      type,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      label,
      interactive: isInteractive(type),
      zIndex: getEffectiveZIndex(node),
    });
  }

  // ── Effective Z-Index ──────────────────────────────────────────
  // Walk up the tree to find the highest stacking context

  function getEffectiveZIndex(node) {
    let z = 0;
    let el = node;
    let depth = 0;
    while (el && el !== document.body && depth < 10) {
      const style = window.getComputedStyle(el);
      const zVal = parseInt(style.zIndex);
      if (!isNaN(zVal) && zVal > z) z = zVal;
      // Dialog/modal elements get a boost to ensure they render on top
      if (el.tagName?.toLowerCase() === 'dialog' || style.position === 'fixed') {
        z = Math.max(z, 10000);
      }
      el = el.parentElement;
      depth++;
    }
    return z;
  }

  // ── Scroll Container Detection ─────────────────────────────────

  function detectScrollContainers(elements, seen, viewportOnly) {
    const candidates = document.querySelectorAll('*');

    for (const el of candidates) {
      if (!isVisible(el)) continue;

      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;

      const scrollsVertically = (overflowY === 'auto' || overflowY === 'scroll')
        && el.scrollHeight > el.clientHeight + 10;
      const scrollsHorizontally = (overflowX === 'auto' || overflowX === 'scroll')
        && el.scrollWidth > el.clientWidth + 10;

      if (!scrollsVertically && !scrollsHorizontally) continue;

      // Skip if it's the main document scroller
      if (el === document.body || el === document.documentElement) continue;

      // Skip tiny scroll containers (likely internal UI components)
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) continue;

      if (viewportOnly && !isInViewport(rect)) continue;

      const key = `sc:${Math.round(rect.left/8)},${Math.round(rect.top/8)},${Math.round(rect.width/8)},${Math.round(rect.height/8)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Try to identify what this container holds
      const label = getScrollContainerLabel(el);

      const scrollPercent = scrollsVertically
        ? Math.round((el.scrollTop / (el.scrollHeight - el.clientHeight)) * 100)
        : 0;

      elements.push({
        node: el,
        type: 'scroll_container',
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        label,
        interactive: true,
        zIndex: parseInt(style.zIndex) || 0,
        scrollable: {
          vertical: scrollsVertically,
          horizontal: scrollsHorizontally,
        },
        scrollState: {
          scrollTop: el.scrollTop,
          scrollLeft: el.scrollLeft,
          scrollHeight: el.scrollHeight,
          scrollWidth: el.scrollWidth,
          clientHeight: el.clientHeight,
          clientWidth: el.clientWidth,
          scrollPercent,
          canScrollUp: el.scrollTop > 0,
          canScrollDown: el.scrollTop + el.clientHeight < el.scrollHeight - 10,
        },
      });
    }
  }

  function getScrollContainerLabel(el) {
    // Try aria-label first
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `scroll: ${ariaLabel.substring(0, 25)}`;

    // Try role
    const role = el.getAttribute('role');
    if (role) return `scroll: ${role}`;

    // Try to identify by landmark class names
    const cls = el.className?.toString() || '';
    const patterns = ['sidebar', 'panel', 'list', 'feed', 'content', 'main', 'chat', 'messages', 'thread', 'menu', 'nav', 'body', 'scroll'];
    for (const p of patterns) {
      if (cls.toLowerCase().includes(p)) return `scroll: ${p}`;
    }

    // Try tag-based identification
    const tag = el.tagName?.toLowerCase();
    if (tag === 'nav') return 'scroll: navigation';
    if (tag === 'aside') return 'scroll: sidebar';
    if (tag === 'main') return 'scroll: main content';

    return 'scroll: container';
  }

  function getElementLabel(el, type) {
    // Priority: aria-label > innerText > placeholder > alt > title > value
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim().substring(0, 30);

    if (type === 'button' || type === 'link' || type === 'heading') {
      const text = el.innerText?.trim();
      if (text) return text.substring(0, 30);
    }

    if (type === 'input') {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim().substring(0, 30);
      // Check for associated label
      const id = el.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.innerText?.trim().substring(0, 30);
      }
    }

    if (type === 'image') {
      return el.getAttribute('alt')?.trim().substring(0, 20) || 'img';
    }

    const title = el.getAttribute('title');
    if (title) return title.trim().substring(0, 30);

    return '';
  }

  // ── v0.2: Interaction Type Hints ───────────────────────────────

  function getActionHints(node, type) {
    switch (type) {
      case 'button':
        // Check if it's a submit button inside a form
        if (node.type === 'submit' || node.getAttribute('type') === 'submit') {
          return ['click → submit'];
        }
        return ['click'];

      case 'input': {
        const inputType = node.getAttribute('type') || 'text';
        if (inputType === 'file') return ['upload'];
        return ['fill', 'clear'];
      }

      case 'select':
        return ['select'];

      case 'checkbox':
      case 'checkbox_checked':
        return ['toggle'];

      case 'radio':
      case 'radio_checked':
        return ['select'];

      case 'link': {
        const href = node.getAttribute('href') || '';
        // In-page links
        if (href.startsWith('#') || href.startsWith('javascript:')) {
          return ['click → in-page'];
        }
        // Same-origin navigation
        try {
          const linkUrl = new URL(href, window.location.origin);
          if (linkUrl.origin === window.location.origin) {
            return ['click → nav'];
          }
          return ['click → external'];
        } catch {
          return ['click → nav'];
        }
      }

      case 'scroll_container':
        return ['scroll'];

      default:
        return ['click'];
    }
  }

  // ── v0.2: Form Grouping ────────────────────────────────────────

  function getFormGroup(node) {
    // Walk up to find parent <form>
    let parent = node.parentElement;
    let depth = 0;
    while (parent && depth < 15) {
      if (parent.tagName?.toLowerCase() === 'form') {
        const formName = parent.getAttribute('name')
          || parent.getAttribute('id')
          || parent.getAttribute('aria-label')
          || parent.getAttribute('action')?.split('/').pop()
          || null;
        return formName ? `form:${formName.substring(0, 20)}` : 'form';
      }
      parent = parent.parentElement;
      depth++;
    }
    return null;
  }

  // ── v0.2: Layer / Modal Detection ──────────────────────────────

  function getLayerInfo(node, zIndex) {
    // Detect if this element is in a modal/overlay layer
    let el = node;
    let depth = 0;
    while (el && depth < 10) {
      const tag = el.tagName?.toLowerCase();
      const role = el.getAttribute?.('role');
      const isModal = el.getAttribute?.('aria-modal') === 'true';

      if (tag === 'dialog' && el.open) {
        return { layer: 'modal', type: 'dialog' };
      }
      if (isModal || role === 'dialog' || role === 'alertdialog') {
        return { layer: 'modal', type: role || 'modal' };
      }
      if (el.classList?.contains?.('modal') || el.classList?.contains?.('overlay')) {
        return { layer: 'overlay', type: 'overlay' };
      }
      el = el.parentElement;
      depth++;
    }

    // High z-index suggests floating layer
    if (zIndex > 100) {
      return { layer: 'floating', type: 'elevated' };
    }

    return null;
  }

  // ── v0.2: Blocked Element Detection ────────────────────────────

  function isBlockedByModal() {
    // Check if there's an open modal that blocks the page
    const openDialogs = document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"]');
    for (const d of openDialogs) {
      if (isVisible(d)) return true;
    }
    return false;
  }

  // ── v0.2: Text Content Scanner ─────────────────────────────────
  // Extracts visible text content for read mode

  function scanTextContent(viewportOnly = true) {
    const textBlocks = [];
    const seen = new Set();

    const textTags = new Set([
      'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'li', 'td', 'th', 'dt', 'dd', 'label', 'caption',
      'figcaption', 'blockquote', 'pre', 'code',
      'strong', 'em', 'b', 'i', 'a', 'small', 'time',
    ]);

    const dataElements = new Set(['td', 'th', 'li', 'dt', 'dd']);

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while (node = walker.nextNode()) {
      const tag = node.tagName?.toLowerCase();
      if (!textTags.has(tag)) continue;

      const rect = node.getBoundingClientRect();
      if (viewportOnly && !isInViewport(rect)) continue;
      if (rect.width < 4 || rect.height < 4) continue;

      // Get direct text content (not deeply nested)
      const text = getDirectText(node).trim();
      if (!text || text.length < 2) continue;

      // Dedup by text + approximate position
      const key = `${text.substring(0, 30)}:${Math.round(rect.top/20)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const blockType = /^h[1-6]$/.test(tag) ? 'heading'
        : tag === 'th' ? 'table_header'
        : dataElements.has(tag) ? 'data'
        : tag === 'a' ? 'link_text'
        : tag === 'label' ? 'label'
        : tag === 'code' || tag === 'pre' ? 'code'
        : 'text';

      textBlocks.push({
        type: blockType,
        text: text.substring(0, 200),
        tag,
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        },
      });
    }

    // Sort top-to-bottom, left-to-right
    textBlocks.sort((a, b) => {
      const rowDiff = Math.round(a.rect.top / 20) - Math.round(b.rect.top / 20);
      if (rowDiff !== 0) return rowDiff;
      return a.rect.left - b.rect.left;
    });

    return textBlocks;
  }

  function getDirectText(node) {
    // Get text from direct child text nodes only (avoid deep nesting duplication)
    let text = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      }
    }
    // Fall back to innerText if no direct text nodes
    if (!text.trim() && node.childElementCount === 0) {
      text = node.innerText || '';
    }
    return text;
  }

  // ── v0.2: Table Extractor ──────────────────────────────────────
  // Extracts visible tables as structured data

  function scanTables(viewportOnly = true) {
    const tables = [];
    const tableEls = document.querySelectorAll('table');

    for (const table of tableEls) {
      if (!isVisible(table)) continue;
      const rect = table.getBoundingClientRect();
      if (viewportOnly && !isInViewport(rect)) continue;

      const headers = [];
      const rows = [];

      // Extract headers
      const ths = table.querySelectorAll('thead th, thead td, tr:first-child th');
      ths.forEach(th => {
        const text = th.innerText?.trim().substring(0, 30);
        if (text) headers.push(text);
      });

      // Extract visible rows (limit to prevent explosion)
      const trs = table.querySelectorAll('tbody tr');
      const maxRows = 20;
      let rowCount = 0;

      for (const tr of trs) {
        if (rowCount >= maxRows) break;
        const trRect = tr.getBoundingClientRect();
        if (viewportOnly && !isInViewport(trRect)) continue;

        const cells = [];
        tr.querySelectorAll('td, th').forEach(td => {
          cells.push(td.innerText?.trim().substring(0, 50) || '');
        });

        if (cells.some(c => c)) {
          rows.push(cells);
          rowCount++;
        }
      }

      if (headers.length > 0 || rows.length > 0) {
        // Check for pagination/count info near the table
        const countText = findNearbyCount(table);

        tables.push({
          headers,
          rows,
          totalRowsVisible: rows.length,
          countInfo: countText,
          rect: { left: rect.left, top: rect.top },
        });
      }
    }

    return tables;
  }

  function findNearbyCount(tableEl) {
    // Look for pagination or count text near the table
    // Common patterns: "Showing 1-20 of 2,048" / "Total: 156" / "1-20 of 2048 records"
    const searchArea = tableEl.parentElement || document.body;
    const candidates = searchArea.querySelectorAll(
      '.pagination, .pager, .total, .count, .records, [class*="pagination"], [class*="total"], [class*="count"], [class*="showing"]'
    );

    for (const el of candidates) {
      const text = el.innerText?.trim();
      if (text && text.length < 100 && /\d/.test(text)) {
        return text.substring(0, 80);
      }
    }

    // Search siblings and nearby text for count patterns
    const parent = tableEl.parentElement;
    if (parent) {
      const allText = parent.innerText || '';
      const countMatch = allText.match(
        /(?:showing|displaying|total|records|results|items|of)\s*:?\s*[\d,]+(?:\s*[-–]\s*[\d,]+)?(?:\s*(?:of|\/)\s*[\d,]+)?/i
      );
      if (countMatch) {
        return countMatch[0].trim().substring(0, 80);
      }
    }

    return null;
  }

  // ── v0.2: Read Mode Renderer ───────────────────────────────────
  // Combines numbered interactive elements with readable text content

  function renderRead(elements) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Get the numbered map for interactive elements
    const numberedResult = renderNumbered(elements);

    // Scan text content
    const textBlocks = scanTextContent(true);

    // Scan tables
    const tables = scanTables(true);

    // Build content sections
    const content = [];

    // Group text blocks by vertical region
    let currentSection = { heading: null, items: [] };

    for (const block of textBlocks) {
      if (block.type === 'heading') {
        if (currentSection.items.length > 0 || currentSection.heading) {
          content.push(currentSection);
        }
        currentSection = { heading: block.text, items: [] };
      } else {
        const prefix = block.type === 'table_header' ? '[TH] '
          : block.type === 'data' ? ''
          : block.type === 'label' ? '[label] '
          : block.type === 'code' ? '[code] '
          : '';
        currentSection.items.push(prefix + block.text);
      }
    }
    if (currentSection.items.length > 0 || currentSection.heading) {
      content.push(currentSection);
    }

    // Format content as readable text
    let readableContent = '';

    for (const section of content) {
      if (section.heading) {
        readableContent += `\n## ${section.heading}\n`;
      }
      for (const item of section.items) {
        readableContent += `  ${item}\n`;
      }
    }

    // Format tables
    let tableContent = '';
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      tableContent += `\n── Table ${i + 1}`;
      if (t.countInfo) {
        tableContent += ` (${t.countInfo})`;
      }
      tableContent += ` ──\n`;

      if (t.headers.length > 0) {
        tableContent += '  | ' + t.headers.join(' | ') + ' |\n';
        tableContent += '  |' + t.headers.map(() => '---').join('|') + '|\n';
      }
      for (const row of t.rows) {
        tableContent += '  | ' + row.join(' | ') + ' |\n';
      }
    }

    // Enhance registry with v0.2 metadata
    const enhancedRegistry = numberedResult.registry.map(entry => {
      const node = entry.node;
      const enhanced = { ...entry };

      // Add interaction hints
      enhanced.actions = getActionHints(node, entry.type);

      // Add form grouping
      const formGroup = getFormGroup(node);
      if (formGroup) enhanced.form = formGroup;

      // Add layer info
      const layerInfo = getLayerInfo(node, entry.zIndex || 0);
      if (layerInfo) enhanced.layer = layerInfo;

      return enhanced;
    });

    // Check for modal blocking
    const hasModal = isBlockedByModal();
    const modalElements = hasModal
      ? enhancedRegistry.filter(e => e.layer?.layer === 'modal').map(e => e.id)
      : null;

    return {
      map: numberedResult.map,
      registry: enhancedRegistry,
      content: readableContent,
      tables: tableContent,
      meta: {
        ...numberedResult.meta,
        textBlocks: textBlocks.length,
        tableCount: tables.length,
        hasModal,
        modalElements,
      },
    };
  }

  // ── Grid Builder ───────────────────────────────────────────────

  function createGrid(cols, rows) {
    const grid = [];
    for (let r = 0; r < rows; r++) {
      grid.push(new Array(cols).fill(DENSITY.empty));
    }
    return grid;
  }

  function mapToGrid(rect, cols, rows, viewportWidth, viewportHeight) {
    return {
      startCol: Math.max(0, Math.floor((rect.left / viewportWidth) * cols)),
      endCol:   Math.min(cols - 1, Math.floor((rect.right / viewportWidth) * cols)),
      startRow: Math.max(0, Math.floor((rect.top / viewportHeight) * rows)),
      endRow:   Math.min(rows - 1, Math.floor((rect.bottom / viewportHeight) * rows)),
    };
  }

  // ── Render: Full Mode ──────────────────────────────────────────

  function renderFull(elements) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cols = Math.min(CONFIG.maxCols, Math.floor(vw / CONFIG.cellWidth));
    const rows = Math.min(CONFIG.maxRows, Math.floor(vh / CONFIG.cellHeight));
    const grid = createGrid(cols, rows);

    for (const el of elements) {
      const g = mapToGrid(el.rect, cols, rows, vw, vh);
      renderElementToGrid(grid, g, el, cols, rows);
    }

    return gridToString(grid);
  }

  function renderElementToGrid(grid, g, el, cols, rows) {
    const { startCol, endCol, startRow, endRow } = g;
    const w = endCol - startCol;
    const h = endRow - startRow;

    switch (el.type) {
      case 'button':
        fillRect(grid, g, DENSITY.buttonFill);
        placeLabel(grid, g, el.label, DENSITY.buttonFill);
        break;

      case 'input':
        // Draw bordered input box
        drawBox(grid, g, DENSITY.inputTL, DENSITY.inputTR, DENSITY.inputBL, DENSITY.inputBR, DENSITY.inputBorderH, DENSITY.inputBorderV);
        placeLabel(grid, g, el.label || '...', DENSITY.inputFill);
        break;

      case 'select':
        drawBox(grid, g, DENSITY.inputTL, DENSITY.inputTR, DENSITY.inputBL, DENSITY.inputBR, DENSITY.inputBorderH, DENSITY.inputBorderV);
        // Place dropdown arrow at end
        if (endCol > startCol + 1) {
          grid[Math.min(startRow + Math.floor(h/2), rows-1)][endCol - 1] = DENSITY.select;
        }
        placeLabel(grid, g, el.label, DENSITY.inputFill);
        break;

      case 'checkbox':
        if (startRow < rows && startCol < cols) grid[startRow][startCol] = DENSITY.checkbox;
        placeLabel(grid, { startCol: startCol + 2, endCol, startRow, endRow }, el.label);
        break;

      case 'checkbox_checked':
        if (startRow < rows && startCol < cols) grid[startRow][startCol] = DENSITY.checked;
        placeLabel(grid, { startCol: startCol + 2, endCol, startRow, endRow }, el.label);
        break;

      case 'radio':
        if (startRow < rows && startCol < cols) grid[startRow][startCol] = DENSITY.radio;
        placeLabel(grid, { startCol: startCol + 2, endCol, startRow, endRow }, el.label);
        break;

      case 'radio_checked':
        if (startRow < rows && startCol < cols) grid[startRow][startCol] = DENSITY.radioChecked;
        placeLabel(grid, { startCol: startCol + 2, endCol, startRow, endRow }, el.label);
        break;

      case 'link':
        placeLabel(grid, g, el.label, DENSITY.link);
        break;

      case 'heading':
        placeLabel(grid, g, el.label, DENSITY.heading);
        break;

      case 'text':
        placeLabel(grid, g, el.label, DENSITY.text);
        break;

      case 'image':
        fillRect(grid, g, DENSITY.image);
        placeLabel(grid, g, el.label);
        break;

      case 'nav':
        for (let c = startCol; c <= endCol && c < cols; c++) {
          if (startRow < rows) grid[startRow][c] = DENSITY.nav;
        }
        break;

      case 'scroll_container':
        // Draw a dashed border to indicate scrollable region
        for (let c = startCol; c <= endCol && c < cols; c++) {
          if (startRow < rows) grid[startRow][c] = (c % 2 === 0) ? '┄' : '─';
          if (endRow < rows) grid[endRow][c] = (c % 2 === 0) ? '┄' : '─';
        }
        for (let r = startRow; r <= endRow && r < rows; r++) {
          if (startCol < cols) grid[r][startCol] = (r % 2 === 0) ? '┆' : '│';
          if (endCol < cols) grid[r][endCol] = (r % 2 === 0) ? '┆' : '│';
        }
        // Scroll arrows
        if (el.scrollState) {
          const midCol = startCol + Math.floor(w / 2);
          if (el.scrollState.canScrollUp && startRow < rows && midCol < cols) {
            grid[startRow][midCol] = '▲';
          }
          if (el.scrollState.canScrollDown && endRow < rows && midCol < cols) {
            grid[endRow][midCol] = '▼';
          }
        }
        placeLabel(grid, g, el.label);
        break;

      default:
        break;
    }
  }

  // ── Render: Actions Only Mode ──────────────────────────────────

  function renderActionsOnly(elements) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cols = Math.min(CONFIG.maxCols, Math.floor(vw / CONFIG.cellWidth));
    const rows = Math.min(CONFIG.maxRows, Math.floor(vh / CONFIG.cellHeight));
    const grid = createGrid(cols, rows);

    const interactive = elements.filter(e => e.interactive);

    for (const el of interactive) {
      const g = mapToGrid(el.rect, cols, rows, vw, vh);
      renderElementToGrid(grid, g, el, cols, rows);
    }

    return gridToString(grid);
  }

  // ── Render: Numbered Mode ──────────────────────────────────────

  function renderNumbered(elements) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cols = Math.min(CONFIG.maxCols, Math.floor(vw / CONFIG.cellWidth));
    const rows = Math.min(CONFIG.maxRows, Math.floor(vh / CONFIG.cellHeight));
    const grid = createGrid(cols, rows);

    const interactive = elements.filter(e => e.interactive);
    const registry = [];

    interactive.forEach((el, idx) => {
      const num = idx + 1;
      const g = mapToGrid(el.rect, cols, rows, vw, vh);
      const tag = `[${num}]`;

      // Place the number tag at the element's position
      const row = Math.min(g.startRow, rows - 1);
      let col = g.startCol;
      for (let i = 0; i < tag.length && col + i < cols; i++) {
        grid[row][col + i] = tag[i];
      }

      // Draw a subtle indicator of element size
      if (el.type === 'button') {
        for (let r = g.startRow; r <= g.endRow && r < rows; r++) {
          for (let c = g.startCol; c <= g.endCol && c < cols; c++) {
            if (grid[r][c] === DENSITY.empty) {
              grid[r][c] = DENSITY.buttonFill;
            }
          }
        }
        // Re-place number on top
        for (let i = 0; i < tag.length && col + i < cols; i++) {
          grid[row][col + i] = tag[i];
        }
      }

      // Render scroll containers with dashed border
      if (el.type === 'scroll_container') {
        renderElementToGrid(grid, g, el, cols, rows);
        // Re-place number on top
        for (let i = 0; i < tag.length && col + i < cols; i++) {
          grid[row][col + i] = tag[i];
        }
      }

      const entry = {
        id: num,
        type: el.type,
        label: el.label,
        rect: el.rect,
        center: {
          x: Math.round(el.rect.left + el.rect.width / 2),
          y: Math.round(el.rect.top + el.rect.height / 2),
        },
        node: el.node, // kept for action execution, not serialized
      };

      // Include scroll metadata for scroll containers
      if (el.type === 'scroll_container') {
        entry.scrollable = el.scrollable;
        entry.scrollState = el.scrollState;
      }

      registry.push(entry);
    });

    return {
      map: gridToString(grid),
      registry,
      meta: {
        viewport: { width: vw, height: vh },
        gridSize: { cols, rows },
        cellSize: { width: CONFIG.cellWidth, height: CONFIG.cellHeight },
        elementCount: registry.length,
      }
    };
  }

  // ── Grid Drawing Utilities ─────────────────────────────────────

  function fillRect(grid, g, char) {
    const rows = grid.length;
    const cols = grid[0].length;
    for (let r = g.startRow; r <= g.endRow && r < rows; r++) {
      for (let c = g.startCol; c <= g.endCol && c < cols; c++) {
        grid[r][c] = char;
      }
    }
  }

  function drawBox(grid, g, tl, tr, bl, br, h, v) {
    const rows = grid.length;
    const cols = grid[0].length;
    const { startCol, endCol, startRow, endRow } = g;

    if (startRow < rows && startCol < cols) grid[startRow][startCol] = tl;
    if (startRow < rows && endCol < cols)   grid[startRow][endCol] = tr;
    if (endRow < rows && startCol < cols)   grid[endRow][startCol] = bl;
    if (endRow < rows && endCol < cols)     grid[endRow][endCol] = br;

    for (let c = startCol + 1; c < endCol && c < cols; c++) {
      if (startRow < rows) grid[startRow][c] = h;
      if (endRow < rows)   grid[endRow][c] = h;
    }
    for (let r = startRow + 1; r < endRow && r < rows; r++) {
      if (startCol < cols) grid[r][startCol] = v;
      if (endCol < cols)   grid[r][endCol] = v;
    }
  }

  function placeLabel(grid, g, label, bgChar) {
    if (!label) return;
    const rows = grid.length;
    const cols = grid[0].length;
    const row = Math.min(g.startRow + Math.floor((g.endRow - g.startRow) / 2), rows - 1);
    const availWidth = g.endCol - g.startCol - 1;
    const text = label.substring(0, Math.max(availWidth, 1));
    const startCol = g.startCol + 1;

    for (let i = 0; i < text.length && startCol + i < cols; i++) {
      grid[row][startCol + i] = text[i];
    }
  }

  // ── Output ─────────────────────────────────────────────────────

  function gridToString(grid) {
    return grid.map(row => row.join('')).join('\n');
  }

  // ── v0.3: One-Shot Full Page Scan ───────────────────────────────
  // Scans the entire page (not just viewport) with section markers.
  // The model gets global context to plan before executing.

  function renderOneShot(elements) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const totalViewports = Math.min(
      Math.ceil(docHeight / vh),
      CONFIG.maxPageViewports
    );
    const totalPageHeight = vh * totalViewports;

    const cols = Math.min(CONFIG.maxCols, Math.floor(vw / CONFIG.cellWidth));
    const rowsPerViewport = Math.min(CONFIG.maxRows, Math.floor(vh / CONFIG.cellHeight));
    const totalRows = rowsPerViewport * totalViewports;

    // Scan full page elements (not viewport-only)
    const allElements = scanElements(false);
    const interactive = allElements.filter(e => e.interactive);
    const registry = [];

    // Build sections
    const sections = [];

    for (let vp = 0; vp < totalViewports; vp++) {
      const vpTop = vp * vh;
      const vpBottom = vpTop + vh;
      const grid = createGrid(cols, rowsPerViewport);

      // Filter elements in this viewport section
      const vpElements = interactive.filter(el => {
        const absTop = el.rect.top + window.scrollY;
        return absTop >= vpTop && absTop < vpBottom;
      });

      const currentScrollY = window.scrollY;
      const isCurrentViewport = currentScrollY >= vpTop && currentScrollY < vpBottom;

      vpElements.forEach(el => {
        const num = registry.length + 1;

        // Adjust rect to be relative to this viewport section
        const absTop = el.rect.top + currentScrollY;
        const relRect = {
          left: el.rect.left,
          top: absTop - vpTop,
          right: el.rect.right,
          bottom: (absTop - vpTop) + el.rect.height,
          width: el.rect.width,
          height: el.rect.height,
        };

        const g = mapToGrid(relRect, cols, rowsPerViewport, vw, vh);
        const tag = `[${num}]`;

        // Place number on grid
        const row = Math.min(g.startRow, rowsPerViewport - 1);
        let col = g.startCol;
        for (let i = 0; i < tag.length && col + i < cols; i++) {
          grid[row][col + i] = tag[i];
        }

        if (el.type === 'button') {
          for (let r = g.startRow; r <= g.endRow && r < rowsPerViewport; r++) {
            for (let c = g.startCol; c <= g.endCol && c < cols; c++) {
              if (grid[r][c] === DENSITY.empty) grid[r][c] = DENSITY.buttonFill;
            }
          }
          for (let i = 0; i < tag.length && col + i < cols; i++) {
            grid[row][col + i] = tag[i];
          }
        }

        const entry = {
          id: num,
          type: el.type,
          label: el.label,
          rect: el.rect,
          section: vp + 1,
          center: {
            x: Math.round(el.rect.left + el.rect.width / 2),
            y: Math.round(absTop + el.rect.height / 2),
          },
          node: el.node,
        };

        if (el.type === 'scroll_container') {
          entry.scrollable = el.scrollable;
          entry.scrollState = el.scrollState;
        }

        entry.actions = getActionHints(el.node, el.type);
        const formGroup = getFormGroup(el.node);
        if (formGroup) entry.form = formGroup;

        registry.push(entry);
      });

      sections.push({
        viewport: vp + 1,
        isCurrent: isCurrentViewport,
        elementCount: vpElements.length,
        map: gridToString(grid),
      });
    }

    // Build combined output
    let combinedMap = '';
    for (const section of sections) {
      const marker = section.isCurrent ? '(current)' : '';
      combinedMap += `── section ${section.viewport}/${totalViewports} ${marker} ──\n`;
      combinedMap += section.map + '\n\n';
    }

    return {
      map: combinedMap,
      registry,
      sections: sections.map(s => ({
        viewport: s.viewport,
        isCurrent: s.isCurrent,
        elementCount: s.elementCount,
      })),
      meta: {
        viewport: { width: vw, height: vh },
        documentHeight: docHeight,
        totalViewports,
        gridSize: { cols, rowsPerViewport },
        elementCount: registry.length,
      },
    };
  }

  // ── v0.3: State Diff ───────────────────────────────────────────
  // Stores the last rendered state and returns only what changed.
  // Massively reduces tokens on subsequent scans of the same page.

  let lastStateSnapshot = null;

  function computeStateDiff(currentState) {
    if (!lastStateSnapshot) {
      // First scan — no diff available, return full state
      lastStateSnapshot = {
        url: currentState.url,
        map: currentState.map,
        registry: currentState.registry,
        timestamp: Date.now(),
      };
      return {
        type: 'full',
        state: currentState,
      };
    }

    // Check if we're on a different page
    if (lastStateSnapshot.url !== currentState.url) {
      lastStateSnapshot = {
        url: currentState.url,
        map: currentState.map,
        registry: currentState.registry,
        timestamp: Date.now(),
      };
      return {
        type: 'new_page',
        state: currentState,
      };
    }

    // Same page — compute diff
    const oldMap = lastStateSnapshot.map || '';
    const newMap = currentState.map || '';
    const oldLines = oldMap.split('\n');
    const newLines = newMap.split('\n');

    const changedLines = [];
    const maxLines = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLines; i++) {
      const oldLine = oldLines[i] || '';
      const newLine = newLines[i] || '';
      if (oldLine !== newLine) {
        changedLines.push({ line: i, content: newLine });
      }
    }

    // Registry diff — find added, removed, changed elements
    const oldRegistry = lastStateSnapshot.registry || [];
    const newRegistry = currentState.registry || [];

    const oldIds = new Set(oldRegistry.map(e => `${e.type}:${e.label}:${Math.round(e.center?.x/20)},${Math.round(e.center?.y/20)}`));
    const newIds = new Set(newRegistry.map(e => `${e.type}:${e.label}:${Math.round(e.center?.x/20)},${Math.round(e.center?.y/20)}`));

    const added = newRegistry.filter(e => {
      const key = `${e.type}:${e.label}:${Math.round(e.center?.x/20)},${Math.round(e.center?.y/20)}`;
      return !oldIds.has(key);
    });

    const removed = oldRegistry.filter(e => {
      const key = `${e.type}:${e.label}:${Math.round(e.center?.x/20)},${Math.round(e.center?.y/20)}`;
      return !newIds.has(key);
    });

    // Update snapshot
    lastStateSnapshot = {
      url: currentState.url,
      map: currentState.map,
      registry: currentState.registry,
      timestamp: Date.now(),
    };

    const totalLines = newLines.length;
    const unchangedPercent = totalLines > 0
      ? Math.round(((totalLines - changedLines.length) / totalLines) * 100)
      : 0;

    // If more than 70% changed, just send the full state (cheaper than a huge diff)
    if (changedLines.length > totalLines * 0.7) {
      return {
        type: 'major_change',
        state: currentState,
        stats: { changedLines: changedLines.length, totalLines, unchangedPercent },
      };
    }

    // Build compact diff output
    let diffMap = '';
    if (changedLines.length > 0) {
      // Group consecutive changed lines into regions
      const regions = [];
      let currentRegion = null;

      for (const cl of changedLines) {
        if (currentRegion && cl.line === currentRegion.end + 1) {
          currentRegion.end = cl.line;
          currentRegion.lines.push(cl.content);
        } else {
          if (currentRegion) regions.push(currentRegion);
          currentRegion = { start: cl.line, end: cl.line, lines: [cl.content] };
        }
      }
      if (currentRegion) regions.push(currentRegion);

      for (const region of regions) {
        diffMap += `[changed: rows ${region.start}-${region.end}]\n`;
        diffMap += region.lines.join('\n') + '\n';
      }
    }

    return {
      type: 'diff',
      url: currentState.url,
      title: currentState.title,
      diff: {
        map: diffMap || '[no visual changes]',
        added: added.map(({ node, ...rest }) => rest),
        removed: removed.map(({ node, ...rest }) => rest),
      },
      scroll: currentState.scroll,
      stats: {
        changedLines: changedLines.length,
        totalLines,
        unchangedPercent,
        elementsAdded: added.length,
        elementsRemoved: removed.length,
      },
      // Always include full registry so agent can still target elements
      registry: currentState.registry,
    };
  }

  function resetDiffState() {
    lastStateSnapshot = null;
    return { success: true };
  }

  // ── v0.3: Hidden DOM Flow Scan ─────────────────────────────────
  // Scans hidden elements (display:none, visibility:hidden) to find
  // multi-step form flows that exist in DOM but aren't visible.
  // Lets the model plan an entire form sequence in one call.

  function scanHiddenFlow() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Find all interactive elements including hidden ones
    const visibleElements = [];
    const hiddenElements = [];

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      null,
    );

    let node;
    while (node = walker.nextNode()) {
      const type = classifyElement(node);
      if (type === 'unknown' || type === 'container') continue;
      if (!isInteractive(type)) continue;

      const rect = node.getBoundingClientRect();
      const label = getElementLabel(node, type);
      if (!label && type !== 'input') continue;

      const style = window.getComputedStyle(node);
      const isHidden = style.display === 'none'
        || style.visibility === 'hidden'
        || style.opacity === '0'
        || rect.width === 0
        || rect.height === 0
        || !isInViewport(rect);

      // Try to find the containing step/section
      const stepInfo = findFlowStep(node);

      const entry = {
        type,
        label,
        hidden: isHidden,
        step: stepInfo,
        actions: getActionHints(node, type),
      };

      const formGroup = getFormGroup(node);
      if (formGroup) entry.form = formGroup;

      if (isHidden) {
        hiddenElements.push(entry);
      } else {
        entry.rect = {
          left: rect.left, top: rect.top,
          right: rect.right, bottom: rect.bottom,
        };
        visibleElements.push(entry);
      }
    }

    // Group hidden elements by their step
    const steps = {};
    for (const el of [...visibleElements, ...hiddenElements]) {
      const stepName = el.step || (el.hidden ? 'hidden' : 'visible');
      if (!steps[stepName]) steps[stepName] = [];
      steps[stepName].push(el);
    }

    // Format as a flow
    const flow = [];
    for (const [stepName, elements] of Object.entries(steps)) {
      const isVisible = elements.some(e => !e.hidden);
      flow.push({
        step: stepName,
        visible: isVisible,
        elements: elements.map(e => ({
          type: e.type,
          label: e.label,
          actions: e.actions,
          form: e.form,
        })),
      });
    }

    return {
      flow,
      totalSteps: flow.length,
      visibleSteps: flow.filter(s => s.visible).length,
      hiddenSteps: flow.filter(s => !s.visible).length,
      totalElements: visibleElements.length + hiddenElements.length,
      hiddenElements: hiddenElements.length,
    };
  }

  function findFlowStep(node) {
    // Walk up the tree looking for step indicators
    let el = node.parentElement;
    let depth = 0;

    while (el && depth < 10) {
      // Check for common step patterns
      const cls = el.className?.toString()?.toLowerCase() || '';
      const id = el.id?.toLowerCase() || '';
      const role = el.getAttribute('role');
      const ariaLabel = el.getAttribute('aria-label');

      // Step indicator patterns
      const stepPatterns = [
        'step', 'wizard', 'stage', 'phase', 'tab-panel', 'tabpanel',
        'section', 'fieldset', 'panel', 'slide', 'page',
      ];

      for (const pattern of stepPatterns) {
        if (cls.includes(pattern) || id.includes(pattern)) {
          // Try to get a meaningful name
          const name = ariaLabel
            || el.getAttribute('data-step')
            || el.getAttribute('data-label')
            || el.getAttribute('title')
            || `${pattern}:${id || cls.substring(0, 20)}`;
          return name.substring(0, 40);
        }
      }

      if (role === 'tabpanel') {
        return ariaLabel || `tabpanel:${id || 'unnamed'}`;
      }

      el = el.parentElement;
      depth++;
    }

    return null;
  }

  // ── Public API ─────────────────────────────────────────────────

  function getPageRepresentation(mode = 'full') {
    const elements = scanElements(true);
    const url = window.location.href;
    const title = document.title;

    let output;

    switch (mode) {
      case 'actions_only':
        output = {
          url,
          title,
          mode,
          map: renderActionsOnly(elements),
          stats: {
            totalElements: elements.length,
            interactiveElements: elements.filter(e => e.interactive).length,
          }
        };
        break;

      case 'numbered': {
        const result = renderNumbered(elements);
        // Serialize registry without DOM node references
        const serializedRegistry = result.registry.map(({ node, ...rest }) => rest);
        output = {
          url,
          title,
          mode,
          map: result.map,
          registry: serializedRegistry,
          meta: result.meta,
        };
        break;
      }

      case 'numbered_v2': {
        // Enhanced numbered with interaction hints, form grouping, layer info
        const result = renderRead(elements);
        const serializedRegistry = result.registry.map(({ node, ...rest }) => rest);
        output = {
          url,
          title,
          mode,
          map: result.map,
          registry: serializedRegistry,
          meta: result.meta,
        };
        break;
      }

      case 'read': {
        // Full read mode: interactive elements + readable text + tables
        const result = renderRead(elements);
        const serializedRegistry = result.registry.map(({ node, ...rest }) => rest);
        output = {
          url,
          title,
          mode,
          map: result.map,
          registry: serializedRegistry,
          content: result.content,
          tables: result.tables,
          meta: result.meta,
        };
        break;
      }

      case 'oneshot': {
        const result = renderOneShot(elements);
        const serializedRegistry = result.registry.map(({ node, ...rest }) => rest);
        output = {
          url,
          title,
          mode,
          map: result.map,
          registry: serializedRegistry,
          sections: result.sections,
          meta: result.meta,
        };
        break;
      }

      case 'diff': {
        // Get current numbered state, then diff against last snapshot
        const result = renderRead(elements);
        const serializedRegistry = result.registry.map(({ node, ...rest }) => rest);
        const currentState = {
          url,
          title,
          mode: 'diff',
          map: result.map,
          registry: serializedRegistry,
          content: result.content,
          tables: result.tables,
          meta: result.meta,
          scroll: getScrollContext(),
        };
        const diffResult = computeStateDiff(currentState);
        output = diffResult;
        break;
      }

      case 'flow': {
        const flowResult = scanHiddenFlow();
        output = {
          url,
          title,
          mode,
          flow: flowResult,
        };
        break;
      }

      case 'full':
      default:
        output = {
          url,
          title,
          mode,
          map: renderFull(elements),
          stats: {
            totalElements: elements.length,
            interactiveElements: elements.filter(e => e.interactive).length,
          }
        };
        break;
    }

    return output;
  }

  // ── Phase 2: Action Executor ────────────────────────────────────
  // Robust action execution with DOM event simulation, scroll handling,
  // retry logic, wait-for-condition, and automatic state re-rendering.

  let currentRegistry = null;
  let actionHistory = [];

  // ── Scroll State ───────────────────────────────────────────────

  function getScrollContext() {
    const docHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const viewportHeight = window.innerHeight;
    const scrollTop = window.scrollY;
    const scrollPercent = docHeight > viewportHeight
      ? Math.round((scrollTop / (docHeight - viewportHeight)) * 100)
      : 100;
    const totalPages = Math.ceil(docHeight / viewportHeight);
    const currentPage = Math.floor(scrollTop / viewportHeight) + 1;

    return {
      scrollTop,
      scrollPercent,
      viewportHeight,
      documentHeight: docHeight,
      currentPage,
      totalPages,
      canScrollUp: scrollTop > 0,
      canScrollDown: scrollTop + viewportHeight < docHeight - 10,
    };
  }

  // ── DOM Mutation Waiter ────────────────────────────────────────
  // Waits for the DOM to "settle" after an action (SPA transitions, etc.)

  function waitForDomSettle(timeout = 2000, idleTime = 300) {
    return new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const observer = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          settled = true;
          observer.disconnect();
          resolve(true);
        }, idleTime);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      // Start the idle timer immediately in case no mutations happen
      timer = setTimeout(() => {
        if (!settled) {
          observer.disconnect();
          resolve(true);
        }
      }, idleTime);

      // Hard timeout failsafe
      setTimeout(() => {
        if (!settled) {
          observer.disconnect();
          resolve(false);
        }
      }, timeout);
    });
  }

  // ── Realistic Event Simulation ─────────────────────────────────
  // React, Vue, and other frameworks need proper event sequences

  function simulateClick(node) {
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const eventOpts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
    };

    // Scroll element into view if needed
    if (!isInViewport(rect)) {
      node.scrollIntoView({ behavior: 'instant', block: 'center' });
    }

    // Full mouse event sequence for framework compatibility
    node.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    node.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    node.dispatchEvent(new MouseEvent('click', eventOpts));

    // Also trigger focus for interactive elements
    if (node.focus) node.focus();
  }

  function simulateFill(node, value) {
    node.scrollIntoView({ behavior: 'instant', block: 'center' });
    node.focus();

    // Clear existing value
    // Use native setter to bypass React's synthetic event system
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(node, value);
    } else {
      node.value = value;
    }

    // Fire the full event sequence React and other frameworks expect
    node.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    node.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    // KeyboardEvent sequence for frameworks that listen to key events
    for (const char of value.slice(-1)) {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    }
  }

  function simulateSelect(node, value) {
    node.scrollIntoView({ behavior: 'instant', block: 'center' });
    node.focus();

    // Find option by value or text
    const options = Array.from(node.options || []);
    const match = options.find(
      o => o.value === value || o.textContent.trim().toLowerCase() === value.toLowerCase()
    );

    if (match) {
      node.value = match.value;
    } else {
      node.value = value;
    }

    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function simulateHover(node) {
    const rect = node.getBoundingClientRect();
    const opts = {
      bubbles: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      view: window,
    };
    node.dispatchEvent(new MouseEvent('mouseenter', opts));
    node.dispatchEvent(new MouseEvent('mouseover', opts));
  }

  function simulateKeypress(key, modifiers = {}) {
    const target = document.activeElement || document.body;
    const opts = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.ctrl || false,
      shiftKey: modifiers.shift || false,
      altKey: modifiers.alt || false,
      metaKey: modifiers.meta || false,
    };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ── Core Action Executor ───────────────────────────────────────

  async function executeAction(action) {
    const timestamp = Date.now();

    // Scroll with a container target — route to container scroll
    if (action.action === 'scroll' && action.container !== undefined) {
      return await executeContainerScroll(action, timestamp);
    }

    // Global actions (no element target needed)
    if (['scroll', 'scroll_to', 'keypress', 'wait', 'back', 'forward', 'refresh'].includes(action.action)) {
      return await executeGlobalAction(action, timestamp);
    }

    // Element-targeted actions
    if (action.element === undefined || action.element === null) {
      return { success: false, error: 'Action requires an element ID.', timestamp };
    }

    // Auto-scan if no registry exists
    if (!currentRegistry) {
      const numberedResult = renderNumbered(scanElements(true));
      currentRegistry = numberedResult.registry;
    }

    const entry = currentRegistry.find(e => e.id === action.element);
    if (!entry) {
      return {
        success: false,
        error: `Element [${action.element}] not found. Registry has ${currentRegistry.length} elements.`,
        available: currentRegistry.map(e => ({ id: e.id, type: e.type, label: e.label })),
        timestamp,
      };
    }

    const node = entry.node;
    if (!node || !node.isConnected) {
      // Element disconnected — attempt re-scan and retry
      const retryResult = await retryWithRescan(action, entry);
      if (retryResult) return retryResult;
      return {
        success: false,
        error: `Element [${action.element}] "${entry.label}" is no longer in the DOM. Page may have changed.`,
        suggestion: 'Re-scan with GET_STATE to get updated element registry.',
        timestamp,
      };
    }

    try {
      switch (action.action) {
        case 'click':
          simulateClick(node);
          break;

        case 'fill':
          if (action.value === undefined) {
            return { success: false, error: 'Fill action requires a "value" field.', timestamp };
          }
          simulateFill(node, String(action.value));
          break;

        case 'clear':
          simulateFill(node, '');
          break;

        case 'select':
          if (action.value === undefined) {
            return { success: false, error: 'Select action requires a "value" field.', timestamp };
          }
          simulateSelect(node, String(action.value));
          break;

        case 'hover':
          simulateHover(node);
          break;

        case 'focus':
          node.scrollIntoView({ behavior: 'instant', block: 'center' });
          node.focus();
          break;

        default:
          return { success: false, error: `Unknown action: "${action.action}"`, timestamp };
      }

      // Record action in history
      const historyEntry = {
        action: action.action,
        element: action.element,
        label: entry.label,
        type: entry.type,
        value: action.value,
        timestamp,
      };
      actionHistory.push(historyEntry);

      // Wait for DOM to settle after action
      const settled = await waitForDomSettle(
        action.waitTimeout || 2000,
        action.waitIdle || 300
      );

      // Auto-re-render and return new state
      const newState = await refreshState(action.returnMode || 'numbered');

      return {
        success: true,
        action: action.action,
        element: action.element,
        label: entry.label,
        domSettled: settled,
        newState,
        timestamp,
      };

    } catch (err) {
      return { success: false, error: err.message, element: action.element, timestamp };
    }
  }

  // ── Global Actions (no element target) ─────────────────────────

  async function executeGlobalAction(action, timestamp) {
    try {
      switch (action.action) {
        case 'scroll': {
          const direction = action.direction || 'down';
          const amount = action.amount || window.innerHeight * 0.75;
          const scrollMap = {
            down:  [0, amount],
            up:    [0, -amount],
            left:  [-amount, 0],
            right: [amount, 0],
            top:   null,
            bottom: null,
          };

          if (direction === 'top') {
            window.scrollTo({ top: 0, behavior: 'instant' });
          } else if (direction === 'bottom') {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
          } else {
            const [dx, dy] = scrollMap[direction] || [0, amount];
            window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
          }
          break;
        }

        case 'scroll_to': {
          const targetY = action.y || 0;
          const targetX = action.x || 0;
          window.scrollTo({ top: targetY, left: targetX, behavior: 'instant' });
          break;
        }

        case 'keypress': {
          simulateKeypress(action.key, action.modifiers || {});
          break;
        }

        case 'wait': {
          await new Promise(r => setTimeout(r, action.duration || 1000));
          break;
        }

        case 'back': {
          window.history.back();
          break;
        }

        case 'forward': {
          window.history.forward();
          break;
        }

        case 'refresh': {
          // Don't actually reload — just re-scan
          break;
        }

        default:
          return { success: false, error: `Unknown global action: "${action.action}"`, timestamp };
      }

      // Record in history
      actionHistory.push({ action: action.action, direction: action.direction, timestamp });

      // Wait for settle then re-render
      await waitForDomSettle(action.waitTimeout || 1500, action.waitIdle || 250);
      const newState = await refreshState(action.returnMode || 'numbered');

      return {
        success: true,
        action: action.action,
        scroll: getScrollContext(),
        newState,
        timestamp,
      };

    } catch (err) {
      return { success: false, error: err.message, timestamp };
    }
  }

  // ── Container Scroll ───────────────────────────────────────────
  // Scrolls a specific scroll_container element by its registry ID

  async function executeContainerScroll(action, timestamp) {
    // Auto-scan if no registry
    if (!currentRegistry) {
      const numberedResult = renderNumbered(scanElements(true));
      currentRegistry = numberedResult.registry;
    }

    const entry = currentRegistry.find(e => e.id === action.container);
    if (!entry) {
      return {
        success: false,
        error: `Container [${action.container}] not found in registry.`,
        timestamp,
      };
    }

    if (entry.type !== 'scroll_container') {
      return {
        success: false,
        error: `Element [${action.container}] is a ${entry.type}, not a scroll_container.`,
        timestamp,
      };
    }

    const node = entry.node;
    if (!node || !node.isConnected) {
      return { success: false, error: `Container [${action.container}] is no longer in the DOM.`, timestamp };
    }

    try {
      const direction = action.direction || 'down';
      const amount = action.amount || node.clientHeight * 0.75;

      switch (direction) {
        case 'down':
          node.scrollBy({ top: amount, behavior: 'instant' });
          break;
        case 'up':
          node.scrollBy({ top: -amount, behavior: 'instant' });
          break;
        case 'top':
          node.scrollTo({ top: 0, behavior: 'instant' });
          break;
        case 'bottom':
          node.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
          break;
        case 'left':
          node.scrollBy({ left: -amount, behavior: 'instant' });
          break;
        case 'right':
          node.scrollBy({ left: amount, behavior: 'instant' });
          break;
      }

      // Record in history
      actionHistory.push({
        action: 'scroll',
        container: action.container,
        label: entry.label,
        direction,
        timestamp,
      });

      await waitForDomSettle(action.waitTimeout || 1000, action.waitIdle || 200);
      const newState = await refreshState(action.returnMode || 'numbered');

      // Get updated scroll state for this container
      const containerScroll = {
        scrollPercent: node.scrollHeight > node.clientHeight
          ? Math.round((node.scrollTop / (node.scrollHeight - node.clientHeight)) * 100)
          : 100,
        canScrollUp: node.scrollTop > 0,
        canScrollDown: node.scrollTop + node.clientHeight < node.scrollHeight - 10,
      };

      return {
        success: true,
        action: 'scroll',
        container: action.container,
        containerLabel: entry.label,
        containerScroll,
        scroll: getScrollContext(),
        newState,
        timestamp,
      };

    } catch (err) {
      return { success: false, error: err.message, timestamp };
    }
  }

  // ── Retry with Re-scan ─────────────────────────────────────────
  // If an element disappeared, re-scan and try to find a matching one

  async function retryWithRescan(action, originalEntry) {
    const numberedResult = renderNumbered(scanElements(true));
    currentRegistry = numberedResult.registry;

    // Try to find element by matching label and type
    const match = currentRegistry.find(
      e => e.type === originalEntry.type && e.label === originalEntry.label
    );

    if (match && match.node && match.node.isConnected) {
      // Found a match — re-execute with new element ID
      const retryAction = { ...action, element: match.id };
      return await executeAction(retryAction);
    }

    return null; // Retry failed
  }

  // ── State Refresh ──────────────────────────────────────────────
  // Re-scans and re-renders after an action

  async function refreshState(mode = 'numbered') {
    // Small delay to let paint complete
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));

    const elements = scanElements(true);

    if (mode === 'read' || mode === 'numbered_v2') {
      const result = renderRead(elements);
      currentRegistry = result.registry;
      const serializedRegistry = result.registry.map(({ node, ...rest }) => rest);
      const output = {
        url: window.location.href,
        title: document.title,
        mode,
        map: result.map,
        registry: serializedRegistry,
        meta: result.meta,
        scroll: getScrollContext(),
      };
      if (mode === 'read') {
        output.content = result.content;
        output.tables = result.tables;
      }
      return output;
    }

    if (mode === 'numbered') {
      const result = renderNumbered(elements);
      currentRegistry = result.registry; // Update registry with fresh references
      const serializedRegistry = result.registry.map(({ node, ...rest }) => rest);
      return {
        url: window.location.href,
        title: document.title,
        mode,
        map: result.map,
        registry: serializedRegistry,
        meta: result.meta,
        scroll: getScrollContext(),
      };
    }

    return {
      url: window.location.href,
      title: document.title,
      mode,
      map: mode === 'actions_only' ? renderActionsOnly(elements) : renderFull(elements),
      scroll: getScrollContext(),
    };
  }

  // ── Batch Action Execution ─────────────────────────────────────
  // Execute a sequence of actions, stopping on first failure

  async function executeBatch(actions) {
    const results = [];

    for (let i = 0; i < actions.length; i++) {
      const result = await executeAction(actions[i]);
      results.push(result);

      if (!result.success) {
        return {
          completed: i,
          total: actions.length,
          results,
          stoppedOnError: true,
        };
      }

      // Optional delay between actions
      if (actions[i].delayAfter) {
        await new Promise(r => setTimeout(r, actions[i].delayAfter));
      }
    }

    return {
      completed: actions.length,
      total: actions.length,
      results,
      stoppedOnError: false,
    };
  }

  // ── Action History ─────────────────────────────────────────────

  function getActionHistory() {
    return {
      actions: actionHistory,
      count: actionHistory.length,
      firstAction: actionHistory[0]?.timestamp || null,
      lastAction: actionHistory[actionHistory.length - 1]?.timestamp || null,
    };
  }

  function clearActionHistory() {
    actionHistory = [];
    return { success: true };
  }

  // ── Message Handler (Extension Communication) ──────────────────

  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    // State queries
    if (msg.type === 'GET_STATE') {
      const mode = msg.mode || 'full';
      const result = getPageRepresentation(mode);

      // Store registry for action execution
      if (mode === 'numbered' || mode === 'numbered_v2' || mode === 'read') {
        const elements = scanElements(true);
        if (mode === 'numbered') {
          currentRegistry = renderNumbered(elements).registry;
        } else {
          currentRegistry = renderRead(elements).registry;
        }
      }

      // Attach scroll context
      result.scroll = getScrollContext();
      sendResponse(result);
      return true;
    }

    // Single action execution (async)
    if (msg.type === 'EXECUTE_ACTION') {
      executeAction(msg.action).then(result => {
        sendResponse(result);
      });
      return true; // keep channel open for async
    }

    // Batch action execution (async)
    if (msg.type === 'EXECUTE_BATCH') {
      executeBatch(msg.actions).then(result => {
        sendResponse(result);
      });
      return true;
    }

    // Action history
    if (msg.type === 'GET_HISTORY') {
      sendResponse(getActionHistory());
      return true;
    }

    if (msg.type === 'CLEAR_HISTORY') {
      sendResponse(clearActionHistory());
      return true;
    }

    // v0.3: Reset diff baseline
    if (msg.type === 'RESET_DIFF') {
      sendResponse(resetDiffState());
      return true;
    }

    // v0.3: Flow scan (hidden DOM)
    if (msg.type === 'GET_FLOW') {
      sendResponse(scanHiddenFlow());
      return true;
    }

    // Environment summary
    if (msg.type === 'GET_ENVIRONMENT') {
      const elements = scanElements(true);
      const numbered = renderNumbered(elements);
      currentRegistry = numbered.registry;
      const serializedRegistry = numbered.registry.map(({ node, ...rest }) => rest);
      sendResponse({
        url: window.location.href,
        title: document.title,
        scroll: getScrollContext(),
        map: numbered.map,
        registry: serializedRegistry,
        meta: numbered.meta,
        history: getActionHistory(),
        pageType: detectPageType(elements),
      });
      return true;
    }

    if (msg.type === 'PING') {
      sendResponse({ status: 'alive', version: '0.3.0', registrySize: currentRegistry?.length || 0 });
      return true;
    }
  });

  // ── Page Type Detection ────────────────────────────────────────
  // Heuristic classification for agent context

  function detectPageType(elements) {
    const types = elements.map(e => e.type);
    const inputCount = types.filter(t => t === 'input').length;
    const buttonCount = types.filter(t => t === 'button').length;
    const linkCount = types.filter(t => t === 'link').length;
    const headingCount = types.filter(t => t === 'heading').length;

    if (inputCount >= 3 && buttonCount >= 1) return 'form';
    if (inputCount === 1 && buttonCount <= 2 && elements.length < 15) return 'login';
    if (inputCount === 1 && linkCount > 10) return 'search';
    if (linkCount > 20 && headingCount > 3) return 'content_feed';
    if (linkCount > 15 && inputCount === 0) return 'navigation';
    if (buttonCount > 5 && inputCount > 2) return 'dashboard';
    if (headingCount > 0 && linkCount < 10 && inputCount === 0) return 'article';
    return 'general';
  }

  // ── Expose on window for console testing ───────────────────────
  window.__graphicDensity = {
    getPageRepresentation,
    executeAction,
    executeBatch,
    scanElements,
    scanTextContent,
    scanTables,
    scanHiddenFlow,
    renderOneShot,
    computeStateDiff,
    resetDiffState,
    getScrollContext,
    getActionHistory,
    clearActionHistory,
    refreshState,
    CONFIG,
  };

  console.log('[Graphic Density v0.3] Modes: full, actions_only, numbered, numbered_v2, read, oneshot, diff, flow');
})();
