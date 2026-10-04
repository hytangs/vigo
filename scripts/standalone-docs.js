'use strict';

const pages = [...document.querySelectorAll('.doc-page')];
const input = document.querySelector('#search');
const navigation = document.querySelector('#navigation');
const chapters = document.querySelector('#chapters');
const results = document.querySelector('#search-results');
const resultLinks = document.querySelector('#search-links');
const resultStatus = document.querySelector('#search-status');
const navLinks = [...chapters.querySelectorAll('a')];
const mobile = window.matchMedia('(max-width: 840px)');
let activePage;
const normalize = text => text.replace(/\s+/g, ' ').trim();
const searchIndex = [];
for (const page of pages) {
  const body = page.querySelector('.page-body');
  const pageEntry = { page, label: page.dataset.title, target: page.dataset.page, kind: 'page', text: normalize(body.textContent) };
  searchIndex.push(pageEntry);
  let section;
  for (const block of body.children) {
    if (block.matches('h2, h3')) {
      section = { page, label: block.textContent, target: block.id, kind: 'section', text: '' };
      searchIndex.push(section);
    } else if (section) section.text += ' ' + normalize(block.textContent);
    for (const row of block.querySelectorAll('[data-search-label]')) {
      searchIndex.push({ page, label: row.dataset.searchLabel, target: row.id, kind: 'field',
        text: [...row.cells].map(cell => normalize([...cell.childNodes].map(node => node.textContent).join(' '))).join(' · ') });
    }
  }
}

function highlight(node, value, words) {
  const escaped = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.sort((a, b) => b.length - a.length).join('|'), 'gi');
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    node.append(document.createTextNode(value.slice(start, match.index)));
    const mark = document.createElement('mark'); mark.textContent = match[0]; node.append(mark);
    start = match.index + match[0].length;
  }
  node.append(document.createTextNode(value.slice(start)));
}

function search() {
  const query = input.value.toLowerCase().trim();
  const words = query.split(/\s+/).filter(Boolean);
  results.hidden = !query;
  chapters.hidden = Boolean(query);
  resultLinks.replaceChildren();
  if (!query) { resultStatus.textContent = ''; return; }
  const best = new Map();
  for (const item of searchIndex) {
    const label = item.label.toLowerCase();
    const combined = `${label} ${item.page.dataset.title} ${item.text}`.toLowerCase();
    if (!words.every(word => combined.includes(word))) continue;
    const score = (label === query ? 100 : label.startsWith(query) ? 80 : label.includes(query) ? 60 : 0)
      + words.filter(word => label.includes(word)).length * 10
      + (item.kind === 'field' ? 8 : item.kind === 'section' ? 4 : 0)
      - (item.page.dataset.nav === 'native-fields' && label !== query ? 20 : 0);
    if (!best.has(item.page) || score > best.get(item.page).score) best.set(item.page, { ...item, score });
  }
  const matches = [...best.values()].sort((a, b) => b.score - a.score);
  resultStatus.textContent = matches.length ? `${matches.length} ${matches.length === 1 ? 'page' : 'pages'} found` : 'No results. Try a command, field name, or error message.';
  for (const item of matches) {
    const link = document.createElement('a');
    link.href = '#' + item.target;
    link.className = 'search-result';
    const label = document.createElement('span'); label.className = 'search-label';
    highlight(label, item.label, words); link.append(label);
    if (item.kind !== 'page') {
      const context = document.createElement('span'); context.className = 'search-context';
      context.textContent = item.page.dataset.title; link.append(context);
    }
    const excerpt = document.createElement('span'); excerpt.className = 'search-excerpt';
    const text = normalize(item.text);
    const matchAt = Math.max(0, text.toLowerCase().indexOf(words[0]));
    const start = Math.max(0, matchAt - 32);
    highlight(excerpt, (start ? '…' : '') + text.slice(start, start + 150) + (text.length > start + 150 ? '…' : ''), words);
    link.append(excerpt);
    resultLinks.append(link);
  }
}

