// comparison.js - BPCL Belgaum Territory 3-Day EOD Comparison & Root-Cause Engine (v4)
//
// What changed vs v3:
//  * No synthetic history. Day 1 / Day 2 / Day 3 come only from REAL data:
//      1. Explicit EOD captures (manual button or automatic 10:00 PM capture)
//      2. Google Sheet syncs / Excel uploads already stored in IndexedDB "history"
//         (the record closest to 10:00 PM on each date is used as that day's EOD)
//      3. The currently loaded live data (today only, marked provisional)
//  * Captures never get overwritten by morning data; re-seeding is gone.
//  * Snapshots persist in IndexedDB (the global `DB` from trend.js) with a localStorage fallback.
//  * Strict Column V parsing + data-quality audit. If Column V disagrees with
//    MPD/ATG telemetry the page says so and lets you switch status basis.
//  * Classification uses per-day equipment data and the 3-day pattern:
//      Equipment Issue  - down days mostly coincide with MPD/ATG faults
//      Possible Dealer  - down on 2+ days while MPD/ATG telemetry was healthy
//      Requires Verify  - single-day drop with healthy equipment, or Online in
//                         Column V while telemetry reports a fault
//      Normal           - Online all 3 days, no fault
//  * Hotspot breakdown by Sales Area / EO / SO / Vendor, trend column,
//    sortable columns, visible filters, Excel export with summary sheet,
//    and import of a past day's MIS file straight into history.

