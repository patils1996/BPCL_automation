// Application Controller for BPCL Automation Monitoring Dashboard

// State variables (exposed globally on window for integration)
window.defaultMappings = {};
window.customMappings = {};
window.activeMappings = {};
window.rawDataRows = [];
window.calculatedROs = [];
window.salesAreaSummary = [];
window.eoSummary = [];
window.soSummary = [];
window.vendorSummary = [];
window.overallMetrics = {};
window.dashboardFilteredROs = [];

// Local references for compatibility
var defaultMappings = window.defaultMappings;
var customMappings = window.customMappings;
var activeMappings = window.activeMappings;
var rawDataRows = window.rawDataRows;

// Default outlet order everywhere: Sales Area (A–Z, Unmapped last), then RO code
function compareBySalesArea(a, b) {
  const aa = String((a && a.sales_area) || '').trim(), ba = String((b && b.sales_area) || '').trim();
  const ua = !aa || aa === 'Unmapped', ub = !ba || ba === 'Unmapped';
  if (ua !== ub) return ua ? 1 : -1;
  const c = aa.localeCompare(ba, 'en', { sensitivity: 'base' });
  if (c) return c;
  const ra = parseInt(String(a.roid || '').replace(/\D/g, ''), 10) || 0, rb = parseInt(String(b.roid || '').replace(/\D/g, ''), 10) || 0;
  return ra - rb;
}
window.compareBySalesArea = compareBySalesArea;
var calculatedROs = window.calculatedROs;
var salesAreaSummary = window.salesAreaSummary;
var eoSummary = window.eoSummary;
var soSummary = window.soSummary;
var vendorSummary = window.vendorSummary;
var overallMetrics = window.overallMetrics;
var dashboardFilteredROs = window.dashboardFilteredROs;

// Charts instances
let statusPieChartInstance = null;
let salesAreaBarChartInstance = null;

// Pagination and Sorting states
const RO_PAGE_SIZE = 15;
let roCurrentPage = 1;
let roSortField = 'sales_area'; // default: grouped by sales area, then RO code
let roSortAsc = true;
let roFilteredList = [];

const MAP_PAGE_SIZE = 15;
let mapCurrentPage = 1;
let mapSortField = 'roid';
let mapSortAsc = true;
let mapFilteredList = [];

// Initialize application on load
window.addEventListener('DOMContentLoaded', async () => {
  // Register PWA Service Worker with auto-update / reload logic
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('Service Worker registered', reg);
        reg.update();
      })
      .catch(err => console.log('Service Worker registration failed', err));
      
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  initTheme();
  initTabs();
  setupEventListeners();
  startLiveClock();
  
  // Mobile Hamburger Toggle
  const btnMenuToggle = document.getElementById('btn-menu-toggle');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  if (btnMenuToggle && sidebarBackdrop) {
    btnMenuToggle.addEventListener('click', () => {
      document.body.classList.toggle('sidebar-open');
    });
    sidebarBackdrop.addEventListener('click', () => {
      document.body.classList.remove('sidebar-open');
    });
    
    // Close sidebar when clicking any menu item on mobile
    const menuItems = document.querySelectorAll('.sidebar .menu-item');
    menuItems.forEach(item => {
      item.addEventListener('click', () => {
        document.body.classList.remove('sidebar-open');
      });
    });
  }
  
  // Load mappings
  await loadMappings();
  
  // Load sample data if available
  document.getElementById('load-sample-btn').addEventListener('click', () => {
    loadSampleData();
  });
  
  // Bind Google Sheet Sync Buttons
  const syncBtn = document.getElementById('btn-sync-sheet');
  const syncBtnLanding = document.getElementById('btn-sync-sheet-landing');
  if (syncBtn) {
    syncBtn.addEventListener('click', window.syncGoogleSheet);
  }
  if (syncBtnLanding) {
    syncBtnLanding.addEventListener('click', window.syncGoogleSheet);
  }

  // Bind Google Sheet Link Configuration
  const setupGoogleSheetLink = () => {
    const currentUrl = localStorage.getItem('bpcl_google_sheet_url') || 'https://docs.google.com/spreadsheets/d/14KDPhrCgKmZzLKNzSdS6YtPIeXdDtlXPbbPWMVxFA5I/export?format=xlsx';
    const newUrl = prompt("Enter your Google Sheet URL:\n(Either copy the address bar link, or use File > Share > Publish to web > CSV Link)", currentUrl);
    if (newUrl !== null && newUrl.trim() !== "") {
      localStorage.setItem('bpcl_google_sheet_url', newUrl.trim());
      showToast("Google Sheet URL updated successfully!", "success");
    }
  };

  const linkSetup = document.getElementById('link-setup-sheet');
  const linkSetupLanding = document.getElementById('link-setup-sheet-landing');
  if (linkSetup) linkSetup.addEventListener('click', setupGoogleSheetLink);
  if (linkSetupLanding) linkSetupLanding.addEventListener('click', setupGoogleSheetLink);

  // Helper to restore latest data from local IndexedDB if offline
  const restoreLatestFromHistory = async () => {
    try {
      if (!DB.db) await DB.open();
      const records = await DB.getAllRecords();
      if (records && records.length > 0) {
        const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
        const latest = sorted[0];
        console.log("Restoring latest uploaded data from IndexedDB:", latest.filename);
        
        // Stored rawData is already parsed row objects — load it directly (re-parsing crashes)
        rawDataRows.length = 0;
        (latest.rawData || []).forEach(r => rawDataRows.push(r));
        window.overallMetrics = latest.metrics;
        window.dashboardMode = (latest.rawData[0] && latest.rawData[0].station_name !== undefined) ? 'evcs' : 'automation';

        recalculateAndRefresh();
        
        document.getElementById('upload-landing-view').style.display = 'none';
        document.getElementById('dashboard-active-view').style.display = 'flex';
        
        document.getElementById('file-meta').textContent = `Loaded from DB: ${latest.filename} (${latest.date} ${latest.time})`;
        document.getElementById('file-meta').style.display = 'block';
        document.getElementById('header-upload-wrapper').style.display = 'block';
        document.getElementById('btn-sync-sheet').style.display = 'inline-flex';
        document.getElementById('link-setup-sheet').style.display = 'inline-block';
      }
    } catch (e) {
      console.error("IndexedDB startup restore failed:", e);
    }
  };

  // Auto-sync Google Sheet on startup with local database fallback
  try {
    await window.syncGoogleSheet(true); // Try silent auto-sync
  } catch (err) {
    console.warn("Auto Google Sheet sync failed on startup, loading from local IndexedDB backup...", err);
    await restoreLatestFromHistory();
  }
});

// Theme Management
function initTheme() {
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (!themeToggleBtn) return;
  const sunIcon = themeToggleBtn.querySelector('.theme-icon-sun');
  const moonIcon = themeToggleBtn.querySelector('.theme-icon-moon');
  
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcons(savedTheme, sunIcon, moonIcon);
  
  themeToggleBtn.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcons(newTheme, sunIcon, moonIcon);
  });
}

function updateThemeIcons(theme, sun, moon) {
  if (theme === 'light') {
    sun.style.display = 'block';
    moon.style.display = 'none';
  } else {
    sun.style.display = 'none';
    moon.style.display = 'block';
  }
}

// Tab Controls
function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(targetId).classList.add('active');
    });
  });
}

// Load EO-SO Mapping
async function loadMappings() {
  try {
    const response = await fetch('mapping.json');
    if (response.ok) {
      defaultMappings = await response.json();
    }
  } catch (e) {
    console.warn("Could not load mapping.json, using fallback empty mappings", e);
  }
  
  // Load custom mappings from localstorage
  try {
    const savedCustom = localStorage.getItem('bpcl_custom_mappings');
    if (savedCustom) {
      customMappings = JSON.parse(savedCustom);
    }
  } catch (e) {
    console.error("Error reading custom mappings from localStorage", e);
  }
  
  refreshActiveMappings();
  renderMappingsTable();
}

function refreshActiveMappings() {
  activeMappings = Object.assign({}, defaultMappings, customMappings);
}

// File Upload Listeners
function setupEventListeners() {
  // Main dropzone upload
  const uploadLanding = document.getElementById('upload-landing-view');
  const mainFileInput = document.getElementById('main-file-input');
  
  // Drag and drop handlers
  uploadLanding.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadLanding.classList.add('dragover');
  });
  
  uploadLanding.addEventListener('dragleave', () => {
    uploadLanding.classList.remove('dragover');
  });
  
  uploadLanding.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadLanding.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      window.handleUploadedFile(files[0]);
    }
  });
  
  mainFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      window.handleUploadedFile(e.target.files[0]);
    }
  });
  
  // Header upload
  const headerFileInput = document.getElementById('header-file-input');
  headerFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      window.handleUploadedFile(e.target.files[0]);
    }
  });
  
  // RO Explorer Search & Filters
  const roSearchInput = document.getElementById('ro-search-input');
  if (roSearchInput) {
    roSearchInput.addEventListener('input', () => {
      roCurrentPage = 1;
      filterROExplorer();
    });
  }

  // Global enterprise filters
  ['global-filter-sales-area', 'global-filter-vendor', 'global-filter-status', 'global-filter-region', 'global-filter-state-office', 'global-filter-territory', 'global-filter-onboarded'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        roCurrentPage = 1;
        filterROExplorer();
      });
    }
  });

  ['ro-filter-new-logic', 'ro-filter-status', 'ro-filter-nano', 'ro-filter-area', 'ro-filter-technology'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        roCurrentPage = 1;
        filterROExplorer();
      });
    }
  });
  
  // Day Monitoring Search
  document.getElementById('day-search-input').addEventListener('input', () => {
    renderDayMonitoringTable();
  });

  // Save a complete daily snapshot to Google Drive
  const saveDayDriveBtn = document.getElementById('save-day-monitoring-drive-btn');
  if (saveDayDriveBtn) {
    saveDayDriveBtn.addEventListener('click', window.saveDailyDayMonitoringToDrive);
  }


  // Day Monitoring Header Filters
  ['day-filter-area', 'day-filter-vendor', 'day-filter-status', 'day-filter-tech', 'day-filter-resp'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        renderDayMonitoringTable();
      });
    }
  });
  
  // Mapping search
  document.getElementById('map-search-input').addEventListener('input', () => {
    mapCurrentPage = 1;
    filterMappings();
  });
  
  // Mapping Reset button
  document.getElementById('map-reset-btn').addEventListener('click', () => {
    if (confirm("Are you sure you want to delete all custom mappings and restore default database mappings?")) {
      customMappings = {};
      localStorage.removeItem('bpcl_custom_mappings');
      refreshActiveMappings();
      showToast("Mappings reset to default database!", "success");
      renderMappingsTable();
      if (calculatedROs.length > 0) {
        recalculateAndRefresh();
      }
    }
  });
  
  // Mapping form submission
  document.getElementById('mapping-entry-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const roid = document.getElementById('map-roid').value.trim();
    const name = document.getElementById('map-outlet').value.trim();
    const eo = document.getElementById('map-eo').value.trim();
    const so = document.getElementById('map-so').value.trim();
    const mst = document.getElementById('map-mst').value.trim();
    const group = document.getElementById('map-group').value.trim();
    
    if (!roid || !name || !eo || !so) {
      showToast("Please fill in all required fields", "error");
      return;
    }
    
    customMappings[roid] = {
      'outlet_name': name,
      'eo_name': eo,
      'sales_group': group,
      'so_name': so,
      'mst_name': mst
    };
    
    localStorage.setItem('bpcl_custom_mappings', JSON.stringify(customMappings));
    refreshActiveMappings();
    showToast(`Saved mapping for ROID ${roid}`, "success");
    document.getElementById('mapping-entry-form').reset();
    renderMappingsTable();
    if (calculatedROs.length > 0) {
      recalculateAndRefresh();
    }
  });
  
  document.getElementById('map-clear-btn').addEventListener('click', () => {
    document.getElementById('mapping-entry-form').reset();
  });
  
  // Import mapping file button
  document.getElementById('map-import-input').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleMappingsImportFile(e.target.files[0]);
    }
  });
  
  // Exports
  document.getElementById('export-sales-area-btn').addEventListener('click', () => {
    exportToCSV(salesAreaSummary, 'SalesArea_Summary.csv', true);
  });
  document.getElementById('export-eo-btn').addEventListener('click', () => {
    exportToCSV(eoSummary, 'TE_Summary.csv', false);
  });
  document.getElementById('export-so-btn').addEventListener('click', () => {
    const rows = (window.territorySummary || []).concat(window.territorySummaryTotal && window.territorySummary.length > 1 ? [window.territorySummaryTotal] : []);
    exportToCSV(rows, 'Territory_Summary.csv', false);
  });
  const exportVendorBtn = document.getElementById('export-vendor-btn');
  if (exportVendorBtn) {
    exportVendorBtn.addEventListener('click', () => {
      exportToCSV(vendorSummary, 'Vendor_Summary.csv', false);
    });
  }
  document.getElementById('export-ro-btn').addEventListener('click', () => {
    const listToExport = (roFilteredList && roFilteredList.length >= 0) ? roFilteredList : calculatedROs;
    exportToCSV(listToExport, 'RetailOutlet_Details.csv', false, true);
  });
  const exportDayBtn = document.getElementById('export-day-monitoring-btn');
  if (exportDayBtn) {
    exportDayBtn.addEventListener('click', () => {
      exportDayMonitoringData();
    });
  }
  
  // Sort clicks on tables
  setupTableSort();
  
  // Monitoring comparison event listeners
  if (window.setupMonitoringListeners) {
    window.setupMonitoringListeners();
  }
}

// Table sorting event registration
function setupTableSort() {
  // RO Table headers
  const roHeaders = document.querySelectorAll('#ro-explorer-table th[data-sort]');
  roHeaders.forEach(th => {
    th.addEventListener('click', () => {
      const field = th.getAttribute('data-sort');
      if (roSortField === field) {
        roSortAsc = !roSortAsc;
      } else {
        roSortField = field;
        roSortAsc = true;
      }
      
      // Update UI header symbols
      roHeaders.forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(roSortAsc ? 'sort-asc' : 'sort-desc');
      
      sortROs();
      renderROExplorerPage();
    });
  });

  // Mappings Table headers
  const mapHeaders = document.querySelectorAll('#mapping-table th[data-mapsort]');
  mapHeaders.forEach(th => {
    th.addEventListener('click', () => {
      const field = th.getAttribute('data-mapsort');
      if (mapSortField === field) {
        mapSortAsc = !mapSortAsc;
      } else {
        mapSortField = field;
        mapSortAsc = true;
      }
      
      mapHeaders.forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(mapSortAsc ? 'sort-asc' : 'sort-desc');
      
      sortMappings();
      renderMappingsPage();
    });
  });
}

// Recalculates metrics and redraws UI
function recalculateAndRefresh() {
  if (window.dashboardMode === 'evcs') {
    document.getElementById('automation-overview-sec').style.display = 'none';
    document.getElementById('evcs-overview-sec').style.display = 'block';
    
    // Change app title
    document.querySelector('header h1').innerHTML = `EVCS Live <span class="highlight-yellow">Status</span>`;
    
    processEvcsCalculations();
    updateEvcsDashboardKPIs();
    updateEvcsOverviewCharts();
  } else {
    document.getElementById('evcs-overview-sec').style.display = 'none';
    document.getElementById('automation-overview-sec').style.display = 'block';
    
    // Restore app title for the active tab
    if (window.uiSetPageTitle) {
      const activeNav = document.querySelector('.sidebar-menu .menu-item.active');
      window.uiSetPageTitle(activeNav ? activeNav.dataset.tab : 'tab-overview', activeNav, { keepScroll: true });
    }
    
    processCalculations(rawDataRows);
    updateDashboardKPIs();
    updateOverviewCharts();
    renderSalesAreaTable();
    renderEOTable();
    renderSOTable();
    renderVendorTable();
    
    // Update filter select dropdown values
    populateFilters();
    filterROExplorer();
    
    // Day Monitoring header filters
    populateDayMonitoringHeaderFilters();
    
    // Notify comparison engine if present
    if (typeof window.onDashboardDataUpdated === 'function') {
      window.onDashboardDataUpdated();
    }
    
    // Notify New Logic Dashboard
    // Notify Outlets Status (2 Slot Partial & Offline Sites)
    if (typeof window.populateOutletsStatusFilters === 'function') {
      window.populateOutletsStatusFilters();
    }
    if (typeof window.renderOutletsStatusTable === 'function') {
      window.renderOutletsStatusTable();
    }

    if (typeof window.renderNewLogicDashboard === 'function') {
      window.renderNewLogicDashboard();
    }

    if (typeof window.renderTerritoryPerformance === 'function') {
      window.renderTerritoryPerformance();
    }
    if (window.DataFreshness) window.DataFreshness.render();
    if (typeof window.renderDashboardExtraCharts === 'function') window.renderDashboardExtraCharts();
  }
}

// File Processing
window.handleUploadedFile = function(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      // Read the workbook in the background (no page freeze)
      const book = await WorkbookReader.read(e.target.result);
      const mapAoa = book.byKind('mapping');
      if (mapAoa) parseMappingsFromSheet(mapAoa);
      const rawDataSheetName = pickUptimeSheet(book);
      const parsedData = rawDataSheetName ? book.rows[rawDataSheetName] : [];
      if (window.TankStock && (book.byKind('tank_latest') || book.byKind('tank_hourly'))) {
        window.TankStock.ingestSheets({ latest: book.byKind('tank_latest'), hourly: book.byKind('tank_hourly'), onboarded: book.byKind('tank_onboarded') });
      }

      // Cache raw sheet JSON objects for New Logic Dashboard
      try {
        window.rawSheetObjects = WorkbookReader.aoaToObjects(parsedData, '');
        window.lastUploadedFileName = file.name;
      } catch (eRaw) {
        console.warn('Could not cache rawSheetObjects', eRaw);
      }
      
      if (parsedData.length < 3) {
        showToast("Invalid sheet structure: not enough rows", "error");
        return;
      }
      
      // Process raw rows
      parseRawData(parsedData);
      
      // Recalculate
      if (window.DataFreshness) DataFreshness.fromUpload(file.lastModified || Date.now(), file.name);
      recalculateAndRefresh();
      
      // Switch view from upload landing to active dashboard
      document.getElementById('upload-landing-view').style.display = 'none';
      document.getElementById('dashboard-active-view').style.display = 'flex';
      
      // Show header elements
      document.getElementById('file-meta').textContent = `Loaded: ${file.name} (${rawDataRows.length} rows)`;
      document.getElementById('file-meta').style.display = 'block';
      document.getElementById('header-upload-wrapper').style.display = 'block';
      document.getElementById('btn-sync-sheet').style.display = 'inline-flex';
      
      showToast(`Successfully processed file with ${rawDataRows.length} outlets!`, "success");
      
    } catch (err) {
      console.error("Error reading file", err);
      showToast(`Error processing file: ${err.message}`, "error");
    }
  };
  reader.readAsArrayBuffer(file);
}

function handleMappingsImportFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    try {
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      parseMappingsFromSheet(firstSheet);
      showToast("Mappings imported successfully!", "success");
      renderMappingsTable();
      if (calculatedROs.length > 0) {
        recalculateAndRefresh();
      }
    } catch (err) {
      showToast(`Error importing mappings: ${err.message}`, "error");
    }
  };
  reader.readAsArrayBuffer(file);
}

// Parses the mappings sheet
function parseMappingsFromSheet(sheet) {
  const parsed = Array.isArray(sheet) ? sheet : XLSX.utils.sheet_to_json(sheet, { header: 1 });
  if (parsed.length < 2) return;
  
  // Find header row (must contain ROID)
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(10, parsed.length); i++) {
    if (parsed[i].some(cell => String(cell).toLowerCase().includes('roid'))) {
      headerRowIdx = i;
      break;
    }
  }
  
  if (headerRowIdx === -1) headerRowIdx = 0;
  
  const headers = parsed[headerRowIdx].map(h => String(h).trim().toLowerCase());
  
  const roidCol = headers.findIndex(h => h.includes('roid'));
  const nameCol = headers.findIndex(h => h.includes('ro name') || h.includes('outlet') || h.includes('retail'));
  const eoCol = headers.findIndex(h => h.includes('te name') || h.includes('te') || h.includes('eo name') || h.includes('eo') || h.includes('territory engineer') || h.includes('executive officer'));
  const soCol = headers.findIndex(h => h.includes('so name') || h.includes('so'));
  const mstCol = headers.findIndex(h => h.includes('mst name') || h.includes('mst'));
  const groupCol = headers.findIndex(h => h.includes('sales group') || h.includes('group'));
  
  if (roidCol === -1 || eoCol === -1 || soCol === -1) {
    showToast("Mapping sheet must contain ROID, TE/EO Name, and SO Name columns", "error");
    return;
  }
  
  let importCount = 0;
  for (let r = headerRowIdx + 1; r < parsed.length; r++) {
    const row = parsed[r];
    if (!row || row.length <= Math.max(roidCol, eoCol, soCol)) continue;
    
    const roidRaw = row[roidCol];
    if (roidRaw === null || roidRaw === undefined || roidRaw === "") continue;
    
    const roid = String(parseInt(roidRaw));
    if (isNaN(roid)) continue;
    
    customMappings[roid] = {
      'outlet_name': nameCol !== -1 && row[nameCol] ? String(row[nameCol]).trim() : `RO ${roid}`,
      'eo_name': row[eoCol] ? String(row[eoCol]).trim() : "Unmapped",
      'sales_group': groupCol !== -1 && row[groupCol] ? String(row[groupCol]).trim() : "",
      'so_name': row[soCol] ? String(row[soCol]).trim() : "Unmapped",
      'mst_name': mstCol !== -1 && row[mstCol] ? String(row[mstCol]).trim() : ""
    };
    importCount++;
  }
  
  localStorage.setItem('bpcl_custom_mappings', JSON.stringify(customMappings));
  refreshActiveMappings();
}

