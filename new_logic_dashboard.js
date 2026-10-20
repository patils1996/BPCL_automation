// new_logic_dashboard.js - BPCL Belgaum Territory Dynamic MIS & 2-Slot Uptime Engine
// Faithfully implements logic from automation_mis_dashboard.html & Automation_MIS_Dynamic_Uptime_Dashboard.xlsx

(function() {
  'use strict';

  // --- Configuration & Column Aliases ---
  const aliases = {
    id: ['RO ID', 'ROID', 'roid', 'ro_id', 'BL Code', 'CC Code', 'Outlet Code'],
    name: ['Retail Outlet', 'outlet_name', 'RO Name', 'Outlet Name', 'Station Name'],
    vendor: ['RA Vendor', 'vendor', 'Vendor', 'ra_vendor'],
    area: ['Sales Area', 'sales_area', 'SalesArea', 'Area'],
    mpdOn: ['No. of On-Boarded MPDs', 'MPD Onboarded', 'onb_mpd', 'On-Boarded MPDs', 'MPD On-Boarded'],
    mpdOnline: ['No. of Online MPDs', 'MPD Online', 'onl_mpd', 'Online MPDs'],
    mpdGap: ['MPD Gap', 'mpd_gap'],
    atgOn: ['No. of On-Boarded Tanks', 'ATG Onboarded', 'onb_tnk', 'On-Boarded Tanks', 'No. of On-Boarded ATG', 'Tank Onboarded'],
    atgOnline: ['No. of Online Tanks', 'ATG Online', 'onl_tnk', 'Online Tanks', 'No. of Online ATG', 'Tank Online'],
    atgGap: ['ATG Gap', 'atg_gap'],
    mpdPct: ['MPD Online%', 'MPD Online %', 'mpd_online_pct', 'MPD Online pct', 'mpd_pct'],
    atgPct: ['Tank Online%', 'Tank Online %', 'ATG Online%', 'ATG Online %', 'tank_online_pct', 'atg_online_pct', 'tank_pct'],
    avgRoPct: ['Avg RO Online %', 'Avg RO Online%', 'avg_ro_online_pct', 'Avg RO Online pct'],
    roStatus: ["RO's Online", 'RO Online', 'RO Status', 'Outlet Status', 'ro_online_status', 'status']
  };

  // State
  let allRows = [];
  let sourceFileName = 'Live System Data';

  // Table filtering and pagination state
  let searchQuery = '';
  let statusFilter = '';
  let categoryFilter = 'all'; // 'all' | 'fully' | 'affected' | 'list1' | 'list2'
  let areaFilter = '';
  let vendorFilter = '';
  let sortField = 'id';
  let sortAsc = true;
  let currentPage = 1;
  const PAGE_SIZE = 20;

  // --- Standard MIS Utility Functions ---
  function norm(s) {
    return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function getCol(row, key) {
    if (!row) return '';
    const keyCandidates = aliases[key] || [];
    for (const a of keyCandidates) {
      if (row[a] !== undefined && row[a] !== null && row[a] !== '') return row[a];
    }
    // Also try case-insensitive lookup over object keys
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
    const s = String(v).trim().replace(/,/g, '').replace('%', '');
    const n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return String(v).includes('%') ? n / 100 : n;
  }

  function pctValue(v) {
    const n = num(v);
    if (!Number.isFinite(n)) return NaN;
    return n > 1 && n <= 100 ? n / 100 : n;
  }

  function fmtPct(v) {
    return Number.isFinite(v) ? (v * 100).toFixed(2) + '%' : '—';
  }

  function fmtNum(v) {
    return Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
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

  function sum(rows, key) {
    return rows.reduce((a, r) => {
      const n = num(getCol(r, key));
      return a + (Number.isFinite(n) ? n : 0);
    }, 0);
  }

  // Exact 2-slot uptime average matching automation_mis_dashboard.html & Excel =AVERAGE(range)
  function averagePct(rows, key) {
    const vals = rows.map(r => pctValue(getCol(r, key))).filter(v => Number.isFinite(v) && v >= 0 && v <= 1);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  }

  // Determine Outlet Online Status
  function statusOf(r) {
    const rawStatus = String(getCol(r, 'roStatus') || '').trim();
    if (rawStatus) {
      const lower = rawStatus.toLowerCase();
      if (lower === 'online' || lower === 'fully online') return 'Fully Online';
      if (lower === 'partial' || lower === 'partially online' || lower.includes('part')) return 'Partially Online';
      if (lower === 'offline' || lower.includes('off')) return 'Offline';
      return rawStatus;
    }
    const mo = num(getCol(r, 'mpdOn')), mp = num(getCol(r, 'mpdOnline'));
    const ao = num(getCol(r, 'atgOn')), ap = num(getCol(r, 'atgOnline'));
    if ([mo, mp, ao, ap].some(Number.isFinite)) {
      if ((!Number.isFinite(mp) || mp === 0) && (!Number.isFinite(ap) || ap === 0)) return 'Offline';
      if ((Number.isFinite(mo) && Number.isFinite(mp) && mp < mo) || (Number.isFinite(ao) && Number.isFinite(ap) && ap < ao)) return 'Partially Online';
      return 'Fully Online';
    }
    return 'Unknown';
  }

  // Determine List 1 (Dealer Dependency) vs List 2 (Team Analysis)
  function listClassificationOf(r) {
    const status = statusOf(r);
    if (status === 'Fully Online') return 'Healthy';
    
    const mo = num(getCol(r, 'mpdOn'));
    const mp = num(getCol(r, 'mpdOnline'));
    const ao = num(getCol(r, 'atgOn'));
    const ap = num(getCol(r, 'atgOnline'));

    const mpdGap = Math.max(0, (Number.isFinite(mo) ? mo : 0) - (Number.isFinite(mp) ? mp : 0));
    const atgGap = Math.max(0, (Number.isFinite(ao) ? ao : 0) - (Number.isFinite(ap) ? ap : 0));

    if (mpdGap === 0 && atgGap === 0) {
      return 'List 1 - Dealer Dependency';
    } else {
      return 'List 2 - Team Analysis';
    }
  }

  // --- Calculate Metrics Engine ---
  function calculateMetrics() {
    const totalMPDOn = sum(allRows, 'mpdOn');
    const totalMPDOnline = sum(allRows, 'mpdOnline');
    const totalATGOn = sum(allRows, 'atgOn');
    const totalATGOnline = sum(allRows, 'atgOnline');

    // 1. Equipment Uptime = Total Online / Total Onboarded
    const mpdEquipUptime = totalMPDOn ? totalMPDOnline / totalMPDOn : NaN;
    const atgEquipUptime = totalATGOn ? totalATGOnline / totalATGOn : NaN;

    // 2. 2-Slot Uptime = Arithmetic average of row-level online percentage columns
    // Matching =AVERAGE(tblRaw[MPD Online%]) and =AVERAGE(tblRaw[Tank Online%])
    const mpd2SlotUptime = averagePct(allRows, 'mpdPct');
    const atg2SlotUptime = averagePct(allRows, 'atgPct');

    const statuses = {
      'Fully Online': 0,
      'Partially Online': 0,
      'Offline': 0
    };

    let list1Count = 0;
    let list2Count = 0;

    const areaCounts = {};
    const vendorCounts = {};

    allRows.forEach(r => {
      const st = statusOf(r);
      statuses[st] = (statuses[st] || 0) + 1;

      if (st === 'Offline' || st === 'Partially Online') {
        const mo = num(getCol(r, 'mpdOn'));
        const mp = num(getCol(r, 'mpdOnline'));
        const ao = num(getCol(r, 'atgOn'));
        const ap = num(getCol(r, 'atgOnline'));

        const mpdGap = Math.max(0, (Number.isFinite(mo) ? mo : 0) - (Number.isFinite(mp) ? mp : 0));
        const atgGap = Math.max(0, (Number.isFinite(ao) ? ao : 0) - (Number.isFinite(ap) ? ap : 0));

        if (mpdGap === 0 && atgGap === 0) {
          list1Count++;
        } else {
          list2Count++;
        }

        const area = String(getCol(r, 'area') || 'Unassigned').trim();
        const vendor = String(getCol(r, 'vendor') || 'Unassigned').trim();
        areaCounts[area] = (areaCounts[area] || 0) + 1;
        vendorCounts[vendor] = (vendorCounts[vendor] || 0) + 1;
      }
    });

    const totalOutlets = allRows.length;
    const fullyOnline = statuses['Fully Online'] || 0;
    const affectedOutlets = (statuses['Offline'] || 0) + (statuses['Partially Online'] || 0);

    return {
      totalOutlets,
      fullyOnline,
      affectedOutlets,
      totalMPDOn,
      totalMPDOnline,
      mpdGap: Math.max(0, totalMPDOn - totalMPDOnline),
      totalATGOn,
      totalATGOnline,
      atgGap: Math.max(0, totalATGOn - totalATGOnline),
      mpdEquipUptime,
      atgEquipUptime,
      mpd2SlotUptime,
      atg2SlotUptime,
      statuses,
      list1Count,
      list2Count,
      areaCounts,
      vendorCounts
    };
  }

  // --- Render Dashboard Metrics (KPIs, Cards, Bars, Matrix) ---
  function renderDashboardMetrics() {
    const m = calculateMetrics();

    // Source info
    const srcEl = document.getElementById('nld-source-name');
    if (srcEl) srcEl.textContent = sourceFileName;

    const countEl = document.getElementById('nld-record-count');
    if (countEl) countEl.textContent = fmtNum(m.totalOutlets);

    // Update 2-Slot 5:00 PM Status Badge
    const badgeEl = document.getElementById('nld-slot-badge');
    const badgeTextEl = document.getElementById('nld-slot-badge-text');
    const slotDescEl = document.getElementById('nld-slot-desc');

    const has2SlotData = (Number.isFinite(m.mpd2SlotUptime) && m.mpd2SlotUptime > 0.05) ||
                         (Number.isFinite(m.atg2SlotUptime) && m.atg2SlotUptime > 0.05);

    if (has2SlotData) {
      if (badgeEl) badgeEl.className = 'nld-slot-badge slot-2';
      if (badgeTextEl) badgeTextEl.textContent = '2-Slot EOD Data Active (Post-5 PM Official)';
      if (slotDescEl) slotDescEl.textContent = 'Official 2-slot uptime calculated from raw MPD Online% & Tank Online% columns';
    } else {
      if (badgeEl) badgeEl.className = 'nld-slot-badge slot-1';
      if (badgeTextEl) badgeTextEl.textContent = 'Pre-5 PM Data (2-Slot EOD Pending)';
      if (slotDescEl) slotDescEl.textContent = '2-slot uptime in this file will update after 5:00 PM data is uploaded';
    }

    // 1. Top 4 KPI Cards
    const mpdEquipVal = document.getElementById('nld-mpd-equip-val');
    const mpdEquipSub = document.getElementById('nld-mpd-equip-sub');
    const mpdEquipBar = document.getElementById('nld-mpd-equip-bar');
    if (mpdEquipVal) mpdEquipVal.textContent = fmtPct(m.mpdEquipUptime);
    if (mpdEquipSub) mpdEquipSub.textContent = `${fmtNum(m.totalMPDOnline)} online / ${fmtNum(m.totalMPDOn)} onboarded · ${fmtNum(m.mpdGap)} offline`;
    if (mpdEquipBar) mpdEquipBar.style.width = (Number.isFinite(m.mpdEquipUptime) ? Math.max(0, Math.min(100, m.mpdEquipUptime * 100)) : 0) + '%';

    const atgEquipVal = document.getElementById('nld-atg-equip-val');
    const atgEquipSub = document.getElementById('nld-atg-equip-sub');
    const atgEquipBar = document.getElementById('nld-atg-equip-bar');
    if (atgEquipVal) atgEquipVal.textContent = fmtPct(m.atgEquipUptime);
    if (atgEquipSub) atgEquipSub.textContent = `${fmtNum(m.totalATGOnline)} online / ${fmtNum(m.totalATGOn)} onboarded · ${fmtNum(m.atgGap)} offline`;
    if (atgEquipBar) atgEquipBar.style.width = (Number.isFinite(m.atgEquipUptime) ? Math.max(0, Math.min(100, m.atgEquipUptime * 100)) : 0) + '%';

    const mpd2Val = document.getElementById('nld-mpd-2slot-val');
    const mpd2Sub = document.getElementById('nld-mpd-2slot-sub');
    const mpd2Bar = document.getElementById('nld-mpd-2slot-bar');
    if (mpd2Val) mpd2Val.textContent = fmtPct(m.mpd2SlotUptime);
    if (mpd2Bar) mpd2Bar.style.width = (Number.isFinite(m.mpd2SlotUptime) ? Math.max(0, Math.min(100, m.mpd2SlotUptime * 100)) : 0) + '%';
    if (mpd2Sub) mpd2Sub.textContent = 'Average of MPD Online% across valid outlets';

    const atg2Val = document.getElementById('nld-atg-2slot-val');
    const atg2Sub = document.getElementById('nld-atg-2slot-sub');
    const atg2Bar = document.getElementById('nld-atg-2slot-bar');
    if (atg2Val) atg2Val.textContent = fmtPct(m.atg2SlotUptime);
    if (atg2Bar) atg2Bar.style.width = (Number.isFinite(m.atg2SlotUptime) ? Math.max(0, Math.min(100, m.atg2SlotUptime * 100)) : 0) + '%';
    if (atg2Sub) atg2Sub.textContent = 'Average of Tank Online% across valid outlets';

    // 2. Overview Count Cards
    const cntTot = document.getElementById('nld-count-total');
    if (cntTot) cntTot.textContent = fmtNum(m.totalOutlets);

    const cntFully = document.getElementById('nld-count-fully');
    const pctFully = document.getElementById('nld-pct-fully');
    if (cntFully) cntFully.textContent = fmtNum(m.fullyOnline);
    if (pctFully) pctFully.textContent = m.totalOutlets ? `${((m.fullyOnline / m.totalOutlets) * 100).toFixed(1)}% of outlets` : '0% of outlets';

    const cntAffected = document.getElementById('nld-count-affected');
    const pctAffected = document.getElementById('nld-pct-affected');
    if (cntAffected) cntAffected.textContent = fmtNum(m.affectedOutlets);
    if (pctAffected) pctAffected.textContent = m.totalOutlets ? `${((m.affectedOutlets / m.totalOutlets) * 100).toFixed(1)}% of outlets` : '0% of outlets';

    const cntList1 = document.getElementById('nld-count-list1');
    if (cntList1) cntList1.textContent = fmtNum(m.list1Count);

    const cntList2 = document.getElementById('nld-count-list2');
    if (cntList2) cntList2.textContent = fmtNum(m.list2Count);

    // 3. Status Distribution Bars
    renderBars('nld-status-bars', m.statuses, m.totalOutlets, true);

    // 4. Equipment Matrix Table
    const matrixBody = document.getElementById('nld-equipment-matrix-body');
    if (matrixBody) {
      matrixBody.innerHTML = `
        <tr>
          <td>Onboarded units</td>
          <td class="num">${fmtNum(m.totalMPDOn)}</td>
          <td class="num">${fmtNum(m.totalATGOn)}</td>
        </tr>
        <tr>
          <td>Online units</td>
          <td class="num" style="color: var(--accent-green, #16845b);">${fmtNum(m.totalMPDOnline)}</td>
          <td class="num" style="color: var(--accent-green, #16845b);">${fmtNum(m.totalATGOnline)}</td>
        </tr>
        <tr>
          <td>Offline / gap units</td>
          <td class="num" style="color: ${m.mpdGap > 0 ? 'var(--accent-red, #dc2626)' : 'inherit'}; font-weight: 700;">${fmtNum(m.mpdGap)}</td>
          <td class="num" style="color: ${m.atgGap > 0 ? 'var(--accent-red, #dc2626)' : 'inherit'}; font-weight: 700;">${fmtNum(m.atgGap)}</td>
        </tr>
        <tr style="background: rgba(0, 63, 135, 0.03);">
          <td><b>Equipment uptime</b></td>
          <td class="num"><b>${fmtPct(m.mpdEquipUptime)}</b></td>
          <td class="num"><b>${fmtPct(m.atgEquipUptime)}</b></td>
        </tr>
        <tr style="background: rgba(0, 63, 135, 0.06);">
          <td>
            <b>Average 2-slot uptime</b>
            <div style="font-size: 0.68rem; color: var(--text-muted); font-weight: normal;">
              Arithmetic average of row-level online percentage columns
            </div>
          </td>
          <td class="num"><b style="color: var(--navy, #003F87); font-size: 0.95rem;">${fmtPct(m.mpd2SlotUptime)}</b></td>
          <td class="num"><b style="color: var(--navy, #003F87); font-size: 0.95rem;">${fmtPct(m.atg2SlotUptime)}</b></td>
        </tr>
      `;
    }

    // 5. Affected Outlets Bars (Sales Area & Vendor)
    const areaBadge = document.getElementById('nld-area-affected-badge');
    if (areaBadge) areaBadge.textContent = `${fmtNum(m.affectedOutlets)} affected`;
    renderBars('nld-area-bars', m.areaCounts, m.affectedOutlets, false);

    const vendorBadge = document.getElementById('nld-vendor-affected-badge');
    if (vendorBadge) vendorBadge.textContent = `${fmtNum(m.affectedOutlets)} affected`;
    renderBars('nld-vendor-bars', m.vendorCounts, m.affectedOutlets, false);

    // 6. Populate Filter Dropdowns
    populateFilterDropdowns();
  }

  // Generic Bar Renderer
  function renderBars(containerId, dataObj, denominator, isStatus = false) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const entries = Object.entries(dataObj).filter(([, val]) => val > 0).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      el.innerHTML = '<div class="nld-empty-note">No affected records. All outlets healthy!</div>';
      return;
    }

    const maxVal = Math.max(1, ...entries.map(e => e[1]));
    const denom = denominator > 0 ? denominator : 1;

    el.innerHTML = entries.map(([label, count]) => {
      const pctOfMax = (count / maxVal) * 100;
      const pctOfTotal = ((count / denom) * 100).toFixed(1);

      let barColor = 'var(--accent-blue, #2563eb)';
      if (isStatus) {
        const lNorm = norm(label);
        if (lNorm.includes('fully') || lNorm === 'online') barColor = 'var(--accent-green, #16845b)';
        else if (lNorm.includes('partial')) barColor = 'var(--accent-yellow, #d97706)';
        else if (lNorm.includes('off')) barColor = 'var(--accent-red, #dc2626)';
      }

      return `
        <div class="nld-bar-row">
          <div class="nld-bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
          <div class="nld-bar-track">
            <div class="nld-bar-fill" style="width: ${pctOfMax}%; background: ${barColor};"></div>
          </div>
          <div class="nld-bar-count">
            <b>${fmtNum(count)}</b>
            <span class="nld-bar-pct">(${pctOfTotal}%)</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // Populate Area and Vendor dropdown filters
  function populateFilterDropdowns() {
    const areaSelect = document.getElementById('nld-area-select');
    const vendorSelect = document.getElementById('nld-vendor-select');

    if (areaSelect && areaSelect.options.length <= 1) {
      const areas = [...new Set(allRows.map(r => String(getCol(r, 'area') || '').trim()).filter(Boolean))].sort();
      areas.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a;
        opt.textContent = a;
        areaSelect.appendChild(opt);
      });
    }

    if (vendorSelect && vendorSelect.options.length <= 1) {
      const vendors = [...new Set(allRows.map(r => String(getCol(r, 'vendor') || '').trim()).filter(Boolean))].sort();
      vendors.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        vendorSelect.appendChild(opt);
      });
    }
  }

  // --- Filter and Render Table ---
  function getFilteredRows() {
    const q = norm(searchQuery);
    return allRows.filter(r => {
      // 1. Text Search across RO ID, Retail Outlet, Vendor, Sales Area
      if (q) {
        const id = norm(getCol(r, 'id'));
        const name = norm(getCol(r, 'name'));
        const vendor = norm(getCol(r, 'vendor'));
        const area = norm(getCol(r, 'area'));
        if (!id.includes(q) && !name.includes(q) && !vendor.includes(q) && !area.includes(q)) {
          return false;
        }
      }

      // 2. Status Filter
      const st = statusOf(r);
      if (statusFilter && st !== statusFilter) {
        return false;
      }

      // 3. Category Filter (List 1 vs List 2)
      if (categoryFilter === 'fully' && st !== 'Fully Online') return false;
      if (categoryFilter === 'affected' && (st !== 'Offline' && st !== 'Partially Online')) return false;

      const classification = listClassificationOf(r);
      if (categoryFilter === 'list1' && classification !== 'List 1 - Dealer Dependency') return false;
      if (categoryFilter === 'list2' && classification !== 'List 2 - Team Analysis') return false;

      // 4. Area Filter
      if (areaFilter) {
        const area = String(getCol(r, 'area') || '').trim();
        if (area !== areaFilter) return false;
      }

      // 5. Vendor Filter
      if (vendorFilter) {
        const vendor = String(getCol(r, 'vendor') || '').trim();
        if (vendor !== vendorFilter) return false;
      }

      return true;
    });
  }

  function renderDataTable() {
    const filtered = getFilteredRows();

    // Sort rows
    filtered.sort((a, b) => {
      let va = getCol(a, sortField);
      let vb = getCol(b, sortField);

      if (['mpdOn', 'mpdOnline', 'mpdGap', 'atgOn', 'atgOnline', 'atgGap'].includes(sortField)) {
        va = num(va);
        vb = num(vb);
      } else if (['mpdPct', 'atgPct'].includes(sortField)) {
        va = pctValue(va);
        vb = pctValue(vb);
      } else {
        va = String(va || '').toLowerCase();
        vb = String(vb || '').toLowerCase();
      }

      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });

    const totalFiltered = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const pageRows = filtered.slice(startIdx, startIdx + PAGE_SIZE);

    // Update count subtitle
    const countSub = document.getElementById('nld-table-count-sub');
    if (countSub) {
      countSub.textContent = `Showing ${fmtNum(filtered.length)} of ${fmtNum(allRows.length)} outlets (Page ${currentPage} of ${totalPages})`;
    }

    // Update pagination controls
    const pageInfo = document.getElementById('nld-page-info');
    const pageNumber = document.getElementById('nld-page-number');
    const btnPrev = document.getElementById('nld-btn-prev');
    const btnNext = document.getElementById('nld-btn-next');

    if (pageInfo) pageInfo.textContent = `Showing ${filtered.length ? startIdx + 1 : 0}-${Math.min(startIdx + PAGE_SIZE, totalFiltered)} of ${fmtNum(totalFiltered)}`;
    if (pageNumber) pageNumber.textContent = `${currentPage} / ${totalPages}`;
    if (btnPrev) btnPrev.disabled = (currentPage <= 1);
    if (btnNext) btnNext.disabled = (currentPage >= totalPages);

    // Render Table Body
    const tbody = document.getElementById('nld-table-body');
    if (!tbody) return;

    if (!pageRows.length) {
      tbody.innerHTML = `<tr><td colspan="14" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">No outlets found matching the selected filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = pageRows.map(r => {
      const id = getCol(r, 'id') || '—';
      const name = getCol(r, 'name') || '—';
      const vendor = getCol(r, 'vendor') || '—';
      const area = getCol(r, 'area') || '—';

      const mo = num(getCol(r, 'mpdOn'));
      const mp = num(getCol(r, 'mpdOnline'));
      const mpdGap = Math.max(0, (Number.isFinite(mo) ? mo : 0) - (Number.isFinite(mp) ? mp : 0));

      const ao = num(getCol(r, 'atgOn'));
      const ap = num(getCol(r, 'atgOnline'));
      const atgGap = Math.max(0, (Number.isFinite(ao) ? ao : 0) - (Number.isFinite(ap) ? ap : 0));

      // Display actual row-level percentage from file
      const rawMpdPct = pctValue(getCol(r, 'mpdPct'));
      const rawAtgPct = pctValue(getCol(r, 'atgPct'));

      const mpdPctDisplay = fmtPct(rawMpdPct);
      const atgPctDisplay = fmtPct(rawAtgPct);

      const st = statusOf(r);
      let statusPillClass = 'nld-pill-green';
      if (st === 'Offline') statusPillClass = 'nld-pill-red';
      else if (st === 'Partially Online') statusPillClass = 'nld-pill-yellow';

      const classification = listClassificationOf(r);
      let classPill = '';
      if (classification === 'List 1 - Dealer Dependency') {
        classPill = `<span class="nld-class-badge list-1" title="Offline/Partial but 0 MPD and 0 ATG Gap. All equipment healthy.">List 1 · Dealer</span>`;
      } else if (classification === 'List 2 - Team Analysis') {
        classPill = `<span class="nld-class-badge list-2" title="Hardware gap detected. MPD Gap: ${mpdGap}, ATG Gap: ${atgGap}">List 2 · Equipment</span>`;
      } else {
        classPill = `<span class="nld-class-badge healthy">Normal</span>`;
      }

      return `
        <tr>
          <td><b style="font-family: monospace; font-size: 0.85rem;">${escapeHtml(id)}</b></td>
          <td style="font-weight: 600; max-width: 220px;" class="truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</td>
          <td>${escapeHtml(vendor)}</td>
          <td>${escapeHtml(area)}</td>
          <td><span class="nld-status-pill ${statusPillClass}">${escapeHtml(st)}</span></td>
          <td class="num">${Number.isFinite(mo) ? fmtNum(mo) : '—'}</td>
          <td class="num">${Number.isFinite(mp) ? fmtNum(mp) : '—'}</td>
          <td class="num" style="color: ${mpdGap > 0 ? 'var(--accent-red, #dc2626)' : 'inherit'}; font-weight: ${mpdGap > 0 ? '700' : 'normal'};">${fmtNum(mpdGap)}</td>
          <td class="num">${mpdPctDisplay}</td>
          <td class="num">${Number.isFinite(ao) ? fmtNum(ao) : '—'}</td>
          <td class="num">${Number.isFinite(ap) ? fmtNum(ap) : '—'}</td>
          <td class="num" style="color: ${atgGap > 0 ? 'var(--accent-red, #dc2626)' : 'inherit'}; font-weight: ${atgGap > 0 ? '700' : 'normal'};">${fmtNum(atgGap)}</td>
          <td class="num">${atgPctDisplay}</td>
          <td style="text-align: center;">${classPill}</td>
        </tr>
      `;
    }).join('');
  }

  // --- Export Filtered CSV ---
  function exportFilteredCSV() {
    const rows = getFilteredRows();
    if (!rows.length) {
      alert('No data to export.');
      return;
    }

    const headers = [
      'RO ID',
      'Retail Outlet',
      'RA Vendor',
      'Sales Area',
      "RO's Online Status",
      'Onboarded MPDs',
      'Online MPDs',
      'MPD Gap',
      'MPD Online %',
      'Onboarded ATG',
      'Online ATG',
      'ATG Gap',
      'Tank Online %',
      'Classification'
    ];

    const csvData = [headers];

    rows.forEach(r => {
      const id = getCol(r, 'id');
      const name = getCol(r, 'name');
      const vendor = getCol(r, 'vendor');
      const area = getCol(r, 'area');
      const st = statusOf(r);

      const mo = num(getCol(r, 'mpdOn'));
      const mp = num(getCol(r, 'mpdOnline'));
      const mpdGap = Math.max(0, (Number.isFinite(mo) ? mo : 0) - (Number.isFinite(mp) ? mp : 0));

      const ao = num(getCol(r, 'atgOn'));
      const ap = num(getCol(r, 'atgOnline'));
      const atgGap = Math.max(0, (Number.isFinite(ao) ? ao : 0) - (Number.isFinite(ap) ? ap : 0));

      const rawMpdPct = pctValue(getCol(r, 'mpdPct'));
      const rawAtgPct = pctValue(getCol(r, 'atgPct'));

      const mpdPctVal = fmtPct(rawMpdPct);
      const atgPctVal = fmtPct(rawAtgPct);
      const classification = listClassificationOf(r);

      csvData.push([
        id,
        name,
        vendor,
        area,
        st,
        Number.isFinite(mo) ? mo : '',
        Number.isFinite(mp) ? mp : '',
        mpdGap,
        mpdPctVal,
        Number.isFinite(ao) ? ao : '',
        Number.isFinite(ap) ? ap : '',
        atgGap,
        atgPctVal,
        classification
      ]);
    });

    const csvContent = csvData.map(row => 
      row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');

    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `BPCL_Automation_MIS_Export_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // --- Data Synchronization Handler ---
  function syncFromGlobalAppState() {
    // 1. Check if raw sheet objects exist from latest file upload
    if (window.rawSheetObjects && Array.isArray(window.rawSheetObjects) && window.rawSheetObjects.length > 0) {
      allRows = window.rawSheetObjects.filter(r => String(getCol(r, 'id') || getCol(r, 'name')).trim() !== '');
      sourceFileName = window.lastUploadedFileName || 'Uploaded Workbook (RAW Data)';
      return true;
    }

    // 2. Check calculatedROs
    if (window.calculatedROs && Array.isArray(window.calculatedROs) && window.calculatedROs.length > 0) {
      allRows = window.calculatedROs.map(ro => ({
        'RO ID': ro.roid,
        'Retail Outlet': ro.outlet_name,
        'RA Vendor': ro.vendor,
        'Sales Area': ro.sales_area,
        'No. of On-Boarded MPDs': ro.onb_mpd,
        'No. of Online MPDs': ro.onl_mpd,
        'No. of On-Boarded Tanks': ro.onb_tnk,
        'No. of Online Tanks': ro.onl_tnk,
        "RO's Online": ro.ro_online_status || ro.status,
        'MPD Online%': (ro.mpd_online_pct !== null && ro.mpd_online_pct !== undefined) ? ro.mpd_online_pct : '',
        'Tank Online%': (ro.tank_online_pct !== null && ro.tank_online_pct !== undefined) ? ro.tank_online_pct : '',
        'Avg RO Online %': (ro.avg_ro_online_pct !== null && ro.avg_ro_online_pct !== undefined) ? ro.avg_ro_online_pct : ''
      }));
      sourceFileName = 'Active System Dashboard Data';
      return true;
    }

    // 3. Check rawDataRows
    if (window.rawDataRows && Array.isArray(window.rawDataRows) && window.rawDataRows.length > 0) {
      allRows = window.rawDataRows.map(r => ({
        'RO ID': r.roid,
        'Retail Outlet': r.outlet_name,
        'RA Vendor': r.vendor,
        'Sales Area': r.sales_area,
        'No. of On-Boarded MPDs': r.onb_mpd,
        'No. of Online MPDs': r.onl_mpd,
        'No. of On-Boarded Tanks': r.onb_tnk,
        'No. of Online Tanks': r.onl_tnk,
        "RO's Online": r.ro_online_status,
        'MPD Online%': (r.mpd_online_pct !== null && r.mpd_online_pct !== undefined) ? r.mpd_online_pct : '',
        'Tank Online%': (r.tank_online_pct !== null && r.tank_online_pct !== undefined) ? r.tank_online_pct : '',
        'Avg RO Online %': (r.avg_ro_online_pct !== null && r.avg_ro_online_pct !== undefined) ? r.avg_ro_online_pct : ''
      }));
      sourceFileName = 'Raw Data Stream';
      return true;
    }

    // 4. Fallback to sample data if present
    if (window.BPCL_SAMPLE_DATA && Array.isArray(window.BPCL_SAMPLE_DATA) && window.BPCL_SAMPLE_DATA.length > 0) {
      allRows = window.BPCL_SAMPLE_DATA.map(r => ({
        'RO ID': r.roid,
        'Retail Outlet': r.outlet_name,
        'RA Vendor': r.vendor,
        'Sales Area': r.sales_area,
        'No. of On-Boarded MPDs': r.onb_mpd,
        'No. of Online MPDs': r.onl_mpd,
        'No. of On-Boarded Tanks': r.onb_tnk,
        'No. of Online Tanks': r.onl_tnk,
        "RO's Online": (r.onb_mpd === r.onl_mpd && r.onb_tnk === r.onl_tnk) ? 'Fully Online' : 'Partially Online',
        'MPD Online%': r.onb_mpd > 0 ? (r.onl_mpd / r.onb_mpd) : '',
        'Tank Online%': r.onb_tnk > 0 ? (r.onl_tnk / r.onb_tnk) : ''
      }));
      sourceFileName = 'Sample Belgaum Territory Data';
      return true;
    }

    return false;
  }

  // Handle direct file upload inside New Logic Dashboard tab
  async function handleNewLogicFileUpload(file) {
    if (!file) return;
    if (typeof XLSX === 'undefined') {
      alert('Excel parsing library (SheetJS) is not loaded.');
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true });

      // Find Raw Data sheet
      let rawSheetName = wb.SheetNames.find(n => norm(n) === 'raw data') ||
                         wb.SheetNames.find(n => norm(n).includes('raw')) ||
                         wb.SheetNames[0];

      const ws = wb.Sheets[rawSheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });

      if (!rows || !rows.length) {
        alert('The selected sheet has no valid data rows.');
        return;
      }

      // Check required headers
      const firstRow = rows[0];
      const headers = Object.keys(firstRow);
      const hasIdOrName = headers.some(h => aliases.id.some(a => norm(a) === norm(h)) || aliases.name.some(a => norm(a) === norm(h)));

      if (!hasIdOrName) {
        alert('Could not find RO ID or Outlet Name columns in sheet: ' + rawSheetName);
        return;
      }

      allRows = rows.filter(r => String(getCol(r, 'id') || getCol(r, 'name')).trim() !== '');
      sourceFileName = file.name;

      // Keep reference on window so other components can benefit
      window.rawSheetObjects = allRows;
      window.lastUploadedFileName = file.name;

      currentPage = 1;
      const landing = document.getElementById('upload-landing-view');
      const active = document.getElementById('dashboard-active-view');
      if (landing) landing.style.display = 'none';
      if (active) active.style.display = 'flex';
      renderDashboardMetrics();
      renderDataTable();

      if (window.showToast) {
        window.showToast(`Loaded ${allRows.length} outlets into New Logic Dashboard!`, 'success');
      }
    } catch (err) {
      console.error('Error parsing MIS Excel in New Logic Dashboard:', err);
      alert('Error reading Excel file: ' + err.message);
    }
  }

  // Public render function called when tab opens or data updates
  function renderNewLogicDashboard() {
    syncFromGlobalAppState();
    renderDashboardMetrics();
    renderDataTable();
  }

  function filterByCategory(cat) {
    categoryFilter = cat;
    currentPage = 1;

    // Highlight count card
    ['all', 'fully', 'affected', 'list1', 'list2'].forEach(c => {
      const card = document.getElementById('nld-card-filter-' + c);
      if (card) {
        if (c === cat) card.classList.add('active');
        else card.classList.remove('active');
      }
    });

    renderDataTable();
  }

  function handleFilterChange() {
    const searchInput = document.getElementById('nld-search-input');
    const statusSelect = document.getElementById('nld-status-select');
    const categorySelect = document.getElementById('nld-category-select');
    const areaSelect = document.getElementById('nld-area-select');
    const vendorSelect = document.getElementById('nld-vendor-select');

    if (searchInput) searchQuery = searchInput.value;
    if (statusSelect) statusFilter = statusSelect.value;
    if (categorySelect) categoryFilter = categorySelect.value;
    if (areaSelect) areaFilter = areaSelect.value;
    if (vendorSelect) vendorFilter = vendorSelect.value;

    currentPage = 1;
    renderDataTable();
  }

  function sortTable(field) {
    if (sortField === field) {
      sortAsc = !sortAsc;
    } else {
      sortField = field;
      sortAsc = true;
    }
    renderDataTable();
  }

  function changePage(delta) {
    currentPage += delta;
    renderDataTable();
  }

  // Expose on window
  window.renderNewLogicDashboard = renderNewLogicDashboard;
  window.handleNewLogicFileUpload = handleNewLogicFileUpload;
  window.filterNewLogicByCategory = filterByCategory;
  window.handleNewLogicFilterChange = handleFilterChange;
  window.sortNewLogicTable = sortTable;
  window.changeNewLogicPage = changePage;
  window.exportNewLogicCSV = exportFilteredCSV;

  // Initial sync attempt
  window.addEventListener('DOMContentLoaded', () => {
    syncFromGlobalAppState();
  });
})();
