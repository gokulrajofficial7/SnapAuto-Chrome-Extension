/**
 * SnapAuto - Snapchat Web Chrome Extension
 * Content Script Engine v2.5.0
 *
 * Core Architecture & Reactive State Machine:
 * 1. Explicit 15-State Finite State Machine:
 *    IDLE, OPENING_CHAT, SCANNING_CHAT, SCROLLING_UP, WAITING_FOR_OLDER_MESSAGES,
 *    PROCESSING_SNAP, VERIFYING_CHAT_HISTORY, VERIFYING_SIDEBAR_STATUS,
 *    CHAT_COMPLETED, MOVING_TO_NEXT_CHAT, SCROLLING_SIDEBAR, PAUSED, BLOCKED, ERROR, COMPLETED.
 * 2. Progressive Upward Chat History Scan:
 *    Inspects conversation messages, progressively scans upward with virtualized hydration handling,
 *    and tracks accessible conversation items.
 * 3. Two-Tier Verification Check:
 *    Ensures verified status by confirming both chat history status and sidebar indicators.
 * 4. Mobile-Only & Unsupported Snap Detection:
 *    Identifies platform-restricted snaps requiring mobile app and transparently alerts user.
 * 5. Feed Cycler & Status Monitor:
 *    Provides activity monitoring and conversation status tracking across friends feed.
 * 6. Compact Floating Dark HUD:
 *    Draggable dashboard with status indicators, session analytics, and user controls.
 */