// Parses raw automation or EVCS data rows
function parseRawData(rows) {
  let headerRowIdx = -1;
  let isEvcs = false;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (rows[i].some(cell => {
      const s = String(cell).toLowerCase();
      if (s.includes('ocpp id') || s.includes('ocpp_id') || s.includes('station name') || s.includes('territory eo')) {
        isEvcs = true;
        return true;
      }
      if (s.includes('roid') || s === 'ro id' || s === 'ro_id') {
        return true;
      }
      return false;
    })) {
      headerRowIdx = i;
      break;
    }
  }
  
  if (headerRowIdx === -1) {
    headerRowIdx = 2; // Default Row 3 in Excel
  }
  
  const headerRow = rows[headerRowIdx];
  const headers = Array.from(headerRow).map(h => h ? String(h).trim().toLowerCase() : "");
  
  // Double-check isEvcs with header fields
  if (!isEvcs) {
    isEvcs = headers.some(h => h && (h.includes('ocpp id') || h.includes('ocpp_id') || h.includes('station name') || h.includes('territory eo')));
  }
  
  if (isEvcs) {
    window.dashboardMode = 'evcs';
    parseEvcsData(rows, headerRowIdx, headers);
  } else {
    window.dashboardMode = 'automation';
    parseAutomationData(rows, headerRowIdx, headers);
  }
}

function parseAutomationData(rows, headerRowIdx, headers) {
  const roidCol = headers.findIndex(h => h === 'roid' || h === 'ro id' || h === 'ro_id');
  const nameCol = headers.findIndex(h => h.includes('retail') || h.includes('ro name') || h.includes('outlet name') || h === 'outlet');
  const vendorCol = headers.findIndex(h => h.includes('vendor') || h.includes('ra vendo') || h.includes('ra vendor'));
  const areaCol = headers.findIndex(h => h.includes('sales area') || h.includes('salesarea') || h.includes('sales_area'));
  const territoryCol = headers.findIndex(h => h === 'territory' || h === 'territory name' || h === 'territory_name');
  const stateOfficeCol = headers.findIndex(h => h === 'state office' || h === 'stateoffice' || h === 'state_office');
  const regionCol = headers.findIndex(h => h === 'region' || h === 'zone');
  
  let onbMpdCol = headers.findIndex(h => h.includes('on-boarded mpd') || h.includes('onbmpd') || h.includes('onb_mpd') || h === 'onbd mpd');
  let onlMpdCol = headers.findIndex(h => h.includes('online mpd') || h.includes('onlmpd') || h.includes('onl_mpd'));
  
  let onbTnkCol = headers.findIndex(h => h.includes('on-boarded tank') || h.includes('onbtnk') || h.includes('onb_tnk') || h === 'onbd tank');
  let onlTnkCol = headers.findIndex(h => h.includes('online tank') || h.includes('onltnk') || h.includes('onl_tnk'));
  
  // Fallbacks for duplicate/abbreviated headers like "No. of On" & "No. of Onl"
  if (onbMpdCol === -1) onbMpdCol = headers.indexOf('no. of on');
  if (onlMpdCol === -1) onlMpdCol = headers.indexOf('no. of onl');
  
  if (onbTnkCol === -1) {
    onbTnkCol = headers.lastIndexOf('no. of on');
    if (onbTnkCol === onbMpdCol) onbTnkCol = -1;
  }
  if (onlTnkCol === -1) {
    onlTnkCol = headers.lastIndexOf('no. of onl');
    if (onlTnkCol === onlMpdCol) onlTnkCol = -1;
  }
  
  const autoRspCol = headers.findIndex(h => h.includes('auto rsp') || h.includes('autorsp') || h.includes('auto_rsp'));
  const mpdPctCol = headers.findIndex(h => h === 'mpd online%' || h === 'mpd online %' || (h.includes('mpd') && h.includes('online') && h.includes('%')));
  const tankPctCol = headers.findIndex(h => h === 'tank online%' || h === 'tank online %' || h === 'atg online%' || h === 'atg online %' || (h.includes('tank') && h.includes('online') && h.includes('%')) || (h.includes('atg') && h.includes('online') && h.includes('%')));
  const avgRoOnlineCol = headers.findIndex(h => h === 'avg ro online%' || h === 'avg ro online %' || (h.includes('avg') && h.includes('online') && h.includes('%')));
  const iotCol = headers.findIndex(h => h.includes('iot enabl') || h.includes('iot enabled') || h.includes('iot_enabled') || h === 'iot');
  let roOnlineCol = headers.findIndex(h => h === "ro's online" || h === "ro online status" || h === "ro's online status" || h === "ro online" || h === "ro status");
  if (roOnlineCol === -1) {
    roOnlineCol = headers.findIndex(h => h.includes("online") && (h.includes("ro") || h.includes("ro's")) && !h.includes("%") && !h.includes("avg") && !h.includes("mpd") && !h.includes("tank"));
  }
  if (roOnlineCol === -1 && headers.length > 21) {
    roOnlineCol = 21; // Column V is standard index 21
  }
  
  if (roidCol === -1) {
    throw new Error("Could not find 'ROID' or 'RO ID' column in header row!");
  }
  
  rawDataRows.length = 0;
  
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length <= roidCol) continue;
    
    const roidRaw = row[roidCol];
    if (roidRaw === null || roidRaw === undefined || roidRaw === "") continue;
    
    const roidVal = parseInt(roidRaw);
    if (isNaN(roidVal)) continue;
    
    const iotVal = iotCol !== -1 && row[iotCol] ? String(row[iotCol]).trim() : (roidVal % 3 !== 0 ? "Yes" : "No");

    let roOnlineVal = "";
    if (roOnlineCol !== -1 && row[roOnlineCol] !== undefined && row[roOnlineCol] !== null) {
      const candidate = String(row[roOnlineCol]).trim();
      if (candidate.toLowerCase().includes('on') || candidate.toLowerCase().includes('part') || candidate.toLowerCase().includes('off')) {
        roOnlineVal = candidate;
      }
    }
    if (!roOnlineVal && row.length > 21 && row[21] !== undefined && row[21] !== null) {
      const candidate21 = String(row[21]).trim();
      if (candidate21.toLowerCase().includes('on') || candidate21.toLowerCase().includes('part') || candidate21.toLowerCase().includes('off')) {
        roOnlineVal = candidate21;
      }
    }
    
    if (!roOnlineVal && row.length > 23 && row[23] !== undefined && row[23] !== null) {
      const candidate23 = String(row[23]).trim();
      if (candidate23.toLowerCase().includes('on') || candidate23.toLowerCase().includes('part') || candidate23.toLowerCase().includes('off')) {
        roOnlineVal = candidate23;
      }
    }

    const parsePctVal = col => {
      if (col === -1 || row[col] === undefined || row[col] === null || String(row[col]).trim() === '') return null;
      let s = String(row[col]).trim().replace(/,/g, '').replace('%', '');
      let n = parseFloat(s);
      if (isNaN(n)) return null;
      return String(row[col]).includes('%') || n > 1 ? n / 100 : n;
    };

    rawDataRows.push({
      roid: String(roidVal),
      outlet_name: nameCol !== -1 && row[nameCol] ? String(row[nameCol]).trim() : "",
      vendor: vendorCol !== -1 && row[vendorCol] ? String(row[vendorCol]).trim() : "",
      sales_area: areaCol !== -1 && row[areaCol] ? String(row[areaCol]).trim() : "Unmapped",
      territory: territoryCol !== -1 && row[territoryCol] ? String(row[territoryCol]).trim() : "",
      state_office: stateOfficeCol !== -1 && row[stateOfficeCol] ? String(row[stateOfficeCol]).trim() : "",
      region: regionCol !== -1 && row[regionCol] ? String(row[regionCol]).trim() : "",
      onb_mpd: onbMpdCol !== -1 && row[onbMpdCol] !== undefined ? parseFloat(row[onbMpdCol]) : 0,
      onl_mpd: onlMpdCol !== -1 && row[onlMpdCol] !== undefined ? parseFloat(row[onlMpdCol]) : 0,
      onb_tnk: onbTnkCol !== -1 && row[onbTnkCol] !== undefined ? parseFloat(row[onbTnkCol]) : 0,
      onl_tnk: onlTnkCol !== -1 && row[onlTnkCol] !== undefined ? parseFloat(row[onlTnkCol]) : 0,
      auto_rsp: autoRspCol !== -1 && row[autoRspCol] ? String(row[autoRspCol]).trim() : "No",
      iot_enabled: iotVal,
      ro_online_status: roOnlineVal,
      mpd_online_pct: parsePctVal(mpdPctCol),
      tank_online_pct: parsePctVal(tankPctCol),
      avg_ro_online_pct: parsePctVal(avgRoOnlineCol)
    });
  }
}

function parseEvcsData(rows, headerRowIdx, headers) {
  const stationCol = headers.findIndex(h => h.includes('station name') || h.includes('station_name') || h === 'station');
  const blCol = headers.findIndex(h => h.includes('bl code') || h.includes('bl_code') || h.includes('roid') || h === 'ro id');
  const ocppCol = headers.findIndex(h => h.includes('ocpp id') || h.includes('ocpp_id') || h === 'ocpp');
  const eoCol = headers.findIndex(h => h.includes('territory te') || h.includes('territory_te') || h.includes('territory eo') || h.includes('territory_eo') || h.includes('te') || h.includes('eo') || h.includes('executive officer') || h.includes('territory engineer'));
  const powerCol = headers.findIndex(h => h.includes('power rating') || h.includes('power_rating') || h.includes('power'));
  const cityCol = headers.findIndex(h => h === 'city');
  const stateCol = headers.findIndex(h => h === 'state');
  const typeCol = headers.findIndex(h => h === 'type' || h === 'charger');
  const statusCol = headers.lastIndexOf('charger status') !== -1 ? headers.lastIndexOf('charger status') : headers.findIndex(h => h === 'status' || h === 'charger status.1' || h === 'status.1');
  const soCol = headers.findIndex(h => h === 'so' || h.includes('sales officer') || h === 'sales_officer');
  
  rawDataRows.length = 0;
  
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    
    const stationVal = stationCol !== -1 && row[stationCol] ? String(row[stationCol]).trim() : "";
    if (!stationVal) continue; // skip empty rows
    
    rawDataRows.push({
      s_no: r - headerRowIdx,
      station_name: stationVal,
      bl_code: blCol !== -1 && row[blCol] ? String(row[blCol]).trim() : "",
      ocpp_id: ocppCol !== -1 && row[ocppCol] ? String(row[ocppCol]).trim() : "",
      territory_eo: eoCol !== -1 && row[eoCol] ? String(row[eoCol]).trim() : "Unmapped",
      power_rating: powerCol !== -1 && row[powerCol] ? String(row[powerCol]).trim() : "",
      city: cityCol !== -1 && row[cityCol] ? String(row[cityCol]).trim() : "",
      state: stateCol !== -1 && row[stateCol] ? String(row[stateCol]).trim() : "",
      type: typeCol !== -1 && row[typeCol] ? String(row[typeCol]).trim() : "Non FAME",
      status: statusCol !== -1 && row[statusCol] ? String(row[statusCol]).trim() : "Offline",
      so: soCol !== -1 && row[soCol] ? String(row[soCol]).trim() : ""
    });
  }
}

// Running calculation engine
function processCalculations(rows) {
  calculatedROs.length = 0;
  
  const NANO_STATUS_MAP = {
    "Fully online, Fully online": "Fully Online",
    "Offline, Fully online": "No MPD Communicated",
    "Partially MPD, Fully online": "Partially Communicated MPD",
    "Fully online, Partially ATG": "Partially Communicated ATG",
    "Fully online, Offline": "No ATG Communicated",
    "Partially MPD, Offline": "Partially Online",
    "Offline, Offline": "Offline",
    "Partially MPD, Partially ATG": "Partially Online",
    "Offline, Partially ATG": "Partially Online"
  };

  rows.forEach(row => {
    const mapInfo = activeMappings[row.roid] || {};
    
    const outlet_name = row.outlet_name || mapInfo.outlet_name || `RO ${row.roid}`;
    const eo_name = mapInfo.eo_name || "Unmapped";
    const so_name = mapInfo.so_name || "Unmapped";
    const mst_name = mapInfo.mst_name || "Unmapped";
    
    // Totals
    const tot_onb = row.onb_mpd + row.onb_tnk;
    const tot_onl = row.onl_mpd + row.onl_tnk;
    
    // Uptime
    const uptime = tot_onb > 0 ? tot_onl / tot_onb : 0;
    
    // Status (replicates Excel formulas)
    let status = "Offline";
    if (tot_onb > 0 && tot_onl > 0) {
      if (tot_onl >= tot_onb) {
        status = "Fully Online";
      } else {
        status = "Partially Online";
      }
    }
    
    // Conditions
    let mpd_cond = "Offline";
    if (row.onl_mpd > 0) {
      mpd_cond = row.onl_mpd >= row.onb_mpd ? "Fully online" : "Partially MPD";
    }
    
    let tnk_cond = "Offline";
    if (row.onl_tnk > 0) {
      tnk_cond = row.onl_tnk >= row.onb_tnk ? "Fully online" : "Partially ATG";
    }
    
    const condition = `${mpd_cond}, ${tnk_cond}`;
    
    // NANO Status
    let nano_status = NANO_STATUS_MAP[condition] || "Partially Online";
    
    // Offlines
    const off_mpd = Math.max(0, row.onb_mpd - row.onl_mpd);
    const off_tnk = Math.max(0, row.onb_tnk - row.onl_tnk);
    
    const iot_status = (row.iot_enabled && (row.iot_enabled.toLowerCase() === 'yes' || row.iot_enabled === 'Yes')) ? 'IOT' : 'WFCC';
    
    // Determine New Logic Status
    let new_logic_status = "Offline";
    const rawNl = String(row.ro_online_status || '').trim();
    if (rawNl) {
      const lowerNl = rawNl.toLowerCase();
      if (lowerNl === 'fully online' || lowerNl === 'online') {
        new_logic_status = 'Fully Online';
      } else if (lowerNl === 'partially online' || lowerNl === 'partial' || lowerNl.includes('part')) {
        new_logic_status = 'Partially Online';
      } else if (lowerNl === 'offline' || lowerNl.includes('off')) {
        new_logic_status = 'Offline';
      } else {
        new_logic_status = rawNl;
      }
    } else {
      const mo = Number(row.onb_mpd), mp = Number(row.onl_mpd);
      const ao = Number(row.onb_tnk), ap = Number(row.onl_tnk);
      if ([mo, mp, ao, ap].some(v => !isNaN(v) && v > 0)) {
        if ((isNaN(mp) || mp === 0) && (isNaN(ap) || ap === 0)) {
          new_logic_status = 'Offline';
        } else if ((!isNaN(mo) && !isNaN(mp) && mp < mo) || (!isNaN(ao) && !isNaN(ap) && ap < ao)) {
          new_logic_status = 'Partially Online';
        } else {
          new_logic_status = 'Fully Online';
        }
      } else {
        new_logic_status = status;
      }
    }

    calculatedROs.push({
      roid: row.roid,
      outlet_name: outlet_name,
      sales_area: row.sales_area,
      territory: row.territory || (activeMappings[row.roid] && activeMappings[row.roid].territory) || '',
      state_office: row.state_office || '',
      region: row.region || '',
      eo_name: eo_name,
      so_name: so_name,
      mst_name: mst_name,
      vendor: row.vendor || "Unmapped",
      auto_rsp: row.auto_rsp,
      iot_status: iot_status,
      onb_mpd: row.onb_mpd,
      onl_mpd: row.onl_mpd,
      onb_tnk: row.onb_tnk,
      onl_tnk: row.onl_tnk,
      tot_onb: tot_onb,
      tot_onl: tot_onl,
      uptime: uptime,
      status: status,
      ro_online_status: row.ro_online_status || status,
      new_logic_status: new_logic_status,
      condition: condition,
      nano_status: nano_status,
      off_mpd: off_mpd,
      off_tnk: off_tnk,
      mpd_online_pct: row.mpd_online_pct !== undefined ? row.mpd_online_pct : null,
      tank_online_pct: row.tank_online_pct !== undefined ? row.tank_online_pct : null,
      avg_ro_online_pct: row.avg_ro_online_pct !== undefined ? row.avg_ro_online_pct : null
    });
  });
  
  // Present outlets grouped by sales area (then RO code) on every menu
  calculatedROs.sort(compareBySalesArea);

  // Filter based on logged in user scope
  if (window.currentUser) {
    const { role, username } = window.currentUser;
    let filtered = [];
    if (role === 'so') {
      filtered = calculatedROs.filter(ro => ro.so_name === username);
    } else if (role === 'eo') {
      filtered = calculatedROs.filter(ro => ro.eo_name === username);
    } else if (role === 'vendor') {
      filtered = calculatedROs.filter(ro => ro.vendor === username);
    } else {
      filtered = [...calculatedROs];
    }
    calculatedROs.length = 0;
    filtered.forEach(item => calculatedROs.push(item));
  }
  
  // RO code → territory / sales area from the uptime sheet (before the territory
  // scope is applied) — other menus such as Tank Stock use it so every menu
  // groups outlets the same way.
  {
    const look = new Map();
    calculatedROs.forEach(ro => { if (ro.roid != null) look.set(String(ro.roid).replace(/\D/g, '').replace(/^0+/, ''), { territory: ro.territory || '', area: ro.sales_area || '' }); });
    window.__roLookup = look;
    if (window.TankStock && window.TankStock.refreshLookup) window.TankStock.refreshLookup();
  }

  // Unscoped copy (role scope applied) for Territory Performance ranking
  window.__unscopedROs = calculatedROs.slice();

  // Global Territory filter (chosen on any menu, applies to every menu)
  if (window.GlobalScope) {
    GlobalScope.registerTerritories(calculatedROs.map(ro => ro.territory));
    if (GlobalScope.active()) {
      const inScope = calculatedROs.filter(ro => GlobalScope.match(ro.territory));
      calculatedROs.length = 0;
      inScope.forEach(item => calculatedROs.push(item));
    }
  }

  // Reset dashboard filters on new file upload (kept when only the territory changed)
  if (!window.__keepDashFilters) {
    dashboardFilters = {
      salesArea: null,
      eoName: null,
      vendor: null,
      status: null,
      technology: null
    };
  }

  dashboardFilteredROs = calculatedROs;
  if (window.__keepDashFilters && typeof applyDashboardFilters === 'function' &&
      ['salesArea', 'eoName', 'vendor', 'status', 'technology'].some(k => dfArr(k).length)) {
    setTimeout(applyDashboardFilters, 0);
  }

  // Recalculate summaries
  aggregateSummaries();
  
  // Render mockup interactive filter panels
  renderFilterButtons();
}

function aggregateSummaries(rosList) {
  const listToUse = rosList || calculatedROs;
  
  // Reset maps
  const salesMap = {};
  const eoMap = {};
  const soMap = {};
  const vendorMap = {};
  
  // Overall Metrics counters
  let totalROs = listToUse.length;
  let fullyOnline = 0;
  let partiallyOnline = 0;
  let offline = 0;
  let autoRspCount = 0;
  let sumOnbMpd = 0;
  let sumOnlMpd = 0;
  let sumOnbTnk = 0;
  let sumOnlTnk = 0;
  
  listToUse.forEach(ro => {
    // Status counts
    if (ro.status === "Fully Online") fullyOnline++;
    else if (ro.status === "Partially Online") partiallyOnline++;
    else if (ro.status === "Offline") offline++;
    
    if (ro.auto_rsp.toLowerCase() === "yes" || ro.auto_rsp === "Yes") autoRspCount++;
    
    sumOnbMpd += ro.onb_mpd;
    sumOnlMpd += ro.onl_mpd;
    sumOnbTnk += ro.onb_tnk;
    sumOnlTnk += ro.onl_tnk;
    
    // 1. Sales Area aggregation
    if (!salesMap[ro.sales_area]) salesMap[ro.sales_area] = createAggregateObj(ro.sales_area);
    updateAggregateObj(salesMap[ro.sales_area], ro);
    
    // 2. EO aggregation
    if (!eoMap[ro.eo_name]) eoMap[ro.eo_name] = createAggregateObj(ro.eo_name);
    updateAggregateObj(eoMap[ro.eo_name], ro);
    
    // 3. SO aggregation
    if (!soMap[ro.so_name]) soMap[ro.so_name] = createAggregateObj(ro.so_name);
    updateAggregateObj(soMap[ro.so_name], ro);

    // 4. Vendor aggregation
    if (!vendorMap[ro.vendor]) vendorMap[ro.vendor] = createAggregateObj(ro.vendor);
    updateAggregateObj(vendorMap[ro.vendor], ro);
  });
  
  // Calculate ratios for overall
  overallMetrics = {
    totalROs,
    fullyOnline,
    partiallyOnline,
    offline,
    autoRspCount,
    sumOnbMpd,
    sumOnlMpd,
    sumOnbTnk,
    sumOnlTnk,
    uptime: (sumOnbMpd + sumOnbTnk) > 0 ? (sumOnlMpd + sumOnlTnk) / (sumOnbMpd + sumOnbTnk) : 0,
    mpdUptime: sumOnbMpd > 0 ? sumOnlMpd / sumOnbMpd : 0,
    tankUptime: sumOnbTnk > 0 ? sumOnlTnk / sumOnbTnk : 0,
    autoRspPct: totalROs > 0 ? autoRspCount / totalROs : 0
  };
  
  // Finalize summaries
  salesAreaSummary = Object.values(salesMap).map(finalizeAggregate);
  eoSummary = Object.values(eoMap).map(finalizeAggregate);
  soSummary = Object.values(soMap).map(finalizeAggregate);
  vendorSummary = Object.values(vendorMap).map(finalizeAggregate);
  
  // Sort alphabetically by name initially
  salesAreaSummary.sort((a, b) => a.key.localeCompare(b.key));
  eoSummary.sort((a, b) => a.key.localeCompare(b.key));
  soSummary.sort((a, b) => a.key.localeCompare(b.key));
  vendorSummary.sort((a, b) => a.key.localeCompare(b.key));
}

