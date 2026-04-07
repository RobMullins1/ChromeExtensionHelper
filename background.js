'use strict';

// Same detection as popup Doc Reader: find Klaviyo-related scripts (inline or external)
function getKlaviyoScripts() {
  const keywords = ['klaviyo', '_klonsite', '_learnq', 'klaviyo.js'];
  const scripts = document.querySelectorAll('script');
  const out = [];
  const snippetLen = 400;
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    const src = (s.src || '').toLowerCase();
    const text = (s.textContent || '').toLowerCase();
    const isExternal = !!s.src;
    const matchExternal = isExternal && keywords.some((k) => src.includes(k));
    const matchInline = !isExternal && keywords.some((k) => text.includes(k));
    if (matchExternal || matchInline) {
      const snippet = isExternal ? s.src : (s.textContent || '').trim().slice(0, snippetLen);
      out.push({
        type: isExternal ? 'external' : 'inline',
        src: isExternal ? s.src : undefined,
        snippet: snippet + (snippet.length >= snippetLen ? '…' : ''),
      });
    }
  }
  return out;
}

async function updateBadgeForTab(tabId) {
  if (tabId == null) return;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: getKlaviyoScripts,
    });
    const list = results?.[0]?.result ?? [];
    const hasInline = Array.isArray(list) && list.some((item) => item.type === 'inline');
    await chrome.action.setBadgeText({ tabId, text: hasInline ? '!' : '' });
    if (hasInline) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff3b30' });
    }
  } catch (_) {
    await chrome.action.setBadgeText({ tabId, text: '' });
  }
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') {
    updateBadgeForTab(tabId);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  updateBadgeForTab(activeInfo.tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'reloadTabAndReopen') {
    const tabId = message.tabId;
    if (tabId == null) {
      sendResponse({ ok: false });
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.action.openPopup().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: true }));
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.update(tabId, { active: true }).catch(() => {});
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId).then(() => {}).catch(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      finish();
    });
    return true;
  }
});
