/* ==========================================================================
   dashboard_extra_charts.js — interactive Dashboard
   --------------------------------------------------------------------------
   1. Side chart: top 10 territories by Equipment uptime
      (MPD + ATG online ÷ onboarded), deep navy bars with the user's own
      territory in coral. Display only (tooltips, no filtering).
      With only one territory in the data it ranks sales areas instead.
   2. Every Dashboard chart is a filter:
        Sales Area Performance / Equipment Summary bar → Sales Area
        Territory Engineer bar                       → TE
        Status doughnut slice                        → Uptime status
      Click again to remove. Each chart header shows what it is filtering
      by, with a × to clear it.
   ========================================================================== */
(function () {
  'use strict';

  var topChart = null, topGroups = [], topLevel = 'territory';

  var $ = function (id) { return document.getElementById(id); };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function uptimeColor(p) { return p >= 95 ? '#138a4a' : p >= 85 ? '#d48a00' : '#c8322b'; }
  function areaLabel(v) { return String(v || '').replace(' Retail', '').replace('-retail', ''); }

  // value labels at the end of each horizontal bar
  var endLabels = {
    id: 'dxEndLabels',
    afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx, ds = chart.data.datasets[0];
      if (!ds) return;
      chart.getDatasetMeta(0).data.forEach(function (bar, i) {
        var v = ds.data[i];
        if (v == null) return;
        var label = (v >= 99.95 ? '100' : Number(v).toFixed(1)) + '%';
        ctx.save();
        ctx.font = '700 11px Inter, system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        var w = ctx.measureText(label).width, len = Math.abs(bar.x - bar.base);
        var bg = String(Array.isArray(ds.backgroundColor) ? ds.backgroundColor[i] : ds.backgroundColor).toLowerCase();
        if (len >= w + 14) { ctx.fillStyle = bg === '#f07a5a' ? '#1b365d' : '#fff'; ctx.textAlign = 'right'; ctx.fillText(label, bar.x - 7, bar.y); }
        else { ctx.fillStyle = '#0f172a'; ctx.textAlign = 'left'; ctx.fillText(label, bar.x + 5, bar.y); }
        ctx.restore();
      });
    }
  };

  // ============================================ 1. territory side chart (top 10, display only)
  function renderTop() {
    var el = $('dx-top-territory-chart');
    if (!el || typeof Chart === 'undefined') return;
    var all = (Array.isArray(window.__unscopedROs) && window.__unscopedROs.length) ? window.__unscopedROs : (window.calculatedROs || []);
    var empty = !all.length || window.dashboardMode === 'evcs';
    $('dx-top-empty').hidden = !empty;
    if (empty) { if (topChart) { topChart.destroy(); topChart = null; } return; }

    var by = function (list, keyFn) {
      var m = {};
      list.forEach(function (ro) {
        var k = keyFn(ro); if (!k) return;
        var g = m[k] || (m[k] = { name: k, onb: 0, onl: 0, ros: 0 });
        g.onb += num(ro.onb_mpd) + num(ro.onb_tnk);
        g.onl += num(ro.onl_mpd) + num(ro.onl_tnk);
        g.ros++;
      });
      return Object.keys(m).map(function (k) { var g = m[k]; g.pct = g.onb ? g.onl / g.onb * 100 : null; return g; })
        .filter(function (g) { return g.pct != null; });
    };
    var clean = function (v) { v = String(v || '').trim(); return v && v !== 'Unmapped' ? v : ''; };
    var groups = by(all, function (ro) { return clean(ro.territory); });
    topLevel = 'territory';
    if (groups.length < 2) {
      topLevel = 'area';
      groups = by(window.calculatedROs || all, function (ro) { return clean(ro.sales_area); });
    }
    groups.sort(function (a, b) { return b.pct - a.pct || b.ros - a.ros || a.name.localeCompare(b.name); });
    groups.forEach(function (g, i) { g.rank = i + 1; });
    var top = groups.slice(0, 10);
    topGroups = top;

    var mine = topLevel === 'territory' && window.GlobalScope ? GlobalScope.get() : [];
    var hasMine = top.some(function (g) { return mine.indexOf(g.name) !== -1; });
    var noun = topLevel === 'territory' ? 'Territories' : 'Sales Areas';
    $('dx-top-title').textContent = 'Top ' + top.length + ' ' + noun + ' · Equipment Uptime';
    $('dx-top-sub').textContent = (groups.length > top.length ? 'OUT OF ' + groups.length + ' · ' : '') +
      (topLevel === 'territory' ? (hasMine ? 'YOUR TERRITORY IN CORAL' : 'MPD + ATG ONLINE ÷ ONBOARDED') : 'ONE TERRITORY IN DATA, SO BY SALES AREA');

    var data = {
      labels: top.map(function (g) { return g.rank + '. ' + short(g.name, 20); }),
      datasets: [{
        data: top.map(function (g) { return +g.pct.toFixed(2); }),
        // deep navy bars; the user's own territory in coral
        backgroundColor: top.map(function (g) { return mine.indexOf(g.name) !== -1 ? '#f07a5a' : '#1b365d'; }),
        borderRadius: 6, maxBarThickness: 24, categoryPercentage: 0.78, barPercentage: 0.9
      }]
    };
    var opts = {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      layout: { padding: { right: 8 } },
      events: ['mousemove', 'mouseout', 'touchstart', 'touchmove'],      // tooltips only — no click action
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: function (it) { return topGroups[it[0].dataIndex].name; },
          label: function (it) { var g = topGroups[it.dataIndex]; return ' ' + g.pct.toFixed(2) + '% · ' + g.onl + '/' + g.onb + ' units · ' + g.ros + ' ROs'; }
        } }
      },
      scales: {
        x: { min: 0, max: 100, grid: { color: 'rgba(27, 54, 93, .07)' }, ticks: { color: '#5b6b84', font: { family: 'Inter', size: 11 }, callback: function (v) { return v + '%'; } } },
        y: { grid: { display: false }, ticks: { color: '#1b365d', autoSkip: false, font: { family: 'Inter', size: 11.5, weight: '700' } } }
      }
    };
    if (topChart) topChart.destroy();
    topChart = new Chart(el.getContext('2d'), { type: 'bar', data: data, options: opts, plugins: [endLabels] });
  }

  function pointer(evt, items) {
    var t = evt && evt.native && evt.native.target;
    if (t) t.style.cursor = items && items.length ? 'pointer' : 'default';
  }

  // ============================================ 2. click-to-filter on the 4 charts
  var FILTER_CHARTS = [
    { canvas: 'sales-area-bar-chart', key: 'salesArea', what: 'sales area', list: function () { return window.salesAreaSummary || []; }, label: areaLabel },
    { canvas: 'equipment-comp-chart', key: 'salesArea', what: 'sales area', list: function () { return (window.salesAreaSummary || []).slice(0, 15); }, label: areaLabel },
    { canvas: 'eo-horizontal-chart', key: 'eoName', what: 'TE', list: function () { return (window.eoSummary || []).slice(0, 15); }, label: function (v) { return v; } },
    { canvas: 'status-doughnut-chart', key: 'status', what: 'status', list: function () { return [{ key: 'Fully Online' }, { key: 'Partially Online' }, { key: 'Offline' }]; }, label: function (v) { return v; } }
  ];

  function activeVals(key) { return typeof dfArr === 'function' ? dfArr(key) : []; }

  function makeInteractive() {
    if (typeof Chart === 'undefined') return;
    FILTER_CHARTS.forEach(function (cfg) {
      var chart = Chart.getChart(cfg.canvas);
      if (!chart) return;
      var o = chart.config.options;            // raw options (not the resolved proxy)
      o.onHover = pointer;
      o.onClick = function (evt, items) {
        if (!items || !items.length || typeof toggleDashboardFilter !== 'function') return;
        var item = cfg.list()[items[0].index];
        if (item) setTimeout(function () { toggleDashboardFilter(cfg.key, item.key); }, 0);
      };
      o.plugins = o.plugins || {};
      o.plugins.tooltip = o.plugins.tooltip || {};
      o.plugins.tooltip.callbacks = Object.assign({}, o.plugins.tooltip.callbacks, {
        footer: function (it) {
          var item = it && it.length ? cfg.list()[it[0].dataIndex] : null;
          if (!item) return '';
          return activeVals(cfg.key).indexOf(item.key) !== -1 ? 'Click to remove this filter' : 'Click to filter the dashboard';
        }
      });
      chart.update('none');
      headerChip(cfg, chart.canvas);
    });
  }

  // "Filtered: Desur ×" in each chart header (or a quiet hint when nothing is picked)
  function headerChip(cfg, canvas) {
    var card = canvas.closest('.panel-card');
    var head = card && card.querySelector('.panel-card-header');
    if (!head) return;
    var chip = head.querySelector('.dx-filter-chip[data-key="' + cfg.canvas + '"]');
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'dx-filter-chip';
      chip.setAttribute('data-key', cfg.canvas);
      head.appendChild(chip);
    }
    var vals = activeVals(cfg.key);
    if (!vals.length) {
      chip.className = 'dx-filter-chip dx-hint';
      chip.innerHTML = 'Click to filter';
      return;
    }
    var txt = vals.map(cfg.label).join(', ');
    chip.className = 'dx-filter-chip is-on';
    chip.innerHTML = '<span title="' + esc(txt) + '">' + esc(short(txt, 26)) + '</span>' +
      '<button type="button" aria-label="Clear ' + esc(cfg.what) + ' filter" data-clear="' + cfg.key + '">' +
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-clear]');
    if (!t) return;
    if (typeof dashboardFilters === 'object' && typeof applyDashboardFilters === 'function') {
      dashboardFilters[t.getAttribute('data-clear')] = null;
      applyDashboardFilters();
    }
  });

  // Run after every Dashboard chart redraw (filters, data, territory change)
  function hook() {
    if (typeof window.updateOverviewCharts !== 'function' || window.updateOverviewCharts.__dx) return;
    var orig = window.updateOverviewCharts;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      try { makeInteractive(); renderTop(); } catch (e) { console.warn('[Dashboard charts]', e); }
      return r;
    };
    wrapped.__dx = true;
    window.updateOverviewCharts = wrapped;
  }
  hook();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook);

  window.renderDashboardExtraCharts = function () { hook(); makeInteractive(); renderTop(); };
})();
