// trend.js - Historical database, archiving, and trend visualization controller

// IndexedDB Helper
const DB = {
  dbName: 'automation_monitoring_db',
  dbVersion: 1,
  db: null,

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('history')) {
          const store = db.createObjectStore('history', { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains('config')) {
          db.createObjectStore('config', { keyPath: 'key' });
        }
      };
    });
  },

  get(storeName, key) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve(null);
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  },

  set(storeName, key, value) {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  saveRecord(record) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error("Database not open"));
      const tx = this.db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      const req = store.put(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  getAllRecords() {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction('history', 'readonly');
      const store = tx.objectStore('history');
      const index = store.index('timestamp');
      const req = index.openCursor(null, 'prev'); // sort descending by timestamp
      const list = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          list.push(cursor.value);
          cursor.continue();
        } else {
          resolve(list);
        }
      };
      req.onerror = () => reject(req.error);
    });
  },

  deleteRecord(id) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error("Database not open"));
      const tx = this.db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
};

// Local Folder Archiving Setup
let archiveDirectoryHandle = null;

async function selectArchiveFolder() {
  try {
    const handle = await window.showDirectoryPicker();
    if (await verifyFolderPermission(handle, true)) {
      archiveDirectoryHandle = handle;
      await DB.set('config', 'archiveFolderHandle', handle);
      updateFolderStatusUI(handle.name);
      showToast(`Connected to archive folder: ${handle.name}`, "success");
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      showToast("Failed to select archive folder", "error");
    }
  }
}

async function verifyFolderPermission(handle, readWrite) {
  const options = {};
  if (readWrite) {
    options.mode = 'readwrite';
  }
  if ((await handle.queryPermission(options)) === 'granted') {
    return true;
  }
  if ((await handle.requestPermission(options)) === 'granted') {
    return true;
  }
  return false;
}

async function loadArchiveFolder() {
  updateFolderStatusUI("Automation Daily Archive (Shared)");
}

function updateFolderStatusUI(folderName) {
  const el = document.getElementById('folder-status-text');
  if (el) {
    el.innerHTML = `Connected to Google Drive Folder:<br>
    <a href="https://drive.google.com/drive/folders/1x3giWLl-yft4JiXrVwaJURbDi7UYkvG-?usp=sharing" target="_blank" style="color: var(--accent-color); font-weight: 700; text-decoration: underline; word-break: break-all;">
      Automation Daily Archive (Shared)
    </a>`;
  }
}

async function archiveFileToLocalFolder(file, dateStr, timeStr) {
  if (!archiveDirectoryHandle) return;
  
  try {
    const hasPermission = await verifyFolderPermission(archiveDirectoryHandle, true);
    if (!hasPermission) {
      console.warn("Archive folder write permission denied");
      showToast("Archive folder permission denied. File not archived locally.", "error");
      return;
    }
    
    // Format filename: Automation_Uptime_2026-07-15_18-00.xlsx
    const timestampStr = `${dateStr}_${timeStr.replace(':', '-')}`;
    const ext = file.name.split('.').pop() || 'xlsx';
    const archiveName = `Automation_Uptime_${timestampStr}.${ext}`;
    
    const fileHandle = await archiveDirectoryHandle.getFileHandle(archiveName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file);
    await writable.close();
    console.log("Archived file successfully:", archiveName);
  } catch (err) {
    console.error("Error writing copy to archive folder:", err);
    showToast("Failed to copy file to local archive folder", "error");
  }
}

// Date/Time Confirmation Modal Logic
let pendingUploadFile = null;

function showUploadConfirmModal(file) {
  pendingUploadFile = file;
  const modal = document.getElementById('upload-confirm-modal');
  const filenameEl = document.getElementById('upload-confirm-filename');
  const dateInput = document.getElementById('upload-confirm-date');
  const timeInput = document.getElementById('upload-confirm-time');
  
  if (!modal || !filenameEl || !dateInput || !timeInput) return;
  
  filenameEl.textContent = file.name;
  
  // Detect date and time from filename
  const parsed = parseDateFromFilename(file.name);
  dateInput.value = parsed.date;
  timeInput.value = parsed.time;
  
  modal.style.display = 'flex';
}

