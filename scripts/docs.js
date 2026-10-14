'use strict';

// One offline page serves the browser, Studio (embedded), and `vigo serve`.
(function () {
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const embedded = params.get('embedded') === '1';
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ } },
  };

  // Studio passes bundled asset URLs; external links leave the embedded reader.
  if (embedded) {
    for (const link of document.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (href.startsWith('#')) continue;
      if (/(^|\/)standalone-openapi\.json$/.test(href)) {
        link.href = new URL(params.get('schema') || href, location.href).href;
        link.download = 'standalone-openapi.json';
      } else {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    }
  }

  // Theme: Studio's appearance, then the reader's choice, then the system.
  const toggle = document.querySelector('#theme-toggle');
  function applyTheme(theme) {
    root.dataset.theme = theme;
    toggle?.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
  applyTheme(root.dataset.theme || 'light');
  toggle?.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.set('vigo-docs-theme', next);
  });
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  scheme?.addEventListener?.('change', event => {
    if (!embedded && !store.get('vigo-docs-theme')) applyTheme(event.matches ? 'dark' : 'light');
  });

  const pages = [...document.querySelectorAll('.doc-page')];
  const chapters = document.querySelector('#chapters');
  const navLinks = [...chapters.querySelectorAll('a[data-nav]')];
  const sidebar = document.querySelector('#sidebar');
  const scrim = document.querySelector('.scrim');
  const menu = document.querySelector('.menu-button');
  const narrow = window.matchMedia('(max-width: 960px)');
  const product = document.body.dataset.product || 'VIGO';
  let activePage = pages[0];

  function setSidebar(open) {
    if (!sidebar) return;
    sidebar.classList.toggle('open', open);
    if (scrim) scrim.hidden = !open;
    menu?.setAttribute('aria-expanded', String(open));
    if (open) sidebar.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'center' });
  }
  menu?.addEventListener('click', () => setSidebar(!sidebar.classList.contains('open')));
  scrim?.addEventListener('click', () => setSidebar(false));

  // Stacked tables on narrow screens label each cell with its column header.
  for (const table of document.querySelectorAll('.page-body table')) {
    const labels = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    for (const row of table.querySelectorAll('tbody tr')) [...row.cells].forEach((cell, n) => { if (labels[n]) cell.dataset.column = labels[n]; });
  }

  // Heading anchors are added here so headings keep clean text for search.
  const anchorIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/></svg>';
  for (const heading of document.querySelectorAll('.page-body h2[id], .page-body h3[id]')) {
    const anchor = document.createElement('a');
    anchor.className = 'heading-anchor';
    anchor.href = '#' + heading.id;
    anchor.setAttribute('aria-label', 'Link to ' + heading.textContent);
    anchor.innerHTML = anchorIcon;
    heading.prepend(anchor);
  }

  function showPage(focus = false) {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { id = ''; }
    const target = (id && document.getElementById(id)) || document.getElementById('overview');
    const current = target?.closest('.doc-page') || pages[0];
    const changed = current !== activePage;
    activePage = current;
    for (const page of pages) page.hidden = page !== current;
    const nav = current.dataset.nav;
    for (const link of navLinks) {
      if (link.dataset.nav === nav) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    for (const parent of chapters.querySelectorAll('.has-children')) {
      parent.classList.toggle('open', Boolean(parent.querySelector(`[data-nav="${CSS.escape(nav)}"]`)));
    }
    document.title = current.dataset.page === 'overview'
      ? `${product} documentation`
      : `${current.dataset.title} · ${product} documentation`;
    setSidebar(false);
    if (!narrow.matches) {
      const selected = chapters.querySelector('[aria-current="page"]');
      if (selected) {
        const item = selected.getBoundingClientRect(), list = chapters.getBoundingClientRect();
        if (item.top < list.top + 40 || item.bottom > list.bottom - 40) chapters.scrollTop += item.top - list.top - list.height / 3;
      }
    }
    const heading = current.querySelector('h1');
    const subsection = target && target !== heading && !target.classList.contains('doc-page');
    if (subsection) {
      const details = target.closest('details');
      if (details) details.open = true;
      target.scrollIntoView();
    } else if (changed || focus) window.scrollTo(0, 0);
    if (focus) {
      const focusTarget = subsection ? target : heading;
      if (!focusTarget.hasAttribute('tabindex')) focusTarget.tabIndex = -1;
      focusTarget.focus({ preventScroll: true });
    }
    updateOutline();
  }

  // Outline: highlight the section at the top of the viewport.
  function updateOutline() {
    const links = [...activePage.querySelectorAll('.page-outline a')];
    if (!links.length) return;
    const offset = (parseFloat(getComputedStyle(root).getPropertyValue('--header')) || 0) + 90;
    let current = links[0];
    for (const link of links) {
      const heading = document.getElementById(link.hash.slice(1));
      if (heading && heading.getBoundingClientRect().top <= offset) current = link;
    }
    // At the end of a page the last section is current even if it starts lower down.
    if (window.innerHeight + window.scrollY >= root.scrollHeight - 4 && window.scrollY > 0) current = links.at(-1);
    for (const link of links) {
      if (link === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
  let outlinePending = false;
  window.addEventListener('scroll', () => {
    if (outlinePending) return;
    outlinePending = true;
    requestAnimationFrame(() => { outlinePending = false; updateOutline(); });
  }, { passive: true });

  // Tabs: one choice (e.g. Windows, Compiler) applies to every matching group.
  const tabGroups = [...document.querySelectorAll('.tab-group')];
  function selectTab(group, tab, remember) {
    for (const item of group.querySelectorAll('[role="tab"]')) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    }
    if (!remember) return;
    const label = tab.dataset.tab;
    const siblings = [...group.querySelectorAll('[role="tab"]')].map(item => item.dataset.tab).sort().join('|');
    store.set('vigo-docs-tab:' + siblings, label);
    for (const other of tabGroups) {
      if (other === group) continue;
      const match = [...other.querySelectorAll('[role="tab"]')].find(item => item.dataset.tab === label);
      if (match) selectTab(other, match, false);
    }
  }
  for (const group of tabGroups) {
    const tabs = [...group.querySelectorAll('[role="tab"]')];
    const saved = store.get('vigo-docs-tab:' + tabs.map(tab => tab.dataset.tab).sort().join('|'));
    const initial = tabs.find(tab => tab.dataset.tab === saved);
    if (initial) selectTab(group, initial, false);
    else if (/Win/.test(navigator.platform || '')) {
      const windows = tabs.find(tab => tab.dataset.tab === 'Windows');
      if (windows) selectTab(group, windows, false);
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => selectTab(group, tab, true));
      tab.addEventListener('keydown', event => {
        const keys = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
        if (!(event.key in keys)) return;
        event.preventDefault();
        const next = tabs[(keys[event.key] + tabs.length) % tabs.length];
        selectTab(group, next, true);
        next.focus();
      });
    });
  }

  // Search: pages, sections and reference fields, ranked by where the words match.
  const dialog = document.querySelector('#search-dialog');
  const input = document.querySelector('#search');
  const resultLinks = document.querySelector('#search-links');
  const status = document.querySelector('#search-status');
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  // Read prose and code, skipping control labels such as Copy and language names.
  const skip = '.copy, .code-language, .heading-anchor, .tab-list, .tool';
  function textOf(node) {
    if (node.nodeType === 1 && node.matches(skip)) return '';
    const parts = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: text => text.parentElement.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
    return normalize(parts.join(' '));
  }
  const clean = node => textOf(node);
  let index;
  function buildIndex() {
    index = [];
    for (const page of pages) {
      const body = page.querySelector('.page-body');
      const group = page.dataset.group || '';
      index.push({ page, label: page.dataset.title, target: page.dataset.page, kind: 'page', group, text: textOf(body).slice(0, 4000) });
      let section;
      for (const block of body.children) {
        if (block.matches('h2, h3')) {
          section = { page, label: clean(block), target: block.id, kind: 'section', group, text: '' };
          index.push(section);
        } else if (section && section.text.length < 1200) section.text += ' ' + textOf(block);
        for (const row of block.querySelectorAll('[data-search-label]')) {
          index.push({ page, label: row.dataset.searchLabel, target: row.id, kind: 'field', group,
            text: [...row.cells].map(cell => textOf(cell)).join(' · ') });
        }
      }
    }
  }
  function highlight(node, value, words) {
    if (!words.length) { node.append(value); return; }
    const pattern = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'gi');
    let start = 0;
    for (const match of value.matchAll(pattern)) {
      node.append(value.slice(start, match.index));
      const mark = document.createElement('mark'); mark.textContent = match[0]; node.append(mark);
      start = match.index + match[0].length;
    }
    node.append(value.slice(start));
  }
  let selected = -1;
  function select(position) {
    const links = [...resultLinks.querySelectorAll('.search-result')];
    if (!links.length) { selected = -1; return; }
    selected = (position + links.length) % links.length;
    links.forEach((link, n) => link.setAttribute('aria-selected', String(n === selected)));
    links[selected].scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', links[selected].id);
  }
  const suggestions = ['Quickstart', 'maxWalkKm', 'arrive_by', 'durationsSeconds', 'Docker', 'not_found', 'Python', 'scenario'];
  function search() {
    if (!index) buildIndex();
    const query = input.value.toLowerCase().trim();
    const words = query.split(/\s+/).filter(Boolean);
    resultLinks.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    if (!query) {
      status.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.innerHTML = '<strong>Search the VIGO guide</strong>Commands, request fields, Result fields, errors and concepts.';
      const chips = document.createElement('div');
      chips.className = 'search-suggestions';
      for (const term of suggestions) {
        const chip = document.createElement('button');
        chip.type = 'button'; chip.textContent = term;
        chip.addEventListener('click', () => { input.value = term; search(); input.focus(); });
        chips.append(chip);
      }
      empty.append(chips);
      resultLinks.append(empty);
      return;
    }
    const best = new Map();
    for (const item of index) {
      const label = item.label.toLowerCase();
      const haystack = `${label} ${item.page.dataset.title.toLowerCase()} ${item.text.toLowerCase()}`;
      if (!words.every(word => haystack.includes(word))) continue;
      const score = (label === query ? 120 : label.startsWith(query) ? 90 : label.includes(query) ? 70 : 0)
        + words.filter(word => label.includes(word)).length * 12
        + (item.kind === 'field' ? 10 : item.kind === 'section' ? 6 : 8)
        + (item.page.dataset.title.toLowerCase().includes(query) ? 10 : 0)
        - (item.page.dataset.parent === 'native-fields' && label !== query ? 20 : 0);
      const key = item.kind === 'page' ? item.page : item.target;
      if (!best.has(key) || score > best.get(key).score) best.set(key, { ...item, score });
    }
    // Keep at most three hits per page so one long page cannot crowd others out.
    const perPage = new Map();
    const matches = [...best.values()].sort((a, b) => b.score - a.score).filter(item => {
      const count = perPage.get(item.page) || 0;
      perPage.set(item.page, count + 1);
      return count < 3;
    }).slice(0, 40);
    status.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'result' : 'results'}` : '';
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.innerHTML = '<strong>No results</strong>Try a command, a field name such as <code>maxWalkKm</code>, or an error message.';
      resultLinks.append(empty);
      return;
    }
    let lastGroup;
    matches.forEach((item, n) => {
      const group = item.group;
      if (group !== lastGroup && matches.length > 4) {
        const heading = document.createElement('p');
        heading.className = 'search-section'; heading.textContent = group;
        resultLinks.append(heading);
        lastGroup = group;
      }
      const link = document.createElement('a');
      link.href = '#' + item.target;
      link.className = 'search-result';
      link.id = 'search-option-' + n;
      link.setAttribute('role', 'option');
      const label = document.createElement('span'); label.className = 'search-label';
      const text = document.createElement('span'); highlight(text, item.label, words);
      label.append(text);
      if (item.kind !== 'page') {
        const kind = document.createElement('span'); kind.className = 'search-kind';
        kind.textContent = item.kind === 'field' ? 'field' : '§';
        label.append(kind);
      }
      link.append(label);
      if (item.kind !== 'page') {
        const context = document.createElement('span'); context.className = 'search-context';
        context.textContent = item.page.dataset.title; link.append(context);
      }
      const excerpt = document.createElement('span'); excerpt.className = 'search-excerpt';
      const body = normalize(item.text);
      const at = Math.max(0, body.toLowerCase().indexOf(words[0]));
      const start = Math.max(0, at - 40);
      highlight(excerpt, (start ? '…' : '') + body.slice(start, start + 170) + (body.length > start + 170 ? '…' : ''), words);
      link.append(excerpt);
      link.addEventListener('mousemove', () => { if (selected !== n) select(n); });
      resultLinks.append(link);
    });
    // Group headings are only a reading aid; keep the best result first in order.
    select(0);
  }
  let returnFocus;
  function openSearch(initial = '') {
    returnFocus = document.activeElement;
    dialog.hidden = false;
    document.body.style.overflow = 'hidden';
    input.value = initial;
    search();
    input.focus();
    input.select();
  }
  function closeSearch() {
    dialog.hidden = true;
    document.body.style.overflow = '';
    returnFocus?.focus?.({ preventScroll: true });
  }
  for (const button of document.querySelectorAll('[data-search-open]')) button.addEventListener('click', () => openSearch());
  document.querySelector('[data-search-close]')?.addEventListener('click', closeSearch);
  dialog.addEventListener('click', event => { if (event.target === dialog) closeSearch(); });
  input.addEventListener('input', search);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); select(selected + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); select(selected - 1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      resultLinks.querySelectorAll('.search-result')[Math.max(selected, 0)]?.click();
    } else if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
    else if (event.key === 'Tab') event.preventDefault();
  });
  resultLinks.addEventListener('click', event => { if (event.target.closest('.search-result')) closeSearch(); });

  // In-page navigation keeps one article visible at a time.
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const id = decodeURIComponent(link.getAttribute('href').slice(1));
    const target = document.getElementById(id);
    if (id === 'content') {
      event.preventDefault();
      const heading = activePage.querySelector('h1');
      heading.focus({ preventScroll: true });
      heading.scrollIntoView();
      return;
    }
    if (!target?.closest('.doc-page')) return;
    event.preventDefault();
    if (location.hash === '#' + id) showPage(true);
    else location.hash = id;
  });
  window.addEventListener('hashchange', () => {
    if (!dialog.hidden) { dialog.hidden = true; document.body.style.overflow = ''; }
    showPage(true);
  });

  // Copy code, copy page link, print.
  const announce = text => { const node = document.querySelector('#copy-status'); node.textContent = ''; node.textContent = text; };
  async function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    const copied = document.execCommand('copy'); area.remove();
    if (!copied) throw new Error('Clipboard unavailable');
  }
  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const text = button.closest('.code-block').querySelector('code').textContent;
      try {
        await copyText(text);
        button.textContent = 'Copied'; button.classList.add('copied');
        announce('Code copied to clipboard.');
      } catch {
        button.textContent = 'Select and copy';
        announce('Clipboard unavailable. Select the code and copy it manually.');
      }
      setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('copied'); }, 1800);
    });
  }
  for (const button of document.querySelectorAll('[data-copy-link]')) {
    button.addEventListener('click', async () => {
      const url = new URL(location.href);
      url.hash = button.closest('.doc-page').dataset.page;
      const label = button.querySelector('span');
      try { await copyText(url.href); label.textContent = 'Copied'; announce('Link copied.'); }
      catch { label.textContent = 'Unavailable'; }
      setTimeout(() => { label.textContent = 'Copy link'; }, 1800);
    });
  }
  for (const button of document.querySelectorAll('[data-print]')) button.addEventListener('click', () => window.print());

  document.addEventListener('keydown', event => {
    const typing = document.activeElement?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (dialog.hidden) openSearch(); else closeSearch();
    } else if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey && dialog.hidden) {
      event.preventDefault();
      openSearch();
    } else if (event.key === 'Escape' && sidebar?.classList.contains('open')) setSidebar(false);
  });
  narrow.addEventListener?.('change', () => setSidebar(false));

  showPage();
})();
