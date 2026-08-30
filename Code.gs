/**
 * BPCL Automation Dashboard - Shared Day Monitoring backend
 *
 * Deploy as: Web app
 * Execute as: Me
 * Who has access: Anyone
 *
 * This script stores today's Dependency/Responsibility + Remarks in a
 * shared Google Sheet and creates a daily CSV snapshot in Google Drive.
 */

const CONFIG = {
  API_KEY: 'BPCL_Auto1312',
  DATA_SHEET: 'DayMonitoring',
  SNAPSHOT_SHEET: 'DayMonitoringSnapshots',
  DRIVE_FOLDER: 'BPCL Uptime Backups',
  DRIVE_FOLDER_ID: '1x3giWLl-yft4JiXrVwaJURbDi7UYkvG-'
};

function doGet(e) {
  try {
    validateKey_(e && e.parameter ? e.parameter.apiKey : '');
    const action = (e.parameter && e.parameter.action) || 'get';
    if (action !== 'get') return json_({success:false, message:'Unsupported GET action'});

    const date = (e.parameter && e.parameter.date) || today_();
    const territory = (e.parameter && e.parameter.territory) || 'Belgaum';
    return json_({success:true, rows:getRows_(date, territory)});
  } catch (err) {
    return json_({success:false, message:String(err.message || err)});
  }
}

function doPost(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    validateKey_(params.apiKey);

    const payload = JSON.parse(params.payload || '{}');
    const action = payload.action || params.action || 'saveRows';

    if (action === 'saveRows') {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      upsertRows_(rows);
      return json_({success:true, saved:rows.length});
    }

    if (action === 'saveDaily') {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      upsertRows_(rows);
      const date = payload.date || today_();
      const territory = payload.territory || 'Belgaum';
      const file = createDailySnapshot_(date, territory);
      return json_({
        success:true,
        saved:rows.length,
        fileId:file.id,
        fileName:file.name,
        fileUrl:file.url
      });
    }

    return json_({success:false, message:'Unsupported POST action: ' + action});
  } catch (err) {
    return json_({success:false, message:String(err.message || err)});
  }
}

function validateKey_(key) {
  if (!CONFIG.API_KEY || CONFIG.API_KEY === 'CHANGE_THIS_KEY') {
    throw new Error('Configure API_KEY in Code.gs before deployment.');
  }
  if (String(key || '') !== String(CONFIG.API_KEY)) {
    throw new Error('Unauthorized request.');
  }
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');

  if (id) return SpreadsheetApp.openById(id);

  const ss = SpreadsheetApp.create('BPCL Automation Shared Day Monitoring');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  setupSheets_(ss);
  return ss;
}

function setupSheets_(ss) {
  let sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) sheet = ss.insertSheet(CONFIG.DATA_SHEET);
  const headers = [
    'Date','ROID','Outlet Name','Sales Area','Vendor','Status','IOT/WFCC',
    'Uptime','Offline MPD','Offline Tank','Responsibility','Remark',
    'Updated By','Updated At','Territory','Target Date'
  ];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    const firstRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (firstRow.indexOf('Target Date') === -1) {
      sheet.getRange(1, firstRow.length + 1).setValue('Target Date');
    }
  }

  let snapshots = ss.getSheetByName(CONFIG.SNAPSHOT_SHEET);
  if (!snapshots) snapshots = ss.insertSheet(CONFIG.SNAPSHOT_SHEET);
  if (snapshots.getLastRow() === 0) {
    snapshots.appendRow(['Date','Territory','File Name','File ID','Drive URL','Created At']);
    snapshots.setFrozenRows(1);
  }
}

function getRows_(date, territory) {
  const ss = getSpreadsheet_();
  setupSheets_(ss);
  const sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const obj = {};
    headers.forEach((h, j) => obj[h] = values[i][j]);
    const rowDate = normalizeDate_(obj['Date']);
    const rowTerritory = String(obj['Territory'] || '');
    if (rowDate === date && (!territory || rowTerritory === territory)) {
      rows.push({
        date: rowDate,
        roid: String(obj['ROID'] || ''),
        outletName: String(obj['Outlet Name'] || ''),
        salesArea: String(obj['Sales Area'] || ''),
        vendor: String(obj['Vendor'] || ''),
        status: String(obj['Status'] || ''),
        iot: String(obj['IOT/WFCC'] || ''),
        uptime: Number(obj['Uptime'] || 0),
        offlineMpd: Number(obj['Offline MPD'] || 0),
        offlineTank: Number(obj['Offline Tank'] || 0),
        responsibility: String(obj['Responsibility'] || ''),
        remark: String(obj['Remark'] || ''),
        targetDate: String(obj['Target Date'] || ''),
        updatedBy: String(obj['Updated By'] || ''),
        updatedAt: obj['Updated At'] instanceof Date ? obj['Updated At'].toISOString() : String(obj['Updated At'] || ''),
        territory: rowTerritory
      });
    }
  }
  return rows;
}