window.closeUploadConfirmModal = function() {
  const modal = document.getElementById('upload-confirm-modal');
  if (modal) modal.style.display = 'none';
  pendingUploadFile = null;
};

// When user clicks Confirm & Import
document.getElementById('btn-confirm-upload-save').addEventListener('click', async () => {
  if (!pendingUploadFile) return;
  
  const dateInput = document.getElementById('upload-confirm-date').value;
  const timeInput = document.getElementById('upload-confirm-time').value;
  
  if (!dateInput || !timeInput) {
    showToast("Please enter a valid Date and Time", "error");
    return;
  }
  
  const file = pendingUploadFile;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const data = new Uint8Array(e.target.result);
    try {
      const workbook = XLSX.read(data, { type: 'array' });
      
      // Process mappings sheet if exists
      if (workbook.SheetNames.includes('EO-SO Map')) {
        parseMappingsFromSheet(workbook.Sheets['EO-SO Map']);
      }
      
      // Process raw data sheet
      let rawDataSheetName = null;
      if (workbook.SheetNames.includes('Raw Data')) {
        rawDataSheetName = 'Raw Data';
      } else {
        rawDataSheetName = workbook.SheetNames.find(name => name.toLowerCase().includes('raw'));
      }
      
      if (!rawDataSheetName) {
        // Look for matching names containing charger, list, data, status (case-insensitive)
        rawDataSheetName = workbook.SheetNames.find(name => {
          const ln = name.toLowerCase();
          return ln.includes('charger') || ln.includes('list') || ln.includes('data') || ln.includes('status');
        });
      }
      
      if (!rawDataSheetName) {
        rawDataSheetName = workbook.SheetNames[0];
      }
      
      const sheet = workbook.Sheets[rawDataSheetName];
      const parsedData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      
      if (parsedData.length < 3) {
        showToast("Invalid sheet structure: not enough rows", "error");
        return;
      }
      
      // Parse raw rows in app.js
      parseRawData(parsedData);
      
      // Recalculate metrics in app.js
      recalculateAndRefresh();
      
      // Construct timestamp
      const timestamp = new Date(`${dateInput}T${timeInput}:00`).getTime();
      
      // Save to IndexedDB
      const record = {
        id: timestamp,
        timestamp: timestamp,
        date: dateInput,
        time: timeInput,
        filename: file.name,
        metrics: Object.assign({}, window.overallMetrics), // clone overall metrics
        rawData: JSON.parse(JSON.stringify(window.rawDataRows)), // deep clone raw data
        fileBlob: file
      };
      
      await DB.saveRecord(record);
      
      // Archive to local folder
      await archiveFileToLocalFolder(file, dateInput, timeInput);
      
      // Close confirmation modal
      closeUploadConfirmModal();
      
      // Switch view from upload landing to active dashboard
      document.getElementById('upload-landing-view').style.display = 'none';
      document.getElementById('dashboard-active-view').style.display = 'flex';
      
      // Show header elements
      document.getElementById('file-meta').textContent = `Loaded: ${file.name} (${window.rawDataRows.length} rows)`;
      document.getElementById('file-meta').style.display = 'block';
      document.getElementById('header-upload-wrapper').style.display = 'block';
      document.getElementById('btn-sync-sheet').style.display = 'inline-flex';
      
      showToast(`Successfully processed & saved copy to database!`, "success");
      
      // If currently active tab is Trend tab, refresh it
      if (document.getElementById('tab-performance-trend').classList.contains('active')) {
        loadUploadHistory();
      }
      
    } catch (err) {
      console.error("Error reading file", err);
      showToast(`Error processing file: ${err.message}`, "error");
    }
  };
  reader.readAsArrayBuffer(file);
});

// Date/Time parsing from filename utility
function parseDateFromFilename(filename) {
  const cleaned = filename.toLowerCase();
  
  // 1. Match YYYY-MM-DD
  let match = cleaned.match(/(\d{4})[-_.](\d{2})[-_.](\d{2})/);
  if (match) {
    return { date: `${match[1]}-${match[2]}-${match[3]}`, time: detectTime(cleaned) };
  }
  
  // 2. Match DD-MM-YYYY
  match = cleaned.match(/(\d{2})[-_.](\d{2})[-_.](\d{4})/);
  if (match) {
    return { date: `${match[3]}-${match[2]}-${match[1]}`, time: detectTime(cleaned) };
  }
  
  // 3. Match DD-MM-YY
  match = cleaned.match(/(\d{2})[-_.](\d{2})[-_.](\d{2})/);
  if (match) {
    let year = parseInt(match[3]);
    if (year < 100) year += 2000;
    return { date: `${year}-${match[2]}-${match[1]}`, time: detectTime(cleaned) };
  }
  
  // Default to today
  const todayStr = new Date().toISOString().substring(0, 10);
  return { date: todayStr, time: detectTime(cleaned) };
}

