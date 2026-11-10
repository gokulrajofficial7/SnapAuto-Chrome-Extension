/**
 * SnapAuto - Extension Popup Logic
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const masterToggle = document.getElementById('masterToggle');
  const statusDesc = document.getElementById('statusDescription');
  const modeAllChats = document.getElementById('modeAllChats');
  const modeActiveChat = document.getElementById('modeActiveChat');
  const viewDurationSlider = document.getElementById('viewDurationSlider');
  const viewDurationVal = document.getElementById('viewDurationVal');
  const chatDelaySlider = document.getElementById('chatDelaySlider');
  const chatDelayVal = document.getElementById('chatDelayVal');
  const jitterToggle = document.getElementById('jitterToggle');
  const cooldownToggle = document.getElementById('cooldownToggle');
  const autoScrollToggle = document.getElementById('autoScrollToggle');
  const hudVisibleToggle = document.getElementById('hudVisibleToggle');
  const statSession = document.getElementById('statSession');
  const statTotal = document.getElementById('statTotal');
  const btnResetStats = document.getElementById('btnResetStats');

  // Default state
  let currentSettings = {
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
      chatsScanned: 0
    }
  };

  // Load saved state
  function loadSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['snapauto_settings'], (result) => {
        if (result && result.snapauto_settings) {
          currentSettings = {
            ...currentSettings,
            ...result.snapauto_settings,
            stats: {
              ...currentSettings.stats,
              ...(result.snapauto_settings.stats || {})
            }
          };
        }
        updateUI();
      });
    } else {
      updateUI();
    }
  }

  function updateUI() {
    // Master switch
    masterToggle.checked = currentSettings.enabled;
    if (currentSettings.enabled) {
      statusDesc.textContent = 'Active & Running';
      statusDesc.className = 'master-desc active';
    } else {
      statusDesc.textContent = 'Currently Paused';
      statusDesc.className = 'master-desc';
    }

    // Modes
    if (currentSettings.mode === 'active_chat') {
      modeActiveChat.checked = true;
    } else {
      modeAllChats.checked = true;
    }

    // Sliders
    viewDurationSlider.value = currentSettings.viewDuration;
    viewDurationVal.textContent = (currentSettings.viewDuration / 1000).toFixed(1) + 's';

    chatDelaySlider.value = currentSettings.chatDelay;
    chatDelayVal.textContent = (currentSettings.chatDelay / 1000).toFixed(1) + 's';

    // Toggles
    jitterToggle.checked = currentSettings.humanJitter;
    cooldownToggle.checked = currentSettings.cooldownEnabled;
    autoScrollToggle.checked = currentSettings.autoScroll;
    hudVisibleToggle.checked = currentSettings.hudVisible;

    // Stats
    statSession.textContent = currentSettings.stats.sessionOpened || 0;
    statTotal.textContent = currentSettings.stats.totalOpened || 0;
  }

  function saveSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['snapauto_settings', 'snapauto_total_opened'], (result) => {
        const existing = (result && result.snapauto_settings) || {};
        const existingStats = existing.stats || {};
        const total = Math.max(
          Number(result && result.snapauto_total_opened) || 0,
          Number(existingStats.totalOpened) || 0,
          Number(currentSettings.stats && currentSettings.stats.totalOpened) || 0
        );
        const payload = {
          ...existing,
          ...currentSettings,
          stats: {
            ...existingStats,
            ...(currentSettings.stats || {}),
            totalOpened: total
          }
        };
        chrome.storage.local.set({ snapauto_settings: payload });
      });
    }
  }

  // Event Listeners
  masterToggle.addEventListener('change', () => {
    currentSettings.enabled = masterToggle.checked;
    saveSettings();
    updateUI();
  });

  modeAllChats.addEventListener('change', () => {
    if (modeAllChats.checked) {
      currentSettings.mode = 'all_chats';
      saveSettings();
    }
  });

  modeActiveChat.addEventListener('change', () => {
    if (modeActiveChat.checked) {
      currentSettings.mode = 'active_chat';
      saveSettings();
    }
  });

  viewDurationSlider.addEventListener('input', () => {
    const val = parseInt(viewDurationSlider.value, 10);
    viewDurationVal.textContent = (val / 1000).toFixed(1) + 's';
    currentSettings.viewDuration = val;
    saveSettings();
  });

  chatDelaySlider.addEventListener('input', () => {
    const val = parseInt(chatDelaySlider.value, 10);
    chatDelayVal.textContent = (val / 1000).toFixed(1) + 's';
    currentSettings.chatDelay = val;
    saveSettings();
  });

  jitterToggle.addEventListener('change', () => {
    currentSettings.humanJitter = jitterToggle.checked;
    saveSettings();
  });

  cooldownToggle.addEventListener('change', () => {
    currentSettings.cooldownEnabled = cooldownToggle.checked;
    saveSettings();
  });

  autoScrollToggle.addEventListener('change', () => {
    currentSettings.autoScroll = autoScrollToggle.checked;
    saveSettings();
  });

  hudVisibleToggle.addEventListener('change', () => {
    currentSettings.hudVisible = hudVisibleToggle.checked;
    saveSettings();
  });

  btnResetStats.addEventListener('click', () => {
    if (confirm('Reset session statistics?')) {
      currentSettings.stats.sessionOpened = 0;
      currentSettings.stats.totalOpened = 0;
      currentSettings.stats.chatsScanned = 0;
      saveSettings();
      updateUI();
    }
  });

  // Listen for storage changes from content script
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.snapauto_settings) {
        const newVal = changes.snapauto_settings.newValue;
        if (newVal) {
          currentSettings = {
            ...currentSettings,
            ...newVal,
            stats: { ...currentSettings.stats, ...(newVal.stats || {}) }
          };
          updateUI();
        }
      }
    });
  }

  loadSettings();
});
