/**
 * Outlets Status Module
 * Displays 2-Slot Partial & Offline Outlets with interactive tracking:
 * RO ID, RO Name, Sales area, Vendor, EO, MST, IOT/WFCC, 2 slot status,
 * Responsibility, Complaint remarks, BROMA No, Date, Target date.
 * Supports:
 * - Excel & CSV Import of Remarks, BROMA No, Responsibility, Dates
 * - Multi-user Live Cloud Sync via Google Sheets Apps Script
 * - Immediate persistence and cross-device synchronization on Git links
 */

(function() {
  let outletsStatusSortField = 'roid';
  let outletsStatusSortAsc = true;
  let outletsStatusFilteredList = [];
  const debounceTimers = {};

  function getTodayDateStr() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function normalizeDateStr(val) {
    if (!val) return '';
    if (typeof val === 'number') {
      // Excel serial date to YYYY-MM-DD
      const date = new Date(Math.round((val - 25569) * 86400 * 1000));
      return date.toISOString().split('T')[0];
    }
    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    // DD-MM-YYYY or DD/MM/YYYY
    const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (dmyMatch) {
      const day = dmyMatch[1].padStart(2, '0');
      const month = dmyMatch[2].padStart(2, '0');
      const year = dmyMatch[3];
      return `${year}-${month}-${day}`;
    }
    return str;
  }

  function getStoredOutletData(roid) {
    const key = String(roid);
    const sharedDay = (typeof getSharedDayData === 'function') 
      ? getSharedDayData(key) 
      : ((window.dayMonitoringShared && window.dayMonitoringShared[key]) || {});

    const raw = localStorage.getItem('outlets_status_' + key);
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); } catch(e) {}
    }

    const dayRaw = localStorage.getItem('day_remarks_' + key);
    let dayData = {};
    if (dayRaw) {
      try { dayData = JSON.parse(dayRaw); } catch(e) {}
    }

    // Cloud values from shared Google Sheets backend take priority so any user opening the git link sees the latest updates!
    const resp = sharedDay.responsibility || data.responsibility || dayData.responsibility || '';
    const remark = sharedDay.remark || data.remark || dayData.remark || '';
    const broma = sharedDay.bromaNo || sharedDay.broma_no || data.broma_no || dayData.broma_no || '';
    const dt = sharedDay.date || data.date || dayData.date || getTodayDateStr();
    const targetDt = sharedDay.targetDate || sharedDay.target_date || data.target_date || dayData.targetDate || '';

    return {
      responsibility: resp,
      remark: remark,
      broma_no: broma,
      date: dt,
      target_date: targetDt
    };
  }

  async function saveStoredOutletData(roid, updates, syncCloud = true) {
    const key = String(roid);
    const current = getStoredOutletData(key);
    const updated = Object.assign({}, current, updates);
    localStorage.setItem('outlets_status_' + key, JSON.stringify(updated));

    // Also sync to day_remarks_
    const dayRaw = localStorage.getItem('day_remarks_' + key);
    let dayData = {};
    if (dayRaw) {
      try { dayData = JSON.parse(dayRaw); } catch(e) {}
    }
    dayData.responsibility = updated.responsibility;
    dayData.remark = updated.remark;
    dayData.targetDate = updated.target_date;
    dayData.broma_no = updated.broma_no;
    dayData.date = updated.date;
    localStorage.setItem('day_remarks_' + key, JSON.stringify(dayData));

    // Update memory shared object immediately
    if (window.dayMonitoringShared) {
      const existing = window.dayMonitoringShared[key] || {};
      window.dayMonitoringShared[key] = Object.assign({}, existing, {
        roid: key,
        responsibility: updated.responsibility,
        remark: updated.remark,
        targetDate: updated.target_date,
        bromaNo: updated.broma_no,
        date: updated.date,
        updatedAt: new Date().toISOString()
      });
    }

    if (syncCloud) {
      const ro = (window.calculatedROs || []).find(r => String(r.roid) === key) || { roid: key };
      if (typeof window.saveSharedDayMonitoringRow === 'function') {
        window.saveSharedDayMonitoringRow(
          ro,
          updated.responsibility,
          updated.remark,
          updated.target_date,
          false,
          updated.broma_no,
          updated.date
        );
      }
    }
  }

  function debouncedSave(roid, updates, delay = 500) {
    const key = String(roid);
    // Save to local storage immediately
    saveStoredOutletData(key, updates, false);

    // Debounce cloud sync so typing doesn't overload the network
    if (debounceTimers[key]) clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(() => {
      saveStoredOutletData(key, updates, true);
      delete debounceTimers[key];
    }, delay);
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
      countBadge.innerHTML = `<span>${filtered.length} Outlets</span> <span style="opacity: 0.4;">|</span> <span style="color: #fca5a5;">${offCount} Offline</span> <span style="opacity: 0.4;">·</span> <span style="color: #fcd34d;">${partCount} Partial</span>`;
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; padding: 2.5rem; color: var(--text-muted); font-weight: 600;">No partial or offline 2-slot outlets matching the selected criteria.</td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    filtered.forEach(ro => {
      const tr = document.createElement('tr');
      const nlStatus = get2SlotStatus(ro);
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

      // IOT/WFCC - Normal format
      const tdTech = document.createElement('td');
      tdTech.textContent = ro.iot_status || '';
      tr.appendChild(tdTech);

      // 2 slot status - Normal format
      const tdStatus = document.createElement('td');
      const isOff = nlStatus.toLowerCase().includes('off');
      tdStatus.innerHTML = `<span style="font-weight: 600; color: ${isOff ? '#dc2626' : '#d97706'};">${nlStatus}</span>`;
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
        saveStoredOutletData(ro.roid, { responsibility: e.target.value }, true);
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
      inpRemark.addEventListener('input', (e) => {
        debouncedSave(ro.roid, { remark: e.target.value });
      });
      inpRemark.addEventListener('change', (e) => {
        saveStoredOutletData(ro.roid, { remark: e.target.value.trim() }, true);
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
      inpBroma.addEventListener('input', (e) => {
        debouncedSave(ro.roid, { broma_no: e.target.value });
      });
      inpBroma.addEventListener('change', (e) => {
        saveStoredOutletData(ro.roid, { broma_no: e.target.value.trim() }, true);
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
        saveStoredOutletData(ro.roid, { date: e.target.value }, true);
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
        saveStoredOutletData(ro.roid, { target_date: e.target.value }, true);
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

  /**
   * Import Excel / CSV with Remarks, BROMA No, Responsibility, Date, Target Date
   */
  function handleOutletsStatusImportFile(file) {
    if (!file) return;
    if (window.showToast) window.showToast('Reading file for import...', 'info');

    const reader = new FileReader();
    reader.onload = async function(e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

        if (!rows || rows.length === 0) {
          if (window.showToast) window.showToast('No rows found in the imported file.', 'error');
          return;
        }

        const keys = Object.keys(rows[0] || {});
        function findKey(patterns) {
          return keys.find(k => {
            const clean = k.toLowerCase().replace(/[^a-z0-9]/g, '');
            return patterns.some(p => clean.includes(p));
          });
        }

        const roidKey = findKey(['roid', 'outletid', 'outletcode', 'rocode', 'code', 'id']);
        const respKey = findKey(['responsibility', 'resp', 'responsible']);
        const remarkKey = findKey(['complaintremark', 'remarks', 'remark', 'complaint', 'issue', 'reason']);
        const bromaKey = findKey(['bromano', 'broma', 'ticket', 'complaintno']);
        const dateKey = findKey(['date', 'entrydate', 'complaintdate']);
        const targetDateKey = findKey(['targetdate', 'targetdt', 'target']);

        if (!roidKey) {
          if (window.showToast) window.showToast('Could not find RO ID column in the imported file.', 'error');
          return;
        }

        let updatedCount = 0;
        const batchRows = [];
        const allROs = window.calculatedROs || [];

        rows.forEach(r => {
          const rawRoid = r[roidKey];
          if (!rawRoid) return;
          const roid = String(rawRoid).replace(/[^0-9]/g, '');
          if (!roid) return;

          const currentStored = getStoredOutletData(roid);
          const newResp = (respKey && r[respKey] !== undefined && String(r[respKey]).trim() !== '') ? String(r[respKey]).trim() : currentStored.responsibility;
          const newRemark = (remarkKey && r[remarkKey] !== undefined && String(r[remarkKey]).trim() !== '') ? String(r[remarkKey]).trim() : currentStored.remark;
          const newBroma = (bromaKey && r[bromaKey] !== undefined && String(r[bromaKey]).trim() !== '') ? String(r[bromaKey]).trim() : currentStored.broma_no;
          const newDate = (dateKey && r[dateKey] !== undefined && String(r[dateKey]).trim() !== '') ? normalizeDateStr(r[dateKey]) : currentStored.date;
          const newTargetDate = (targetDateKey && r[targetDateKey] !== undefined && String(r[targetDateKey]).trim() !== '') ? normalizeDateStr(r[targetDateKey]) : currentStored.target_date;

          const updated = {
            responsibility: newResp,
            remark: newRemark,
            broma_no: newBroma,
            date: newDate,
            target_date: newTargetDate
          };

          // Save locally
          localStorage.setItem('outlets_status_' + roid, JSON.stringify(updated));

          // Sync to day_remarks_
          const dayRaw = localStorage.getItem('day_remarks_' + roid);
          let dayData = {};
          if (dayRaw) {
            try { dayData = JSON.parse(dayRaw); } catch(err) {}
          }
          dayData.responsibility = newResp;
          dayData.remark = newRemark;
          dayData.targetDate = newTargetDate;
          dayData.broma_no = newBroma;
          dayData.date = newDate;
          localStorage.setItem('day_remarks_' + roid, JSON.stringify(dayData));

          // Prepare shared cloud row
          const roObj = allROs.find(ro => String(ro.roid) === roid) || { roid: roid };
          const cloudRow = {
            date: newDate || (typeof getDayMonitoringDate === 'function' ? getDayMonitoringDate() : getTodayDateStr()),
            roid: roid,
            outletName: roObj.outlet_name || '',
            salesArea: roObj.sales_area || '',
            vendor: roObj.vendor || '',
            status: roObj.status || '',
            iot: roObj.iot_status || '',
            uptime: Number(roObj.uptime || 0),
            offlineMpd: Number(roObj.off_mpd || 0),
            offlineTank: Number(roObj.off_tnk || 0),
            responsibility: newResp,
            remark: newRemark,
            targetDate: newTargetDate,
            bromaNo: newBroma,
            updatedBy: (typeof getCurrentDashboardUserName === 'function') ? getCurrentDashboardUserName() : 'Excel Import',
            updatedAt: new Date().toISOString(),
            territory: 'Belgaum'
          };

          if (typeof setSharedDayData === 'function') {
            setSharedDayData(roid, cloudRow);
          } else if (window.dayMonitoringShared) {
            window.dayMonitoringShared[roid] = cloudRow;
          }

          batchRows.push(cloudRow);
          updatedCount++;
        });

        // Re-render table immediately
        renderOutletsStatusTable();
        if (typeof renderDayMonitoringTable === 'function') {
          renderDayMonitoringTable();
        }

        // Push batch to Google Apps Script cloud backend in background
        if (batchRows.length > 0 && typeof dayMonitoringApiRequest === 'function') {
          try {
            const apiResult = await dayMonitoringApiRequest('POST', {
              action: 'saveRows',
              rows: batchRows
            });
            if (apiResult && apiResult.success) {
              const statusEl = document.getElementById('outlets-status-cloud-status');
              if (statusEl) {
                statusEl.textContent = `Shared Live Sync: Synced ${updatedCount} outlets at ${new Date().toLocaleTimeString()}.`;
              }
            }
          } catch (cloudErr) {
            console.warn('Batch cloud sync error:', cloudErr);
          }
        }

        if (window.showToast) {
          window.showToast(`Imported & updated ${updatedCount} outlets successfully!`, 'success');
        }
      } catch (err) {
        console.error('Import error:', err);
        if (window.showToast) window.showToast('Error processing file: ' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
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

    // Import file input listener
    const importInput = document.getElementById('import-outlets-status-input');
    if (importInput) {
      importInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          handleOutletsStatusImportFile(e.target.files[0]);
          e.target.value = ''; // Reset input so same file can be re-selected if modified
        }
      });
    }

    // Cloud sync button
    const syncBtn = document.getElementById('sync-outlets-status-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        syncBtn.style.opacity = '0.6';
        if (window.showToast) window.showToast('Syncing latest cloud data...', 'info');
        try {
          if (typeof window.loadSharedDayMonitoring === 'function') {
            await window.loadSharedDayMonitoring(false);
          }
          renderOutletsStatusTable();
          const statusEl = document.getElementById('outlets-status-cloud-status');
          if (statusEl) {
            statusEl.textContent = `Shared Live Sync: Refreshed at ${new Date().toLocaleTimeString()}.`;
          }
          if (window.showToast) window.showToast('Synced latest remarks and BROMA details!', 'success');
        } catch (err) {
          console.warn('Sync failed:', err);
        } finally {
          syncBtn.disabled = false;
          syncBtn.style.opacity = '1';
        }
      });
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
  window.handleOutletsStatusImportFile = handleOutletsStatusImportFile;
  window.setupOutletsStatusEventListeners = setupOutletsStatusEventListeners;

  // Auto initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupOutletsStatusEventListeners);
  } else {
    setupOutletsStatusEventListeners();
  }
})();
