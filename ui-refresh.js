/* ==========================================================================
   UI refresh helpers
   - Header page title / breadcrumb follows the active sidebar tab
   - Loaded-file meta gets a tooltip and a "live" dot
   - Chart.js global defaults (font, colours, tooltips) for a consistent look
   ========================================================================== */
(function () {
  'use strict';

  var PAGE_META = {
    'tab-overview':          { title: 'Automation Uptime', accent: 'Dashboard', sub: 'Automation | IFMS | Uptime Monitoring' },
    'tab-new-logic':         { title: 'Automation Uptime', accent: 'MIS',       sub: 'Equipment and 2-slot uptime recalculated from the RAW Data sheet' },
    'tab-performance-trend': { title: 'Performance',       accent: 'Trend',     sub: 'Day-end history, archive and uptime trend over time' },
    'tab-day-monitoring':    { title: 'Day',               accent: 'Monitoring', sub: 'Offline and partially online sites that need action today' },
    'tab-monitoring':        { title: 'Status',            accent: 'Monitoring', sub: 'Yesterday 10 PM vs today: drops and improvements' },
    'tab-comparison':        { title: '3-Day',             accent: 'Comparison', sub: 'Separate dealer-side downtime from equipment faults' },
    'tab-outlets-status':    { title: 'Outlets',           accent: 'Status',    sub: '2-slot partial and offline sites with responsibility tracking' },
    'tab-sales-area':        { title: 'Sales Area',        accent: 'Summary',   sub: 'Outlet and equipment uptime by sales area' },
    'tab-vendor-summary':    { title: 'Vendor',            accent: 'Summary',   sub: 'Outlet and equipment uptime by automation vendor' },
    'tab-eo-summary':        { title: 'TE',                accent: 'Summary',   sub: 'Uptime by Territory Engineer' },
    'tab-so-summary':        { title: 'SO',                accent: 'Summary',   sub: 'Uptime by Sales Officer' },
    'tab-day-end-mis':       { title: 'Day End',           accent: 'MIS Exporter', sub: 'Build, compare and export the day-end automation MIS (Excel, WhatsApp, PDF)' },
    'tab-ro-explorer':       { title: 'RO',                accent: 'Explorer',  sub: 'Search and inspect any retail outlet' },
    'tab-mapping':           { title: 'Mappings',          accent: 'Database',  sub: 'TE / SO / sales-area mapping used across the dashboard' }
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  window.uiSetPageTitle = function (tabId, item, opts) {
    var meta = PAGE_META[tabId];
    var label = item ? (item.querySelector('span') || item).textContent.trim() : '';
    var titleEl = document.getElementById('header-page-title');
    var crumbEl = document.getElementById('header-page-name');
    var subEl = document.getElementById('app-subtitle');
    if (crumbEl) crumbEl.textContent = label || (meta ? meta.title + ' ' + meta.accent : '');
    if (titleEl && meta) {
      titleEl.innerHTML = escapeHtml(meta.title) + ' <span class="highlight-yellow">' + escapeHtml(meta.accent) + '</span>';
    }
    // The overview subtitle is owned by app.js (it switches to EVCS stats); only set it for other tabs.
    if (subEl && meta && tabId !== 'tab-overview') subEl.textContent = meta.sub;
    if (subEl && tabId === 'tab-overview' && !/Chargers/.test(subEl.textContent)) subEl.textContent = meta.sub;
    document.title = (label || 'Dashboard') + ' | BPCL Belgaum Automation';
    if (opts && opts.keepScroll) return;
    try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, 0); }
    var main = document.querySelector('main');
    if (main) main.scrollTop = 0;
  };

  // Mirror the loaded-file text into a tooltip and flag the header as "data loaded"
  function watchFileMeta() {
    var meta = document.getElementById('file-meta');
    var box = document.querySelector('.header-file-meta-box');
    if (!meta || !box) return;
    var sync = function () {
      var txt = meta.textContent.trim();
      meta.title = txt;
      box.classList.toggle('is-loaded', !!txt && !/No data loaded/i.test(txt));
      meta.style.display = '';
    };
    sync();
    new MutationObserver(sync).observe(meta, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  }

  // Chart.js defaults so every chart in every module shares the same typography
  function applyChartDefaults() {
    if (!window.Chart || !Chart.defaults) return;
    var d = Chart.defaults;
    d.font.family = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
    d.font.size = 11;
    d.color = '#5b6b84';
    d.borderColor = 'rgba(15, 30, 54, 0.06)';
    if (d.plugins && d.plugins.tooltip) {
      var t = d.plugins.tooltip;
      t.backgroundColor = '#0b1f3a';
      t.titleColor = '#ffffff';
      t.bodyColor = '#dbe4f0';
      t.padding = 10;
      t.cornerRadius = 8;
      t.boxPadding = 4;
      t.titleFont = { weight: '700', size: 12 };
      t.bodyFont = { size: 12 };
      t.displayColors = true;
      t.usePointStyle = true;
    }
    if (d.plugins && d.plugins.legend && d.plugins.legend.labels) {
      d.plugins.legend.labels.usePointStyle = true;
      d.plugins.legend.labels.pointStyle = 'rectRounded';
      d.plugins.legend.labels.padding = 14;
    }
    if (d.elements) {
      if (d.elements.bar) d.elements.bar.borderRadius = 6;
      if (d.elements.line) { d.elements.line.tension = 0.35; d.elements.line.borderWidth = 2.25; }
      if (d.elements.point) { d.elements.point.radius = 3; d.elements.point.hoverRadius = 5; }
    }
  }

  applyChartDefaults();

  function init() {
    watchFileMeta();
    var active = document.querySelector('.sidebar-menu .menu-item.active');
    if (active) window.uiSetPageTitle(active.dataset.tab, active);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
