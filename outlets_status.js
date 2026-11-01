/**
 * Outlets Status Module
 * Displays 2-Slot Partial & Offline Outlets with interactive tracking:
 * RO ID, RO Name, Sales area, Vendor, EO, MST, IOT/WFCC, 2 slot status,
 * Responsibility, Complaint remarks, BROMA No, Date, Target date.
 */

(function() {
  let outletsStatusSortField = 'roid';
  let outletsStatusSortAsc = true;
  let outletsStatusFilteredList = [];

  function getTodayDateStr() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getStoredOutletData(roid) {
    const raw = localStorage.getItem('outlets_status_' + roid);
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); } catch(e) {}
    }
    // Fallbacks from day_remarks_ if available
    const dayRaw = localStorage.getItem('day_remarks_' + roid);
    let dayData = {};
    if (dayRaw) {
      try { dayData = JSON.parse(dayRaw); } catch(e) {}
    }
    const sharedDay = (typeof getSharedDayData === 'function') ? getSharedDayData(roid) : {};

    return {
      responsibility: data.responsibility ?? sharedDay.responsibility ?? dayData.responsibility ?? '',
      remark: data.remark ?? sharedDay.remark ?? dayData.remark ?? '',
      broma_no: data.broma_no ?? dayData.broma_no ?? '',
      date: data.date ?? dayData.date ?? getTodayDateStr(),
      target_date: data.target_date ?? sharedDay.targetDate ?? dayData.targetDate ?? ''
    };
  }

  function saveStoredOutletData(roid, updates) {
    const current = getStoredOutletData(roid);
    const updated = Object.assign({}, current, updates);
    localStorage.setItem('outlets_status_' + roid, JSON.stringify(updated));

    // Also sync to day_remarks_ so responsibility & remarks remain unified across views
    const dayRaw = localStorage.getItem('day_remarks_' + roid);
    let dayData = {};
    if (dayRaw) {
      try { dayData = JSON.parse(dayRaw); } catch(e) {}
    }
    dayData.responsibility = updated.responsibility;
    dayData.remark = updated.remark;
    dayData.targetDate = updated.target_date;
    dayData.broma_no = updated.broma_no;
    dayData.date = updated.date;
    localStorage.setItem('day_remarks_' + roid, JSON.stringify(dayData));

    // If day monitoring cloud save is available, trigger background save
    if (typeof saveSharedDayMonitoringRow === 'function') {
      const ro = (window.calculatedROs || []).find(r => String(r.roid) === String(roid));
      if (ro) {
        saveSharedDayMonitoringRow(ro, updated.responsibility, updated.remark, updated.target_date, true);
      }
    }
  }

  function get2SlotStatus(ro) {
    return ro.new_logic_status || ro.ro_online_status || ro.status || 'Offline';
  }

  function is2SlotPartialOrOffline(ro) {
    const s = get2SlotStatus(ro).toLowerCase();
    return s.includes('part') || s.includes('off');
  }

  function populateOutletsStatusFilters() {
    const areaSelect = document.getElementById('outlets-status-filter-area');
    const vendorSelect = document.getElementById('outlets-status-filter-vendor');
    if (!areaSelect || !vendorSelect) return;

    const list = (window.calculatedROs || []).filter(is2SlotPartialOrOffline);
    
    // Areas
    const currentArea = areaSelect.value;
    const areas = [...new Set(list.map(r => r.sales_area))].filter(Boolean).sort();
    areaSelect.innerHTML = '<option value="">All Sales Areas</option>';
    areas.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      areaSelect.appendChild(opt);
    });
    areaSelect.value = currentArea;

    // Vendors
    const currentVendor = vendorSelect.value;
    const vendors = [...new Set(list.map(r => r.vendor))].filter(Boolean).sort();
    vendorSelect.innerHTML = '<option value="">All Vendors</option>';
    vendors.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      vendorSelect.appendChild(opt);
    });
    vendorSelect.value = currentVendor;
  }

  function renderOutletsStatusTable() {
    const tbody = document.getElementById('outlets-status-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const allAffected = (window.calculatedROs || []).filter(is2SlotPartialOrOffline);

    const searchQuery = (document.getElementById('outlets-status-search-input')?.value || '').toLowerCase().trim();
    const filterStatus = document.getElementById('outlets-status-filter-status')?.value || '';
    const filterArea = document.getElementById('outlets-status-filter-area')?.value || '';
    const filterVendor = document.getElementById('outlets-status-filter-vendor')?.value || '';
    const filterTech = document.getElementById('outlets-status-filter-tech')?.value || '';
    const filterResp = document.getElementById('outlets-status-filter-resp')?.value || '';

    let filtered = allAffected.filter(ro => {
      const nlStatus = get2SlotStatus(ro);
      if (filterStatus !== "") {
        if (filterStatus === "Partially Online" && !nlStatus.toLowerCase().includes('part')) return false;
        if (filterStatus === "Offline" && !nlStatus.toLowerCase().includes('off')) return false;
      }
      if (filterArea !== "" && ro.sales_area !== filterArea) return false;
      if (filterVendor !== "" && ro.vendor !== filterVendor) return false;
      if (filterTech !== "" && ro.iot_status !== filterTech) return false;

      const stored = getStoredOutletData(ro.roid);
      if (filterResp !== "" && stored.responsibility !== filterResp) return false;

      if (searchQuery !== "") {
        const match = String(ro.roid).includes(searchQuery) ||
          String(ro.outlet_name || '').toLowerCase().includes(searchQuery) ||
          String(ro.sales_area || '').toLowerCase().includes(searchQuery) ||
          String(ro.vendor || '').toLowerCase().includes(searchQuery) ||
          String(ro.eo_name || '').toLowerCase().includes(searchQuery) ||
          String(ro.mst_name || '').toLowerCase().includes(searchQuery) ||
          String(stored.remark || '').toLowerCase().includes(searchQuery) ||
          String(stored.broma_no || '').toLowerCase().includes(searchQuery);
        if (!match) return false;
      }
      return true;
    });

    // Sorting
    filtered.sort((a, b) => {
      let valA, valB;
      if (outletsStatusSortField === 'responsibility' || outletsStatusSortField === 'date' || outletsStatusSortField === 'target_date') {
        const storedA = getStoredOutletData(a.roid);
        const storedB = getStoredOutletData(b.roid);
        valA = storedA[outletsStatusSortField] || '';
        valB = storedB[outletsStatusSortField] || '';
      } else if (outletsStatusSortField === 'new_logic_status') {
        valA = get2SlotStatus(a);
        valB = get2SlotStatus(b);
      } else {
        valA = a[outletsStatusSortField];
        valB = b[outletsStatusSortField];
      }

      if (typeof valA === 'string' && !isNaN(valA) && valA !== '') valA = parseFloat(valA);
      if (typeof valB === 'string' && !isNaN(valB) && valB !== '') valB = parseFloat(valB);

      if (valA < valB) return outletsStatusSortAsc ? -1 : 1;
      if (valA > valB) return outletsStatusSortAsc ? 1 : -1;
      return 0;
    });

    outletsStatusFilteredList = filtered;
    window.outletsStatusFilteredList = filtered;

    // Update count badge
    const countBadge = document.getElementById('outlets-status-count-badge');
    if (countBadge) {
      const offCount = filtered.filter(r => get2SlotStatus(r).toLowerCase().includes('off')).length;
      const partCount = filtered.filter(r => get2SlotStatus(r).toLowerCase().includes('part')).length;
      countBadge.textContent = `${filtered.length} Outlets (${offCount} Offline · ${partCount} Partial)`;
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; padding: 2.5rem; color: var(--text-muted); font-weight: 600;">No partial or offline 2-slot outlets matching the selected criteria.</td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    filtered.forEach(ro => {
      const tr = document.createElement('tr');
      const nlStatus = get2SlotStatus(ro);
      let nlBadgeClass = 'badge-offline';
      if (nlStatus.toLowerCase().includes('part')) nlBadgeClass = 'badge-partial';
      else if (nlStatus.toLowerCase().includes('fully') || nlStatus.toLowerCase() === 'online') nlBadgeClass = 'badge-online';

      const stored = getStoredOutletData(ro.roid);

      // RO ID
      const tdRoid = document.createElement('td');
      tdRoid.innerHTML = `<b>${ro.roid}</b>`;
      tr.appendChild(tdRoid);

      // RO Name
      const tdName = document.createElement('td');
      tdName.setAttribute('title', ro.outlet_name || '');
      tdName.textContent = ro.outlet_name || '';
      tr.appendChild(tdName);

      // Sales Area
      const tdArea = document.createElement('td');
      tdArea.textContent = ro.sales_area || '';
      tr.appendChild(tdArea);

      // Vendor
      const tdVendor = document.createElement('td');
      tdVendor.textContent = ro.vendor || 'Unmapped';
      tr.appendChild(tdVendor);

      // EO
      const tdEO = document.createElement('td');
      tdEO.textContent = ro.eo_name || '';
      tr.appendChild(tdEO);

      // MST
      const tdMST = document.createElement('td');
      tdMST.textContent = ro.mst_name || '';
      tr.appendChild(tdMST);

      // IOT/WFCC
      const tdTech = document.createElement('td');
      const isIOT = (ro.iot_status === 'IOT');
      tdTech.innerHTML = `<span class="badge" style="background:${isIOT ? 'rgba(16,185,129,0.15)' : 'rgba(99,102,241,0.15)'}; color:${isIOT ? '#059669' : '#4f46e5'}; border:1px solid ${isIOT ? 'rgba(16,185,129,0.3)' : 'rgba(99,102,241,0.3)'}; font-weight:700;">${ro.iot_status}</span>`;
      tr.appendChild(tdTech);

      // 2 slot status
      const tdStatus = document.createElement('td');
      tdStatus.innerHTML = `<span class="badge ${nlBadgeClass}">${nlStatus}</span>`;
      tr.appendChild(tdStatus);

      // Responsibility
      const tdResp = document.createElement('td');
      const selResp = document.createElement('select');
      selResp.className = 'table-select';
      const respOptions = ['', 'DEALER', 'BPCL', 'RA VENDOR', 'VENDOR'];
      respOptions.forEach(optVal => {
        const opt = document.createElement('option');
        opt.value = optVal;
        opt.textContent = optVal === '' ? 'Select' : optVal;
        if (optVal === stored.responsibility) opt.selected = true;
        selResp.appendChild(opt);
      });
      selResp.addEventListener('change', (e) => {
        saveStoredOutletData(ro.roid, { responsibility: e.target.value });
      });
      tdResp.appendChild(selResp);
      tr.appendChild(tdResp);

      // Complaint remarks
      const tdRemark = document.createElement('td');
      const inpRemark = document.createElement('input');
      inpRemark.type = 'text';
      inpRemark.className = 'table-input';
      inpRemark.style.width = '180px';
      inpRemark.placeholder = 'Enter remarks...';
      inpRemark.value = stored.remark || '';
      inpRemark.addEventListener('change', (e) => {
        saveStoredOutletData(ro.roid, { remark: e.target.value.trim() });
      });
      tdRemark.appendChild(inpRemark);
      tr.appendChild(tdRemark);

      // BROMA No
      const tdBroma = document.createElement('td');
      const inpBroma = document.createElement('input');
      inpBroma.type = 'text';
      inpBroma.className = 'table-input';
      inpBroma.style.width = '110px';
      inpBroma.placeholder = 'BROMA No';
      inpBroma.value = stored.broma_no || '';
      inpBroma.addEventListener('change', (e) => {
        saveStoredOutletData(ro.roid, { broma_no: e.target.value.trim() });
      });
      tdBroma.appendChild(inpBroma);
      tr.appendChild(tdBroma);

      // Date
      const tdDate = document.createElement('td');
      const inpDate = document.createElement('input');
      inpDate.type = 'date';
      inpDate.className = 'table-input';
      inpDate.style.width = '130px';
      inpDate.value = stored.date || getTodayDateStr();
      inpDate.addEventListener('change', (e) => {
        saveStoredOutletData(ro.roid, { date: e.target.value });
      });
      tdDate.appendChild(inpDate);
      tr.appendChild(tdDate);

      // Target Date
      const tdTarget = document.createElement('td');
      const inpTarget = document.createElement('input');
      inpTarget.type = 'date';
      inpTarget.className = 'table-input';
      inpTarget.style.width = '130px';
      inpTarget.value = stored.target_date || '';
      inpTarget.addEventListener('change', (e) => {
        saveStoredOutletData(ro.roid, { target_date: e.target.value });
      });
      tdTarget.appendChild(inpTarget);
      tr.appendChild(tdTarget);

      fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);
  }

  function exportOutletsStatusCSV() {
    const list = outletsStatusFilteredList;
    if (!list || list.length === 0) {
      if (window.showToast) window.showToast('No outlets data to export', 'error');
      return;
    }

    const headers = [
      "RO ID",
      "RO Name",
      "Sales area",
      "Vendor",
      "EO",
      "MST",
      "IOT/WFCC",
      "2 slot status",
      "Responsibility",
      "Complaint remarks",
      "BROMA No",
      "Date",
      "Target date"
    ];

    let csv = "data:text/csv;charset=utf-8,";
    csv += headers.map(h => `"${h.replace(/"/g, '""')}"`).join(",") + "\n";

    list.forEach(ro => {
      const stored = getStoredOutletData(ro.roid);
      const row = [
        ro.roid,
        ro.outlet_name || '',
        ro.sales_area || '',
        ro.vendor || 'Unmapped',
        ro.eo_name || '',
        ro.mst_name || '',
        ro.iot_status || '',
        get2SlotStatus(ro),
        stored.responsibility || '',
        stored.remark || '',
        stored.broma_no || '',
        stored.date || '',
        stored.target_date || ''
      ];
      csv += row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(",") + "\n";
    });

    const encodedUri = encodeURI(csv);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'Outlets_Status_2Slot.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (window.showToast) window.showToast(`Exported ${list.length} outlets to CSV!`, 'success');
  }

  function setupOutletsStatusEventListeners() {
    const searchInput = document.getElementById('outlets-status-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', renderOutletsStatusTable);
    }

    ['outlets-status-filter-status', 'outlets-status-filter-area', 'outlets-status-filter-vendor', 'outlets-status-filter-tech', 'outlets-status-filter-resp'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', renderOutletsStatusTable);
    });

    const exportBtn = document.getElementById('export-outlets-status-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', exportOutletsStatusCSV);
    }

    // Sort clicks on headers
    const headers = document.querySelectorAll('#outlets-status-table th[data-sort]');
    headers.forEach(th => {
      th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        if (outletsStatusSortField === field) {
          outletsStatusSortAsc = !outletsStatusSortAsc;
        } else {
          outletsStatusSortField = field;
          outletsStatusSortAsc = true;
        }

        headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(outletsStatusSortAsc ? 'sort-asc' : 'sort-desc');

        renderOutletsStatusTable();
      });
    });
  }

  // Expose global methods
  window.renderOutletsStatusTable = renderOutletsStatusTable;
  window.populateOutletsStatusFilters = populateOutletsStatusFilters;
  window.exportOutletsStatusCSV = exportOutletsStatusCSV;
  window.setupOutletsStatusEventListeners = setupOutletsStatusEventListeners;

  // Auto initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupOutletsStatusEventListeners);
  } else {
    setupOutletsStatusEventListeners();
  }
})();
