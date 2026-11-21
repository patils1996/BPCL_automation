/* ==========================================================================
   multiselect.js — multi-choice filter dropdowns for the whole dashboard
   --------------------------------------------------------------------------
   Turns the filter <select>s (those starting with "All …") into checkbox
   dropdowns so several values can be picked at once (e.g. Fully Online +
   Offline). The native <select> stays in the DOM (hidden, `multiple`) so the
   existing code that fills options, resets with `.value = ''` or listens for
   `change` keeps working.

   API (used by every page's filter logic):
     MS.vals(idOrEl)      → array of ticked values ([] = no filter / "All")
     MS.ok(values, v)     → true when values is empty or contains v
     MS.match(idOrEl, v)  → MS.ok(MS.vals(idOrEl), v)
     MS.set(idOrEl, arr)  → tick exactly these values (no change event)
   ========================================================================== */
(function () {
  'use strict';

  var FILTER_IDS = [
    // RO Explorer
    'ro-filter-status', 'ro-filter-new-logic', 'ro-filter-nano', 'ro-filter-area', 'ro-filter-technology',
    // Day Monitoring
    'day-filter-area', 'day-filter-vendor', 'day-filter-status', 'day-filter-tech', 'day-filter-resp',
    // Monitoring
    'mon-filter-area-select', 'mon-filter-vendor-select', 'mon-filter-mst-select', 'mon-filter-base-status', 'mon-filter-curr-status', 'mon-filter-change-status',
    // 3-Day Comparison
    'comp-filter-area', 'comp-filter-eo', 'comp-filter-so', 'comp-filter-vendor', 'comp-filter-d1-status', 'comp-filter-d2-status', 'comp-filter-d3-status', 'comp-filter-pattern', 'comp-filter-trend',
    // MIS Dashboard
    'statusFilter',
    // Outlets Status
    'outlets-status-filter-status', 'outlets-status-filter-area', 'outlets-status-filter-vendor', 'outlets-status-filter-tech', 'outlets-status-filter-resp',
    // RO-Wise Tank Stock
    'territory', 'area', 'vendor', 'state',
    // Day End MIS Exporter
    'dem-f-area', 'dem-f-te', 'dem-f-vendor',
    // Dashboard filter bar
    'dash-f-territory', 'dash-f-area', 'dash-f-te', 'dash-f-vendor', 'dash-f-status', 'dash-f-tech',
    // Global territory strip + MIS Dashboard filter bar
    'scope-territory', 'mis-f-territory', 'mis-f-area', 'mis-f-te', 'mis-f-vendor', 'mis-f-status', 'mis-f-tech'
  ];

  var registry = new Map(); // select element -> widget
  var openWidget = null;
  var nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

  function byId(x) { return typeof x === 'string' ? document.getElementById(x) : x; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var MS = {
    vals: function (x) {
      var el = byId(x);
      if (!el) return [];
      if (!el.multiple) { var v = nativeValue.get.call(el); return v ? [v] : []; }
      var out = [];
      for (var i = 0; i < el.options.length; i++) {
        var o = el.options[i];
        if (o.selected && o.value !== '') out.push(o.value);
      }
      return out;
    },
    ok: function (values, v) {
      var a = Array.isArray(values) ? values : (values ? [values] : []);
      if (!a.length) return true;
      return a.indexOf(String(v == null ? '' : v)) !== -1;
    },
    match: function (x, v) { return MS.ok(MS.vals(x), v); },
    set: function (x, vals) {
      var el = byId(x);
      if (!el) return;
      var w = registry.get(el);
      var arr = Array.isArray(vals) ? vals.map(String) : (vals ? [String(vals)] : []);
      if (w) { w.state = new Set(arr); w.apply(); w.render(); }
      else nativeValue.set.call(el, arr[0] || '');
    },
    enhance: enhance
  };
  window.MS = MS;

  /* ------------------------------------------------------------ widget */
  function enhance(el) {
    if (!el || registry.has(el) || el.tagName !== 'SELECT') return;
    var compact = el.classList.contains('header-filter-select');

    var root = document.createElement('div');
    root.className = 'ms' + (compact ? ' ms-compact' : '');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ms-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (el.getAttribute('aria-label')) btn.setAttribute('aria-label', el.getAttribute('aria-label'));
    btn.innerHTML = '<span class="ms-text"></span><span class="ms-count" hidden></span><svg class="ms-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6"><polyline points="6 9 12 15 18 9"/></svg>';
    root.appendChild(btn);

    el.parentNode.insertBefore(root, el.nextSibling);
    el.multiple = true;
    el.classList.add('ms-native');
    el.setAttribute('tabindex', '-1');
    el.setAttribute('aria-hidden', 'true');

    var w = {
      el: el, root: root, btn: btn, panel: null, state: new Set(),
      placeholder: function () {
        var o = Array.prototype.find.call(el.options, function (x) { return x.value === ''; });
        return o ? o.textContent.trim() : 'All';
      },
      title: function () {
        // Column header text (table filters) → aria-label → "All Sales Areas" minus "All"
        var th = el.closest('th');
        if (th) {
          var c = th.cloneNode(true);
          Array.prototype.forEach.call(c.querySelectorAll('select, .ms, button'), function (n) { n.remove(); });
          var t = c.textContent.replace(/\s+/g, ' ').trim();
          if (t) return t;
        }
        var lab = el.closest('label');
        if (lab) {
          var l = lab.cloneNode(true);
          Array.prototype.forEach.call(l.querySelectorAll('select, .ms'), function (n) { n.remove(); });
          var lt = l.textContent.replace(/\s+/g, ' ').trim();
          if (lt) return lt;
        }
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        return w.placeholder().replace(/^All\s+/i, '') || 'Filter';
      },
      options: function () {
        return Array.prototype.filter.call(el.options, function (o) { return o.value !== ''; });
      },
      apply: function () {
        // push the widget state onto the native <select>, dropping values that no longer exist
        var present = new Set();
        Array.prototype.forEach.call(el.options, function (o) {
          if (o.value === '') { o.selected = w.state.size === 0; return; }
          o.selected = w.state.has(o.value);
          if (o.selected) present.add(o.value);
        });
        w.state = present;
      },
      render: function () {
        var vals = Array.from(w.state);
        var text = btn.querySelector('.ms-text'), count = btn.querySelector('.ms-count');
        if (!vals.length) {
          text.textContent = w.placeholder();
          count.hidden = true;
          count.textContent = '';
          root.classList.remove('ms-active');
        } else {
          var first = Array.prototype.find.call(el.options, function (o) { return o.value === vals[0]; });
          text.textContent = first ? first.textContent.trim() : vals[0];
          count.hidden = vals.length < 2;
          count.textContent = '+' + (vals.length - 1);
          root.classList.add('ms-active');
        }
        btn.title = vals.length ? vals.join(', ') : w.placeholder();
        if (w.panel) renderList();
      }
    };

    // Programmatic `select.value = x` (resets etc.) keeps the widget in sync
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: function () { return nativeValue.get.call(el); },
      set: function (v) {
        w.state = new Set(v === '' || v == null ? [] : [String(v)]);
        w.apply();
        w.render();
      }
    });

    // Options re-filled by page code → re-apply the remembered selection
    new MutationObserver(function () {
      w.apply();
      w.render();
    }).observe(el, { childList: true });

    // initial state from whatever is currently selected
    Array.prototype.forEach.call(el.options, function (o) { if (o.selected && o.value !== '') w.state.add(o.value); });
    w.apply();
    w.render();

    root.addEventListener('click', function (e) { e.stopPropagation(); });
    root.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    btn.addEventListener('click', function () { openWidget === w ? close() : open(w); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(w); }
    });

    function fire() { el.dispatchEvent(new Event('change', { bubbles: true })); }

    function renderList() {
      var p = w.panel;
      var list = p.querySelector('.ms-list');
      var q = (p.querySelector('.ms-search') || {}).value || '';
      q = q.toLowerCase().trim();
      var opts = w.options().filter(function (o) { return !q || o.textContent.toLowerCase().indexOf(q) !== -1; });
      list.innerHTML = opts.length ? opts.map(function (o) {
        var on = w.state.has(o.value);
        return '<label class="ms-opt' + (on ? ' is-on' : '') + '"><input type="checkbox" value="' + esc(o.value) + '"' + (on ? ' checked' : '') + '><span class="ms-box"></span><span class="ms-lbl">' + esc(o.textContent.trim()) + '</span></label>';
      }).join('') : '<div class="ms-none">No options</div>';
      var n = w.state.size;
      p.querySelector('.ms-summary').textContent = n ? n + ' selected' : 'Showing all';
    }

    w.open = function () {
      var p = document.createElement('div');
      p.className = 'ms-panel';
      p.setAttribute('role', 'listbox');
      p.setAttribute('aria-multiselectable', 'true');
      var many = w.options().length > 8;
      p.innerHTML =
        '<div class="ms-head"><b>' + esc(w.title()) + '</b><span class="ms-summary"></span></div>' +
        (many ? '<input type="search" class="ms-search" placeholder="Search…" autocomplete="off">' : '') +
        '<div class="ms-tools"><button type="button" data-act="all">Select all</button><button type="button" data-act="clear">Clear</button></div>' +
        '<div class="ms-list"></div>' +
        '<div class="ms-foot"><button type="button" class="ms-done">Done</button></div>';
      document.body.appendChild(p);
      w.panel = p;
      renderList();

      p.addEventListener('click', function (e) { e.stopPropagation(); });
      p.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      p.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb || cb.type !== 'checkbox') return;
        if (cb.checked) w.state.add(cb.value); else w.state.delete(cb.value);
        w.apply(); w.render(); fire();
      });
      p.querySelector('.ms-tools').addEventListener('click', function (e) {
        var act = e.target.getAttribute('data-act');
        if (!act) return;
        if (act === 'all') {
          var q = (p.querySelector('.ms-search') || {}).value || '';
          w.options().forEach(function (o) { if (!q || o.textContent.toLowerCase().indexOf(q.toLowerCase()) !== -1) w.state.add(o.value); });
        } else w.state.clear();
        w.apply(); w.render(); fire();
      });
      p.querySelector('.ms-done').addEventListener('click', close);
      var s = p.querySelector('.ms-search');
      if (s) { s.addEventListener('input', renderList); setTimeout(function () { s.focus(); }, 30); }
      position(w);
    };

    registry.set(el, w);
    return w;
  }

  function position(w) {
    var p = w.panel;
    if (!p) return;
    if (window.matchMedia('(max-width: 640px)').matches) { p.classList.add('ms-sheet'); return; }
    p.classList.remove('ms-sheet');
    var r = w.btn.getBoundingClientRect();
    var width = Math.max(r.width, 220);
    p.style.minWidth = width + 'px';
    var ph = p.offsetHeight, vh = window.innerHeight, vw = window.innerWidth;
    var top = r.bottom + 6;
    if (top + ph > vh - 8 && r.top - ph - 6 > 8) top = r.top - ph - 6;
    var left = Math.min(r.left, vw - p.offsetWidth - 8);
    p.style.top = Math.max(8, top) + 'px';
    p.style.left = Math.max(8, left) + 'px';
  }

  function open(w) {
    close();
    openWidget = w;
    w.btn.setAttribute('aria-expanded', 'true');
    w.root.classList.add('ms-open');
    w.open();
    document.body.classList.add('ms-is-open');
  }
  function close() {
    var w = openWidget;
    if (!w) return;
    openWidget = null;
    w.btn.setAttribute('aria-expanded', 'false');
    w.root.classList.remove('ms-open');
    if (w.panel) { w.panel.remove(); w.panel = null; }
    document.body.classList.remove('ms-is-open');
  }

  document.addEventListener('click', function () { close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', function () { if (openWidget) position(openWidget); });
  document.addEventListener('scroll', function (e) {
    if (!openWidget || (openWidget.panel && openWidget.panel.contains(e.target))) return;
    if (window.matchMedia('(max-width: 640px)').matches) return;
    position(openWidget);
  }, true);

  function init() { FILTER_IDS.forEach(function (id) { enhance(document.getElementById(id)); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