function createAggregateObj(key) {
  return {
    key: key,
    totalROs: 0,
    fullyOnline: 0,
    partiallyOnline: 0,
    offline: 0,
    onb_mpd: 0,
    onl_mpd: 0,
    onb_tnk: 0,
    onl_tnk: 0
  };
}

function updateAggregateObj(obj, ro) {
  obj.totalROs++;
  if (ro.status === "Fully Online") obj.fullyOnline++;
  else if (ro.status === "Partially Online") obj.partiallyOnline++;
  else if (ro.status === "Offline") obj.offline++;
  
  obj.onb_mpd += ro.onb_mpd;
  obj.onl_mpd += ro.onl_mpd;
  obj.onb_tnk += ro.onb_tnk;
  obj.onl_tnk += ro.onl_tnk;
}

function finalizeAggregate(obj) {
  obj.mpdUptime = obj.onb_mpd > 0 ? obj.onl_mpd / obj.onb_mpd : 0;
  obj.tankUptime = obj.onb_tnk > 0 ? obj.onl_tnk / obj.onb_tnk : 0;
  obj.uptime = (obj.onb_mpd + obj.onb_tnk) > 0 ? (obj.onl_mpd + obj.onl_tnk) / (obj.onb_mpd + obj.onb_tnk) : 0;
  obj.off_mpd = Math.max(0, obj.onb_mpd - obj.onl_mpd);
  obj.off_tnk = Math.max(0, obj.onb_tnk - obj.onl_tnk);
  return obj;
}

// Render Dashboard KPI Metric Cards
function updateDashboardKPIs() {
  const total = overallMetrics.totalROs || 0;
  const fully = overallMetrics.fullyOnline || 0;
  const partial = overallMetrics.partiallyOnline || 0;
  const offline = overallMetrics.offline || 0;

  document.getElementById('kpi-total-ros').textContent = total;
  document.getElementById('kpi-fully-online').textContent = fully;
  document.getElementById('kpi-partially-online').textContent = partial;
  document.getElementById('kpi-offline').textContent = offline;
  document.getElementById('kpi-mpd-uptime').textContent = (overallMetrics.mpdUptime * 100).toFixed(2) + "%";
  document.getElementById('kpi-tank-uptime').textContent = (overallMetrics.tankUptime * 100).toFixed(2) + "%";
  
  const uptimePct = (overallMetrics.uptime * 100).toFixed(2) + "%";
  document.getElementById('kpi-territory-uptime').textContent = uptimePct;
  
  // Set Auto RSP value
  const autoRspVal = document.getElementById('kpi-auto-rsp');
  if (autoRspVal) {
    autoRspVal.textContent = (overallMetrics.autoRspPct * 100).toFixed(2) + "%";
  }
  
  // Update header subtitle
  const subEl = document.getElementById('app-subtitle');
  if (subEl) {
    subEl.textContent = "Automation | IFMS | Uptime Monitoring";
  }
  
  // Update header badge with outlets count
  const countEl = document.getElementById('header-outlets-count');
  if (countEl) countEl.textContent = `${total} Outlets`;
  const badgeEl = document.getElementById('header-outlets-badge');
  if (badgeEl && !countEl) badgeEl.textContent = `${total} Outlets`;

  const metaRows = document.getElementById('file-meta-rows');
  if (metaRows) metaRows.textContent = `(${total} rows)`;

  // Update status summary numbers and percentages (both Donut legend and Right Status card)
  const calcTotal = total > 0 ? total : (fully + partial + offline);
  const onlPct = calcTotal > 0 ? ((fully / calcTotal) * 100).toFixed(2) : "0.00";
  const partPct = calcTotal > 0 ? ((partial / calcTotal) * 100).toFixed(2) : "0.00";
  const offPct = calcTotal > 0 ? ((offline / calcTotal) * 100).toFixed(2) : "0.00";

  const onlText = `${fully} (${onlPct}%)`;
  const partText = `${partial} (${partPct}%)`;
  const offText = `${offline} (${offPct}%)`;

  const dOnl = document.getElementById('donut-val-online'); if (dOnl) dOnl.textContent = onlText;
  const dPart = document.getElementById('donut-val-partial'); if (dPart) dPart.textContent = partText;
  const dOff = document.getElementById('donut-val-offline'); if (dOff) dOff.textContent = offText;

  const sOnl = document.getElementById('status-cnt-online'); if (sOnl) sOnl.textContent = onlText;
  const sPart = document.getElementById('status-cnt-partial'); if (sPart) sPart.textContent = partText;
  const sOff = document.getElementById('status-cnt-offline'); if (sOff) sOff.textContent = offText;
  [['online', onlPct], ['partial', partPct], ['offline', offPct]].forEach(([k, v]) => { const b = document.getElementById('status-bar-' + k); if (b) b.style.width = Math.max(0, Math.min(100, parseFloat(v) || 0)) + '%'; });
}

// Global dashboard filters
// Dashboard pill filters hold arrays (multi-select); null / [] = no filter
function dfArr(key) { const v = dashboardFilters[key]; return Array.isArray(v) ? v : (v ? [v] : []); }
function dfHas(key, value) { return dfArr(key).includes(value); }
let dashboardFilters = {
  salesArea: null,
  eoName: null,
  vendor: null,
  status: null,
  technology: null
};

// Render mockup interactive filter panels
// Dashboard filter bar: one multi-select dropdown per dimension
const DASH_FILTERS = [
  { id: 'dash-f-area', key: 'salesArea', all: 'All Sales Areas', values: () => [...new Set(calculatedROs.map(ro => ro.sales_area))].filter(Boolean).sort(), label: v => v.replace(' Retail', '').replace('-retail', '') },
  { id: 'dash-f-te', key: 'eoName', all: 'All TEs', values: () => [...new Set(calculatedROs.map(ro => ro.eo_name))].filter(Boolean).sort(), label: v => v },
  { id: 'dash-f-vendor', key: 'vendor', all: 'All Vendors', values: () => [...new Set(calculatedROs.map(ro => ro.vendor))].filter(Boolean).sort(), label: v => v },
  { id: 'dash-f-status', key: 'status', all: 'All Statuses', values: () => ['Fully Online', 'Partially Online', 'Offline'], label: v => v },
  { id: 'dash-f-tech', key: 'technology', all: 'All Technologies', values: () => ['IOT', 'WFCC'], label: v => v }
];
let dashFiltersBound = false;

function renderFilterButtons() {
  const escOpt = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  DASH_FILTERS.forEach(cfg => {
    const sel = document.getElementById(cfg.id);
    if (!sel) return;
    const vals = cfg.values();
    sel.innerHTML = `<option value="">${cfg.all}</option>` + vals.map(v => `<option value="${escOpt(v)}">${escOpt(cfg.label(v))}</option>`).join('');
    const keep = dfArr(cfg.key).filter(v => vals.includes(v));
    if (window.MS) MS.set(sel, keep); else sel.value = keep[0] || '';
  });

  if (!dashFiltersBound) {
    dashFiltersBound = true;
    DASH_FILTERS.forEach(cfg => {
      const sel = document.getElementById(cfg.id);
      if (!sel) return;
      sel.addEventListener('change', () => {
        const vals = window.MS ? MS.vals(sel) : (sel.value ? [sel.value] : []);
        dashboardFilters[cfg.key] = vals.length ? vals : null;
        applyDashboardFilters();
      });
    });
  }

  // Active-filter count + clear button
  const active = DASH_FILTERS.reduce((n, cfg) => n + dfArr(cfg.key).length, 0) + (window.GlobalScope ? GlobalScope.get().length : 0);
  const resetBtn = document.getElementById('filter-reset-global-btn');
  if (resetBtn) resetBtn.style.display = active ? 'inline-flex' : 'none';
  const cnt = document.getElementById('dash-filter-count');
  if (cnt) { cnt.hidden = !active; cnt.textContent = active ? active + ' active' : ''; }
}

function toggleDashboardFilter(filterKey, value) {
  // Multi-select: tap a pill to add it, tap again to remove it
  const cur = dfArr(filterKey);
  const next = cur.includes(value) ? cur.filter(v => v !== value) : cur.concat(value);
  dashboardFilters[filterKey] = next.length ? next : null;

  applyDashboardFilters();
}

function resetGlobalDashboardFilters() {
  dashboardFilters = {
    salesArea: null,
    eoName: null,
    vendor: null,
    status: null,
    technology: null
  };
  // "Clear filters" also clears the territory (which refreshes every menu)
  if (window.GlobalScope && GlobalScope.active()) { GlobalScope.set([]); return; }
  applyDashboardFilters();
}

function applyDashboardFilters() {
  let filtered = calculatedROs;
  if (dfArr('salesArea').length) {
    filtered = filtered.filter(ro => dfArr('salesArea').includes(ro.sales_area));
  }
  if (dfArr('eoName').length) {
    filtered = filtered.filter(ro => dfArr('eoName').includes(ro.eo_name));
  }
  if (dfArr('vendor').length) {
    filtered = filtered.filter(ro => dfArr('vendor').includes(ro.vendor));
  }
  if (dfArr('status').length) {
    filtered = filtered.filter(ro => dfArr('status').includes(ro.status));
  }
  if (dfArr('technology').length) {
    filtered = filtered.filter(ro => dfArr('technology').includes(ro.iot_status));
  }

  // Update summaries with filtered list
  dashboardFilteredROs = filtered;
  aggregateSummaries(filtered);

  // Re-render dashboard
  updateDashboardKPIs();
  updateOverviewCharts();
  renderFilterButtons();
}

// Global chart instances
let statusDoughnutChartInstance = null;
let eoHorizontalChartInstance = null;
let soHorizontalChartInstance = null;
let equipmentCompChartInstance = null;

// Render Overview Charts
function updateOverviewCharts() {
  const textColor = '#5b6b84';
  const gridColor = '#eef1f6';

  // Custom inline plugin: draws % labels on bar charts
  // % labels in the style of the reference photos:
  //  • upright bars  → white value written vertically inside the top of the bar
  //  • sideways bars → white value inside the right end of the bar
  // (falls back to a dark label outside only when a bar is too short to hold the text)
  const barDataLabels = {
    id: 'barDataLabels',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const horizontal = chart.options.indexAxis === 'y';
      const fmt = v => { const n = parseFloat(v); return (n >= 99.95 ? '100' : n.toFixed(1)) + '%'; };

      chart.data.datasets.forEach((dataset, datasetIndex) => {
        if (dataset.type === 'line') return;
        const meta = chart.getDatasetMeta(datasetIndex);
        if (meta.hidden) return;

        meta.data.forEach((bar, index) => {
          const value = dataset.data[index];
          if (value === null || value === undefined || Number(value) === 0) return;
          const label = fmt(value);
          const bg = String(Array.isArray(dataset.backgroundColor) ? dataset.backgroundColor[index] : dataset.backgroundColor || '').toLowerCase();
          const inside = /^#(fcb813|f07a5a)$/.test(bg) ? '#1b365d' : '#ffffff';
          ctx.save();
          ctx.font = '700 11px Inter, system-ui, sans-serif';
          const textW = ctx.measureText(label).width;
          ctx.textBaseline = 'middle';

          if (horizontal) {
            const barLen = Math.abs(bar.x - bar.base);
            if (barLen >= textW + 14) {
              ctx.fillStyle = inside;
              ctx.textAlign = 'right';
              ctx.fillText(label, bar.x - 7, bar.y);
            } else {
              ctx.fillStyle = '#0f172a';
              ctx.textAlign = 'left';
              ctx.fillText(label, bar.x + 5, bar.y);
            }
          } else {
            const barH = Math.abs(bar.base - bar.y);
            ctx.translate(bar.x, bar.y);
            ctx.rotate(-Math.PI / 2);
            if (barH >= textW + 12) {
              ctx.fillStyle = inside;
              ctx.textAlign = 'right';
              ctx.fillText(label, -6, 0);
            } else {
              ctx.fillStyle = '#0f172a';
              ctx.textAlign = 'left';
              ctx.fillText(label, 4, 0);
            }
          }
          ctx.restore();
        });
      });
    }
  };

  // Center text plugin for doughnut chart
  const centerTextPlugin = {
    id: 'centerTextPlugin',
    beforeDraw(chart) {
      if (chart.config.type !== 'doughnut') return;
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const { top, bottom, left, right } = chartArea;
      ctx.save();
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;

      const total = overallMetrics.totalROs || 392;
      ctx.font = '800 24px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#0d1b2e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(total, centerX, centerY - 8);

      ctx.font = '700 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText('Outlets', centerX, centerY + 12);
      ctx.restore();
    }
  };

  // 1. Doughnut Chart: RO Status Breakdown
  const doughnutEl = document.getElementById('status-doughnut-chart');
  if (doughnutEl) {
    const doughnutCtx = doughnutEl.getContext('2d');
    if (statusDoughnutChartInstance) {
      statusDoughnutChartInstance.destroy();
    }
    
    statusDoughnutChartInstance = new Chart(doughnutCtx, {
      type: 'doughnut',
      plugins: [centerTextPlugin],
      data: {
        labels: ['Online', 'Partial', 'Offline'],
        datasets: [{
          data: [overallMetrics.fullyOnline, overallMetrics.partiallyOnline, overallMetrics.offline],
          backgroundColor: ['#138a4a', '#fcb813', '#c8322b'],   // online (green) · partial (yellow) · offline (red)
          borderWidth: 2,
          borderColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        cutout: '72%', spacing: 2, borderRadius: 4
      }
    });

    // Update status breakdown labels in legend and right status card
    const total = overallMetrics.totalROs || (overallMetrics.fullyOnline + overallMetrics.partiallyOnline + overallMetrics.offline);
    const onlPct = total > 0 ? ((overallMetrics.fullyOnline / total) * 100).toFixed(2) : "0.00";
    const partPct = total > 0 ? ((overallMetrics.partiallyOnline / total) * 100).toFixed(2) : "0.00";
    const offPct = total > 0 ? ((overallMetrics.offline / total) * 100).toFixed(2) : "0.00";

    const onlText = `${overallMetrics.fullyOnline} (${onlPct}%)`;
    const partText = `${overallMetrics.partiallyOnline} (${partPct}%)`;
    const offText = `${overallMetrics.offline} (${offPct}%)`;

    const dOnl = document.getElementById('donut-val-online'); if (dOnl) dOnl.textContent = onlText;
    const dPart = document.getElementById('donut-val-partial'); if (dPart) dPart.textContent = partText;
    const dOff = document.getElementById('donut-val-offline'); if (dOff) dOff.textContent = offText;

    const sOnl = document.getElementById('status-cnt-online'); if (sOnl) sOnl.textContent = onlText;
    const sPart = document.getElementById('status-cnt-partial'); if (sPart) sPart.textContent = partText;
    const sOff = document.getElementById('status-cnt-offline'); if (sOff) sOff.textContent = offText;
    [['online', onlPct], ['partial', partPct], ['offline', offPct]].forEach(([k, v]) => { const b = document.getElementById('status-bar-' + k); if (b) b.style.width = Math.max(0, Math.min(100, parseFloat(v) || 0)) + '%'; });
  }
  
  // 2. Horizontal Bar Chart: Sales Area Performance
  const barEl = document.getElementById('sales-area-bar-chart');
  if (barEl) {
    const barCtx = barEl.getContext('2d');
    if (salesAreaBarChartInstance) {
      salesAreaBarChartInstance.destroy();
    }
    
    const salesAreaLabels = salesAreaSummary.map(s => s.key.replace(' Retail', '').replace('-retail', ''));
    const salesAreaUptimeVals = salesAreaSummary.map(s => (s.uptime * 100).toFixed(1));
    
    salesAreaBarChartInstance = new Chart(barCtx, {
      type: 'bar',
      plugins: [barDataLabels],
      data: {
        labels: salesAreaLabels,
        datasets: [
          {
            label: 'Uptime %',
            data: salesAreaUptimeVals,
            backgroundColor: '#1b365d',   // deep navy
            borderRadius: 4,
            barThickness: 18
          }
        ]
      },
      options: {
        indexAxis: 'y', // Horizontal bars
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            min: 0,
            max: 100,
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: 'Inter', size: 11 },
              callback: value => value <= 100 ? value + '%' : ''
            }
          },
          y: {
            grid: { display: false },
            ticks: { color: textColor, font: { family: 'Inter', size: 11, weight: '600' } }
          }
        }
      }
    });
  }

  // 3. Equipment Performance Summary (MPD vs Tank Uptime)
  const equipEl = document.getElementById('equipment-comp-chart');
  if (equipEl) {
    const equipCtx = equipEl.getContext('2d');
    if (equipmentCompChartInstance) {
      equipmentCompChartInstance.destroy();
    }
    
    // Cap chart bars to top 15 to prevent mobile canvas memory crashes
    const chartSalesAreas = salesAreaSummary.slice(0, 15);
    const salesAreaLabels = chartSalesAreas.map(s => s.key.replace(' Retail', '').replace('-retail', ''));
    const mpdUptimeVals = chartSalesAreas.map(s => (s.mpdUptime * 100).toFixed(1));
    const tankUptimeVals = chartSalesAreas.map(s => (s.tankUptime * 100).toFixed(1));
    
    equipmentCompChartInstance = new Chart(equipCtx, {
      type: 'bar',
      plugins: [barDataLabels],
      data: {
        labels: salesAreaLabels,
        datasets: [
          {
            label: 'MPD Uptime',
            data: mpdUptimeVals,
            backgroundColor: '#1b365d',   // deep navy
            borderRadius: 6,
            maxBarThickness: 14,
            categoryPercentage: 0.92,
            barPercentage: 0.62
          },
          {
            label: 'Tank Uptime',
            data: tankUptimeVals,
            backgroundColor: '#f07a5a',   // coral
            borderRadius: 6,
            maxBarThickness: 14,
            categoryPercentage: 0.92,
            barPercentage: 0.62
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 6 } },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: textColor, font: { family: 'Inter', size: 11, weight: '600' }, boxWidth: 12 }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: textColor, font: { family: 'Inter', size: 11, weight: '600' } }
          },
          y: {
            min: 0,
            max: 110,
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: 'Inter', size: 11 },
              callback: value => value <= 100 ? value + '%' : ''
            }
          }
        }
      }
    });
  }

  // 4. Horizontal Chart: Territory Engineer (TE) Uptime Performance
  const eoEl = document.getElementById('eo-horizontal-chart');
  if (eoEl) {
    const eoCtx = eoEl.getContext('2d');
    if (eoHorizontalChartInstance) {
      eoHorizontalChartInstance.destroy();
    }
    
    const chartEos = eoSummary.slice(0, 15);
    const eoLabels = chartEos.map(e => e.key);
    const eoVals = chartEos.map(e => (e.uptime * 100).toFixed(1));
    
    eoHorizontalChartInstance = new Chart(eoCtx, {
      type: 'bar',
      plugins: [barDataLabels],
      data: {
        labels: eoLabels,
        datasets: [{
          label: 'Uptime %',
          data: eoVals,
          backgroundColor: '#1b365d',   // deep navy
          borderRadius: 4,
          barThickness: 18
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            min: 0,
            max: 100,
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: 'Inter', size: 11 },
              callback: value => value <= 100 ? value + '%' : ''
            }
          },
          y: {
            grid: { display: false },
            ticks: { color: textColor, font: { family: 'Inter', size: 11, weight: '600' } }
          }
        }
      }
    });
  }

  // 5. Horizontal Chart: SOs by Uptime (optional if present in DOM)
  const soEl = document.getElementById('so-horizontal-chart');
  if (soEl) {
    const soCtx = soEl.getContext('2d');
    if (soHorizontalChartInstance) {
      soHorizontalChartInstance.destroy();
    }
    
    const sortedSoSummary = [...soSummary].sort((a, b) => b.uptime - a.uptime).slice(0, 15);
    const soLabels = sortedSoSummary.map(s => s.key);
    const soVals = sortedSoSummary.map(s => (s.uptime * 100).toFixed(1));
    
    soHorizontalChartInstance = new Chart(soCtx, {
      type: 'bar',
      plugins: [barDataLabels],
      data: {
        labels: soLabels,
        datasets: [{
          label: 'Uptime %',
          data: soVals,
          backgroundColor: '#1b365d',   // deep navy
          borderRadius: 4,
          barThickness: 10
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            min: 0,
            max: 100,
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: 'Inter', size: 11 },
              callback: value => value <= 100 ? value + '%' : ''
            }
          },
          y: {
            grid: { display: false },
            ticks: { color: textColor, font: { family: 'Inter', size: 10, weight: '600' } }
          }
        }
      }
    });
  }
}

// Render Sales Area Table
function renderSalesAreaTable() {
  const tbody = document.getElementById('sales-area-tbody');
  tbody.innerHTML = '';
  
  let grandTotal = {
    totalROs: 0,
    fullyOnline: 0,
    partiallyOnline: 0,
    offline: 0,
    onb_mpd: 0,
    onl_mpd: 0,
    onb_tnk: 0,
    onl_tnk: 0
  };
  
  salesAreaSummary.forEach(row => {
    grandTotal.totalROs += row.totalROs;
    grandTotal.fullyOnline += row.fullyOnline;
    grandTotal.partiallyOnline += row.partiallyOnline;
    grandTotal.offline += row.offline;
    grandTotal.onb_mpd += row.onb_mpd;
    grandTotal.onl_mpd += row.onl_mpd;
    grandTotal.onb_tnk += row.onb_tnk;
    grandTotal.onl_tnk += row.onl_tnk;
    
    tbody.appendChild(createSummaryRowHtml(row, row.key));
  });
  
  // Finalize Grand Total
  grandTotal = finalizeAggregate(grandTotal);
  tbody.appendChild(createSummaryRowHtml(grandTotal, 'Territory Total', true));
}