function detectTime(cleaned) {
  let hour = 18; // default 6PM
  let min = 0;
  
  if (cleaned.includes('6pm') || cleaned.includes('18_00') || cleaned.includes('18-00') || cleaned.includes('1800')) {
    hour = 18;
  } else if (cleaned.includes('8pm') || cleaned.includes('20_00') || cleaned.includes('20-00') || cleaned.includes('2000')) {
    hour = 20;
  } else {
    // Check HH:MM
    const timeMatch = cleaned.match(/(\d{1,2})[-_.:](\d{2})/);
    if (timeMatch) {
      const h = parseInt(timeMatch[1]);
      const m = parseInt(timeMatch[2]);
      if (h < 24 && m < 60) {
        hour = h;
        min = m;
      }
    }
  }
  
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Yesterday vs Today Comparison logic
async function calculateYesterdayVsToday(historyRecords) {
  if (historyRecords.length === 0) return;
  
  const sorted = [...historyRecords].sort((a, b) => b.timestamp - a.timestamp);
  
  // Today's latest upload
  const todayRecord = sorted[0];
  const todayDate = todayRecord.date;
  
  // Find Yesterday's latest Day End upload (latest preceding date)
  let yesterdayRecord = null;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].date !== todayDate) {
      yesterdayRecord = sorted[i];
      break;
    }
  }
  
  // Render Territory Uptime
  renderComparisonCard('comp-uptime-yesterday', 'comp-uptime-today', 'comp-uptime-trend', 
                       yesterdayRecord ? yesterdayRecord.metrics.uptime * 100 : null, 
                       todayRecord.metrics.uptime * 100, true);
                       
  // Render Fully Online count
  renderComparisonCard('comp-online-yesterday', 'comp-online-today', 'comp-online-trend', 
                       yesterdayRecord ? yesterdayRecord.metrics.fullyOnline : null, 
                       todayRecord.metrics.fullyOnline, false);
                       
  // Render Offline count (inverted color: negative diff is good!)
  renderComparisonCard('comp-offline-yesterday', 'comp-offline-today', 'comp-offline-trend', 
                       yesterdayRecord ? yesterdayRecord.metrics.offline : null, 
                       todayRecord.metrics.offline, false, true);
}

function renderComparisonCard(yesterdayId, todayId, trendId, valYesterday, valToday, isPercent = false, invertColor = false) {
  const yEl = document.getElementById(yesterdayId);
  const tEl = document.getElementById(todayId);
  const trEl = document.getElementById(trendId);
  
  if (!yEl || !tEl || !trEl) return;
  
  // Format Today
  tEl.textContent = isPercent ? valToday.toFixed(2) + '%' : valToday;
  
  // Format Yesterday
  if (valYesterday === null || valYesterday === undefined) {
    yEl.textContent = '-';
    trEl.textContent = 'No past data';
    trEl.className = 'comp-trend trend-neutral';
    return;
  }
  
  yEl.textContent = isPercent ? valYesterday.toFixed(2) + '%' : valYesterday;
  
  // Calculate Delta
  const diff = valToday - valYesterday;
  let diffStr = '';
  let trendClass = 'trend-neutral';
  
  if (diff > 0) {
    diffStr = `+${isPercent ? diff.toFixed(2) + '%' : diff}`;
    trendClass = invertColor ? 'trend-down' : 'trend-up';
  } else if (diff < 0) {
    diffStr = `${isPercent ? diff.toFixed(2) + '%' : diff}`;
    trendClass = invertColor ? 'trend-up' : 'trend-down';
  } else {
    diffStr = '0.00%';
    if (!isPercent) diffStr = '0';
    trendClass = 'trend-neutral';
  }
  
  trEl.textContent = diffStr;
  trEl.className = `comp-trend ${trendClass}`;
}

