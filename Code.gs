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

    // ---- Tank Stock Google Drive Sync (RO-Wise Tank Stock menu) ----
    if (action === 'getTankStockFiles') {
      const folderId = (e.parameter && e.parameter.folderId) || '17C1s0lqJ0jCZqc_xmRB2H_YGOro1pUk4';
      const folder = DriveApp.getFolderById(folderId);
      const files = folder.getFiles();
      const result = {};
      while (files.hasNext()) {
        const file = files.next();
        const name = file.getName();
        if (name.endsWith('.xlsx')) {
          result[name] = {
            name: name,
            id: file.getId(),
            updated: file.getLastUpdated().toISOString(),
            base64: Utilities.base64Encode(file.getBlob().getBytes())
          };
        }
      }
      return json_({success: true, folderId: folderId, files: result});
    }

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

    // ---- WhatsApp dealer alerts (Monitoring menu) ----
    if (action === 'waStatus') {
      return json_(waStatus_(payload.date || today_()));
    }
    if (action === 'saveContacts') {
      return json_(waSaveContacts_(payload));
    }
    if (action === 'sendAlerts') {
      return json_(waSendAlerts_(payload));
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

/* =====================================================================
 * WhatsApp dealer alerts (Monitoring menu)
 * ---------------------------------------------------------------------
 * Script Properties (Project Settings > Script properties):
 *   WA_TOKEN            WhatsApp Cloud API permanent access token   (required)
 *   WA_PHONE_NUMBER_ID  Sender phone-number ID from Meta            (required)
 *   WA_TEMPLATE         Approved template name (default ro_automation_alert)
 *   WA_LANG             Template language code (default en)
 *   WA_MODE             template (default) | text  (text only works inside a 24h chat window)
 *   WA_DAILY_LIMIT      Max alerts per day for the whole territory (default 300)
 *   ADMIN_KEY           Secret needed to upload dealer numbers from the dashboard
 *   WA_TEST_NUMBER      Your own number, used by testWhatsAppAlert()
 *
 * Safety: the dashboard's API key is visible in public JS, so this backend
 *  - only sends to numbers in its own DealerContacts sheet (looked up by ROID),
 *  - builds the message text itself from the alert type and equipment counts,
 *  - de-duplicates per ROID + alert type per day and caps alerts per RO and per day,
 *  - never returns full phone numbers (masked only).
 * ===================================================================== */

const WA = {
  CONTACTS_SHEET: 'DealerContacts',
  LOG_SHEET: 'WhatsAppAlertLog',
  GRAPH_VERSION: 'v21.0',
  KINDS: ['OFFLINE', 'MPD', 'ATG', 'MPD_ATG', 'PARTIAL'],
  SIGNATURE: 'BPCL Belgaum Territory Retail Engineering.'
};

function waProps_() {
  const p = PropertiesService.getScriptProperties();
  return {
    token: p.getProperty('WA_TOKEN') || '',
    phoneId: p.getProperty('WA_PHONE_NUMBER_ID') || '',
    template: p.getProperty('WA_TEMPLATE') || 'ro_automation_alert',
    lang: p.getProperty('WA_LANG') || 'en',
    mode: (p.getProperty('WA_MODE') || 'template').toLowerCase(),
    dailyLimit: Number(p.getProperty('WA_DAILY_LIMIT') || 300),
    adminKey: p.getProperty('ADMIN_KEY') || '',
    testNumber: p.getProperty('WA_TEST_NUMBER') || ''
  };
}

function waSheets_() {
  const ss = getSpreadsheet_();
  let c = ss.getSheetByName(WA.CONTACTS_SHEET);
  if (!c) {
    c = ss.insertSheet(WA.CONTACTS_SHEET);
    c.appendRow(['ROID', 'Dealer Name', 'WhatsApp Number', 'Active', 'Updated At', 'Updated By']);
    c.setFrozenRows(1);
    c.getRange('C:C').setNumberFormat('@'); // keep numbers as text
  }
  let l = ss.getSheetByName(WA.LOG_SHEET);
  if (!l) {
    l = ss.insertSheet(WA.LOG_SHEET);
    l.appendRow(['Date', 'Time', 'ROID', 'Outlet', 'Alert Type', 'Status', 'Previous Status', 'To', 'Result', 'Detail', 'Message ID', 'Sent By']);
    l.setFrozenRows(1);
  }
  return { contacts: c, log: l };
}

function waNormPhone_(v) {
  let d = String(v == null ? '' : v).replace(/\.0+$/, '').replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '0') d = d.substring(1);
  if (d.length === 10) d = '91' + d;
  return (d.length >= 11 && d.length <= 15) ? d : '';
}
function waMask_(p) { p = String(p || ''); return p.length > 6 ? p.substring(0, 4) + 'XXXX' + p.substring(p.length - 3) : p; }
function waClean_(s, max) {
  // Template parameters may not contain new lines, tabs or more than 4 consecutive spaces
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().substring(0, max || 200);
}
function waNum_(n) { n = Number(n); return isFinite(n) && n >= 0 && n < 1000 ? n : 0; }
function waFmt_(n) { return Math.abs(n - Math.round(n)) < 0.001 ? String(Math.round(n)) : n.toFixed(2); }
function waIsInt_(n) { return Math.abs(n - Math.round(n)) < 0.001; }

