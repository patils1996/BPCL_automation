/* ==========================================================================
   share_kit.js — Universal Share for every page + KPI detail pop-ups
   --------------------------------------------------------------------------
   • Floating "Share" button on every tab
   • Share sheet: WhatsApp text · Share / download as Image (PNG) ·
     Share / download as PDF · Copy text · native share (phones)
   • KPI detail modal (Partially Online / Offline / …): Image + Share buttons
   Images are rendered with html2canvas and PDFs with jsPDF (both bundled
   locally and lazy-loaded so the first page load stays fast and offline-safe).
   ========================================================================== */
(function () {
  'use strict';

  var TERRITORY = 'Belgaum Retail Territory';
  var MAX_TEXT = 3500;
  var MAX_ROWS = 40;
  var libs = {};

  /* ---------------------------------------------------------------- utils */
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m, t) { if (typeof window.showToast === 'function') window.showToast(m, t || 'success'); }
  function pct(v) { return (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(1) + '%'; }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function stamp(d) {
    d = d || new Date();
    var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    return String(d.getDate()).padStart(2, '0') + '-' + MONTHS[d.getMonth()] + '-' + d.getFullYear() + ' ' +
      (h % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ap;
  }
  function fileStamp(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
      '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }
  function slug(s) { return clean(s).replace(/\(.*?\)/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Report'; }
  function userName() {
    var u = window.currentUser;
    return (u && (u.username || u.role)) || '';
  }

  function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve();
    if (libs[src]) return libs[src];
    libs[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { delete libs[src]; reject(new Error('Could not load ' + src + ' — check your connection and reload.')); };
      document.head.appendChild(s);
    });
    return libs[src];
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  function canShareFiles(sample) {
    try {
      var f = sample || new File(['x'], 'x.png', { type: 'image/png' });
      return !!(navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------- page contexts */
  function activePanel() { return document.querySelector('.tab-panel.active'); }
  function activeTitle() {
    var item = document.querySelector('.sidebar .menu-item.active span');
    return item ? clean(item.textContent) : 'Dashboard';
  }

  function headerText(title, sub) {
    return ['*BPCL ' + TERRITORY + '*', '*' + title + '*' + (sub ? ' — ' + sub : ''), '_' + stamp() + '_', ''];
  }

  function tableText(table, limit) {
    if (!table) return [];
    var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (th) { return clean(th.textContent); });
    var rows = Array.prototype.filter.call(table.querySelectorAll('tbody tr'), function (tr) {
      return tr.offsetParent !== null && tr.children.length > 1;
    });
    var out = [];
    rows.slice(0, limit || MAX_ROWS).forEach(function (tr, i) {
      var cells = Array.prototype.map.call(tr.children, function (td) { return clean(td.textContent); });
      if (!cells.join('')) return;
      var first = cells[0];
      var rest = cells.slice(1).map(function (c, j) {
        var h = heads[j + 1];
        return h && /^[\d.,%+\-\s—/]+$/.test(c) ? h + ': ' + c : c;
      }).filter(function (c) { return c && c !== '—' && c !== '-'; });
      out.push((/total/i.test(first) ? '*' + first + '*' : (i + 1) + '. ' + first) + (rest.length ? ' — ' + rest.join(' · ') : ''));
    });
    if (rows.length > (limit || MAX_ROWS)) out.push('…and ' + (rows.length - (limit || MAX_ROWS)) + ' more (see image / PDF)');
    return out;
  }

  function kpiText(panel) {
    var out = [];
    var cards = panel.querySelectorAll('.kpi-card-v2, .mis-card, .dem-kpi, .kpi-card, .stat-card, .summary-card, .ts-kpi');
    Array.prototype.forEach.call(cards, function (c) {
      if (c.offsetParent === null) return;
      var lines = String(c.innerText || '').split('\n').map(clean).filter(Boolean);
      if (lines.length >= 2) out.push('• ' + lines[0] + ': *' + lines[1] + '*' + (lines[2] && lines[2].length < 40 ? ' (' + lines[2] + ')' : ''));
    });
    return out.slice(0, 12);
  }

  function summaryArrayText(arr, label) {
    if (!Array.isArray(arr) || !arr.length) return [];
    var out = ['*' + label + ' wise uptime*'];
    arr.slice().sort(function (a, b) { return (b.uptime || 0) - (a.uptime || 0); }).forEach(function (a, i) {
      out.push((i + 1) + '. ' + a.key + ' — ' + pct(a.uptime) + ' (ROs ' + a.totalROs + ' · 🟢' + a.fullyOnline + ' 🟡' + a.partiallyOnline + ' 🔴' + a.offline + ')');
    });
    return out;
  }

  function roListText(list, title, limit) {
    var out = ['*' + title + ' (' + list.length + ')*'];
    list.slice(0, limit || MAX_ROWS).forEach(function (r, i) {
      var up = r.uptime != null && isFinite(r.uptime) ? ' — ' + (r.uptime * 100).toFixed(0) + '%' : '';
      out.push((i + 1) + '. ' + r.roid + ' ' + clean(r.outlet_name) + ' (' + (r.sales_area || '-') + ')' + up + (r.eo_name && r.eo_name !== 'Unmapped' ? ' · TE ' + r.eo_name : ''));
    });
    if (list.length > (limit || MAX_ROWS)) out.push('…and ' + (list.length - (limit || MAX_ROWS)) + ' more (see image / PDF)');
    return out;
  }

  function overviewText() {
    var m = window.overallMetrics || {};
    var out = [];
    if (m.totalROs) {
      out.push('Total ROs: *' + m.totalROs + '*');
      out.push('🟢 Fully Online: *' + m.fullyOnline + '*');
      out.push('🟡 Partially Online: *' + m.partiallyOnline + '*');
      out.push('🔴 Offline: *' + m.offline + '*');
      out.push('');
      out.push('⚙️ MPD uptime: *' + pct(m.mpdUptime) + '* (' + m.sumOnlMpd + '/' + m.sumOnbMpd + ')');
      out.push('🛢️ ATG uptime: *' + pct(m.tankUptime) + '* (' + m.sumOnlTnk + '/' + m.sumOnbTnk + ')');
      out.push('📊 Overall uptime: *' + pct(m.uptime) + '*');
      out.push('');
      out = out.concat(summaryArrayText(window.salesAreaSummary, 'Sales area'));
    }
    return out;
  }

  var PAGE_TEXT = {
    'tab-overview': function (p) { return window.dashboardMode === 'evcs' ? kpiText(p) : overviewText(); },
    'tab-sales-area': function () { return summaryArrayText(window.salesAreaSummary, 'Sales area'); },
    'tab-vendor-summary': function () { return summaryArrayText(window.vendorSummary, 'Vendor'); },
    'tab-eo-summary': function () { return summaryArrayText(window.eoSummary, 'TE'); },
    'tab-so-summary': function () { return summaryArrayText(window.soSummary, 'SO'); },
    'tab-day-monitoring': function () {
      var l = window.dayMonitoringFilteredList || [];
      var off = l.filter(function (r) { return r.status === 'Offline'; });
      var part = l.filter(function (r) { return r.status !== 'Offline'; });
      return ['Sites needing action: *' + l.length + '* (🔴 ' + off.length + ' offline · 🟡 ' + part.length + ' partial)', '']
        .concat(roListText(off, '🔴 Offline', 25), [''], roListText(part, '🟡 Partially online', 25));
    },
    'tab-outlets-status': function (p) {
      var l = window.outletsStatusFilteredList;
      return Array.isArray(l) && l.length && l[0].roid ? roListText(l, 'Outlets') : null;
    },
    'tab-day-end-mis': function () {
      var t = window.DayEndMIS && window.DayEndMIS.buildText();
      return t ? { raw: t } : null;
    }
  };

  function pageText(panel, title) {
    var id = panel ? panel.id : '';
    var builder = PAGE_TEXT[id];
    var body = null;
    try { body = builder ? builder(panel) : null; } catch (e) { console.warn('[Share] text builder failed', e); }
    if (body && body.raw) return body.raw.slice(0, MAX_TEXT);
    if (!body || !body.length) {
      body = kpiText(panel);
      var table = Array.prototype.find.call(panel.querySelectorAll('table'), function (t) { return t.offsetParent !== null && t.querySelector('tbody tr'); });
      var tt = tableText(table, 30);
      if (body.length && tt.length) body.push('');
      body = body.concat(tt);
    }
    if (!body.length) body = ['Open the attached image / PDF for details.'];
    var txt = headerText(title).concat(body).join('\n');
    return txt.length > MAX_TEXT ? txt.slice(0, MAX_TEXT - 40) + '\n…(trimmed — see image / PDF)' : txt;
  }

  function modalText() {
    var title = clean(($('modal-title') || {}).textContent || 'Outlet list');
    var list = (typeof activeModalData !== 'undefined' && Array.isArray(activeModalData)) ? activeModalData : [];
    var type = (typeof activeModalType !== 'undefined') ? String(activeModalType) : '';
    var body;
    if (list.length && list[0] && list[0].roid !== undefined && type.indexOf('evcs_') !== 0) {
      body = roListText(list, title.replace(/\s*\(\d+ Outlets\)/, ''));
    } else {
      body = tableText($('modal-data-table'));
    }
    var txt = headerText('Dashboard', title).concat(body).join('\n');
    return txt.length > MAX_TEXT ? txt.slice(0, MAX_TEXT - 40) + '\n…(trimmed — see image / PDF)' : txt;
  }

  function pageContext() {
    var panel = activePanel();
    if (!panel) return null;
    var title = activeTitle();
    return {
      kind: 'page',
      target: panel,
      title: title,
      subtitle: 'BPCL ' + TERRITORY + ' · Automation Dashboard',
      text: function () { return pageText(panel, title); },
      file: 'BPCL_' + slug(title) + '_' + fileStamp()
    };
  }

  function modalContext() {
    var card = document.querySelector('#kpi-details-modal .modal-container');
    var title = clean(($('modal-title') || {}).textContent || 'Outlet list');
    return {
      kind: 'modal',
      target: card,
      title: title,
      subtitle: 'BPCL ' + TERRITORY + ' · Dashboard drill-down',
      text: modalText,
      file: 'BPCL_' + slug(title) + '_' + fileStamp()
    };
  }

  /* ------------------------------------------------------------ capture */
  function brandHeader(doc, ctx, width) {
    var h = doc.createElement('div');
    h.setAttribute('style', [
      'display:flex', 'align-items:center', 'gap:16px', 'padding:16px 22px', 'margin:0 0 18px 0',
      'background:linear-gradient(120deg,#001a3d 0%,#002a5c 55%,#0b55a8 100%)', 'border-radius:14px',
      'border-bottom:5px solid #fcb813', 'color:#fff', 'font-family:Inter,Segoe UI,Arial,sans-serif', 'box-sizing:border-box',
      'width:100%'
    ].join(';'));
    var narrow = width < 560;
    h.innerHTML =
      '<div style="flex:1 1 auto;min-width:0;border-left:4px solid #fcb813;padding-left:14px;">' +
      '<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#fcb813;font-weight:800;">Bharat Petroleum · ' + esc(TERRITORY) + '</div>' +
      '<div style="font-size:' + (narrow ? 18 : 24) + 'px;font-weight:800;line-height:1.2;margin-top:3px;">' + esc(ctx.title) + '</div>' +
      '<div style="font-size:12px;color:#c9d6ea;margin-top:3px;">Automation · IFMS · Uptime Monitoring</div></div>' +
      (narrow ? '' : '<div style="text-align:right;flex:0 0 auto;font-size:12px;color:#dbe4f0;line-height:1.5;">' +
        '<div style="font-weight:800;color:#fff;font-size:13px;">' + esc(stamp()) + '</div>' +
        (userName() ? '<div>By ' + esc(userName()) + '</div>' : '') + '</div>');
    if (narrow) {
      var s = doc.createElement('div');
      s.setAttribute('style', 'font-size:11px;color:#5b6b84;margin:-10px 0 14px 4px;font-family:Inter,Arial,sans-serif;');
      s.textContent = stamp() + (userName() ? ' · ' + userName() : '');
      return [h, s];
    }
    return [h];
  }
  function brandFooter(doc) {
    var f = doc.createElement('div');
    f.setAttribute('style', 'margin-top:18px;padding-top:10px;border-top:2px solid #fcb813;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font:600 11px Inter,Segoe UI,Arial,sans-serif;color:#5b6b84;');
    f.innerHTML = '<span>BPCL ' + esc(TERRITORY) + ' · Automation Uptime Dashboard</span><span>Generated ' + esc(stamp()) + '</span>';
    return f;
  }

  var HIDE_BTN = /export|download|upload|sync|refresh|share|save|print|import|csv|image|install|configure|reset/i;

  async function capture(ctx) {
    await loadScript('html2canvas.min.js', 'html2canvas');
    var el = ctx.target;
    if (!el) throw new Error('Nothing to capture on this page.');

    // Find scroll areas so the image contains the full tables, not just the visible part
    var extraW = 0, extraH = 0;
    var marked = [];
    el.querySelectorAll('*').forEach(function (n) {
      if (n.scrollHeight > n.clientHeight + 4 || n.scrollWidth > n.clientWidth + 4) {
        var cs = getComputedStyle(n);
        if (/(auto|scroll|hidden)/.test(cs.overflowX + ' ' + cs.overflowY) && n.clientHeight > 0) {
          n.setAttribute('data-sk-expand', '1');
          marked.push(n);
          extraH += Math.max(0, n.scrollHeight - n.clientHeight);
          extraW = Math.max(extraW, n.scrollWidth - n.clientWidth);
        }
      }
    });
    el.setAttribute('data-sk-target', '1');

    var baseW = Math.max(el.clientWidth, el.getBoundingClientRect().width);
    var width = Math.round(Math.min(Math.max(baseW + extraW + 44, 360), 2800));
    var estH = el.scrollHeight + extraH + 260;
    var dpr = window.devicePixelRatio || 1;
    var scale = Math.min(dpr > 1 ? 2 : 1.5, Math.sqrt(15000000 / (width * estH)));
    scale = Math.max(0.5, scale);
    var bg = getComputedStyle(document.body).backgroundColor;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var paper = dark ? '#0d1a2d' : '#f3f6fa';

    try {
      return await window.html2canvas(el, {
        scale: scale,
        useCORS: true,
        logging: false,
        backgroundColor: paper || bg || '#ffffff',
        windowWidth: Math.max(document.documentElement.clientWidth, width + 40),
        scrollX: 0,
        scrollY: -window.scrollY,
        onclone: function (doc) {
          var t = doc.querySelector('[data-sk-target]');
          if (!t) return;
          doc.querySelectorAll('[data-sk-expand]').forEach(function (n) {
            n.style.maxHeight = 'none'; n.style.height = 'auto'; n.style.overflow = 'visible';
          });
          // Pop-ups: take the card out of the fixed, centred overlay
          var ov = t.closest('.modal-overlay');
          if (ov) {
            ov.style.position = 'absolute'; ov.style.inset = 'auto'; ov.style.top = '0'; ov.style.left = '0';
            ov.style.display = 'block'; ov.style.height = 'auto'; ov.style.padding = '0'; ov.style.background = 'transparent';
            ov.style.backdropFilter = 'none'; ov.style.overflow = 'visible';
            t.style.margin = '0'; t.style.transform = 'none'; t.style.maxHeight = 'none'; t.style.animation = 'none';
          }
          t.classList.add('active');
          t.style.width = width + 'px';
          t.style.maxWidth = 'none';
          t.style.boxSizing = 'border-box';
          t.style.padding = '22px';
          t.style.background = paper;
          t.style.overflow = 'visible';
          // Hide action buttons & anything marked as not-for-sharing
          t.querySelectorAll('[data-share-hide], .sk-fab, input[type=file]').forEach(function (n) { n.style.display = 'none'; });
          t.querySelectorAll('button, a.btn-primary, a.btn-secondary, .mis-upload').forEach(function (b) {
            if (HIDE_BTN.test(b.textContent || '') || HIDE_BTN.test(b.getAttribute('title') || '')) b.style.display = 'none';
          });
          // Pagination controls & page-size pickers are noise in a snapshot
          t.querySelectorAll('.pagination, .pagination-controls, [id$="-pagination"]').forEach(function (n) { n.style.display = 'none'; });
          // Ellipsis-clipped cells: allow wrap so names are readable
          t.querySelectorAll('td').forEach(function (td) { td.style.textOverflow = 'clip'; });
          var nodes = brandHeader(doc, ctx, width);
          for (var i = nodes.length - 1; i >= 0; i--) t.insertBefore(nodes[i], t.firstChild);
          t.appendChild(brandFooter(doc));
        }
      });
    } finally {
      el.removeAttribute('data-sk-target');
      marked.forEach(function (n) { n.removeAttribute('data-sk-expand'); });
    }
  }

  function canvasToBlob(canvas, type, q) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('Image encoding failed')); }, type, q);
      else {
        try {
          var bin = atob(canvas.toDataURL(type, q).split(',')[1]); var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: type }));
        } catch (e) { reject(e); }
      }
    });
  }

  /** Find a calm horizontal line (row gap) near y so PDF pages don't cut through text. */
  function findCut(ctx2d, w, y, maxBack) {
    try {
      var data = ctx2d.getImageData(0, Math.max(0, y - maxBack), w, maxBack).data;
      var step = Math.max(4, Math.floor(w / 160)) * 4;
      for (var row = maxBack - 1; row >= 0; row--) {
        var off = row * w * 4, r0 = data[off], g0 = data[off + 1], b0 = data[off + 2], same = true;
        for (var x = 0; x < w * 4; x += step) {
          if (Math.abs(data[off + x] - r0) + Math.abs(data[off + x + 1] - g0) + Math.abs(data[off + x + 2] - b0) > 24) { same = false; break; }
        }
        if (same) return y - maxBack + row;
      }
    } catch (e) { /* tainted canvas — fall through */ }
    return y;
  }

  async function makePdf(canvas, ctx) {
    await loadScript('jspdf.umd.min.js', 'jspdf');
    var JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF) throw new Error('PDF library failed to load.');
    var landscape = canvas.width > canvas.height * 0.9;
    var pdf = new JsPDF({ orientation: landscape ? 'l' : 'p', unit: 'pt', format: 'a4', compress: true });
    var pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    var m = 20, foot = 18;
    var imgW = pw - m * 2;
    var ratio = imgW / canvas.width;
    var sliceMax = Math.floor((ph - m * 2 - foot) / ratio);
    var c2d = canvas.getContext('2d');
    var cuts = [];
    var y = 0;
    while (y < canvas.height) {
      var end = Math.min(canvas.height, y + sliceMax);
      if (end < canvas.height) {
        var cut = findCut(c2d, canvas.width, end, Math.min(Math.floor(sliceMax * 0.25), 220));
        if (cut > y + sliceMax * 0.5) end = cut;
      }
      cuts.push([y, end]);
      y = end;
    }
    pdf.setProperties({ title: ctx.title + ' — BPCL ' + TERRITORY, subject: 'Automation Dashboard', author: userName() || 'BPCL', creator: 'BPCL Automation Dashboard' });
    cuts.forEach(function (c, i) {
      if (i) pdf.addPage();
      var hpx = c[1] - c[0];
      var part = document.createElement('canvas');
      part.width = canvas.width; part.height = hpx;
      var p2 = part.getContext('2d');
      p2.fillStyle = '#ffffff'; p2.fillRect(0, 0, part.width, part.height);
      p2.drawImage(canvas, 0, c[0], canvas.width, hpx, 0, 0, canvas.width, hpx);
      pdf.addImage(part.toDataURL('image/jpeg', 0.9), 'JPEG', m, m, imgW, hpx * ratio, undefined, 'FAST');
      // footer
      pdf.setDrawColor(252, 184, 19); pdf.setLineWidth(1.2);
      pdf.line(m, ph - m - 8, pw - m, ph - m - 8);
      pdf.setFontSize(8); pdf.setTextColor(91, 107, 132);
      pdf.text('BPCL ' + TERRITORY + '  |  ' + ctx.title + '  |  ' + stamp(), m, ph - m + 2);
      pdf.text('Page ' + (i + 1) + ' of ' + cuts.length, pw - m, ph - m + 2, { align: 'right' });
    });
    return { blob: pdf.output('blob'), pages: cuts.length };
  }

  /* --------------------------------------------------------- share sheet */
  var S = { ctx: null, canvas: null, png: null, pdf: null, pdfPages: 0, busy: null, seq: 0 };

  function buildSheet() {
    if ($('sk-sheet')) return;
    var wrap = document.createElement('div');
    wrap.id = 'sk-sheet';
    wrap.className = 'sk-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'sk-title');
    wrap.style.display = 'none';
    wrap.innerHTML =
      '<div class="sk-card">' +
      '  <div class="sk-head">' +
      '    <div class="sk-head-txt"><span class="sk-kicker">Share report</span><h3 id="sk-title">Dashboard</h3><span class="sk-sub" id="sk-sub"></span></div>' +
      '    <button type="button" class="sk-close" id="sk-close" aria-label="Close">' + ICON.x + '</button>' +
      '  </div>' +
      '  <div class="sk-body">' +
      '    <div class="sk-preview" id="sk-preview">' +
      '      <div class="sk-preview-status" id="sk-status"><span class="sk-spin"></span><span>Preparing image &amp; PDF…</span></div>' +
      '      <img id="sk-img" alt="Preview of the shared image" hidden>' +
      '    </div>' +
      '    <div class="sk-meta" id="sk-meta"></div>' +
      '    <div class="sk-section-label">Send</div>' +
      '    <div class="sk-grid">' +
      tile('sk-wa', 'sk-t-wa', ICON.wa, 'WhatsApp', 'Text summary') +
      tile('sk-share-img', 'sk-t-navy', ICON.img, 'Share Image', 'PNG via apps') +
      tile('sk-share-pdf', 'sk-t-red', ICON.pdf, 'Share PDF', 'A4 report') +
      tile('sk-share-txt', 'sk-t-blue', ICON.share, 'More apps', 'Mail, Teams…') +
      '    </div>' +
      '    <div class="sk-section-label">Save</div>' +
      '    <div class="sk-grid sk-grid-save">' +
      tile('sk-dl-img', 'sk-t-soft', ICON.dl, 'Download Image', '.png') +
      tile('sk-dl-pdf', 'sk-t-soft', ICON.dl, 'Download PDF', '.pdf') +
      tile('sk-copy', 'sk-t-soft', ICON.copy, 'Copy Text', 'for any chat') +
      '    </div>' +
      '    <details class="sk-text-wrap"><summary>Edit message text</summary><textarea id="sk-text" spellcheck="false"></textarea></details>' +
      '    <p class="sk-hint" id="sk-hint"></p>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);

    $('sk-close').addEventListener('click', close);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && wrap.style.display !== 'none') close(); });
    $('sk-wa').addEventListener('click', shareWhatsApp);
    $('sk-share-img').addEventListener('click', function () { shareBlob('png'); });
    $('sk-share-pdf').addEventListener('click', function () { shareBlob('pdf'); });
    $('sk-share-txt').addEventListener('click', shareTextNative);
    $('sk-dl-img').addEventListener('click', function () { download('png'); });
    $('sk-dl-pdf').addEventListener('click', function () { download('pdf'); });
    $('sk-copy').addEventListener('click', copyText);
  }

  function tile(id, tone, icon, label, sub) {
    return '<button type="button" class="sk-tile ' + tone + '" id="' + id + '">' +
      '<span class="sk-tile-ic">' + icon + '</span><span class="sk-tile-txt"><b>' + label + '</b><small>' + sub + '</small></span></button>';
  }

  var ICON = {
    x: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    wa: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12.04 2a9.9 9.9 0 0 0-8.5 14.98L2 22l5.17-1.5A9.9 9.9 0 1 0 12.04 2zm0 18.1a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.07.89.9-3-.2-.31a8.2 8.2 0 1 1 6.85 3.75zm4.5-6.14c-.25-.12-1.46-.72-1.69-.8-.23-.08-.39-.12-.56.12-.16.25-.64.8-.79.97-.14.16-.29.19-.54.06a6.7 6.7 0 0 1-3.32-2.9c-.25-.43.25-.4.72-1.33.08-.16.04-.3-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.41-.56-.42h-.48a.92.92 0 0 0-.66.31 2.79 2.79 0 0 0-.87 2.07c0 1.22.89 2.4 1.01 2.57.12.16 1.75 2.67 4.24 3.75 1.58.68 2.2.74 2.99.62.48-.07 1.46-.6 1.67-1.18.2-.58.2-1.07.14-1.18-.06-.1-.22-.16-.47-.29z"/></svg>',
    img: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="M21 15l-5-5L5 21"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h1.5a1.5 1.5 0 0 1 0 3H8v-3zm0 3v2M13 13v5h1a2.5 2.5 0 0 0 0-5h-1zM18 13h-2v5M16 15.5h1.6"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>',
    dl: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  };

  function setStatus(state, msg) {
    var st = $('sk-status'), img = $('sk-img');
    if (state === 'busy') { st.hidden = false; st.innerHTML = '<span class="sk-spin"></span><span>' + esc(msg || 'Preparing image & PDF…') + '</span>'; img.hidden = true; }
    else if (state === 'error') { st.hidden = false; st.innerHTML = '<span class="sk-err">!</span><span>' + esc(msg) + '</span>'; img.hidden = true; }
    else { st.hidden = true; img.hidden = false; }
    ['sk-share-img', 'sk-share-pdf', 'sk-dl-img', 'sk-dl-pdf'].forEach(function (id) {
      var b = $(id); if (b) b.disabled = state !== 'ready';
    });
  }

  async function prepare() {
    var seq = ++S.seq;
    S.canvas = null; S.png = null; S.pdf = null; S.pdfPages = 0;
    setStatus('busy');
    $('sk-meta').textContent = '';
    // Let the sheet paint before the heavy capture work starts
    await new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 60); }); });
    try {
      var canvas = await capture(S.ctx);
      if (seq !== S.seq) return;
      S.canvas = canvas;
      S.png = await canvasToBlob(canvas, 'image/png');
      if (seq !== S.seq) return;
      var url = URL.createObjectURL(S.png);
      var img = $('sk-img');
      if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
      img.dataset.url = url; img.src = url;
      setStatus('busy', 'Building PDF…');
      $('sk-img').hidden = false;
      var pdf = await makePdf(canvas, S.ctx);
      if (seq !== S.seq) return;
      S.pdf = pdf.blob; S.pdfPages = pdf.pages;
      setStatus('ready');
      $('sk-meta').textContent = canvas.width + ' × ' + canvas.height + ' px image · ' + kb(S.png.size) + '  |  PDF ' + pdf.pages + ' page' + (pdf.pages > 1 ? 's' : '') + ' · ' + kb(S.pdf.size);
    } catch (e) {
      console.error('[Share] capture failed', e);
      if (seq === S.seq) setStatus('error', 'Could not create the image: ' + e.message + ' — WhatsApp text and Copy still work.');
    }
  }
  function kb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function open(ctx) {
    if (!ctx || !ctx.target) { toast('Nothing to share on this page yet', 'error'); return; }
    buildSheet();
    S.ctx = ctx;
    $('sk-title').textContent = ctx.title;
    $('sk-sub').textContent = ctx.subtitle + ' · ' + stamp();
    var txt = '';
    try { txt = ctx.text(); } catch (e) { txt = 'BPCL ' + TERRITORY + ' — ' + ctx.title; }
    $('sk-text').value = txt;
    var files = canShareFiles();
    $('sk-share-img').style.display = files ? '' : 'none';
    $('sk-share-pdf').style.display = files ? '' : 'none';
    $('sk-share-txt').style.display = navigator.share ? '' : 'none';
    $('sk-hint').textContent = files
      ? 'Share Image / PDF opens your phone\'s share menu — pick WhatsApp, Gmail, Teams or any app.'
      : 'On this device, download the image or PDF and attach it in WhatsApp Web / e-mail. WhatsApp sends the text summary.';
    var sheet = $('sk-sheet');
    sheet.style.display = 'flex';
    document.body.classList.add('sk-open');
    requestAnimationFrame(function () { sheet.classList.add('sk-visible'); });
    prepare();
  }

  function close() {
    var sheet = $('sk-sheet');
    if (!sheet) return;
    S.seq++;
    sheet.classList.remove('sk-visible');
    document.body.classList.remove('sk-open');
    setTimeout(function () { sheet.style.display = 'none'; }, 200);
  }

  function blobFor(kind) {
    return kind === 'pdf' ? { blob: S.pdf, name: S.ctx.file + '.pdf', type: 'application/pdf' }
      : { blob: S.png, name: S.ctx.file + '.png', type: 'image/png' };
  }

  async function shareBlob(kind) {
    var b = blobFor(kind);
    if (!b.blob) { toast('Still preparing — try again in a moment', 'error'); return; }
    var file = new File([b.blob], b.name, { type: b.type });
    if (canShareFiles(file)) {
      try {
        await navigator.share({ files: [file], title: S.ctx.title + ' — BPCL', text: firstLines($('sk-text').value, 8) });
        toast('Shared ' + (kind === 'pdf' ? 'PDF' : 'image'));
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.warn('[Share] native share failed', e);
      }
    }
    downloadBlob(b.blob, b.name);
    toast((kind === 'pdf' ? 'PDF' : 'Image') + ' downloaded — attach it in WhatsApp or e-mail');
  }

  function download(kind) {
    var b = blobFor(kind);
    if (!b.blob) { toast('Still preparing — try again in a moment', 'error'); return; }
    downloadBlob(b.blob, b.name);
    toast('Downloaded ' + b.name);
  }

  function firstLines(t, n) { return String(t || '').split('\n').slice(0, n).join('\n'); }

  function shareWhatsApp() {
    var txt = $('sk-text').value || '';
    window.open('https://wa.me/?text=' + encodeURIComponent(txt), '_blank', 'noopener');
  }
  async function shareTextNative() {
    try { await navigator.share({ title: S.ctx.title + ' — BPCL', text: $('sk-text').value }); }
    catch (e) { if (!e || e.name !== 'AbortError') copyText(); }
  }
  async function copyText() {
    var txt = $('sk-text').value;
    try { await navigator.clipboard.writeText(txt); toast('Text copied — paste it in WhatsApp or e-mail'); }
    catch (e) {
      var ta = $('sk-text');
      ta.closest('details').open = true; ta.focus(); ta.select();
      try { document.execCommand('copy'); toast('Text copied'); } catch (e2) { toast('Select the text and copy it manually', 'error'); }
    }
  }

  /* ------------------------------------------- KPI modal: quick image */
  async function modalImage() {
    var btn = $('modal-image-btn');
    try {
      if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
      var ctx = modalContext();
      var canvas = await capture(ctx);
      var blob = await canvasToBlob(canvas, 'image/png');
      downloadBlob(blob, ctx.file + '.png');
      toast('Image downloaded: ' + ctx.file + '.png');
    } catch (e) {
      console.error(e); toast('Image failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    }
  }

  /* ---------------------------------------------------------------- FAB */
  function buildFab() {
    if ($('sk-fab')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'sk-fab';
    b.className = 'sk-fab';
    b.setAttribute('aria-label', 'Share this page');
    b.title = 'Share this page (WhatsApp, Image, PDF)';
    b.innerHTML = ICON.share + '<span>Share</span>';
    b.addEventListener('click', function () { open(pageContext()); });
    document.body.appendChild(b);
  }

  function init() {
    buildFab();
    var mi = $('modal-image-btn'), ms = $('modal-share-btn');
    if (mi) mi.addEventListener('click', modalImage);
    if (ms) ms.addEventListener('click', function () { open(modalContext()); });
  }

  window.ShareKit = { open: open, page: function () { open(pageContext()); }, modal: function () { open(modalContext()); }, capture: capture, pageText: function () { var c = pageContext(); return c ? c.text() : ''; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