// Calculation Engine for Seed Records (replicating calculations)
function calculateMetricsForDataset(rows) {
  let totalROs = rows.length;
  let fullyOnline = 0;
  let partiallyOnline = 0;
  let offline = 0;
  let autoRspCount = 0;
  let sumOnbMpd = 0;
  let sumOnlMpd = 0;
  let sumOnbTnk = 0;
  let sumOnlTnk = 0;
  
  rows.forEach(row => {
    const tot_onb = row.onb_mpd + row.onb_tnk;
    const tot_onl = row.onl_mpd + row.onl_tnk;
    
    let status = "Offline";
    if (tot_onb > 0 && tot_onl > 0) {
      if (tot_onl >= tot_onb) {
        status = "Fully Online";
      } else {
        status = "Partially Online";
      }
    }
    
    if (status === "Fully Online") fullyOnline++;
    else if (status === "Partially Online") partiallyOnline++;
    else if (status === "Offline") offline++;
    
    if (row.auto_rsp === "Yes" || row.auto_rsp === "yes") autoRspCount++;
    
    sumOnbMpd += row.onb_mpd;
    sumOnlMpd += row.onl_mpd;
    sumOnbTnk += row.onb_tnk;
    sumOnlTnk += row.onl_tnk;
  });
  
  return {
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
}

// Seed Generator on first load
async function seedMockHistory() {
  if (!window.BPCL_SAMPLE_DATA || window.BPCL_SAMPLE_DATA.length === 0) return;

  const records = [];
  const baseData = window.BPCL_SAMPLE_DATA;
  const now = new Date();
  
  // Seed past 14 days chronologically
  for (let i = 14; i >= 1; i--) {
    const targetDate = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = targetDate.toISOString().substring(0, 10);
    
    // 3 uploads per day representing a typical dashboard monitoring workflow
    const uploads = [
      { time: "10:30", hour: 10, min: 30 },
      { time: "14:15", hour: 14, min: 15 },
      { time: "18:30", hour: 18, min: 30 } // 6:30PM counts as Day End
    ];
    
    for (let u = 0; u < uploads.length; u++) {
      const upload = uploads[u];
      const uploadTime = upload.time;
      const uploadTimestamp = new Date(`${dateStr}T${uploadTime}:00`).getTime();
      
      // Mutate the raw data slightly using a sine wave progression for a clean trend curve
      const dayFactor = Math.sin((14 - i) / 2.5) * 0.02 + 0.94; // oscilliates around 94%
      
      const mutatedData = baseData.map(ro => {
        const cloned = Object.assign({}, ro);
        if (!cloned.iot_enabled) {
          cloned.iot_enabled = parseInt(cloned.roid) % 3 !== 0 ? "Yes" : "No";
        }
        
        // Degrade MPDs with some probability
        if (Math.random() > dayFactor && cloned.onb_mpd > 0) {
          cloned.onl_mpd = Math.max(0, Math.floor(cloned.onb_mpd * (dayFactor - Math.random() * 0.08)));
        }
        
        // Degrade Tanks with some probability
        if (Math.random() > dayFactor && cloned.onb_tnk > 0) {
          cloned.onl_tnk = parseFloat((cloned.onb_tnk * (dayFactor - Math.random() * 0.12)).toFixed(2));
        }
        
        return cloned;
      });
      
      const metrics = calculateMetricsForDataset(mutatedData);
      
      records.push({
        id: uploadTimestamp,
        timestamp: uploadTimestamp,
        date: dateStr,
        time: uploadTime,
        filename: `Belgaum_Territory_RawData_${dateStr.replace(/-/g, '_')}_${uploadTime.replace(':', '_')}.xlsx`,
        metrics: metrics,
        rawData: mutatedData,
        fileBlob: new Blob(["Preseeded Mock Binary spreadsheet"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
      });
    }
  }
  
  for (const rec of records) {
    await DB.saveRecord(rec);
  }
  console.log("Seeded database with 14 days of historical monitoring logs!");
}

// Controller and Rendering logic
let uptimeChartInstance = null;
let statusChartInstance = null;

async function loadUploadHistory() {
  if (!DB.db) {
    await DB.open();
  }
  
  let records = await DB.getAllRecords();
  
  // Seed if empty
  if (records.length === 0) {
    await seedMockHistory();
    records = await DB.getAllRecords();
  }
  
  // Recalculate yesterday vs today card values
  await calculateYesterdayVsToday(records);
  
  // Render trend table and visualizations
  window.renderHistoryAndCharts(records);
}

window.renderHistoryAndCharts = async function(recordsList) {
  let records = recordsList;
  if (!records) {
    records = await DB.getAllRecords();
  }
  
  const granularity = document.getElementById('trend-granularity-select').value;
  
  // Compute Day End records (latest record for each date)
  const dayEndMap = {};
  records.forEach(rec => {
    if (!dayEndMap[rec.date]) {
      dayEndMap[rec.date] = rec;
    }
  });
  
  // History table displays raw records depending on selection:
  // If 'all', displays all uploads. Otherwise, displays day-end records.
  let tableRecords = [];
  if (granularity === 'all') {
    tableRecords = [...records].sort((a, b) => b.timestamp - a.timestamp);
  } else {
    tableRecords = Object.values(dayEndMap).sort((a, b) => b.timestamp - a.timestamp);
  }
  renderHistoryTable(tableRecords, dayEndMap);
  
  // Prepare chart records:
  // First, extract day-end records sorted ascending
  const dayEndRecords = Object.values(dayEndMap).sort((a, b) => a.timestamp - b.timestamp);
  
  // Then group them based on granularity
  let chartRecords = [];
  if (granularity === 'all') {
    chartRecords = [...records].sort((a, b) => a.timestamp - b.timestamp);
  } else {
    chartRecords = groupRecords(dayEndRecords, granularity);
  }
  
  // Render Trend Charts
  renderTrendCharts(chartRecords, granularity);
};

// Helper function to group and aggregate records for weekly/monthly views
function groupRecords(dayEndRecords, granularity) {
  if (granularity === 'dayend' || granularity === 'all') {
    return dayEndRecords;
  }
  
  const groups = {};
  
  dayEndRecords.forEach(rec => {
    const d = new Date(rec.date);
    let key = '';
    let label = '';
    
    if (granularity === 'weekly') {
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const pastDaysOfYear = (d - startOfYear) / 86400000;
      const weekNum = Math.ceil((pastDaysOfYear + startOfYear.getDay() + 1) / 7);
      key = `${d.getFullYear()}-W${weekNum}`;
      
      const currentDay = d.getDay();
      const distanceToMon = currentDay === 0 ? -6 : 1 - currentDay;
      const mon = new Date(d.getTime() + distanceToMon * 24 * 60 * 60 * 1000);
      const sun = new Date(mon.getTime() + 6 * 24 * 60 * 60 * 1000);
      
      const monStr = mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const sunStr = sun.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      label = `W${weekNum} (${monStr} - ${sunStr})`;
    } else if (granularity === 'monthly') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    
    if (!groups[key]) {
      groups[key] = {
        label: label,
        records: [],
        timestamp: rec.timestamp
      };
    }
    groups[key].records.push(rec);
  });
  
  const result = Object.values(groups).map(g => {
    const count = g.records.length;
    const sumMetrics = g.records.reduce((acc, r) => {
      acc.uptime += r.metrics.uptime;
      acc.mpdUptime += r.metrics.mpdUptime;
      acc.tankUptime += r.metrics.tankUptime;
      acc.autoRspPct += r.metrics.autoRspPct;
      acc.fullyOnline += r.metrics.fullyOnline;
      acc.partiallyOnline += r.metrics.partiallyOnline;
      acc.offline += r.metrics.offline;
      return acc;
    }, { uptime: 0, mpdUptime: 0, tankUptime: 0, autoRspPct: 0, fullyOnline: 0, partiallyOnline: 0, offline: 0 });
    
    return {
      date: g.label,
      time: '',
      timestamp: g.timestamp,
      metrics: {
        uptime: sumMetrics.uptime / count,
        mpdUptime: sumMetrics.mpdUptime / count,
        tankUptime: sumMetrics.tankUptime / count,
        autoRspPct: sumMetrics.autoRspPct / count,
        fullyOnline: Math.round(sumMetrics.fullyOnline / count),
        partiallyOnline: Math.round(sumMetrics.partiallyOnline / count),
        offline: Math.round(sumMetrics.offline / count)
      }
    };
  });
  
  return result.sort((a, b) => a.timestamp - b.timestamp);
}

function renderHistoryTable(records, dayEndMap) {
  const tbody = document.getElementById('trend-history-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 2rem;">No upload history available.</td></tr>`;
    return;
  }
  
  records.forEach(rec => {
    const isDayEnd = dayEndMap[rec.date] && dayEndMap[rec.date].id === rec.id;
    const tr = document.createElement('tr');
    
    if (isDayEnd) {
      tr.style.borderLeft = "3px solid var(--accent-green)";
    }
    
    const formattedDate = formatDateString(rec.date);
    
    tr.innerHTML = `
      <td style="font-weight: 600;">${formattedDate} <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal; margin-left: 0.25rem;">${rec.time}</span></td>
      <td title="${rec.filename}" style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        ${rec.filename}
        ${isDayEnd ? `<span class="status-badge status-fully-online" style="font-size: 0.6rem; padding: 0.1rem 0.35rem; margin-left: 0.25rem; box-shadow: none;">Day End</span>` : ''}
      </td>
      <td style="font-weight: 700; color: var(--accent-color);">${(rec.metrics.uptime * 100).toFixed(2)}%</td>
      <td>
        <span style="color: #059669; font-weight: 700;">${rec.metrics.fullyOnline}</span> / 
        <span style="color: #d97706; font-weight: 700;">${rec.metrics.partiallyOnline}</span> / 
        <span style="color: #dc2626; font-weight: 700;">${rec.metrics.offline}</span>
      </td>
      <td style="text-align: center; white-space: nowrap;">
        <button class="history-action-btn btn-load" onclick="restoreHistoricalUpload(${rec.id})" title="Load into Active Dashboard">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          Load
        </button>
        <button class="history-action-btn btn-dl" onclick="downloadHistoricalFile(${rec.id})" title="Download Excel File">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          Dl
        </button>
        <button class="history-action-btn btn-del" onclick="deleteHistoricalUpload(${rec.id})" title="Delete Record">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function formatDateString(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Actions from History List Table
window.restoreHistoricalUpload = async function(id) {
  try {
    const tx = DB.db.transaction('history', 'readonly');
    const store = tx.objectStore('history');
    const req = store.get(id);
    req.onsuccess = () => {
      const record = req.result;
      if (record && record.rawData) {
        // Clear and push to main global array
        window.rawDataRows.length = 0;
        window.rawDataRows.push(...record.rawData);
        
        // Recalculate metrics in app.js
        window.recalculateAndRefresh();
        
        // Update header file info
        document.getElementById('file-meta').textContent = `Restored History: ${record.filename} (${record.date} ${record.time})`;
        document.getElementById('file-meta').style.display = 'block';
        document.getElementById('header-upload-wrapper').style.display = 'block';
        
        showToast(`Loaded historical data for ${record.date} ${record.time}!`, "success");
      }
    };
  } catch (err) {
    console.error(err);
    showToast("Failed to restore record", "error");
  }
};

window.downloadHistoricalFile = async function(id) {
  try {
    const tx = DB.db.transaction('history', 'readonly');
    const store = tx.objectStore('history');
    const req = store.get(id);
    req.onsuccess = () => {
      const record = req.result;
      if (record) {
        if (record.fileBlob) {
          const blob = record.fileBlob;
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = record.filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          showToast(`Downloaded: ${record.filename}`, "success");
        } else if (record.googleDriveFileId) {
          window.open(`https://drive.google.com/uc?export=download&id=${record.googleDriveFileId}`, '_blank');
          showToast(`Downloading from Google Drive: ${record.filename}`, "success");
        } else {
          showToast("Spreadsheet file is not available for this record", "error");
        }
      }
    };
  } catch (err) {
    console.error(err);
    showToast("Failed to download file", "error");
  }
};

window.deleteHistoricalUpload = async function(id) {
  if (confirm("Are you sure you want to delete this upload from history?")) {
    try {
      await DB.deleteRecord(id);
      showToast("Deleted record from history", "success");
      loadUploadHistory();
    } catch (err) {
      console.error(err);
      showToast("Failed to delete record", "error");
    }
  }
};

// Rendering Visual Charts (Chart.js)
function renderTrendCharts(records, granularity) {
  const textColor = '#4a5568';
  const gridColor = 'rgba(163, 177, 198, 0.3)';
  
  const labels = records.map(rec => {
    if (granularity === 'weekly' || granularity === 'monthly') {
      return rec.date;
    }
    const d = new Date(rec.date);
    const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return granularity === 'dayend' ? datePart : `${datePart} ${rec.time}`;
  });
  
  const uptimeVals = records.map(rec => (rec.metrics.uptime * 100).toFixed(2));
  const mpdUptimeVals = records.map(rec => (rec.metrics.mpdUptime * 100).toFixed(2));
  const tankUptimeVals = records.map(rec => (rec.metrics.tankUptime * 100).toFixed(2));
  
  const fullyOnlineVals = records.map(rec => rec.metrics.fullyOnline);
  const partiallyOnlineVals = records.map(rec => rec.metrics.partiallyOnline);
  const offlineVals = records.map(rec => rec.metrics.offline);
  
  // 1. Line Chart (Uptime)
  const uptimeCtx = document.getElementById('trend-uptime-chart').getContext('2d');
  if (uptimeChartInstance) {
    uptimeChartInstance.destroy();
  }
  
  uptimeChartInstance = new Chart(uptimeCtx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Overall Uptime',
          data: uptimeVals,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.05)',
          borderWidth: 2,
          pointRadius: records.length > 25 ? 0 : 3.5,
          pointBackgroundColor: '#6366f1',
          fill: true,
          tension: 0.15
        },
        {
          label: 'MPD Uptime',
          data: mpdUptimeVals,
          borderColor: '#3b82f6',
          borderWidth: 1.5,
          pointRadius: records.length > 25 ? 0 : 2.5,
          pointBackgroundColor: '#3b82f6',
          fill: false,
          tension: 0.15
        },
        {
          label: 'Tank Uptime',
          data: tankUptimeVals,
          borderColor: '#14b8a6',
          borderWidth: 1.5,
          pointRadius: records.length > 25 ? 0 : 2.5,
          pointBackgroundColor: '#14b8a6',
          fill: false,
          tension: 0.15
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: textColor, font: { family: 'Inter', size: 9, weight: '600' } }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: textColor, font: { family: 'Inter', size: 8 } }
        },
        y: {
          min: 80,
          max: 100,
          grid: { color: gridColor },
          ticks: {
            color: textColor,
            font: { family: 'Inter', size: 8 },
            callback: value => value + '%'
          }
        }
      }
    }
  });
  
  // 2. Stacked Bar Chart (Status Distribution)
  const statusCtx = document.getElementById('trend-status-chart').getContext('2d');
  if (statusChartInstance) {
    statusChartInstance.destroy();
  }
  
  statusChartInstance = new Chart(statusCtx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Fully Online',
          data: fullyOnlineVals,
          backgroundColor: '#10b981',
          order: 3
        },
        {
          label: 'Partially Online',
          data: partiallyOnlineVals,
          backgroundColor: '#f59e0b',
          order: 2
        },
        {
          label: 'Offline',
          data: offlineVals,
          backgroundColor: '#ef4444',
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: textColor, font: { family: 'Inter', size: 9, weight: '600' } }
        }
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { color: textColor, font: { family: 'Inter', size: 8 } }
        },
        y: {
          stacked: true,
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: 'Inter', size: 8 } }
        }
      }
    }
  });
}

// Bind to lifecycle on document ready
window.addEventListener('DOMContentLoaded', () => {
  // Overwrite original app.js file handler to introduce confirmation flow
  window.handleUploadedFile = function(file) {
    showUploadConfirmModal(file);
  };
  
  // Bind Select Folder Button
  const btnSelectFolder = document.getElementById('btn-select-folder');
  if (btnSelectFolder) {
    btnSelectFolder.addEventListener('click', selectArchiveFolder);
  }
  
  // Load local reference archive folder (if selected in prior sessions)
  loadArchiveFolder();
  
  // Load upload history if database is ready
  DB.open().then(() => {
    const ptTab = document.getElementById('tab-performance-trend');
    if (ptTab && ptTab.classList.contains('active')) {
      loadUploadHistory();
    }
  });
});