function waContacts_() {
  const sh = waSheets_().contacts;
  const v = sh.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < v.length; i++) {
    const roid = String(v[i][0] || '').trim().replace(/\.0+$/, '');
    const phone = waNormPhone_(v[i][2]);
    if (!roid || !phone) continue;
    const active = String(v[i][3] === '' ? 'Y' : v[i][3]).toUpperCase().charAt(0) !== 'N';
    map[roid] = { roid: roid, dealerName: String(v[i][1] || ''), phone: phone, active: active };
  }
  return map;
}

function waTodayLog_(date) {
  const sh = waSheets_().log;
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) {
    if (normalizeDate_(v[i][0]) !== date) continue;
    out.push({
      date: date,
      time: v[i][1] instanceof Date ? Utilities.formatDate(v[i][1], Session.getScriptTimeZone(), 'HH:mm') : String(v[i][1] || '').substring(0, 5),
      roid: String(v[i][2]), kind: String(v[i][4]), result: String(v[i][8]), detail: String(v[i][9] || '')
    });
  }
  return out;
}

// ---- Message rules (kept identical to whatsapp_alerts.js) ----
function waAction_(a) {
  const offM = waNum_(a.offMpd), onbM = waNum_(a.onbMpd), offT = waNum_(a.offTnk), onbT = waNum_(a.onbTnk);
  const mpd = (waIsInt_(offM) && waIsInt_(onbM)
      ? waFmt_(offM) + ' of ' + waFmt_(onbM) + ' MPD' + (onbM === 1 ? ' is' : 's are') + ' not communicating.'
      : 'MPD data is not communicating fully.') +
    ' Please Turn ON all MPDs and make sure they are connected to the automation system.';
  const atg = (waIsInt_(offT) && waIsInt_(onbT)
      ? 'ATG data for ' + waFmt_(offT) + ' of ' + waFmt_(onbT) + ' tank' + (onbT === 1 ? '' : 's') + ' is not communicating.'
      : 'ATG (tank gauge) data is not communicating fully.') +
    ' Please restart the ATG console and check that it is powered ON.';
  switch (a.kind) {
    case 'OFFLINE': return 'Your outlet automation is showing OFFLINE. Please make sure the internet connection is working (router/modem ON, SIM or broadband active with data balance) and that the automation FCC is switched ON and the HOS status is green.';
    case 'MPD': return mpd;
    case 'ATG': return atg;
    case 'MPD_ATG': return mpd + ' Also: ' + atg;
    default: return 'Some equipment at your outlet is not communicating. Please check that all MPDs and the ATG console are switched ON and connected.';
  }
}