// Render EO Table
function renderEOTable() {
  const tbody = document.getElementById('eo-tbody');
  tbody.innerHTML = '';
  eoSummary.forEach(row => {
    tbody.appendChild(createSummaryRowHtml(row, row.key));
  });
}

// Render SO Table
// Territory Summary (menu formerly "SO Summary"): one row per territory.
// Compares every territory in the data — the global Territory filter only
// highlights the chosen one — ranked by AVG uptime, with an all-territory total.
window.territorySummary = [];
window.territorySummaryTotal = null;
function computeTerritorySummary() {
  const src = (Array.isArray(window.__unscopedROs) && window.__unscopedROs.length) ? window.__unscopedROs : calculatedROs;
  const map = {};
  const total = createAggregateObj('All Territories');
  src.forEach(ro => {
    const k = String(ro.territory || '').trim() || 'Unmapped';
    if (!map[k]) map[k] = createAggregateObj(k);
    updateAggregateObj(map[k], ro);
    updateAggregateObj(total, ro);
  });
  const list = Object.values(map).map(finalizeAggregate)
    .sort((a, b) => (a.key === 'Unmapped') - (b.key === 'Unmapped') || b.uptime - a.uptime || b.totalROs - a.totalROs || a.key.localeCompare(b.key));
  list.forEach((r, i) => { r.rank = i + 1; });
  window.territorySummary = list;
  window.territorySummaryTotal = finalizeAggregate(total);
  return list;
}
function renderSOTable() {
  const tbody = document.getElementById('so-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const list = computeTerritorySummary();
  const sel = window.GlobalScope ? GlobalScope.get() : [];
  list.forEach(row => {
    const tr = createSummaryRowHtml(row, row.key);
    const td = document.createElement('td');
    td.className = 'ts-rank';
    td.textContent = row.rank;
    tr.insertBefore(td, tr.firstChild);
    if (sel.includes(row.key)) tr.classList.add('ts-selected');
    tbody.appendChild(tr);
  });
  if (list.length > 1) {
    const tr = createSummaryRowHtml(window.territorySummaryTotal, 'All Territories', true);
    tr.insertBefore(document.createElement('td'), tr.firstChild);
    tbody.appendChild(tr);
  }
  const note = document.getElementById('territory-summary-note');
  if (note) note.textContent = list.length
    ? `${list.length} territor${list.length === 1 ? 'y' : 'ies'} · ranked by AVG uptime` + (sel.length ? ' · your territory highlighted' : '')
    : 'No data loaded yet';
}

// Render Vendor Table
function renderVendorTable() {
  const tbody = document.getElementById('vendor-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  vendorSummary.forEach(row => {
    tbody.appendChild(createSummaryRowHtml(row, row.key));
  });
}

function createSummaryRowHtml(row, name, isGrandTotal = false) {
  const tr = document.createElement('tr');
  if (isGrandTotal) tr.classList.add('summary-row');
  
  tr.innerHTML = `
    <td>${name}</td>
    <td>${row.totalROs}</td>
    <td>${row.fullyOnline}</td>
    <td>${row.partiallyOnline}</td>
    <td>${row.offline}</td>
    <td>${row.onb_mpd.toFixed(0)}</td>
    <td>${row.onl_mpd.toFixed(0)}</td>
    <td>${(row.mpdUptime * 100).toFixed(1)}%</td>
    <td>${row.onb_tnk.toFixed(0)}</td>
    <td>${row.onl_tnk.toFixed(0)}</td>
    <td>${(row.tankUptime * 100).toFixed(1)}%</td>
    <td style="font-weight: 600; color: ${isGrandTotal ? 'var(--text-primary)' : 'var(--accent-color)'}">
      ${(row.uptime * 100).toFixed(2)}%
    </td>
    <td>${row.off_mpd.toFixed(0)}</td>
    <td>${row.off_tnk.toFixed(0)}</td>
  `;
  return tr;
}

// Populate Filters dynamically
window.populateFilters = populateFilters;
window.filterROExplorer = filterROExplorer;
window.renderROExplorerPage = renderROExplorerPage;

function populateFilters() {
  // Sales Area filter
  const areaSelect = document.getElementById('ro-filter-area');
  areaSelect.innerHTML = '<option value="">All Sales Areas</option>';
  
  const areas = [...new Set(calculatedROs.map(ro => ro.sales_area))].sort();
  areas.forEach(area => {
    const opt = document.createElement('option');
    opt.value = area;
    opt.textContent = area;
    areaSelect.appendChild(opt);
  });
  
  // NANO Status filter
  const nanoSelect = document.getElementById('ro-filter-nano');
  nanoSelect.innerHTML = '<option value="">All NANO Statuses</option>';
  
  const nanos = [...new Set(calculatedROs.map(ro => ro.nano_status))].sort();
  nanos.forEach(nano => {
    const opt = document.createElement('option');
    opt.value = nano;
    opt.textContent = nano;
    nanoSelect.appendChild(opt);
  });
}

// RO Explorer Filter & Render
function filterROExplorer() {
  const searchEl = document.getElementById('ro-search-input');
  const searchQuery = searchEl ? searchEl.value.toLowerCase().trim() : '';

  const statusEl = document.getElementById('ro-filter-status');
  const statusFilter = MS.vals(statusEl);

  const areaEl = document.getElementById('ro-filter-area');
  const areaFilter = MS.vals(areaEl);

  const nanoEl = document.getElementById('ro-filter-nano');
  const nanoFilter = MS.vals(nanoEl);

  const techEl = document.getElementById('ro-filter-technology');
  const techFilter = MS.vals(techEl);

  const nlFilterEl = document.getElementById('ro-filter-new-logic');
  const nlFilter = MS.vals(nlFilterEl);
  
  roFilteredList = calculatedROs.filter(ro => {
    // Search match
    const searchMatch = searchQuery === "" || 
      (ro.roid && String(ro.roid).toLowerCase().includes(searchQuery)) ||
      (ro.outlet_name && ro.outlet_name.toLowerCase().includes(searchQuery)) ||
      (ro.sales_area && ro.sales_area.toLowerCase().includes(searchQuery)) ||
      (ro.eo_name && ro.eo_name.toLowerCase().includes(searchQuery)) ||
      (ro.vendor && ro.vendor.toLowerCase().includes(searchQuery)) ||
      (ro.mst_name && ro.mst_name.toLowerCase().includes(searchQuery));
      
    const statusMatch = MS.ok(statusFilter, ro.status);
    const nlMatch = MS.ok(nlFilter, ro.new_logic_status || ro.ro_online_status || ro.status);
    const nanoMatch = MS.ok(nanoFilter, ro.nano_status);
    const areaMatch = MS.ok(areaFilter, ro.sales_area);
    const techMatch = MS.ok(techFilter, ro.iot_status);
    
    return searchMatch && statusMatch && nlMatch && nanoMatch && areaMatch && techMatch;
  });
  
  sortROs();
  renderROExplorerPage();
}

function sortROs() {
  const key = roSortField;
  const asc = roSortAsc;
  
  roFilteredList.sort((a, b) => {
    let valA = key === 'new_logic_status' ? (a.new_logic_status || a.ro_online_status || a.status || '') : a[key];
    let valB = key === 'new_logic_status' ? (b.new_logic_status || b.ro_online_status || b.status || '') : b[key];
    
    // Numeric conversions
    if (key === 'sales_area') { const c = compareBySalesArea(a, b); return asc ? c : -c; }
    if (typeof valA === 'string' && !isNaN(valA) && valA !== "") valA = parseFloat(valA);
    if (typeof valB === 'string' && !isNaN(valB) && valB !== "") valB = parseFloat(valB);
    
    if (valA < valB) return asc ? -1 : 1;
    if (valA > valB) return asc ? 1 : -1;
    return compareBySalesArea(a, b);
  });
}

function renderROExplorerPage() {
  const tbody = document.getElementById('ro-explorer-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  const total = roFilteredList.length;
  const startIdx = (roCurrentPage - 1) * RO_PAGE_SIZE;
  const endIdx = Math.min(startIdx + RO_PAGE_SIZE, total);
  
  const pageData = roFilteredList.slice(startIdx, endIdx);
  
  if (total === 0) {
    tbody.innerHTML = `<tr><td colspan="19" style="text-align: center; padding: 2rem;">No matching outlets found.</td></tr>`;
    const infoEl = document.getElementById('ro-pagination-info');
    if (infoEl) infoEl.textContent = "Showing 0 to 0 of 0 entries";
    renderPaginationButtons('ro-pagination-btns', 0, 1, 1, (page) => {});
    return;
  }
  
  pageData.forEach(ro => {
    const tr = document.createElement('tr');
    
    let statusClass = "badge-offline";
    if (ro.status === "Fully Online") statusClass = "badge-online";
    else if (ro.status === "Partially Online") statusClass = "badge-partial";
    
    const nlStatus = ro.new_logic_status || ro.ro_online_status || ro.status;
    let nlClass = "badge-offline";
    if (nlStatus === "Fully Online") nlClass = "badge-online";
    else if (nlStatus === "Partially Online" || nlStatus === "Partial") nlClass = "badge-partial";
    
    const offMpdVal = parseInt(ro.off_mpd) || 0;
    const offTnkVal = parseInt(ro.off_tnk) || 0;
    const offMpdHtml = offMpdVal > 0 ? `<span class="badge badge-offline" style="font-weight: 700;">${offMpdVal}</span>` : '0';
    const offTnkHtml = offTnkVal > 0 ? `<span class="badge badge-offline" style="font-weight: 700;">${offTnkVal}</span>` : '0';

    tr.innerHTML = `
      <td style="font-weight: 700; font-family: monospace;">${ro.roid}</td>
      <td style="font-weight: 700;" title="${ro.outlet_name}">${ro.outlet_name}</td>
      <td>${ro.sales_area}</td>
      <td>${ro.eo_name}</td>
      <td>${ro.vendor}</td>
      <td>${ro.mst_name}</td>
      <td>${ro.auto_rsp}</td>
      <td>${ro.onb_mpd !== undefined ? ro.onb_mpd.toFixed(0) : '0'}</td>
      <td>${ro.onl_mpd !== undefined ? ro.onl_mpd.toFixed(0) : '0'}</td>
      <td>${ro.onb_tnk !== undefined ? ro.onb_tnk.toFixed(0) : '0'}</td>
      <td>${ro.onl_tnk !== undefined ? ro.onl_tnk.toFixed(0) : '0'}</td>
      <td>${ro.tot_onb !== undefined ? ro.tot_onb.toFixed(1) : '0'}</td>
      <td>${ro.tot_onl !== undefined ? ro.tot_onl.toFixed(1) : '0'}</td>
      <td style="font-weight: 600;">${(ro.uptime !== undefined ? (ro.uptime * 100).toFixed(1) : '0.0')}%</td>
      <td><span class="badge ${statusClass}">${ro.status}</span></td>
      <td>${offMpdHtml}</td>
      <td>${offTnkHtml}</td>
      <td title="${ro.condition || ''}">${ro.nano_status || '-'}</td>
      <td><span class="badge ${nlClass}">${nlStatus}</span></td>
    `;
    tbody.appendChild(tr);
  });
  
  const infoEl = document.getElementById('ro-pagination-info');
  if (infoEl) {
    infoEl.textContent = `Showing ${startIdx + 1} to ${endIdx} of ${total} entries`;
  }
    
  const maxPages = Math.ceil(total / RO_PAGE_SIZE);
  renderPaginationButtons('ro-pagination-btns', maxPages, roCurrentPage, total, (page) => {
    roCurrentPage = page;
    renderROExplorerPage();
  });
}

// Pagination Builder Helper
function renderPaginationButtons(containerId, maxPages, currentPage, totalEntries, onPageClick) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  
  if (totalEntries === 0) return;
  
  // Previous button
  const prevBtn = document.createElement('div');
  prevBtn.className = `pagination-btn ${currentPage === 1 ? 'disabled' : ''}`;
  prevBtn.innerHTML = `&laquo;`;
  if (currentPage > 1) {
    prevBtn.addEventListener('click', () => onPageClick(currentPage - 1));
  }
  container.appendChild(prevBtn);
  
  // Number buttons
  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(maxPages, startPage + 4);
  
  for (let i = startPage; i <= endPage; i++) {
    const numBtn = document.createElement('div');
    numBtn.className = `pagination-btn ${currentPage === i ? 'active' : ''}`;
    numBtn.textContent = i;
    numBtn.addEventListener('click', () => onPageClick(i));
    container.appendChild(numBtn);
  }
  
  // Next button
  const nextBtn = document.createElement('div');
  nextBtn.className = `pagination-btn ${currentPage === maxPages ? 'disabled' : ''}`;
  nextBtn.innerHTML = `&raquo;`;
  if (currentPage < maxPages) {
    nextBtn.addEventListener('click', () => onPageClick(currentPage + 1));
  }
  container.appendChild(nextBtn);
}

// Mappings Management Tab
function filterMappings() {
  const query = document.getElementById('map-search-input').value.toLowerCase().trim();
  const list = [];
  
  Object.keys(activeMappings).forEach(roid => {
    const info = activeMappings[roid];
    if (query === "" || 
        roid.includes(query) ||
        info.outlet_name.toLowerCase().includes(query) ||
        info.eo_name.toLowerCase().includes(query) ||
        info.so_name.toLowerCase().includes(query) ||
        info.mst_name.toLowerCase().includes(query)) {
      list.push({
        roid: roid,
        outlet_name: info.outlet_name,
        eo_name: info.eo_name,
        sales_group: info.sales_group,
        so_name: info.so_name,
        mst_name: info.mst_name,
        isCustom: !!customMappings[roid]
      });
    }
  });
  
  mapFilteredList = list;
  sortMappings();
  renderMappingsPage();
}

function sortMappings() {
  const key = mapSortField;
  const asc = mapSortAsc;
  
  mapFilteredList.sort((a, b) => {
    let valA = key === 'new_logic_status' ? (a.new_logic_status || a.ro_online_status || a.status || '') : a[key];
    let valB = key === 'new_logic_status' ? (b.new_logic_status || b.ro_online_status || b.status || '') : b[key];
    
    if (key === 'roid') {
      valA = parseInt(valA);
      valB = parseInt(valB);
    }
    
    if (valA < valB) return asc ? -1 : 1;
    if (valA > valB) return asc ? 1 : -1;
    return 0;
  });
}

function renderMappingsTable() {
  filterMappings();
}

function renderMappingsPage() {
  const tbody = document.getElementById('mapping-tbody');
  tbody.innerHTML = '';
  
  const total = mapFilteredList.length;
  const startIdx = (mapCurrentPage - 1) * MAP_PAGE_SIZE;
  const endIdx = Math.min(startIdx + MAP_PAGE_SIZE, total);
  
  const pageData = mapFilteredList.slice(startIdx, endIdx);
  
  if (total === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem;">No mappings found.</td></tr>`;
    document.getElementById('map-pagination-info').textContent = "Showing 0 to 0 of 0 entries";
    renderPaginationButtons('map-pagination-btns', 0, 1, 1, (page) => {});
    return;
  }
  
  pageData.forEach(row => {
    const tr = document.createElement('tr');
    if (row.isCustom) {
      tr.style.borderLeft = "3px solid var(--accent-color)";
    }
    
    tr.innerHTML = `
      <td>${row.roid}</td>
      <td title="${row.outlet_name}">${row.outlet_name}</td>
      <td>${row.eo_name}</td>
      <td>${row.sales_group}</td>
      <td>${row.so_name}</td>
      <td>${row.mst_name}</td>
      <td>
        <button class="btn-secondary" style="padding: 0.2rem 0.5rem; font-size: 0.75rem; display: inline-flex;" onclick="editMappingEntry('${row.roid}')">Edit</button>
        ${row.isCustom ? `<button class="btn-secondary" style="padding: 0.2rem 0.5rem; font-size: 0.75rem; color: var(--status-offline); display: inline-flex;" onclick="deleteMappingEntry('${row.roid}')">Delete</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });
  
  document.getElementById('map-pagination-info').textContent = `Showing ${startIdx + 1} to ${endIdx} of ${total} entries`;
  
  const maxPages = Math.ceil(total / MAP_PAGE_SIZE);
  renderPaginationButtons('map-pagination-btns', maxPages, mapCurrentPage, total, (page) => {
    mapCurrentPage = page;
    renderMappingsPage();
  });
}

// Global functions for inline actions (Edit/Delete mappings)
window.editMappingEntry = function(roid) {
  const item = activeMappings[roid];
  if (!item) return;
  
  document.getElementById('map-roid').value = roid;
  document.getElementById('map-outlet').value = item.outlet_name;
  document.getElementById('map-eo').value = item.eo_name;
  document.getElementById('map-so').value = item.so_name;
  document.getElementById('map-mst').value = item.mst_name || '';
  document.getElementById('map-group').value = item.sales_group || '';
  
  // Scroll form into view
  document.getElementById('mapping-entry-form').scrollIntoView({ behavior: 'smooth' });
};

window.deleteMappingEntry = function(roid) {
  if (confirm(`Delete custom mapping override for ROID ${roid}?`)) {
    delete customMappings[roid];
    localStorage.setItem('bpcl_custom_mappings', JSON.stringify(customMappings));
    refreshActiveMappings();
    showToast(`Deleted custom mapping override for ${roid}`, "success");
    renderMappingsTable();
    if (calculatedROs.length > 0) {
      recalculateAndRefresh();
    }
  }
};

