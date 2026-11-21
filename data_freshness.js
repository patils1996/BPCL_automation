/* ==========================================================================
   data_freshness.js — "Data last updated" bar shown on every menu
   --------------------------------------------------------------------------
   Tells every user how fresh the figures are.

   Source of the time, best first:
     1. Google Sheet → "Last Updated" tab (written by google_sheet_script/Code.gs
        each time the Uptime tab is imported) → the real data time, same for all users
     2. Manual Excel upload → the date/time confirmed in the upload dialog
     3. Google Sheet without that tab → only the time this device fetched it

   API
     DataFreshness.fromWorkbook(book)  → reads the "Last Updated" tab (sheet sync)
     DataFreshness.sheetChecked()      → sheet re-checked, no change
     DataFreshness.fromUpload(ms, name)→ manual upload with confirmed data time
   ========================================================================== */
(function () {
  'use strict';

  var KEY = 'bpcl_data_freshness';
  var state = load();   // { source, dataAt, checkedAt, label }
  var el = null, timer = null;

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(d) {
    var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + two(d.getMinutes()) + ' ' + ap;
  }
  function fmtDateTime(ms) {
    var d = new Date(ms), now = new Date();
    var y = new Date(now); y.setDate(now.getDate() - 1);
    var same = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
    var day = same(d, now) ? 'Today' : same(d, y) ? 'Yesterday' : (d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear());
    return day + ', ' + fmtTime(d);
  }
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h ' + (m % 60 ? (m % 60) + ' min ' : '') + 'ago';
    var d = Math.floor(h / 24);
    return d + ' day' + (d > 1 ? 's' : '') + ' ago';
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Parse a time cell: ISO text, Excel serial number, or "dd-MMM-yyyy hh:mm a"
  function parseTime(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') {
      if (v > 1e12) return v;                          // epoch ms
      if (v > 20000 && v < 80000) {                     // Excel serial (local time)
        var ms = Math.round((v - 25569) * 86400000);
        var d = new Date(ms);
        return ms + d.getTimezoneOffset() * 60000;
      }
      return NaN;
    }
    var s = String(v).trim();
    var t = Date.parse(s);
    if (!isNaN(t)) return t;
    var m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3})[-\s/](\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
    if (m) {
      var mon = MON.findIndex(function (x) { return x.toLowerCase() === m[2].toLowerCase(); });
      var hh = +m[4];
      if (m[6]) { var pm = /p/i.test(m[6]); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
      return new Date(+m[3], mon, +m[1], hh, +m[5]).getTime();
    }
    return NaN;
  }

  /** "Last Updated" tab (array of arrays) → ms of the Uptime tab's last import */
  function readMeta(aoa) {
    if (!aoa || aoa.length < 2) return NaN;
    var head = (aoa[0] || []).map(function (h) { return String(h == null ? '' : h).toLowerCase(); });
    var iIso = head.findIndex(function (h) { return /iso/.test(h); });
    var iLoc = head.findIndex(function (h) { return /updated|time|date/.test(h) && !/iso/.test(h); });
    var best = NaN, uptime = NaN;
    for (var r = 1; r < aoa.length; r++) {
      var row = aoa[r] || [];
      var t = parseTime(iIso >= 0 ? row[iIso] : NaN);
      if (isNaN(t) && iLoc >= 0) t = parseTime(row[iLoc]);
      if (isNaN(t)) continue;
      if (/uptime|raw/i.test(String(row[0] || ''))) uptime = t;
      if (isNaN(best) || t > best) best = t;
    }
    return !isNaN(uptime) ? uptime : best;
  }

  var API = {
    fromWorkbook: function (book) {
      var aoa = book && book.byKind ? book.byKind('meta') : null;
      var t = readMeta(aoa);
      state = { source: isNaN(t) ? 'sheet-nostamp' : 'sheet', dataAt: isNaN(t) ? null : t, checkedAt: Date.now() };
      save(); render();
    },
    sheetChecked: function () {
      if (!state.source || state.source === 'upload') state.source = 'sheet-nostamp';
      state.checkedAt = Date.now();
      save(); render();
    },
    fromUpload: function (ms, name) {
      state = { source: 'upload', dataAt: ms || Date.now(), checkedAt: Date.now(), label: name || '' };
      save(); render();
    },
    get: function () { return Object.assign({}, state); }
  };
  window.DataFreshness = API;

  // ---------------------------------------------------------------- UI
  function level(ms) {
    var h = (Date.now() - ms) / 3600000;
    return h <= 3 ? 'fresh' : h <= 12 ? 'aging' : 'stale';
  }

  function render() {
    if (!el) return;
    var hasData = Array.isArray(window.rawDataRows) && window.rawDataRows.length > 0;
    if (!state.source || (!hasData && !state.dataAt)) { el.hidden = true; return; }
    el.hidden = false;

    var main, sub = '', lvl, title;
    if (state.source === 'sheet' && state.dataAt) {
      lvl = level(state.dataAt);
      main = '<span class="dfr-k"><span class="dfr-long">Data last updated in Google Sheet</span><span class="dfr-short">Sheet updated</span></span> <b>' + esc(fmtDateTime(state.dataAt)) + '</b> <span class="dfr-ago">(' + esc(ago(state.dataAt)) + ')</span>';
      title = 'Time the Uptime data was last imported into the shared Google Sheet';
    } else if (state.source === 'upload' && state.dataAt) {
      lvl = level(state.dataAt);
      main = '<span class="dfr-k"><span class="dfr-long">Data from uploaded file</span><span class="dfr-short">File data</span></span> <b>' + esc(fmtDateTime(state.dataAt)) + '</b> <span class="dfr-ago">(' + esc(ago(state.dataAt)) + ')</span>';
      title = (state.label ? state.label + ' — ' : '') + 'date/time confirmed at upload (this device only)';
    } else {
      lvl = 'unknown';
      main = '<span class="dfr-k">Synced from Google Sheet</span> <b>' + esc(state.checkedAt ? fmtDateTime(state.checkedAt) : '—') + '</b>';
      title = 'The Google Sheet has no "Last Updated" tab yet, so only the sync time is known';
    }
    if (state.checkedAt && state.source !== 'upload') {
      sub = 'Checked ' + esc(fmtTime(new Date(state.checkedAt))) + '<span class="dfr-long"> · auto-refresh every ' + esc(autoMin()) + ' min</span>';
    }
    var badge = { fresh: 'Up to date', aging: 'Few hours old', stale: 'Old data', unknown: 'Live sync' }[lvl];
    el.className = 'dfr dfr-' + lvl;
    el.title = title;
    el.innerHTML =
      '<span class="dfr-dot" aria-hidden="true"></span>' +
      '<span class="dfr-main">' + main + '</span>' +
      '<span class="dfr-badge">' + badge + '</span>' +
      (sub ? '<span class="dfr-sub">' + sub + '</span>' : '');
  }
  function autoMin() { return Math.max(2, parseInt(localStorage.getItem('bpcl_sheet_autosync_min') || '5', 10) || 5); }

  function init() {
    el = document.createElement('div');
    el.id = 'data-freshness';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    var strip = document.querySelector('.top-yellow-accent-strip');
    var main = document.querySelector('.app-container main');
    if (strip && strip.parentNode) strip.parentNode.insertBefore(el, strip.nextSibling);
    else if (main) main.insertBefore(el, main.firstChild);
    else document.body.insertBefore(el, document.body.firstChild);
    render();
    timer = setInterval(render, 60000);           // keep "x min ago" current
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') render(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // re-render once data is on screen (restored sessions etc.)
  window.addEventListener('load', function () { setTimeout(render, 1500); });
  API.render = render;
})();