function upsertRows_(rows) {
  if (!rows.length) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const ss = getSpreadsheet_();
    setupSheets_(ss);
    const sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    const data = sheet.getDataRange().getValues();
    const existing = new Map();

    for (let i = 1; i < data.length; i++) {
      const key = normalizeDate_(data[i][0]) + '|' + String(data[i][1]) + '|' + String(data[i][14] || '');
      existing.set(key, i + 1);
    }

    rows.forEach(r => {
      const date = r.date || today_();
      const territory = r.territory || 'Belgaum';
      const values = [
        date,
        String(r.roid || ''),
        String(r.outletName || ''),
        String(r.salesArea || ''),
        String(r.vendor || ''),
        String(r.status || ''),
        String(r.iot || ''),
        Number(r.uptime || 0),
        Number(r.offlineMpd || 0),
        Number(r.offlineTank || 0),
        String(r.responsibility || ''),
        String(r.remark || ''),
        String(r.updatedBy || 'Unknown User'),
        r.updatedAt ? new Date(r.updatedAt) : new Date(),
        territory,
        String(r.targetDate || '')
      ];
      const key = date + '|' + String(r.roid || '') + '|' + territory;
      const rowNo = existing.get(key);
      if (rowNo) sheet.getRange(rowNo, 1, 1, values.length).setValues([values]);
      else {
        sheet.appendRow(values);
        existing.set(key, sheet.getLastRow());
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function createDailySnapshot_(date, territory) {
  const rows = getRows_(date, territory);
  const folder = getOrCreateFolder_(CONFIG.DRIVE_FOLDER);
  const fileName = 'Automation_Day_Monitoring_' + date + '.csv';

  const headers = [
    'Date','ROID','Outlet Name','Sales Area','Vendor','Status','IOT/WFCC',
    'Uptime %','Offline MPD','Offline Tank','Responsibility','Remark',
    'Target Date','Updated By','Updated At','Territory'
  ];

  const lines = [headers.map(csv_).join(',')];
  rows.forEach(r => {
    lines.push([
      r.date, r.roid, r.outletName, r.salesArea, r.vendor, r.status, r.iot,
      (Number(r.uptime || 0) * 100).toFixed(2) + '%',
      r.offlineMpd, r.offlineTank, r.responsibility, r.remark,
      r.targetDate || '',
      r.updatedBy, r.updatedAt, r.territory
    ].map(csv_).join(','));
  });

  const blob = Utilities.newBlob(
    lines.join('\r\n'),
    'text/csv',
    fileName
  );

  // Replace the same day's snapshot rather than generating endless duplicates.
  const old = folder.getFilesByName(fileName);
  while (old.hasNext()) old.next().setTrashed(true);

  const file = folder.createFile(blob);
  const ss = getSpreadsheet_();
  setupSheets_(ss);
  const snapshotSheet = ss.getSheetByName(CONFIG.SNAPSHOT_SHEET);
  const snapshotValues = snapshotSheet.getDataRange().getValues();
  for (let i = snapshotValues.length - 1; i >= 1; i--) {
    if (normalizeDate_(snapshotValues[i][0]) === date && String(snapshotValues[i][1] || '') === String(territory || '')) {
      snapshotSheet.deleteRow(i + 1);
    }
  }
  snapshotSheet.appendRow([
    date, territory, fileName, file.getId(), file.getUrl(), new Date()
  ]);

  return {id:file.getId(), name:fileName, url:file.getUrl()};
}

function getOrCreateFolder_(name) {
  if (CONFIG.DRIVE_FOLDER_ID) {
    try {
      return DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    } catch (e) {
      // Fall back to name-based creation if the configured folder is inaccessible.
    }
  }
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function normalizeDate_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(value || '').trim();
  if (!s) return '';
  // Handles common ISO timestamp values.
  if (s.indexOf('T') > 0) return s.substring(0, 10);
  return s.substring(0, 10);
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function csv_(value) {
  const s = String(value == null ? '' : value);
  return '"' + s.replace(/"/g, '""') + '"';
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Creates the automatic daily Google Drive backup trigger.
 * The trigger runs independently of the GitHub Pages website/browser.
 * Run setupBackend() once after deployment; it installs this trigger.
 */
function installDailyBackupTrigger_() {
  const handler = 'automaticDailyBackup';
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .nearMinute(55)
    .create();
}

/**
 * Runs automatically every day around 11:55 PM in the Apps Script project
 * timezone. It creates/replaces the day's Day Monitoring archive in Drive.
 */
function automaticDailyBackup() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const date = today_();
    const ss = getSpreadsheet_();
    setupSheets_(ss);
    const sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    const values = sheet.getDataRange().getValues();

    // Back up every territory represented in the shared data for today.
    const territories = {};
    for (let i = 1; i < values.length; i++) {
      if (normalizeDate_(values[i][0]) === date) {
        territories[String(values[i][14] || 'Belgaum')] = true;
      }
    }

    const names = Object.keys(territories);
    if (!names.length) {
      // Still create an archive marker so the trigger can be monitored.
      const folder = getOrCreateFolder_(CONFIG.DRIVE_FOLDER);
      const fileName = 'Automation_Day_Monitoring_' + date + '_NO_DATA.txt';
      const old = folder.getFilesByName(fileName);
      while (old.hasNext()) old.next().setTrashed(true);
      folder.createFile(fileName, 'Automatic backup ran successfully at ' + new Date().toISOString() + '\nNo shared Day Monitoring rows were available for ' + date + '.');
      return;
    }

    names.forEach(function(territory) {
      createDailySnapshot_(date, territory);
    });
  } finally {
    lock.releaseLock();
  }
}

/** Run this manually to test the Drive archive without waiting for the trigger. */
function testDailyBackupNow() {
  automaticDailyBackup();
  Logger.log('Manual automatic-backup test completed for ' + today_());
}

/**
 * Run this ONCE manually from the Apps Script editor after adding your API key.
 * It creates the shared spreadsheet immediately and stores its ID.
 */
function setupBackend() {
  const ss = getSpreadsheet_();
  setupSheets_(ss);
  Logger.log('Shared spreadsheet: ' + ss.getUrl());
  Logger.log('Drive folder: ' + getOrCreateFolder_(CONFIG.DRIVE_FOLDER).getUrl());
  installDailyBackupTrigger_();
  Logger.log('Automatic daily backup trigger installed for approximately 11:55 PM.');
}