// Toast Alerts
function showToast(message, type = "success") {
  const toast = document.getElementById('toast-notification');
  const icon = document.getElementById('toast-icon');
  const msgEl = document.getElementById('toast-message');
  
  msgEl.textContent = message;
  
  if (type === "success") {
    icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="toast-success-icon"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  } else {
    icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="toast-error-icon"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  }
  
  toast.classList.add('show');
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

// Exports Handler
function exportToCSV(dataList, filename, isSalesArea = false, isRODetails = false) {
  if (!dataList || dataList.length === 0) {
    showToast("No data to export", "error");
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  let headers = [];
  
  if (isSalesArea) {
    headers = ["Sales Area", "Total ROs", "Fully Online", "Partially Online", "Offline", "Onbd MPD", "Online MPD", "MPD Uptime %", "Onbd Tank", "Online Tank", "Tank Uptime %", "AVG Uptime %", "Offline MPDs", "Offline Tanks"];
  } else if (isRODetails) {
    headers = ["ROID", "Retail Outlet", "Sales Area", "TE Name", "RA Vendor", "MST Name", "Auto RSP", "Onbd MPD", "Online MPD", "Onbd Tank", "Online Tank", "Total Onbd", "Total Online", "Uptime %", "Equipment Status", "Offline MPD", "Offline Tank", "NANO Status", "2 Slot Status"];
  } else {
    headers = ["Name", "Total ROs", "Fully Online", "Partially Online", "Offline", "Onbd MPD", "Online MPD", "MPD Uptime %", "Onbd Tank", "Online Tank", "Tank Uptime %", "AVG Uptime %", "Offline MPDs", "Offline Tanks"];
  }
  
  csvContent += headers.map(h => `"${h.replace(/"/g, '""')}"`).join(",") + "\n";
  
  dataList.forEach(row => {
    let rowVals = [];
    if (isRODetails) {
      rowVals = [
        row.roid,
        row.outlet_name,
        row.sales_area,
        row.eo_name,
        row.vendor || "Unmapped",
        row.mst_name,
        row.auto_rsp,
        row.onb_mpd,
        row.onl_mpd,
        row.onb_tnk,
        row.onl_tnk,
        row.tot_onb,
        row.tot_onl,
        (row.uptime * 100).toFixed(2) + "%",
        row.status,

        row.off_mpd,
        row.off_tnk,
        row.nano_status,
        row.new_logic_status || row.ro_online_status || row.status
      ];
    } else {
      rowVals = [
        row.key || row.name || "Territory Total",
        row.totalROs,
        row.fullyOnline,
        row.partiallyOnline,
        row.offline,
        row.onb_mpd,
        row.onl_mpd,
        (row.mpdUptime * 100).toFixed(2) + "%",
        row.onb_tnk,
        row.onl_tnk,
        (row.tankUptime * 100).toFixed(2) + "%",
        (row.uptime * 100).toFixed(2) + "%",
        row.off_mpd,
        row.off_tnk
      ];
    }
    
    csvContent += rowVals.map(v => {
      const str = String(v);
      return `"${str.replace(/"/g, '""')}"`;
    }).join(",") + "\n";
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Samples loader (for verification / testing demo)
function loadSampleData() {
  // Let's generate synthetic but structurally realistic data representing the spreadsheet
  // We can also fetch data.xlsx via AJAX and parse it if the user wants, but generating a sample locally is direct.
  // Wait! Since we have the workbook `data.xlsx` downloaded locally, we can just fetch it!
  // This is way better than mock data because it's the ACTUAL data!
  // Let's read `data.xlsx` from the server. But wait, we are in a static file context, does it let us fetch?
  // If the browser opens index.html locally (file:// scheme), AJAX fetch to mapping.json and data.xlsx might be blocked by CORS!
  // Ah! If it's opened via file://, fetching a local Excel file might cause a CORS error.
  // To handle that, we can embed a backup set of sample data directly inside app.js, so that if the user clicks "load sample",
  // we load the complete data set directly from pre-defined records. Or we can try to fetch, and if it fails, fallback to generating
  // the exact 368 outlets.
  // Wait, let's write a python script to convert the raw data from `data.xlsx` into a JSON file `sample_raw_data.json` inside the workspace!
  // That way, if they click "load sample data", we fetch it. And if they run it locally under file://, SheetJS can still read local files they upload,
  // and we can also embed the sample raw data directly inside `app.js` as a local JS object, or we can instruct them how to upload their Excel sheet.
  // Wait! Embedding the raw data from `data.xlsx` as a static array in a separate file `sample_data.js` or in `app.js` is incredibly neat,
  // because then they can immediately click "Load Sample Data" and see the EXACT dashboard values!
  // Let's do that! Let's write a python script to extract all raw data rows and write them as a JS array inside a new file `sample_data.js`
  // and load it in `index.html`.
  // Wait! Let's check how many rows there are. 370 rows. A JS array of 370 elements is very small (around 30-40KB) and can easily be loaded in a script!
  // This is a brilliant strategy. It ensures the "Load Sample Data" button works 100% of the time, even under file:// CORS restrictions!

  if (window.BPCL_SAMPLE_DATA) {
    rawDataRows.length = 0;
    const mappedSamples = window.BPCL_SAMPLE_DATA.map(ro => {
      const cloned = Object.assign({}, ro);
      if (!cloned.iot_enabled) {
        cloned.iot_enabled = parseInt(cloned.roid) % 3 !== 0 ? "Yes" : "No";
      }
      return cloned;
    });
    rawDataRows.push(...mappedSamples);
    recalculateAndRefresh();
    
    document.getElementById('upload-landing-view').style.display = 'none';
    document.getElementById('dashboard-active-view').style.display = 'flex';
    
    document.getElementById('file-meta').textContent = `Loaded: Preloaded Belgaum Territory Sample (${rawDataRows.length} rows)`;
    document.getElementById('file-meta').style.display = 'block';
    document.getElementById('header-upload-wrapper').style.display = 'block';
    
    showToast("Loaded sample territory data!", "success");
  } else {
    showToast("Sample data file not loaded. Please upload your spreadsheet.", "error");
  }
}

// ==========================================
// Neumorphic KPI Modal Details & Exporter
// ==========================================
let activeModalData = [];
let activeModalType = '';

window.openKpiDetailsModal = function(type) {
  activeModalType = type;
  const modal = document.getElementById('kpi-details-modal');
  const titleEl = document.getElementById('modal-title');
  const headersEl = document.getElementById('modal-table-headers');
  const bodyEl = document.getElementById('modal-table-body');
  
  if (!modal || !titleEl || !headersEl || !bodyEl) return;
  
  headersEl.innerHTML = '';
  bodyEl.innerHTML = '';
  
  let list = [];
  let headers = [];
  let title = '';
  
  if (type === 'total') {
    title = 'Total Retail Outlets';
    headers = ["ROID", "Retail Outlet", "Sales Area", "TE Name", "SO Name", "Auto RSP", "Uptime", "Status"];
    list = dashboardFilteredROs;
  } else if (type === 'fully') {
    title = 'Fully Online Outlets';
    headers = ["ROID", "Retail Outlet", "Sales Area", "TE Name", "SO Name", "Auto RSP", "Uptime", "Status"];
    list = dashboardFilteredROs.filter(ro => ro.status === "Fully Online");
  } else if (type === 'partially') {
    title = 'Partially Online Outlets';
    headers = ["ROID", "Retail Outlet", "Sales Area", "TE Name", "SO Name", "Auto RSP", "Uptime", "Status"];
    list = dashboardFilteredROs.filter(ro => ro.status === "Partially Online");
  } else if (type === 'offline') {
    title = 'Offline Outlets';
    headers = ["ROID", "Retail Outlet", "Sales Area", "TE Name", "SO Name", "Auto RSP", "Uptime", "Status"];
    list = dashboardFilteredROs.filter(ro => ro.status === "Offline");
  } else if (type === 'mpd') {
    title = 'MPD Uptime Details (Onboarded)';
    headers = ["ROID", "Retail Outlet", "Sales Area", "Onbd MPD", "Online MPD", "Offline MPD", "MPD Uptime"];
    list = dashboardFilteredROs.filter(ro => ro.onb_mpd > 0).sort((a, b) => {
      const uptA = a.onb_mpd > 0 ? (a.onl_mpd / a.onb_mpd) : 0;
      const uptB = b.onb_mpd > 0 ? (b.onl_mpd / b.onb_mpd) : 0;
      return uptA - uptB;
    });
  } else if (type === 'tank') {
    title = 'Tank Uptime Details (Onboarded)';
    headers = ["ROID", "Retail Outlet", "Sales Area", "Onbd Tank", "Online Tank", "Offline Tank", "Tank Uptime"];
    list = dashboardFilteredROs.filter(ro => ro.onb_tnk > 0).sort((a, b) => {
      const uptA = a.onb_tnk > 0 ? (a.onl_tnk / a.onb_tnk) : 0;
      const uptB = b.onb_tnk > 0 ? (b.onl_tnk / b.onb_tnk) : 0;
      return uptA - uptB;
    });
  } else if (type === 'territory') {
    title = 'Territory Uptime Details';
    headers = ["ROID", "Retail Outlet", "Sales Area", "Total Onbd", "Total Online", "Uptime", "Status"];
    list = dashboardFilteredROs.slice().sort((a, b) => a.uptime - b.uptime); // copy: don't reorder the dashboard's own list
  } else if (type === 'autorsp') {
    title = 'Auto RSP Outlets';
    headers = ["ROID", "Retail Outlet", "Sales Area", "TE Name", "SO Name", "Auto RSP", "Uptime", "Status"];
    list = dashboardFilteredROs.filter(ro => ro.auto_rsp.toLowerCase() === "yes" || ro.auto_rsp === "Yes");
  }
  
  activeModalData = list;
  titleEl.textContent = `${title} (${list.length} Outlets)`;
  
  headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    headersEl.appendChild(th);
  });
  
  if (list.length === 0) {
    bodyEl.innerHTML = `<tr><td colspan="${headers.length}" style="text-align: center; padding: 2rem;">No matching outlets found.</td></tr>`;
  } else {
    list.forEach(ro => {
      const tr = document.createElement('tr');
      let cols = [];
      let uptimeVal = (ro.uptime * 100).toFixed(2) + '%';
      
      if (type === 'total' || type === 'fully' || type === 'partially' || type === 'offline' || type === 'autorsp') {
        cols = [
          ro.roid,
          ro.outlet_name,
          ro.sales_area,
          ro.eo_name,
          ro.so_name,
          ro.auto_rsp,
          uptimeVal,
          `<span class="status-badge status-${ro.status.toLowerCase().replace(' ', '-')}">${ro.status}</span>`
        ];
      } else if (type === 'mpd') {
        const mpdUptime = ro.onb_mpd > 0 ? (ro.onl_mpd / ro.onb_mpd * 100).toFixed(2) + '%' : '0.00%';
        cols = [
          ro.roid,
          ro.outlet_name,
          ro.sales_area,
          ro.onb_mpd.toFixed(0),
          ro.onl_mpd.toFixed(0),
          ro.off_mpd.toFixed(0),
          mpdUptime
        ];
      } else if (type === 'tank') {
        const tankUptime = ro.onb_tnk > 0 ? (ro.onl_tnk / ro.onb_tnk * 100).toFixed(2) + '%' : '0.00%';
        cols = [
          ro.roid,
          ro.outlet_name,
          ro.sales_area,
          ro.onb_tnk.toFixed(0),
          ro.onl_tnk.toFixed(0),
          ro.off_tnk.toFixed(0),
          tankUptime
        ];
      } else if (type === 'territory') {
        cols = [
          ro.roid,
          ro.outlet_name,
          ro.sales_area,
          ro.tot_onb.toFixed(0),
          ro.tot_onl.toFixed(0),
          uptimeVal,
          `<span class="status-badge status-${ro.status.toLowerCase().replace(' ', '-')}">${ro.status}</span>`
        ];
      }
      
      tr.innerHTML = cols.map(c => `<td>${c}</td>`).join('');
      bodyEl.appendChild(tr);
    });
  }
  
  modal.style.display = 'flex';
};

window.closeKpiDetailsModal = function() {
  const modal = document.getElementById('kpi-details-modal');
  if (modal) modal.style.display = 'none';
};

window.downloadModalCSV = function() {
  if (!activeModalData || activeModalData.length === 0) {
    showToast("No data to download", "error");
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  let headers = [];
  
  if (activeModalType.startsWith('evcs_')) {
    headers = ["S.No", "Station Name", "BL Code", "OCPP ID", "Territory TE", "Power Rating", "City", "Type", "Status"];
  } else if (activeModalType === 'total' || activeModalType === 'fully' || activeModalType === 'partially' || activeModalType === 'offline' || activeModalType === 'autorsp') {
    headers = ["ROID", "Retail Outlet", "Sales Area", "TE Name", "SO Name", "Auto RSP", "Uptime %", "Status"];
  } else if (activeModalType === 'mpd') {
    headers = ["ROID", "Retail Outlet", "Sales Area", "Onbd MPD", "Online MPD", "Offline MPD", "MPD Uptime %"];
  } else if (activeModalType === 'tank') {
    headers = ["ROID", "Retail Outlet", "Sales Area", "Onbd Tank", "Online Tank", "Offline Tank", "Tank Uptime %"];
  } else if (activeModalType === 'territory') {
    headers = ["ROID", "Retail Outlet", "Sales Area", "Total Onbd", "Total Online", "Uptime %", "Status"];
  }
  
  csvContent += headers.map(h => `"${h.replace(/"/g, '""')}"`).join(",") + "\n";
  
  activeModalData.forEach(row => {
    let rowVals = [];
    if (activeModalType.startsWith('evcs_')) {
      rowVals = [
        row.s_no,
        row.station_name,
        row.bl_code,
        row.ocpp_id,
        row.territory_eo,
        row.power_rating,
        row.city,
        row.type,
        row.status
      ];
    } else if (activeModalType === 'total' || activeModalType === 'fully' || activeModalType === 'partially' || activeModalType === 'offline' || activeModalType === 'autorsp') {
      rowVals = [
        row.roid,
        row.outlet_name,
        row.sales_area,
        row.eo_name,
        row.so_name,
        row.auto_rsp,
        (row.uptime * 100).toFixed(2) + "%",
        row.status
      ];
    } else if (activeModalType === 'mpd') {
      const mpdUptime = row.onb_mpd > 0 ? (row.onl_mpd / row.onb_mpd * 100).toFixed(2) + '%' : '0.00%';
      rowVals = [
        row.roid,
        row.outlet_name,
        row.sales_area,
        row.onb_mpd.toFixed(0),
        row.onl_mpd.toFixed(0),
        row.off_mpd.toFixed(0),
        mpdUptime
      ];
    } else if (activeModalType === 'tank') {
      const tankUptime = row.onb_tnk > 0 ? (row.onl_tnk / row.onb_tnk * 100).toFixed(2) + '%' : '0.00%';
      rowVals = [
        row.roid,
        row.outlet_name,
        row.sales_area,
        row.onb_tnk.toFixed(0),
        row.onl_tnk.toFixed(0),
        row.off_tnk.toFixed(0),
        tankUptime
      ];
    } else if (activeModalType === 'territory') {
      rowVals = [
        row.roid,
        row.outlet_name,
        row.sales_area,
        row.tot_onb.toFixed(0),
        row.tot_onl.toFixed(0),
        (row.uptime * 100).toFixed(2) + "%",
        row.status
      ];
    }
    
    csvContent += rowVals.map(v => {
      const str = String(v);
      return `"${str.replace(/"/g, '""')}"`;
    }).join(",") + "\n";
  });
  
  const filename = `${activeModalType}_kpi_data.csv`;
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast(`Downloaded ${filename} successfully!`, "success");
};

// Close modal on click outside content
window.addEventListener('click', (e) => {
  const modal = document.getElementById('kpi-details-modal');
  if (e.target === modal) {
    closeKpiDetailsModal();
  }
});

// ==========================================
// Day Monitoring Panel Logic
// ==========================================

// ==========================================
// Shared Day Monitoring Cloud Sync
// ==========================================
window.dayMonitoringShared = {};
window.dayMonitoringSyncState = { loading: false, lastSync: null };

function getDayMonitoringApiConfig() {
  const cfg = window.DAY_MONITORING_CONFIG || {};
  return {
    apiUrl: (localStorage.getItem('day_monitoring_api_url') || cfg.apiUrl || '').trim(),
    apiKey: localStorage.getItem('day_monitoring_api_key') || cfg.apiKey || ''
  };
}

function getDayMonitoringDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

function getCurrentDashboardUserName() {
  return (window.currentUser && window.currentUser.username) ||
         localStorage.getItem('bpcl_dashboard_user_name') || 'Unknown User';
}

function getSharedDayData(roid) {
  const key = String(roid);
  return window.dayMonitoringShared[key] || {};
}

function setSharedDayData(roid, data) {
  window.dayMonitoringShared[String(roid)] = Object.assign({}, data);
}
window.getSharedDayData = getSharedDayData;
window.setSharedDayData = setSharedDayData;
window.dayMonitoringApiRequest = dayMonitoringApiRequest;
if (false) {
}

async function dayMonitoringApiRequest(method, payload) {
  const cfg = getDayMonitoringApiConfig();
  if (!cfg.apiUrl || cfg.apiUrl === 'CHANGE_ME') {
    throw new Error('Day Monitoring Google Apps Script URL is not configured.');
  }

  let url = cfg.apiUrl;
  if (method === 'GET') {
    const params = new URLSearchParams({
      action: 'get',
      date: getDayMonitoringDate(),
      territory: 'Belgaum',
      apiKey: cfg.apiKey
    });
    const response = await fetch(`${url}?${params.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cloud read failed (${response.status})`);
    return response.json();
  }

  // URLSearchParams keeps the request "simple" so Apps Script can receive it
  // without a CORS preflight.
  const form = new URLSearchParams();
  form.set('action', payload.action || 'saveRows');
  form.set('apiKey', cfg.apiKey);
  form.set('payload', JSON.stringify(payload));

  const response = await fetch(url, {
    method: 'POST',
    body: form,
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Cloud save failed (${response.status})`);
  return response.json();
}

window.loadSharedDayMonitoring = async function(silent = true) {
  if (window.dayMonitoringSyncState.loading) return;
  window.dayMonitoringSyncState.loading = true;

  try {
    const result = await dayMonitoringApiRequest('GET');
    if (result && result.success && Array.isArray(result.rows)) {
      window.dayMonitoringShared = {};
      result.rows.forEach(row => {
        if (row.roid !== undefined && row.roid !== null) {
          setSharedDayData(row.roid, row);
        }
      });
      window.dayMonitoringSyncState.lastSync = new Date();
      const cloudStatus = document.getElementById('day-monitoring-cloud-status');
      if (cloudStatus) {
        cloudStatus.textContent = `Shared Day Monitoring: synced ${window.dayMonitoringSyncState.lastSync.toLocaleTimeString()}.`;
      }
      if (typeof renderDayMonitoringTable === 'function') renderDayMonitoringTable();
      if (typeof window.renderOutletsStatusTable === 'function') window.renderOutletsStatusTable();
      if (typeof window.startAutomaticDayMonitoringSync === 'function') window.startAutomaticDayMonitoringSync();
    }
  } catch (error) {
    console.warn('Shared Day Monitoring load failed; local values will be used.', error);
    if (!silent) showToast(error.message || 'Could not load shared Day Monitoring data.', 'error');
  } finally {
    window.dayMonitoringSyncState.loading = false;
  }
};

window.saveSharedDayMonitoringRow = async function(ro, responsibility, remark, targetDate = '', showMessage = false, bromaNo = '', entryDate = '') {
  const row = {
    date: entryDate || getDayMonitoringDate(),
    roid: String(ro.roid),
    outletName: ro.outlet_name || '',
    salesArea: ro.sales_area || '',
    vendor: ro.vendor || '',
    status: ro.status || '',
    iot: ro.iot_status || '',
    uptime: Number(ro.uptime || 0),
    offlineMpd: Number(ro.off_mpd || 0),
    offlineTank: Number(ro.off_tnk || 0),
    responsibility: responsibility || '',
    remark: remark || '',
    targetDate: targetDate || '',
    bromaNo: bromaNo || '',
    updatedBy: getCurrentDashboardUserName(),
    updatedAt: new Date().toISOString(),
    territory: 'Belgaum'
  };

  // Update UI immediately; cloud sync happens in the background.
  setSharedDayData(row.roid, row);

  try {
    const result = await dayMonitoringApiRequest('POST', {
      action: 'saveRows',
      rows: [row]
    });
    if (!result || !result.success) throw new Error((result && result.message) || 'Cloud save failed');
    if (showMessage) showToast('Day Monitoring update saved for all users.', 'success');
  } catch (error) {
    console.error('Shared Day Monitoring save failed:', error);
    // Keep a local fallback so the entry is not lost if the network is down.
    localStorage.setItem('day_remarks_' + ro.roid, JSON.stringify({
      responsibility: responsibility || '',
      remark: remark || '',
      targetDate: targetDate || '',
      pendingCloudSync: true,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy
    }));
    showToast('Saved locally. Cloud sync failed; please retry when online.', 'error');
  }
};

let dayMonitoringAutoSyncTimer = null;
let dayMonitoringAutoSyncInProgress = false;

/**
 * Automatically pushes the current Day Monitoring rows to the shared backend.
 * This keeps the server-side copy current so the nightly Apps Script trigger
 * can archive it even when nobody clicks the Drive button.
 */
window.autoSyncDayMonitoringToCloud = async function(silent = true) {
  if (dayMonitoringAutoSyncInProgress || !Array.isArray(calculatedROs) || !calculatedROs.length) return;
  
  // Guard against overwriting cloud data with empty/stale local values on startup
  if (!window.dayMonitoringSyncState.lastSync) {
    console.log("Skipping auto-push sync: Cloud data not yet loaded.");
    return;
  }

  const cfg = getDayMonitoringApiConfig();
  if (!cfg.apiUrl || !cfg.apiKey || cfg.apiKey === 'CHANGE_THIS_KEY') return;

  const list = calculatedROs.filter(ro => ro.status === 'Partially Online' || ro.status === 'Offline');
  if (!list.length) return;

  dayMonitoringAutoSyncInProgress = true;
  try {
    const rows = list.map(ro => {
      const shared = getSharedDayData(ro.roid);
      const local = JSON.parse(localStorage.getItem('day_remarks_' + ro.roid) || '{}');
      return {
        date: getDayMonitoringDate(),
        roid: String(ro.roid),
        outletName: ro.outlet_name || '',
        salesArea: ro.sales_area || '',
        vendor: ro.vendor || '',
        status: ro.status || '',
        iot: ro.iot_status || '',
        uptime: Number(ro.uptime || 0),
        offlineMpd: Number(ro.off_mpd || 0),
        offlineTank: Number(ro.off_tnk || 0),
        responsibility: shared.responsibility ?? local.responsibility ?? '',
        remark: shared.remark ?? local.remark ?? '',
        targetDate: shared.targetDate ?? local.targetDate ?? '',
        updatedBy: shared.updatedBy || getCurrentDashboardUserName(),
        updatedAt: shared.updatedAt || new Date().toISOString(),
        territory: 'Belgaum'
      };
    });

    const result = await dayMonitoringApiRequest('POST', { action: 'saveRows', rows });
    if (!result || !result.success) throw new Error((result && result.message) || 'Automatic cloud sync failed');

    const cloudStatus = document.getElementById('day-monitoring-cloud-status');
    if (cloudStatus) {
      cloudStatus.textContent = `Shared Day Monitoring: auto-synced ${new Date().toLocaleTimeString()}. Nightly Drive backup is enabled.`;
    }
  } catch (error) {
    console.warn('Automatic Day Monitoring cloud sync failed:', error);
    if (!silent) showToast(error.message || 'Automatic cloud sync failed.', 'error');
  } finally {
    dayMonitoringAutoSyncInProgress = false;
  }
};

window.startAutomaticDayMonitoringSync = function() {
  if (dayMonitoringAutoSyncTimer) clearInterval(dayMonitoringAutoSyncTimer);
  // First sync shortly after the current data is available, then every 10 minutes.
  setTimeout(() => window.autoSyncDayMonitoringToCloud(true), 3000);
  dayMonitoringAutoSyncTimer = setInterval(() => window.autoSyncDayMonitoringToCloud(true), 10 * 60 * 1000);

  // Poll for updates from other users every 30 seconds
  if (window.dayMonitoringPollTimer) clearInterval(window.dayMonitoringPollTimer);
  window.dayMonitoringPollTimer = setInterval(async () => {
    // Only pull if the user is not actively typing or selecting inside the table
    const activeEl = document.activeElement;
    const isEditing = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT') && (activeEl.closest('#day-monitoring-tbody') || activeEl.closest('#outlets-status-tbody'));
    if (!isEditing) {
      try {
        await window.loadSharedDayMonitoring(true);
      } catch (e) {
        console.warn("Background fetch of shared day monitoring failed:", e);
      }
    }
  }, 30 * 1000);
};

window.saveDailyDayMonitoringToDrive = async function() {
  const list = calculatedROs.filter(ro => ro.status === "Partially Online" || ro.status === "Offline");
  if (!list.length) {
    showToast('No offline or partially online sites to save.', 'error');
    return;
  }

  const rows = list.map(ro => {
    const shared = getSharedDayData(ro.roid);
    const local = JSON.parse(localStorage.getItem('day_remarks_' + ro.roid) || '{}');
    return {
      date: getDayMonitoringDate(),
      roid: String(ro.roid),
      outletName: ro.outlet_name || '',
      salesArea: ro.sales_area || '',
      vendor: ro.vendor || '',
      status: ro.status || '',
      iot: ro.iot_status || '',
      uptime: Number(ro.uptime || 0),
      offlineMpd: Number(ro.off_mpd || 0),
      offlineTank: Number(ro.off_tnk || 0),
      responsibility: shared.responsibility ?? local.responsibility ?? '',
      remark: shared.remark ?? local.remark ?? '',
      targetDate: shared.targetDate ?? local.targetDate ?? '',
      updatedBy: shared.updatedBy || getCurrentDashboardUserName(),
      updatedAt: shared.updatedAt || new Date().toISOString(),
      territory: 'Belgaum'
    };
  });

  const btn = document.getElementById('save-day-monitoring-drive-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  try {
    const result = await dayMonitoringApiRequest('POST', {
      action: 'saveDaily',
      date: getDayMonitoringDate(),
      territory: 'Belgaum',
      rows
    });
    if (!result || !result.success) throw new Error((result && result.message) || 'Daily archive failed');

    if (result.fileUrl) {
      showToast(`Daily data saved to Google Drive: ${result.fileName || 'archive file'}`, 'success');
      window.open(result.fileUrl, '_blank');
    } else {
      showToast('Daily monitoring data saved to Google Drive.', 'success');
    }
  } catch (error) {
    console.error('Daily Google Drive archive failed:', error);
    showToast(error.message || 'Could not save daily data to Google Drive.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = 'Save Daily Data to Drive'; }
  }
};

const COMPLAINT_REMARKS_DB = {
  '': ['Onboarding pending','Reconfiguration/Onboarding pending','Calibration pending',
    'MPD Technical issue','Old MPD removed/WIP Deboarding','Slave/Master Slave issue',
    'Gantry no sell','Dealer switched off MPD','IOT communication issue',
    'Tank calibration/sensor/ATG issues','Power issue','No SIM/Network issue',
    'RO closed temporarily','Other'],
  'DEALER': ['Automation Switched off','Stamping Pending','Network issue','NOT USING','SWITCH OFF'],
  'BPCL':   ['MPD technical issue','ATG cable issue','PO to be issued'],
  'RA VENDOR': ['Probe issue','Float issue','Console issue (GVR)','Barrier Card Issue (IOT)',
    'Software issue (IOT)','SLAVE issue','C1 ISSUE','Onboarding Pending','IRIS Alert issue',
    'Connectivity Issue','WFCC issue','IOT Software Issue','SPARE issue'],
  'VENDOR': ['Probe issue','Float issue','Console issue (GVR)','Barrier Card Issue (IOT)',
    'Software issue (IOT)','SLAVE issue','C1 ISSUE','Onboarding Pending','IRIS Alert issue',
    'Connectivity Issue','WFCC issue','IOT Software Issue','SPARE issue']
};

window.renderDayMonitoringTable = function() {
  const tbody = document.getElementById('day-monitoring-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const searchQuery = (document.getElementById('day-search-input').value || '').toLowerCase().trim();
  
  // Header filter values
  const filterArea = MS.vals('day-filter-area');
  const filterVendor = MS.vals('day-filter-vendor');
  const filterStatus = MS.vals('day-filter-status');
  const filterTech = MS.vals('day-filter-tech');
  const filterResp = MS.vals('day-filter-resp');

  // Filter for partially online or offline sites
  const list = calculatedROs.filter(ro => {
    if (ro.status !== "Partially Online" && ro.status !== "Offline") {
      return false;
    }
    
    // Header filters
    if (!MS.ok(filterArea, ro.sales_area)) return false;
    if (!MS.ok(filterVendor, ro.vendor)) return false;
    if (!MS.ok(filterStatus, ro.status)) return false;
    if (!MS.ok(filterTech, ro.iot_status)) return false;
    if (filterResp.length) {
      const sharedData = getSharedDayData(ro.roid);
      const localData = JSON.parse(localStorage.getItem('day_remarks_' + ro.roid) || '{}');
      const resp = sharedData.responsibility ?? localData.responsibility ?? '';
      if (!MS.ok(filterResp, resp)) return false;
    }
    
    // Search match
    if (searchQuery !== "") {
      const searchMatch = ro.roid.includes(searchQuery) ||
        ro.outlet_name.toLowerCase().includes(searchQuery) ||
        ro.eo_name.toLowerCase().includes(searchQuery) ||
        ro.so_name.toLowerCase().includes(searchQuery) ||
        ro.vendor.toLowerCase().includes(searchQuery) ||
        ro.sales_area.toLowerCase().includes(searchQuery);
      if (!searchMatch) return false;
    }
    return true;
  });


  window.dayMonitoringFilteredList = list;
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 2rem;">No matching offline or partially online outlets.</td></tr>`;
    const pEl = document.getElementById('day-monitoring-pagination');
    if (pEl) pEl.style.display = 'none';
    return;
  }

  // Pagination for Day Monitoring to prevent mobile browser crash
  const DM_PAGE_SIZE = 40;
  let page = window._dmPage || 1;
  const totalPages = Math.max(1, Math.ceil(list.length / DM_PAGE_SIZE));
  if (page > totalPages) page = 1;
  window._dmPage = page;
  const startIdx = (page - 1) * DM_PAGE_SIZE;
  const pagedList = list.slice(startIdx, startIdx + DM_PAGE_SIZE);

  pagedList.forEach(ro => {
    const tr = document.createElement('tr');
    
    // Shared cloud values are preferred; localStorage remains an offline fallback.
    const sharedData = getSharedDayData(ro.roid);
    const localData = JSON.parse(localStorage.getItem('day_remarks_' + ro.roid) || '{}');
    const savedResp = sharedData.responsibility ?? localData.responsibility ?? '';
    const savedRemark = sharedData.remark ?? localData.remark ?? '';
    const savedTargetDate = sharedData.targetDate ?? localData.targetDate ?? '';

    // Create Row Cells
    const tdRoid = document.createElement('td');
    tdRoid.textContent = ro.roid;
    tr.appendChild(tdRoid);

    const tdName = document.createElement('td');
    tdName.textContent = ro.outlet_name;
    tr.appendChild(tdName);

    const tdArea = document.createElement('td');
    tdArea.textContent = ro.sales_area;
    tr.appendChild(tdArea);

    const tdVendor = document.createElement('td');
    tdVendor.textContent = ro.vendor || 'Unmapped';
    tr.appendChild(tdVendor);

    const tdUptime = document.createElement('td');
    tdUptime.textContent = (ro.uptime * 100).toFixed(2) + '%';
    tr.appendChild(tdUptime);

    const tdStatus = document.createElement('td');
    tdStatus.innerHTML = `<span class="status-badge status-${ro.status.toLowerCase().replace(' ', '-')}">${ro.status}</span>`;
    tr.appendChild(tdStatus);

    const tdIot = document.createElement('td');
    tdIot.innerHTML = `<span class="status-badge" style="background-color: var(--card-bg); border: 1px solid var(--border-color); color: var(--text-color); box-shadow: none; font-weight: 700;">${ro.iot_status}</span>`;
    tr.appendChild(tdIot);

    // Responsibility Select
    const tdResp = document.createElement('td');
    const selectResp = document.createElement('select');
    selectResp.className = 'table-select';
    
    const respOptions = ['', 'DEALER', 'BPCL', 'RA VENDOR', 'VENDOR'];
    respOptions.forEach(optVal => {
      const opt = document.createElement('option');
      opt.value = optVal;
      opt.textContent = optVal === '' ? 'Select' : optVal;
      if (optVal === savedResp) {
        opt.selected = true;
      }
      selectResp.appendChild(opt);
    });
    tdResp.appendChild(selectResp);
    tr.appendChild(tdResp);

    // Complaint Remarks Simple Text Input
    const tdRemark = document.createElement('td');
    const inputRemark = document.createElement('input');
    inputRemark.type = 'text';
    inputRemark.className = 'table-input';
    inputRemark.style.width = '180px';
    inputRemark.value = savedRemark;
    inputRemark.placeholder = 'Enter remarks...';
    tdRemark.appendChild(inputRemark);
    tr.appendChild(tdRemark);

    // Target Date Input
    const tdTargetDate = document.createElement('td');
    const inputTargetDate = document.createElement('input');
    inputTargetDate.type = 'date';
    inputTargetDate.className = 'table-input';
    inputTargetDate.style.width = '130px';
    inputTargetDate.value = savedTargetDate;
    tdTargetDate.appendChild(inputTargetDate);
    tr.appendChild(tdTargetDate);

    // Event listener for Responsibility
    selectResp.addEventListener('change', (e) => {
      const newResp = e.target.value;
      const currentRemark = inputRemark.value;
      const targetDt = inputTargetDate.value;
      localStorage.setItem('day_remarks_' + ro.roid, JSON.stringify({
        responsibility: newResp,
        remark: currentRemark,
        targetDate: targetDt
      }));
      saveSharedDayMonitoringRow(ro, newResp, currentRemark, targetDt, true);
    });

    // Event listener for Remarks text input
    inputRemark.addEventListener('change', (e) => {
      const newRemark = e.target.value;
      const currentResp = selectResp.value;
      const targetDt = inputTargetDate.value;
      localStorage.setItem('day_remarks_' + ro.roid, JSON.stringify({
        responsibility: currentResp,
        remark: newRemark,
        targetDate: targetDt
      }));
      saveSharedDayMonitoringRow(ro, currentResp, newRemark, targetDt, true);
    });

    // Event listener for Target Date
    inputTargetDate.addEventListener('change', (e) => {
      const targetDt = e.target.value;
      const currentResp = selectResp.value;
      const currentRemark = inputRemark.value;
      localStorage.setItem('day_remarks_' + ro.roid, JSON.stringify({
        responsibility: currentResp,
        remark: currentRemark,
        targetDate: targetDt
      }));
      saveSharedDayMonitoringRow(ro, currentResp, currentRemark, targetDt, true);
    });

    const tdMpd = document.createElement('td');
    tdMpd.textContent = ro.off_mpd.toFixed(0);
    tr.appendChild(tdMpd);

    const tdTank = document.createElement('td');
    tdTank.textContent = ro.off_tnk.toFixed(0);
    tr.appendChild(tdTank);

    tbody.appendChild(tr);
  });

  // Responsive pagination bar for Day Monitoring
  let paginEl = document.getElementById('day-monitoring-pagination');
  const tableCard = document.querySelector('#tab-day-monitoring .table-card') || (tbody.closest ? tbody.closest('.table-card') : null);
  if (!paginEl && tableCard) {
    paginEl = document.createElement('div');
    paginEl.id = 'day-monitoring-pagination';
    tableCard.appendChild(paginEl);
  }
  if (paginEl) {
    if (totalPages <= 1) {
      paginEl.style.display = 'none';
      paginEl.innerHTML = '';
    } else {
      paginEl.style.display = 'flex';
      paginEl.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px 18px; margin:10px 1.5rem 1rem; background:var(--card-bg, #fff); border-radius:10px; border:1px solid var(--border-color, #e2e8f0); flex-wrap:wrap; gap:10px; font-size:13px;';
      paginEl.innerHTML = `
        <span style="font-weight:600; color:var(--text-muted, #64748b);">
          Showing ${startIdx + 1}–${Math.min(startIdx + DM_PAGE_SIZE, list.length)} of <b>${list.length.toLocaleString()}</b> outlets (Page <b>${page}</b> of <b>${totalPages}</b>)
        </span>
        <div style="display:flex; gap:8px;">
          <button class="btn-secondary" type="button" style="padding:6px 14px; font-weight:700; border-radius:8px; cursor:${page > 1 ? 'pointer' : 'not-allowed'}; opacity:${page > 1 ? '1' : '0.4'};" onclick="window.dmNavPage(-1)">← Previous</button>
          <button class="btn-secondary" type="button" style="padding:6px 14px; font-weight:700; border-radius:8px; cursor:${page < totalPages ? 'pointer' : 'not-allowed'}; opacity:${page < totalPages ? '1' : '0.4'};" onclick="window.dmNavPage(1)">Next →</button>
        </div>
      `;
    }
  }
};

window.dmNavPage = function(delta) {
  const cur = window._dmPage || 1;
  window._dmPage = Math.max(1, cur + delta);
  if (window.renderDayMonitoringTable) window.renderDayMonitoringTable();
  const target = document.getElementById('tab-day-monitoring');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.exportDayMonitoringData = function() {
  const list = window.dayMonitoringFilteredList !== undefined ? window.dayMonitoringFilteredList : calculatedROs.filter(ro => ro.status === "Partially Online" || ro.status === "Offline");

  if (list.length === 0) {
    showToast("No data to export", "error");
    return;
  }

  let csvContent = "data:text/csv;charset=utf-8,";
  const headers = ["ROID", "Retail Outlet", "Sales Area", "Vendor", "Uptime %", "Status", "IOT/WFCC", "Responsibility", "Complaint Remarks", "Target Date", "Offline MPDs", "Offline Tanks"];
  csvContent += headers.map(h => `"${h.replace(/"/g, '""')}"`).join(",") + "\n";

  list.forEach(ro => {
    const sharedData = getSharedDayData(ro.roid);
    const localData = JSON.parse(localStorage.getItem('day_remarks_' + ro.roid) || '{}');
    const resp = sharedData.responsibility ?? localData.responsibility ?? '';
    const remark = sharedData.remark ?? localData.remark ?? '';
    const targetDate = sharedData.targetDate ?? localData.targetDate ?? '';
    
    const rowVals = [
      ro.roid,
      ro.outlet_name,
      ro.sales_area,
      ro.vendor || 'Unmapped',
      (ro.uptime * 100).toFixed(2) + "%",
      ro.status,
      ro.iot_status,
      resp,
      remark,
      targetDate,
      ro.off_mpd.toFixed(0),
      ro.off_tnk.toFixed(0)
    ];

    csvContent += rowVals.map(v => {
      const str = String(v);
      return `"${str.replace(/"/g, '""')}"`;
    }).join(",") + "\n";
  });

  const filename = "Day_Monitoring_Summary.csv";
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("Day Monitoring CSV downloaded successfully!", "success");
};

// Start a live ticking clock showing the current date and time
function startLiveClock() {
  const datetimeEl = document.getElementById('app-datetime');
  if (!datetimeEl) return;
  
  const updateClock = () => {
    const now = new Date();
    const optionsDate = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const dateStr = now.toLocaleDateString('en-US', optionsDate);
    const timeStr = now.toLocaleTimeString('en-US', { hour12: true });
    datetimeEl.textContent = `${dateStr} | ${timeStr}`;
  };
  
  updateClock();
  setInterval(updateClock, 1000);
}

// ==========================================
// EVCS Processing & Chart Routines
// ==========================================
let evcsRatioChartInstance = null;
let evcsEoChartInstance = null;
let evcsSoChartInstance = null;

function processEvcsCalculations() {
  const total = rawDataRows.length;
  const online = rawDataRows.filter(c => c.status.toLowerCase() === 'online').length;
  const offline = rawDataRows.filter(c => c.status.toLowerCase() === 'offline').length;
  
  const fame = rawDataRows.filter(c => c.type.toUpperCase() === 'FAME');
  const fameTotal = fame.length;
  const fameOnline = fame.filter(c => c.status.toLowerCase() === 'online').length;
  const fameOffline = fameTotal - fameOnline;
  
  const nonFame = rawDataRows.filter(c => c.type.toUpperCase() !== 'FAME');
  const nonFameTotal = nonFame.length;
  const nonFameOnline = nonFame.filter(c => c.status.toLowerCase() === 'online').length;
  const nonFameOffline = nonFameTotal - nonFameOnline;
  
  overallMetrics = {
    totalChargers: total,
    onlineChargers: online,
    offlineChargers: offline,
    fameTotal: fameTotal,
    fameOnline: fameOnline,
    fameOffline: fameOffline,
    nonFameTotal: nonFameTotal,
    nonFameOnline: nonFameOnline,
    nonFameOffline: nonFameOffline
  };

  // Group by Territory EO
  const eoGroups = {};
  rawDataRows.forEach(c => {
    const eo = c.territory_eo || "Unmapped";
    if (!eoGroups[eo]) eoGroups[eo] = { online: 0, offline: 0 };
    if (c.status.toLowerCase() === 'online') eoGroups[eo].online++;
    else eoGroups[eo].offline++;
  });
  
  // Group by Sales Officers (mapped BL Code / ROID)
  const soGroups = {};
  rawDataRows.forEach(c => {
    const mapInfo = activeMappings[c.bl_code] || {};
    const so = c.so || mapInfo.so_name || "Unmapped";
    if (!soGroups[so]) soGroups[so] = { online: 0, offline: 0 };
    if (c.status.toLowerCase() === 'online') soGroups[so].online++;
    else soGroups[so].offline++;
  });

  window.evcsEoSummary = Object.keys(eoGroups).map(key => ({
    key: key,
    online: eoGroups[key].online,
    offline: eoGroups[key].offline
  })).sort((a, b) => a.key.localeCompare(b.key));

  window.evcsSoSummary = Object.keys(soGroups).map(key => ({
    key: key,
    online: soGroups[key].online,
    offline: soGroups[key].offline
  })).sort((a, b) => a.key.localeCompare(b.key));
}

function updateEvcsDashboardKPIs() {
  document.getElementById('evcs-kpi-total').textContent = overallMetrics.totalChargers;
  
  const onlinePct = overallMetrics.totalChargers > 0 ? (overallMetrics.onlineChargers / overallMetrics.totalChargers * 100).toFixed(1) : "0.0";
  document.getElementById('evcs-kpi-online').textContent = overallMetrics.onlineChargers;
  document.getElementById('evcs-kpi-online-sub').textContent = `${onlinePct}% of total`;
  
  const offlinePct = overallMetrics.totalChargers > 0 ? (overallMetrics.offlineChargers / overallMetrics.totalChargers * 100).toFixed(1) : "0.0";
  document.getElementById('evcs-kpi-offline').textContent = overallMetrics.offlineChargers;
  document.getElementById('evcs-kpi-offline-sub').textContent = `${offlinePct}% of total`;
  
  document.getElementById('evcs-kpi-fame').textContent = overallMetrics.fameTotal;
  document.getElementById('evcs-kpi-fame-sub').textContent = `${overallMetrics.fameOnline} Online / ${overallMetrics.fameOffline} Offline`;
  
  document.getElementById('evcs-kpi-nonfame').textContent = overallMetrics.nonFameTotal;
  document.getElementById('evcs-kpi-nonfame-sub').textContent = `${overallMetrics.nonFameOnline} Online / ${overallMetrics.nonFameOffline} Offline`;

  // Update header subtitle
  document.getElementById('app-subtitle').textContent = `Total Chargers: ${overallMetrics.totalChargers} | Online: ${overallMetrics.onlineChargers} | Offline: ${overallMetrics.offlineChargers} | Online Ratio: ${onlinePct}%`;
  
  // Update header badge
  document.getElementById('header-outlets-badge').textContent = `${overallMetrics.totalChargers} Chargers`;
}

function updateEvcsOverviewCharts() {
  const greenColor = '#138a4a';
  const redColor = '#c8322b';
  
  // Custom plugins for Neumorphic EVCS layout
  const evcsBarBackgroundPlugin = {
    id: 'evcsBarBackground',
    beforeDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const yScale = chart.scales.y;
      const yMax = yScale.getPixelForValue(yScale.max);
      const yMin = yScale.getPixelForValue(yScale.min);
      const height = yMin - yMax;
      
      ctx.save();
      ctx.fillStyle = '#f1f5f9'; // soft off-white/gray background
      
      chart.data.datasets.forEach((dataset, datasetIdx) => {
        const datasetMeta = chart.getDatasetMeta(datasetIdx);
        if (datasetMeta.hidden) return;
        
        datasetMeta.data.forEach((bar) => {
          const x = bar.x - bar.width / 2;
          const width = bar.width;
          const radius = width / 2;
          
          ctx.beginPath();
          ctx.roundRect(x, yMax, width, height, radius);
          ctx.fill();
        });
      });
      ctx.restore();
    }
  };

  const evcsCircleLabelPlugin = {
    id: 'evcsCircleLabels',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      chart.data.datasets.forEach((dataset, datasetIdx) => {
        const datasetMeta = chart.getDatasetMeta(datasetIdx);
        if (datasetMeta.hidden) return;
        
        datasetMeta.data.forEach((bar, index) => {
          const value = dataset.data[index];
          if (value === undefined || value === null || value === 0) return;
          
          // Draw white circle centered at the top of the bar
          const radius = 9; 
          const x = bar.x;
          const y = bar.y; 
          
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = dataset.backgroundColor; 
          ctx.lineWidth = 2;
          ctx.stroke();
          
          // Draw value text inside circle
          ctx.fillStyle = '#0f172a';
          ctx.font = 'bold 9px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(value, x, y);
          ctx.restore();
        });
      });
    }
  };

  // 1. Doughnut: Overall Online Ratio
  const ratioCtx = document.getElementById('evcs-ratio-chart').getContext('2d');
  if (evcsRatioChartInstance) evcsRatioChartInstance.destroy();
  
  evcsRatioChartInstance = new Chart(ratioCtx, {
    type: 'doughnut',
    data: {
      labels: ['Online', 'Offline'],
      datasets: [{
        data: [overallMetrics.onlineChargers, overallMetrics.offlineChargers],
        backgroundColor: [greenColor, redColor],
        borderWidth: 2,
        borderColor: '#ffffff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { family: 'Inter', size: 11, weight: '600' } }
        }
      },
      cutout: '70%'
    }
  });

  // 2. Bar Chart: Territory EO
  const eoCtx = document.getElementById('evcs-eo-chart').getContext('2d');
  if (evcsEoChartInstance) evcsEoChartInstance.destroy();
  
  const eoLabels = window.evcsEoSummary.map(s => s.key);
  const eoOnlineData = window.evcsEoSummary.map(s => s.online);
  const eoOfflineData = window.evcsEoSummary.map(s => s.offline);
  
  evcsEoChartInstance = new Chart(eoCtx, {
    type: 'bar',
    plugins: [evcsBarBackgroundPlugin, evcsCircleLabelPlugin],
    data: {
      labels: eoLabels,
      datasets: [
        {
          label: 'Online',
          data: eoOnlineData,
          backgroundColor: greenColor,
          borderRadius: 20,
          borderSkipped: false
        },
        {
          label: 'Offline',
          data: eoOfflineData,
          backgroundColor: redColor,
          borderRadius: 20,
          borderSkipped: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top' }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 45, minRotation: 45 }
        },
        y: {
          beginAtZero: true,
          max: 25,
          ticks: { stepSize: 5 }
        }
      }
    }
  });

  // 3. Bar Chart: Sales Officers
  const soCtx = document.getElementById('evcs-so-chart').getContext('2d');
  if (evcsSoChartInstance) evcsSoChartInstance.destroy();
  
  const soLabels = window.evcsSoSummary.map(s => s.key);
  const soOnlineData = window.evcsSoSummary.map(s => s.online);
  const soOfflineData = window.evcsSoSummary.map(s => s.offline);
  
  evcsSoChartInstance = new Chart(soCtx, {
    type: 'bar',
    plugins: [evcsBarBackgroundPlugin, evcsCircleLabelPlugin],
    data: {
      labels: soLabels,
      datasets: [
        {
          label: 'Online',
          data: soOnlineData,
          backgroundColor: greenColor,
          borderRadius: 20,
          borderSkipped: false
        },
        {
          label: 'Offline',
          data: soOfflineData,
          backgroundColor: redColor,
          borderRadius: 20,
          borderSkipped: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top' }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 45, minRotation: 45 }
        },
        y: {
          beginAtZero: true,
          max: 20,
          ticks: { stepSize: 2 }
        }
      }
    }
  });
}

window.openEvcsDetailsModal = function(type) {
  const modal = document.getElementById('kpi-details-modal');
  const titleEl = document.getElementById('modal-title');
  const headersEl = document.getElementById('modal-table-headers');
  const bodyEl = document.getElementById('modal-table-body');
  
  if (!modal || !titleEl || !headersEl || !bodyEl) return;
  
  headersEl.innerHTML = '';
  bodyEl.innerHTML = '';
  
  let list = [];
  let headers = ["S.No", "Station Name", "BL Code", "OCPP ID", "Territory TE", "Power Rating", "City", "Type", "Status"];
  let title = '';
  
  if (type === 'total') {
    title = 'Total EVCS Chargers';
    list = rawDataRows;
  } else if (type === 'online') {
    title = 'Online EVCS Chargers';
    list = rawDataRows.filter(c => c.status.toLowerCase() === 'online');
  } else if (type === 'offline') {
    title = 'Offline EVCS Chargers';
    list = rawDataRows.filter(c => c.status.toLowerCase() === 'offline');
  } else if (type === 'fame') {
    title = 'FAME EVCS Chargers';
    list = rawDataRows.filter(c => c.type.toUpperCase() === 'FAME');
  } else if (type === 'nonfame') {
    title = 'Non FAME EVCS Chargers';
    list = rawDataRows.filter(c => c.type.toUpperCase() !== 'FAME');
  }
  
  activeModalData = list;
  activeModalType = 'evcs_' + type;
  titleEl.textContent = `${title} (${list.length} Chargers)`;
  
  headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    headersEl.appendChild(th);
  });
  
  if (list.length === 0) {
    bodyEl.innerHTML = `<tr><td colspan="${headers.length}" style="text-align: center; padding: 2rem;">No matching chargers found.</td></tr>`;
  } else {
    list.forEach(c => {
      const tr = document.createElement('tr');
      const cols = [
        c.s_no,
        c.station_name,
        c.bl_code,
        c.ocpp_id,
        c.territory_eo,
        c.power_rating,
        c.city,
        c.type,
        `<span class="status-badge status-${c.status.toLowerCase()}">${c.status}</span>`
      ];
      tr.innerHTML = cols.map(colVal => `<td>${colVal}</td>`).join('');
      bodyEl.appendChild(tr);
    });
  }
  
  modal.style.display = 'flex';
};

window.populateDayMonitoringHeaderFilters = function() {
  const list = calculatedROs.filter(ro => ro.status === "Partially Online" || ro.status === "Offline");
  
  // 1. Sales Area
  const areaSelect = document.getElementById('day-filter-area');
  if (areaSelect) {
    const currentVal = areaSelect.value;
    const areas = [...new Set(list.map(ro => ro.sales_area))].filter(Boolean).sort();
    areaSelect.innerHTML = '<option value="">All</option>';
    areas.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a.replace(' Retail', '').replace('-retail', '');
      areaSelect.appendChild(opt);
    });
    areaSelect.value = currentVal;
  }
  
  // 2. Vendor
  const vendorSelect = document.getElementById('day-filter-vendor');
  if (vendorSelect) {
    const currentVal = vendorSelect.value;
    const vendors = [...new Set(list.map(ro => ro.vendor))].filter(Boolean).sort();
    vendorSelect.innerHTML = '<option value="">All</option>';
    vendors.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      vendorSelect.appendChild(opt);
    });
    vendorSelect.value = currentVal;
  }
};