function waBuild_(a) {
  // Template variables: {{1}} RO name, {{2}} CC code, {{3}} current status,
  // {{4}} yesterday's status, {{5}} time stamp, {{6}} action needed
  const curr = waClean_(a.currStatus, 40);
  const prev = waClean_(a.prevStatus, 40) || 'not available';
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'h:mm a, d MMM');
  const action = waAction_(a);
  const params = [waClean_(a.outletName, 80), waClean_(a.roid, 20), curr, prev, stamp, waClean_(action, 600)];
  const text = [
    '*BPCL Automation Alert*',
    'RO: ' + params[0] + ' (CC ' + params[1] + ')',
    'Current Status: ' + curr,
    'Yesterday Status: was ' + prev + ' as of ' + stamp,
    '',
    '*Action needed:* ' + action,
    '',
    'If the problem continues after these checks, or there is any technical fault in the equipment, please raise a complaint with the Automation vendor / automation helpdesk immediately and share the complaint number with your Sales Officer.',
    '',
    '– ' + WA.SIGNATURE
  ].join('\n');
  return { params: params, text: text };
}

function waSendOne_(cfg, to, msg) {
  const url = 'https://graph.facebook.com/' + WA.GRAPH_VERSION + '/' + cfg.phoneId + '/messages';
  const body = cfg.mode === 'text'
    ? { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: msg.text, preview_url: false } }
    : { messaging_product: 'whatsapp', to: to, type: 'template', template: {
        name: cfg.template, language: { code: cfg.lang },
        components: [{ type: 'body', parameters: msg.params.map(function (t) { return { type: 'text', text: t }; }) }]
      } };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + cfg.token }, payload: JSON.stringify(body)
  });
  const code = res.getResponseCode();
  let json = {};
  try { json = JSON.parse(res.getContentText()); } catch (e) { /* ignore */ }
  if (code >= 200 && code < 300 && json.messages && json.messages[0]) {
    return { ok: true, id: json.messages[0].id };
  }
  const err = (json.error && (json.error.error_data && json.error.error_data.details || json.error.message)) || ('HTTP ' + code);
  return { ok: false, detail: String(err).substring(0, 200) };
}

function waStatus_(date) {
  const cfg = waProps_();
  const contacts = waContacts_();
  const log = waTodayLog_(date);
  return {
    success: true,
    configured: !!(cfg.token && cfg.phoneId),
    message: (cfg.token && cfg.phoneId) ? '' : 'Set WA_TOKEN and WA_PHONE_NUMBER_ID in Script Properties',
    template: cfg.mode === 'text' ? '(text mode)' : cfg.template,
    sentToday: log.filter(function (e) { return e.result === 'sent'; }).length,
    contacts: Object.keys(contacts).map(function (k) {
      const c = contacts[k]; return { roid: c.roid, dealerName: c.dealerName, masked: waMask_(c.phone), active: c.active };
    }),
    log: log
  };
}

function waSaveContacts_(payload) {
  const cfg = waProps_();
  if (!cfg.adminKey) throw new Error('Set ADMIN_KEY in Script Properties before uploading contacts.');
  if (String(payload.adminKey || '') !== cfg.adminKey) throw new Error('Wrong admin key.');
  const rows = Array.isArray(payload.contacts) ? payload.contacts : [];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = waSheets_().contacts;
    const v = sh.getDataRange().getValues();
    const idx = {};
    for (let i = 1; i < v.length; i++) idx[String(v[i][0]).replace(/\.0+$/, '')] = i + 1;
    let saved = 0;
    const append = [];
    rows.forEach(function (r) {
      const roid = String(r.roid || '').trim().replace(/\.0+$/, '');
      const phone = waNormPhone_(r.phone);
      if (!roid || !phone) return;
      const vals = [roid, waClean_(r.dealerName, 80), phone, r.active === false ? 'N' : 'Y', new Date(), waClean_(payload.updatedBy || 'Dashboard', 40)];
      if (idx[roid]) sh.getRange(idx[roid], 1, 1, vals.length).setValues([vals]);
      else append.push(vals);
      saved++;
    });
    if (append.length) sh.getRange(sh.getLastRow() + 1, 1, append.length, append[0].length).setValues(append);
    return { success: true, saved: saved };
  } finally {
    lock.releaseLock();
  }
}

