/**
 * BPCL Automation Dashboard — Google Sheet updater
 * ------------------------------------------------
 * Fills the 4 tabs that the Automation Dashboard web app reads:
 *
 *   Uptime          ← "Uptime.xlsx"               (Power BI export)
 *   Last stock      ← "Last_updated_stock.xlsx"   (Power BI export)
 *   Hourly stock    ← "Stock_hourly.xlsx"         (Power BI export)
 *   Onboarded tanks ← "Onboarded_tanks.xlsx"      (Power BI export)
 *
 * Two ways to update:
 *   A) Menu  BPCL Automation ▸ Import Excel files…   (pick the files from your PC/phone)
 *   B) Optional: drop the files into a Google Drive folder and let the
 *      script import them automatically every 15 minutes (see SETUP B below).
 *
 * What the script does with every file:
 *   • detects which tab it belongs to from its column headers (file name does not matter)
 *   • removes Power BI footer rows ("Total", blank line, "Applied filters: …")
 *   • keeps column types exactly as in the export (text stays text, numbers stay numbers),
 *     dates become yyyy-mm-dd and times hh:mm:ss
 *   • (recommended) keeps only the tank rows of outlets present in the Uptime tab,
 *     so an all-India export of 60,000 rows becomes ~1,000 rows and the dashboard stays fast
 *   • replaces the old data of that tab completely
 */

// ============================ SETTINGS ============================
var TABS = {
  uptime:    'Uptime',
  last:      'Last stock',
  hourly:    'Hourly stock',
  onboarded: 'Onboarded tanks'
};

// Territories to keep from the all-India exports (comma separated, '' = all India).
// Can also be changed in the Import dialog — the dialog's value is remembered.
var DEFAULT_TERRITORIES = 'Belgaum';

// Keep only tank rows whose RO ID is in the Uptime tab (recommended)
var KEEP_ONLY_UPTIME_ROS = true;

// SETUP B (optional): ID of a Google Drive folder where you drop the Excel files.
// Open the folder in Drive — the ID is the last part of the URL:
//   https://drive.google.com/drive/folders/<THIS_PART>
var DRIVE_FOLDER_ID = '';

// How often the Drive folder is checked (minutes: 5, 10, 15 or 30)
var AUTO_IMPORT_EVERY_MIN = 15;
// ==================================================================


// ---------------------------- Menu ----------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('BPCL Automation')
    .addItem('Import Excel files…', 'showImportDialog')
    .addSeparator()
    .addItem('Import now from Drive folder', 'importFromDriveFolder')
    .addItem('Turn ON auto-import from Drive folder', 'enableAutoImport')
    .addItem('Turn OFF auto-import', 'disableAutoImport')
    .addSeparator()
    .addItem('Show last update info', 'showStatus')
    .addToUi();
}

function showImportDialog() {
  var html = HtmlService.createHtmlOutputFromFile('ImportDialog')
    .setWidth(560).setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, 'Update Automation data');
}


// ------------------- Called from the dialog -------------------

/** Settings + RO IDs currently in the Uptime tab (used to filter tank files). */
function getImportContext() {
  return {
    tabs: TABS,
    keepOnlyUptimeRos: KEEP_ONLY_UPTIME_ROS,
    territories: getTerritories_(),
    uptimeRoIds: readUptimeRoIds_()
  };
}

/** Saves the territory list typed in the dialog (used by the Drive-folder import too). */
function saveTerritories(text) {
  PropertiesService.getDocumentProperties().setProperty('keep_territories', String(text || '').trim());
  return getTerritories_();
}

function getTerritories_() {
  var v = PropertiesService.getDocumentProperties().getProperty('keep_territories');
  return v === null ? DEFAULT_TERRITORIES : v;
}