// Init Login & RBAC Access Control
window.currentUser = null;

window.initLogin = function() {
  const loginOverlay = document.getElementById('login-overlay');
  const loginForm = document.getElementById('login-form');
  const roleSelect = document.getElementById('login-role');
  const usernameGroup = document.getElementById('login-username-group');
  const usernameSelect = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorMsg = document.getElementById('login-error-msg');
  const profileWidget = document.getElementById('user-profile-widget');
  const profileBadge = document.getElementById('user-profile-badge');
  const profileName = document.getElementById('user-profile-name');
  const logoutBtn = document.getElementById('btn-logout');
  
  if (!loginOverlay || !loginForm) return;
  
  const populateUsernamesForRole = (role) => {
    usernameSelect.innerHTML = '';
    
    let names = [];
    if (role === 'so') {
      names = ['Vinit S', 'Jaydip C', 'Spandan P', 'Muthukuma M', 'Saigiridhar K'];
    } else if (role === 'eo') {
      names = ['Vasa Nagamallik', 'Sourabh Paul', 'Bhupesh Bajiya'];
    } else if (role === 'vendor') {
      names = ['GEMS', 'ORPAK', 'PINELABS', 'RELCON'];
    }
    
    if (names.length > 0) {
      usernameGroup.style.display = 'block';
      usernameSelect.required = true;
      names.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        usernameSelect.appendChild(opt);
      });
    } else {
      usernameGroup.style.display = 'none';
      usernameSelect.required = false;
    }
  };
  
  roleSelect.addEventListener('change', (e) => {
    populateUsernamesForRole(e.target.value);
  });
  
  // Try loading active session
  const savedUser = localStorage.getItem('bpcl_dashboard_user');
  if (savedUser) {
    window.currentUser = JSON.parse(savedUser);
    loginOverlay.style.display = 'none';
    
    // Update profile header widget
    if (profileBadge) {
      profileBadge.textContent = window.currentUser.role.toUpperCase();
      profileBadge.className = `user-badge role-${window.currentUser.role}`;
    }
    if (profileName) profileName.textContent = window.currentUser.username;
    if (profileWidget) profileWidget.style.display = 'flex';
  } else {
    loginOverlay.style.display = 'flex';
    if (profileWidget) profileWidget.style.display = 'flex';
    populateUsernamesForRole('admin');
  }
  
  // Form submit handler
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    errorMsg.style.display = 'none';
    
    const role = roleSelect.value;
    let username = '';
    
    if (role === 'admin') username = 'Administrator';
    else if (role === 'tm') username = 'Territory Manager';
    else username = usernameSelect.value;
    
    const password = passwordInput.value;
    
    if (password !== 'password') {
      errorMsg.textContent = 'Invalid password. Please enter "password".';
      errorMsg.style.display = 'block';
      return;
    }
    
    const userSession = { role, username };
    localStorage.setItem('bpcl_dashboard_user', JSON.stringify(userSession));
    window.currentUser = userSession;
    
    // Reset login form fields
    passwordInput.value = '';
    loginOverlay.style.display = 'none';
    
    // Update profile widget
    if (profileBadge) {
      profileBadge.textContent = role.toUpperCase();
      profileBadge.className = `user-badge role-${role}`;
    }
    if (profileName) profileName.textContent = username;
    if (profileWidget) profileWidget.style.display = 'flex';
    
    // Reload dashboard to apply scoping if data exists
    if (window.rawDataRows && window.rawDataRows.length > 0) {
      recalculateAndRefresh();
    }
  });
  
  // Logout handler
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('bpcl_dashboard_user');
    window.currentUser = null;
    calculatedROs.length = 0;
    
    loginOverlay.style.display = 'flex';
    profileWidget.style.display = 'none';
    
    roleSelect.value = 'admin';
    populateUsernamesForRole('admin');
    passwordInput.value = '';
    
    window.location.reload();
  });
};