function waSendAlerts_(payload) {
  const cfg = waProps_();
  if (!cfg.token || !cfg.phoneId) return { success: false, message: 'WhatsApp is not configured (WA_TOKEN / WA_PHONE_NUMBER_ID).' };
  const date = today_();
  const alerts = (Array.isArray(payload.alerts) ? payload.alerts : []).slice(0, 50);
  const maxPerRo = Math.max(1, Math.min(5, Number(payload.maxPerRo || 2)));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheets = waSheets_();
    const contacts = waContacts_();
    const log = waTodayLog_(date);
    const sentKeys = {}, perRo = {};
    let sentToday = 0;
    log.forEach(function (e) {
      if (e.result !== 'sent') return;
      sentKeys[e.roid + '|' + e.kind] = true;
      perRo[e.roid] = (perRo[e.roid] || 0) + 1;
      sentToday++;
    });
    const results = [], rowsOut = [];
    const tz = Session.getScriptTimeZone();
    alerts.forEach(function (a) {
      const roid = String(a.roid || '').trim();
      const kind = WA.KINDS.indexOf(a.kind) >= 0 ? a.kind : 'PARTIAL';
      const res = { roid: roid, kind: kind };
      const c = contacts[roid];
      let msg = null;
      if (!c || !c.active) { res.result = 'no_contact'; }
      else if (sentKeys[roid + '|' + kind]) { res.result = 'duplicate'; }
      else if ((perRo[roid] || 0) >= maxPerRo || sentToday >= cfg.dailyLimit) { res.result = 'limit'; }
      else {
        msg = waBuild_(Object.assign({}, a, { kind: kind, roid: roid }));
        const r = waSendOne_(cfg, c.phone, msg);
        if (r.ok) {
          res.result = 'sent'; res.id = r.id;
          sentKeys[roid + '|' + kind] = true; perRo[roid] = (perRo[roid] || 0) + 1; sentToday++;
        } else { res.result = 'failed'; res.detail = r.detail; }
      }
      results.push(res);
      if (res.result !== 'duplicate') {
        rowsOut.push([date, Utilities.formatDate(new Date(), tz, 'HH:mm'), roid, waClean_(a.outletName, 80), kind,
          waClean_(a.currStatus, 40), waClean_(a.prevStatus, 40), c ? waMask_(c.phone) : '', res.result, res.detail || '', res.id || '', waClean_(a.sentBy, 40)]);
      }
    });
    if (rowsOut.length) sheets.log.getRange(sheets.log.getLastRow() + 1, 1, rowsOut.length, rowsOut[0].length).setValues(rowsOut);
    return { success: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

/** Run once from the editor to create the WhatsApp sheets. */
function setupWhatsAppAlerts() {
  waSheets_();
  Logger.log('DealerContacts and WhatsAppAlertLog sheets ready in ' + getSpreadsheet_().getUrl());
}

/** Sends a sample OFFLINE alert to WA_TEST_NUMBER so you can check the template. */
function testWhatsAppAlert() {
  const cfg = waProps_();
  const to = waNormPhone_(cfg.testNumber);
  if (!to) throw new Error('Set WA_TEST_NUMBER in Script Properties');
  const msg = waBuild_({ kind: 'OFFLINE', roid: '116218', outletName: 'TEST OUTLET', currStatus: 'Offline', prevStatus: 'Fully Online', helpdesk: 'the Pine Labs automation helpdesk' });
  Logger.log(JSON.stringify(waSendOne_(cfg, to, msg)));
}
