/* ==========================================================================
   xlsx_worker.js — reads Excel / Google Sheet workbooks OFF the main thread
   --------------------------------------------------------------------------
   Reading a large workbook (uptime + last stock + hourly stock + onboarded
   tanks) used to freeze the page for several seconds. This worker does the
   heavy XLSX parsing in the background and streams the rows back in small
   chunks, so the dashboard stays responsive.

   Sheet roles (by sheet name, case-insensitive):
     tank_latest    → "Last updated stock", "Latest stock", "Current stock"
     tank_hourly    → "Stock hourly", "Hourly stock", "Hourly"
     tank_onboarded → "Onboarded tanks", "Tank mapping", "Tank master"
     mapping        → "TE-SO Map", "EO-SO Map"
     history        → "HistoryArchive"
     other          → everything else (the uptime sheet is chosen on the page)

   Message in : { id, buf: ArrayBuffer }
   Messages out: { id, type: 'names', sheets: [{ name, kind }] }
                 { id, type: 'rows', name, kind, rows: [...] }   (chunks)
                 { id, type: 'done' } | { id, type: 'error', message }
   Tank sheets come back as objects (header → value, plus _ro/_tank/_product);
   all other sheets as arrays of arrays (same as sheet_to_json header:1).
   ========================================================================== */
/* global XLSX */
importScripts('xlsx.full.min.js');

var CHUNK = 3000;

function classify(name) {
  var n = String(name || '').trim().toLowerCase();
  if (/^(te|eo)[-\s]?so\s*map/.test(n)) return 'mapping';
  if (n === 'historyarchive' || n === 'history archive') return 'history';
  if (/(last|latest|current)\s*(updated)?\s*stock/.test(n)) return 'tank_latest';
  if (/hourly/.test(n)) return 'tank_hourly';
  if (/onboard|tank\s*(map|master|list)/.test(n)) return 'tank_onboarded';
  return 'other';
}

var KEYS = {
  tank_hourly: { ro: ['RO ID', 'ROID'], tank: ['Tank ID', 'Local tank id'], product: ['Product Name', 'Product_Name'] },
  tank_latest: { ro: ['RO ID', 'ROID'], tank: null, product: ['Product Name', 'Product_Name'] },
  tank_onboarded: { ro: ['ROID', 'RO ID'], tank: ['Local tank id', 'Tank ID'], product: ['Product_Name', 'Product Name'] }
};

var ALLOWED_COLS = {
  tank_latest: ['RO ID', 'ROID', 'Retail Outlet', 'RO_Name', 'Territory', 'Sales Area', 'Salesarea', 'RA Vendor', 'RA_Vendor', 'State', 'Product Name', 'Product_Name', 'Stock', 'On-boarded Tankage', 'On-Line Tankage', 'Status'],
  tank_hourly: ['RO ID', 'ROID', 'Product Name', 'Product_Name', 'Tank ID', 'Local tank id', 'Dip_Time', 'Dip Time', 'Dip', 'Dip (cm)', 'Volume', 'Stock (L)'],
  tank_onboarded: ['ROID', 'RO ID', 'Local tank id', 'Tank ID', 'Product_Name', 'Product Name', 'Status', 'Retail Outlet', 'RO_Name', 'Territory', 'Sales Area', 'Salesarea', 'RA Vendor', 'RA_Vendor', 'State']
};

function pick(row, names) {
  if (!names) return '';
  for (var i = 0; i < names.length; i++) {
    var v = row[names[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}
function key(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

function fixDates(row) {
  // Google/Excel date cells arrive as serial numbers: show them as text
  Object.keys(row).forEach(function (k) {
    var v = row[k];
    if (typeof v !== 'number') return;
    if (/time$/i.test(k) && v >= 0 && v < 1) row[k] = XLSX.SSF.format('hh:mm:ss', v);
    else if (/(date|updated)/i.test(k) && v > 20000 && v < 80000) row[k] = XLSX.SSF.format('yyyy-mm-dd', v);
  });
}

function tankObjects(ws, kind) {
  var src = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  var cfg = KEYS[kind];
  var allowed = ALLOWED_COLS[kind] || null;
  var out = [];
  for (var i = 0; i < src.length; i++) {
    var s = src[i];
    var ro = key(pick(s, cfg.ro)).replace(/\.0+$/, '');
    if (!/^\d{3,10}$/.test(ro)) continue; // skip Power BI footer notes / blank lines
    var r = {};
    if (allowed) {
      for (var j = 0; j < allowed.length; j++) {
        var col = allowed[j];
        if (s[col] !== undefined && s[col] !== null) r[col] = s[col];
      }
    } else {
      for (var k in s) r[String(k).trim()] = s[k];
    }
    r._ro = ro;
    r._product = key(pick(s, cfg.product));
    if (cfg.tank) r._tank = key(pick(s, cfg.tank)).replace(/\.0+$/, '');
    fixDates(r);
    out.push(r);
    src[i] = null;
  }
  src = null;
  return out;
}

function streamSheet(id, name, kind, ws) {
  var rows = kind.indexOf('tank_') === 0 ? tankObjects(ws, kind) : XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (!rows.length) self.postMessage({ id: id, type: 'rows', name: name, kind: kind, rows: [] });
  for (var i = 0; i < rows.length; i += CHUNK) {
    self.postMessage({ id: id, type: 'rows', name: name, kind: kind, rows: rows.slice(i, i + CHUNK) });
  }
}

self.onmessage = function (e) {
  var id = e.data && e.data.id;
  try {
    var u8 = new Uint8Array(e.data.buf);
    // Sheet names only (fast), then read in two stages:
    //  stage 1 — uptime / mapping / history sheets (small) → dashboard updates in ~1 s
    //  stage 2 — tank sheets one by one (large hourly sheet last)
    var names = XLSX.read(u8, { type: 'array', bookSheets: true }).SheetNames;
    var sheets = names.map(function (n) { return { name: n, kind: classify(n) }; });
    self.postMessage({ id: id, type: 'names', sheets: sheets });

    var light = sheets.filter(function (s) { return s.kind.indexOf('tank_') !== 0; });
    if (light.length) {
      var wb1 = XLSX.read(u8, { type: 'array', dense: true, sheets: light.map(function (s) { return s.name; }) });
      light.forEach(function (s) { streamSheet(id, s.name, s.kind, wb1.Sheets[s.name]); });
      wb1 = null;
    }
    self.postMessage({ id: id, type: 'stage', stage: 1 });

    var order = { tank_latest: 0, tank_onboarded: 1, tank_hourly: 2 };
    sheets.filter(function (s) { return s.kind.indexOf('tank_') === 0; })
      .sort(function (a, b) { return order[a.kind] - order[b.kind]; })
      .forEach(function (s) {
        var wb = XLSX.read(u8, { type: 'array', dense: true, sheets: [s.name] });
        streamSheet(id, s.name, s.kind, wb.Sheets[s.name]);
      });
    self.postMessage({ id: id, type: 'done' });
  } catch (err) {
    self.postMessage({ id: id, type: 'error', message: (err && err.message) || String(err) });
  }
};