// Start login logic on DOM ready
window.addEventListener('DOMContentLoaded', () => {
  window.initLogin();
});

// Monitoring Comparison Tab Logic
window.renderMonitoringComparison = async function() {
  const tbody = document.getElementById('monitoring-comparison-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  if (!window.calculatedROs || window.calculatedROs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 2rem;">No current active data loaded. Please upload a spreadsheet or load sample data.</td></tr>`;
    return;
  }
  
  if (!DB.db) {
    await DB.open();
  }
  
  let records = await DB.getAllRecords();
  if (records.length === 0) {
    if (typeof seedMockHistory === 'function') {
      await seedMockHistory();
      records = await DB.getAllRecords();
    }
  }
  
  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 2rem;">No historical uploads in database to compare against. Please upload files to build history.</td></tr>`;
    return;
  }
  
  // Sort history descending by timestamp
  const sortedHistory = [...records].sort((a, b) => b.timestamp - a.timestamp);
  
  // Dynamically populate baseline selector dropdown
  const selectEl = document.getElementById('mon-baseline-select');
  if (selectEl) {
    const currentSelected = selectEl.value;
    selectEl.innerHTML = '';
    
    sortedHistory.forEach(rec => {
      const opt = document.createElement('option');
      opt.value = rec.id;
      opt.textContent = `${rec.date} ${rec.time} (${rec.filename.substring(0, 30)}...)`;
      selectEl.appendChild(opt);
    });
    
    if (currentSelected && selectEl.querySelector(`option[value="${currentSelected}"]`)) {
      selectEl.value = currentSelected;
    } else {
      // Find closest to 10 PM yesterday relative to the active upload date
      const activeRecord = sortedHistory[0];
      const activeDate = new Date(activeRecord.timestamp);
      const yesterday = new Date(activeDate.getTime() - 24 * 60 * 60 * 1000);
      // Local date (toISOString would give the UTC date and pick the wrong day after midnight IST)
      const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
      
      const yesterdayRecs = sortedHistory.filter(r => r.date === yesterdayStr);
      let autoRec = null;
      if (yesterdayRecs.length > 0) {
        let minDiff = Infinity;
        yesterdayRecs.forEach(r => {
          const parts = r.time.split(':');
          const hr = parseInt(parts[0]);
          const mn = parseInt(parts[1]);
          const diff = Math.abs((hr * 60 + mn) - (22 * 60)); // diff from 10 PM (22:00)
          if (diff < minDiff) {
            minDiff = diff;
            autoRec = r;
          }
        });
      }
      
      if (!autoRec) {
        autoRec = sortedHistory[1] || sortedHistory[0];
      }
      
      selectEl.value = autoRec.id;
    }
  }

  // Dynamically populate header filter options (Sales Area and Vendor)
  const monAreaSelect = document.getElementById('mon-filter-area-select');
  if (monAreaSelect) {
    const currentVal = monAreaSelect.value;
    const areas = [...new Set(calculatedROs.map(ro => ro.sales_area))].filter(Boolean).sort();
    monAreaSelect.innerHTML = '<option value="">All</option>';
    areas.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a.replace(' Retail', '').replace('-retail', '');
      monAreaSelect.appendChild(opt);
    });
    monAreaSelect.value = currentVal;
  }

  const monVendorSelect = document.getElementById('mon-filter-vendor-select');
  if (monVendorSelect) {
    const currentVal = monVendorSelect.value;
    const vendors = [...new Set(calculatedROs.map(ro => ro.vendor))].filter(Boolean).sort();
    monVendorSelect.innerHTML = '<option value="">All</option>';
    vendors.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      monVendorSelect.appendChild(opt);
    });
    monVendorSelect.value = currentVal;
  }

  const monMstSelect = document.getElementById('mon-filter-mst-select');
  if (monMstSelect) {
    const currentVal = monMstSelect.value;
    const msts = [...new Set(calculatedROs.map(ro => ro.mst_name))].filter(Boolean).sort();
    monMstSelect.innerHTML = '<option value="">All</option>';
    msts.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      monMstSelect.appendChild(opt);
    });
    monMstSelect.value = currentVal;
  }
  
  // Get active baseline record
  const baselineId = parseInt(selectEl.value);
  const baselineRecord = records.find(r => r.id === baselineId);
  if (!baselineRecord) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 2rem;">Selected baseline record could not be found.</td></tr>`;
    return;
  }
  
  // Show baseline info
  const infoEl = document.getElementById('mon-baseline-info');
  if (infoEl) {
    infoEl.innerHTML = `Comparing current data against: <strong style="color: var(--accent-color);">${baselineRecord.date} ${baselineRecord.time}</strong> (${baselineRecord.filename})`;
  }
  
  // Helper to compute status for baseline objects
  const calculateRoStatus = (item) => {
    const onbMpd = parseInt(item.onb_mpd) || 0;
    const onlMpd = parseInt(item.onl_mpd) || 0;
    const onbTnk = parseInt(item.onb_tnk) || 0;
    const onlTnk = parseInt(item.onl_tnk) || 0;
    
    let mpdCond = "Offline";
    if (onbMpd > 0) {
      if (onlMpd === 0) mpdCond = "Offline";
      else if (onlMpd < onbMpd) mpdCond = "Partially MPD";
      else mpdCond = "Fully online";
    }
    
    let tnkCond = "Offline";
    if (onbTnk > 0) {
      if (onlTnk === 0) tnkCond = "Offline";
      else if (onlTnk < onbTnk) tnkCond = "Partially ATG";
      else tnkCond = "Fully online";
    }
    
    const combo = `${mpdCond}, ${tnkCond}`;
    const NANO_MAP = {
      "Fully online, Fully online": "Fully Online",
      "Offline, Fully online": "No MPD Communicated",
      "Partially MPD, Fully online": "Partially Communicated MPD",
      "Fully online, Partially ATG": "Partially Communicated ATG",
      "Fully online, Offline": "No ATG Communicated",
      "Partially MPD, Offline": "Partially Online",
      "Offline, Offline": "Offline",
      "Partially MPD, Partially ATG": "Partially Online",
      "Offline, Partially ATG": "Partially Online"
    };
    return NANO_MAP[combo] || "Offline";
  };

  // Build status map for baseline
  const baselineStatusMap = {};
  if (baselineRecord.rawData) {
    const rows = baselineRecord.rawData;
    if (rows.length > 0) {
      const firstRow = rows[0];
      if (typeof firstRow === 'object' && !Array.isArray(firstRow)) {
        // Handle list of objects (pre-seeded mock history)
        rows.forEach(item => {
          if (item && item.roid) {
            baselineStatusMap[item.roid] = item.status || calculateRoStatus(item);
          }
        });
      } else {
        // Handle list of arrays (Excel uploaded rows)
        let headerRowIdx = -1;
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          if (rows[i] && Array.isArray(rows[i]) && rows[i].some(cell => {
            const s = String(cell).toLowerCase();
            return s.includes('ocpp id') || s.includes('roid') || s === 'ro id';
          })) {
            headerRowIdx = i;
            break;
          }
        }
        
        if (headerRowIdx !== -1) {
          const headers = rows[headerRowIdx].map(h => String(h).toLowerCase().trim());
          const roidCol = headers.findIndex(h => h === 'roid' || h === 'ro id' || h === 'ro_id' || h === 'bl code' || h.includes('bl_code'));
          const statusCol = headers.findIndex(h => h === 'status' || h === 'uptime status');
          
          const onbMpdCol = headers.indexOf('no. of on');
          const onlMpdCol = headers.indexOf('no. of onl');
          const onbTnkCol = headers.lastIndexOf('no. of on');
          const onlTnkCol = headers.lastIndexOf('no. of onl');
          
          for (let r = headerRowIdx + 1; r < rows.length; r++) {
            const row = rows[r];
            if (!row || row.length < 2) continue;
            const roid = String(row[roidCol] || '').trim();
            if (!roid) continue;
            
            let statusVal = "Offline";
            if (statusCol !== -1 && row[statusCol]) {
              statusVal = String(row[statusCol]).trim();
            } else if (onbMpdCol !== -1 && onlMpdCol !== -1) {
              const onbMpd = parseInt(row[onbMpdCol]) || 0;
              const onlMpd = parseInt(row[onlMpdCol]) || 0;
              const onbTnk = parseInt(row[onbTnkCol]) || 0;
              const onlTnk = parseInt(row[onlTnkCol]) || 0;
              
              let mpdCond = "Offline";
              if (onbMpd > 0) {
                if (onlMpd === 0) mpdCond = "Offline";
                else if (onlMpd < onbMpd) mpdCond = "Partially MPD";
                else mpdCond = "Fully online";
              }
              
              let tnkCond = "Offline";
              if (onbTnk > 0) {
                if (onlTnk === 0) tnkCond = "Offline";
                else if (onlTnk < onbTnk) tnkCond = "Partially ATG";
                else tnkCond = "Fully online";
              }
              
              const combo = `${mpdCond}, ${tnkCond}`;
              const NANO_MAP = {
                "Fully online, Fully online": "Fully Online",
                "Offline, Fully online": "No MPD Communicated",
                "Partially MPD, Fully online": "Partially Communicated MPD",
                "Fully online, Partially ATG": "Partially Communicated ATG",
                "Fully online, Offline": "No ATG Communicated",
                "Partially MPD, Offline": "Partially Online",
                "Offline, Offline": "Offline",
                "Partially MPD, Partially ATG": "Partially Online",
                "Offline, Partially ATG": "Partially Online"
              };
              statusVal = NANO_MAP[combo] || "Offline";
            }
            baselineStatusMap[roid] = statusVal;
          }
        }
      }
    }
  }
  
  // Get active filters and search queries
  let activeFilter = 'drops';
  ['mon-filter-all', 'mon-filter-drops', 'mon-filter-upgrades', 'mon-filter-changes'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.classList.contains('active')) {
      activeFilter = id.replace('mon-filter-', '');
    }
  });
  
  const searchVal = (document.getElementById('mon-search-input').value || '').toLowerCase().trim();
  
  // Header filter values
  const filterMonArea = MS.vals('mon-filter-area-select');
  const filterMonVendor = MS.vals('mon-filter-vendor-select');
  const filterMonMst = MS.vals('mon-filter-mst-select');
  const filterMonBaseStatus = MS.vals('mon-filter-base-status');
  const filterMonCurrStatus = MS.vals('mon-filter-curr-status');
  const filterMonChangeStatus = MS.vals('mon-filter-change-status');
  // "Partially Online" also covers the partial NANO variants (Partially Communicated MPD etc.)
  const monStatusIn = (wanted, st) => !wanted.length || wanted.some(w => st === w || (w === 'Partially Online' && st !== 'Fully Online' && st !== 'Offline'));

  const compareList = calculatedROs.filter(ro => {
    const baseStatus = baselineStatusMap[ro.roid] || 'Offline';
    const currStatus = ro.status;
    
    const getRank = (st) => {
      if (st === "Fully Online") return 3;
      if (st === "Partially Online" || st.includes("Partially") || st.includes("Communicated") || st.includes("No MPD")) return 2;
      return 1;
    };
    const baseRank = getRank(baseStatus);
    const currRank = getRank(currStatus);
    
    // 1. Column header filters
    if (!MS.ok(filterMonArea, ro.sales_area)) return false;
    if (!MS.ok(filterMonVendor, ro.vendor)) return false;
    if (!MS.ok(filterMonMst, ro.mst_name)) return false;
    if (!monStatusIn(filterMonBaseStatus, baseStatus)) return false;
    if (!monStatusIn(filterMonCurrStatus, currStatus)) return false;
    
    if (filterMonChangeStatus.length) {
      let changeType = "Unchanged";
      if (currRank < baseRank) changeType = "Drop";
      else if (currRank > baseRank) changeType = "Improvement";
      if (!MS.ok(filterMonChangeStatus, changeType)) return false;
    }
    
    // 2. Global pill filters
    let matchesFilter = false;
    if (activeFilter === 'all') {
      matchesFilter = true;
    } else if (activeFilter === 'changes') {
      matchesFilter = (baseStatus !== currStatus);
    } else if (activeFilter === 'drops') {
      matchesFilter = (currRank < baseRank);
    } else if (activeFilter === 'upgrades') {
      matchesFilter = (currRank > baseRank);
    }
    
    if (!matchesFilter) return false;
    
    // 3. Search query match
    if (searchVal !== '') {
      return ro.roid.includes(searchVal) ||
             ro.outlet_name.toLowerCase().includes(searchVal) ||
             ro.sales_area.toLowerCase().includes(searchVal) ||
             ro.vendor.toLowerCase().includes(searchVal) ||
             ro.mst_name.toLowerCase().includes(searchVal);
    }
    return true;
  });
  
  if (compareList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 2rem;">No matching status changes found.</td></tr>`;
    const pEl = document.getElementById('mon-comparison-pagination');
    if (pEl) pEl.style.display = 'none';
    return;
  }
  
  // Ensure comparison list is sorted sales area wise, then RO code
  if (typeof compareBySalesArea === 'function') compareList.sort(compareBySalesArea);
  
  // Pagination for Monitoring Comparison to prevent mobile browser crash
  const MON_PAGE_SIZE = 40;
  let monPage = window._monPage || 1;
  const totalMonPages = Math.max(1, Math.ceil(compareList.length / MON_PAGE_SIZE));
  if (monPage > totalMonPages) monPage = 1;
  window._monPage = monPage;
  const monStartIdx = (monPage - 1) * MON_PAGE_SIZE;
  const pagedCompareList = compareList.slice(monStartIdx, monStartIdx + MON_PAGE_SIZE);

  pagedCompareList.forEach(ro => {
    const baseStatus = baselineStatusMap[ro.roid] || 'Offline';
    const currStatus = ro.status;
    
    const getRank = (st) => {
      if (st === "Fully Online") return 3;
      if (st === "Partially Online" || st.includes("Partially") || st.includes("Communicated") || st.includes("No MPD")) return 2;
      return 1;
    };
    const baseRank = getRank(baseStatus);
    const currRank = getRank(currStatus);
    
    let changeHtml = '';
    if (currRank < baseRank) {
      changeHtml = `<span style="color: var(--accent-red); font-weight: 800; display: inline-flex; align-items: center; gap: 0.25rem;">🔴 ⬇️ Drop</span>`;
    } else if (currRank > baseRank) {
      changeHtml = `<span style="color: var(--accent-green); font-weight: 800; display: inline-flex; align-items: center; gap: 0.25rem;">🟢 ⬆️ Improvement</span>`;
    } else {
      changeHtml = `<span style="color: var(--text-muted); font-weight: 600;">⎌ Unchanged</span>`;
    }
    
    const offMpdVal = ro.off_mpd !== undefined ? ro.off_mpd.toFixed(0) : "0";
    const offTnkVal = ro.off_tnk !== undefined ? ro.off_tnk.toFixed(0) : "0";

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ro.roid}</td>
      <td>${ro.outlet_name}</td>
      <td>${ro.sales_area}</td>
      <td>${ro.vendor}</td>
      <td>${ro.mst_name}</td>
      <td><span class="status-badge status-${baseStatus.toLowerCase().replace(/ /g, '-')}">${baseStatus}</span></td>
      <td><span class="status-badge status-${currStatus.toLowerCase().replace(/ /g, '-')}">${currStatus}</span></td>
      <td style="text-align: center;">${changeHtml}</td>
      <td style="text-align: center; font-weight: 700; color: ${ro.off_mpd > 0 ? 'var(--accent-red)' : 'var(--text-muted)'};">${offMpdVal}</td>
      <td style="text-align: center; font-weight: 700; color: ${ro.off_tnk > 0 ? 'var(--accent-red)' : 'var(--text-muted)'};">${offTnkVal}</td>
      <td style="text-align: center;">${window.WhatsAppAlerts ? window.WhatsAppAlerts.cellHtml(ro, baseStatus) : ''}</td>
    `;
    tbody.appendChild(tr);
  });

  // Responsive pagination bar for Monitoring Comparison
  let monPaginEl = document.getElementById('mon-comparison-pagination');
  const monTableCard = document.querySelector('#tab-monitoring .table-card') || (tbody.closest ? tbody.closest('.table-card') : null);
  if (!monPaginEl && monTableCard) {
    monPaginEl = document.createElement('div');
    monPaginEl.id = 'mon-comparison-pagination';
    monTableCard.appendChild(monPaginEl);
  }
  if (monPaginEl) {
    if (totalMonPages <= 1) {
      monPaginEl.style.display = 'none';
      monPaginEl.innerHTML = '';
    } else {
      monPaginEl.style.display = 'flex';
      monPaginEl.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px 18px; margin:10px 1.5rem 1rem; background:var(--card-bg, #fff); border-radius:10px; border:1px solid var(--border-color, #e2e8f0); flex-wrap:wrap; gap:10px; font-size:13px;';
      monPaginEl.innerHTML = `
        <span style="font-weight:600; color:var(--text-muted, #64748b);">
          Showing ${monStartIdx + 1}–${Math.min(monStartIdx + MON_PAGE_SIZE, compareList.length)} of <b>${compareList.length.toLocaleString()}</b> outlets (Page <b>${monPage}</b> of <b>${totalMonPages}</b>)
        </span>
        <div style="display:flex; gap:8px;">
          <button class="btn-secondary" type="button" style="padding:6px 14px; font-weight:700; border-radius:8px; cursor:${monPage > 1 ? 'pointer' : 'not-allowed'}; opacity:${monPage > 1 ? '1' : '0.4'};" onclick="window.monNavPage(-1)">← Previous</button>
          <button class="btn-secondary" type="button" style="padding:6px 14px; font-weight:700; border-radius:8px; cursor:${monPage < totalMonPages ? 'pointer' : 'not-allowed'}; opacity:${monPage < totalMonPages ? '1' : '0.4'};" onclick="window.monNavPage(1)">Next →</button>
        </div>
      `;
    }
  }
};

window.monNavPage = function(delta) {
  const cur = window._monPage || 1;
  window._monPage = Math.max(1, cur + delta);
  if (window.renderMonitoringComparison) window.renderMonitoringComparison();
  const target = document.getElementById('tab-monitoring');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.setupMonitoringListeners = function() {
  const selectEl = document.getElementById('mon-baseline-select');
  if (selectEl) {
    selectEl.addEventListener('change', () => {
      window.renderMonitoringComparison();
    });
  }
  
  const searchInput = document.getElementById('mon-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      window.renderMonitoringComparison();
    });
  }

  // Bind change events to column header dropdown filters
  const headerFilters = ['mon-filter-area-select', 'mon-filter-vendor-select', 'mon-filter-mst-select', 'mon-filter-base-status', 'mon-filter-curr-status', 'mon-filter-change-status'];
  headerFilters.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        window.renderMonitoringComparison();
      });
    }
  });
  
  const pills = ['mon-filter-all', 'mon-filter-drops', 'mon-filter-upgrades', 'mon-filter-changes'];
  pills.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', () => {
        pills.forEach(pId => {
          const pill = document.getElementById(pId);
          if (pill) pill.classList.remove('active');
        });
        el.classList.add('active');
        window.renderMonitoringComparison();
      });
    }
  });
  
  const btnExport = document.getElementById('export-monitoring-btn');
  if (btnExport) {
    btnExport.addEventListener('click', () => {
      const tbody = document.getElementById('monitoring-comparison-tbody');
      if (!tbody || tbody.rows.length === 0 || tbody.rows[0].cells.length < 8) {
        showToast("No comparison data to export", "error");
        return;
      }
      
      let csvContent = "data:text/csv;charset=utf-8,";
      csvContent += "ROID,Retail Outlet,Sales Area,Vendor,MST,Yesterday Status,Current Status,Change Status,Offline MPDs,Offline Tanks\n";
      
      const rows = tbody.querySelectorAll('tr');
      rows.forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 10) return;
        const roid = cells[0].textContent;
        const name = `"${cells[1].textContent.replace(/"/g, '""')}"`;
        const area = `"${cells[2].textContent.replace(/"/g, '""')}"`;
        const vendor = cells[3].textContent;
        const mst = `"${cells[4].textContent.replace(/"/g, '""')}"`;
        const baseStatus = cells[5].textContent;
        const currStatus = cells[6].textContent;
        const changeStatus = cells[7].textContent.replace(/🔴|⬇️|🟢|⬆️/g, '').trim();
        const offMpd = cells[8].textContent.trim();
        const offTnk = cells[9].textContent.trim();
        
        csvContent += `${roid},${name},${area},${vendor},${mst},${baseStatus},${currStatus},${changeStatus},${offMpd},${offTnk}\n`;
      });
      
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `Monitoring_Comparison_${new Date().toISOString().substring(0, 10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }
};

// Sync live day monitoring data from Google Sheet
// --------------------------------------------------------------------------
// Google Sheet sync — one workbook feeds the whole app:
//   Sheet 1  uptime monitoring ("Raw Data")        → every automation menu
//   + "Last updated stock" / "Stock hourly" / "Onboarded tanks" → RO-Wise Tank Stock
//   + optional "TE-SO Map" and "HistoryArchive"
// The workbook is read in a background worker (no page freeze). If the sheet has
// not changed since the last sync, nothing is re-processed.
// --------------------------------------------------------------------------
window.__sheetSync = { fp: null, at: 0, busy: null, tankFound: false };

function resolveSheetExportUrl() {
  const OFFICIAL_URL = 'https://docs.google.com/spreadsheets/d/14KDPhrCgKmZzLKNzSdS6YtPIeXdDtlXPbbPWMVxFA5I/export?format=xlsx';
  let configuredUrl = localStorage.getItem('bpcl_google_sheet_url');
  if (!configuredUrl || configuredUrl.includes('2PACX-1vS3EE_SNele4ucfWLc38wDtMaSB18jj2OgCw')) {
    configuredUrl = OFFICIAL_URL;
    localStorage.setItem('bpcl_google_sheet_url', OFFICIAL_URL);
  }
  let targetUrl = configuredUrl.trim();
  if (targetUrl.includes('docs.google.com/spreadsheets') && !targetUrl.includes('/export') && !targetUrl.includes('/pub')) {
    if (targetUrl.includes('/edit')) {
      targetUrl = targetUrl.replace(/\/edit.*$/, '/export?format=xlsx');
    } else {
      if (!targetUrl.endsWith('/')) targetUrl += '/';
      targetUrl += 'export?format=xlsx';
    }
  } else if (targetUrl.includes('pub?output=csv')) {
    targetUrl = targetUrl.replace('pub?output=csv', 'pub?output=xlsx');
  }
  return targetUrl;
}
window.resolveSheetExportUrl = resolveSheetExportUrl;

function pickUptimeSheet(book) {
  const candidates = book.sheets.filter(s => s.kind === 'other');
  const exact = candidates.find(s => s.name.trim().toLowerCase() === 'raw data');
  if (exact) return exact.name;
  const named = candidates.find(s => /raw|uptime|automation/i.test(s.name));
  if (named) return named.name;
  const generic = candidates.find(s => /charger|list|data|status/i.test(s.name));
  if (generic) return generic.name;
  return candidates.length ? candidates[0].name : null; // Sheet 1 = uptime monitoring
}

async function importHistoryArchive(aoa) {
  const rows = WorkbookReader.aoaToObjects(aoa);
  if (!rows.length) return 0;
  if (!DB.db) await DB.open();
  const existing = new Set((await DB.getAllRecords()).map(r => r.id));
  let added = 0;
  for (const row of rows) {
    const idVal = parseInt(row.ID || row.id || row.Timestamp || row.timestamp);
    if (isNaN(idVal) || existing.has(idVal)) continue; // never overwrite a full local snapshot
    let metricsVal = {}, statusMapVal = {};
    try { metricsVal = typeof row.MetricsJSON === 'string' ? JSON.parse(row.MetricsJSON) : (row.MetricsJSON || {}); } catch (e) { /* ignore */ }
    try { statusMapVal = typeof row.StatusMapJSON === 'string' ? JSON.parse(row.StatusMapJSON) : (row.StatusMapJSON || {}); } catch (e) { /* ignore */ }
    const rawDataList = Object.keys(statusMapVal).map(roid => ({ roid, status: statusMapVal[roid] }));
    await DB.saveRecord({
      id: idVal, timestamp: idVal,
      date: String(row.Date || row.date || ''),
      time: String(row.Time || row.time || ''),
      filename: String(row.Filename || row.filename || ''),
      metrics: metricsVal, rawData: rawDataList,
      googleDriveFileId: String(row.GoogleDriveFileId || row.googledrivefileid || '')
    });
    added++;
  }
  return added;
}

function rowsFingerprint(rows) {
  const str = JSON.stringify(rows);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return str.length + ':' + (h >>> 0).toString(16);
}

window.syncGoogleSheet = async function(silent = false, opts = {}) {
  // one sync at a time: a second click joins the running one
  if (window.__sheetSync.busy) return window.__sheetSync.busy;
  const run = (async () => {
    if (!silent) showToast("Fetching the latest data from Google Sheet…", "info");
    const btns = [document.getElementById('btn-sync-sheet'), document.getElementById('tsSyncBtn')].filter(Boolean);
    btns.forEach(b => b.classList.add('is-syncing'));
    try {
      const targetUrl = resolveSheetExportUrl();
      const response = await fetch(targetUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to fetch Google Sheet (${response.status}). Please make sure you published to web, or shared as "Anyone with the link can view".`);
      }
      const arrayBuffer = await response.arrayBuffer();

      // Unchanged sheet → nothing to do (keeps auto-refresh cheap)
      const fp = WorkbookReader.fingerprint(arrayBuffer);
      const haveData = Array.isArray(window.rawDataRows) && window.rawDataRows.length > 0;
      if (!opts.force && fp === window.__sheetSync.fp && haveData) {
        window.__sheetSync.at = Date.now();
        if (window.DataFreshness) DataFreshness.sheetChecked();
        if (window.TankStock) window.TankStock.markSynced(window.__sheetSync.at, window.__sheetSync.tankFound);
        if (!silent) showToast('Already up to date — no changes in the Google Sheet since the last sync.', 'success');
        return;
      }

      // Two-stage read: uptime first (fast), tank sheets afterwards in the background
      let firstReady;
      const first = new Promise(r => { firstReady = r; });
      const all = WorkbookReader.read(arrayBuffer, { onStage1: b => firstReady(b) });
      const book = await Promise.race([first, all]);
      if (window.TankStock) window.TankStock.markLoading();

      // TE/SO mapping sheet
      const mapAoa = book.byKind('mapping');
      if (mapAoa) parseMappingsFromSheet(mapAoa);

      // History archive (only adds snapshots this device does not have yet)
      const histAoa = book.byKind('history');
      if (histAoa) { try { await importHistoryArchive(histAoa); } catch (e) { console.error('HistoryArchive import failed', e); } }

      // Uptime monitoring sheet
      const uptimeName = pickUptimeSheet(book);
      const parsedData = uptimeName ? book.rows[uptimeName] : null;
      if (!parsedData || parsedData.length < 3) {
        throw new Error("Invalid sheet structure: the uptime sheet (Sheet 1 / 'Raw Data') has no data.");
      }
      parseRawData(parsedData);
      if (window.DataFreshness) DataFreshness.fromWorkbook(book);
      recalculateAndRefresh();
      await window.loadSharedDayMonitoring(true);

      window.__sheetSync.fp = fp;
      window.__sheetSync.at = Date.now();

      // Tank stock sheets (same workbook) arrive when the background read finishes
      all.then(full => {
        const tank = {
          latest: full.byKind('tank_latest'),
          hourly: full.byKind('tank_hourly'),
          onboarded: full.byKind('tank_onboarded')
        };
        window.__sheetSync.tankFound = !!(tank.latest || tank.hourly || tank.onboarded);
        if (window.TankStock) {
          window.TankStock.ingestSheets(tank);
          window.TankStock.markSynced(window.__sheetSync.at, window.__sheetSync.tankFound);
        }
      }).catch(err => {
        console.error('Tank sheets could not be read', err);
        if (window.TankStock) window.TankStock.markSyncError(err.message);
      });

      // History snapshot — only when the uptime data changed, and without the workbook copy
      const now = new Date();
      const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      if (!DB.db) await DB.open();
      const dataFp = rowsFingerprint(window.rawDataRows);
      const latest = (await DB.getAllRecords())[0];
      if (!latest || latest.dataFp !== dataFp || latest.date !== dateStr) {
        // Compact rawData to keep only essential fields to prevent mobile IndexedDB quota crash
        const compactRaw = (window.rawDataRows || []).map(r => ({
          roid: r.roid,
          outlet_name: r.outlet_name,
          sales_area: r.sales_area,
          territory: r.territory,
          vendor: r.vendor,
          onb_mpd: r.onb_mpd,
          onl_mpd: r.onl_mpd,
          onb_tnk: r.onb_tnk,
          onl_tnk: r.onl_tnk,
          status: r.status,
          ro_online_status: r.ro_online_status
        }));
        await DB.saveRecord({
          id: now.getTime(), timestamp: now.getTime(), date: dateStr, time: timeStr,
          filename: "Google_Sheet_Live_Sync.xlsx",
          metrics: Object.assign({}, window.overallMetrics),
          rawData: compactRaw,
          dataFp: dataFp
        });
      }

      // Refresh the trend table only when it is on screen
      const trendOpen = document.getElementById('tab-performance-trend')?.classList.contains('active');
      if (trendOpen && typeof loadUploadHistory === 'function') await loadUploadHistory();

      document.getElementById('upload-landing-view').style.display = 'none';
      document.getElementById('dashboard-active-view').style.display = 'flex';
      const meta = document.getElementById('file-meta');
      if (meta) { meta.textContent = `Loaded: Google Sheet Live Sync (${rawDataRows.length} rows)`; meta.style.display = 'block'; }
      const btnSync = document.getElementById('btn-sync-sheet');
      if (btnSync) btnSync.style.display = 'inline-flex';

      if (!silent) {
        const tankMsg = window.__sheetSync.tankFound ? ' + tank stock' : '';
        showToast(`Synced Google Sheet: ${rawDataRows.length} outlets${tankMsg}`, "success");
      }
    } catch (error) {
      console.error("Google Sheet Sync Error:", error);
      if (window.TankStock) window.TankStock.markSyncError(error.message);
      if (!silent) {
        showToast(error.message || "Failed to sync Google Sheet. Verify sharing settings.", "error");
      } else {
        throw error;
      }
    } finally {
      btns.forEach(b => b.classList.remove('is-syncing'));
    }
  })();
  window.__sheetSync.busy = run;
  try { return await run; } finally { window.__sheetSync.busy = null; }
};

