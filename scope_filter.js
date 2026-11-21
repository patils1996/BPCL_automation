/* ==========================================================================
   scope_filter.js — Global Territory filter (applies to every menu)
   --------------------------------------------------------------------------
   One territory selection, shared by every page. Choose territories on the
   Dashboard (or any menu) and every menu — Dashboard, MIS, Monitoring,
   Comparison, Trend, Outlets, Tank Stock, Day End MIS … — shows only those
   territories. The choice is remembered on this device.

   API
     GlobalScope.get()              → selected territories ([] = all)
     GlobalScope.match(territory)   → true if in scope (unknown territory = kept,
                                      so older snapshots without the column still show)
     GlobalScope.matchRow(row)      → same, reading row.territory / row.Territory
     GlobalScope.set(arr)           → change selection and refresh every menu
     GlobalScope.registerTerritories(list) → add options seen in the data
     GlobalScope.bind(idOrEl)       → keep a <select> in sync with the scope
     GlobalScope.metricsFor(rawRows)→ dashboard metrics for rows in scope (Trend)
   ========================================================================== */
(function () {
  'use strict';

  var KEY = 'bpcl_scope_territory';
  var selected = load();
  var known = new Set();
  var controls = [];
  var refreshing = false;

  function load() {
    try {
      var item = localStorage.getItem(KEY);
      if (item === null) {
        // First-time visit: default to 'Belgaum' so mobile & low-memory devices load instantly
        return ['Belgaum'];
      }
      var v = JSON.parse(item || '[]');
      return Array.isArray(v) ? v.filter(Boolean).map(String) : [];
    } catch (e) { return ['Belgaum']; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(selected)); } catch (e) { /* ignore */ } }
  function same(a, b) { return a.length === b.length && a.every(function (x) { return b.indexOf(x) !== -1; }); }
  function clean(t) { return t == null ? '' : String(t).trim(); }
  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  var GS = {
    get: function () { return selected.slice(); },
    active: function () { return selected.length > 0; },
    match: function (t) {
      if (!selected.length) return true;
      t = clean(t);
      if (!t || t === 'Unmapped') return true; // no territory info (older snapshots) → keep
      return selected.indexOf(t) !== -1;
    },
    matchRow: function (r) {
      if (!r) return true;
      return GS.match(r.territory != null ? r.territory : (r.Territory != null ? r.Territory : r['Territory Name']));
    },
    label: function () { return selected.length ? selected.join(', ') : 'All territories'; },

    registerTerritories: function (list) {
      var before = known.size;
      (list || []).forEach(function (t) { t = clean(t); if (t && t !== 'Unmapped') known.add(t); });
      selected.forEach(function (t) { known.add(t); });
      if (known.size !== before) renderControls();
    },
    territories: function () { return Array.from(known).sort(); },

    bind: function (x) {
      var el = typeof x === 'string' ? document.getElementById(x) : x;
      if (!el || controls.indexOf(el) !== -1) return;
      controls.push(el);
      el.addEventListener('change', function () {
        if (refreshing) return;
        var vals = window.MS ? MS.vals(el) : (el.value ? [el.value] : []);
        if (!same(vals, selected)) GS.set(vals);
      });
      renderControls();
    },

    set: function (arr, opts) {
      var next = (arr || []).map(clean).filter(Boolean);
      if (same(next, selected) && !(opts && opts.force)) return;
      selected = next;
      selected.forEach(function (t) { known.add(t); });
      save();
      renderControls();
      if (!(opts && opts.silent)) refreshAll();
    },

    metricsFor: metricsFor
  };
  window.GlobalScope = GS;

  /* --------------------------------------------------- dropdown controls */
  function renderControls() {
    var opts = GS.territories();
    refreshing = true;
    try {
      controls.forEach(function (el) {
        if (el.dataset.scopeOwnOptions === '1') {
          // page fills its own options (Tank Stock): only push the selection
          if (window.MS) MS.set(el, selected); else el.value = selected[0] || '';
          el.dispatchEvent(new Event('change', { bubbles: true })); // let the page redraw (ignored by our own listener)
          return;
        }
        var all = el.getAttribute('data-all-label') || 'All Territories';
        el.innerHTML = '<option value="">' + esc(all) + '</option>' +
          opts.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
        if (window.MS) MS.set(el, selected); else el.value = selected[0] || '';
      });
    } finally { refreshing = false; }
    var chip = document.getElementById('scope-active-chip');
    if (chip) { chip.hidden = !selected.length; chip.textContent = selected.length ? 'Filtered' : ''; }
  }

  /* ---------------------------------------------- refresh every menu */
  function refreshAll() {
    // 1. Shared outlet list → Dashboard, summaries, RO Explorer, Day Monitoring,
    //    Monitoring, Outlets Status, MIS Dashboard, Comparison (via hooks)
    if (typeof window.recalculateAndRefresh === 'function' && window.dashboardMode !== 'evcs' &&
        Array.isArray(window.rawDataRows) && window.rawDataRows.length) {
      window.__keepDashFilters = true;
      try { window.recalculateAndRefresh(); } finally { window.__keepDashFilters = false; }
    } else if (typeof window.renderNewLogicDashboard === 'function') {
      window.renderNewLogicDashboard();
    }
    // 2. Pages that build from their own data, when open
    var active = document.querySelector('.tab-panel.active');
    var id = active ? active.id : '';
    if (id === 'tab-day-end-mis' && window.renderDayEndMIS) window.renderDayEndMIS('open');
    if (id === 'tab-performance-trend' && window.loadUploadHistory) window.loadUploadHistory();
    if (id === 'tab-monitoring' && window.renderMonitoringComparison) window.renderMonitoringComparison();
    if (id === 'tab-comparison' && window.render3DayComparison) window.render3DayComparison({ reload: true });
    if (id === 'tab-tank-stock' && window.TankStock && window.TankStock.onScopeChange) window.TankStock.onScopeChange();
    if (window.showToast) window.showToast(selected.length ? 'Territory: ' + selected.join(', ') + ' — applied to all menus' : 'Showing all territories', 'success');
  }

  /* ------------------------------------- metrics for Trend snapshots */
  function metricsFor(rows) {
    var list = (rows || []).filter(GS.matchRow);
    if (!list.length || list[0].onb_mpd === undefined) return null;
    var m = { totalROs: 0, fullyOnline: 0, partiallyOnline: 0, offline: 0, onbM: 0, onlM: 0, onbT: 0, onlT: 0, rsp: 0 };
    list.forEach(function (r) {
      var oM = +r.onb_mpd || 0, lM = +r.onl_mpd || 0, oT = +r.onb_tnk || 0, lT = +r.onl_tnk || 0;
      var onb = oM + oT, onl = lM + lT;
      m.totalROs++;
      if (onb > 0 && onl > 0) { if (onl >= onb) m.fullyOnline++; else m.partiallyOnline++; } else m.offline++;
      m.onbM += oM; m.onlM += lM; m.onbT += oT; m.onlT += lT;
      if (/^yes$/i.test(String(r.auto_rsp || ''))) m.rsp++;
    });
    return {
      totalROs: m.totalROs,
      fullyOnline: m.fullyOnline,
      partiallyOnline: m.partiallyOnline,
      offline: m.offline,
      uptime: (m.onbM + m.onbT) ? (m.onlM + m.onlT) / (m.onbM + m.onbT) : 0,
      mpdUptime: m.onbM ? m.onlM / m.onbM : 0,
      tankUptime: m.onbT ? m.onlT / m.onbT : 0,
      autoRspPct: m.totalROs ? m.rsp / m.totalROs : 0
    };
  }

  function init() {
    // Global strip (all menus without their own territory filter) + Dashboard + MIS dropdowns
    ['scope-territory', 'dash-f-territory', 'mis-f-territory'].forEach(GS.bind);
    // Tank Stock keeps its own Territory list (from the tank files) but shares the selection
    var tank = document.getElementById('territory');
    if (tank) { tank.dataset.scopeOwnOptions = '1'; GS.bind(tank); }
    // when the list of territories grows, refresh option lists everywhere
    renderControls();
    // Mark the active menu on <body> so the strip can hide where a page has its own control
    var act = document.querySelector('.tab-panel.active');
    if (act) document.body.dataset.tab = act.id;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
