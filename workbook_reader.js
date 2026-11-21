/* ==========================================================================
   workbook_reader.js — fast, non-blocking workbook reading for the whole app
   --------------------------------------------------------------------------
   WorkbookReader.read(arrayBuffer) → Promise<{
       sheets: [{ name, kind }],          // in workbook order
       rows:   { [sheetName]: rows },      // see xlsx_worker.js for the format
       byKind(kind) → first sheet's rows of that kind (or null)
       nameOf(kind) → that sheet's name
   }>
   Uses a background Web Worker (xlsx_worker.js). Falls back to reading on
   the page when workers are unavailable (e.g. opened straight from disk).

   WorkbookReader.fingerprint(arrayBuffer) → quick content hash, used to skip
   re-processing when the Google Sheet has not changed since the last sync.
   ========================================================================== */
(function () {
  'use strict';

  var worker = null, workerBroken = false, seq = 0;
  var pending = {};

  function getWorker() {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker('xlsx_worker.js');
      worker.onmessage = onMessage;
      worker.onerror = function (e) {
        console.warn('[WorkbookReader] worker failed, using page fallback', e && e.message);
        workerBroken = true;
        try { worker.terminate(); } catch (x) { /* ignore */ }
        worker = null;
        Object.keys(pending).forEach(function (id) {
          var p = pending[id]; delete pending[id];
          readOnPage(p.buf).then(p.resolve, p.reject);
        });
      };
    } catch (e) {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  function result(sheets, rows) {
    return {
      sheets: sheets,
      rows: rows,
      byKind: function (kind) {
        var s = sheets.find(function (x) { return x.kind === kind; });
        return s ? rows[s.name] : null;
      },
      nameOf: function (kind) {
        var s = sheets.find(function (x) { return x.kind === kind; });
        return s ? s.name : null;
      }
    };
  }

  function onMessage(e) {
    var m = e.data, p = pending[m.id];
    if (!p) return;
    if (m.type === 'names') {
      p.sheets = m.sheets;
      m.sheets.forEach(function (s) { p.rows[s.name] = []; });
    } else if (m.type === 'rows') {
      var arr = p.rows[m.name] || (p.rows[m.name] = []);
      for (var i = 0; i < m.rows.length; i++) arr.push(m.rows[i]);
    } else if (m.type === 'stage') {
      if (p.onStage1) { try { p.onStage1(result(p.sheets || [], p.rows)); } catch (x) { console.error(x); } }
    } else if (m.type === 'done') {
      delete pending[m.id];
      p.resolve(result(p.sheets || [], p.rows));
    } else if (m.type === 'error') {
      delete pending[m.id];
      p.reject(new Error(m.message));
    }
  }

  // ---------- fallback: same output, read on the page ----------
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
  function pickVal(row, names) {
    if (!names) return '';
    for (var i = 0; i < names.length; i++) { var v = row[names[i]]; if (v !== undefined && v !== null && v !== '') return v; }
    return '';
  }
  function key(v) { return String(v == null ? '' : v).trim().toUpperCase(); }
  function readOnPage(buf) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          var wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
          var sheets = wb.SheetNames.map(function (n) { return { name: n, kind: classify(n) }; });
          var rows = {};
          sheets.forEach(function (s) {
            var ws = wb.Sheets[s.name];
            if (s.kind.indexOf('tank_') !== 0) { rows[s.name] = XLSX.utils.sheet_to_json(ws, { header: 1 }); return; }
            var cfg = KEYS[s.kind];
            rows[s.name] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true }).map(function (src) {
              var r = {};
              for (var k in src) r[String(k).trim()] = src[k];
              r._ro = key(pickVal(r, cfg.ro)).replace(/\.0+$/, '');
              r._product = key(pickVal(r, cfg.product));
              if (cfg.tank) r._tank = key(pickVal(r, cfg.tank)).replace(/\.0+$/, '');
              return r;
            }).filter(function (r) { return /^\d{3,10}$/.test(r._ro); });
          });
          resolve(result(sheets, rows));
        } catch (e) { reject(e); }
      }, 0);
    });
  }

  /**
   * read(buf, { onStage1(book) }) — onStage1 fires as soon as the small sheets
   * (uptime / mapping / history) are ready; the promise resolves when the tank
   * sheets are read too.
   */
  function read(buf, opts) {
    opts = opts || {};
    var w = getWorker();
    if (!w) return readOnPage(buf);
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      // keep a copy for the fallback path; the worker gets its own (transferred) copy
      var copy = buf.slice(0);
      pending[id] = { resolve: resolve, reject: reject, rows: {}, sheets: null, buf: copy, onStage1: opts.onStage1 };
      w.postMessage({ id: id, buf: buf }, [buf]);
    });
  }

  function fingerprint(buf) {
    // FNV-1a over 32-bit words — ~10 ms for a 10 MB workbook
    var n = buf.byteLength, words = new Uint32Array(buf, 0, n >> 2), h = 0x811c9dc5;
    for (var i = 0; i < words.length; i++) { h ^= words[i]; h = Math.imul(h, 0x01000193); }
    var tail = new Uint8Array(buf, n & ~3);
    for (var j = 0; j < tail.length; j++) { h ^= tail[j]; h = Math.imul(h, 0x01000193); }
    return n + ':' + (h >>> 0).toString(16);
  }

  /** Sheet → array of objects (first row = headers), like XLSX.utils.sheet_to_json(ws) */
  function aoaToObjects(aoa, defval) {
    if (!aoa || !aoa.length) return [];
    var head = (aoa[0] || []).map(function (h) { return h == null ? '' : String(h); });
    var out = [];
    for (var i = 1; i < aoa.length; i++) {
      var row = aoa[i];
      if (!row || !row.some(function (c) { return c !== undefined && c !== null && c !== ''; })) continue;
      var o = {};
      head.forEach(function (h, j) {
        if (!h) return;
        if (row[j] !== undefined && row[j] !== null) o[h] = row[j];
        else if (defval !== undefined) o[h] = defval;
      });
      out.push(o);
    }
    return out;
  }

  window.WorkbookReader = { read: read, fingerprint: fingerprint, aoaToObjects: aoaToObjects };
})();
