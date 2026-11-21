/* ==========================================================================
   day_end_mis.js — Day End MIS Exporter
   --------------------------------------------------------------------------
   Builds the Automation Day End MIS from the IndexedDB upload history
   (Day End = latest snapshot of a date, same rule as Performance Trend) or
   from the data that is currently loaded, compares it with the previous
   Day End, previews it on screen and exports:
     • multi-sheet Excel workbook (.xlsx)
     • WhatsApp / e-mail text summary (copy or share)
     • printable / PDF view
   Works on mobile, tablet and desktop (Web Share API on phones).
   ========================================================================== */
(function () {
  'use strict';

  var TERRITORY = 'Belgaum Retail Territory';
  var LIVE_ID = 'live';
  var STATUS_RANK = { 'Fully Online': 2, 'Partially Online': 1, 'Offline': 0 };

  var S = {
    records: [],          // automation history records, newest first
    dates: [],            // unique dates, newest first
    byDate: {},           // date -> [records newest first]
    reportKey: '',        // 'live' or record id
    compareKey: '',       // '' (none) or record id
    basis: 'equipment',   // 'equipment' | 'colv'
    filters: { area: [], te: [], vendor: [] },
    view: 'summary',
    report: null,         // computed report
    statusCache: {},      // record id -> {roid: status}
    busy: false,
    bound: false
  };

  /* ---------------------------------------------------------------- utils */
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function pct(v, d) { return (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(d == null ? 1 : d) + '%'; }
  function ratio(a, b) { return b > 0 ? a / b : null; }
  function toast(msg, type) { if (typeof window.showToast === 'function') window.showToast(msg, type || 'success'); }
  function todayStr() {
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    return m[3] + '-' + MONTHS[parseInt(m[2], 10) - 1] + '-' + m[1];
  }
  function fmtTime(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    if (!m) return String(t || '');
    var h = parseInt(m[1], 10), ap = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 || 12;
    return h12 + ':' + m[2] + ' ' + ap;
  }
  function deltaPP(a, b) { return (a == null || b == null) ? null : (a - b) * 100; }
  function signed(n, d, suffix) {
    if (n == null || !isFinite(n)) return '—';
    var s = n.toFixed(d == null ? 0 : d);
    if (parseFloat(s) === 0) return '0' + (suffix || '');
    return (n > 0 ? '+' : '') + s + (suffix || '');
  }

  function getDB() { return (typeof DB !== 'undefined') ? DB : (window.DB || null); }

  /* ------------------------------------------------------- history loading */
  function isAutomationRecord(rec) {
    if (!rec || !Array.isArray(rec.rawData) || !rec.rawData.length) return false;
    var r0 = rec.rawData[0] || {};
    if (r0.station_name !== undefined) return false;           // EVCS snapshot
    return r0.roid !== undefined;
  }

  async function loadHistory() {
    var db = getDB();
    var recs = [];
    if (db) {
      try {
        if (!db.db) await db.open();
        recs = await db.getAllRecords();
      } catch (e) { console.warn('[DayEndMIS] history read failed', e); }
    }
    recs = (recs || []).filter(isAutomationRecord)
      .filter(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')); })
      .sort(function (a, b) { return b.timestamp - a.timestamp; });
    S.records = recs;
    S.byDate = {};
    recs.forEach(function (r) { (S.byDate[r.date] = S.byDate[r.date] || []).push(r); });
    S.dates = Object.keys(S.byDate).sort().reverse();
    S.statusCache = {};
  }

  function hasLive() {
    return window.dashboardMode !== 'evcs' && Array.isArray(window.rawDataRows) && window.rawDataRows.length > 0 &&
      window.rawDataRows[0] && window.rawDataRows[0].roid !== undefined;
  }

  function findRecord(id) {
    for (var i = 0; i < S.records.length; i++) if (String(S.records[i].id) === String(id)) return S.records[i];
    return null;
  }

  /** Snapshot descriptor for report or comparison. */
  function getSnapshot(key) {
    if (!key) return null;
    if (key === LIVE_ID) {
      if (!hasLive()) return null;
      var meta = ($('file-meta') && $('file-meta').textContent.trim()) || 'Currently loaded data';
      var now = new Date();
      return {
        id: LIVE_ID, date: todayStr(),
        time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
        filename: window.lastUploadedFileName || meta.replace(/^Loaded( from DB)?:\s*/i, ''),
        rawData: window.rawDataRows, live: true
      };
    }
    return findRecord(key);
  }

  /** Previous Day End strictly before the given date. */
  function previousDayEnd(dateStr) {
    for (var i = 0; i < S.dates.length; i++) {
      if (S.dates[i] < dateStr) return S.byDate[S.dates[i]][0];
    }
    return null;
  }

  /* --------------------------------------------------------- calculations */
  function mapping(roid) {
    var m = window.activeMappings || (typeof activeMappings !== 'undefined' ? activeMappings : {}) || {};
    return m[roid] || m[String(roid)] || {};
  }

  function normaliseStatus(raw) {
    var s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    if (s === 'fully online' || s === 'online') return 'Fully Online';
    if (s.indexOf('part') !== -1) return 'Partially Online';
    if (s.indexOf('off') !== -1) return 'Offline';
    if (s.indexOf('online') !== -1) return 'Fully Online';
    return '';
  }

  var NANO = {
    'Fully online, Fully online': 'Fully Online',
    'Offline, Fully online': 'No MPD Communicated',
    'Partially MPD, Fully online': 'Partially Communicated MPD',
    'Fully online, Partially ATG': 'Partially Communicated ATG',
    'Fully online, Offline': 'No ATG Communicated',
    'Partially MPD, Offline': 'Partially Online',
    'Offline, Offline': 'Offline',
    'Partially MPD, Partially ATG': 'Partially Online',
    'Offline, Partially ATG': 'Partially Online'
  };

  /** Pure re-implementation of app.js processCalculations() — never mutates globals. */
  function computeROs(rawRows) {
    var limited = false;
    var list = (rawRows || []).map(function (row) {
      var roid = String(row.roid);
      var m = mapping(roid);
      var full = row.onb_mpd !== undefined || row.onb_tnk !== undefined;
      if (!full) limited = true;

      var onbM = num(row.onb_mpd), onlM = num(row.onl_mpd), onbT = num(row.onb_tnk), onlT = num(row.onl_tnk);
      var totOnb = onbM + onbT, totOnl = onlM + onlT;

      var eqStatus = 'Offline';
      if (full) {
        if (totOnb > 0 && totOnl > 0) eqStatus = totOnl >= totOnb ? 'Fully Online' : 'Partially Online';
      } else {
        eqStatus = normaliseStatus(row.status) || 'Offline';
      }

      var colv = normaliseStatus(row.ro_online_status) || (full ? eqStatus : normaliseStatus(row.status)) || eqStatus;

      var mc = onlM > 0 ? (onlM >= onbM ? 'Fully online' : 'Partially MPD') : 'Offline';
      var tc = onlT > 0 ? (onlT >= onbT ? 'Fully online' : 'Partially ATG') : 'Offline';
      var cond = mc + ', ' + tc;

      var iotRaw = String(row.iot_enabled || '').toLowerCase();
      return {
        roid: roid,
        outlet_name: row.outlet_name || m.outlet_name || ('RO ' + roid),
        sales_area: row.sales_area || m.sales_area || 'Unmapped',
        territory: row.territory || m.territory || '',
        eo_name: m.eo_name || 'Unmapped',
        so_name: m.so_name || 'Unmapped',
        mst_name: m.mst_name || 'Unmapped',
        vendor: row.vendor || m.vendor || 'Unmapped',
        auto_rsp: String(row.auto_rsp || 'No'),
        iot_status: iotRaw === 'yes' ? 'IOT' : (full ? 'WFCC' : ''),
        onb_mpd: full ? onbM : null, onl_mpd: full ? onlM : null,
        onb_tnk: full ? onbT : null, onl_tnk: full ? onlT : null,
        off_mpd: full ? Math.max(0, onbM - onlM) : null,
        off_tnk: full ? Math.max(0, onbT - onlT) : null,
        uptime: full ? ratio(totOnl, totOnb) : null,
        eq_status: eqStatus,
        colv_status: colv,
        nano_status: full ? (NANO[cond] || 'Partially Online') : '',
        mpd_pct: row.mpd_online_pct != null ? num(row.mpd_online_pct) : null,
        tank_pct: row.tank_online_pct != null ? num(row.tank_online_pct) : null,
        avg_pct: row.avg_ro_online_pct != null ? num(row.avg_ro_online_pct) : null,
        full: full
      };
    });

    // Global Territory filter (shared by every menu)
    if (window.GlobalScope && GlobalScope.active()) list = list.filter(function (r) { return GlobalScope.match(r.territory); });

    // Same role scoping as the rest of the dashboard
    var u = window.currentUser;
    if (u && u.role) {
      if (u.role === 'so') list = list.filter(function (r) { return r.so_name === u.username; });
      else if (u.role === 'eo') list = list.filter(function (r) { return r.eo_name === u.username; });
      else if (u.role === 'vendor') list = list.filter(function (r) { return r.vendor === u.username; });
    }
    return { list: list, limited: limited };
  }

  function statusOf(ro) { return S.basis === 'colv' ? ro.colv_status : ro.eq_status; }

  function inSet(arr, v) { return !arr || !arr.length || arr.indexOf(v) !== -1; }
  function applyFilters(list) {
    var f = S.filters;
    return list.filter(function (r) {
      return inSet(f.area, r.sales_area) && inSet(f.te, r.eo_name) && inSet(f.vendor, r.vendor);
    });
  }

  function emptyAgg(key) {
    return { key: key, total: 0, fully: 0, partial: 0, offline: 0, onb_mpd: 0, onl_mpd: 0, onb_tnk: 0, onl_tnk: 0,
      autoRsp: 0, iot: 0, mpdPctSum: 0, mpdPctN: 0, tnkPctSum: 0, tnkPctN: 0, hasEquip: false };
  }
  function addAgg(a, ro) {
    a.total++;
    var st = statusOf(ro);
    if (st === 'Fully Online') a.fully++; else if (st === 'Partially Online') a.partial++; else a.offline++;
    if (ro.full) {
      a.hasEquip = true;
      a.onb_mpd += ro.onb_mpd; a.onl_mpd += ro.onl_mpd; a.onb_tnk += ro.onb_tnk; a.onl_tnk += ro.onl_tnk;
    }
    if (/^yes$/i.test(ro.auto_rsp)) a.autoRsp++;
    if (ro.iot_status === 'IOT') a.iot++;
    if (ro.mpd_pct != null && ro.mpd_pct >= 0 && ro.mpd_pct <= 1) { a.mpdPctSum += ro.mpd_pct; a.mpdPctN++; }
    if (ro.tank_pct != null && ro.tank_pct >= 0 && ro.tank_pct <= 1) { a.tnkPctSum += ro.tank_pct; a.tnkPctN++; }
  }
  function finAgg(a) {
    var eq = a.hasEquip;
    a.mpdUp = eq ? ratio(a.onl_mpd, a.onb_mpd) : null;
    a.tnkUp = eq ? ratio(a.onl_tnk, a.onb_tnk) : null;
    a.uptime = eq ? ratio(a.onl_mpd + a.onl_tnk, a.onb_mpd + a.onb_tnk) : null;
    a.off_mpd = eq ? Math.max(0, a.onb_mpd - a.onl_mpd) : null;
    a.off_tnk = eq ? Math.max(0, a.onb_tnk - a.onl_tnk) : null;
    a.mpd2 = a.mpdPctN ? a.mpdPctSum / a.mpdPctN : null;
    a.tnk2 = a.tnkPctN ? a.tnkPctSum / a.tnkPctN : null;
    a.fullyPct = ratio(a.fully, a.total);
    return a;
  }
  function aggregate(list, keyFn) {
    var map = {};
    list.forEach(function (ro) {
      var k = keyFn(ro) || 'Unmapped';
      if (!map[k]) map[k] = emptyAgg(k);
      addAgg(map[k], ro);
    });
    return Object.keys(map).map(function (k) { return finAgg(map[k]); })
      .sort(function (a, b) {
        if (a.key === 'Unmapped') return 1;
        if (b.key === 'Unmapped') return -1;
        return a.key.localeCompare(b.key);
      });
  }
  function totalAgg(list) {
    var a = emptyAgg('Grand Total');
    list.forEach(function (ro) { addAgg(a, ro); });
    return finAgg(a);
  }

  /** {roid: status} for a history record (cached), honouring role + filters + basis. */
  function statusMapFor(rec) {
    var ck = rec.id + '|' + S.basis + '|' + (window.GlobalScope ? GlobalScope.get().join(',') : '') + '|' + S.filters.area.join(',') + '|' + S.filters.te.join(',') + '|' + S.filters.vendor.join(',');
    if (S.statusCache[ck]) return S.statusCache[ck];
    var out = {};
    applyFilters(computeROs(rec.rawData).list).forEach(function (ro) { out[ro.roid] = statusOf(ro); });
    S.statusCache[ck] = out;
    return out;
  }

  /** Consecutive Day-Ends (ending on the report date) the RO had the given status. */
  function streak(roid, status, reportDate, todayStatus) {
    if (todayStatus !== status) return 0;
    var n = 1;
    for (var i = 0; i < S.dates.length; i++) {
      var d = S.dates[i];
      if (d >= reportDate) continue;
      var st = statusMapFor(S.byDate[d][0])[roid];
      if (st === status) n++; else break;
    }
    return n;
  }

  function remarkFor(roid) {
    var shared = (typeof window.getSharedDayData === 'function') ? (window.getSharedDayData(roid) || {}) : {};
    if (!shared.responsibility && !shared.remark) {
      try {
        var ls = JSON.parse(localStorage.getItem('day_remarks_' + roid) || 'null');
        if (ls) shared = ls;
      } catch (e) { /* ignore */ }
    }
    return { responsibility: shared.responsibility || '', remark: shared.remark || '' };
  }

  function buildReport() {
    var snap = getSnapshot(S.reportKey);
    if (!snap) return null;
    var cur = computeROs(snap.rawData);
    var list = applyFilters(cur.list);

    var prevSnap = S.compareKey ? getSnapshot(S.compareKey) : null;
    var prevList = [], prevLimited = false;
    if (prevSnap) {
      var p = computeROs(prevSnap.rawData);
      prevList = applyFilters(p.list);
      prevLimited = p.limited;
    }
    var prevById = {};
    prevList.forEach(function (r) { prevById[r.roid] = r; });

    var areaPrev = {}, tePrev = {}, soPrev = {}, venPrev = {};
    if (prevSnap) {
      aggregate(prevList, function (r) { return r.sales_area; }).forEach(function (a) { areaPrev[a.key] = a; });
      aggregate(prevList, function (r) { return r.eo_name; }).forEach(function (a) { tePrev[a.key] = a; });
      aggregate(prevList, function (r) { return r.so_name; }).forEach(function (a) { soPrev[a.key] = a; });
      aggregate(prevList, function (r) { return r.vendor; }).forEach(function (a) { venPrev[a.key] = a; });
    }
    function attachPrev(rows, prevMap) {
      rows.forEach(function (a) { a.prev = prevMap[a.key] || null; });
      return rows;
    }

    // RO-level enrichment
    list.forEach(function (ro) {
      var st = statusOf(ro);
      var pr = prevById[ro.roid];
      ro.status = st;
      ro.prev_status = pr ? statusOf(pr) : (prevSnap ? 'Not in data' : '');
      ro.prev_uptime = pr ? pr.uptime : null;
      ro.change = '';
      if (pr) {
        var d = STATUS_RANK[st] - STATUS_RANK[ro.prev_status];
        ro.change = d < 0 ? 'Drop' : d > 0 ? 'Improvement' : 'No change';
      } else if (prevSnap) {
        ro.change = 'New';
      }
      ro.off_days = st === 'Offline' ? streak(ro.roid, 'Offline', snap.date, st) : 0;
      var rm = remarkFor(ro.roid);
      ro.responsibility = rm.responsibility;
      ro.remark = rm.remark;
    });

    var sortExc = function (a, b) {
      return (a.sales_area || '').localeCompare(b.sales_area || '') || (b.off_days - a.off_days) || a.roid.localeCompare(b.roid);
    };
    var curIds = {};
    list.forEach(function (r) { curIds[r.roid] = 1; });
    var removed = prevList.filter(function (r) { return !curIds[r.roid]; });

    var total = totalAgg(list);
    var prevTotal = prevSnap ? totalAgg(prevList) : null;
    total.prev = prevTotal;

    return {
      snap: snap,
      prevSnap: prevSnap,
      limited: cur.limited,
      prevLimited: prevLimited,
      list: list,
      total: total,
      prevTotal: prevTotal,
      areas: attachPrev(aggregate(list, function (r) { return r.sales_area; }), areaPrev),
      tes: attachPrev(aggregate(list, function (r) { return r.eo_name; }), tePrev),
      sos: attachPrev(aggregate(list, function (r) { return r.so_name; }), soPrev),
      vendors: attachPrev(aggregate(list, function (r) { return r.vendor; }), venPrev),
      offline: list.filter(function (r) { return r.status === 'Offline'; }).sort(sortExc),
      partial: list.filter(function (r) { return r.status === 'Partially Online'; }).sort(sortExc),
      drops: list.filter(function (r) { return r.change === 'Drop'; }).sort(sortExc),
      improvements: list.filter(function (r) { return r.change === 'Improvement'; }).sort(sortExc),
      added: list.filter(function (r) { return r.change === 'New'; }),
      removed: removed,
      generatedAt: new Date(),
      generatedBy: (window.currentUser && (window.currentUser.username || window.currentUser.role)) || 'User',
      basisLabel: S.basis === 'colv' ? "Column V (RO's Online)" : 'Equipment count (MPD + ATG)',
      filterLabel: [window.GlobalScope && GlobalScope.active() && ('Territory: ' + GlobalScope.get().join(', ')), S.filters.area.length && ('Sales Area: ' + S.filters.area.join(', ')), S.filters.te.length && ('TE: ' + S.filters.te.join(', ')),
        S.filters.vendor.length && ('Vendor: ' + S.filters.vendor.join(', '))].filter(Boolean).join(' · ') || 'All outlets'
    };
  }

  /* ------------------------------------------------------------- controls */
  function snapshotLabel(rec, isDayEnd) {
    return fmtTime(rec.time) + (isDayEnd ? ' · Day End' : '') + ' · ' + (rec.filename || 'snapshot');
  }

  function fillSelect(sel, options, value) {
    if (!sel) return;
    sel.innerHTML = options.map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (o.disabled ? ' disabled' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
    if (value != null && options.some(function (o) { return String(o.value) === String(value); })) sel.value = value;
  }

  function currentDate() {
    var sel = $('dem-date');
    return sel ? sel.value : '';
  }

  function renderDateOptions() {
    var opts = [];
    if (hasLive()) opts.push({ value: LIVE_ID, label: 'Live · currently loaded data (' + fmtDate(todayStr()) + ')' });
    S.dates.forEach(function (d) {
      var n = S.byDate[d].length;
      opts.push({ value: d, label: fmtDate(d) + '  (' + n + ' snapshot' + (n > 1 ? 's' : '') + ')' });
    });
    if (!opts.length) opts.push({ value: '', label: 'No data available', disabled: true });
    var prev = currentDate();
    fillSelect($('dem-date'), opts, prev || (S.dates[0] || (hasLive() ? LIVE_ID : '')));
  }

  function renderSnapshotOptions() {
    var d = currentDate();
    var sel = $('dem-snapshot');
    if (!sel) return;
    if (d === LIVE_ID || !d) {
      fillSelect(sel, [{ value: LIVE_ID, label: 'Current dashboard data' }], LIVE_ID);
      sel.disabled = true;
      S.reportKey = d ? LIVE_ID : '';
      return;
    }
    sel.disabled = false;
    var recs = S.byDate[d] || [];
    fillSelect(sel, recs.map(function (r, i) { return { value: r.id, label: snapshotLabel(r, i === 0) }; }),
      recs.some(function (r) { return String(r.id) === String(S.reportKey); }) ? S.reportKey : (recs[0] && recs[0].id));
    S.reportKey = sel.value;
  }

  function renderCompareOptions(autoPick) {
    var sel = $('dem-compare');
    if (!sel) return;
    var d = currentDate() === LIVE_ID ? todayStr() : currentDate();
    var opts = [{ value: '', label: 'No comparison' }];
    S.dates.forEach(function (dt) {
      var recs = S.byDate[dt];
      recs.forEach(function (r, i) {
        if (String(r.id) === String(S.reportKey)) return;
        if (dt > d) return;
        opts.push({ value: r.id, label: fmtDate(dt) + ' · ' + fmtTime(r.time) + (i === 0 ? ' (Day End)' : '') });
      });
    });
    var pick = S.compareKey;
    if (autoPick || !opts.some(function (o) { return String(o.value) === String(pick); })) {
      var pd = previousDayEnd(d);
      pick = pd ? pd.id : '';
    }
    fillSelect(sel, opts, pick);
    S.compareKey = sel.value;
  }

  function renderFilterOptions() {
    var snap = getSnapshot(S.reportKey);
    var list = snap ? computeROs(snap.rawData).list : [];
    function uniq(fn) {
      var seen = {};
      list.forEach(function (r) { seen[fn(r) || 'Unmapped'] = 1; });
      return Object.keys(seen).sort();
    }
    var f = S.filters;
    function fillMulti(id, label, values, keep) {
      var sel = $(id);
      if (!sel) return [];
      sel.innerHTML = '<option value="">' + esc(label) + '</option>' + values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
      var kept = keep.filter(function (v) { return values.indexOf(v) !== -1; });
      if (window.MS) MS.set(sel, kept); else sel.value = kept[0] || '';
      return kept;
    }
    f.area = fillMulti('dem-f-area', 'All sales areas', uniq(function (r) { return r.sales_area; }), f.area);
    f.te = fillMulti('dem-f-te', 'All TEs', uniq(function (r) { return r.eo_name; }), f.te);
    f.vendor = fillMulti('dem-f-vendor', 'All vendors', uniq(function (r) { return r.vendor; }), f.vendor);
  }

  /* -------------------------------------------------------------- preview */
  function statusPill(st) {
    var cls = st === 'Fully Online' ? 'ok' : st === 'Partially Online' ? 'warn' : st === 'Offline' ? 'bad' : 'muted';
    return '<span class="dem-pill dem-pill-' + cls + '">' + esc(st || '—') + '</span>';
  }
  function changePill(c) {
    if (!c) return '—';
    var cls = c === 'Drop' ? 'bad' : c === 'Improvement' ? 'ok' : c === 'New' ? 'info' : 'muted';
    var arrow = c === 'Drop' ? '▼ ' : c === 'Improvement' ? '▲ ' : '';
    return '<span class="dem-pill dem-pill-' + cls + '">' + arrow + esc(c) + '</span>';
  }
  function deltaChip(val, prev, opts) {
    opts = opts || {};
    if (prev == null || val == null) return '';
    var d = opts.pp ? deltaPP(val, prev) : (val - prev);
    if (!isFinite(d)) return '';
    var good = opts.lowerIsBetter ? d < 0 : d > 0;
    var cls = Math.abs(d) < (opts.pp ? 0.05 : 0.5) ? 'flat' : good ? 'up' : 'down';
    var txt = opts.pp ? signed(d, 1, ' pp') : signed(d, 0);
    return '<span class="dem-delta dem-delta-' + cls + '">' + txt + '</span>';
  }

  function renderKPIs(R) {
    var t = R.total, p = R.prevTotal;
    var cards = [
      { label: 'Total ROs', val: t.total, prev: p && p.total, fmt: String, tone: 'navy' },
      { label: 'Fully Online', val: t.fully, prev: p && p.fully, fmt: String, tone: 'ok', sub: pct(t.fullyPct) + ' of ROs' },
      { label: 'Partially Online', val: t.partial, prev: p && p.partial, fmt: String, tone: 'warn', lower: true },
      { label: 'Offline', val: t.offline, prev: p && p.offline, fmt: String, tone: 'bad', lower: true },
      { label: 'Overall Uptime', val: t.uptime, prev: p && p.uptime, fmt: pct, pp: true, tone: 'info', sub: 'MPD + ATG units' },
      { label: 'MPD Uptime', val: t.mpdUp, prev: p && p.mpdUp, fmt: pct, pp: true, tone: 'info', sub: t.hasEquip ? (t.onl_mpd + ' / ' + t.onb_mpd + ' online') : '' },
      { label: 'ATG Uptime', val: t.tnkUp, prev: p && p.tnkUp, fmt: pct, pp: true, tone: 'info', sub: t.hasEquip ? (t.onl_tnk + ' / ' + t.onb_tnk + ' online') : '' },
      { label: '2-Slot Uptime', val: (t.mpd2 != null && t.tnk2 != null) ? (t.mpd2 + t.tnk2) / 2 : (t.mpd2 != null ? t.mpd2 : t.tnk2), prev: p && ((p.mpd2 != null && p.tnk2 != null) ? (p.mpd2 + p.tnk2) / 2 : null), fmt: pct, pp: true, tone: 'info', sub: 'MPD ' + pct(t.mpd2) + ' · ATG ' + pct(t.tnk2) }
    ];
    $('dem-kpis').innerHTML = cards.map(function (c) {
      return '<div class="dem-kpi dem-tone-' + c.tone + '">' +
        '<div class="dem-kpi-label">' + esc(c.label) + '</div>' +
        '<div class="dem-kpi-value">' + esc(c.val == null ? '—' : c.fmt(c.val)) + deltaChip(c.val, c.prev, { pp: c.pp, lowerIsBetter: c.lower }) + '</div>' +
        (c.sub ? '<div class="dem-kpi-sub">' + esc(c.sub) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderMeta(R) {
    var s = R.snap, p = R.prevSnap;
    var html = '<div class="dem-meta-item"><span>Report</span><b>' + esc(fmtDate(s.date)) + ' · ' + esc(fmtTime(s.time)) + (s.live ? ' (live)' : '') + '</b></div>' +
      '<div class="dem-meta-item"><span>Compared with</span><b>' + (p ? esc(fmtDate(p.date) + ' · ' + fmtTime(p.time)) : 'None') + '</b></div>' +
      '<div class="dem-meta-item"><span>Status basis</span><b>' + esc(R.basisLabel) + '</b></div>' +
      '<div class="dem-meta-item"><span>Scope</span><b>' + esc(R.filterLabel) + '</b></div>' +
      '<div class="dem-meta-item dem-meta-wide"><span>Source</span><b title="' + esc(s.filename || '') + '">' + esc(s.filename || '—') + '</b></div>';
    $('dem-meta').innerHTML = html;
    var warn = [];
    if (R.limited) warn.push('This snapshot was restored from the Google Sheet history archive and only carries RO status — MPD/ATG counts and uptime % are not available for it.');
    if (R.prevLimited) warn.push('The comparison snapshot only carries RO status, so uptime deltas are not shown.');
    if (!R.prevSnap && S.dates.length < 2 && !R.snap.live) warn.push('Only one day of history is stored, so day-on-day changes cannot be calculated yet.');
    $('dem-warn').innerHTML = warn.map(function (w) { return '<div class="dem-note">' + esc(w) + '</div>'; }).join('');
  }

  var SUMMARY_COLS = [
    { h: 'Total ROs', f: function (a) { return a.total; } },
    { h: 'Fully Online', f: function (a) { return a.fully; } },
    { h: 'Partial', f: function (a) { return a.partial; } },
    { h: 'Offline', f: function (a) { return a.offline; } },
    { h: 'MPD Uptime', f: function (a) { return pct(a.mpdUp); } },
    { h: 'ATG Uptime', f: function (a) { return pct(a.tnkUp); } },
    { h: 'Overall Uptime', f: function (a) { return '<b>' + pct(a.uptime) + '</b>' + deltaChip(a.uptime, a.prev && a.prev.uptime, { pp: true }); }, html: true },
    { h: 'Offline MPDs', f: function (a) { return a.off_mpd == null ? '—' : a.off_mpd; } },
    { h: 'Offline ATGs', f: function (a) { return a.off_tnk == null ? '—' : a.off_tnk; } }
  ];

  function summaryTable(rows, total, firstCol) {
    var head = '<tr><th class="dem-sticky">' + esc(firstCol) + '</th>' + SUMMARY_COLS.map(function (c) { return '<th class="num">' + esc(c.h) + '</th>'; }).join('') + '</tr>';
    function tr(a, isTotal) {
      return '<tr' + (isTotal ? ' class="dem-total"' : '') + '><td class="dem-sticky">' + esc(a.key) + '</td>' +
        SUMMARY_COLS.map(function (c) { var v = c.f(a); return '<td class="num">' + (c.html ? v : esc(v)) + '</td>'; }).join('') + '</tr>';
    }
    var body = rows.map(function (a) { return tr(a, false); }).join('') + tr(total, true);
    return '<div class="dem-table-wrap"><table class="dem-table dem-summary-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  function roCards(list, kind) {
    if (!list.length) return '<div class="dem-empty-inline">No outlets in this list. 🎉</div>';
    var showOff = kind === 'offline';
    var head = '<tr><th>RO ID</th><th>Outlet</th><th>Sales Area</th><th>TE</th><th>SO</th><th>Vendor</th>' +
      '<th class="num">MPD</th><th class="num">ATG</th><th>Status</th><th>Prev Day</th>' + (showOff ? '<th class="num">Off Days</th>' : '') + '<th>Responsibility / Remark</th></tr>';
    var rows = list.map(function (r) {
      var mpd = r.full ? (r.onl_mpd + '/' + r.onb_mpd) : '—';
      var atg = r.full ? (r.onl_tnk + '/' + r.onb_tnk) : '—';
      var rem = [r.responsibility, r.remark].filter(Boolean).join(' · ') || '—';
      return '<tr>' +
        '<td data-label="RO ID"><b>' + esc(r.roid) + '</b></td>' +
        '<td data-label="Outlet" class="dem-cell-name">' + esc(r.outlet_name) + '</td>' +
        '<td data-label="Sales Area">' + esc(r.sales_area) + '</td>' +
        '<td data-label="TE">' + esc(r.eo_name) + '</td>' +
        '<td data-label="SO">' + esc(r.so_name) + '</td>' +
        '<td data-label="Vendor">' + esc(r.vendor) + '</td>' +
        '<td data-label="MPD online" class="num">' + esc(mpd) + '</td>' +
        '<td data-label="ATG online" class="num">' + esc(atg) + '</td>' +
        '<td data-label="Status">' + statusPill(r.status) + '</td>' +
        '<td data-label="Prev Day">' + (r.prev_status ? statusPill(r.prev_status) : '—') + '</td>' +
        (showOff ? '<td data-label="Off days" class="num">' + (r.off_days || '—') + '</td>' : '') +
        '<td data-label="Remark" class="dem-cell-remark">' + esc(rem) + '</td>' +
        '</tr>';
    }).join('');
    return '<div class="dem-table-wrap dem-cardable"><table class="dem-table dem-ro-table"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>';
  }

  function changeTable(R) {
    if (!R.prevSnap) return '<div class="dem-empty-inline">Pick a comparison snapshot to see drops and improvements.</div>';
    var rows = R.drops.concat(R.improvements);
    if (!rows.length && !R.added.length && !R.removed.length) return '<div class="dem-empty-inline">No status changes between the two snapshots.</div>';
    var head = '<tr><th>Change</th><th>RO ID</th><th>Outlet</th><th>Sales Area</th><th>TE</th><th>Vendor</th><th>Previous</th><th>Current</th><th class="num">Uptime (prev → now)</th></tr>';
    var body = rows.map(function (r) {
      return '<tr>' +
        '<td data-label="Change">' + changePill(r.change) + '</td>' +
        '<td data-label="RO ID"><b>' + esc(r.roid) + '</b></td>' +
        '<td data-label="Outlet" class="dem-cell-name">' + esc(r.outlet_name) + '</td>' +
        '<td data-label="Sales Area">' + esc(r.sales_area) + '</td>' +
        '<td data-label="TE">' + esc(r.eo_name) + '</td>' +
        '<td data-label="Vendor">' + esc(r.vendor) + '</td>' +
        '<td data-label="Previous">' + statusPill(r.prev_status) + '</td>' +
        '<td data-label="Current">' + statusPill(r.status) + '</td>' +
        '<td data-label="Uptime" class="num">' + pct(r.prev_uptime, 0) + ' → ' + pct(r.uptime, 0) + '</td>' +
        '</tr>';
    }).join('');
    var extra = '';
    if (R.added.length) extra += '<div class="dem-note">' + R.added.length + ' RO(s) appear only in the current snapshot: ' + esc(R.added.slice(0, 12).map(function (r) { return r.roid; }).join(', ')) + (R.added.length > 12 ? '…' : '') + '</div>';
    if (R.removed.length) extra += '<div class="dem-note">' + R.removed.length + ' RO(s) were in the previous snapshot but are missing now: ' + esc(R.removed.slice(0, 12).map(function (r) { return r.roid; }).join(', ')) + (R.removed.length > 12 ? '…' : '') + '</div>';
    return (rows.length ? '<div class="dem-table-wrap dem-cardable"><table class="dem-table dem-ro-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' : '') + extra;
  }

  function renderView() {
    var R = S.report;
    if (!R) return;
    var counts = {
      summary: R.areas.length, te: R.tes.length, so: R.sos.length, vendor: R.vendors.length,
      offline: R.offline.length, partial: R.partial.length, changes: R.drops.length + R.improvements.length
    };
    document.querySelectorAll('#dem-views button').forEach(function (b) {
      var v = b.getAttribute('data-view');
      b.classList.toggle('is-on', v === S.view);
      b.setAttribute('aria-selected', v === S.view ? 'true' : 'false');
      var c = b.querySelector('.dem-count');
      if (c) c.textContent = counts[v] != null ? counts[v] : '';
    });
    var html = '';
    switch (S.view) {
      case 'te': html = summaryTable(R.tes, R.total, 'Territory Engineer'); break;
      case 'so': html = summaryTable(R.sos, R.total, 'Sales Officer'); break;
      case 'vendor': html = summaryTable(R.vendors, R.total, 'Vendor'); break;
      case 'offline': html = roCards(R.offline, 'offline'); break;
      case 'partial': html = roCards(R.partial, 'partial'); break;
      case 'changes': html = changeTable(R); break;
      default: html = summaryTable(R.areas, R.total, 'Sales Area');
    }
    $('dem-view-body').innerHTML = html;
  }

  function setState(state, msg) {
    var empty = $('dem-empty'), body = $('dem-report');
    if (state === 'empty') {
      empty.style.display = '';
      body.style.display = 'none';
      if (msg) $('dem-empty-msg').innerHTML = msg;
    } else {
      empty.style.display = 'none';
      body.style.display = '';
    }
    ['dem-btn-xlsx', 'dem-btn-share', 'dem-btn-wa', 'dem-btn-print'].forEach(function (id) {
      var b = $(id); if (b) b.disabled = state === 'empty';
    });
  }

  function recompute() {
    S.statusCache = {};
    S.report = buildReport();
    if (!S.report) {
      setState('empty', S.dates.length || hasLive()
        ? 'Select a report date to build the Day End MIS.'
        : 'No automation data yet. Upload the day\'s uptime Excel or use <b>Sync Sheet</b> — every upload is stored as a snapshot and the last one of each day becomes that day\'s <b>Day End</b>.');
      return;
    }
    setState('ready');
    renderMeta(S.report);
    renderKPIs(S.report);
    renderView();
  }

  /* --------------------------------------------------------- Excel export */
  function setCols(ws, widths) { ws['!cols'] = widths.map(function (w) { return { wch: w }; }); }
  function fmtRange(ws, r0, r1, c0, c1, z) {
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) {
      var cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
      if (cell && cell.t === 'n') cell.z = z;
    }
  }
  function titleBlock(R, title) {
    var s = R.snap;
    return [
      ['Bharat Petroleum Corporation Ltd. — ' + TERRITORY],
      [title],
      ['Report: ' + fmtDate(s.date) + ' ' + fmtTime(s.time) + (s.live ? ' (live data)' : ' (Day End snapshot)') +
        (R.prevSnap ? '   |   Compared with: ' + fmtDate(R.prevSnap.date) + ' ' + fmtTime(R.prevSnap.time) : '') +
        '   |   Basis: ' + R.basisLabel + '   |   Scope: ' + R.filterLabel],
      []
    ];
  }
  function sheetFromBlock(R, title, header, rows, opts) {
    opts = opts || {};
    var top = titleBlock(R, title);
    var aoa = top.concat([header], rows);
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var hr = top.length; // header row index
    var lastCol = header.length - 1;
    ws['!merges'] = [0, 1, 2].map(function (r) { return { s: { r: r, c: 0 }, e: { r: r, c: Math.max(lastCol, 5) } }; });
    if (rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: hr, c: 0 }, e: { r: hr + rows.length, c: lastCol } }) };
    (opts.pctCols || []).forEach(function (c) { fmtRange(ws, hr + 1, hr + rows.length, c, c, '0.0%'); });
    (opts.ppCols || []).forEach(function (c) { fmtRange(ws, hr + 1, hr + rows.length, c, c, '+0.0;-0.0;0.0'); });
    if (opts.widths) setCols(ws, opts.widths);
    return ws;
  }

  function summarySheetRows(rows, total) {
    var out = rows.concat([total]).map(function (a) {
      return [a.key, a.total, a.fully, a.partial, a.offline,
        a.hasEquip ? a.onb_mpd : null, a.hasEquip ? a.onl_mpd : null, a.mpdUp,
        a.hasEquip ? a.onb_tnk : null, a.hasEquip ? a.onl_tnk : null, a.tnkUp,
        a.uptime, a.prev ? a.prev.uptime : null,
        (a.prev && a.prev.uptime != null && a.uptime != null) ? +((a.uptime - a.prev.uptime) * 100).toFixed(2) : null,
        a.mpd2, a.tnk2, a.off_mpd, a.off_tnk];
    });
    return out;
  }
  var SUMMARY_HEADER = ['Name', 'Total ROs', 'Fully Online', 'Partially Online', 'Offline', 'Onbd MPDs', 'Online MPDs', 'MPD Uptime %',
    'Onbd ATGs', 'Online ATGs', 'ATG Uptime %', 'Overall Uptime %', 'Prev Overall Uptime %', 'Change (pp)', 'MPD 2-Slot %', 'ATG 2-Slot %', 'Offline MPDs', 'Offline ATGs'];
  var SUMMARY_WIDTHS = [30, 10, 12, 15, 9, 11, 12, 13, 11, 12, 13, 15, 19, 12, 13, 13, 12, 12];

  function addSummarySheet(wb, R, name, title, firstCol, rows) {
    var total = R.total;
    var hdr = SUMMARY_HEADER.slice(); hdr[0] = firstCol;
    var ws = sheetFromBlock(R, title, hdr, summarySheetRows(rows, total), { pctCols: [7, 10, 11, 12, 14, 15], ppCols: [13], widths: SUMMARY_WIDTHS });
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  function roRow(r, extra) {
    return [Number(r.roid) || r.roid, r.outlet_name, r.sales_area, r.eo_name, r.so_name, r.vendor,
      r.onb_mpd, r.onl_mpd, r.off_mpd, r.onb_tnk, r.onl_tnk, r.off_tnk, r.uptime, r.status, r.nano_status, r.prev_status || ''].concat(extra || []);
  }
  var RO_HEADER = ['RO ID', 'Retail Outlet', 'Sales Area', 'TE', 'SO', 'Vendor', 'Onbd MPDs', 'Online MPDs', 'Offline MPDs',
    'Onbd ATGs', 'Online ATGs', 'Offline ATGs', 'Equipment Uptime %', 'Status', 'NANO Status', 'Previous Day Status'];
  var RO_WIDTHS = [10, 32, 18, 22, 22, 14, 10, 11, 11, 10, 11, 11, 17, 16, 26, 18];

  function buildWorkbook(R, sheets) {
    var wb = XLSX.utils.book_new();
    wb.Props = { Title: 'Automation Day End MIS ' + R.snap.date, Subject: 'BPCL ' + TERRITORY, Author: R.generatedBy, CreatedDate: new Date() };
    var t = R.total, p = R.prevTotal;

    // 1. Summary
    if (sheets.summary) {
      var top = titleBlock(R, 'AUTOMATION DAY END MIS — EXECUTIVE SUMMARY');
      var hdr = ['Metric', 'Day End ' + fmtDate(R.snap.date), p ? 'Previous ' + fmtDate(R.prevSnap.date) : 'Previous', 'Change'];
      function line(label, a, b, kind) {
        var ch = null;
        if (a != null && b != null) ch = kind === 'pct' ? +((a - b) * 100).toFixed(2) : a - b;
        return { row: [label, a, b, ch], kind: kind };
      }
      var two = function (x) { return x ? ((x.mpd2 != null && x.tnk2 != null) ? (x.mpd2 + x.tnk2) / 2 : null) : null; };
      var lines = [
        line('Total ROs', t.total, p && p.total, 'n'),
        line('Fully Online ROs', t.fully, p && p.fully, 'n'),
        line('Partially Online ROs', t.partial, p && p.partial, 'n'),
        line('Offline ROs', t.offline, p && p.offline, 'n'),
        line('Fully Online % of ROs', t.fullyPct, p && p.fullyPct, 'pct'),
        line('Onboarded MPDs', t.hasEquip ? t.onb_mpd : null, p && p.hasEquip ? p.onb_mpd : null, 'n'),
        line('Online MPDs', t.hasEquip ? t.onl_mpd : null, p && p.hasEquip ? p.onl_mpd : null, 'n'),
        line('MPD Uptime %', t.mpdUp, p && p.mpdUp, 'pct'),
        line('Onboarded ATGs (Tanks)', t.hasEquip ? t.onb_tnk : null, p && p.hasEquip ? p.onb_tnk : null, 'n'),
        line('Online ATGs (Tanks)', t.hasEquip ? t.onl_tnk : null, p && p.hasEquip ? p.onl_tnk : null, 'n'),
        line('ATG Uptime %', t.tnkUp, p && p.tnkUp, 'pct'),
        line('Overall Equipment Uptime %', t.uptime, p && p.uptime, 'pct'),
        line('MPD 2-Slot Uptime %', t.mpd2, p && p.mpd2, 'pct'),
        line('ATG 2-Slot Uptime %', t.tnk2, p && p.tnk2, 'pct'),
        line('Average 2-Slot Uptime %', two(t), two(p), 'pct'),
        line('Auto RSP ROs', t.autoRsp, p && p.autoRsp, 'n'),
        line('IOT ROs', t.iot, p && p.iot, 'n')
      ];
      var aoa = top.concat([hdr], lines.map(function (l) { return l.row; }));
      aoa.push([]);
      aoa.push(['Day-on-day movement', 'Count']);
      aoa.push(['Status drops', R.prevSnap ? R.drops.length : null]);
      aoa.push(['Status improvements', R.prevSnap ? R.improvements.length : null]);
      aoa.push(['Offline 3+ consecutive day-ends', R.offline.filter(function (r) { return r.off_days >= 3; }).length]);
      aoa.push([]);
      aoa.push(['Source file', R.snap.filename || '']);
      aoa.push(['Generated', R.generatedAt.toLocaleString('en-IN') + ' by ' + R.generatedBy]);
      aoa.push(['Notes', 'Equipment uptime = online units ÷ onboarded units. 2-slot uptime = average of row-level MPD / ATG online % columns. ' +
        'Day End = last snapshot stored for the date. Off-days count consecutive Day-End snapshots.']);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      var hr = top.length;
      lines.forEach(function (l, i) {
        var r = hr + 1 + i;
        if (l.kind === 'pct') {
          fmtRange(ws, r, r, 1, 2, '0.0%');
          fmtRange(ws, r, r, 3, 3, '+0.0" pp";-0.0" pp";0.0" pp"');
        } else {
          fmtRange(ws, r, r, 3, 3, '+0;-0;0');
        }
      });
      ws['!merges'] = [0, 1, 2].map(function (r) { return { s: { r: r, c: 0 }, e: { r: r, c: 5 } }; })
        .concat([{ s: { r: aoa.length - 1, c: 1 }, e: { r: aoa.length - 1, c: 5 } }]);
      setCols(ws, [34, 22, 22, 14, 14, 14]);
      XLSX.utils.book_append_sheet(wb, ws, 'MIS Summary');
    }

    if (sheets.area) addSummarySheet(wb, R, 'Sales Area', 'SALES AREA WISE UPTIME', 'Sales Area', R.areas);
    if (sheets.te) addSummarySheet(wb, R, 'TE Wise', 'TERRITORY ENGINEER WISE UPTIME', 'Territory Engineer', R.tes);
    if (sheets.so) addSummarySheet(wb, R, 'SO Wise', 'SALES OFFICER WISE UPTIME', 'Sales Officer', R.sos);
    if (sheets.vendor) addSummarySheet(wb, R, 'Vendor Wise', 'AUTOMATION VENDOR WISE UPTIME', 'Vendor', R.vendors);

    if (sheets.offline) {
      var hdrO = RO_HEADER.concat(['Offline Days (consecutive Day-Ends)', 'Responsibility', 'Remark']);
      var wsO = sheetFromBlock(R, 'OFFLINE OUTLETS — ' + R.offline.length, hdrO,
        R.offline.map(function (r) { return roRow(r, [r.off_days, r.responsibility, r.remark]); }),
        { pctCols: [12], widths: RO_WIDTHS.concat([20, 22, 40]) });
      XLSX.utils.book_append_sheet(wb, wsO, 'Offline ROs');
    }
    if (sheets.partial) {
      var hdrP = RO_HEADER.concat(['Responsibility', 'Remark']);
      var wsP = sheetFromBlock(R, 'PARTIALLY ONLINE OUTLETS — ' + R.partial.length, hdrP,
        R.partial.map(function (r) { return roRow(r, [r.responsibility, r.remark]); }),
        { pctCols: [12], widths: RO_WIDTHS.concat([22, 40]) });
      XLSX.utils.book_append_sheet(wb, wsP, 'Partial ROs');
    }
    if (sheets.changes && R.prevSnap) {
      var chRows = R.drops.concat(R.improvements, R.added).map(function (r) {
        return [r.change, Number(r.roid) || r.roid, r.outlet_name, r.sales_area, r.eo_name, r.so_name, r.vendor, r.prev_status, r.status, r.prev_uptime, r.uptime,
          (r.prev_uptime != null && r.uptime != null) ? +((r.uptime - r.prev_uptime) * 100).toFixed(2) : null];
      }).concat(R.removed.map(function (r) {
        return ['Missing now', Number(r.roid) || r.roid, r.outlet_name, r.sales_area, r.eo_name, r.so_name, r.vendor, statusOf(r), 'Not in data', r.uptime, null, null];
      }));
      var wsC = sheetFromBlock(R, 'DAY-ON-DAY STATUS CHANGES — ' + R.drops.length + ' drops, ' + R.improvements.length + ' improvements',
        ['Change', 'RO ID', 'Retail Outlet', 'Sales Area', 'TE', 'SO', 'Vendor', 'Previous Status', 'Current Status', 'Prev Uptime %', 'Current Uptime %', 'Change (pp)'],
        chRows, { pctCols: [9, 10], ppCols: [11], widths: [13, 10, 32, 18, 22, 22, 14, 18, 18, 13, 15, 12] });
      XLSX.utils.book_append_sheet(wb, wsC, 'Day-on-Day Changes');
    }
    if (sheets.detail) {
      var hdrD = RO_HEADER.concat(["RO's Online (Col V)", 'MPD Online % (2-slot)', 'ATG Online % (2-slot)', 'Avg RO Online %', 'Auto RSP', 'IOT / WFCC', 'Change vs Prev', 'Offline Days', 'Responsibility', 'Remark']);
      var detail = R.list.slice().sort(function (a, b) { return (a.sales_area || '').localeCompare(b.sales_area || '') || a.roid.localeCompare(b.roid); });
      var wsD = sheetFromBlock(R, 'RO WISE DETAIL — ' + detail.length + ' outlets', hdrD,
        detail.map(function (r) { return roRow(r, [r.colv_status, r.mpd_pct, r.tank_pct, r.avg_pct, r.auto_rsp, r.iot_status, r.change, r.off_days || null, r.responsibility, r.remark]); }),
        { pctCols: [12, 17, 18, 19], widths: RO_WIDTHS.concat([18, 18, 18, 15, 9, 10, 14, 11, 22, 40]) });
      XLSX.utils.book_append_sheet(wb, wsD, 'RO Wise Detail');
    }
    return wb;
  }

  function selectedSheets() {
    var out = {};
    document.querySelectorAll('#dem-sheets input[type=checkbox]').forEach(function (cb) { out[cb.value] = cb.checked; });
    return out;
  }
  function fileName(R) {
    var scope = [].concat(S.filters.area, S.filters.te, S.filters.vendor).filter(Boolean).join('_').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
    var t = String(R.snap.time || '').replace(':', '');
    return 'Automation_DayEnd_MIS_Belgaum_' + R.snap.date + (t ? '_' + t : '') + (scope ? '_' + scope : '') + '.xlsx';
  }

  function makeWorkbook() {
    var R = S.report;
    if (!R) { toast('Nothing to export yet', 'error'); return null; }
    if (typeof XLSX === 'undefined') { toast('Excel library failed to load. Reload the page.', 'error'); return null; }
    var sheets = selectedSheets();
    if (!Object.keys(sheets).some(function (k) { return sheets[k]; })) { toast('Tick at least one sheet to export', 'error'); return null; }
    return buildWorkbook(R, sheets);
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function exportExcel() {
    var wb = makeWorkbook();
    if (!wb) return;
    var name = fileName(S.report);
    try {
      var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
      downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
      logExport(name);
      toast('Day End MIS exported: ' + name);
    } catch (e) {
      console.error('[DayEndMIS] export failed', e);
      toast('Export failed: ' + e.message, 'error');
    }
  }

  async function shareExcel() {
    var wb = makeWorkbook();
    if (!wb) return;
    var name = fileName(S.report);
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
    var mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    var file;
    try { file = new File([out], name, { type: mime }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Automation Day End MIS ' + fmtDate(S.report.snap.date), text: buildText(S.report, true) });
        logExport(name + ' (shared)');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.warn('[DayEndMIS] share failed, falling back to download', e);
      }
    } else {
      toast('Sharing files is not supported on this browser — downloading instead');
    }
    downloadBlob(new Blob([out], { type: mime }), name);
    logExport(name);
  }

  function logExport(name) {
    try {
      var log = JSON.parse(localStorage.getItem('bpcl_dayend_mis_exports') || '[]');
      log.unshift({ name: name, at: Date.now(), by: S.report ? S.report.generatedBy : '' });
      localStorage.setItem('bpcl_dayend_mis_exports', JSON.stringify(log.slice(0, 15)));
    } catch (e) { /* ignore */ }
    renderExportLog();
  }
  function renderExportLog() {
    var el = $('dem-log');
    if (!el) return;
    var log = [];
    try { log = JSON.parse(localStorage.getItem('bpcl_dayend_mis_exports') || '[]'); } catch (e) { log = []; }
    if (!log.length) { el.innerHTML = '<span class="dem-muted">No exports from this device yet.</span>'; return; }
    el.innerHTML = log.slice(0, 5).map(function (l) {
      return '<div class="dem-log-row"><span class="dem-log-name" title="' + esc(l.name) + '">' + esc(l.name) + '</span><span class="dem-muted">' + esc(new Date(l.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</span></div>';
    }).join('');
  }

  /* -------------------------------------------------- WhatsApp / text */
  function buildText(R, short) {
    var t = R.total, p = R.prevTotal;
    var dn = function (a, b, lower) {
      if (a == null || b == null) return '';
      var d = a - b; if (!d) return ' (=)';
      var good = lower ? d < 0 : d > 0;
      return ' (' + (good ? '▲' : '▼') + Math.abs(d) + ')';
    };
    var dpp = function (a, b) {
      if (a == null || b == null) return '';
      var d = (a - b) * 100;
      return ' (' + (d >= 0 ? '+' : '') + d.toFixed(1) + ' pp)';
    };
    var lines = [];
    lines.push('*BPCL ' + TERRITORY + '*');
    lines.push('*Automation Day End MIS — ' + fmtDate(R.snap.date) + '* (' + fmtTime(R.snap.time) + ')');
    if (R.filterLabel !== 'All outlets') lines.push('_Scope: ' + R.filterLabel + '_');
    lines.push('');
    lines.push('Total ROs: *' + t.total + '*');
    lines.push('🟢 Fully Online: *' + t.fully + '* (' + pct(t.fullyPct) + ')' + dn(t.fully, p && p.fully));
    lines.push('🟡 Partially Online: *' + t.partial + '*' + dn(t.partial, p && p.partial, true));
    lines.push('🔴 Offline: *' + t.offline + '*' + dn(t.offline, p && p.offline, true));
    if (t.hasEquip) {
      lines.push('');
      lines.push('⚙️ MPD uptime: *' + pct(t.mpdUp) + '*' + dpp(t.mpdUp, p && p.mpdUp) + ' (' + t.onl_mpd + '/' + t.onb_mpd + ')');
      lines.push('🛢️ ATG uptime: *' + pct(t.tnkUp) + '*' + dpp(t.tnkUp, p && p.tnkUp) + ' (' + t.onl_tnk + '/' + t.onb_tnk + ')');
      lines.push('📊 Overall uptime: *' + pct(t.uptime) + '*' + dpp(t.uptime, p && p.uptime));
    }
    if (short) return lines.join('\n');
    if (R.areas.length > 1) {
      lines.push('');
      lines.push('*Sales area wise uptime*');
      R.areas.forEach(function (a) {
        lines.push('• ' + a.key + ': ' + (a.uptime != null ? pct(a.uptime) : (a.fully + '/' + a.total + ' fully online')) + ' — Off ' + a.offline + ', Partial ' + a.partial);
      });
    }
    if (R.prevSnap) {
      lines.push('');
      lines.push('*Day-on-day:* ' + R.drops.length + ' drop(s), ' + R.improvements.length + ' improvement(s)');
      R.drops.slice(0, 10).forEach(function (r) { lines.push('  ▼ ' + r.roid + ' ' + r.outlet_name + ' — ' + r.prev_status + ' → ' + r.status); });
      if (R.drops.length > 10) lines.push('  …and ' + (R.drops.length - 10) + ' more');
    }
    if (R.offline.length) {
      lines.push('');
      lines.push('*Offline ROs (' + R.offline.length + ')*');
      R.offline.slice(0, 20).forEach(function (r) {
        lines.push('  🔴 ' + r.roid + ' ' + r.outlet_name + ' (' + r.sales_area + ')' + (r.off_days > 1 ? ' — ' + r.off_days + ' days' : ''));
      });
      if (R.offline.length > 20) lines.push('  …and ' + (R.offline.length - 20) + ' more (see Excel)');
    }
    return lines.join('\n');
  }

  function openTextModal() {
    if (!S.report) return;
    $('dem-text').value = buildText(S.report, false);
    var m = $('dem-text-modal');
    m.style.display = 'flex';
    setTimeout(function () { $('dem-text').focus(); }, 30);
  }
  function closeTextModal() { $('dem-text-modal').style.display = 'none'; }
  async function copyText() {
    var txt = $('dem-text').value;
    try {
      await navigator.clipboard.writeText(txt);
      toast('Summary copied — paste it in WhatsApp or e-mail');
    } catch (e) {
      var ta = $('dem-text'); ta.focus(); ta.select();
      try { document.execCommand('copy'); toast('Summary copied'); } catch (e2) { toast('Select the text and copy it manually', 'error'); }
    }
  }
  function whatsappText() {
    var txt = $('dem-text').value;
    window.open('https://wa.me/?text=' + encodeURIComponent(txt), '_blank', 'noopener');
  }

  /* -------------------------------------------------------------- print */
  function printReport() {
    if (!S.report) return;
    var R = S.report;
    var sec = function (title, html) { return '<section class="dem-print-sec"><h3>' + esc(title) + '</h3>' + html + '</section>'; };
    var html = '<div class="dem-print-head"><h2>Automation Day End MIS — ' + esc(fmtDate(R.snap.date)) + '</h2><p>BPCL ' + esc(TERRITORY) + ' · ' + esc(fmtTime(R.snap.time)) +
      (R.prevSnap ? ' · vs ' + esc(fmtDate(R.prevSnap.date)) : '') + ' · ' + esc(R.filterLabel) + '</p></div>' +
      '<div class="dem-kpis">' + $('dem-kpis').innerHTML + '</div>' +
      sec('Sales Area wise', summaryTable(R.areas, R.total, 'Sales Area')) +
      sec('TE wise', summaryTable(R.tes, R.total, 'Territory Engineer')) +
      sec('Vendor wise', summaryTable(R.vendors, R.total, 'Vendor')) +
      sec('Offline outlets (' + R.offline.length + ')', roCards(R.offline, 'offline')) +
      sec('Partially online outlets (' + R.partial.length + ')', roCards(R.partial, 'partial')) +
      (R.prevSnap ? sec('Day-on-day changes', changeTable(R)) : '');
    var host = $('dem-print-area');
    host.innerHTML = html;
    document.body.classList.add('dem-printing');
    var done = function () {
      document.body.classList.remove('dem-printing');
      host.innerHTML = '';
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    setTimeout(function () { window.print(); setTimeout(function () { if (document.body.classList.contains('dem-printing') && !window.matchMedia('print').matches) done(); }, 1500); }, 60);
  }

  /* --------------------------------------------------------------- wiring */
  function bind() {
    if (S.bound) return;
    S.bound = true;
    $('dem-date').addEventListener('change', function () {
      S.reportKey = '';
      renderSnapshotOptions(); renderCompareOptions(true); renderFilterOptions(); recompute();
    });
    $('dem-snapshot').addEventListener('change', function () {
      S.reportKey = this.value; renderCompareOptions(false); renderFilterOptions(); recompute();
    });
    $('dem-compare').addEventListener('change', function () { S.compareKey = this.value; recompute(); });
    $('dem-basis').addEventListener('change', function () { S.basis = this.value; recompute(); });
    ['area', 'te', 'vendor'].forEach(function (k) {
      $('dem-f-' + k).addEventListener('change', function () { S.filters[k] = window.MS ? MS.vals(this) : (this.value ? [this.value] : []); recompute(); });
    });
    $('dem-reset').addEventListener('click', function () {
      S.filters = { area: [], te: [], vendor: [] };
      S.basis = 'equipment'; $('dem-basis').value = 'equipment';
      renderFilterOptions(); recompute();
    });
    $('dem-refresh').addEventListener('click', function () { window.renderDayEndMIS(true); });
    $('dem-views').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-view]');
      if (!b) return;
      S.view = b.getAttribute('data-view');
      renderView();
    });
    $('dem-btn-xlsx').addEventListener('click', exportExcel);
    $('dem-btn-share').addEventListener('click', shareExcel);
    $('dem-btn-wa').addEventListener('click', openTextModal);
    $('dem-btn-print').addEventListener('click', printReport);
    $('dem-text-close').addEventListener('click', closeTextModal);
    $('dem-text-copy').addEventListener('click', copyText);
    $('dem-text-wa').addEventListener('click', whatsappText);
    $('dem-text-modal').addEventListener('click', function (e) { if (e.target === this) closeTextModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('dem-text-modal').style.display === 'flex') closeTextModal(); });
    $('dem-sheet-all').addEventListener('click', function () {
      var boxes = document.querySelectorAll('#dem-sheets input[type=checkbox]');
      var allOn = Array.prototype.every.call(boxes, function (b) { return b.checked; });
      boxes.forEach(function (b) { b.checked = !allOn; });
      saveSheetPrefs();
    });
    document.querySelectorAll('#dem-sheets input[type=checkbox]').forEach(function (cb) { cb.addEventListener('change', saveSheetPrefs); });
    loadSheetPrefs();
    // Hide share button where the Web Share API cannot share files (most desktops)
    var probe = null;
    try { probe = new File(['x'], 't.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); } catch (e) { probe = null; }
    if (!(probe && navigator.canShare && navigator.canShare({ files: [probe] }))) $('dem-btn-share').style.display = 'none';
  }
  function saveSheetPrefs() {
    try { localStorage.setItem('bpcl_dayend_mis_sheets', JSON.stringify(selectedSheets())); } catch (e) { /* ignore */ }
  }
  function loadSheetPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem('bpcl_dayend_mis_sheets') || 'null');
      if (p) document.querySelectorAll('#dem-sheets input[type=checkbox]').forEach(function (cb) { if (p[cb.value] !== undefined) cb.checked = !!p[cb.value]; });
    } catch (e) { /* ignore */ }
  }

  /** Entry point — called when the tab opens (and by Refresh). */
  window.renderDayEndMIS = async function (forceReload) {
    if (!$('tab-day-end-mis')) return;
    bind();
    if (S.busy) return;
    S.busy = true;
    try {
      if (forceReload || !S.records.length) await loadHistory();
      renderDateOptions();
      renderSnapshotOptions();
      renderCompareOptions(!S.compareKey);
      renderFilterOptions();
      recompute();
      renderExportLog();
      if (forceReload === true) toast('Day End MIS refreshed');
    } catch (e) {
      console.error('[DayEndMIS] render failed', e);
      setState('empty', 'Could not build the report: ' + esc(e.message));
    } finally {
      S.busy = false;
    }
  };

  // Exposed for testing / other modules
  window.DayEndMIS = { buildText: function () { return S.report ? buildText(S.report, false) : ''; }, state: S, computeROs: computeROs };
})();