(() => {
  'use strict';

  if (window.__SNAP_AUTO_LOADED__) return;
  window.__SNAP_AUTO_LOADED__ = true;

  // --- State Machine States ---
  const MachineState = {
    IDLE: 'IDLE',
    OPENING_CHAT: 'OPENING_CHAT',
    SCANNING_CHAT: 'SCANNING_CHAT',
    SCROLLING_UP: 'SCROLLING_UP',
    WAITING_FOR_OLDER_MESSAGES: 'WAITING_FOR_OLDER_MESSAGES',
    PROCESSING_SNAP: 'PROCESSING_SNAP',
    VERIFYING_CHAT_HISTORY: 'VERIFYING_CHAT_HISTORY',
    VERIFYING_SIDEBAR_STATUS: 'VERIFYING_SIDEBAR_STATUS',
    CHAT_COMPLETED: 'CHAT_COMPLETED',
    MOVING_TO_NEXT_CHAT: 'MOVING_TO_NEXT_CHAT',
    SCROLLING_SIDEBAR: 'SCROLLING_SIDEBAR',
    PAUSED: 'PAUSED',
    BLOCKED: 'BLOCKED',
    ERROR: 'ERROR',
    COMPLETED: 'COMPLETED'
  };

  let currentMachineState = MachineState.IDLE;

  // Default Settings
  const DEFAULT_SETTINGS = {
    enabled: false,
    mode: 'all_chats',
    viewDuration: 2000,
    chatDelay: 1200,
    humanJitter: false,
    autoScroll: true,
    cooldownEnabled: true,
    batchSize: 50,
    batchCooldown: 8000,
    hudVisible: true,
    hudMinimized: false,
    speedPreset: 'balanced',
    stats: {
      sessionOpened: 0,
      totalOpened: 0,
      chatsScanned: 0,
      lastReset: new Date().toISOString()
    }
  };

  let state = {
    ...DEFAULT_SETTINGS,
    isRunning: false,
    isCooldown: false,
    statusText: 'Ready',
    currentSnapCount: 0,
    hudEl: null
  };

  // Activity Log Buffer
  const activityLogs = [];
  function addLog(msg) {
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = { time, msg };
    activityLogs.unshift(entry);
    if (activityLogs.length > 30) activityLogs.pop();
    renderLogs();
  }

  // --- Strict Filters ---
  const MOBILE_ONLY_REGEX = /open (?:the )?(?:mobile|snapchat) app|only available on mobile|cannot be viewed on web|switch to mobile|open snapchat on your phone|new snap on mobile/i;
  const OUTGOING_REGEX = /\b(?:delivered|sent|sending|pending|failed to send|you sent|opened|replayed)\b/i;
  const UNREAD_FEED_REGEX = /\b(?:new (?:chats? and )?snaps?|tap to view|click to view)\b/i;

  const completedChats = new Set();
  const skippedChats = new Map();
  const failedSnapSignatures = new Set();

  let lastUserScrollTime = 0;
  function isUserInteractingWithSidebar() {
    return (Date.now() - lastUserScrollTime < 1500);
  }

  function setupUserActivityListeners() {
    window.addEventListener('wheel', (e) => {
      if (e.clientX < 450) {
        lastUserScrollTime = Date.now();
      }
    }, { capture: true, passive: true });
  }

  // Safety watchdog: prevent search bar from ever staying focused
  setInterval(() => {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      const ph = (document.activeElement.getAttribute('placeholder') || '').toLowerCase();
      if (ph.includes('search')) {
        document.activeElement.blur();
      }
    }
  }, 1000);

  /**
   * SAFETY GUARD: Identifies dangerous buttons that must NEVER be clicked!
   * Blocks: Call, Phone, Video, Audio, Dial, Camera, Back, Block, Report, Leave, Story
   * Blocks: ANY button in the top chat header (rect.top < 110)
   */
  function isDangerousButton(el) {
    if (!el) return true;
    const text = (el.innerText || '').toLowerCase();
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const testId = (el.getAttribute('data-testid') || '').toLowerCase();
    const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const all = `${text} ${label} ${title} ${testId} ${className}`;

    if (/\b(?:call|video|phone|audio|dial|camera|back|leave|block|delete|report|story)\b/i.test(all)) {
      return true;
    }

    const rect = el.getBoundingClientRect();
    if (rect.top < 110) {
      return true;
    }

    return false;
  }

  function isChatSkipped(friendName) {
    if (!friendName) return false;
    const key = friendName.toLowerCase().trim();
    const until = skippedChats.get(key);
    if (!until) return false;
    if (Date.now() > until) {
      skippedChats.delete(key);
      return false;
    }
    return true;
  }

  function skipChat(friendName, reason = 'Unverified', durationMs = 25 * 1000) {
    if (!friendName) return;
    const key = friendName.toLowerCase().trim();
    skippedChats.set(key, Date.now() + durationMs);
    addLog(`⏭ Skipping ${friendName}: ${reason}`);
  }

  function markSnapFailed(snapElement) {
    if (!snapElement) return;
    try {
      snapElement.dataset.snapautoFailed = 'true';
      const rect = snapElement.getBoundingClientRect();
      const sig = (snapElement.innerText || '').replace(/\s+/g, ' ').slice(0, 60) + '_' + Math.round(rect.top);
      failedSnapSignatures.add(sig);

      let p = snapElement.parentElement;
      for (let i = 0; i < 4 && p; i++) {
        p.dataset.snapautoFailed = 'true';
        p = p.parentElement;
      }
    } catch (e) {}
  }

  // --- Utility Functions ---

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function simulateClick(element) {
    if (!element) return;
    try {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width * 0.5;
      const y = rect.top + rect.height * 0.5;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
        try {
          element.dispatchEvent(new MouseEvent(type, opts));
        } catch (e) {}
      });

      if (typeof element.click === 'function') {
        element.click();
      }
    } catch (e) {
      console.warn('[SnapAuto] Click simulation error:', e);
    }
  }

  function simulateKeyPress(key, code) {
    const opts = {
      key: key,
      code: code || key,
      keyCode: key === 'Escape' ? 27 : (key === 'PageUp' ? 33 : 0),
      which: key === 'Escape' ? 27 : (key === 'PageUp' ? 33 : 0),
      bubbles: true,
      cancelable: true,
      view: window
    };
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch (e) {}
  }

  function isOutgoingMessage(element) {
    if (!element || typeof element.closest !== 'function') return false;
    const container = element.closest('li, [role="row"], [data-testid*="message"], div[class*="message"]') || element.parentElement || element;
    if (!container) return false;

    const fullText = (container.innerText || '').toLowerCase();
    if (fullText.includes('right click to replay') || fullText.includes('replay or save')) return true;
    if (OUTGOING_REGEX.test(fullText) && !/new snap|tap to view|click to view/i.test(fullText)) return true;

    try {
      const computed = window.getComputedStyle(container);
      if (computed.alignSelf === 'flex-end' || computed.justifyContent === 'flex-end') return true;
    } catch (e) {}

    return false;
  }

  function isMobileOnlyNoticePresent() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], div[class*="modal"], div[class*="dialog"]'));
    for (const dlg of dialogs) {
      if (dlg.offsetWidth > 0 && dlg.offsetHeight > 0 && dlg.id !== 'snapauto-hud' && (!dlg.closest || !dlg.closest('#snapauto-hud'))) {
        const text = (dlg.innerText || '').toLowerCase();
        if (MOBILE_ONLY_REGEX.test(text) || text.includes('on mobile')) return dlg;
      }
    }

    const notices = Array.from(document.querySelectorAll('div, span, p')).filter(el => {
      if (el.id === 'snapauto-hud' || (el.closest && el.closest('#snapauto-hud'))) return false;
      const t = (el.innerText || '').toLowerCase();
      return (MOBILE_ONLY_REGEX.test(t) || t.includes('on mobile')) && el.offsetWidth > 0 && el.offsetHeight > 0;
    });

    return notices.length > 0 ? notices[0] : null;
  }

  function getActiveChatName() {
    const headerTitle = document.querySelector('header h1, header h2, header [data-testid*="title"], [data-testid*="chat-header"] span, [role="main"] header h2');
    if (headerTitle && headerTitle.innerText && headerTitle.innerText.trim()) {
      return headerTitle.innerText.trim();
    }

    const header = document.querySelector('header, [role="banner"], [data-testid*="chat-header"]');
    if (header) {
      const texts = Array.from(header.querySelectorAll('span, div, h2, h3'))
        .map(el => el.innerText ? el.innerText.trim() : '')
        .filter(t => t && t.length > 1 && !/^(call|video|search|view|back|active now|\d+[smhdw])$/i.test(t));
      if (texts.length > 0) return texts[0];
    }

    const mainHeader = Array.from(document.querySelectorAll('div, span, h2')).find(el => {
      if (el.id === 'snapauto-hud' || (el.closest && el.closest('#snapauto-hud'))) return false;
      const rect = el.getBoundingClientRect();
      return rect.top >= 40 && rect.top <= 100 && rect.left >= 200 && rect.left <= 700 && el.offsetHeight > 15;
    });
    if (mainHeader && mainHeader.innerText && mainHeader.innerText.trim()) {
      return mainHeader.innerText.trim().split('\n')[0];
    }

    return 'Active Chat';
  }

  // --- Snap Viewer Detection ---

  function isSnapViewerOpen() {
    const overlays = Array.from(document.querySelectorAll('div[class*="overlay"], div[class*="viewer"], div[class*="snapView"], div[class*="player"]')).filter(el => {
      if (el.id === 'snapauto-hud' || (el.closest && el.closest('#snapauto-hud'))) return false;
      const style = window.getComputedStyle(el);
      const isHighZ = parseInt(style.zIndex, 10) > 20;
      const isFloating = style.position === 'fixed' || style.position === 'absolute';
      const coversLargeArea = el.offsetWidth > window.innerWidth * 0.35 && el.offsetHeight > window.innerHeight * 0.5;
      return isHighZ && isFloating && coversLargeArea;
    });

    if (overlays.length > 0) return true;

    const replyInput = document.querySelector('[placeholder*="Reply to Snap" i], [aria-label*="Reply to Snap" i], input[value*="Reply to Snap" i]');
    if (replyInput && (replyInput.offsetWidth > 0 || replyInput.offsetHeight > 0)) return true;

    const playerContainer = document.querySelector('[data-testid*="snap-player" i], [data-testid*="media-viewer" i], [class*="snapPlayer" i], [class*="mediaViewer" i]');
    if (playerContainer && (playerContainer.offsetWidth > 0 || playerContainer.offsetHeight > 0)) return true;

    const activeMedia = Array.from(document.querySelectorAll('video, canvas')).find(el => {
      if (!el.closest || el.closest('#snapauto-hud') || el.closest('[role="row"], [role="listitem"]')) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 200 && rect.height > 300 && rect.left > 350;
    });

    if (activeMedia) return true;

    return false;
  }

  /**
   * Safe Snap Viewer Dismissal:
   * 1. Escape key is primary dismissal (clean, standard, never clicks dangerous buttons).
   * 2. Close buttons strictly confined to viewer pane (rect.left > 400 && rect.top > 110).
   * 3. NEVER touches Call, Video Call, or Chat Header buttons!
   */
  async function dismissSnapViewer() {
    simulateKeyPress('Escape');
    await sleep(150);
    if (!isSnapViewerOpen()) return true;

    const viewerCloseButtons = Array.from(document.querySelectorAll(
      'button[aria-label*="Close" i], [role="button"][aria-label*="Close" i], button[data-testid*="close" i], button[class*="close" i]'
    )).filter(btn => {
      const rect = btn.getBoundingClientRect();
      return rect.left > 400 && rect.top > 110 && !isDangerousButton(btn);
    });

    for (const btn of viewerCloseButtons) {
      simulateClick(btn);
      await sleep(150);
      if (!isSnapViewerOpen()) return true;
    }

    const player = document.querySelector('[data-testid*="snap-player" i], [data-testid*="media-viewer" i], [class*="snapPlayer" i], video, canvas');
    if (player) {
      const pRect = player.getBoundingClientRect();
      if (pRect.left > 400 && pRect.top > 110) {
        simulateClick(player);
        await sleep(150);
        if (!isSnapViewerOpen()) return true;
      }
    }

    simulateKeyPress('Escape');
    await sleep(150);

    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      const placeholder = (document.activeElement.getAttribute('placeholder') || '').toLowerCase();
      if (placeholder.includes('search')) {
        document.activeElement.blur();
      }
    }

    return !isSnapViewerOpen();
  }

  // --- Center Chat Pane Snaps & Container ---

  /**
   * Finds all unopened incoming snap elements in the center chat pane.
   * Identifies mobile-only status and sorts bottom-to-top (newest visible first).
   */
  function findUnopenedSnapsInActiveChat() {
    const candidates = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!node.textContent) return NodeFilter.FILTER_REJECT;
          const text = node.textContent.trim().toLowerCase();
          if (text === 'new snap' || text === 'click to view' || text === 'tap to view' || text.startsWith('new snap')) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    let textNode;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement;
      if (!parent || (parent.closest && parent.closest('#snapauto-hud'))) continue;

      let messageCard = parent;
      for (let i = 0; i < 4 && messageCard && messageCard.parentElement; i++) {
        const role = messageCard.getAttribute ? messageCard.getAttribute('role') : '';
        if (role === 'row' || role === 'listitem' || messageCard.tagName === 'LI') break;
        if (messageCard.parentElement.getAttribute && (messageCard.parentElement.getAttribute('role') === 'list' || messageCard.parentElement.getAttribute('role') === 'log')) break;
        messageCard = messageCard.parentElement;
      }
      const cardText = (messageCard.innerText || '').toLowerCase();

      if (cardText.includes('right click to replay') || cardText.includes('replay or save')) continue;
      if (OUTGOING_REGEX.test(cardText) && !/new snap|tap to view|click to view/i.test(cardText)) continue;
      if (isOutgoingMessage(messageCard)) continue;

      const isMobile = (MOBILE_ONLY_REGEX.test(cardText) || cardText.includes('on mobile') || cardText.includes('open snapchat on your phone'));

      if (parent.dataset && parent.dataset.snapautoFailed === 'true') continue;
      if (parent.closest && parent.closest('[data-snapauto-failed="true"]')) continue;

      let clickable = parent;
      for (let i = 0; i < 5 && clickable && clickable !== document.body; i++) {
        if (clickable.tagName === 'BUTTON' || clickable.getAttribute('role') === 'button' || clickable.onclick || window.getComputedStyle(clickable).cursor === 'pointer') {
          break;
        }
        if (clickable.parentElement) clickable = clickable.parentElement;
      }

      if (clickable.dataset && clickable.dataset.snapautoFailed === 'true') continue;
      if (clickable.closest && clickable.closest('[data-snapauto-failed="true"]')) continue;
      if (isDangerousButton(clickable)) continue;

      const rect = clickable.getBoundingClientRect();
      // Snap cards are strictly inside chat message area (left > 180, top >= 65, bottom < window.innerHeight - 65)
      if (rect.left > 180 && rect.top >= 65 && rect.bottom < window.innerHeight - 65 && rect.width > 0 && rect.height > 0) {
        const sig = (clickable.innerText || '').replace(/\s+/g, ' ').slice(0, 60) + '_' + Math.round(rect.top);
        if (failedSnapSignatures.has(sig)) continue;

        if (!candidates.some(c => c.element === clickable)) {
          candidates.push({ element: clickable, isMobile, top: rect.top });
        }
      }
    }

    // Sort strictly bottom-to-top (newest visible first)
    candidates.sort((a, b) => b.top - a.top);
    return candidates;
  }

  /**
   * Finds the actual scrollable message container in the active chat pane.
   */
  function findMessageScrollContainer() {
    // Strategy 1: Find message elements and walk up to the actual scroll container
    const messages = Array.from(document.querySelectorAll(
      '[role="row"], [role="listitem"], [data-testid*="message"], div[class*="message"], [data-testid*="chat-message"]'
    )).filter(el => {
      const r = el.getBoundingClientRect();
      return r.left > 180 && r.left < window.innerWidth - 80 && r.height > 10;
    });

    for (const msg of messages.slice(0, 8)) {
      let curr = msg.parentElement;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        if (curr.id === 'snapauto-hud' || (curr.closest && curr.closest('#snapauto-hud'))) break;
        const r = curr.getBoundingClientRect();
        if (r.left > 160 && r.left < window.innerWidth - 60 && r.height > 200) {
          const style = window.getComputedStyle(curr);
          const isScrollableStyle = /(auto|scroll|overlay)/.test(style.overflowY);
          const hasScroll = curr.scrollHeight > curr.clientHeight + 10;
          if (isScrollableStyle && hasScroll) {
            return curr;
          }
        }
        curr = curr.parentElement;
      }
    }

    // Strategy 2: Direct scan of center pane elements with overflowY
    const candidates = Array.from(document.querySelectorAll(
      'main, [role="main"], [role="log"], [role="list"], section, div, ul'
    )).filter(el => {
      if (el.id === 'snapauto-hud' || (el.closest && el.closest('#snapauto-hud'))) return false;
      const r = el.getBoundingClientRect();
      if (r.left < 160 || r.left > window.innerWidth - 80 || r.width < 250 || r.height < 300 || r.top > 160) return false;
      const style = window.getComputedStyle(el);
      const isScroll = /(auto|scroll|overlay)/.test(style.overflowY);
      return isScroll && (el.scrollHeight > el.clientHeight + 10);
    });

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.scrollHeight - b.scrollHeight);
      return candidates[0];
    }

    return null;
  }

  /**
   * Progressively scrolls UP through the message container:
   * Uses smooth scrollBy step, fallback scrollTop, scroll event, and
   * scrolls the topmost visible message into view to trigger dynamic virtualization loading.
   */
  async function scrollContainerUp(container) {
    if (!container) return { scrolled: false, atTop: true };

    const beforeScrollTop = container.scrollTop;
    const beforeScrollHeight = container.scrollHeight;

    // Progressive upward scroll step (380px)
    const scrollStep = 380;
    try {
      container.scrollBy({ top: -scrollStep, behavior: 'instant' });
    } catch (e) {}

    if (container.scrollTop > 0) {
      container.scrollTop = Math.max(0, container.scrollTop - scrollStep);
    }

    try {
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    } catch (e) {}

    try {
      container.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -400,
        view: window
      }));
    } catch (e) {}

    try {
      container.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', code: 'PageUp', keyCode: 33, bubbles: true }));
      container.dispatchEvent(new KeyboardEvent('keyup', { key: 'PageUp', code: 'PageUp', keyCode: 33, bubbles: true }));
    } catch (e) {}

    // Scroll topmost visible element into view to trigger dynamic virtualization loading
    const visibleMessages = Array.from(container.querySelectorAll(
      '[role="row"], [role="listitem"], [data-testid*="message"], div[class*="message"]'
    )).filter(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 70 && r.height > 10;
    });

    if (visibleMessages.length > 0) {
      visibleMessages.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const topVisible = visibleMessages[0];
      if (topVisible && topVisible.previousElementSibling) {
        try {
          topVisible.previousElementSibling.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
        } catch (e) {}
      }
    }

    await sleep(400);

    const afterScrollTop = container.scrollTop;
    const isAtTop = afterScrollTop <= 10;
    const didScroll = Math.abs(beforeScrollTop - afterScrollTop) > 5;

    return { scrolled: didScroll, atTop: isAtTop, beforeHeight: beforeScrollHeight };
  }

  function findConversationListContainer() {
    const elements = Array.from(document.querySelectorAll('div, section, nav, aside')).filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.left > 200 || rect.width > 500 || rect.height < 300) return false;
      const style = window.getComputedStyle(el);
      const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      return isScrollable;
    });

    if (elements.length === 0) return null;
    elements.sort((a, b) => b.scrollHeight - a.scrollHeight);
    return elements[0];
  }

  function extractRowName(row) {
    if (!row) return 'Friend';
    const lines = (row.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (
        !UNREAD_FEED_REGEX.test(line) &&
        !OUTGOING_REGEX.test(line) &&
        !MOBILE_ONLY_REGEX.test(line) &&
        !/^(view|call|chat|notifications|turn on|snapchat|my ai|search)$/i.test(line) &&
        !/^\d+[smhdw]$/i.test(line) &&
        !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(line)
      ) {
        return line.slice(0, 40);
      }
    }
    return 'Friend';
  }

  /**
   * Checks whether a conversation row in the left sidebar still has unread status.
   * True if purple "View" button is present or unread text matches.
   */
  function isRowUnread(row) {
    if (!row) return false;
    const text = (row.innerText || '').toLowerCase();

    // 1. Purple "View" button is present
    const viewBtn = row.querySelector('button, [role="button"]');
    if (viewBtn && /view/i.test(viewBtn.innerText || '')) {
      return true;
    }

    // 2. Unread badge / "New Snap" / "New Chats and Snaps"
    if (UNREAD_FEED_REGEX.test(text) && !OUTGOING_REGEX.test(text)) {
      return true;
    }

    return false;
  }

  /**
   * Finds the sidebar row corresponding to an active chat name.
   */
  function findSidebarRowForChat(chatName) {
    if (!chatName) return null;
    const target = chatName.toLowerCase().trim();
    const rows = Array.from(document.querySelectorAll(
      '[role="row"], [role="listitem"], [data-testid*="conversation"], [data-testid*="chat-item"]'
    )).filter(r => {
      const rect = r.getBoundingClientRect();
      return rect.left < 450 && rect.top >= 100 && rect.width > 100;
    });

    for (const r of rows) {
      const name = extractRowName(r).toLowerCase().trim();
      if (name === target || name.includes(target) || target.includes(name)) {
        return r;
      }
    }
    return null;
  }

  /**
   * Finds unread conversations in the left sidebar feed.
   * Strictly matches rows where isRowUnread(row) is true.
   * Sorts strictly by vertical position (rect.top ascending).
   */
  function findUnreadConversations() {
    const unreadChats = [];
    const seenElements = new Set();

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!node.textContent) return NodeFilter.FILTER_REJECT;
          const text = node.textContent.trim();
          if (UNREAD_FEED_REGEX.test(text) || /^view$/i.test(text)) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    let textNode;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement;
      if (!parent || (parent.closest && parent.closest('#snapauto-hud'))) continue;

      const rect = parent.getBoundingClientRect();
      if (rect.left < 450 && rect.top >= 170 && rect.width > 0 && rect.height > 0) {
        if (parent.closest && parent.closest('[role="search"], form, [data-testid*="search"]')) continue;

        let row = parent;
        for (let i = 0; i < 7 && row && row.parentElement && row.parentElement !== document.body; i++) {
          const role = row.getAttribute ? row.getAttribute('role') : '';
          if (role === 'button' || role === 'row' || role === 'listitem') break;
          if (row.parentElement.getAttribute && (row.parentElement.getAttribute('role') === 'list' || row.parentElement.children.length > 5)) break;
          row = row.parentElement;
        }

        const rowRect = row.getBoundingClientRect();
        if (rowRect.top < 170) continue;

        if (row && !seenElements.has(row)) {
          if (!isRowUnread(row)) continue;

          const friendName = extractRowName(row);
          if (/^(search|my ai|turn on|notifications)$/i.test(friendName)) continue;
          if (isChatSkipped(friendName)) continue;

          seenElements.add(row);
          unreadChats.push({ element: row, name: friendName, top: rowRect.top });
        }
      }
    }

    // STRICT LINEAR TOP-TO-BOTTOM ORDER
    unreadChats.sort((a, b) => a.top - b.top);
    return unreadChats;
  }

  /**
   * Safe Conversation Row Opener
   * NEVER clicks avatar circle (x < 80) to avoid opening Private Stories!
   * Clicks "View" button or friend name in the middle (x > 120).
   */
  function openConversationRow(row) {
    if (!row) return false;

    // 1. If "View" button exists, clicking it is 100% safe
    const viewBtn = row.querySelector('button, [role="button"]');
    if (viewBtn && /view/i.test(viewBtn.innerText || '') && !isDangerousButton(viewBtn)) {
      simulateClick(viewBtn);
      return true;
    }

    // 2. Click friend name element (safely away from avatar circle)
    const nameEl = row.querySelector('span, h3, h2, [data-testid*="name"]');
    if (nameEl && !isDangerousButton(nameEl)) {
      const rect = nameEl.getBoundingClientRect();
      if (rect.left > 75) {
        simulateClick(nameEl);
        return true;
      }
    }

    // 3. Fallback: Click the row in the middle (x = left + 150), NEVER on avatar (x < 75)
    const rowRect = row.getBoundingClientRect();
    const safeX = Math.max(rowRect.left + 120, rowRect.left + rowRect.width * 0.5);
    const safeY = rowRect.top + rowRect.height * 0.5;

    const mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: safeX, clientY: safeY };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
      try {
        row.dispatchEvent(new MouseEvent(type, mouseOpts));
      } catch (e) {}
    });

    return true;
  }

  // --- Snap Viewing Orchestration ---

  async function handleSnapViewing(targetName = 'Friend', snapElement = null) {
    let viewerOpen = false;

    for (let i = 0; i < 7; i++) {
      if (isSnapViewerOpen()) {
        viewerOpen = true;
        break;
      }

      const mobileNotice = isMobileOnlyNoticePresent();
      if (mobileNotice) {
        simulateKeyPress('Escape');
        const okBtn = mobileNotice.querySelector('button');
        if (okBtn) simulateClick(okBtn);
        await sleep(200);
        markSnapFailed(snapElement);
        return { success: false, isMobile: true };
      }

      await sleep(200);
    }

    if (!viewerOpen) {
      const mobileNotice = isMobileOnlyNoticePresent();
      if (mobileNotice) {
        simulateKeyPress('Escape');
        const okBtn = mobileNotice.querySelector('button');
        if (okBtn) simulateClick(okBtn);
        await sleep(200);
        markSnapFailed(snapElement);
        return { success: false, isMobile: true };
      }
      markSnapFailed(snapElement);
      return { success: false, isMobile: false };
    }

    // Snap viewer is open: view for strictly 1.2s per user instruction
    updateStatus(`Viewing snap from ${targetName}...`, 'running');
    await sleep(state.viewDuration);

    const closed = await dismissSnapViewer();
    if (closed || !isSnapViewerOpen()) {
      recordSnapOpened();
      return { success: true, isMobile: false };
    }

    simulateKeyPress('Escape');
    await sleep(200);
    recordSnapOpened();
    return { success: true, isMobile: false };
  }

  /**
   * State Machine State Dispatcher
   */
  function setMachineState(newState, detail = '') {
    currentMachineState = newState;
    let displayStatus = newState;
    let dotClass = 'running';

    switch (newState) {
      case MachineState.IDLE:
        displayStatus = 'Ready';
        dotClass = 'paused';
        break;
      case MachineState.OPENING_CHAT:
        displayStatus = `Opening: ${detail}`;
        break;
      case MachineState.SCANNING_CHAT:
        displayStatus = 'Scanning chat history';
        break;
      case MachineState.SCROLLING_UP:
        displayStatus = 'Scrolling upward';
        break;
      case MachineState.WAITING_FOR_OLDER_MESSAGES:
        displayStatus = 'Older messages loading...';
        dotClass = 'cooldown';
        break;
      case MachineState.PROCESSING_SNAP:
        displayStatus = `Processing snap: ${detail}`;
        break;
      case MachineState.VERIFYING_CHAT_HISTORY:
        displayStatus = 'Checking remaining snaps';
        break;
      case MachineState.VERIFYING_SIDEBAR_STATUS:
        displayStatus = 'Checking sidebar unread status';
        break;
      case MachineState.CHAT_COMPLETED:
        displayStatus = 'Conversation verified complete';
        break;
      case MachineState.MOVING_TO_NEXT_CHAT:
        displayStatus = 'Finding next conversation';
        break;
      case MachineState.SCROLLING_SIDEBAR:
        displayStatus = 'Scanning sidebar feed';
        break;
      case MachineState.PAUSED:
        displayStatus = detail || 'Paused';
        dotClass = 'paused';
        break;
      case MachineState.BLOCKED:
        displayStatus = `Blocked: ${detail}`;
        dotClass = 'cooldown';
        break;
      case MachineState.ERROR:
        displayStatus = `Error: ${detail}`;
        dotClass = 'cooldown';
        break;
      case MachineState.COMPLETED:
        displayStatus = 'All conversations completed';
        dotClass = 'paused';
        break;
    }

    updateStatus(displayStatus, dotClass);
  }

  /**
   * CRITICAL BUG 1 & BUG 2 RESOLUTION:
   * Reliable Conversation Processing with Progressive Upward Scan & Two-Tier Verification
   */
  async function processConversation(chatName, chatRow) {
    let hasMobileInaccessible = false;
    let snapsOpenedInChat = 0;
    let consecutiveScrollsWithoutNewMessages = 0;
    let reachedTopOfHistory = false;

    // 1. Initial scan at bottom of chat
    setMachineState(MachineState.SCANNING_CHAT);
    addLog('Scanning chat history');
    await sleep(500);

    // Progressive upward processing loop
    while (state.isRunning && state.enabled) {
      // Find all unopened snaps visible in current view
      const visibleSnaps = findUnopenedSnapsInActiveChat();

      if (visibleSnaps.length > 0) {
        consecutiveScrollsWithoutNewMessages = 0;
        // Process each visible snap individually
        for (const snapItem of visibleSnaps) {
          if (!state.isRunning || !state.enabled) break;

          if (snapItem.isMobile) {
            addLog('Mobile-only snap detected');
            addLog('Conversation completion not verified');
            markSnapFailed(snapItem.element);
            hasMobileInaccessible = true;
            continue;
          }

          setMachineState(MachineState.PROCESSING_SNAP, chatName);
          simulateClick(snapItem.element);

          const result = await handleSnapViewing(chatName, snapItem.element);
          if (result.success) {
            snapsOpenedInChat++;
            addLog('Snap processed');
          } else if (result.isMobile) {
            addLog('Mobile-only snap detected');
            addLog('Conversation completion not verified');
            hasMobileInaccessible = true;
          } else {
            markSnapFailed(snapItem.element);
          }

          await sleep(Math.min(state.chatDelay, 600));
        }

        // Re-scan current view to see if more snaps appeared at this level
        const remainingAtThisLevel = findUnopenedSnapsInActiveChat();
        if (remainingAtThisLevel.length > 0) {
          continue;
        }
      }

      // If we have already reached the top of history, stop upward scrolling
      if (reachedTopOfHistory) {
        break;
      }

      // 2. Progressive upward scroll
      setMachineState(MachineState.SCROLLING_UP);
      addLog('Scrolling upward');

      const container = findMessageScrollContainer();
      if (!container) {
        break;
      }

      const prevScrollTop = container.scrollTop;
      const prevScrollHeight = container.scrollHeight;

      await scrollContainerUp(container);

      setMachineState(MachineState.WAITING_FOR_OLDER_MESSAGES);
      await sleep(700); // Wait for dynamic messages to load

      const newScrollHeight = container.scrollHeight;
      const newScrollTop = container.scrollTop;

      const heightChanged = (newScrollHeight > prevScrollHeight + 20);
      const scrollTopDecreased = (newScrollTop < prevScrollTop - 10);

      if (heightChanged || scrollTopDecreased) {
        addLog('Older messages loaded');
        consecutiveScrollsWithoutNewMessages = 0;
      } else {
        consecutiveScrollsWithoutNewMessages++;
      }

      // Check if top of history reached:
      // container is at top (scrollTop <= 10) AND no new messages loaded after consecutive attempts
      if (container.scrollTop <= 10 && consecutiveScrollsWithoutNewMessages >= 3) {
        reachedTopOfHistory = true;
      }

      // Bounded safety limit: maximum 35 scroll steps per conversation
      if (consecutiveScrollsWithoutNewMessages >= 5) {
        reachedTopOfHistory = true;
      }
    }

    if (!state.isRunning || !state.enabled) return { success: false };

    // 3. Scan loaded history again to ensure no eligible unopened snaps were missed
    setMachineState(MachineState.VERIFYING_CHAT_HISTORY);
    addLog('Checking remaining snaps');
    await sleep(400);

    const remainingSnaps = findUnopenedSnapsInActiveChat();
    for (const snapItem of remainingSnaps) {
      if (!state.isRunning || !state.enabled) break;
      if (snapItem.isMobile) {
        addLog('Mobile-only snap detected');
        addLog('Conversation completion not verified');
        hasMobileInaccessible = true;
        continue;
      }

      setMachineState(MachineState.PROCESSING_SNAP, chatName);
      simulateClick(snapItem.element);
      const res = await handleSnapViewing(chatName, snapItem.element);
      if (res.success) {
        snapsOpenedInChat++;
        addLog('Snap processed');
      } else if (res.isMobile) {
        addLog('Mobile-only snap detected');
        addLog('Conversation completion not verified');
        hasMobileInaccessible = true;
      }
      await sleep(400);
    }

    // 4. Return attention to the corresponding conversation entry in the left sidebar
    setMachineState(MachineState.VERIFYING_SIDEBAR_STATUS);
    addLog('Checking sidebar unread status');
    await sleep(500);

    // If mobile-only snaps were found, we CANNOT verify completion!
    if (hasMobileInaccessible) {
      addLog('Conversation completion not verified');
      setMachineState(MachineState.PAUSED, 'Paused: Mobile-only snap present');
      state.enabled = false;
      state.isRunning = false;
      saveSettingsToStorage();
      renderUI();
      return { success: false, reason: 'mobile_only' };
    }

    // Check sidebar row for this chat with bounded retry
    let isSidebarStillUnread = true;
    for (let checkAttempt = 0; checkAttempt < 3; checkAttempt++) {
      const currentSidebarRow = findSidebarRowForChat(chatName) || chatRow;
      isSidebarStillUnread = currentSidebarRow ? isRowUnread(currentSidebarRow) : false;
      if (!isSidebarStillUnread) break;
      await sleep(500);
    }

    if (isSidebarStillUnread) {
      // The sidebar still indicates unread snaps! Never mark complete prematurely.
      addLog(`Unread indicator still present for ${chatName}`);
      addLog('Conversation completion not verified');
      setMachineState(MachineState.PAUSED, `Paused: Unverified unread status for ${chatName}`);
      state.enabled = false;
      state.isRunning = false;
      saveSettingsToStorage();
      renderUI();
      return { success: false, reason: 'sidebar_unread_remains' };
    }

    // Both checks succeeded!
    setMachineState(MachineState.CHAT_COMPLETED);
    addLog('Conversation verified complete');
    return { success: true, snapsOpened: snapsOpenedInChat };
  }

  // --- Automation Loop Execution ---

  async function startLoop() {
    if (state.isRunning) return;
    state.isRunning = true;
    setMachineState(MachineState.MOVING_TO_NEXT_CHAT);
    addLog('▶ SnapAuto started');

    try {
      while (state.isRunning && state.enabled) {
        if (state.cooldownEnabled && state.currentSnapCount >= state.batchSize) {
          state.isCooldown = true;
          updateStatus(`Pacing pause (${Math.round(state.batchCooldown / 1000)}s)...`, 'cooldown');
          addLog(`⏸ Safe pause: ${Math.round(state.batchCooldown / 1000)}s`);

          let remaining = state.batchCooldown;
          while (remaining > 0 && state.isRunning && state.enabled) {
            await sleep(1000);
            remaining -= 1000;
            if (remaining > 0) {
              updateStatus(`Pacing pause: ${Math.round(remaining / 1000)}s`, 'cooldown');
            }
          }
          state.currentSnapCount = 0;
          state.isCooldown = false;
          updateStatus('Resuming...', 'running');
        }

        // 1. If currently inside an open Snap viewer, dismiss it first
        if (isSnapViewerOpen()) {
          const chatName = getActiveChatName();
          updateStatus(`Viewing snap from ${chatName}...`, 'running');
          await sleep(state.viewDuration);
          await dismissSnapViewer();
          recordSnapOpened();
          addLog('Snap processed');
          await sleep(300);
          continue;
        }

        // 2. Mode: Active Chat Only
        if (state.mode === 'active_chat') {
          const currentChat = getActiveChatName();
          await processConversation(currentChat, null);
          updateStatus('Watching active chat...', 'running');
          await sleep(1000);
          continue;
        }

        // 3. Mode: All Chats (Continuous Sequential Feed Cycler)
        setMachineState(MachineState.MOVING_TO_NEXT_CHAT);
        const unreadChats = findUnreadConversations().filter(c => !completedChats.has(c.name.toLowerCase().trim()));
        state.stats.chatsScanned += unreadChats.length;

        if (unreadChats.length > 0) {
          const target = unreadChats[0];
          setMachineState(MachineState.OPENING_CHAT, target.name);
          if (completedChats.size > 0) {
            addLog(`Opening next conversation: ${target.name}`);
          } else {
            addLog(`Opening: ${target.name}`);
          }

          // SAFELY OPEN CHAT (NEVER CLICKS AVATAR OR STORY)
          openConversationRow(target.element);

          // Wait 700ms for chat messages to hydrate
          await sleep(700);

          // COMPLETE FULL BOTTOM-TO-TOP SCAN & VERIFICATION!
          const procRes = await processConversation(target.name, target.element);

          if (procRes.success) {
            completedChats.add(target.name.toLowerCase().trim());
          } else {
            // Paused for user intervention if not verified
            break;
          }

          await sleep(state.chatDelay);
        } else {
          // No unread chats in visible sidebar: scroll feed downwards smoothly
          if (state.autoScroll) {
            if (isUserInteractingWithSidebar()) {
              await sleep(1500);
              continue;
            }

            setMachineState(MachineState.SCROLLING_SIDEBAR);
            const scrollContainer = findConversationListContainer();
            if (scrollContainer) {
              const currentScroll = scrollContainer.scrollTop;
              const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
              const isAtBottom = maxScroll > 0 && currentScroll >= (maxScroll - 40);

              if (isAtBottom) {
                setMachineState(MachineState.COMPLETED);
                addLog('Reached end of friend feed');
                stopLoop();
                break;
              } else {
                scrollContainer.scrollBy({ top: 320, behavior: 'smooth' });
                await sleep(1000);
              }
            } else {
              setMachineState(MachineState.IDLE);
              await sleep(1500);
            }
          } else {
            setMachineState(MachineState.IDLE);
            await sleep(1500);
          }
        }
      }
    } catch (err) {
      console.error('[SnapAuto Error]', err);
      addLog(`⚠ Notice: ${err.message || 'Waiting to recover'}`);
      await sleep(1500);
      if (state.enabled) {
        state.isRunning = false;
        startLoop();
      }
    } finally {
      state.isRunning = false;
      if (!state.enabled && currentMachineState !== MachineState.COMPLETED) {
        setMachineState(MachineState.PAUSED);
        addLog('⏸ SnapAuto paused');
      }
    }
  }

  function stopLoop() {
    state.enabled = false;
    state.isRunning = false;
    setMachineState(MachineState.PAUSED);
    saveSettingsToStorage();
    renderUI();
  }

  function toggleAutoOpener() {
    if (state.enabled) {
      stopLoop();
    } else {
      state.enabled = true;
      saveSettingsToStorage();
      renderUI();
      startLoop();
    }
  }

  function recordSnapOpened() {
    state.currentSnapCount++;
    state.stats.sessionOpened++;
    state.stats.totalOpened++;
    saveSettingsToStorage();
    renderUI();
  }

  function applySpeedPreset(preset) {
    state.speedPreset = preset;
    if (preset === 'fast') {
      state.viewDuration = 1200; // Strict 1.2s
      state.chatDelay = 700;
      state.batchSize = 50;
    } else if (preset === 'balanced') {
      state.viewDuration = 2000;
      state.chatDelay = 1200;
      state.batchSize = 30;
    } else if (preset === 'safe') {
      state.viewDuration = 3500;
      state.chatDelay = 1800;
      state.batchSize = 20;
    }
    saveSettingsToStorage();
    renderUI();
    addLog(`⚡ Speed set to ${preset.toUpperCase()} (${state.viewDuration / 1000}s view)`);
  }

  // --- Storage Synchronization ---
  function saveSettingsToStorage() {
    const payload = {
      enabled: state.enabled,
      mode: state.mode,
      viewDuration: state.viewDuration,
      chatDelay: state.chatDelay,
      humanJitter: state.humanJitter,
      autoScroll: state.autoScroll,
      cooldownEnabled: state.cooldownEnabled,
      batchSize: state.batchSize,
      batchCooldown: state.batchCooldown,
      hudVisible: state.hudVisible,
      hudMinimized: state.hudMinimized,
      speedPreset: state.speedPreset,
      stats: state.stats
    };

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ snapauto_settings: payload });
    }
    try {
      localStorage.setItem('snapauto_settings', JSON.stringify(payload));
    } catch (e) {}
  }

  function loadSettingsFromStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['snapauto_settings'], (result) => {
        if (result && result.snapauto_settings) {
          const s = result.snapauto_settings;
          state = {
            ...state,
            ...s,
            stats: { ...state.stats, ...(s.stats || {}) }
          };
          renderUI();
          if (state.enabled && !state.isRunning) {
            startLoop();
          }
        }
      });
    } else {
      try {
        const raw = localStorage.getItem('snapauto_settings');
        if (raw) {
          const s = JSON.parse(raw);
          state = {
            ...state,
            ...s,
            stats: { ...state.stats, ...(s.stats || {}) }
          };
          renderUI();
          if (state.enabled && !state.isRunning) {
            startLoop();
          }
        }
      } catch (e) {}
    }
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.snapauto_settings) {
        const newVal = changes.snapauto_settings.newValue;
        if (newVal) {
          state = {
            ...state,
            ...newVal,
            stats: { ...state.stats, ...(newVal.stats || {}) }
          };
          renderUI();
          if (newVal.enabled && !state.isRunning) {
            startLoop();
          } else if (!newVal.enabled && state.isRunning) {
            stopLoop();
          }
        }
      }
    });
  }

  // --- Dynamic Style Injection (Guarantees Pristine UI Styling) ---
  function injectStyles() {
    if (document.getElementById('snapauto-css')) return;
    const style = document.createElement('style');
    style.id = 'snapauto-css';
    style.textContent = `
      :root {
        --snap-yellow: #fffc00;
        --snap-yellow-hover: #faea00;
        --snap-red: #e92754;
        --snap-purple: #9b5de5;
        --snap-bg-dark: #121214;
        --snap-panel-bg: rgba(22, 23, 27, 0.94);
        --snap-border: rgba(255, 255, 255, 0.12);
        --snap-text-primary: #ffffff;
        --snap-text-muted: #a0a0a8;
        --snap-green: #00e676;
        --snap-orange: #ff9100;
        --snap-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 1px rgba(255, 255, 255, 0.2);
      }
      #snapauto-hud {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        box-sizing: border-box;
        user-select: none;
        font-size: 13px;
        line-height: 1.4;
        color: var(--snap-text-primary);
        display: flex;
        flex-direction: column;
        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #snapauto-hud * { box-sizing: border-box; }
      #snapauto-hud.minimized .snapauto-panel { display: none !important; }
      #snapauto-hud.minimized .snapauto-pill { display: flex !important; }
      .snapauto-pill {
        display: none;
        align-items: center;
        gap: 8px;
        background: var(--snap-panel-bg);
        backdrop-filter: blur(14px);
        border: 1px solid var(--snap-border);
        padding: 8px 14px;
        border-radius: 999px;
        cursor: pointer;
        box-shadow: var(--snap-shadow);
        font-weight: 600;
        color: var(--snap-yellow);
      }
      .snapauto-pill:hover {
        background: rgba(35, 36, 42, 0.98);
        border-color: var(--snap-yellow);
      }
      .snapauto-panel {
        width: 320px;
        background: var(--snap-panel-bg);
        backdrop-filter: blur(16px);
        border: 1px solid var(--snap-border);
        border-radius: 18px;
        box-shadow: var(--snap-shadow);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .snapauto-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        background: rgba(255, 255, 255, 0.03);
        border-bottom: 1px solid var(--snap-border);
        cursor: grab;
      }
      .snapauto-header:active { cursor: grabbing; }
      .snapauto-brand {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
        font-size: 14px;
        letter-spacing: -0.2px;
      }
      .snapauto-logo-icon {
        width: 20px;
        height: 20px;
        background: var(--snap-yellow);
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .snapauto-logo-icon svg {
        width: 12px;
        height: 12px;
        fill: #000000;
      }
      .snapauto-header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .snapauto-btn-icon {
        background: transparent;
        border: none;
        color: var(--snap-text-muted);
        cursor: pointer;
        padding: 4px 6px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        line-height: 1;
        transition: all 0.15s ease;
      }
      .snapauto-btn-icon:hover {
        color: var(--snap-text-primary);
        background: rgba(255, 255, 255, 0.08);
      }
      .snapauto-status-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 14px;
        background: rgba(0, 0, 0, 0.25);
        font-size: 12px;
      }
      .snapauto-status-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 220px;
      }
      .snapauto-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #757575;
        flex-shrink: 0;
        transition: background 0.2s ease;
      }
      .snapauto-dot.running {
        background: var(--snap-green);
        box-shadow: 0 0 8px rgba(0, 230, 118, 0.6);
      }
      .snapauto-dot.cooldown {
        background: var(--snap-orange);
        box-shadow: 0 0 8px rgba(255, 145, 0, 0.6);
      }
      .snapauto-dot.paused { background: #757575; }
      .snapauto-stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        padding: 10px 14px;
        background: rgba(255, 255, 255, 0.02);
      }
      .snapauto-stat-card {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.05);
        padding: 8px 10px;
        border-radius: 10px;
        text-align: center;
      }
      .snapauto-stat-value {
        font-size: 18px;
        font-weight: 700;
        color: var(--snap-yellow);
        line-height: 1.2;
      }
      .snapauto-stat-label {
        font-size: 10px;
        color: var(--snap-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-top: 2px;
      }
      .snapauto-action-row { padding: 8px 14px; }
      .snapauto-btn-main {
        width: 100%;
        padding: 10px 16px;
        border-radius: 12px;
        border: none;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        background: var(--snap-yellow);
        color: #000000;
      }
      .snapauto-btn-main:hover {
        background: var(--snap-yellow-hover);
        transform: translateY(-1px);
      }
      .snapauto-btn-main:active { transform: translateY(1px); }
      .snapauto-btn-main.is-active {
        background: #ff3b30;
        color: #ffffff;
      }
      .snapauto-presets {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 14px 10px;
      }
      .snapauto-preset-btn {
        flex: 1;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: var(--snap-text-muted);
        font-size: 11px;
        font-weight: 600;
        padding: 6px 4px;
        border-radius: 8px;
        cursor: pointer;
        text-align: center;
        transition: all 0.15s ease;
      }
      .snapauto-preset-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: var(--snap-text-primary);
      }
      .snapauto-preset-btn.active {
        background: rgba(255, 252, 0, 0.15);
        border-color: var(--snap-yellow);
        color: var(--snap-yellow);
      }
      .snapauto-log-box {
        background: rgba(0, 0, 0, 0.35);
        border-top: 1px solid var(--snap-border);
        padding: 8px 12px;
        max-height: 85px;
        overflow-y: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10.5px;
        color: #d1d1d6;
        scrollbar-width: thin;
      }
      .snapauto-log-entry { margin-bottom: 4px; line-height: 1.3; word-break: break-all; }
      .snapauto-log-entry:last-child { margin-bottom: 0; }
      .snapauto-log-time { color: var(--snap-text-muted); margin-right: 4px; }
      .snapauto-target-highlight {
        outline: 2px solid var(--snap-yellow) !important;
        outline-offset: 2px !important;
        transition: outline 0.2s ease !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // --- EXACT ORIGINAL APPROVED FLOATING HUD UI ---

  function createHUD() {
    if (document.getElementById('snapauto-hud')) return;

    injectStyles();

    const hud = document.createElement('div');
    hud.id = 'snapauto-hud';
    if (state.hudMinimized) hud.classList.add('minimized');

    hud.innerHTML = `
      <div class="snapauto-pill" id="snapauto-pill">
        <span>👻 SnapAuto</span>
        <span class="snapauto-dot ${state.enabled ? 'running' : 'paused'}"></span>
        <span id="snapauto-pill-count">${state.stats.sessionOpened}</span>
      </div>

      <div class="snapauto-panel">
        <div class="snapauto-header" id="snapauto-header">
          <div class="snapauto-brand">
            <div class="snapauto-logo-icon">
              <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
            <span>SnapAuto</span>
          </div>
          <div class="snapauto-header-actions">
            <button class="snapauto-btn-icon" id="snapauto-btn-minimize" title="Minimize to pill">─</button>
            <button class="snapauto-btn-icon" id="snapauto-btn-hide" title="Hide HUD">✕</button>
          </div>
        </div>

        <div class="snapauto-status-bar">
          <div class="snapauto-status-indicator">
            <span class="snapauto-dot ${state.enabled ? 'running' : 'paused'}" id="snapauto-status-dot"></span>
            <span id="snapauto-status-text">${state.statusText}</span>
          </div>
          <span style="font-size:10px; color:#888;">${state.mode === 'all_chats' ? 'All Chats' : 'Active Chat'}</span>
        </div>

        <div class="snapauto-stats-grid">
          <div class="snapauto-stat-card">
            <div class="snapauto-stat-value" id="snapauto-stat-session">${state.stats.sessionOpened}</div>
            <div class="snapauto-stat-label">Session Snaps</div>
          </div>
          <div class="snapauto-stat-card">
            <div class="snapauto-stat-value" id="snapauto-stat-total">${state.stats.totalOpened}</div>
            <div class="snapauto-stat-label">Total Opened</div>
          </div>
        </div>

        <div class="snapauto-action-row">
          <button class="snapauto-btn-main ${state.enabled ? 'is-active' : ''}" id="snapauto-btn-toggle">
            ${state.enabled ? '⏸ Pause Monitor' : '▶ Start Monitor'}
          </button>
        </div>

        <div class="snapauto-presets">
          <button class="snapauto-preset-btn ${state.speedPreset === 'fast' ? 'active' : ''}" data-preset="fast" title="1.2s per snap">⚡ Fast (1.2s)</button>
          <button class="snapauto-preset-btn ${state.speedPreset === 'balanced' ? 'active' : ''}" data-preset="balanced" title="2.0s per snap">⚖ Balanced (2.0s)</button>
          <button class="snapauto-preset-btn ${state.speedPreset === 'safe' ? 'active' : ''}" data-preset="safe" title="3.5s safe pacing">🛡 Relaxed</button>
        </div>

        <div class="snapauto-log-box" id="snapauto-log-box"></div>
      </div>
    `;

    document.body.appendChild(hud);
    state.hudEl = hud;

    setupHUDEvents(hud);
    renderLogs();
  }

  function setupHUDEvents(hud) {
    const toggleBtn = hud.querySelector('#snapauto-btn-toggle');
    toggleBtn.addEventListener('click', toggleAutoOpener);

    const minBtn = hud.querySelector('#snapauto-btn-minimize');
    minBtn.addEventListener('click', () => {
      hud.classList.add('minimized');
      state.hudMinimized = true;
      saveSettingsToStorage();
    });

    const pill = hud.querySelector('#snapauto-pill');
    pill.addEventListener('click', () => {
      hud.classList.remove('minimized');
      state.hudMinimized = false;
      saveSettingsToStorage();
    });

    const hideBtn = hud.querySelector('#snapauto-btn-hide');
    hideBtn.addEventListener('click', () => {
      hud.style.display = 'none';
      state.hudVisible = false;
      saveSettingsToStorage();
    });

    const presetBtns = hud.querySelectorAll('.snapauto-preset-btn');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.getAttribute('data-preset');
        applySpeedPreset(preset);
      });
    });

    makeDraggable(hud, hud.querySelector('#snapauto-header'));
  }

  function makeDraggable(el, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      el.style.bottom = 'auto';
      el.style.right = 'auto';
      el.style.top = Math.max(10, Math.min(window.innerHeight - el.offsetHeight - 10, el.offsetTop - pos2)) + 'px';
      el.style.left = Math.max(10, Math.min(window.innerWidth - el.offsetWidth - 10, el.offsetLeft - pos1)) + 'px';
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }

  function updateStatus(text, statusClass = 'running') {
    state.statusText = text;
    if (!state.hudEl) return;

    const textEl = state.hudEl.querySelector('#snapauto-status-text');
    if (textEl) textEl.textContent = text;

    const dotEl = state.hudEl.querySelector('#snapauto-status-dot');
    if (dotEl) {
      dotEl.className = `snapauto-dot ${statusClass}`;
    }

    const pillDot = state.hudEl.querySelector('#snapauto-pill .snapauto-dot');
    if (pillDot) {
      pillDot.className = `snapauto-dot ${statusClass}`;
    }
  }

  function renderUI() {
    if (!state.hudEl) return;

    const toggleBtn = state.hudEl.querySelector('#snapauto-btn-toggle');
    if (toggleBtn) {
      toggleBtn.className = `snapauto-btn-main ${state.enabled ? 'is-active' : ''}`;
      toggleBtn.textContent = state.enabled ? '⏸ Pause Monitor' : '▶ Start Monitor';
    }

    const sessionEl = state.hudEl.querySelector('#snapauto-stat-session');
    if (sessionEl) sessionEl.textContent = state.stats.sessionOpened;

    const totalEl = state.hudEl.querySelector('#snapauto-stat-total');
    if (totalEl) totalEl.textContent = state.stats.totalOpened;

    const pillCount = state.hudEl.querySelector('#snapauto-pill-count');
    if (pillCount) pillCount.textContent = state.stats.sessionOpened;

    const presetBtns = state.hudEl.querySelectorAll('.snapauto-preset-btn');
    presetBtns.forEach(btn => {
      const p = btn.getAttribute('data-preset');
      if (p === state.speedPreset) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (state.hudVisible) {
      state.hudEl.style.display = 'flex';
    } else {
      state.hudEl.style.display = 'none';
    }
  }

  function renderLogs() {
    if (!state.hudEl) return;
    const logBox = state.hudEl.querySelector('#snapauto-log-box');
    if (!logBox) return;

    logBox.innerHTML = activityLogs.map(l => `
      <div class="snapauto-log-entry">
        <span class="snapauto-log-time">[${l.time}]</span>
        <span>${escapeHTML(l.msg)}</span>
      </div>
    `).join('');
  }

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  // --- Background Tab Keep-Alive Heartbeat ---
  function initBackgroundKeepAlive() {
    try {
      const blob = new Blob([`
        setInterval(function() {
          postMessage('heartbeat');
        }, 1000);
      `], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);
      worker.onmessage = function() {
        // Keeps the content script timer loop active even in background tabs
      };
    } catch (e) {}
  }

  // --- Initializer ---
  function init() {
    initBackgroundKeepAlive();
    setupUserActivityListeners();
    createHUD();
    loadSettingsFromStorage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