// Auto-refresh: re-check the Google Sheet every few minutes while the page is open.
// Unchanged sheets cost one download + a 10 ms check; changed sheets refresh every menu.
(function setupSheetAutoRefresh() {
  const minutes = () => Math.max(2, parseInt(localStorage.getItem('bpcl_sheet_autosync_min') || '5', 10) || 5);
  let timer = null;
  async function tick() {
    if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
    if (!window.currentUser || window.dashboardMode === 'evcs') return;
    if (!window.__sheetSync.at) return; // only after the first successful sync
    try { await window.syncGoogleSheet(true); } catch (e) { console.warn('[AutoSync] skipped:', e.message); }
  }
  function start() { if (timer) clearInterval(timer); timer = setInterval(tick, minutes() * 60000); }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.__sheetSync.at && Date.now() - window.__sheetSync.at > minutes() * 60000) tick();
  });
  start();
  window.setSheetAutoSyncMinutes = m => { localStorage.setItem('bpcl_sheet_autosync_min', String(m)); start(); };
})();





// ==========================================================================
// BPCL Exact Mockup UI Helpers: Live Clock, Center Text, Dropdowns
// ==========================================================================
function initLiveHeaderClock() {
  function updateTime() {
    const now = new Date();
    const dateEl = document.getElementById('header-live-date');
    const clockEl = document.getElementById('header-live-clock');
    
    if (dateEl) {
      const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
      dateEl.textContent = now.toLocaleDateString('en-US', options);
    }
    if (clockEl) {
      clockEl.textContent = now.toLocaleTimeString('en-US', { hour12: true });
    }
  }
  updateTime();
  setInterval(updateTime, 1000);
}

window.toggleUserDropdown = function() {
  const menu = document.getElementById('user-dropdown-menu');
  if (menu) {
    menu.style.display = (menu.style.display === 'none' || !menu.style.display) ? 'flex' : 'none';
  }
};

document.addEventListener('click', function(e) {
  const container = document.getElementById('user-profile-widget');
  const menu = document.getElementById('user-dropdown-menu');
  if (container && menu && !container.contains(e.target)) {
    menu.style.display = 'none';
  }
});

// Initialize on DOM load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLiveHeaderClock);
} else {
  initLiveHeaderClock();
}



// ==========================================================================
// Attached Enterprise UI Global Helpers
// ==========================================================================
window.changeROPageSize = function(size) {
  RO_PAGE_SIZE = parseInt(size) || 10;
  roCurrentPage = 1;
  renderROExplorerPage();
};

window.goToROPage = function(page) {
  const p = parseInt(page);
  const maxPages = Math.ceil(roFilteredList.length / RO_PAGE_SIZE) || 1;
  if (p >= 1 && p <= maxPages) {
    roCurrentPage = p;
    renderROExplorerPage();
  }
};

window.applyGlobalFilters = function() {
  const area = document.getElementById('global-filter-sales-area')?.value || '';
  const vendor = document.getElementById('global-filter-vendor')?.value || '';
  const status = document.getElementById('global-filter-status')?.value || '';

  // Apply to roFilteredList
  roFilteredList = calculatedROs.filter(ro => {
    if (area && !ro.sales_area.toLowerCase().includes(area.toLowerCase())) return false;
    if (vendor && ro.vendor !== vendor) return false;
    if (status && ro.status !== status) return false;
    return true;
  });

  roCurrentPage = 1;
  renderROExplorerPage();
};

function updatePortalTimestamp() {
  const now = new Date();
  const el = document.getElementById('portal-live-clock');
  if (el) {
    el.textContent = now.toLocaleDateString('en-US') + ' ' + now.toLocaleTimeString('en-US', { hour12: true });
  }
}
setInterval(updatePortalTimestamp, 1000);
updatePortalTimestamp();