(function () {
  'use strict';

  const SNAP_KEY = 'bpcl_eod_snapshots_v4';
  const PREF_KEY = 'bpcl_comp_prefs_v4';
  const EOD_HOUR = 22;          // 10:00 PM target
  const RETAIN_DAYS = 90;       // captured snapshots kept
  const COVERAGE_DAYS = 14;     // days shown on coverage strip
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const getDB = () => (typeof DB !== 'undefined' ? DB : (window.DB || null));
  const toast = (m, t) => { if (typeof showToast === 'function') showToast(m, t || 'info'); };
  const $ = id => document.getElementById(id);

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function displayDate(dateStr) {
    const p = String(dateStr || '').split('-');
    if (p.length !== 3) return dateStr || '';
    return `${p[2]}-${MONTHS[parseInt(p[1], 10) - 1] || p[1]}-${p[0]}`;
  }
  function shortDate(dateStr) {
    const p = String(dateStr || '').split('-');
    if (p.length !== 3) return dateStr || '';
    return `${p[2]} ${MONTHS[parseInt(p[1], 10) - 1] || p[1]}`;
  }
  function hhmm(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function to12h(t) {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ap}`;
  }
  function cleanId(v) {
    const s = String(v == null ? '' : v).trim().replace(/\.0+$/, '');
    return s;
  }
  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  // ---------------------------------------------------------------------------
  // Status parsing
  // ---------------------------------------------------------------------------
  // Strict Column V parser. Returns 'Online' | 'Partial' | 'Offline' | null (unrecognised)
  function parseColumnV(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (/^(fully online|full online|online|on|fully communicated|communicated|yes|y|1)$/.test(s)) return 'Online';
    if (/^(partially online|partial online|partial|partially|partially communicated.*|part)$/.test(s) || s.startsWith('partial')) return 'Partial';
    if (/^(offline|off|not online|not communicated|no|n|0)$/.test(s) || s.startsWith('offline')) return 'Offline';
    // Loose but safe fallbacks
    if (s.includes('partial')) return 'Partial';
    if (s.includes('online') && !s.includes('offline') && !s.includes('not')) return 'Online';
    if (s.includes('offline')) return 'Offline';
    return null;
  }

  // Equipment telemetry -> status, mirrors app.js Excel formula
  function equipmentStatus(r) {
    const tb = r.onb_mpd + r.onb_tnk;
    const tl = r.onl_mpd + r.onl_tnk;
    if (tb <= 0) return null;
    if (tl <= 0) return 'Offline';
    if (r.onl_mpd < r.onb_mpd || r.onl_tnk < r.onb_tnk) return 'Partial';
    return 'Online';
  }

  // Normalise any source row (raw sheet row, calculated RO, HistoryArchive {roid,status})
  function normaliseRow(ro) {
    const cc = cleanId(ro.roid || ro.cc_code || ro.ROID || ro['RO ID']);
    if (!cc) return null;
    // Global Territory filter (shared by every menu)
    if (window.GlobalScope && !GlobalScope.match(ro.territory || ro.Territory)) return null;
    const map = (window.activeMappings && window.activeMappings[cc]) || {};
    const onb_mpd = num(ro.onb_mpd), onl_mpd = num(ro.onl_mpd);
    const onb_tnk = num(ro.onb_tnk), onl_tnk = num(ro.onl_tnk);
    const off_mpd = Math.max(0, +(onb_mpd - onl_mpd).toFixed(2));
    const off_tnk = Math.max(0, +(onb_tnk - onl_tnk).toFixed(2));
    const hasTelemetry = (onb_mpd + onb_tnk) > 0;

    // Column V: raw sheet value lives in ro_online_status; HistoryArchive has only `status`
    let colvRaw = ro.ro_online_status;
    if ((colvRaw === undefined || colvRaw === null || colvRaw === '') && !hasTelemetry) colvRaw = ro.status;
    const rec = {
      cc,
      name: ro.outlet_name || map.outlet_name || `RO ${cc}`,
      area: ro.sales_area || map.sales_area || 'Unmapped',
      territory: ro.territory || map.territory || '',
      vendor: ro.vendor || map.vendor || 'Unmapped',
      eo: ro.eo_name && ro.eo_name !== 'Unmapped' ? ro.eo_name : (map.eo_name || 'Unmapped'),
      so: ro.so_name && ro.so_name !== 'Unmapped' ? ro.so_name : (map.so_name || 'Unmapped'),
      mst: ro.mst_name && ro.mst_name !== 'Unmapped' ? ro.mst_name : (map.mst_name || 'Unmapped'),
      colv_raw: colvRaw == null ? '' : String(colvRaw).trim(),
      colv: parseColumnV(colvRaw),
      onb_mpd, onl_mpd, onb_tnk, onl_tnk, off_mpd, off_tnk,
      has_tel: hasTelemetry,
      fault: hasTelemetry && (off_mpd > 0 || off_tnk > 0)
    };
    rec.eq = hasTelemetry ? equipmentStatus(rec) : null;
    return rec;
  }

  function buildSnapshot(list, meta) {
    const records = {};
    (list || []).forEach(ro => {
      const r = normaliseRow(ro);
      if (r) records[r.cc] = r;
    });
    return Object.assign({
      date: meta.date,
      display: displayDate(meta.date),
      time: meta.time || '22:00',
      source: meta.source,            // capture | history | live | import
      label: meta.label || '',
      total: Object.keys(records).length,
      records
    }, { quality: assessQuality(records) });
  }

  // Data-quality audit for one snapshot
  function assessQuality(records) {
    const q = { total: 0, colvKnown: 0, colvUnknown: 0, colv: { Online: 0, Partial: 0, Offline: 0 }, eq: { Online: 0, Partial: 0, Offline: 0 }, conflictOffHealthy: 0, rawValues: {} };
    Object.values(records).forEach(r => {
      q.total++;
      const rawKey = r.colv_raw === '' ? '(blank)' : r.colv_raw;
      q.rawValues[rawKey] = (q.rawValues[rawKey] || 0) + 1;
      if (r.colv) { q.colvKnown++; q.colv[r.colv]++; } else q.colvUnknown++;
      if (r.eq) q.eq[r.eq]++;
      if (r.colv === 'Offline' && r.eq === 'Online') q.conflictOffHealthy++;
    });
    q.conflictPct = q.total ? q.conflictOffHealthy / q.total : 0;
    q.colvOffPct = q.total ? q.colv.Offline / q.total : 0;
    q.eqOffPct = q.total ? q.eq.Offline / q.total : 0;
    // Suspicious: Column V marks most ROs offline while telemetry says they're healthy
    q.suspect = q.total > 10 && (q.conflictPct >= 0.4 || (q.colvUnknown / q.total) >= 0.5);
    return q;
  }

  // ---------------------------------------------------------------------------
  // Snapshot store: captures + history-derived + live
  // ---------------------------------------------------------------------------
  const Store = {
    captures: {},       // date -> snapshot (source capture/import)
    derived: {},        // date -> snapshot (source history/live)
    loaded: false,
    historyStamp: 0,

    async open() {
      const db = getDB();
      try { if (db && !db.db) await db.open(); } catch (e) { console.warn('[Comparison] DB open failed', e); }
      return db && db.db ? db : null;
    },

    async loadCaptures() {
      let caps = null;
      const db = await this.open();
      if (db) {
        try { caps = await db.get('config', SNAP_KEY); } catch (e) { console.warn(e); }
      }
      if (!caps) {
        try { caps = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null'); } catch (e) { caps = null; }
      }
      this.captures = caps && typeof caps === 'object' ? caps : {};
      // Re-assess quality (older captures may lack it)
      Object.values(this.captures).forEach(s => { if (!s.quality) s.quality = assessQuality(s.records || {}); });
    },

    async saveCaptures() {
      // prune
      const cutoff = ymd(new Date(Date.now() - RETAIN_DAYS * 86400000));
      Object.keys(this.captures).forEach(d => { if (d < cutoff) delete this.captures[d]; });
      const db = await this.open();
      let ok = false;
      if (db) {
        try { await db.set('config', SNAP_KEY, this.captures); ok = true; } catch (e) { console.warn(e); }
      }
      if (!ok) {
        try { localStorage.setItem(SNAP_KEY, JSON.stringify(this.captures)); } catch (e) { console.warn('[Comparison] localStorage full', e); toast('Could not persist snapshot (storage full).', 'error'); }
      } else {
        try { localStorage.removeItem(SNAP_KEY); } catch (e) { /* ignore */ }
      }
    },

    isMockRecord(rec) {
      const blob = rec.fileBlob;
      return !!(blob && typeof blob.size === 'number' && blob.size < 200 &&
        /^Belgaum_Territory_RawData_/.test(rec.filename || ''));
    },

    // Derive one EOD snapshot per date from IndexedDB history records
    async loadHistory() {
      this.derived = {};
      const db = await this.open();
      if (!db) return;
      let recs = [];
      try { recs = await db.getAllRecords(); } catch (e) { console.warn(e); return; }
      const byDate = {};
      recs.forEach(rec => {
        if (!rec || !rec.date || !Array.isArray(rec.rawData) || rec.rawData.length === 0) return;
        if (this.isMockRecord(rec)) return; // ignore demo history seeded by trend.js
        (byDate[rec.date] = byDate[rec.date] || []).push(rec);
      });
      Object.keys(byDate).forEach(date => {
        const list = byDate[date];
        const target = new Date(`${date}T${String(EOD_HOUR).padStart(2, '0')}:00:00`).getTime();
        // Prefer the latest record at/before 10 PM; otherwise the earliest after it
        const before = list.filter(r => r.timestamp <= target + 30 * 60000).sort((a, b) => b.timestamp - a.timestamp);
        const after = list.filter(r => r.timestamp > target + 30 * 60000).sort((a, b) => a.timestamp - b.timestamp);
        const pick = before[0] || after[0];
        if (!pick) return;
        const time = pick.time || hhmm(pick.timestamp);
        this.derived[date] = buildSnapshot(pick.rawData, {
          date, time, source: 'history',
          label: pick.filename || 'Sync'
        });
        this.derived[date].syncCount = list.length;
        const newest = list.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
        this.derived[date].latestTime = newest.time || hhmm(newest.timestamp);
      });
    },

    addLive() {
      const live = window.calculatedROs;
      if (!live || !live.length) return;
      const today = ymd(new Date());
      if (this.captures[today]) return;
      const existing = this.derived[today];
      // Live data is always at least as fresh as today's latest sync
      // Label with the time of today's latest sync/upload (that's what the loaded data is),
      // falling back to the clock if the data came from somewhere that wasn't logged.
      const latestToday = (existing && existing.latestTime) || hhmm(Date.now());
      this.derived[today] = buildSnapshot(live, {
        date: today, time: latestToday, source: 'live', label: 'Currently loaded data'
      });
      this.derived[today].latestTime = latestToday;
      if (existing) this.derived[today].syncCount = existing.syncCount;
    },

    async refresh() {
      await this.loadCaptures();
      await this.loadHistory();
      this.addLive();
      this.loaded = true;
    },

    get(date) {
      return this.captures[date] || this.derived[date] || null;
    },

    dates() {
      const set = new Set([...Object.keys(this.captures), ...Object.keys(this.derived)]);
      return [...set].sort().reverse(); // newest first
    },

    async capture(date, opts = {}) {
      const live = window.calculatedROs;
      if (!live || !live.length) return { ok: false, msg: 'No outlet data loaded. Sync the Google Sheet first.' };
      if (window.dashboardMode === 'evcs') return { ok: false, msg: 'EVCS data is loaded. Load the Automation sheet to capture an EOD snapshot.' };
      const now = new Date();
      this.captures[date] = buildSnapshot(live, {
        date, time: opts.time || hhmm(now.getTime()), source: opts.source || 'capture',
        label: opts.label || (opts.auto ? 'Auto 10:00 PM capture' : 'Manual capture')
      });
      await this.saveCaptures();
      return { ok: true, msg: `EOD snapshot saved for ${displayDate(date)} (${this.captures[date].total} ROs).` };
    },

    async removeCapture(date) {
      delete this.captures[date];
      await this.saveCaptures();
    }
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const State = {
    dates: [],               // [d1, d2, d3] oldest -> latest
    custom: false,
    basis: 'colv',           // colv | equipment
    category: 'ALL',
    search: '',
    f: { area: [], eo: [], so: [], vendor: [], d1: [], d2: [], d3: [], pattern: [], trend: [] },
    sortField: 'severity',
    sortAsc: false,
    groupBy: 'area',
    list: [],                // scoped list (after role filter)
    view: []                 // filtered + sorted
  };

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (p.basis === 'equipment' || p.basis === 'colv') State.basis = p.basis;
      if (p.groupBy) State.groupBy = p.groupBy;
    } catch (e) { /* ignore */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ basis: State.basis, groupBy: State.groupBy })); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------
  const SEV = { Online: 0, Partial: 1, Offline: 2, 'No Data': -1 };

  function statusFor(rec) {
    if (!rec) return 'No Data';
    if (State.basis === 'equipment') return rec.eq || rec.colv || 'No Data';
    return rec.colv || rec.eq || 'No Data';
  }

  function eqText(r) {
    if (!r) return 'No data for this day';
    if (!r.has_tel) return 'No MPD/ATG telemetry';
    if (r.off_mpd > 0 && r.off_tnk > 0) return `${fmtN(r.off_mpd)} MPD & ${fmtN(r.off_tnk)} tank offline`;
    if (r.off_mpd > 0) return `${fmtN(r.off_mpd)} of ${fmtN(r.onb_mpd)} MPD offline`;
    if (r.off_tnk > 0) return `${fmtN(r.off_tnk)} of ${fmtN(r.onb_tnk)} tank offline`;
    return `All ${fmtN(r.onb_mpd)} MPD / ${fmtN(r.onb_tnk)} tank online`;
  }
  function eqLabel(r) {
    if (!r || !r.has_tel) return 'No telemetry';
    if (r.off_mpd > 0 && r.off_tnk > 0) return 'MPD + Tank fault';
    if (r.off_mpd > 0) return 'MPD fault';
    if (r.off_tnk > 0) return 'Tank fault';
    return 'Healthy';
  }
  function fmtN(n) { return Number.isInteger(n) ? String(n) : (+n).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); }

  function runEngine(snaps) {
    const [s1, s2, s3] = snaps;
    const ccs = new Set([...Object.keys(s1.records), ...Object.keys(s2.records), ...Object.keys(s3.records)]);
    const out = [];

    ccs.forEach(cc => {
      const recs = [s1.records[cc], s2.records[cc], s3.records[cc]];
      const latest = recs[2] || recs[1] || recs[0];
      const st = recs.map(statusFor);
      const isDown = s => s === 'Offline' || s === 'Partial';
      const downIdx = [0, 1, 2].filter(i => isDown(st[i]));
      const downCount = downIdx.length;
      const offCount = st.filter(s => s === 'Offline').length;
      const partCount = st.filter(s => s === 'Partial').length;
      const noData = st.filter(s => s === 'No Data').length;
      const faultOnDown = downIdx.filter(i => recs[i] && recs[i].fault).length;
      const healthyOnDown = downCount - faultOnDown;

      // Pattern
      let pattern;
      if (offCount === 3) pattern = '3-Day Continuous Offline';
      else if (partCount === 3) pattern = '3-Day Continuous Partial';
      else if (downCount === 3) pattern = 'Down All 3 Days (Mixed)';
      else if (downCount === 2) pattern = (isDown(st[0]) && isDown(st[2]) && !isDown(st[1])) ? 'Intermittent (Day 1 & 3)' : 'Down 2 Days';
      else if (downCount === 1) pattern = 'Single Day Drop';
      else if (noData > 0) pattern = 'Incomplete Data';
      else pattern = '3-Day Continuous Online';

      // Trend (Day 1 -> Day 3)
      let trend = 'Stable';
      const a = SEV[st[0]], b = SEV[st[2]];
      if (a >= 0 && b >= 0) {
        if (b < a) trend = b === 0 ? 'Recovered' : 'Improved';
        else if (b > a) trend = 'Drop';
        else trend = b === 0 ? 'Stable' : 'Unchanged';
      } else trend = 'Incomplete';

      // Root-cause classification
      let category, badge, reason;
      if (downCount === 0) {
        if (latest && latest.fault) {
          category = 'Requires Verification'; badge = 'badge-verify';
          reason = `Column V shows Online on all compared days, but telemetry on Day 3 reports ${eqText(latest).toLowerCase()}. Verify sensor/ATG probe reading or Column V source.`;
        } else {
          category = 'Normal'; badge = 'badge-normal';
          reason = noData ? 'Online on every day with data; no equipment fault recorded.' : 'Online on all 3 EOD observations with zero equipment faults.';
        }
      } else if (faultOnDown > 0 && faultOnDown >= healthyOnDown) {
        category = 'Equipment Issue'; badge = 'badge-equip';
        reason = `Down on ${downCount} of 3 days; on ${faultOnDown} of those days MPD/ATG telemetry also shows a fault (${eqText(recs[downIdx[downIdx.length - 1]]).toLowerCase()}). Raise vendor/FCC complaint for the hardware.`;
      } else if (downCount >= 2) {
        category = 'Possible Dealer Issue'; badge = 'badge-dealer';
        reason = `Down in Column V on ${downCount} of 3 days while MPD/ATG telemetry was healthy on ${healthyOnDown} of those days. Points to a site-side cause (automation PC, router, UPS or power switched off). Follow up with the dealer via SO.`;
      } else {
        category = 'Requires Verification'; badge = 'badge-verify';
        reason = `Single-day drop (${[s1, s2, s3][downIdx[0]].display}: ${st[downIdx[0]]}) with healthy equipment. Watch next EOD before escalating.`;
      }

      const severity = (category === 'Possible Dealer Issue' ? 300 : category === 'Equipment Issue' ? 200 : category === 'Requires Verification' ? 100 : 0) + offCount * 20 + partCount * 10;

      out.push({
        cc, name: latest.name, area: latest.area, vendor: latest.vendor, eo: latest.eo, so: latest.so, mst: latest.mst,
        st, recs, downCount, offCount, partCount, noData, faultOnDown,
        pattern, trend, category, badge, reason, severity,
        eqLatestLabel: eqLabel(latest), eqLatestText: eqText(latest), eqFault: !!(latest && latest.fault)
      });
    });
    return out;
  }

  function scope(list) {
    const u = window.currentUser;
    if (!u) return list;
    if (u.role === 'so') return list.filter(r => r.so === u.username);
    if (u.role === 'eo') return list.filter(r => r.eo === u.username);
    if (u.role === 'vendor') return list.filter(r => r.vendor === u.username);
    return list;
  }

  const CAT_FILTERS = {
    ALL: () => true,
    DEALER: r => r.category === 'Possible Dealer Issue',
    EQUIPMENT: r => r.category === 'Equipment Issue',
    NORMAL: r => r.category === 'Normal',
    VERIFY: r => r.category === 'Requires Verification',
    CONT_OFF: r => r.pattern === '3-Day Continuous Offline',
    CONT_PART: r => r.pattern === '3-Day Continuous Partial',
    REPEATED: r => r.downCount >= 2,
    WORSENED: r => r.trend === 'Drop',
    RECOVERED: r => r.trend === 'Recovered' || r.trend === 'Improved'
  };

  // Filter values are arrays (multi-select); empty = no filter
  function fArr(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
  function inF(v, x) { const a = fArr(v); return !a.length || a.includes(x); }
  function setF(k, arr) { State.f[k] = fArr(arr).slice(); const el = $(FILTER_IDS[k]); if (el && window.MS) MS.set(el, State.f[k]); else if (el) el.value = State.f[k][0] || ''; }
  const FILTER_IDS = { area: 'comp-filter-area', eo: 'comp-filter-eo', so: 'comp-filter-so', vendor: 'comp-filter-vendor', d1: 'comp-filter-d1-status', d2: 'comp-filter-d2-status', d3: 'comp-filter-d3-status', pattern: 'comp-filter-pattern', trend: 'comp-filter-trend' };

  function applyFilters(list) {
    const q = State.search.toLowerCase().trim();
    const f = State.f;
    const cat = CAT_FILTERS[State.category] || CAT_FILTERS.ALL;
    return list.filter(r => {
      if (!cat(r)) return false;
      if (!inF(f.area, r.area)) return false;
      if (!inF(f.eo, r.eo)) return false;
      if (!inF(f.so, r.so)) return false;
      if (!inF(f.vendor, r.vendor)) return false;
      if (!inF(f.d1, r.st[0])) return false;
      if (!inF(f.d2, r.st[1])) return false;
      if (!inF(f.d3, r.st[2])) return false;
      if (!inF(f.pattern, r.pattern)) return false;
      if (!inF(f.trend, r.trend)) return false;
      if (q) {
        const hay = `${r.cc} ${r.name} ${r.area} ${r.vendor} ${r.eo} ${r.so} ${r.category} ${r.pattern}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function sortList(list) {
    const k = State.sortField, dir = State.sortAsc ? 1 : -1;
    const val = r => {
      if (k === 'd1') return SEV[r.st[0]];
      if (k === 'd2') return SEV[r.st[1]];
      if (k === 'd3') return SEV[r.st[2]];
      const v = r[k];
      return typeof v === 'string' ? v.toLowerCase() : (v == null ? '' : v);
    };
    list.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return a.cc < b.cc ? -1 : 1;
    });
  }

  // ---------------------------------------------------------------------------
  // Period selection
  // ---------------------------------------------------------------------------
  function defaultPeriod(excludeToday) {
    const today = ymd(new Date());
    let dates = Store.dates();
    if (excludeToday) dates = dates.filter(d => d !== today);
    return dates.slice(0, 3).reverse();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  let rendering = null;
  let pendingOpts = null;
  window.render3DayComparison = async function (opts = {}) {
    if (rendering) {
      // Queue one more pass with merged options so no request is lost
      pendingOpts = Object.assign(pendingOpts || {}, opts, { reload: !!((pendingOpts && pendingOpts.reload) || opts.reload) });
      return rendering.then(() => {
        if (!pendingOpts) return;
        const o = pendingOpts; pendingOpts = null;
        return window.render3DayComparison(o);
      });
    }
    rendering = (async () => {
      try {
        if (!Store.loaded || opts.reload) await Store.refresh();
        else Store.addLive();
        renderCoverage();
        renderAutoStatus();

        const all = Store.dates();
        if (!State.custom || State.dates.some(d => !Store.get(d))) {
          State.custom = false;
          State.dates = defaultPeriod(false);
        }
        populateDateSelects(all);

        if (State.dates.length < 3) {
          renderEmpty(all.length);
          return;
        }

        const snaps = State.dates.map(d => Store.get(d));
        updatePeriodBadge(snaps);
        renderQuality(snaps);
        setHeaderDates(snaps);

        State.list = scope(runEngine(snaps));
        populateFilterOptions(State.list);
        renderKpis(State.list);
        renderHotspots(State.list);
        refreshTable();
      } catch (e) {
        console.error('[Comparison] render failed', e);
        const tb = $('comp-table-tbody');
        if (tb) tb.innerHTML = `<tr><td colspan="11" class="comp-empty">Comparison failed to render: ${esc(e.message)}</td></tr>`;
      }
    })();
    // Release the lock only after the promise settles (the body may finish synchronously)
    const p = rendering;
    p.then(() => { if (rendering === p) rendering = null; });
    return p;
  };

  function refreshTable() {
    const v = applyFilters(State.list);
    sortList(v);
    State.view = v;
    renderRows(v);
    renderActiveFilters();
  }

  function renderEmpty(count) {
    const msg = count === 0
      ? 'No EOD data yet. Sync the Google Sheet (each sync is saved to history) or capture a 10:00 PM snapshot. Past days can be added with “Import past day”.'
      : `Only ${count} day${count === 1 ? '' : 's'} of real data available. A 3-day comparison needs 3 different dates — keep syncing daily, capture at 10:00 PM, or import past MIS files.`;
    const tb = $('comp-table-tbody');
    if (tb) tb.innerHTML = `<tr><td colspan="11" class="comp-empty">${esc(msg)}</td></tr>`;
    const badge = $('comp-period-badge');
    if (badge) badge.textContent = 'Not enough history';
    ['comp-kpi-total', 'comp-kpi-dealer', 'comp-kpi-equip', 'comp-kpi-normal', 'comp-kpi-cont-off', 'comp-kpi-cont-part', 'comp-kpi-repeated', 'comp-kpi-verify'].forEach(id => setText(id, '–'));
    const qb = $('comp-quality-banner'); if (qb) qb.style.display = 'none';
    const hs = $('comp-hotspot-body'); if (hs) hs.innerHTML = '';
    setText('comp-count-info', '');
    setText('comp-variation-text', 'Waiting for 3 days of data.');
  }

  function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

  function sourceInfo(s) {
    if (!s) return { cls: 'missing', label: 'No data', tip: 'No sync, upload or capture for this date' };
    const t = to12h(s.time);
    if (s.source === 'capture') return { cls: 'capture', label: `Captured ${t}`, tip: `${s.label} at ${t}` };
    if (s.source === 'import') return { cls: 'capture', label: 'Imported', tip: `Imported file: ${s.label}` };
    if (s.source === 'live') return { cls: 'live', label: `Live ${t}`, tip: 'Currently loaded data — provisional until the 10:00 PM capture' };
    const h = parseInt(s.time, 10);
    const late = h >= 18;
    return { cls: late ? 'sync' : 'early', label: `Sync ${t}`, tip: `${s.syncCount || 1} sync(s) that day; using the one closest to 10:00 PM (${t})${late ? '' : ' — early in the day, may not reflect EOD'}` };
  }

  function renderCoverage() {
    const wrap = $('comp-coverage');
    if (!wrap) return;
    const today = new Date();
    const cells = [];
    for (let i = COVERAGE_DAYS - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const ds = ymd(d);
      const s = Store.get(ds);
      const info = sourceInfo(s);
      const sel = State.dates.includes(ds);
      cells.push(`<button type="button" class="comp-cov-day cov-${info.cls}${sel ? ' cov-selected' : ''}" data-date="${ds}" title="${esc(displayDate(ds) + ' — ' + info.tip)}" ${s ? '' : 'disabled'}>
        <span class="cov-date">${esc(shortDate(ds))}</span>
        <span class="cov-label">${esc(info.label)}</span>
      </button>`);
    }
    wrap.innerHTML = cells.join('');
    wrap.querySelectorAll('.comp-cov-day[data-date]').forEach(btn => {
      btn.addEventListener('click', () => {
        // Click a day: make it Day 3 and pick the 2 previous available dates
        const d3 = btn.dataset.date;
        const prior = Store.dates().filter(x => x < d3).slice(0, 2).reverse();
        if (prior.length < 2) { toast(`Need 2 earlier days with data before ${displayDate(d3)}.`, 'error'); return; }
        State.dates = [...prior, d3];
        State.custom = true;
        window.render3DayComparison();
      });
    });
  }

  function renderAutoStatus() {
    const el = $('comp-auto-status');
    if (!el) return;
    const today = ymd(new Date());
    const cap = Store.captures[today];
    if (cap) {
      el.innerHTML = `<span class="comp-dot dot-ok"></span>Today's EOD captured at ${esc(to12h(cap.time))}`;
    } else {
      const h = new Date().getHours();
      el.innerHTML = h >= EOD_HOUR
        ? `<span class="comp-dot dot-warn"></span>10:00 PM capture pending — will capture after next sync`
        : `<span class="comp-dot dot-ok"></span>Auto-capture at 10:00 PM (keep dashboard open)`;
    }
  }

  function populateDateSelects(all) {
    const ids = ['comp-date-select-1', 'comp-date-select-2', 'comp-date-select-3'];
    ids.forEach((id, i) => {
      const sel = $(id);
      if (!sel) return;
      sel.innerHTML = all.map(d => {
        const s = Store.get(d);
        const tag = s.source === 'capture' ? 'EOD' : s.source === 'import' ? 'Imported' : s.source === 'live' ? 'Live' : `Sync ${s.time}`;
        return `<option value="${d}" ${State.dates[i] === d ? 'selected' : ''}>${esc(s.display)} · ${esc(tag)}</option>`;
      }).join('');
    });
  }

  function updatePeriodBadge(snaps) {
    const badge = $('comp-period-badge');
    if (badge) badge.textContent = snaps.map(s => s.display).join(' → ');
  }

  function setHeaderDates(snaps) {
    snaps.forEach((s, i) => {
      const el = $(`comp-th-d${i + 1}`);
      if (el) {
        const info = sourceInfo(s);
        el.innerHTML = `${esc(shortDate(s.date))}<span class="comp-th-src cov-${info.cls}">${esc(info.label)}</span>`;
      }
    });
  }

  function renderQuality(snaps) {
    const box = $('comp-quality-banner');
    if (!box) return;
    const issues = [];
    snaps.forEach(s => {
      const q = s.quality;
      if (s.source === 'live') {
        issues.push({ lvl: 'info', html: `<strong>${esc(s.display)}</strong> uses the currently loaded data (${esc(to12h(s.time))}). Treat Day 3 as provisional until the 10:00 PM capture.` });
      } else if (s.source === 'history' && parseInt(s.time, 10) < 18) {
        issues.push({ lvl: 'info', html: `<strong>${esc(s.display)}</strong>: last sync of the day was at ${esc(to12h(s.time))}, not near 10:00 PM.` });
      }
      if (State.basis === 'colv' && q && q.suspect) {
        const top = Object.entries(q.rawValues).sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([k, v]) => `“${esc(k.length > 28 ? k.slice(0, 28) + '…' : k)}” × ${v}`).join(', ');
        issues.push({
          lvl: 'warn',
          html: `<strong>${esc(s.display)}: Column V looks unreliable.</strong> ${q.colv.Offline} of ${q.total} ROs are Offline in Column V, yet ${q.conflictOffHealthy} of them have every MPD/tank online (equipment says ${q.eq.Offline} offline). ${q.colvUnknown ? `${q.colvUnknown} values were unrecognised. ` : ''}Values found: ${top}.`
        });
      }
    });
    if (!issues.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const hasWarn = issues.some(i => i.lvl === 'warn');
    box.className = `comp-quality-banner ${hasWarn ? 'q-warn' : 'q-info'}`;
    box.style.display = 'block';
    box.innerHTML = `<ul>${issues.map(i => `<li class="q-${i.lvl}">${i.html}</li>`).join('')}</ul>
      ${hasWarn ? `<button type="button" class="btn-secondary comp-small-btn" id="comp-switch-basis">Use MPD/ATG telemetry as status</button>` : ''}`;
    const sw = $('comp-switch-basis');
    if (sw) sw.onclick = () => { setBasis('equipment'); };
  }

  function renderKpis(list) {
    const c = { total: list.length, dealer: 0, equip: 0, normal: 0, verify: 0, contOff: 0, contPart: 0, repeated: 0, worse: 0, better: 0 };
    let dlOff = 0, dlPart = 0, eqOff = 0, eqPart = 0, d3Off = 0, d3Part = 0;
    list.forEach(r => {
      const s3 = r.st[2];
      if (s3 === 'Offline') d3Off++; else if (s3 === 'Partial') d3Part++;
      if (r.category === 'Possible Dealer Issue') { c.dealer++; if (s3 === 'Offline') dlOff++; else if (s3 === 'Partial') dlPart++; }
      else if (r.category === 'Equipment Issue') { c.equip++; if (s3 === 'Offline') eqOff++; else if (s3 === 'Partial') eqPart++; }
      else if (r.category === 'Normal') c.normal++;
      else if (r.category === 'Requires Verification') c.verify++;
      if (r.pattern === '3-Day Continuous Offline') c.contOff++;
      if (r.pattern === '3-Day Continuous Partial') c.contPart++;
      if (r.downCount >= 2) c.repeated++;
      if (r.trend === 'Drop') c.worse++;
      if (r.trend === 'Recovered' || r.trend === 'Improved') c.better++;
    });
    setText('comp-kpi-total', c.total);
    setText('comp-kpi-dealer', c.dealer);
    setText('comp-kpi-equip', c.equip);
    setText('comp-kpi-normal', c.normal);
    setText('comp-kpi-cont-off', c.contOff);
    setText('comp-kpi-cont-part', c.contPart);
    setText('comp-kpi-repeated', c.repeated);
    setText('comp-kpi-verify', c.verify);
    setText('comp-kpi-dealer-sub', `Down 2+ days, telemetry healthy · Day 3: ${dlOff} Off / ${dlPart} Part`);
    setText('comp-kpi-equip-sub', `Down with MPD/ATG fault · Day 3: ${eqOff} Off / ${eqPart} Part`);
    setText('comp-kpi-normal-sub', `Online all 3 days, no fault · ${pct(c.normal, c.total)} of outlets`);
    setText('comp-kpi-total-sub', `${c.worse} drop · ${c.better} improved vs Day 1`);
    const v = $('comp-variation-text');
    if (v) {
      const basisLbl = State.basis === 'colv' ? 'Column V' : 'MPD/ATG telemetry';
      v.innerHTML = `Day 3 downtime (${esc(basisLbl)}): <strong>${d3Off + d3Part}</strong> (${d3Off} Offline, ${d3Part} Partial) · ` +
        `Equipment-linked: <strong>${c.equip}</strong> · Dealer-side suspected: <strong>${c.dealer}</strong> · ` +
        `<span class="t-worse">${c.worse} drop</span> · <span class="t-better">${c.better} improved</span>`;
    }
  }
  function pct(a, b) { return b ? `${Math.round((a / b) * 100)}%` : '0%'; }

  function renderHotspots(list) {
    const body = $('comp-hotspot-body');
    if (!body) return;
    const key = { area: 'area', eo: 'eo', so: 'so', vendor: 'vendor' }[State.groupBy] || 'area';
    const groups = {};
    list.forEach(r => {
      const g = groups[r[key]] = groups[r[key]] || { name: r[key], total: 0, dealer: 0, equip: 0, verify: 0, contOff: 0, repeated: 0, worse: 0 };
      g.total++;
      if (r.category === 'Possible Dealer Issue') g.dealer++;
      if (r.category === 'Equipment Issue') g.equip++;
      if (r.category === 'Requires Verification') g.verify++;
      if (r.pattern === '3-Day Continuous Offline') g.contOff++;
      if (r.downCount >= 2) g.repeated++;
      if (r.trend === 'Drop') g.worse++;
    });
    const rows = Object.values(groups).sort((a, b) => (b.dealer + b.equip) - (a.dealer + a.equip) || b.repeated - a.repeated || a.name.localeCompare(b.name));
    const maxIssue = Math.max(1, ...rows.map(g => g.dealer + g.equip));
    body.innerHTML = rows.map(g => {
      const issue = g.dealer + g.equip;
      const w = Math.round((issue / maxIssue) * 100);
      const dw = issue ? Math.round((g.dealer / issue) * w) : 0;
      return `<tr data-group="${esc(g.name)}" class="comp-hot-row${fArr(State.f[key]).includes(g.name) ? ' is-active' : ''}" title="Click to filter the table to ${esc(g.name)}">
        <td class="hot-name">${esc(g.name)}</td>
        <td class="num">${g.total}</td>
        <td class="num t-dealer">${g.dealer}</td>
        <td class="num t-equip">${g.equip}</td>
        <td class="num">${g.verify}</td>
        <td class="num t-off">${g.contOff}</td>
        <td class="num">${g.repeated}</td>
        <td class="num">${pct(g.total - (g.dealer + g.equip + g.verify), g.total)}</td>
        <td class="hot-bar-cell"><div class="hot-bar"><span class="hb-dealer" style="width:${dw}%"></span><span class="hb-equip" style="width:${w - dw}%"></span></div></td>
      </tr>`;
    }).join('') || `<tr><td colspan="9" class="comp-empty">No outlets in scope.</td></tr>`;
    body.querySelectorAll('tr[data-group]').forEach(tr => {
      tr.addEventListener('click', () => {
        const val = tr.dataset.group;
        const cur = fArr(State.f[key]);
        setF(key, cur.includes(val) ? cur.filter(x => x !== val) : cur.concat(val));
        renderHotspots(State.list);
        refreshTable();
      });
    });
  }

  function populateFilterOptions(list) {
    const fill = (id, key, label) => {
      const sel = $(id);
      if (!sel) return;
      const vals = [...new Set(list.map(r => r[key]))].filter(Boolean).sort();
      const cur = fArr(State.f[key]).filter(v => vals.includes(v));
      sel.innerHTML = `<option value="">${label}</option>` + vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      setF(key, cur);
    };
    fill('comp-filter-area', 'area', 'All Sales Areas');
    fill('comp-filter-eo', 'eo', 'All EOs');
    fill('comp-filter-so', 'so', 'All SOs');
    fill('comp-filter-vendor', 'vendor', 'All Vendors');
  }

  function renderActiveFilters() {
    const el = $('comp-active-filters');
    if (!el) return;
    const chips = [];
    const names = { area: 'Area', eo: 'EO', so: 'SO', vendor: 'Vendor', d1: 'Day 1', d2: 'Day 2', d3: 'Day 3', pattern: 'Pattern', trend: 'Trend' };
    Object.entries(State.f).forEach(([k, v]) => { const a = fArr(v); if (a.length) chips.push(`<button type="button" class="comp-chip" data-k="${k}">${esc(names[k])}: ${esc(a.join(', '))} ✕</button>`); });
    if (State.category !== 'ALL') chips.push(`<button type="button" class="comp-chip" data-k="__cat">Card: ${esc(catLabel(State.category))} ✕</button>`);
    if (State.search) chips.push(`<button type="button" class="comp-chip" data-k="__q">Search: “${esc(State.search)}” ✕</button>`);
    el.innerHTML = chips.length ? chips.join('') + `<button type="button" class="comp-chip comp-chip-clear" data-k="__all">Clear all</button>` : '';
    el.querySelectorAll('.comp-chip').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.k;
      if (k === '__all') resetFilters();
      else if (k === '__cat') setCategory('ALL');
      else if (k === '__q') { State.search = ''; const s = $('comp-search-input'); if (s) s.value = ''; }
      else { setF(k, []); }
      renderHotspots(State.list);
      refreshTable();
    }));
  }
  function catLabel(c) {
    return { DEALER: 'Dealer issues', EQUIPMENT: 'Equipment issues', NORMAL: 'Normal', VERIFY: 'Verify', CONT_OFF: '3-day offline', CONT_PART: '3-day partial', REPEATED: 'Repeated', WORSENED: 'Drop', RECOVERED: 'Improved' }[c] || c;
  }
  function resetFilters() {
    Object.keys(State.f).forEach(k => State.f[k] = []);
    State.search = '';
    const s = $('comp-search-input'); if (s) s.value = '';
    setCategory('ALL', true);
    syncFilterInputs();
  }
  function syncFilterInputs() {
    const map = { area: 'comp-filter-area', eo: 'comp-filter-eo', so: 'comp-filter-so', vendor: 'comp-filter-vendor', d1: 'comp-filter-d1-status', d2: 'comp-filter-d2-status', d3: 'comp-filter-d3-status', pattern: 'comp-filter-pattern', trend: 'comp-filter-trend' };
    Object.entries(map).forEach(([k, id]) => { const el = $(id); if (!el) return; if (window.MS) MS.set(el, fArr(State.f[k])); else el.value = fArr(State.f[k])[0] || ''; });
  }

  function pill(st) {
    const cls = st === 'Online' ? 'badge-online' : st === 'Partial' ? 'badge-partial' : st === 'Offline' ? 'badge-offline' : 'badge-nodata';
    return `<span class="badge-status-pill ${cls}">${esc(st === 'No Data' ? 'N/A' : st)}</span>`;
  }
  function trendBadge(t) {
    const m = { Drop: ['t-worse', 'Drop'], Recovered: ['t-better', 'Recovered'], Improved: ['t-better', 'Improved'], Unchanged: ['t-persist', 'Unchanged'], Stable: ['t-stable', 'Stable'], Incomplete: ['t-stable', 'Incomplete'] }[t] || ['t-stable', t];
    return `<span class="comp-trend-tag ${m[0]}">${m[1]}</span>`;
  }

  function renderRows(list) {
    const tb = $('comp-table-tbody');
    if (!tb) return;
    setText('comp-count-info', `Showing ${list.length} of ${State.list.length} outlets`);
    if (!list.length) {
      tb.innerHTML = `<tr><td colspan="11" class="comp-empty">No outlets match the current filters.</td></tr>`;
      return;
    }
    tb.innerHTML = list.map((r, i) => `
      <tr data-i="${i}" class="comp-row" title="Click for 3-day root-cause detail">
        <td class="comp-ro-cell">
          <div class="comp-ro-name" title="${esc(r.name)}">${esc(r.name)}</div>
          <div class="comp-ro-meta">${esc(r.area)} · ${esc(r.vendor)}</div>
        </td>
        <td class="comp-cc">${esc(r.cc)}</td>
        <td class="center">${pill(r.st[0])}</td>
        <td class="center">${pill(r.st[1])}</td>
        <td class="center">${pill(r.st[2])}</td>
        <td class="center"><span class="comp-days-down dd-${r.downCount}">${r.downCount}/3</span></td>
        <td>
          <div class="comp-eq ${r.eqFault ? 'eq-bad' : 'eq-ok'}">${esc(r.eqLatestLabel)}</div>
          <div class="comp-eq-sub" title="${esc(r.eqLatestText)}">${esc(r.eqLatestText)}</div>
        </td>
        <td class="comp-pattern">${esc(r.pattern)}</td>
        <td>${trendBadge(r.trend)}</td>
        <td><span class="badge-issue-category ${r.badge}">${esc(r.category)}</span></td>
        <td class="center"><button type="button" class="btn-view-diagnosis">Root-cause</button></td>
      </tr>`).join('');
    tb.querySelectorAll('tr.comp-row').forEach(tr => {
      tr.addEventListener('click', () => openDetail(State.view[+tr.dataset.i]));
    });
    // sort indicators
    document.querySelectorAll('#comparison-main-table th[data-sort]').forEach(th => {
      th.classList.toggle('sort-asc', th.dataset.sort === State.sortField && State.sortAsc);
      th.classList.toggle('sort-desc', th.dataset.sort === State.sortField && !State.sortAsc);
    });
  }

  // ---------------------------------------------------------------------------
  // Detail modal
  // ---------------------------------------------------------------------------
  function explanation(r) {
    const snaps = State.dates.map(d => Store.get(d));
    const lines = [
      `CC ${r.cc} – ${r.name}`,
      `${r.area} | Vendor: ${r.vendor} | EO: ${r.eo} | SO: ${r.so}`,
      '',
      `EOD status (${State.basis === 'colv' ? 'Column V' : 'MPD/ATG telemetry'}):`
    ];
    snaps.forEach((s, i) => {
      const rec = r.recs[i];
      lines.push(`${s.display} → ${r.st[i]}${rec ? ` | MPD ${fmtN(rec.onl_mpd)}/${fmtN(rec.onb_mpd)}, Tank ${fmtN(rec.onl_tnk)}/${fmtN(rec.onb_tnk)}` : ''}`);
    });
    lines.push('', `Pattern: ${r.pattern} | Trend: ${r.trend}`, `Result: ${r.category.toUpperCase()}`, '', `Reason: ${r.reason}`);
    return lines.join('\n');
  }

  function openDetail(r) {
    if (!r) return;
    let modal = $('comp-detail-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'comp-detail-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }
    const snaps = State.dates.map(d => Store.get(d));
    const text = explanation(r);
    modal.innerHTML = `
      <div class="modal-container comp-modal" role="dialog" aria-modal="true" aria-labelledby="comp-modal-title">
        <div class="comp-modal-head">
          <div>
            <span class="badge-issue-category ${r.badge}">${esc(r.category)}</span>
            <h3 id="comp-modal-title">CC ${esc(r.cc)} – ${esc(r.name)}</h3>
            <div class="comp-modal-meta">${esc(r.area)} · Vendor: ${esc(r.vendor)} · EO: ${esc(r.eo)} · SO: ${esc(r.so)}</div>
          </div>
          <button type="button" class="comp-modal-x" aria-label="Close">&times;</button>
        </div>
        <div class="comp-timeline">
          ${snaps.map((s, i) => {
            const rec = r.recs[i];
            const info = sourceInfo(s);
            return `<div class="comp-tl-day">
              <div class="tl-date">${esc(s.display)}</div>
              <div class="tl-src cov-${info.cls}">${esc(info.label)}</div>
              <div class="tl-status">${pill(r.st[i])}</div>
              <div class="tl-row"><span>Column V</span><b>${esc(rec ? (rec.colv_raw || '(blank)') : '—')}</b></div>
              <div class="tl-row"><span>MPD online</span><b>${rec ? `${fmtN(rec.onl_mpd)} / ${fmtN(rec.onb_mpd)}` : '—'}</b></div>
              <div class="tl-row"><span>Tank online</span><b>${rec ? `${fmtN(rec.onl_tnk)} / ${fmtN(rec.onb_tnk)}` : '—'}</b></div>
              <div class="tl-eq ${rec && rec.fault ? 'eq-bad' : 'eq-ok'}">${esc(eqLabel(rec))}</div>
            </div>`;
          }).join('')}
        </div>
        <div class="comp-modal-reason">
          <div class="cmr-tags">${esc(r.pattern)} · ${trendBadge(r.trend)}</div>
          <p>${esc(r.reason)}</p>
        </div>
        <div class="comp-modal-actions">
          <button type="button" class="btn-secondary" id="comp-copy-btn">Copy summary</button>
          <button type="button" class="btn-primary" id="comp-dismiss-btn">Close</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    const close = () => { modal.style.display = 'none'; document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.comp-modal-x').onclick = close;
    $('comp-dismiss-btn').onclick = close;
    modal.onclick = e => { if (e.target === modal) close(); };
    $('comp-copy-btn').onclick = () => {
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => toast('Summary copied to clipboard', 'success'))
        .catch(() => toast('Copy failed — select the text manually.', 'info'));
    };
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  window.exportComparisonData = function () {
    const rows = State.view.length ? State.view : State.list;
    if (!rows.length) { toast('No comparison data to export.', 'error'); return; }
    const snaps = State.dates.map(d => Store.get(d));
    const head = ['CC Code', 'Retail Outlet', 'Sales Area', 'Vendor', 'EO', 'SO',
      ...snaps.map((s, i) => `Day ${i + 1} ${s.display}`),
      ...snaps.map((s, i) => `Day ${i + 1} Column V raw`),
      'Days Down', 'Day 3 MPD online/onboarded', 'Day 3 Tank online/onboarded', 'Day 3 Equipment',
      'Pattern', 'Trend', 'Issue Category', 'Diagnostic Reason'];
    const data = rows.map(r => {
      const l = r.recs[2];
      return [r.cc, r.name, r.area, r.vendor, r.eo, r.so,
        ...r.st, ...r.recs.map(x => x ? x.colv_raw : ''),
        r.downCount,
        l ? `${fmtN(l.onl_mpd)}/${fmtN(l.onb_mpd)}` : '', l ? `${fmtN(l.onl_tnk)}/${fmtN(l.onb_tnk)}` : '',
        r.eqLatestText, r.pattern, r.trend, r.category, r.reason];
    });
    const fname = `BPCL_3Day_Comparison_${State.dates[2]}`;
    const basisLbl = State.basis === 'colv' ? 'Column V (RO\'s Online)' : 'MPD/ATG telemetry';

    if (typeof XLSX !== 'undefined') {
      const wb = XLSX.utils.book_new();
      const count = f => rows.filter(f).length;
      const summary = [
        ['BPCL Belgaum Territory – 3-Day EOD Comparison'],
        ['Period', snaps.map(s => s.display).join(' → ')],
        ['Status basis', basisLbl],
        ['Day sources', snaps.map(s => `${s.display}: ${sourceInfo(s).label}`).join(' | ')],
        ['Filters applied', State.view.length !== State.list.length ? 'Yes – export reflects filtered view' : 'No'],
        ['Generated', new Date().toLocaleString('en-IN')],
        [],
        ['Metric', 'Count'],
        ['Outlets compared', rows.length],
        ['Possible Dealer Issue', count(CAT_FILTERS.DEALER)],
        ['Equipment Issue', count(CAT_FILTERS.EQUIPMENT)],
        ['Requires Verification', count(CAT_FILTERS.VERIFY)],
        ['Normal', count(CAT_FILTERS.NORMAL)],
        ['3-Day Continuous Offline', count(CAT_FILTERS.CONT_OFF)],
        ['3-Day Continuous Partial', count(CAT_FILTERS.CONT_PART)],
        ['Down 2+ days', count(CAT_FILTERS.REPEATED)],
        ['Drop (Day 1 → Day 3)', count(CAT_FILTERS.WORSENED)],
        ['Improved / Recovered', count(CAT_FILTERS.RECOVERED)]
      ];
      const ws1 = XLSX.utils.aoa_to_sheet(summary);
      ws1['!cols'] = [{ wch: 30 }, { wch: 70 }];
      const ws2 = XLSX.utils.aoa_to_sheet([head, ...data]);
      ws2['!cols'] = head.map((h, i) => ({ wch: i === head.length - 1 ? 80 : i === 1 ? 32 : Math.max(10, Math.min(28, h.length + 2)) }));
      ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length, c: head.length - 1 } }) };
      // Hotspots by Sales Area & EO
      const grp = key => {
        const g = {};
        rows.forEach(r => {
          const o = g[r[key]] = g[r[key]] || [r[key], 0, 0, 0, 0, 0, 0];
          o[1]++; if (r.category === 'Possible Dealer Issue') o[2]++; if (r.category === 'Equipment Issue') o[3]++;
          if (r.category === 'Requires Verification') o[4]++; if (r.pattern === '3-Day Continuous Offline') o[5]++; if (r.downCount >= 2) o[6]++;
        });
        return Object.values(g).sort((a, b) => (b[2] + b[3]) - (a[2] + a[3]));
      };
      const hh = ['Total', 'Dealer Issue', 'Equipment Issue', 'Verify', '3-Day Offline', 'Down 2+ Days'];
      const ws3 = XLSX.utils.aoa_to_sheet([['Sales Area', ...hh], ...grp('area'), [], ['EO', ...hh], ...grp('eo'), [], ['SO', ...hh], ...grp('so')]);
      ws3['!cols'] = [{ wch: 30 }, ...hh.map(() => ({ wch: 14 }))];
      XLSX.utils.book_append_sheet(wb, ws1, 'Summary');
      XLSX.utils.book_append_sheet(wb, ws2, 'Outlet Comparison');
      XLSX.utils.book_append_sheet(wb, ws3, 'Hotspots');
      XLSX.writeFile(wb, `${fname}.xlsx`);
    } else {
      const csv = [head, ...data].map(row => row.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `${fname}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    toast(`Exported ${rows.length} outlets.`, 'success');
  };

  // ---------------------------------------------------------------------------
  // Capture, import, auto-capture
  // ---------------------------------------------------------------------------
  window.triggerManualEODSnapshot = async function () {
    const today = ymd(new Date());
    if (Store.captures[today] && !window.confirm(`An EOD snapshot for ${displayDate(today)} already exists (captured ${to12h(Store.captures[today].time)}). Replace it with the currently loaded data?`)) return;
    const h = new Date().getHours();
    if (h < 18 && !window.confirm(`It's ${to12h(hhmm(Date.now()))}. Capturing now will store daytime status as ${displayDate(today)}'s EOD. Continue?`)) return;
    const res = await Store.capture(today);
    toast(res.msg, res.ok ? 'success' : 'error');
    if (res.ok) window.render3DayComparison();
  };

  // Import a past day's MIS/Raw Data Excel into IndexedDB history (does not touch live data)
  async function importPastFile(file, dateStr, timeStr) {
    if (typeof XLSX === 'undefined' || typeof parseRawData !== 'function') throw new Error('Excel parser not available');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    let sheetName = wb.SheetNames.includes('Raw Data') ? 'Raw Data' : (wb.SheetNames.find(n => n.toLowerCase().includes('raw')) || wb.SheetNames[0]);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
    if (rows.length < 3) throw new Error('Sheet has too few rows');

    // parseRawData mutates the global rawDataRows array; back it up and restore
    const backup = window.rawDataRows.slice();
    const modeBackup = window.dashboardMode;
    let parsed;
    try {
      parseRawData(rows);
      parsed = window.rawDataRows.slice();
      if (window.dashboardMode === 'evcs') throw new Error('This looks like an EVCS file, not Automation Raw Data');
    } finally {
      window.rawDataRows.length = 0;
      backup.forEach(r => window.rawDataRows.push(r));
      window.dashboardMode = modeBackup;
    }
    if (!parsed || !parsed.length) throw new Error('No outlet rows found');

    const ts = new Date(`${dateStr}T${timeStr}:00`).getTime();
    const db = await Store.open();
    if (!db) throw new Error('IndexedDB not available');
    await db.saveRecord({
      id: ts, timestamp: ts, date: dateStr, time: timeStr,
      filename: `EOD_Import_${file.name}`,
      metrics: {}, rawData: JSON.parse(JSON.stringify(parsed)), fileBlob: file
    });
    return parsed.length;
  }

  function openImportDialog() {
    let modal = $('comp-import-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'comp-import-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }
    const y = new Date(Date.now() - 86400000);
    modal.innerHTML = `
      <div class="modal-container comp-modal comp-import" role="dialog" aria-modal="true" aria-labelledby="comp-import-title">
        <div class="comp-modal-head">
          <div><h3 id="comp-import-title">Import a past day's EOD file</h3>
          <div class="comp-modal-meta">Adds that day to history for comparison. Live dashboard data is not changed.</div></div>
          <button type="button" class="comp-modal-x" aria-label="Close">&times;</button>
        </div>
        <label class="comp-field">MIS / Raw Data Excel file<input type="file" id="comp-imp-file" accept=".xlsx,.xls,.csv"></label>
        <div class="comp-field-row">
          <label class="comp-field">Date<input type="date" id="comp-imp-date" value="${ymd(y)}" max="${ymd(new Date())}"></label>
          <label class="comp-field">Time of data<input type="time" id="comp-imp-time" value="22:00"></label>
        </div>
        <div class="comp-modal-actions">
          <button type="button" class="btn-secondary" id="comp-imp-cancel">Cancel</button>
          <button type="button" class="btn-primary" id="comp-imp-go">Import</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    const close = () => { modal.style.display = 'none'; };
    modal.querySelector('.comp-modal-x').onclick = close;
    $('comp-imp-cancel').onclick = close;
    modal.onclick = e => { if (e.target === modal) close(); };
    $('comp-imp-go').onclick = async () => {
      const f = $('comp-imp-file').files[0];
      const d = $('comp-imp-date').value;
      const t = $('comp-imp-time').value || '22:00';
      if (!f || !d) { toast('Choose a file and a date.', 'error'); return; }
      const btn = $('comp-imp-go');
      btn.disabled = true; btn.textContent = 'Importing…';
      try {
        const n = await importPastFile(f, d, t);
        toast(`Imported ${n} outlets for ${displayDate(d)}.`, 'success');
        close();
        await window.render3DayComparison({ reload: true });
      } catch (e) {
        console.error(e);
        toast(`Import failed: ${e.message}`, 'error');
        btn.disabled = false; btn.textContent = 'Import';
      }
    };
  }

  let autoBusy = false;
  function startAutoCapture() {
    setInterval(async () => {
      const now = new Date();
      if (now.getHours() < EOD_HOUR || autoBusy) return;
      const today = ymd(now);
      if (Store.captures[today]) return;
      autoBusy = true;
      try {
        // Pull fresh data at 10 PM before capturing, so the EOD reflects the 10 PM sheet
        if (typeof window.syncGoogleSheet === 'function' && navigator.onLine !== false) {
          try { await window.syncGoogleSheet(true); } catch (e) { console.warn('[Comparison] 10 PM sync failed, capturing loaded data', e); }
        }
        if (window.calculatedROs && window.calculatedROs.length && window.dashboardMode !== 'evcs') {
          const res = await Store.capture(today, { auto: true, time: hhmm(Date.now()) });
          if (res.ok) {
            toast(`Automatic 10:00 PM EOD snapshot saved for ${displayDate(today)}`, 'success');
            if ($('tab-comparison')?.classList.contains('active')) window.render3DayComparison({ reload: true });
            else renderAutoStatus();
          }
        }
      } finally {
        autoBusy = false;
      }
    }, 60000);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function setCategory(cat, silent) {
    State.category = cat;
    document.querySelectorAll('.comp-kpi-card[data-cat]').forEach(c => {
      const on = c.dataset.cat === cat;
      c.classList.toggle('active-kpi-filter', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (!silent) refreshTable();
  }

  function setBasis(b) {
    State.basis = b;
    savePrefs();
    document.querySelectorAll('#comp-basis-toggle button').forEach(btn => btn.classList.toggle('is-on', btn.dataset.basis === b));
    window.render3DayComparison();
  }

  function bind() {
    document.querySelectorAll('.comp-kpi-card[data-cat]').forEach(card => {
      const go = () => setCategory(State.category === card.dataset.cat && card.dataset.cat !== 'ALL' ? 'ALL' : card.dataset.cat);
      card.addEventListener('click', go);
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });

    const s = $('comp-search-input');
    if (s) {
      let t;
      s.addEventListener('input', e => {
        clearTimeout(t);
        t = setTimeout(() => { State.search = e.target.value; refreshTable(); }, 150);
      });
    }

    $('comp-apply-dates-btn')?.addEventListener('click', () => {
      const d = [1, 2, 3].map(i => $(`comp-date-select-${i}`).value);
      if (new Set(d).size !== 3) { toast('Pick 3 different dates.', 'error'); return; }
      State.dates = d.sort();
      State.custom = true;
      window.render3DayComparison();
    });
    $('comp-latest-btn')?.addEventListener('click', () => { State.custom = false; window.render3DayComparison(); });
    $('comp-complete-btn')?.addEventListener('click', () => {
      const d = defaultPeriod(true);
      if (d.length < 3) { toast('Need 3 completed days (before today) with data.', 'error'); return; }
      State.dates = d; State.custom = true; window.render3DayComparison();
    });

    $('comp-snapshot-btn')?.addEventListener('click', window.triggerManualEODSnapshot);
    $('comp-export-btn')?.addEventListener('click', window.exportComparisonData);
    $('comp-import-btn')?.addEventListener('click', openImportDialog);
    $('comp-reload-btn')?.addEventListener('click', async () => {
      await window.render3DayComparison({ reload: true });
      toast('Comparison history reloaded.', 'info');
    });

    document.querySelectorAll('#comp-basis-toggle button').forEach(b => b.addEventListener('click', () => setBasis(b.dataset.basis)));

    const filterMap = { 'comp-filter-area': 'area', 'comp-filter-eo': 'eo', 'comp-filter-so': 'so', 'comp-filter-vendor': 'vendor', 'comp-filter-d1-status': 'd1', 'comp-filter-d2-status': 'd2', 'comp-filter-d3-status': 'd3', 'comp-filter-pattern': 'pattern', 'comp-filter-trend': 'trend' };
    Object.entries(filterMap).forEach(([id, k]) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('click', e => e.stopPropagation()); // header selects inside sortable th
      el.addEventListener('change', e => {
        State.f[k] = window.MS ? MS.vals(e.target) : (e.target.value ? [e.target.value] : []);
        if (['area', 'eo', 'so', 'vendor'].includes(k)) renderHotspots(State.list);
        refreshTable();
      });
    });

    document.querySelectorAll('#comparison-main-table th[data-sort]').forEach(th => {
      th.addEventListener('click', e => {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
        const k = th.dataset.sort;
        if (State.sortField === k) State.sortAsc = !State.sortAsc;
        else { State.sortField = k; State.sortAsc = ['name', 'cc', 'area'].includes(k); }
        refreshTable();
      });
    });

    const gb = $('comp-group-by');
    if (gb) {
      gb.value = State.groupBy;
      gb.addEventListener('change', e => { State.groupBy = e.target.value; savePrefs(); renderHotspots(State.list); });
    }
    $('comp-hotspot-toggle')?.addEventListener('click', () => {
      const p = $('comp-hotspot-panel');
      if (!p) return;
      const open = p.classList.toggle('is-collapsed') === false;
      $('comp-hotspot-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
      $('comp-hotspot-toggle').textContent = open ? 'Hide' : 'Show';
    });

    document.querySelectorAll('#comp-basis-toggle button').forEach(btn => btn.classList.toggle('is-on', btn.dataset.basis === State.basis));
  }

  // Called by app.js after every data load / sync
  window.onDashboardDataUpdated = function () {
    Store.loaded = false; // history may have a new record
    if ($('tab-comparison')?.classList.contains('active')) window.render3DayComparison({ reload: true });
  };

  document.addEventListener('DOMContentLoaded', () => {
    loadPrefs();
    bind();
    startAutoCapture();
  });

  // Exposed for debugging / other modules
  window.EODHistoryManager = {
    store: Store,
    state: State,
    parseColumnV,
    capture: date => Store.capture(date || ymd(new Date())),
    dates: () => Store.dates(),
    getSnapshot: d => Store.get(d)
  };
})();
