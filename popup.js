(function () {
  'use strict';

  // --- Tab switching ---
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabId = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById('panel-' + tabId);
      if (panel) panel.classList.add('active');
      if (tabId === 'js-blocker') runJsBlockerScan();
    });
  });

  // --- Get current tab ---
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // --- JS Blocker: inject and get script list ---
  function getPageScripts() {
    const fromDoc = Array.from(document.scripts)
      .filter((s) => s.src)
      .map((s) => ({ url: s.src, id: s.id || null }));
    const urlSet = new Set(fromDoc.map((x) => x.url));
    try {
      const resources = performance.getEntriesByType('resource');
      for (const e of resources) {
        if (e.name && (e.initiatorType === 'script' || e.name.endsWith('.js'))) {
          if (!urlSet.has(e.name)) {
            urlSet.add(e.name);
            fromDoc.push({ url: e.name, id: null });
          }
        }
      }
    } catch (_) {}
    return fromDoc;
  }

  const jsBlockerList = document.getElementById('js-blocker-list');
  const jsBlockerEmpty = document.getElementById('js-blocker-empty');
  const jsBlockerError = document.getElementById('js-blocker-error');
  const reloadBanner = document.getElementById('js-blocker-reload-banner');
  const btnReloadPage = document.getElementById('btn-reload-page');
  const btnClearAll = document.getElementById('btn-clear-all-blocks');

  let currentJsBlockerScripts = [];
  let currentPageDomain = '';
  const expandedGroupNames = new Set();

  // --- Script blocking helpers (declarativeNetRequest + storage) ---

  async function getBlockedScripts() {
    const data = await chrome.storage.local.get(['blockedScripts']);
    return data.blockedScripts || {};
  }

  async function getNextRuleId() {
    const data = await chrome.storage.local.get(['nextRuleId']);
    return data.nextRuleId || 1;
  }

  async function saveBlockedScripts(blockedScripts, nextRuleId) {
    await chrome.storage.local.set({ blockedScripts, nextRuleId });
  }

  async function blockScript(scriptUrl, pageDomain) {
    const key = pageDomain + '||' + scriptUrl;
    const blocked = await getBlockedScripts();
    if (blocked[key]) return;

    const ruleId = await getNextRuleId();

    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: { type: 'block' },
        condition: {
          urlFilter: scriptUrl,
          resourceTypes: ['script'],
          initiatorDomains: [pageDomain]
        }
      }],
      removeRuleIds: []
    });

    blocked[key] = {
      ruleId,
      scriptUrl,
      pageDomain,
      blockedAt: Date.now()
    };

    await saveBlockedScripts(blocked, ruleId + 1);
  }

  async function unblockScript(scriptUrl, pageDomain) {
    const key = pageDomain + '||' + scriptUrl;
    const blocked = await getBlockedScripts();
    const entry = blocked[key];
    if (!entry) return;

    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [],
      removeRuleIds: [entry.ruleId]
    });

    delete blocked[key];
    const nextId = await getNextRuleId();
    await saveBlockedScripts(blocked, nextId);
  }

  async function clearAllBlocks() {
    const blocked = await getBlockedScripts();
    const ruleIds = Object.values(blocked).map(e => e.ruleId);

    if (ruleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [],
        removeRuleIds: ruleIds
      });
    }

    await chrome.storage.local.set({ blockedScripts: {}, nextRuleId: 1 });
  }

  async function getBlockedForDomain(pageDomain) {
    const blocked = await getBlockedScripts();
    const result = {};
    for (const [, entry] of Object.entries(blocked)) {
      if (entry.pageDomain === pageDomain) {
        result[entry.scriptUrl] = entry;
      }
    }
    return result;
  }

  function showReloadBanner() {
    reloadBanner.classList.remove('hidden');
  }

  function hideReloadBanner() {
    reloadBanner.classList.add('hidden');
  }

  async function updateClearAllVisibility() {
    const blocked = await getBlockedScripts();
    const hasAny = Object.keys(blocked).length > 0;
    btnClearAll.classList.toggle('hidden', !hasAny);
  }

  btnReloadPage.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    hideReloadBanner();
    chrome.runtime.sendMessage({ type: 'reloadTabAndReopen', tabId: tab.id });
  });

  btnClearAll.addEventListener('click', async () => {
    await clearAllBlocks();
    showReloadBanner();
    await renderJsBlockerList(currentJsBlockerScripts, currentPageDomain);
    await updateClearAllVisibility();
  });

  function getScriptGroupKey(url) {
    try {
      const u = new URL(url);
      return u.hostname || 'Other';
    } catch (_) {
      return 'Other';
    }
  }

  function groupScriptsByDomain(scripts) {
    const groups = {};
    for (const s of scripts) {
      const key = getScriptGroupKey(s.url);
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }
    const entries = Object.entries(groups);
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    return entries;
  }

  function showJsBlockerError(msg) {
    jsBlockerError.textContent = msg;
    jsBlockerError.classList.remove('hidden');
    jsBlockerList.classList.add('hidden');
    jsBlockerEmpty.classList.add('hidden');
  }

  function hideJsBlockerError() {
    jsBlockerError.classList.add('hidden');
    jsBlockerError.textContent = '';
  }

  async function renderJsBlockerList(scripts, pageDomain) {
    currentJsBlockerScripts = scripts || [];
    currentPageDomain = pageDomain || '';
    hideJsBlockerError();
    jsBlockerEmpty.classList.add('hidden');
    jsBlockerList.classList.remove('hidden');
    jsBlockerList.innerHTML = '';

    const blockedForDomain = await getBlockedForDomain(pageDomain);

    // Merge blocked-but-not-scanned scripts into the list
    const scannedUrls = new Set((scripts || []).map(s => s.url));
    const merged = [...(scripts || [])];
    for (const [url] of Object.entries(blockedForDomain)) {
      if (!scannedUrls.has(url)) {
        merged.push({ url, id: null });
      }
    }

    if (merged.length === 0) {
      jsBlockerList.classList.add('hidden');
      jsBlockerEmpty.classList.remove('hidden');
      jsBlockerEmpty.textContent = 'No script URLs found on this page.';
      return;
    }

    const grouped = groupScriptsByDomain(merged);
    for (const [groupName, groupScripts] of grouped) {
      const isExpanded = expandedGroupNames.has(groupName);
      const allBlocked = groupScripts.every(({ url }) => !!blockedForDomain[url]);
      const someBlocked = groupScripts.some(({ url }) => !!blockedForDomain[url]);

      const groupEl = document.createElement('div');
      groupEl.className = 'script-group' + (isExpanded ? '' : ' script-group--collapsed');
      groupEl.setAttribute('data-group-name', groupName);

      const header = document.createElement('div');
      header.className = 'script-group-header';
      header.innerHTML =
        '<button type="button" class="script-group-toggle" aria-expanded="' +
        String(isExpanded) +
        '" title="Expand to see individual scripts">' +
        '<span class="script-group-chevron" aria-hidden="true">' +
        (isExpanded ? '▼' : '▶') +
        '</span>' +
        '<span class="script-group-label">' +
        escapeHtml(groupName) +
        ' (' +
        groupScripts.length +
        ')</span>' +
        '</button>' +
        '<label class="script-toggle script-group-toggle-all" title="Block/allow all in group">' +
        '<input type="checkbox" ' + (allBlocked ? '' : 'checked') +
        ' data-group-name="' + escapeHtml(groupName) + '">' +
        '<span class="toggle-slider"></span>' +
        '</label>';
      groupEl.appendChild(header);

      // Set indeterminate state (must be done imperatively, not via HTML)
      if (someBlocked && !allBlocked) {
        const groupCb = header.querySelector('.script-group-toggle-all input');
        if (groupCb) groupCb.indeterminate = true;
      }

      const body = document.createElement('div');
      body.className = 'script-group-body';
      const listEl = document.createElement('div');
      listEl.className = 'script-group-list';
      for (const { url } of groupScripts) {
        const isBlocked = !!blockedForDomain[url];
        const item = document.createElement('div');
        item.className = 'script-item' + (isBlocked ? ' script-item--blocked' : '');
        item.innerHTML =
          '<div class="script-url" title="' +
          escapeHtml(url) +
          '">' +
          escapeHtml(truncateUrl(url)) +
          '</div>' +
          '<label class="script-toggle" title="' + (isBlocked ? 'Blocked' : 'Allowed') + '">' +
          '<input type="checkbox" ' + (isBlocked ? '' : 'checked') +
          ' data-script-url="' + escapeHtml(url) + '">' +
          '<span class="toggle-slider"></span>' +
          '</label>';
        listEl.appendChild(item);
      }
      body.appendChild(listEl);
      groupEl.appendChild(body);
      jsBlockerList.appendChild(groupEl);
    }

    // Toggle expand/collapse handlers
    jsBlockerList.querySelectorAll('.script-group-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.script-group');
        if (!group) return;
        const name = group.getAttribute('data-group-name');
        if (name) {
          if (group.classList.contains('script-group--collapsed')) expandedGroupNames.add(name);
          else expandedGroupNames.delete(name);
        }
        const expanded = group.classList.toggle('script-group--collapsed');
        btn.setAttribute('aria-expanded', String(!expanded));
        const chevron = btn.querySelector('.script-group-chevron');
        if (chevron) chevron.textContent = expanded ? '▶' : '▼';
      });
    });

    // Individual toggle block/unblock handlers
    jsBlockerList.querySelectorAll('.script-item .script-toggle input').forEach((checkbox) => {
      checkbox.addEventListener('change', async (e) => {
        const scriptUrl = e.target.getAttribute('data-script-url');
        const item = e.target.closest('.script-item');
        const toggle = e.target.closest('.script-toggle');

        e.target.disabled = true;
        try {
          if (e.target.checked) {
            await unblockScript(scriptUrl, pageDomain);
            item.classList.remove('script-item--blocked');
            toggle.title = 'Allowed';
          } else {
            await blockScript(scriptUrl, pageDomain);
            item.classList.add('script-item--blocked');
            toggle.title = 'Blocked';
          }
          showReloadBanner();
          await updateClearAllVisibility();

          // Sync the group toggle state
          const groupEl = item.closest('.script-group');
          const groupCb = groupEl?.querySelector('.script-group-toggle-all input');
          if (groupCb) {
            const allInputs = [...groupEl.querySelectorAll('.script-item .script-toggle input')];
            const blockedCount = allInputs.filter(i => !i.checked).length;
            groupCb.checked = blockedCount === 0;
            groupCb.indeterminate = blockedCount > 0 && blockedCount < allInputs.length;
          }
        } finally {
          e.target.disabled = false;
        }
      });
    });

    // Group toggle handlers (block/unblock all in group)
    jsBlockerList.querySelectorAll('.script-group-toggle-all input').forEach((cb) => {
      cb.addEventListener('change', async (e) => {
        const group = e.target.closest('.script-group');
        const individualInputs = [...group.querySelectorAll('.script-item .script-toggle input')];
        const urls = individualInputs.map(i => i.getAttribute('data-script-url'));

        e.target.disabled = true;
        e.target.indeterminate = false;
        try {
          if (e.target.checked) {
            for (const url of urls) await unblockScript(url, pageDomain);
          } else {
            for (const url of urls) await blockScript(url, pageDomain);
          }
          // Sync individual toggles visually
          individualInputs.forEach(i => {
            i.checked = e.target.checked;
            i.closest('.script-item').classList.toggle('script-item--blocked', !e.target.checked);
            i.closest('.script-toggle').title = e.target.checked ? 'Allowed' : 'Blocked';
          });
          showReloadBanner();
          await updateClearAllVisibility();
        } finally {
          e.target.disabled = false;
        }
      });
    });
  }

  function truncateUrl(url, maxLen = 80) {
    if (url.length <= maxLen) return url;
    return url.slice(0, maxLen - 3) + '...';
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  async function runJsBlockerScan() {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    hideJsBlockerError();
    jsBlockerEmpty.classList.remove('hidden');
    jsBlockerEmpty.textContent = 'Scanning…';
    jsBlockerList.classList.add('hidden');

    let pageDomain = '';
    try {
      pageDomain = new URL(tab.url).hostname;
    } catch (_) {}

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: getPageScripts,
      });
      const scripts = results?.[0]?.result ?? null;
      if (chrome.runtime.lastError) {
        showJsBlockerError("Can't run on this page. Try a normal website.");
        jsBlockerList.classList.add('hidden');
        jsBlockerEmpty.classList.remove('hidden');
        jsBlockerEmpty.textContent = '';
        return;
      }
      await renderJsBlockerList(scripts, pageDomain);
      await updateClearAllVisibility();
    } catch (_) {
      jsBlockerEmpty.textContent = 'Run on a normal webpage to list scripts.';
    }
  }

  if (document.getElementById('panel-js-blocker').classList.contains('active')) {
    runJsBlockerScan();
  }

  // --- Klaviyo Document Reader ---
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

  const docReaderList = document.getElementById('doc-reader-list');
  const docReaderEmpty = document.getElementById('doc-reader-empty');
  const docReaderError = document.getElementById('doc-reader-error');
  const btnScanKlaviyo = document.getElementById('btn-scan-klaviyo');

  btnScanKlaviyo.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    btnScanKlaviyo.disabled = true;
    docReaderError.classList.add('hidden');
    docReaderError.textContent = '';
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: getKlaviyoScripts,
      });
      const list = results?.[0]?.result ?? null;
      if (chrome.runtime.lastError) {
        docReaderList.classList.add('hidden');
        docReaderEmpty.classList.remove('hidden');
        docReaderEmpty.textContent = "Can't run on this page. Try a normal website.";
        return;
      }
      docReaderEmpty.classList.add('hidden');
      docReaderList.classList.remove('hidden');
      docReaderList.innerHTML = '';
      if (!list || list.length === 0) {
        docReaderList.classList.add('hidden');
        docReaderEmpty.classList.remove('hidden');
        docReaderEmpty.textContent = 'No Klaviyo-related scripts found.';
        return;
      }
      const inlineItems = list.filter((a) => a.type === 'inline');
      const externalItems = list.filter((a) => a.type === 'external');

      function appendScriptItem(item) {
        const div = document.createElement('div');
        div.className = 'script-item' + (item.type === 'inline' ? ' script-item--inline' : '');
        const meta = item.type === 'external' ? 'External: ' + (item.src || '') : 'Inline';
        const snippetEscaped = escapeHtml(item.snippet);
        const copyBtn = item.type === 'inline'
          ? '<button type="button" class="btn btn-copy-icon" title="Copy snippet" aria-label="Copy snippet">\u2398</button>'
          : '';
        div.innerHTML =
          '<div class="script-meta">' +
          escapeHtml(meta) +
          '</div>' +
          (item.src ? '<div class="script-url" title="' + escapeHtml(item.src) + '">' + escapeHtml(truncateUrl(item.src)) + '</div>' : '') +
          '<div class="script-snippet-row">' +
          '<div class="script-snippet">' + snippetEscaped + '</div>' +
          copyBtn +
          '</div>';
        docReaderList.appendChild(div);
        if (item.type === 'inline' && copyBtn) {
          const btn = div.querySelector('.btn-copy-icon');
          if (btn) {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              try {
                await navigator.clipboard.writeText(item.snippet);
                btn.textContent = '\u2713';
                btn.setAttribute('title', 'Copied');
                setTimeout(() => {
                  btn.textContent = '\u2398';
                  btn.setAttribute('title', 'Copy snippet');
                }, 1500);
              } catch (_) {
                btn.setAttribute('title', 'Copy failed');
                setTimeout(() => btn.setAttribute('title', 'Copy snippet'), 1500);
              }
            });
          }
        }
      }

      // Inline scripts first, ungrouped
      for (const item of inlineItems) {
        appendScriptItem(item);
      }

      // External scripts grouped under one section header
      if (externalItems.length > 0) {
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'doc-reader-section-header';
        sectionHeader.textContent = 'External Klaviyo Scripts';
        docReaderList.appendChild(sectionHeader);
        for (const item of externalItems) {
          appendScriptItem(item);
        }
      }
    } finally {
      btnScanKlaviyo.disabled = false;
    }
  });

  // --- Quick Actions: static snippets + copy ---
  const QUICK_ACTIONS = [
    {
      name: 'identify',
      description: 'Identify a user by email or phone and set profile properties.',
      code: "klaviyo.identify({ email: 'test@example.com', first_name: 'Test', last_name: 'User' });",
    },
    {
      name: 'track',
      description: 'Track a custom event for the identified user.',
      code: "klaviyo.track('Viewed Product', { ProductName: 'Example', ProductID: '123' });",
    },
    {
      name: 'trackViewedItem',
      description: 'Track a viewed item (e.g. product) with standard item properties.',
      code:
        'klaviyo.trackViewedItem({ ProductName: "Example", ProductID: "123", SKU: "SKU1", Price: 9.99, URL: window.location.href });',
    },
    {
      name: 'openForm',
      description: 'Open a Klaviyo form by form ID.',
      code: "klaviyo.openForm('YOUR_FORM_ID');",
    },
    {
      name: 'push (array)',
      description: 'Legacy array form; works before Klaviyo.js is fully loaded.',
      code: "klaviyo.push(['identify', {}]);",
    },
    {
      name: 'account',
      description: 'Set or get account ID. Pass account_id to set.',
      code: 'klaviyo.account();',
    },
    {
      name: 'isIdentified',
      description: 'Check if the current visitor is identified.',
      code: 'klaviyo.isIdentified();',
    },
    {
      name: 'getGroupMembership',
      description: 'Get group membership (e.g. list membership) for the identified profile.',
      code: 'klaviyo.getGroupMembership();',
    },
    {
      name: 'cookieDomain',
      description: 'Set or get cookie domain. Pass string to set.',
      code: 'klaviyo.cookieDomain();',
    },
    {
      name: 'cacheEvent',
      description: 'Cache an event to send when the user is identified.',
      code: "klaviyo.cacheEvent('Viewed Product', { ProductName: 'Example' });",
    },
    {
      name: 'sendCachedEvents',
      description: 'Send any cached events (e.g. after identify).',
      code: 'klaviyo.sendCachedEvents();',
    },
  ];

  const quickActionsList = document.getElementById('quick-actions-list');
  for (const a of QUICK_ACTIONS) {
    const card = document.createElement('div');
    card.className = 'quick-action-card';
    card.innerHTML =
      '<h3>' +
      escapeHtml(a.name) +
      '</h3>' +
      '<p class="description">' +
      escapeHtml(a.description) +
      '</p>' +
      '<div class="snippet-wrap">' +
      '<pre>' +
      escapeHtml(a.code) +
      '</pre>' +
      '<button type="button" class="btn btn-copy-icon" data-code="' +
      escapeHtml(a.code) +
      '" title="Copy snippet" aria-label="Copy snippet">\u2398</button>' +
      '</div>';
    quickActionsList.appendChild(card);
  }

  quickActionsList.querySelectorAll('.btn-copy-icon').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = btn.getAttribute('data-code');
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = '\u2713';
        btn.setAttribute('title', 'Copied');
        setTimeout(() => {
          btn.textContent = '\u2398';
          btn.setAttribute('title', 'Copy snippet');
        }, 1500);
      } catch (_) {
        btn.setAttribute('title', 'Copy failed');
        setTimeout(() => btn.setAttribute('title', 'Copy snippet'), 1500);
      }
    });
  });

  // --- Doc Finder (from Dev Doc Tool) ---
  if (typeof DOC_FINDER_PLATFORMS !== 'undefined') {
    const docFinderGrid = document.getElementById('doc-finder-grid');
    const docFinderHome = document.getElementById('doc-finder-home');
    const docFinderDetail = document.getElementById('doc-finder-detail');
    const docFinderTitle = document.getElementById('doc-finder-title');
    const docFinderLinks = document.getElementById('doc-finder-links');
    const docFinderBack = document.getElementById('doc-finder-back');

    DOC_FINDER_PLATFORMS.forEach((platform) => {
      const wrap = document.createElement('div');
      wrap.className = 'docfinder-card';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button-28';
      btn.textContent = platform.label;
      btn.addEventListener('click', () => {
        docFinderTitle.textContent = platform.label;
        docFinderLinks.innerHTML = '';
        platform.links.forEach((item) => {
          const linkWrap = document.createElement('div');
          linkWrap.className = 'docfinder-link-wrap';
          const linkBtn = document.createElement('button');
          linkBtn.type = 'button';
          linkBtn.className = 'button-28';
          linkBtn.textContent = item.text;
          linkBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: item.url });
          });
          linkWrap.appendChild(linkBtn);
          docFinderLinks.appendChild(linkWrap);
        });
        docFinderHome.classList.add('hidden');
        docFinderDetail.classList.remove('hidden');
      });
      wrap.appendChild(btn);
      docFinderGrid.appendChild(wrap);
    });

    docFinderBack.addEventListener('click', () => {
      docFinderDetail.classList.add('hidden');
      docFinderHome.classList.remove('hidden');
    });
  }
})();