function territorySet_(text) {
  var list = String(text || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(String);
  if (!list.length) return null;
  var set = {}; list.forEach(function (t) { set[t] = true; }); return set;
}

/**
 * Writes one chunk of rows into a tab.
 * First chunk (startIndex 0) clears the tab, sizes it and writes the header.
 */
function writeChunk(kind, header, rows, startIndex, totalRows, textCols) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var sh = getOrCreateTab_(TABS[kind]);
    if (startIndex === 0) prepareTab_(sh, header, totalRows, textCols);
    if (rows.length) sh.getRange(2 + startIndex, 1, rows.length, header.length).setValues(rows);
    if (startIndex + rows.length >= totalRows) {
      SpreadsheetApp.flush();
      stampImport_(kind, totalRows);
    }
    return startIndex + rows.length;
  } finally {
    lock.releaseLock();
  }
}

/** Rows and time of the last import of each tab. */
function getStatus() {
  var p = PropertiesService.getDocumentProperties().getProperties();
  var out = {};
  Object.keys(TABS).forEach(function (k) { out[k] = p['import_' + k] ? JSON.parse(p['import_' + k]) : null; });
  return out;
}

function showStatus() {
  var s = getStatus(), tz = Session.getScriptTimeZone(), lines = [];
  Object.keys(TABS).forEach(function (k) {
    var x = s[k];
    lines.push(TABS[k] + ':  ' + (x ? x.rows + ' rows · ' + Utilities.formatDate(new Date(x.at), tz, 'dd-MMM-yyyy HH:mm') : 'not imported yet'));
  });
  SpreadsheetApp.getUi().alert('Last update', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}


// ---------------- Option B: Google Drive folder ----------------
// Needs: Services (+) ▸ Drive API (advanced service) added to this script.

function enableAutoImport() {
  if (!DRIVE_FOLDER_ID) {
    SpreadsheetApp.getUi().alert('Set DRIVE_FOLDER_ID at the top of Code.gs first (see SETUP B).');
    return;
  }
  disableAutoImport(true);
  ScriptApp.newTrigger('importFromDriveFolder').timeBased().everyMinutes(AUTO_IMPORT_EVERY_MIN).create();
  SpreadsheetApp.getActive().toast('Auto-import ON — the Drive folder is checked every ' + AUTO_IMPORT_EVERY_MIN + ' min.', 'BPCL Automation', 6);
}

function disableAutoImport(silent) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'importFromDriveFolder') ScriptApp.deleteTrigger(t);
  });
  if (silent !== true) SpreadsheetApp.getActive().toast('Auto-import OFF.', 'BPCL Automation', 5);
}

/**
 * Imports every new/changed .xlsx in DRIVE_FOLDER_ID.
 * Files are left in the folder; the script remembers which version it already imported.
 */
function importFromDriveFolder() {
  if (!DRIVE_FOLDER_ID) throw new Error('DRIVE_FOLDER_ID is empty — see SETUP B at the top of Code.gs.');
  var props = PropertiesService.getDocumentProperties();
  var done = JSON.parse(props.getProperty('drive_done') || '{}');
  var folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  var it = folder.getFiles(), found = [];
  while (it.hasNext()) {
    var f = it.next();
    var isXlsx = /\.xlsx$/i.test(f.getName()) || f.getMimeType() === MimeType.MICROSOFT_EXCEL;
    if (!isXlsx) continue;
    var stamp = f.getLastUpdated().getTime();
    if (done[f.getId()] === stamp) continue;
    found.push({ file: f, stamp: stamp });
  }
  if (!found.length) return 'No new files';

  // Read every file first, then write Uptime before the tank tabs
  var batches = [];
  found.forEach(function (x) {
    var aoa = readXlsxViaDrive_(x.file);
    var kind = detectKind_(aoa[0] || [], x.file.getName());
    if (!kind) { console.warn('Not recognised, skipped: ' + x.file.getName()); return; }
    batches.push({ kind: kind, aoa: aoa, x: x });
  });
  var order = { uptime: 0, last: 1, hourly: 2, onboarded: 3 };
  batches.sort(function (a, b) { return order[a.kind] - order[b.kind]; });

  var imported = [];
  batches.forEach(function (b) {
    var roSet = null;
    if (KEEP_ONLY_UPTIME_ROS && b.kind !== 'uptime') {
      var ids = readUptimeRoIds_();
      if (ids.length) { roSet = {}; ids.forEach(function (id) { roSet[id] = true; }); }
    }
    var clean = b.kind === 'uptime' ? cleanRows_(b.aoa, null, territorySet_(getTerritories_()))
                                     : cleanRows_(b.aoa, roSet, roSet ? null : territorySet_(getTerritories_()));
    var CH = 5000;
    if (!clean.rows.length) writeChunk(b.kind, clean.header, [], 0, 0, clean.textCols);
    for (var i = 0; i < clean.rows.length; i += CH) {
      writeChunk(b.kind, clean.header, clean.rows.slice(i, i + CH), i, clean.rows.length, clean.textCols);
    }
    done[b.x.file.getId()] = b.x.stamp;
    imported.push(TABS[b.kind] + ' (' + clean.rows.length + ' rows)');
  });
  props.setProperty('drive_done', JSON.stringify(done));
  var msg = imported.length ? 'Imported: ' + imported.join(', ') : 'No recognised files';
  try { SpreadsheetApp.getActive().toast(msg, 'BPCL Automation', 8); } catch (e) {}
  return msg;
}

