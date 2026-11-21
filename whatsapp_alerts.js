// whatsapp_alerts.js — Automatic WhatsApp alerts to dealers for status DROPS (Monitoring menu)
//
// Rules (current status vs yesterday's ~10 PM baseline):
//   OFFLINE              -> ensure internet connection (router/SIM/broadband), automation PC/FCC & UPS ON
//   PARTIAL, MPD down    -> Turn ON all MPDs
//   PARTIAL, ATG down    -> restart the ATG console
//   PARTIAL, both        -> both instructions
//   every alert          -> if the problem continues / any technical fault: raise a complaint with the vendor helpdesk
//
// Sending:
//   * Automatic: via the Google Apps Script backend (WhatsApp Cloud API, approved template).
//     The backend only sends to numbers in its DealerContacts sheet and de-duplicates per day.
//   * Manual fallback: "Open in WhatsApp" (wa.me) with the message pre-filled.

(function () {
  'use strict';

  const CFG = Object.assign({
    autoSendDefault: false, sendWindowStart: '08:00', sendWindowEnd: '21:00',
    checkEveryMinutes: 5, maxAlertsPerRoPerDay: 2,
    signature: 'BPCL Belgaum Territory Retail Engineering.'
  }, window.WHATSAPP_ALERT_CONFIG || {});

  const LS_AUTO = 'wa_alert_auto_v1';
  const LS_LOG = 'wa_alert_log_v1';
  const LS_ADMIN = 'wa_alert_admin_key';
  const DB_CONTACTS = 'wa_dealer_contacts_v1';

  const $ = id => document.getElementById(id);
  const toast = (m, t) => { if (typeof showToast === 'function') showToast(m, t || 'info'); };
  const getDB = () => (typeof DB !== 'undefined' ? DB : null);
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const to12h = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const isInt = n => Math.abs(n - Math.round(n)) < 0.001;
  const fmt = n => (isInt(n) ? String(Math.round(n)) : (+n).toFixed(2));

  // ---------------------------------------------------------------------------
  // Status helpers (mirror the Monitoring table so both agree on what a "drop" is)
  // ---------------------------------------------------------------------------
  const NANO_MAP = {
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
  function baselineStatus(item) {
    if (item.status) return item.status;
    const onbMpd = parseInt(item.onb_mpd) || 0, onlMpd = parseInt(item.onl_mpd) || 0;
    const onbTnk = parseInt(item.onb_tnk) || 0, onlTnk = parseInt(item.onl_tnk) || 0;
    let m = 'Offline', t = 'Offline';
    if (onbMpd > 0) m = onlMpd === 0 ? 'Offline' : onlMpd < onbMpd ? 'Partially MPD' : 'Fully online';
    if (onbTnk > 0) t = onlTnk === 0 ? 'Offline' : onlTnk < onbTnk ? 'Partially ATG' : 'Fully online';
    return NANO_MAP[`${m}, ${t}`] || 'Offline';
  }
  function rank(st) {
    st = String(st || '');
    if (st === 'Fully Online') return 3;
    if (st === 'Partially Online' || st.includes('Partially') || st.includes('Communicated') || st.includes('No MPD')) return 2;
    return 1;
  }
  const isMockRecord = rec => !!(rec.fileBlob && typeof rec.fileBlob.size === 'number' && rec.fileBlob.size < 200 && /^Belgaum_Territory_RawData_/.test(rec.filename || ''));

  // ---------------------------------------------------------------------------
  // Alert rules
  // ---------------------------------------------------------------------------
  function alertKind(ro) {
    if (ro.status === 'Offline') return 'OFFLINE';
    const mpd = (ro.off_mpd || 0) > 0, atg = (ro.off_tnk || 0) > 0;
    if (mpd && atg) return 'MPD_ATG';
    if (mpd) return 'MPD';
    if (atg) return 'ATG';
    return 'PARTIAL';
  }
  const KIND_LABEL = { OFFLINE: 'Offline – internet', MPD: 'MPD offline', ATG: 'ATG offline', MPD_ATG: 'MPD + ATG offline', PARTIAL: 'Partial' };

  function actionText(ro, kind) {
    const offM = ro.off_mpd || 0, onbM = ro.onb_mpd || 0, offT = ro.off_tnk || 0, onbT = ro.onb_tnk || 0;
    const mpdTxt = (isInt(offM) && isInt(onbM) ? `${fmt(offM)} of ${fmt(onbM)} MPD${onbM === 1 ? ' is' : 's are'} not communicating.` : 'MPD data is not communicating fully.') +
      ' Please Turn ON all MPDs and make sure they are connected to the automation system.';
    const atgTxt = (isInt(offT) && isInt(onbT) ? `ATG data for ${fmt(offT)} of ${fmt(onbT)} tank${onbT === 1 ? '' : 's'} is not communicating.` : 'ATG (tank gauge) data is not communicating fully.') +
      ' Please restart the ATG console and check that it is powered ON.';
    switch (kind) {
      case 'OFFLINE': return 'Your outlet automation is showing OFFLINE. Please make sure the internet connection is working (router/modem ON, SIM or broadband active with data balance) and that the automation FCC is switched ON and the HOS status is green.';
      case 'MPD': return mpdTxt;
      case 'ATG': return atgTxt;
      case 'MPD_ATG': return `${mpdTxt} Also: ${atgTxt}`;
      default: return 'Some equipment at your outlet is not communicating. Please check that all MPDs and the ATG console are switched ON and connected.';
    }
  }
  const COMPLAINT_TEXT = 'If the problem continues after these checks, or there is any technical fault in the equipment, please raise a complaint with the Automation vendor / automation helpdesk immediately and share the complaint number with your Sales Officer.';
  function helpdesk() { return 'the Automation vendor / automation helpdesk'; }
  function complaintText() { return COMPLAINT_TEXT; }
  // e.g. "11:15 PM, 14 Nov" (same format the backend uses)
  function stamp(d) { return `${to12h(hhmm(d))}, ${d.getDate()} ${d.toLocaleString('en-IN', { month: 'short' })}`; }

  function buildAlert(ro, prev) {
    const kind = alertKind(ro);
    const contact = Contacts.get(ro.roid);
    const now = new Date();
    const alert = {
      roid: String(ro.roid), kind, outletName: ro.outlet_name, vendor: ro.vendor || '', salesArea: ro.sales_area || '',
      soName: ro.so_name || '', currStatus: ro.status, prevStatus: prev || '',
      onbMpd: +(ro.onb_mpd || 0), offMpd: +(ro.off_mpd || 0), onbTnk: +(ro.onb_tnk || 0), offTnk: +(ro.off_tnk || 0),
      helpdesk: helpdesk(ro.vendor), dealerName: contact ? contact.dealerName : ''
    };
    alert.action = actionText(ro, kind);
    alert.complaint = complaintText(ro.vendor);
    alert.text = [
      '*BPCL Automation Alert*',
      `RO: ${ro.outlet_name} (CC ${ro.roid})`,
      `Current Status: ${ro.status}`,
      `Yesterday Status: ${prev ? `was ${prev}` : 'not available'} as of ${stamp(now)}`,
      '',
      `*Action needed:* ${alert.action}`,
      '',
      alert.complaint,
      '',
      `– ${CFG.signature}`
    ].join('\n');
    return alert;
  }

  // ---------------------------------------------------------------------------
  // Dealer contacts (full numbers kept locally on the admin's device; the
  // backend holds its own copy and only returns masked numbers)
  // ---------------------------------------------------------------------------
  const Contacts = {
    local: {},   // roid -> {dealerName, phone}
    server: {},  // roid -> {dealerName, masked, active}
    async load() {
      const db = getDB();
      try { if (db && !db.db) await db.open(); this.local = (db && await db.get('config', DB_CONTACTS)) || {}; } catch (e) { this.local = {}; }
    },
    async saveLocal(map) {
      this.local = map;
      const db = getDB();
      try { if (db && !db.db) await db.open(); if (db) await db.set('config', DB_CONTACTS, map); } catch (e) { console.warn(e); }
    },
    get(roid) {
      const k = String(roid);
      if (this.local[k]) return { dealerName: this.local[k].dealerName, phone: this.local[k].phone, masked: mask(this.local[k].phone), active: true };
      if (this.server[k]) return this.server[k];
      return null;
    },
    hasServer(roid) { const s = this.server[String(roid)]; return !!(s && s.active !== false); },
    count() { return new Set([...Object.keys(this.local), ...Object.keys(this.server)]).size; }
  };
  function normPhone(v) {
    let d = String(v == null ? '' : v).replace(/\.0+$/, '').replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10) d = '91' + d;
    return d.length >= 11 && d.length <= 15 ? d : '';
  }
  function mask(p) { p = String(p || ''); return p.length > 6 ? `${p.slice(0, 4)}XXXX${p.slice(-3)}` : p; }

  // ---------------------------------------------------------------------------
  // Alert log (local mirror of the backend log, per day)
  // ---------------------------------------------------------------------------
  const Log = {
    data: {},
    load() { try { this.data = JSON.parse(localStorage.getItem(LS_LOG) || '{}'); } catch (e) { this.data = {}; } this.prune(); },
    save() { try { localStorage.setItem(LS_LOG, JSON.stringify(this.data)); } catch (e) { /* ignore */ } },
    prune() { const cut = ymd(new Date(Date.now() - 7 * 86400000)); Object.keys(this.data).forEach(d => { if (d < cut) delete this.data[d]; }); },
    today() { const d = ymd(new Date()); return (this.data[d] = this.data[d] || {}); },
    get(roid, kind) { return this.today()[`${roid}|${kind}`] || null; },
    forRo(roid) { const t = this.today(); return Object.keys(t).filter(k => k.startsWith(roid + '|')).map(k => Object.assign({ key: k }, t[k])); },
    set(roid, kind, entry) { this.today()[`${roid}|${kind}`] = Object.assign({ time: hhmm(new Date()) }, entry); this.save(); },
    sentCount(roid) { return this.forRo(roid).filter(e => e.result === 'sent').length; }
  };

  // ---------------------------------------------------------------------------
  // Backend
  // ---------------------------------------------------------------------------
  const Backend = {
    state: 'unknown', // unknown | ready | not_configured | unreachable
    message: '',
    async call(payload) {
      if (typeof window.dayMonitoringApiRequest !== 'function') throw new Error('Backend helper not loaded');
      const res = await window.dayMonitoringApiRequest('POST', payload);
      if (!res || res.success === false) throw new Error((res && res.message) || 'Backend error');
      return res;
    },
    async status() {
      try {
        const res = await this.call({ action: 'waStatus', date: ymd(new Date()) });
        this.state = res.configured ? 'ready' : 'not_configured';
        this.message = res.configured ? `Template “${res.template}” · ${res.sentToday || 0} sent today` : (res.message || 'WhatsApp token not set in Apps Script');
        Contacts.server = {};
        (res.contacts || []).forEach(c => { Contacts.server[String(c.roid)] = { dealerName: c.dealerName, masked: c.masked, active: c.active !== false }; });
        (res.log || []).forEach(e => {
          if (e.date !== ymd(new Date())) return;
          const cur = Log.get(e.roid, e.kind);
          if (!cur || cur.result !== 'sent') Log.set(e.roid, e.kind, { result: e.result, time: e.time, via: 'api', detail: e.detail || '' });
        });
      } catch (e) {
        const msg = String(e.message || e);
        this.state = /Unsupported POST action/i.test(msg) ? 'not_configured' : 'unreachable';
        this.message = /Unsupported POST action/i.test(msg) ? 'Backend Code.gs not updated for WhatsApp yet' : msg;
      }
      renderPanel();
      return this.state;
    },
    async send(alerts) {
      const res = await this.call({ action: 'sendAlerts', date: ymd(new Date()), maxPerRo: CFG.maxAlertsPerRoPerDay, alerts: alerts.map(a => ({
        roid: a.roid, kind: a.kind, outletName: a.outletName, vendor: a.vendor, currStatus: a.currStatus, prevStatus: a.prevStatus,
        onbMpd: a.onbMpd, offMpd: a.offMpd, onbTnk: a.onbTnk, offTnk: a.offTnk, helpdesk: a.helpdesk, sentBy: currentUserName()
      })) });
      return res.results || [];
    },
    async saveContacts(rows, adminKey) {
      return this.call({ action: 'saveContacts', adminKey, contacts: rows });
    }
  };
  function currentUserName() { return (window.currentUser && window.currentUser.username) || 'Dashboard'; }

  // ---------------------------------------------------------------------------
  // Drop detection (current data vs yesterday ~10 PM)
  // ---------------------------------------------------------------------------
  const Drops = { list: [], baseline: null, map: {} };

  async function computeDrops() {
    Drops.list = []; Drops.map = {}; Drops.baseline = null;
    const live = window.calculatedROs || [];
    if (!live.length || window.dashboardMode === 'evcs') return Drops;
    const db = getDB();
    if (!db) return Drops;
    try { if (!db.db) await db.open(); } catch (e) { return Drops; }
    let records = [];
    try { records = await db.getAllRecords(); } catch (e) { return Drops; }
    records = records.filter(r => r && Array.isArray(r.rawData) && r.rawData.length && !isMockRecord(r) && typeof r.rawData[0] === 'object' && !Array.isArray(r.rawData[0]));
    if (!records.length) return Drops;

    const today = new Date();
    const yStr = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
    const yRecs = records.filter(r => r.date === yStr);
    let base = null, best = Infinity;
    yRecs.forEach(r => {
      const [h, m] = String(r.time || '00:00').split(':').map(Number);
      const diff = Math.abs(h * 60 + m - 22 * 60);
      if (diff < best) { best = diff; base = r; }
    });
    if (!base) return Drops; // no real baseline for yesterday -> no automatic alerts
    Drops.baseline = base;
    const bmap = {};
    base.rawData.forEach(it => { if (it && it.roid) bmap[String(it.roid).replace(/\.0+$/, '')] = baselineStatus(it); });
    live.forEach(ro => {
      const prev = bmap[String(ro.roid)];
      if (!prev) return;
      if (rank(ro.status) < rank(prev)) {
        const a = buildAlert(ro, prev);
        Drops.list.push(a);
        Drops.map[a.roid] = a;
      }
    });
    return Drops;
  }

  // ---------------------------------------------------------------------------
  // Auto-send
  // ---------------------------------------------------------------------------
  function autoOn() {
    try { const v = localStorage.getItem(LS_AUTO); return v === null ? !!CFG.autoSendDefault : v === '1'; } catch (e) { return false; }
  }
  function inWindow(d = new Date()) {
    const t = hhmm(d);
    return t >= CFG.sendWindowStart && t < CFG.sendWindowEnd;
  }
  // Drops that have a dealer number and haven't been alerted yet today
  function pendingAlerts() {
    return Drops.list.filter(a => {
      if (!Contacts.get(a.roid)) return false;
      const e = Log.get(a.roid, a.kind);
      if (e && (e.result === 'sent' || e.result === 'duplicate')) return false;
      if (Log.sentCount(a.roid) >= CFG.maxAlertsPerRoPerDay) return false;
      return true;
    });
  }

  let running = false;
  async function runAuto(reason) {
    if (running) return;
    running = true;
    try {
      await computeDrops();
      if (!autoOn() || !inWindow()) return;
      if (Backend.state === 'unknown') await Backend.status();
      if (Backend.state !== 'ready') return;
      const pending = pendingAlerts().filter(a => Contacts.hasServer(a.roid));
      if (!pending.length) return;
      await sendBatch(pending, 'auto');
    } catch (e) {
      console.warn('[WA alerts] auto run failed', e);
    } finally {
      running = false;
      renderPanel();
      refreshTableCells();
    }
  }

  async function sendBatch(alerts, via) {
    let sent = 0, failed = 0, noContact = 0;
    for (let i = 0; i < alerts.length; i += 40) {
      const chunk = alerts.slice(i, i + 40);
      let results;
      try { results = await Backend.send(chunk); }
      catch (e) { chunk.forEach(a => Log.set(a.roid, a.kind, { result: 'failed', via, detail: String(e.message || e) })); failed += chunk.length; continue; }
      results.forEach(r => {
        Log.set(r.roid, r.kind, { result: r.result, via, detail: r.detail || '' });
        if (r.result === 'sent') sent++; else if (r.result === 'no_contact') noContact++; else if (r.result !== 'duplicate') failed++;
      });
    }
    if (via === 'auto' && sent) toast(`WhatsApp: ${sent} dealer alert${sent > 1 ? 's' : ''} sent automatically`, 'success');
    if (via !== 'auto') toast(`WhatsApp: ${sent} sent${failed ? `, ${failed} failed` : ''}${noContact ? `, ${noContact} without number` : ''}`, failed ? 'error' : 'success');
    return { sent, failed, noContact };
  }

  // ---------------------------------------------------------------------------
  // UI: panel in Monitoring tab
  // ---------------------------------------------------------------------------
  function renderPanel() {
    const box = $('wa-alert-panel');
    if (!box) return;
    const drops = Drops.list;
    const sent = drops.filter(a => (Log.get(a.roid, a.kind) || {}).result === 'sent').length;
    const noNum = drops.filter(a => !Contacts.get(a.roid)).length;
    const pending = pendingAlerts().length;
    const st = Backend.state;
    const chip = st === 'ready' ? ['ok', 'WhatsApp API connected'] : st === 'not_configured' ? ['warn', 'WhatsApp API not set up'] : st === 'unreachable' ? ['bad', 'Backend unreachable'] : ['idle', 'Checking backend…'];
    const isAdmin = !window.currentUser || window.currentUser.role === 'admin';
    const base = Drops.baseline ? `${Drops.baseline.date} ${to12h(Drops.baseline.time)}` : 'no baseline for yesterday';
    const win = inWindow();

    $('wa-status-chip').className = `wa-chip wa-chip-${chip[0]}`;
    $('wa-status-chip').textContent = chip[1];
    $('wa-status-chip').title = Backend.message || '';
    $('wa-stat-drops').textContent = drops.length;
    $('wa-stat-sent').textContent = sent;
    $('wa-stat-pending').textContent = pending;
    $('wa-stat-nonum').textContent = noNum;
    $('wa-baseline').textContent = `Drops vs ${base} · ${Contacts.count()} dealer numbers on file`;
    const auto = $('wa-auto-toggle');
    if (auto) auto.checked = autoOn();
    const note = $('wa-auto-note');
    if (note) {
      note.textContent = !autoOn() ? 'Auto-send is off on this device.'
        : st !== 'ready' ? 'Auto-send is on, waiting for the WhatsApp backend to be set up.'
        : !win ? `Outside sending hours (${to12h(CFG.sendWindowStart)}–${to12h(CFG.sendWindowEnd)}). Pending alerts go out when the window opens.`
        : `On · checks every ${CFG.checkEveryMinutes} min and after every sync, while this dashboard is open.`;
    }
    ['wa-upload-btn', 'wa-template-btn'].forEach(id => { const b = $(id); if (b) b.style.display = isAdmin ? '' : 'none'; });
    const sendBtn = $('wa-send-now-btn');
    if (sendBtn) sendBtn.disabled = !pending || st !== 'ready';

    // Today's log
    const t = Log.today();
    const rows = Object.entries(t).sort((a, b) => (b[1].time || '').localeCompare(a[1].time || '')).slice(0, 30);
    const lb = $('wa-log-body');
    if (lb) {
      const nameOf = roid => { const ro = (window.calculatedROs || []).find(r => String(r.roid) === roid); return ro ? ro.outlet_name : ''; };
      lb.innerHTML = rows.length ? rows.map(([k, e]) => {
        const [roid, kind] = k.split('|');
        return `<tr><td>${esc(to12h(e.time))}</td><td><b>${esc(roid)}</b> ${esc(nameOf(roid))}</td><td>${esc(KIND_LABEL[kind] || kind)}</td><td><span class="wa-res wa-res-${esc(e.result)}">${esc(resultLabel(e.result))}</span></td><td>${esc(e.via === 'auto' ? 'Auto' : e.via === 'link' ? 'WhatsApp app' : 'Manual')}</td></tr>`;
      }).join('') : `<tr><td colspan="5" class="wa-empty">No alerts sent today.</td></tr>`;
    }
  }
  function resultLabel(r) {
    return { sent: 'Sent', failed: 'Failed', no_contact: 'No number', duplicate: 'Already sent', limit: 'Daily limit', opened: 'Opened in WhatsApp' }[r] || r;
  }

  // Cell in the Monitoring table (called by app.js for each row)
  function cellHtml(ro, prevStatus) {
    const roid = String(ro.roid);
    let a = Drops.map[roid];
    if (!a) {
      if (!prevStatus || rank(ro.status) >= rank(prevStatus)) return '<span class="wa-dash">—</span>';
      a = buildAlert(ro, prevStatus);
    }
    const e = Log.get(roid, a.kind);
    const c = Contacts.get(roid);
    let badge;
    if (e && e.result === 'sent') badge = `<span class="wa-res wa-res-sent" title="${esc(KIND_LABEL[a.kind])}">Sent ${esc(to12h(e.time))}</span>`;
    else if (e && e.result === 'opened') badge = `<span class="wa-res wa-res-opened">Opened ${esc(to12h(e.time))}</span>`;
    else if (e && e.result === 'failed') badge = `<span class="wa-res wa-res-failed" title="${esc(e.detail || '')}">Failed</span>`;
    else if (!c) badge = `<span class="wa-res wa-res-no_contact">No number</span>`;
    else badge = `<span class="wa-res wa-res-pending">Pending</span>`;
    return `<div class="wa-cell">${badge}<button type="button" class="wa-btn-mini" data-wa-roid="${esc(roid)}" data-wa-prev="${esc(prevStatus || a.prevStatus)}" title="Preview / send WhatsApp alert">WhatsApp</button><div class="wa-kind">${esc(KIND_LABEL[a.kind])}</div></div>`;
  }
  function refreshTableCells() {
    if ($('tab-monitoring')?.classList.contains('active') && typeof window.renderMonitoringComparison === 'function') {
      window.renderMonitoringComparison();
    }
  }

  // Preview modal
  function openPreview(roid, prev) {
    const ro = (window.calculatedROs || []).find(r => String(r.roid) === String(roid));
    if (!ro) return;
    const a = Drops.map[String(roid)] && (!prev || Drops.map[String(roid)].prevStatus === prev) ? Drops.map[String(roid)] : buildAlert(ro, prev);
    const c = Contacts.get(roid);
    const e = Log.get(a.roid, a.kind);
    let modal = $('wa-preview-modal');
    if (!modal) { modal = document.createElement('div'); modal.id = 'wa-preview-modal'; modal.className = 'modal-overlay'; document.body.appendChild(modal); }
    const apiReady = Backend.state === 'ready' && Contacts.hasServer(roid);
    modal.innerHTML = `
      <div class="modal-container wa-modal" role="dialog" aria-modal="true" aria-labelledby="wa-modal-title">
        <div class="wa-modal-head">
          <div>
            <span class="wa-kind-tag wa-kind-${a.kind}">${esc(KIND_LABEL[a.kind])}</span>
            <h3 id="wa-modal-title">${esc(ro.outlet_name)} · CC ${esc(roid)}</h3>
            <div class="wa-modal-meta">${esc(a.prevStatus || '?')} → <b>${esc(ro.status)}</b> · ${esc(ro.vendor || '')} · Dealer: ${c ? `${esc(c.dealerName || '—')} (${esc(c.masked || mask(c.phone))})` : '<span class="wa-warn">no WhatsApp number on file</span>'}</div>
          </div>
          <button type="button" class="wa-x" aria-label="Close">&times;</button>
        </div>
        <div class="wa-bubble">${esc(a.text).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</div>
        ${e ? `<div class="wa-modal-meta">Today: ${esc(resultLabel(e.result))} at ${esc(to12h(e.time))}${e.detail ? ` – ${esc(e.detail)}` : ''}</div>` : ''}
        <div class="wa-modal-actions">
          <button type="button" class="btn-secondary" id="wa-copy">Copy text</button>
          <button type="button" class="btn-secondary" id="wa-open">Open in WhatsApp</button>
          <button type="button" class="btn-primary" id="wa-send" ${apiReady ? '' : 'disabled'} title="${apiReady ? 'Send now through WhatsApp Business API' : 'Needs the WhatsApp API set up and this dealer\'s number in the backend'}">Send now</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    const close = () => { modal.style.display = 'none'; document.removeEventListener('keydown', onKey); };
    const onKey = ev => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.wa-x').onclick = close;
    modal.onclick = ev => { if (ev.target === modal) close(); };
    $('wa-copy').onclick = () => navigator.clipboard?.writeText(a.text).then(() => toast('Message copied', 'success')).catch(() => toast('Copy failed', 'error'));
    $('wa-open').onclick = () => {
      const phone = c && c.phone ? c.phone : '';
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(a.text)}`, '_blank', 'noopener');
      if (!e || e.result !== 'sent') Log.set(a.roid, a.kind, { result: 'opened', via: 'link' });
      renderPanel(); refreshTableCells();
    };
    $('wa-send').onclick = async () => {
      const btn = $('wa-send'); btn.disabled = true; btn.textContent = 'Sending…';
      await sendBatch([a], 'manual');
      close(); renderPanel(); refreshTableCells();
    };
  }

  // Contacts upload / template
  async function handleUpload(file) {
    if (typeof XLSX === 'undefined') { toast('Excel library not loaded', 'error'); return; }
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    let hi = rows.findIndex(r => r.some(c => /cc\s*code|ro\s*id|roid|sap/i.test(String(c))));
    if (hi < 0) { toast('Could not find a CC Code / ROID column', 'error'); return; }
    const h = rows[hi].map(c => String(c).toLowerCase().trim());
    const ci = h.findIndex(x => /cc\s*code|ro\s*id|roid|sap/.test(x));
    const ni = h.findIndex(x => /dealer|name of dealer|proprietor|contact name/.test(x) && !/ro name|outlet/.test(x));
    const pi = h.findIndex(x => /whats\s*app|mobile|phone|contact no|number/.test(x));
    if (pi < 0) { toast('Could not find a WhatsApp / Mobile number column', 'error'); return; }
    const map = {}, list = []; let bad = 0;
    rows.slice(hi + 1).forEach(r => {
      const roid = String(r[ci] || '').trim().replace(/\.0+$/, '');
      if (!roid) return;
      const phone = normPhone(r[pi]);
      if (!phone) { if (String(r[pi]).trim()) bad++; return; }
      const dealerName = ni >= 0 ? String(r[ni] || '').trim() : '';
      map[roid] = { dealerName, phone };
      list.push({ roid, dealerName, phone, active: true });
    });
    if (!list.length) { toast('No valid numbers found in the file', 'error'); return; }
    await Contacts.saveLocal(map);
    let serverMsg = '';
    try {
      let key = '';
      try { key = localStorage.getItem(LS_ADMIN) || ''; } catch (e) { /* ignore */ }
      if (!key) key = (window.prompt('Enter the WhatsApp admin key (set as ADMIN_KEY in Apps Script) to upload numbers to the backend. Leave blank to keep them on this device only.') || '').trim();
      if (key) {
        const res = await Backend.saveContacts(list, key);
        try { localStorage.setItem(LS_ADMIN, key); } catch (e) { /* ignore */ }
        serverMsg = ` · ${res.saved} saved to backend`;
        await Backend.status();
      } else serverMsg = ' · saved on this device only';
    } catch (e) {
      try { localStorage.removeItem(LS_ADMIN); } catch (er) { /* ignore */ }
      serverMsg = ` · backend upload failed: ${e.message}`;
    }
    toast(`${list.length} dealer numbers loaded${bad ? ` (${bad} invalid skipped)` : ''}${serverMsg}`, /failed/.test(serverMsg) ? 'error' : 'success');
    await computeDrops(); renderPanel(); refreshTableCells();
  }

  function downloadTemplate() {
    if (typeof XLSX === 'undefined') return;
    const mapping = window.activeMappings || {};
    const ros = (window.calculatedROs && window.calculatedROs.length) ? window.calculatedROs.map(r => [r.roid, r.outlet_name, r.sales_area, r.vendor]) : Object.entries(mapping).map(([k, v]) => [k, v.outlet_name, '', '']);
    const aoa = [['CC Code', 'RO Name', 'Sales Area', 'Vendor', 'Dealer Name', 'WhatsApp Number']];
    ros.sort((a, b) => String(a[0]).localeCompare(String(b[0]))).forEach(r => {
      const c = Contacts.local[String(r[0])];
      aoa.push([...r, c ? c.dealerName : '', c ? c.phone : '']);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 10 }, { wch: 36 }, { wch: 16 }, { wch: 12 }, { wch: 26 }, { wch: 18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dealer Contacts');
    XLSX.writeFile(wb, 'Dealer_WhatsApp_Contacts.xlsx');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function bind() {
    $('wa-auto-toggle')?.addEventListener('change', e => {
      try { localStorage.setItem(LS_AUTO, e.target.checked ? '1' : '0'); } catch (er) { /* ignore */ }
      renderPanel();
      if (e.target.checked) runAuto('toggle');
    });
    $('wa-send-now-btn')?.addEventListener('click', async () => {
      const pend = pendingAlerts();
      if (!pend.length) return;
      const withNum = pend.filter(a => Contacts.hasServer(a.roid));
      if (!withNum.length) { toast('None of the pending sites have a number in the backend.', 'error'); return; }
      if (!window.confirm(`Send WhatsApp alerts to ${withNum.length} dealer${withNum.length > 1 ? 's' : ''} now?`)) return;
      await sendBatch(withNum, 'manual');
      renderPanel(); refreshTableCells();
    });
    $('wa-upload-btn')?.addEventListener('click', () => $('wa-upload-input')?.click());
    $('wa-upload-input')?.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) handleUpload(f); });
    $('wa-template-btn')?.addEventListener('click', downloadTemplate);
    $('wa-refresh-btn')?.addEventListener('click', async () => { await Backend.status(); await computeDrops(); renderPanel(); refreshTableCells(); });
    $('wa-log-toggle')?.addEventListener('click', () => {
      const w = $('wa-log-wrap'); const open = w.classList.toggle('is-open');
      $('wa-log-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
      $('wa-log-toggle').textContent = open ? 'Hide today\'s log' : 'Show today\'s log';
    });
    // Delegated click for table buttons
    document.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('[data-wa-roid]');
      if (b) { e.preventDefault(); openPreview(b.dataset.waRoid, b.dataset.waPrev); }
    });
  }

  // Chain into the dashboard's data-updated hook (comparison.js also uses it)
  function hookDataUpdates() {
    const prev = window.onDashboardDataUpdated;
    window.onDashboardDataUpdated = function () {
      try { if (typeof prev === 'function') prev.apply(this, arguments); } finally { setTimeout(() => runAuto('data'), 1500); }
    };
  }

  window.WhatsAppAlerts = {
    cellHtml, openPreview, buildAlert, alertKind, actionText, computeDrops, runAuto,
    drops: () => Drops.list, contacts: Contacts, log: Log, backend: Backend, config: CFG
  };

  document.addEventListener('DOMContentLoaded', async () => {
    Log.load();
    await Contacts.load();
    bind();
    hookDataUpdates();
    renderPanel();
    Backend.status().then(() => runAuto('start'));
    setInterval(() => runAuto('timer'), Math.max(1, CFG.checkEveryMinutes) * 60000);
  });
})();
