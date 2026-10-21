// new_logic_dashboard.js - Automation Uptime MIS Dashboard
// Full parity with automation_mis_dashboard.html & Automation_MIS_Dynamic_Uptime_Dashboard.xlsx

(function() {
  'use strict';

  const $ = id => document.getElementById(id);
  let allRows = [], headers = [], filteredRows = [];

  const aliases = {
    id: ['RO ID', 'ROID', 'roid', 'ro_id', 'BL Code', 'CC Code', 'Outlet Code'],
    name: ['Retail Outlet', 'outlet_name', 'RO Name', 'Outlet Name', 'Station Name'],
    vendor: ['RA Vendor', 'vendor', 'Vendor', 'ra_vendor'],
    area: ['Sales Area', 'sales_area', 'SalesArea', 'Area'],
    mpdOn: ['No. of On-Boarded MPDs', 'MPD Onboarded', 'onb_mpd', 'On-Boarded MPDs', 'MPD On-Boarded'],
    mpdOnline: ['No. of Online MPDs', 'MPD Online', 'onl_mpd', 'Online MPDs'],
    atgOn: ['No. of On-Boarded Tanks', 'ATG Onboarded', 'onb_tnk', 'On-Boarded Tanks', 'Tank Onboarded', 'No. of On-Boarded ATG'],
    atgOnline: ['No. of Online Tanks', 'ATG Online', 'onl_tnk', 'Online Tanks', 'Tank Online', 'No. of Online ATG'],
    mpdPct: ['MPD Online%', 'MPD Online %', 'mpd_online_pct', 'MPD Online pct'],
    atgPct: ['Tank Online%', 'Tank Online %', 'ATG Online%', 'ATG Online %', 'tank_online_pct', 'atg_online_pct'],
    roStatus: ["RO's Online", 'RO Online', 'RO Status', 'Outlet Status', 'ro_online_status', 'status']
  };

  function norm(s) {
    return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function keyMap(obj) {
    let m = {};
    if (obj) {
      Object.keys(obj).forEach(k => m[norm(k)] = k);
    }
    return m;
  }

  function getCol(row, key) {
    if (!row) return '';
    const keyCandidates = aliases[key] || [];
    for (const a of keyCandidates) {
      if (row[a] !== undefined && row[a] !== null && row[a] !== '') return row[a];
    }
    // Case/spacing-insensitive fallback
    const rowKeys = Object.keys(row);
    for (const a of keyCandidates) {
      const target = norm(a);
      const foundKey = rowKeys.find(k => norm(k) === target);
      if (foundKey && row[foundKey] !== undefined && row[foundKey] !== null && row[foundKey] !== '') {
        return row[foundKey];
      }
    }
    return '';
  }

  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v === null || v === undefined || String(v).trim() === '') return NaN;
    let s = String(v).trim().replace(/,/g, '').replace('%', '');
    let n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return String(v).includes('%') ? n / 100 : n;
  }

  function pctValue(v) {
    let n = num(v);
    if (!Number.isFinite(n)) return NaN;
    return n > 1 && n <= 100 ? n / 100 : n;
  }

  function fmtPct(v) {
    return Number.isFinite(v) ? (v * 100).toFixed(2) + '%' : '—';
  }

  function fmtNum(v) {
    return Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function sum(rows, key) {
    return rows.reduce((a, r) => {
      let n = num(getCol(r, key));
      return a + (Number.isFinite(n) ? n : 0);
    }, 0);
  }

  function averagePct(rows, key) {
    let vals = rows.map(r => pctValue(getCol(r, key))).filter(v => Number.isFinite(v) && v >= 0 && v <= 1);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  }

  function setMetric(id, bar, val) {
    const el = $(id);
    const barEl = $(bar);
    if (el) el.textContent = fmtPct(val);
    if (barEl) barEl.style.width = (Number.isFinite(val) ? Math.max(0, Math.min(100, val * 100)) : 0) + '%';
  }

  function findRawSheet(wb) {
    let exact = wb.SheetNames.find(n => norm(n) === 'raw data');
    return exact || wb.SheetNames.find(n => norm(n).includes('raw')) || wb.SheetNames[0];
  }

  function statusOf(r) {
    let s = String(getCol(r, 'roStatus') || '').trim();
    if (s) return s;
    let mo = num(getCol(r, 'mpdOn')), mp = num(getCol(r, 'mpdOnline')), ao = num(getCol(r, 'atgOn')), ap = num(getCol(r, 'atgOnline'));
    if ([mo, mp, ao, ap].some(Number.isFinite)) {
      if ((!Number.isFinite(mp) || mp === 0) && (!Number.isFinite(ap) || ap === 0)) return 'Offline';
      if ((Number.isFinite(mo) && Number.isFinite(mp) && mp < mo) || (Number.isFinite(ao) && Number.isFinite(ap) && ap < ao)) return 'Partially Online';
      return 'Fully Online';
    }
    return 'Unknown';
  }

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function render() {
    if (!allRows || !allRows.length) {
      if ($('empty')) $('empty').style.display = 'block';
      if ($('dashboard')) $('dashboard').style.display = 'none';
      return;
    }
    if ($('empty')) $('empty').style.display = 'none';
    if ($('dashboard')) $('dashboard').style.display = 'block';

    const totalMPDOn = sum(allRows, 'mpdOn');
    const totalMPDOnline = sum(allRows, 'mpdOnline');
    const totalATGOn = sum(allRows, 'atgOn');
    const totalATGOnline = sum(allRows, 'atgOnline');

    const mpdEq = totalMPDOn ? totalMPDOnline / totalMPDOn : NaN;
    const atgEq = totalATGOn ? totalATGOnline / totalATGOn : NaN;
    const mpd2 = averagePct(allRows, 'mpdPct');
    const atg2 = averagePct(allRows, 'atgPct');

    setMetric('mpdEquip', 'mpdEquipBar', mpdEq);
    setMetric('atgEquip', 'atgEquipBar', atgEq);
    setMetric('mpd2', 'mpd2Bar', mpd2);
    setMetric('atg2', 'atg2Bar', atg2);

    if ($('mpdEquipSub')) {
      $('mpdEquipSub').textContent = `${fmtNum(totalMPDOnline)} online / ${fmtNum(totalMPDOn)} onboarded · ${fmtNum(totalMPDOn - totalMPDOnline)} offline`;
    }
    if ($('atgEquipSub')) {
      $('atgEquipSub').textContent = `${fmtNum(totalATGOnline)} online / ${fmtNum(totalATGOn)} onboarded · ${fmtNum(totalATGOn - totalATGOnline)} offline`;
    }

    const statuses = {};
    allRows.forEach(r => {
      let s = statusOf(r);
      statuses[s] = (statuses[s] || 0) + 1;
    });

    const total = allRows.length;
    const fully = Object.entries(statuses).filter(([s]) => norm(s).includes('fully')).reduce((a, [, v]) => a + v, 0);
    const affected = Object.entries(statuses).filter(([s]) => norm(s).includes('offline') || norm(s).includes('partial')).reduce((a, [, v]) => a + v, 0);

    if ($('totalRO')) $('totalRO').textContent = fmtNum(total);
    if ($('fullyRO')) $('fullyRO').textContent = fmtNum(fully);
    if ($('fullyPct')) $('fullyPct').textContent = fmtPct(fully / total) + ' of outlets';
    if ($('affectedRO')) $('affectedRO').textContent = fmtNum(affected);
    if ($('affectedPct')) $('affectedPct').textContent = fmtPct(affected / total) + ' of outlets';

    renderBars('statusBars', statuses, total);

    const mpdGap = totalMPDOn - totalMPDOnline;
    const atgGap = totalATGOn - totalATGOnline;
    if ($('equipmentTable')) {
      $('equipmentTable').innerHTML = `
        <tr><td>Onboarded units</td><td class="num">${fmtNum(totalMPDOn)}</td><td class="num">${fmtNum(totalATGOn)}</td></tr>
        <tr><td>Online units</td><td class="num">${fmtNum(totalMPDOnline)}</td><td class="num">${fmtNum(totalATGOnline)}</td></tr>
        <tr><td>Offline / gap units</td><td class="num">${fmtNum(mpdGap)}</td><td class="num">${fmtNum(atgGap)}</td></tr>
        <tr><td>Equipment uptime</td><td class="num"><b>${fmtPct(mpdEq)}</b></td><td class="num"><b>${fmtPct(atgEq)}</b></td></tr>
        <tr><td>Average 2-slot uptime</td><td class="num"><b>${fmtPct(mpd2)}</b></td><td class="num"><b>${fmtPct(atg2)}</b></td></tr>
      `;
    }

    const area = {}, vendor = {};
    allRows.forEach(r => {
      let s = norm(statusOf(r));
      if (s.includes('offline') || s.includes('partial')) {
        let a = String(getCol(r, 'area') || 'Unassigned');
        let v = String(getCol(r, 'vendor') || 'Unassigned');
        area[a] = (area[a] || 0) + 1;
        vendor[v] = (vendor[v] || 0) + 1;
      }
    });

    renderBars('areaBars', area, affected);
    renderBars('vendorBars', vendor, affected);
    setupTable();
  }

  function renderBars(id, obj, denom) {
    const el = $(id);
    if (!el) return;
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(e => e[1]));
    el.innerHTML = entries.length ? entries.map(([label, n]) => `
      <div class="mis-barrow">
        <div title="${escapeHtml(label)}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(label)}</div>
        <div class="mis-barbg"><div class="mis-barfill" style="width:${(n / max) * 100}%"></div></div>
        <div style="text-align:right;font-weight:750">${n}</div>
      </div>
    `).join('') : '<div class="mis-empty">No data available.</div>';
  }

  function setupTable() {
    const sf = $('statusFilter');
    if (!sf) return;
    const old = sf.value;
    const opts = [...new Set(allRows.map(statusOf))].sort();
    sf.innerHTML = '<option value="">All outlet statuses</option>' + opts.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (opts.includes(old)) sf.value = old;

    if ($('searchBox')) $('searchBox').oninput = applyFilter;
    sf.onchange = applyFilter;
    if ($('exportCsv')) $('exportCsv').onclick = exportCsv;
    applyFilter();
  }

  function applyFilter() {
    const sb = $('searchBox');
    const sf = $('statusFilter');
    const q = sb ? norm(sb.value) : '';
    const s = sf ? sf.value : '';

    filteredRows = allRows.filter(r => (!s || statusOf(r) === s) && (!q || headers.some(h => norm(r[h]).includes(q))));

    if ($('tableCount')) {
      let countTxt = `Showing ${filteredRows.length.toLocaleString('en-IN')} of ${allRows.length.toLocaleString('en-IN')} outlets`;
      if (filteredRows.length > 1000) countTxt += ' · First 1,000 rows displayed; CSV export includes all filtered rows.';
      $('tableCount').textContent = countTxt;
    }

    if ($('rawHead')) {
      $('rawHead').innerHTML = '<tr>' + headers.map(h => '<th>' + escapeHtml(h) + '</th>').join('') + '<th>Calculated Status</th></tr>';
    }

    if ($('rawBody')) {
      $('rawBody').innerHTML = filteredRows.slice(0, 1000).map(r => {
        const st = statusOf(r);
        const stNorm = norm(st);
        let pillClass = 'mis-pill';
        if (stNorm.includes('partial')) pillClass += ' warn';
        else if (stNorm.includes('off')) pillClass += ' bad';
        return '<tr>' + headers.map(h => '<td>' + escapeHtml(r[h] === undefined ? '' : String(r[h])) + '</td>').join('') + `<td><span class="${pillClass}">${escapeHtml(st)}</span></td></tr>`;
      }).join('');
    }
  }

  function exportCsv() {
    const hs = [...headers, 'Calculated Status'];
    const rows = [hs, ...filteredRows.map(r => [...headers.map(h => r[h] ?? ''), statusOf(r)])];
    const csv = rows.map(row => row.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'automation_mis_filtered.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function handleFileUpload(file) {
    if (!file) return;
    if (typeof XLSX === 'undefined') {
      if ($('status')) $('status').innerHTML = '<span class="mis-error">Excel library did not load. Check internet and reload the page.</span>';
      return;
    }
    if ($('status')) $('status').textContent = 'Reading workbook…';
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const sheetName = findRawSheet(wb);
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
      if (!rows.length) throw new Error('The selected RAW Data sheet has no data rows.');
      headers = Object.keys(rows[0]);
      const missing = ['mpdOn', 'mpdOnline', 'atgOn', 'atgOnline', 'mpdPct', 'atgPct'].filter(k => !headers.some(h => (aliases[k] || []).some(a => norm(a) === norm(h))));
      if (missing.length) throw new Error('Required columns not found: ' + missing.map(k => (aliases[k] || [])[0] || k).join(', '));
      allRows = rows.filter(r => String(getCol(r, 'id') || getCol(r, 'name')).trim() !== '');

      // Cache on window for app-wide sync
      window.rawSheetObjects = allRows;
      window.lastUploadedFileName = file.name;

      if ($('empty')) $('empty').style.display = 'none';
      if ($('dashboard')) $('dashboard').style.display = 'block';
      if ($('fileName')) $('fileName').textContent = file.name;
      if ($('reportMeta')) $('reportMeta').textContent = 'Sheet: ' + sheetName + ' · ' + allRows.length + ' data rows';
      render();
      if ($('status')) $('status').textContent = 'Dashboard updated successfully';
      if (window.showToast) window.showToast(`Loaded ${allRows.length} outlets into MIS Dashboard`, 'success');
    } catch (err) {
      if ($('status')) $('status').innerHTML = '<span class="mis-error">' + escapeHtml(err.message) + '</span>';
      console.error('MIS Dashboard Excel read error:', err);
    }
  }

  function syncFromGlobalAppState() {
    if (window.rawSheetObjects && Array.isArray(window.rawSheetObjects) && window.rawSheetObjects.length > 0) {
      allRows = window.rawSheetObjects.filter(r => String(getCol(r, 'id') || getCol(r, 'name')).trim() !== '');
      headers = Object.keys(window.rawSheetObjects[0]);
      if ($('fileName')) $('fileName').textContent = window.lastUploadedFileName || 'Uploaded MIS Workbook (RAW Data)';
      if ($('reportMeta')) $('reportMeta').textContent = 'Live Active Dataset · ' + allRows.length + ' data rows';
      if ($('empty')) $('empty').style.display = 'none';
      if ($('dashboard')) $('dashboard').style.display = 'block';
      if ($('status')) $('status').textContent = 'Synced from active system data';
      return true;
    }

    if (window.calculatedROs && Array.isArray(window.calculatedROs) && window.calculatedROs.length > 0) {
      headers = [
        'RO ID', 'Retail Outlet', 'RA Vendor', 'Sales Area',
        'No. of On-Boarded MPDs', 'No. of Online MPDs', 'MPD Online%',
        'No. of On-Boarded Tanks', 'No. of Online Tanks', 'Tank Online%',
        "RO's Online"
      ];
      allRows = window.calculatedROs.map(ro => ({
        'RO ID': ro.roid,
        'Retail Outlet': ro.outlet_name,
        'RA Vendor': ro.vendor,
        'Sales Area': ro.sales_area,
        'No. of On-Boarded MPDs': ro.onb_mpd,
        'No. of Online MPDs': ro.onl_mpd,
        'MPD Online%': (ro.mpd_online_pct !== null && ro.mpd_online_pct !== undefined) ? ro.mpd_online_pct : '',
        'No. of On-Boarded Tanks': ro.onb_tnk,
        'No. of Online Tanks': ro.onl_tnk,
        'Tank Online%': (ro.tank_online_pct !== null && ro.tank_online_pct !== undefined) ? ro.tank_online_pct : '',
        "RO's Online": ro.ro_online_status || ro.status
      }));
      if ($('fileName')) $('fileName').textContent = window.lastUploadedFileName || 'Active System Dashboard Data';
      if ($('reportMeta')) $('reportMeta').textContent = allRows.length + ' outlets analyzed';
      if ($('empty')) $('empty').style.display = 'none';
      if ($('dashboard')) $('dashboard').style.display = 'block';
      if ($('status')) $('status').textContent = 'Synced from active dashboard data';
      return true;
    }

    if (window.rawDataRows && Array.isArray(window.rawDataRows) && window.rawDataRows.length > 0) {
      headers = [
        'RO ID', 'Retail Outlet', 'RA Vendor', 'Sales Area',
        'No. of On-Boarded MPDs', 'No. of Online MPDs', 'MPD Online%',
        'No. of On-Boarded Tanks', 'No. of Online Tanks', 'Tank Online%',
        "RO's Online"
      ];
      allRows = window.rawDataRows.map(r => ({
        'RO ID': r.roid,
        'Retail Outlet': r.outlet_name,
        'RA Vendor': r.vendor,
        'Sales Area': r.sales_area,
        'No. of On-Boarded MPDs': r.onb_mpd,
        'No. of Online MPDs': r.onl_mpd,
        'MPD Online%': (r.mpd_online_pct !== null && r.mpd_online_pct !== undefined) ? r.mpd_online_pct : '',
        'No. of On-Boarded Tanks': r.onb_tnk,
        'No. of Online Tanks': r.onl_tnk,
        'Tank Online%': (r.tank_online_pct !== null && r.tank_online_pct !== undefined) ? r.tank_online_pct : '',
        "RO's Online": r.ro_online_status
      }));
      if ($('fileName')) $('fileName').textContent = window.lastUploadedFileName || 'Raw Data Stream';
      if ($('reportMeta')) $('reportMeta').textContent = allRows.length + ' outlets analyzed';
      if ($('empty')) $('empty').style.display = 'none';
      if ($('dashboard')) $('dashboard').style.display = 'block';
      if ($('status')) $('status').textContent = 'Synced from raw data stream';
      return true;
    }

    return false;
  }

  function renderNewLogicDashboard() {
    if (syncFromGlobalAppState()) {
      render();
    } else if (allRows.length > 0) {
      render();
    }
  }

  // Setup file input listener once DOM is ready
  function init() {
    const fi = $('fileInput');
    if (fi) {
      fi.addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) handleFileUpload(file);
      });
    }
    syncFromGlobalAppState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose on window
  window.renderNewLogicDashboard = renderNewLogicDashboard;
  window.handleNewLogicFileUpload = handleFileUpload;
  window.exportNewLogicCSV = exportCsv;
})();