/** Converts an .xlsx to a temporary Google Sheet, reads the first tab, deletes the temp copy. */
function readXlsxViaDrive_(file) {
  var meta = { name: 'tmp_import_' + file.getName(), mimeType: MimeType.GOOGLE_SHEETS };
  var tmp = Drive.Files.create ? Drive.Files.create(meta, file.getBlob())               // Drive API v3
                               : Drive.Files.insert({ title: meta.name, mimeType: meta.mimeType }, file.getBlob(), { convert: true }); // v2
  try {
    var rng = SpreadsheetApp.openById(tmp.id).getSheets()[0].getDataRange();
    // Power BI exports carry wrong cell formats (e.g. a date format on "Stock %"),
    // so read plain values; dates/times are converted by column name in cleanRows_.
    rng.setNumberFormat('General');
    SpreadsheetApp.flush();
    return rng.getValues().map(function (row) {
      return row.map(function (v) { return v instanceof Date ? dateToSerial_(v) : v; });
    });
  } finally {
    DriveApp.getFileById(tmp.id).setTrashed(true);
  }
}

function dateToSerial_(d) {
  var tz = Session.getScriptTimeZone();
  var p = Utilities.formatDate(d, tz, 'yyyy,MM,dd,HH,mm,ss').split(',').map(Number);
  return (Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / 86400000 + (p[3] * 3600 + p[4] * 60 + p[5]) / 86400;
}


// ------------------------- Shared helpers -------------------------

function detectKind_(header, fileName) {
  var h = header.map(function (x) { return String(x || '').trim().toLowerCase(); });
  var has = function (t) { return h.indexOf(t) >= 0; };
  if (has('no. of on-boarded mpds') || has('avg ro utilization %')) return 'uptime';
  if (h.some(function (x) { return /^12 am %$/.test(x); })) return 'hourly';
  if (has('local tank id') || has('morning_status')) return 'onboarded';
  if (has('stock %') && has('date')) return 'last';
  var n = String(fileName || '').toLowerCase();
  if (/uptime/.test(n)) return 'uptime';
  if (/hourly/.test(n)) return 'hourly';
  if (/onboard/.test(n)) return 'onboarded';
  if (/last|latest/.test(n)) return 'last';
  return null;
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** Excel serial number → yyyy-mm-dd or hh:mm:ss (same rule the dashboard uses) */
function serialToText_(v, kind) {
  if (kind === 'time') {
    var s = Math.round(v * 86400) % 86400;
    return pad2_(Math.floor(s / 3600)) + ':' + pad2_(Math.floor(s / 60) % 60) + ':' + pad2_(s % 60);
  }
  var d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function dateKindOf_(head) {
  var h = String(head).trim();
  if (/time$/i.test(h)) return 'time';
  if (/(date|updated)/i.test(h)) return 'date';
  return null;
}

function roKey_(v) {
  return String(v == null ? '' : v).trim().replace(/\.0+$/, '');
}

/** Removes footer rows, keeps only RO rows (optionally only ROs in roSet / territories in terrSet), finds text columns. */
function cleanRows_(aoa, roSet, terrSet) {
  var header = (aoa[0] || []).map(function (x) { return String(x == null ? '' : x); });
  while (header.length && header[header.length - 1] === '') header.pop();
  var roCol = header.map(function (x) { return x.trim().toLowerCase(); })
    .findIndex(function (x) { return x === 'ro id' || x === 'roid'; });
  if (roCol < 0) roCol = 0;
  var terrCol = header.map(function (x) { return x.trim().toLowerCase(); }).indexOf('territory');
  var dk = header.map(dateKindOf_);
  var rows = [];
  for (var i = 1; i < aoa.length; i++) {
    var r = aoa[i] || [], ro = roKey_(r[roCol]);
    if (!/^\d{3,10}$/.test(ro)) continue;           // "Total", blank, "Applied filters…"
    if (roSet && !roSet[ro]) continue;
    if (terrSet && terrCol >= 0 && !terrSet[String(r[terrCol] || '').trim().toLowerCase()]) continue;
    var row = [];
    for (var c = 0; c < header.length; c++) {
      var v = r[c] == null ? '' : r[c];
      if (typeof v === 'number' && dk[c] === 'time' && v >= 0 && v < 1) v = serialToText_(v, 'time');
      else if (typeof v === 'number' && dk[c] === 'date' && v > 20000 && v < 80000) v = serialToText_(v, 'date');
      row.push(v);
    }
    rows.push(row);
  }
  var textCols = [];
  for (var c2 = 0; c2 < header.length; c2++) {
    for (var j = 0; j < rows.length; j++) {
      if (typeof rows[j][c2] === 'string' && rows[j][c2] !== '') { textCols.push(c2); break; }
    }
  }
  return { header: header, rows: rows, textCols: textCols };
}

function readUptimeRoIds_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(TABS.uptime);
  if (!sh || sh.getLastRow() < 2) return [];
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (x) { return String(x).trim().toLowerCase(); });
  var col = head.indexOf('ro id'); if (col < 0) col = head.indexOf('roid'); if (col < 0) col = 0;
  return sh.getRange(2, col + 1, sh.getLastRow() - 1, 1).getValues()
    .map(function (r) { return roKey_(r[0]); })
    .filter(function (x) { return /^\d{3,10}$/.test(x); });
}

function getOrCreateTab_(name) {
  var ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** Clears the tab, sizes the grid exactly, marks text columns as plain text, writes the header. */
function prepareTab_(sh, header, totalRows, textCols) {
  sh.clear();
  var needRows = Math.max(2, totalRows + 1), needCols = Math.max(1, header.length);
  var maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
  if (maxR < needRows) sh.insertRowsAfter(maxR, needRows - maxR);
  else if (maxR > needRows) sh.deleteRows(needRows + 1, maxR - needRows);
  if (maxC < needCols) sh.insertColumnsAfter(maxC, needCols - maxC);
  else if (maxC > needCols) sh.deleteColumns(needCols + 1, maxC - needCols);
  sh.getRange(1, 1, needRows, needCols).setNumberFormat('General');
  (textCols || []).forEach(function (c) { sh.getRange(1, c + 1, needRows, 1).setNumberFormat('@'); });
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#0b3a6f').setFontColor('#ffffff');
  sh.setFrozenRows(1);
}

function stampImport_(kind, rows) {
  PropertiesService.getDocumentProperties()
    .setProperty('import_' + kind, JSON.stringify({ rows: rows, at: Date.now() }));
}