function showPage(focus = false) {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { id = ''; }
  const target = document.getElementById(id || 'overview');
  const current = target?.closest('.doc-page') || pages[0];
  activePage = current;
  for (const page of pages) page.hidden = page !== current;
  for (const link of navLinks) {
    if (link.dataset.nav === current.dataset.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${current.dataset.title} — VIGO`;
  input.value = '';
  search();
  if (mobile.matches) navigation.open = false;
  else {
    const selected = chapters.querySelector('[aria-current="page"]');
    if (selected) {
      const item = selected.getBoundingClientRect(), list = chapters.getBoundingClientRect();
      if (item.top < list.top) chapters.scrollTop += item.top - list.top;
      else if (item.bottom > list.bottom) chapters.scrollTop += item.bottom - list.bottom;
    }
  }
  const heading = current.querySelector('h1');
  const isSubsection = target && target !== current && target !== heading && !target.classList.contains('anchor');
  if (isSubsection) target.scrollIntoView();
  else window.scrollTo(0, 0);
  if (focus) {
    const focusTarget = isSubsection ? target : heading;
    focusTarget.tabIndex = -1;
    focusTarget.focus({ preventScroll: true });
  }
  updateOutline();
}

function updateOutline() {
  const headings = [...activePage.querySelectorAll('.page-body h2')];
  const current = headings.filter(heading => heading.getBoundingClientRect().top <= 170).at(-1) || headings[0];
  for (const link of activePage.querySelectorAll('.page-outline a')) {
    if (current && link.hash === '#' + current.id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
let outlinePending = false;
window.addEventListener('scroll', () => {
  if (outlinePending) return;
  outlinePending = true;
  requestAnimationFrame(() => { outlinePending = false; updateOutline(); });
}, { passive: true });

for (const group of document.querySelectorAll('.platform-group')) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  function select(tab) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault(); select(tabs[next]); tabs[next].focus();
    });
  });
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = document.getElementById(link.getAttribute('href').slice(1));
  if (target?.id === 'content') {
    event.preventDefault();
    const heading = document.querySelector('.doc-page:not([hidden]) h1');
    heading.focus({ preventScroll: true });
    heading.scrollIntoView();
    return;
  }
  if (!target?.closest('.doc-page')) return;
  event.preventDefault();
  if (location.hash === link.hash) showPage(true);
  else location.hash = link.hash;
});
window.addEventListener('hashchange', () => showPage(true));
input.addEventListener('input', search);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter') resultLinks.querySelector('a')?.click();
  if (event.key === 'ArrowDown') { event.preventDefault(); resultLinks.querySelector('a')?.focus(); }
});
resultLinks.addEventListener('keydown', event => {
  const links = [...resultLinks.querySelectorAll('a')];
  const position = links.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') { event.preventDefault(); links[Math.min(position + 1, links.length - 1)]?.focus(); }
  if (event.key === 'ArrowUp') { event.preventDefault(); (links[position - 1] || input).focus(); }
  if (event.key === 'Escape') { event.preventDefault(); input.focus(); input.value = ''; search(); }
});
document.querySelector('#print').addEventListener('click', () => window.print());
document.querySelectorAll('.copy').forEach(button => button.addEventListener('click', async () => {
  const text = button.closest('.code-block').querySelector('code').textContent;
  const status = document.querySelector('#copy-status');
  status.textContent = '';
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = document.createElement('textarea');
      area.value = text; document.body.append(area); area.select();
      const copied = document.execCommand('copy'); area.remove();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    button.textContent = 'Copied';
    status.textContent = 'Code copied to clipboard.';
  } catch { button.textContent = 'Select code'; status.textContent = 'Clipboard unavailable. Select the code and copy it manually.'; }
  setTimeout(() => { button.textContent = 'Copy'; }, 2000);
}));
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !document.activeElement.isContentEditable && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault(); navigation.open = true; input.focus();
  }
  if (event.key === 'Escape' && document.activeElement === input) { input.value = ''; search(); }
});
function resizeNavigation() { navigation.open = !mobile.matches; }
mobile.addEventListener('change', resizeNavigation);
resizeNavigation();
showPage();
