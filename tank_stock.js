/* ==========================================================================
   BPCL RO-WISE TANK STOCK MONITORING & GOOGLE DRIVE SYNC ENGINE
   Target Google Drive Folder: 17C1s0lqJ0jCZqc_xmRB2H_YGOro1pUk4
   Target Local Stream Path: G:\My Drive\TL-PATIL- 2026\Technology\Test tanks status
   ========================================================================== */

(function() {
  'use strict';

  const GDRIVE_CONFIG = {
    url: 'https://drive.google.com/open?id=17C1s0lqJ0jCZqc_xmRB2H_YGOro1pUk4&usp=drive_fs',
    folderId: '17C1s0lqJ0jCZqc_xmRB2H_YGOro1pUk4',
    folderName: 'Test tanks status',
    localPathWindows: 'G:\\My Drive\\TL-PATIL- 2026\\Technology\\Test tanks status',
    requiredFiles: ['Stock hourly.xlsx', 'Last updated stock.xlsx', 'Onboarded tanks.xlsx']
  };

  const FILES = {
    'Stock hourly.xlsx': 'hourly',
    'Onboarded tanks.xlsx': 'onboarded',
    'Last updated stock.xlsx': 'latest'
  };

  const IDB_NAME = 'bpcl_tank_stock_store';
  const IDB_STORE = 'handles';
  const IDB_KEY = 'gdrive_folder_handle';

  let data = { hourly: [], onboarded: [], latest: [] };
  let folderHandle = null;
  let refreshTimer = null;
  let selectedRO = null;
  let allRO = [];
  let fileTimestamps = {};
  let source = '';          // 'sheet' | 'files' | ''
  let lastSyncAt = 0;
  let renderPending = false;

  // Older versions copied the whole tank data into localStorage (slow, ~5 MB limit) — free that space
  try { localStorage.removeItem('bpcl_tank_stock_cache'); localStorage.removeItem('bpcl_tank_mapping_v1'); } catch (e) { /* ignore */ }

  function statusLine(label) {
    return `<span class="ts-dot on"></span> ${esc(label)} · <b>${data.hourly.length.toLocaleString('en-IN')}</b> hourly rows · <b>${data.onboarded.length.toLocaleString('en-IN')}</b> tank mappings · <b>${data.latest.length.toLocaleString('en-IN')}</b> latest stock records`;
  }
  function isVisible() {
    const tab = document.getElementById('tab-tank-stock');
    return !tab || tab.classList.contains('active'); // standalone page has no tab → always visible
  }
  function hhmm(ts) { const d = new Date(ts); return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); }

  // Scoped element selector to #tab-tank-stock to prevent collisions
  const $ = id => document.querySelector('#tab-tank-stock #' + id) || document.getElementById(id);
  const norm = v => String(v ?? '').trim();
  const key = v => norm(v).toUpperCase();
  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    let n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const fmt = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
  const pct = v => v == null ? '—' : fmt(v * 100, 1) + '%';
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- IndexedDB Persistence for DirectoryHandle ----
  function getStoredFolderHandle() {
    return new Promise(resolve => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = e => {
          const db = e.target.result;
          const tx = db.transaction(IDB_STORE, 'readonly');
          const st = tx.objectStore(IDB_STORE);
          const getReq = st.get(IDB_KEY);
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function setStoredFolderHandle(handle) {
    return new Promise(resolve => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = e => {
          const db = e.target.result;
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        };
        req.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function verifyPermission(handle, readWrite = false) {
    if (!handle) return false;
    const opts = {};
    if (readWrite) opts.mode = 'readwrite';
    try {
      if ((await handle.queryPermission(opts)) === 'granted') return true;
      if ((await handle.requestPermission(opts)) === 'granted') return true;
    } catch (e) {
      console.warn('Handle permission prompt:', e);
    }
    return false;
  }

  // Recursive search if parent directory is selected (e.g. G:\My Drive)
  async function resolveTargetFolder(dirHandle, depth = 0) {
    if (!dirHandle || depth > 3) return null;
    try {
      await dirHandle.getFileHandle('Stock hourly.xlsx');
      return dirHandle;
    } catch (e) {}

    try {
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'directory') {
          const n = entry.name.toLowerCase();
          if (n.includes('tank') || n.includes('technology') || n.includes('tl-patil') || depth < 2) {
            const found = await resolveTargetFolder(entry, depth + 1);
            if (found) return found;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  function parseWorkbook(file, type) {
    return file.arrayBuffer().then(buf => {
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true }).map(src => {
        const r = {};
        Object.keys(src).forEach(k => r[String(k).trim()] = src[k]);
        if (type === 'hourly') return { ...r, _ro: key(r['RO ID']), _tank: key(r['Tank ID']), _product: key(r['Product Name']) };
        if (type === 'onboarded') return { ...r, _ro: key(r.ROID), _tank: key(r['Local tank id']), _product: key(r.Product_Name) };
        return { ...r, _ro: key(r['RO ID']), _product: key(r['Product Name']) };
      })
      // Drop Power BI export footer rows ("Applied filters: …") and blank lines — a real RO ID is numeric
      .filter(r => /^\d{3,10}$/.test(String(r._ro || '').replace(/\.0+$/, '')));
    });
  }

  async function loadFiles(fileMap, forceMapping = false) {
    try {
      if (!window.XLSX) throw Error('Excel reader could not load. Check internet access and reload the page.');
      let parsed = {};
      for (const name of ['Stock hourly.xlsx', 'Last updated stock.xlsx']) {
        if (!fileMap[name]) throw Error('Missing file: ' + name);
        parsed[FILES[name]] = await parseWorkbook(fileMap[name], FILES[name]);
      }
      if (fileMap['Onboarded tanks.xlsx']) {
        parsed.onboarded = await parseWorkbook(fileMap['Onboarded tanks.xlsx'], 'onboarded');
      } else {
        parsed.onboarded = data.onboarded || [];
      }
      data.hourly = parsed.hourly;
      data.latest = parsed.latest;
      data.onboarded = parsed.onboarded;

      source = 'files';
      renderDashboard();
      if ($('dataStatus')) {
        $('dataStatus').innerHTML = statusLine('Excel files');
      }
      if ($('updatedAt')) {
        $('updatedAt').textContent = 'Stock refreshed at ' + new Date().toLocaleTimeString() + (forceMapping ? ' • Tank mapping updated' : '');
      }
      if (window.showToast) {
        window.showToast('Tank stock loaded from Excel files', 'success');
      }
    } catch (e) {
      if ($('dataStatus')) $('dataStatus').innerHTML = '<span class="error">' + e.message + '</span>';
      console.error(e);
      if (window.showToast) window.showToast(e.message, 'error');
    }
  }

  function updateDriveStatusUI(connected = false, folderName = GDRIVE_CONFIG.folderName) {
    const folderBtn = $('folderBtn');
    const badge = $('gdriveStatusBadge');
    if (folderBtn) {
      if (connected) {
        folderBtn.innerHTML = `<span class="ts-dot on"></span><span>Drive: <b>${esc(folderName)}</b></span>`;
        folderBtn.title = `Connected to Google Drive: ${GDRIVE_CONFIG.folderId}\nClick to re-sync or change folder`;
        folderBtn.classList.add('is-connected');
      } else {
        folderBtn.innerHTML = `<span class="ts-dot"></span><span>Connect Google Drive</span>`;
        folderBtn.title = `Click to connect Google Drive: ${GDRIVE_CONFIG.folderName} (${GDRIVE_CONFIG.folderId})`;
        folderBtn.classList.remove('is-connected');
      }
    }
    if (badge) {
      if (connected) {
        badge.textContent = '🟢 Connected (Auto-sync 30s)';
        badge.className = 'pill';
        badge.style.background = '#e8f9ee';
        badge.style.color = '#16853c';
      } else {
        badge.textContent = '🟡 Not connected';
        badge.className = 'pill partial';
        badge.style.background = '#fff5df';
        badge.style.color = '#a66a00';
      }
    }
  }

  function openGdriveModal() {
    const m = $('tankModal') || $('modal');
    if (m) m.classList.remove('hidden');
  }

  function closeGdriveModal() {
    const m = $('tankModal') || $('modal');
    if (m) m.classList.add('hidden');
  }

  async function chooseFolder() {
    if (!window.showDirectoryPicker) {
      const fetched = await fetchFromAppsScriptDrive();
      if (!fetched) {
        alert('Browser directory picker is not supported in this browser. Please use "Upload Excel files" or run in Chrome/Edge.');
        $('tankStockFileInput')?.click();
      }
      return;
    }
    try {
      let picked = await window.showDirectoryPicker({
        mode: 'read',
        id: 'bpcl_gdrive_tank_stock',
        startIn: 'documents'
      });
      const target = await resolveTargetFolder(picked) || picked;
      folderHandle = target;
      await setStoredFolderHandle(folderHandle);
      updateDriveStatusUI(true, folderHandle.name || GDRIVE_CONFIG.folderName);
      await readFolder(false, false);

      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => readFolder(true), 30000); // 30s auto-refresh
      closeGdriveModal();
    } catch (e) {
      if (e.name !== 'AbortError') {
        alert('Could not access folder: ' + e.message);
      }
    }
  }

  async function readFolder(silent = false, forceMapping = false) {
    if (!folderHandle) return;
    try {
      const map = {};
      let hasChanges = false;
      for (const name of ['Stock hourly.xlsx', 'Last updated stock.xlsx']) {
        const h = await folderHandle.getFileHandle(name);
        const f = await h.getFile();
        map[name] = f;
        if (!fileTimestamps[name] || fileTimestamps[name] !== f.lastModified) {
          fileTimestamps[name] = f.lastModified;
          hasChanges = true;
        }
      }
      let hasMapping = false;
      try { hasMapping = !!localStorage.getItem('bpcl_tank_mapping_v1'); } catch (e) {}
      if (forceMapping || !hasMapping) {
        const h = await folderHandle.getFileHandle('Onboarded tanks.xlsx');
        const f = await h.getFile();
        map['Onboarded tanks.xlsx'] = f;
        if (!fileTimestamps['Onboarded tanks.xlsx'] || fileTimestamps['Onboarded tanks.xlsx'] !== f.lastModified) {
          fileTimestamps['Onboarded tanks.xlsx'] = f.lastModified;
          hasChanges = true;
        }
      }
      if (hasChanges || forceMapping || !data.latest.length) {
        await loadFiles(map, forceMapping);
      }
    } catch (e) {
      if (!silent) alert('Could not read the Google Drive folder. Confirm that Stock hourly.xlsx, Last updated stock.xlsx, and Onboarded tanks.xlsx are present in the folder. ' + e.message);
      else console.warn('Drive folder read check:', e);
    }
  }

  // Cloud sync fallback via Google Apps Script web app
  async function fetchFromAppsScriptDrive() {
    const config = window.DAY_MONITORING_CONFIG;
    if (!config || !config.apiUrl || config.apiUrl.includes('ENTER_YOUR')) return false;
    try {
      if ($('dataStatus')) $('dataStatus').textContent = 'Fetching latest files from Google Drive cloud...';
      const url = `${config.apiUrl}?apiKey=${config.apiKey}&action=getTankStockFiles&folderId=${GDRIVE_CONFIG.folderId}`;
      const resp = await fetch(url);
      const res = await resp.json();
      if (res && res.success && res.files) {
        const map = {};
        for (const [name, info] of Object.entries(res.files)) {
          const bin = atob(info.base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          map[name] = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        }
        if (map['Stock hourly.xlsx'] && map['Last updated stock.xlsx']) {
          await loadFiles(map);
          return true;
        }
      }
    } catch (e) {
      console.warn('Google Apps Script drive fetch fallback:', e);
    }
    return false;
  }

  function groupByRO() {
    const m = new Map();
    const ensure = (id, row) => {
      if (!m.has(id)) {
        // Territory / sales area come from the uptime sheet when the RO is there,
        // so the territory filter matches the Dashboard and all other menus.
        const up = window.__roLookup && window.__roLookup.get(String(id).replace(/\D/g, '').replace(/^0+/, ''));
        m.set(id, { id, name: row['Retail Outlet'] || row.RO_Name || 'Unknown RO', territory: (up && up.territory) || row.Territory || '', area: (up && up.area) || row['Sales Area'] || row.Salesarea || '', vendor: row['RA Vendor'] || row.RA_Vendor || '', state: row.State || '', ebms: 0, hsd: 0, total: 0, tanks: [], latest: [], online: 0, offline: 0 });
      }
      return m.get(id);
    };
    data.onboarded.forEach(r => {
      if (!r._ro) return;
      let x = ensure(r._ro, r);
      x.tanks.push(r);
      let st = key(r.Status);
      if (st === 'ONLINE') x.online++;
      else if (st === 'OFFLINE') x.offline++;
    });
    data.latest.forEach(r => {
      if (!r._ro) return;
      let x = ensure(r._ro, r);
      x.latest.push(r);
      let p = key(r['Product Name']);
      let stock = num(r.Stock) || 0;
      if (p.includes('EBMS')) x.ebms += stock;
      else if (p === 'HSD') x.hsd += stock;
      x.total += stock;
    });
    data.hourly.forEach(r => {
      if (!r._ro) return;
      ensure(r._ro, r);
    });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function fillFilters() {
    const fields = [['territory', 'territory'], ['area', 'area'], ['vendor', 'vendor'], ['state', 'state']];
    fields.forEach(([id, k]) => {
      const el = $(id);
      if (!el) return;
      const old = el.value;
      let vals = [...new Set(allRO.map(r => r[k]).filter(Boolean))].sort();
      if (id === 'territory' && window.GlobalScope) {
        // share territory options with the global (all-menus) territory filter
        GlobalScope.registerTerritories(vals);
        vals = [...new Set(vals.concat(GlobalScope.territories()))].sort();
      }
      const label = { territory: 'Territories', area: 'Sales Areas', vendor: 'RA Vendors', state: 'States' }[id] || (k.charAt(0).toUpperCase() + k.slice(1) + 's');
      el.innerHTML = `<option value="">All ${label}</option>` + vals.map(v => `<option value="${esc(v)}"${v === old ? ' selected' : ''}>${esc(v)}</option>`).join('');
      if (id === 'territory' && window.GlobalScope && window.MS) MS.set(el, GlobalScope.get());
    });
  }

  function renderDashboard() {
    allRO = groupByRO();
    fillFilters();
    let totalT = 0, on = 0, off = 0;
    allRO.forEach(r => { totalT += r.tanks.length; on += r.online; off += r.offline; });
    const kpisEl = $('kpis');
    if (kpisEl) {
      const onPct = totalT ? on / totalT * 100 : 0;
      kpisEl.innerHTML = [
        ['Retail Outlets', allRO.length, 'Unique RO IDs', 'navy', null],
        ['Onboarded Tanks', totalT, 'Tank records', 'blue', null],
        ['Online Tanks', on, totalT ? `${onPct.toFixed(1)}% online` : 'Status marked Online', 'green', onPct],
        ['Offline Tanks', off, totalT ? `${(off / totalT * 100).toFixed(1)}% offline` : 'Status marked Offline', 'red', null],
        ['Latest Stock Records', data.latest.length, 'Product-level records', 'yellow', null]
      ].map(([label, val, sub, tone, bar]) => `
        <div class="kpi ts-tone-${tone}">
          <div class="klabel">${label}</div>
          <div class="value">${Number(val || 0).toLocaleString('en-IN')}</div>
          ${sub ? `<div class="sub">${sub}</div>` : ''}
          ${bar != null ? `<div class="ts-kbar"><span style="width:${Math.max(0, Math.min(100, bar)).toFixed(1)}%"></span></div>` : ''}
        </div>
      `).join('');
    }
    drawROTable();
  }

  let currentViewMode = (typeof window !== 'undefined' && window.innerWidth <= 768) ? 'cards' : 'table';

  function setViewMode(mode) {
    currentViewMode = mode;
    const tab = $('tab-tank-stock') || document.querySelector('.tank-stock-standalone') || document.body;
    const cardsBtn = $('viewCardsBtn');
    const tableBtn = $('viewTableBtn');
    if (mode === 'cards') {
      tab.classList.remove('mode-table');
      tab.classList.add('mode-cards');
      if (cardsBtn) cardsBtn.classList.add('active');
      if (tableBtn) tableBtn.classList.remove('active');
    } else {
      tab.classList.remove('mode-cards');
      tab.classList.add('mode-table');
      if (tableBtn) tableBtn.classList.add('active');
      if (cardsBtn) cardsBtn.classList.remove('active');
    }
  }

  function drawROTable() {
    const searchEl = $('search'), terrEl = $('territory'), areaEl = $('area'), vendEl = $('vendor'), stateEl = $('state');
    if (!searchEl) return;
    const pick = el => !el ? [] : (window.MS ? MS.vals(el) : (el.value ? [el.value] : []));
    const inSet = (arr, v) => !arr.length || arr.includes(String(v || ''));
    const q = key(searchEl.value), territory = pick(terrEl), area = pick(areaEl), vendor = pick(vendEl), state = pick(stateEl);
    let rows = allRO.filter(r => (!q || r.id.includes(q) || key(r.name).includes(q)) && inSet(territory, r.territory) && (!window.GlobalScope || GlobalScope.match(r.territory)) && inSet(area, r.area) && inSet(vendor, r.vendor) && inSet(state, r.state));
    
    // Pagination to prevent mobile browser crash on thousands of outlets
    const TS_PAGE_SIZE = 40;
    let page = window._tsPage || 1;
    const totalPages = Math.max(1, Math.ceil(rows.length / TS_PAGE_SIZE));
    if (page > totalPages) page = 1;
    window._tsPage = page;
    const startIdx = (page - 1) * TS_PAGE_SIZE;
    const pagedRows = rows.slice(startIdx, startIdx + TS_PAGE_SIZE);

    if ($('rowCount')) $('rowCount').textContent = `${rows.length.toLocaleString()} outlets (Showing ${rows.length ? startIdx + 1 : 0}–${Math.min(startIdx + TS_PAGE_SIZE, rows.length)})`;

    const tbody = $('roTable');
    if (tbody) {
      tbody.innerHTML = pagedRows.map(r => {
        let st = r.offline === 0 && r.online > 0 ? 'ONLINE' : (r.online === 0 ? 'OFFLINE' : 'PARTIAL');
        return `<tr onclick="openRO('${r.id}')"><td class="ts-id" title="${esc(r.id)}">${esc(r.id)}</td><td class="ro-name" title="${esc(r.name)}">${esc(r.name)}</td><td title="${esc(r.territory)} / ${esc(r.area)}">${esc(r.territory)} <span class="muted">/ ${esc(r.area)}</span></td><td title="${esc(r.vendor)}">${esc(r.vendor)}</td><td class="num product-ebms">${fmt(r.ebms, 2)}</td><td class="num product-hsd">${fmt(r.hsd, 2)}</td><td class="num"><b>${fmt(r.total, 2)}</b></td><td class="num"><span class="ts-tanks">${r.online}/${r.tanks.length}</span></td><td><span class="pill ${st === 'OFFLINE' ? 'off' : st === 'ONLINE' ? '' : 'partial'}">${st === 'ONLINE' ? 'Online' : st === 'OFFLINE' ? 'Offline' : 'Partial'}</span></td></tr>`;
      }).join('') || '<tr><td colspan="9" class="empty">No matching retail outlets found.</td></tr>';
    }

    const cardWrap = $('roCardsWrap');
    if (cardWrap) {
      cardWrap.innerHTML = pagedRows.map(r => {
        let st = r.offline === 0 && r.online > 0 ? 'ONLINE' : (r.online === 0 ? 'OFFLINE' : 'PARTIAL');
        return `
          <div class="ro-card" onclick="openRO('${r.id}')">
            <div class="ro-card-top">
              <div>
                <span class="ro-card-id">${r.id}</span>
                <h3 class="ro-card-name">${esc(r.name)}</h3>
                <div class="ro-card-meta">${esc(r.area || r.territory)} • ${esc(r.vendor)}</div>
              </div>
              <span class="pill ${st === 'OFFLINE' ? 'off' : st === 'ONLINE' ? '' : 'partial'}">${st === 'ONLINE' ? 'Online' : st === 'OFFLINE' ? 'Offline' : 'Partial'}</span>
            </div>
            <div class="ro-card-grid">
              <div>
                <div class="col-label">EBMS</div>
                <div class="col-val product-ebms">${fmt(r.ebms, 2)}</div>
              </div>
              <div>
                <div class="col-label">HSD</div>
                <div class="col-val product-hsd">${fmt(r.hsd, 2)}</div>
              </div>
              <div>
                <div class="col-label">Total</div>
                <div class="col-val"><b>${fmt(r.total, 2)}</b></div>
              </div>
              <div style="text-align:right">
                <span class="ts-tanks-chip">${r.online}/${r.tanks.length} tanks ›</span>
              </div>
            </div>
          </div>
        `;
      }).join('') || '<div class="empty">No matching retail outlets found.</div>';
    }

    // Responsive pagination bar
    let paginEl = $('tsPaginationControls');
    if (!paginEl && cardWrap && cardWrap.parentNode) {
      paginEl = document.createElement('div');
      paginEl.id = 'tsPaginationControls';
      cardWrap.parentNode.appendChild(paginEl);
    }
    if (paginEl) {
      if (totalPages <= 1) {
        paginEl.style.display = 'none';
        paginEl.innerHTML = '';
      } else {
        paginEl.style.display = 'flex';
        paginEl.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px 16px; margin-top:14px; background:var(--card-bg, #fff); border-radius:12px; border:1px solid var(--border-color, #e2e8f0); flex-wrap:wrap; gap:10px; font-size:13px;';
        paginEl.innerHTML = `
          <span style="font-weight:600; color:var(--text-muted, #64748b);">
            Page <b>${page}</b> of <b>${totalPages}</b> (${rows.length.toLocaleString()} outlets)
          </span>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-sm" type="button" style="padding:6px 14px; font-weight:700; border-radius:8px; cursor:${page > 1 ? 'pointer' : 'not-allowed'}; opacity:${page > 1 ? '1' : '0.4'};" onclick="window.tsNavPage(-1)">← Previous</button>
            <button class="btn btn-sm" type="button" style="padding:6px 14px; font-weight:700; border-radius:8px; cursor:${page < totalPages ? 'pointer' : 'not-allowed'}; opacity:${page < totalPages ? '1' : '0.4'};" onclick="window.tsNavPage(1)">Next →</button>
          </div>
        `;
      }
    }
  }

  window.tsNavPage = function(delta) {
    const cur = window._tsPage || 1;
    window._tsPage = Math.max(1, cur + delta);
    drawROTable();
    const panel = $('dashboardView');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  window.openRO = function(id) {
    selectedRO = id;
    let ro = allRO.find(x => x.id === id);
    if (!ro) return;
    $('dashboardView')?.classList.add('hidden');
    $('detailView')?.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if ($('roTitle')) $('roTitle').textContent = `${ro.name} (${ro.id})`;
    if ($('roSubtitle')) $('roSubtitle').textContent = `${ro.territory} • ${ro.area} • RA Vendor: ${ro.vendor || '—'} • State: ${ro.state || '—'}`;
    let prods = ['EBMS', 'HSD'];
    if ($('productSummaries')) {
      $('productSummaries').innerHTML = prods.map(p => {
        let recs = ro.latest.filter(r => key(r['Product Name']) === p),
            capacity = recs.reduce((s, r) => s + (num(r['On-boarded Tankage']) || 0), 0),
            stock = recs.reduce((s, r) => s + (num(r.Stock) || 0), 0),
            onlineCap = recs.reduce((s, r) => s + (num(r['On-Line Tankage']) || 0), 0),
            ullage = Math.max(0, capacity - stock),
            net = capacity ? stock / capacity * 100 : 0;
        return `<div class="summarybox"><h3>STOCK SUMMARY — <span class="product-${p.toLowerCase()}">${p}</span></h3><table><thead><tr><th>Product</th><th class="num">Capacity (KL)</th><th class="num">Stock (KL)</th><th class="num">Ullage (KL)</th><th class="num">Stock %</th><th class="num">Ullage %</th></tr></thead><tbody><tr><td class="product-${p.toLowerCase()}">${p}</td><td class="num">${fmt(capacity, 2)}</td><td class="num">${fmt(stock, 2)}</td><td class="num">${fmt(ullage, 2)}</td><td class="num">${capacity ? fmt(net, 1) + '%' : '—'}</td><td class="num">${capacity ? fmt(100 - net, 1) + '%' : '—'}</td></tr></tbody></table><div class="small" style="padding:0 14px 12px">On-line tankage: ${fmt(onlineCap, 2)} KL • ${recs.length} product record(s)</div></div>`;
      }).join('');
    }
    let tanks = ro.tanks.slice().sort((a, b) => (num(a['Local tank id']) || 0) - (num(b['Local tank id']) || 0));
    if ($('tankCards')) {
      $('tankCards').innerHTML = tanks.length ? tanks.map(t => tankCard(t, ro)).join('') : '<div class="empty">No onboarded tank records for this RO.</div>';
      document.querySelectorAll('#tab-tank-stock .tank[data-tank], .tank[data-tank]').forEach(el => el.addEventListener('click', () => showHourly(id, el.dataset.tank, el.dataset.product)));
    }
  };

  function tankCard(t, ro) {
    let id = key(t['Local tank id']), p = key(t.Product_Name), hr = data.hourly.find(h => h._ro === ro.id && h._tank === id && h._product === p);
    let hours = ['12 AM', '1 AM', '2 AM', '3 AM', '4 AM', '5 AM', '6 AM', '7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM', '9 PM', '10 PM', '11 PM'];
    let vals = hr ? hours.map(h => num(hr[h + ' %'])) : [];
    let valid = vals.filter(v => v != null), current = valid.length ? valid[valid.length - 1] : null, first = valid.length ? valid[0] : null, capacity = num(t['On-Boarded Tankage (KL)']) ?? (hr ? num(hr['On-Boarded Tankage (KL)']): null);
    let status = key(t.Status), upRaw = t['Uptime_tank(%)'];
    // Pasted Google data stores 100% as the number 1 — show it as a percent
    let up = typeof upRaw === 'number' ? (upRaw <= 1 ? (upRaw * 100).toFixed(1) : upRaw.toFixed(1)) + '%' : String(upRaw ?? '—');
    let color = p === 'EBMS' ? '#22bd42' : p === 'HSD' ? '#079fe8' : '#f2d000';
    return `<div class="tank" data-tank="${esc(id)}" data-product="${esc(p)}"><div class="tanktop"><div class="tanktitle">Tank ${esc(id)} <small>(${fmt(capacity, 2)} KL)</small></div><div>${status === 'ONLINE' ? '🔒' : '⚠️'} <span class="tankproduct product-${p.toLowerCase()}">${esc(p)}</span></div></div><div class="tankmeta"><span>◈ ${esc(up)} uptime</span><span class="tag">${esc(t['Morning_Status'] || '—')} / ${esc(t['Evening_Status'] || '—')}</span></div><div class="gauge" style="--pct:${Math.max(0, Math.min(100, current ?? 0))};--gauge:${color}"><span>${current == null ? '—' : fmt(current, 2) + '%'}</span></div><div class="tankstats"><div><div class="statlabel">First reported %</div><div class="statvalue">${first == null ? '—' : fmt(first, 2) + '%'}</div></div><div style="text-align:right"><div class="statlabel">Latest hourly %</div><div class="statvalue">${current == null ? '—' : fmt(current, 2) + '%'}</div></div><div><div class="statlabel">Onboarded tankage</div><div class="statvalue">${fmt(capacity, 2)} KL</div></div><div style="text-align:right"><div class="statlabel">Online hours</div><div class="statvalue">${fmt(num(t.Online_hours))} / 24</div></div></div><div class="tankbottom"><div><div class="statlabel">Table updated</div><div class="statvalue">${esc(t.Table_updated_at || '—')}</div></div><div style="text-align:right"><div class="statlabel">Status</div><span class="pill ${status === 'OFFLINE' ? 'off' : status === 'ONLINE' ? '' : 'partial'}">${esc(t.Status || 'Unknown')}</span></div></div></div>`;
  }

  function showHourly(roId, tankId, product) {
    let row = data.hourly.find(h => h._ro === roId && h._tank === key(tankId) && h._product === key(product));
    $('hourlyPanel')?.classList.remove('hidden');
    if ($('hourlyTitle')) $('hourlyTitle').textContent = `HOURLY STOCK TREND — TANK ${tankId} (${product})`;
    if ($('hourlySubtitle')) $('hourlySubtitle').textContent = 'Hourly stock percentage from Stock hourly.xlsx';
    let hours = ['12 AM', '1 AM', '2 AM', '3 AM', '4 AM', '5 AM', '6 AM', '7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM', '9 PM', '10 PM', '11 PM'];
    let vals = hours.map(h => row ? num(row[h + ' %']) : null), max = Math.max(100, ...vals.filter(v => v != null));
    if ($('hourlyChart')) {
      $('hourlyChart').innerHTML = vals.map((v, i) => `<div class="barwrap" title="${hours[i]}: ${v == null ? 'No data' : fmt(v, 2) + '%'}"><small>${v == null ? '' : fmt(v, 0)}</small><div class="bar" style="height:${v == null ? 0 : Math.max(2, v / max * 145)}px;background:${key(product) === 'EBMS' ? '#22bd42' : '#079fe8'}"></div><label>${hours[i].replace(' ', '')}</label></div>`).join('');
    }
    $('hourlyPanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function back() {
    selectedRO = null;
    $('detailView')?.classList.add('hidden');
    $('dashboardView')?.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Pre-load local files if present
  async function tryPreloadLocalFiles() {
    try {
      const map = {};
      for (const name of ['Stock hourly.xlsx', 'Last updated stock.xlsx', 'Onboarded tanks.xlsx']) {
        try {
          const resp = await fetch(name);
          if (resp.ok) {
            map[name] = await resp.blob();
          }
        } catch (e) {}
      }
      if (map['Stock hourly.xlsx'] && map['Last updated stock.xlsx']) {
        await loadFiles(map);
      }
    } catch (e) {
      console.warn('Preload check:', e);
    }
  }

  async function autoConnectGoogleDrive() {
    try {
      const stored = await getStoredFolderHandle();
      if (stored) {
        const perm = await stored.queryPermission({ mode: 'read' });
        if (perm === 'granted') {
          folderHandle = stored;
          updateDriveStatusUI(true, folderHandle.name || GDRIVE_CONFIG.folderName);
          await readFolder(true);
          if (refreshTimer) clearInterval(refreshTimer);
          refreshTimer = setInterval(() => readFolder(true), 30000);
          return true;
        } else {
          // Has stored handle but requires user click to requestPermission
          updateDriveStatusUI(false);
          const folderBtn = $('folderBtn');
          if (folderBtn) {
            folderBtn.innerHTML = `<span class="ts-dot warn"></span><span>Reconnect Google Drive</span>`;
            folderBtn.title = `Click to restore connection to Google Drive: ${GDRIVE_CONFIG.folderName}`;
          }
        }
      }
    } catch (e) {
      console.warn('Auto-connect Google Drive error:', e);
    }
    return false;
  }

  let tankInitDone = false;
  function initEvents() {
    if (tankInitDone) return;
    tankInitDone = true;
    const folderBtn = $('folderBtn');
    const refreshBtn = $('refreshBtn');
    const mappingBtn = $('mappingBtn');
    const uploadBtn = $('uploadBtn');
    const fileInput = $('tankStockFileInput') || $('fileInput');
    const backBtn = $('backBtn');
    const closeHourly = $('closeHourly');
    const modalClose = $('modalClose');
    const chooseFolderNow = $('chooseFolderNow');
    const copyGdrivePathBtn = $('copyGdrivePathBtn');

    const syncBtn = $('tsSyncBtn');
    const sheetChip = $('tsSheetChip');
    if (syncBtn) syncBtn.onclick = () => syncFromSheet(false);
    if (sheetChip) sheetChip.onclick = () => syncFromSheet(false);
    if (window.__sheetSync && window.__sheetSync.at) markSynced(window.__sheetSync.at, window.__sheetSync.tankFound);

    if (folderBtn) {
      folderBtn.onclick = async () => {
        // If we have a stored handle that just needs permission granted:
        const stored = await getStoredFolderHandle();
        if (stored && !folderHandle) {
          const granted = await verifyPermission(stored);
          if (granted) {
            folderHandle = stored;
            updateDriveStatusUI(true, folderHandle.name || GDRIVE_CONFIG.folderName);
            await readFolder();
            if (refreshTimer) clearInterval(refreshTimer);
            refreshTimer = setInterval(() => readFolder(true), 30000);
            if (window.showToast) window.showToast('Reconnected to Google Drive folder: ' + (folderHandle.name || GDRIVE_CONFIG.folderName), 'success');
            return;
          }
        }
        openGdriveModal();
      };
    }

    if (refreshBtn) refreshBtn.onclick = () => folderHandle ? readFolder() : tryPreloadLocalFiles();
    if (mappingBtn) mappingBtn.onclick = () => {
      if (folderHandle) readFolder(false, true);
      else {
        alert('Please connect the Google Drive folder first. Then use Update tank mapping to refresh the fixed onboarded tank list.');
        openGdriveModal();
      }
    };
    if (uploadBtn) uploadBtn.onclick = () => fileInput?.click();
    if (fileInput) fileInput.onchange = async e => {
      let map = {};
      for (const f of e.target.files) {
        if (FILES[f.name]) map[f.name] = f;
      }
      await loadFiles(map, true);
      e.target.value = '';
    };
    if (backBtn) backBtn.onclick = back;
    if (closeHourly) closeHourly.onclick = () => $('hourlyPanel')?.classList.add('hidden');
    if (modalClose) modalClose.onclick = closeGdriveModal;
    if (chooseFolderNow) chooseFolderNow.onclick = () => {
      chooseFolder();
    };

    if (copyGdrivePathBtn) {
      copyGdrivePathBtn.onclick = () => {
        const path = GDRIVE_CONFIG.localPathWindows;
        navigator.clipboard.writeText(path).then(() => {
          copyGdrivePathBtn.textContent = '✓ Copied!';
          setTimeout(() => { copyGdrivePathBtn.textContent = '📋 Copy Path'; }, 2000);
        }).catch(() => {
          prompt('Copy local Google Drive path:', path);
        });
      };
    }

    const viewCardsBtn = $('viewCardsBtn');
    const viewTableBtn = $('viewTableBtn');
    if (viewCardsBtn) viewCardsBtn.onclick = () => {
      sessionStorage.setItem('bpcl_tank_view_manual', '1');
      setViewMode('cards');
    };
    if (viewTableBtn) viewTableBtn.onclick = () => {
      sessionStorage.setItem('bpcl_tank_view_manual', '1');
      setViewMode('table');
    };
    setViewMode((typeof window !== 'undefined' && window.innerWidth <= 768) ? 'cards' : 'table');

    ['search', 'territory', 'area', 'vendor', 'state'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener(id === 'search' ? 'input' : 'change', drawROTable);
    });

    // Data source: the Google Sheet workbook (shared sync in the main app).
    if (typeof window.syncGoogleSheet !== 'function') {
      // Standalone page: sync now, then re-check every few minutes (unchanged sheet = no work)
      syncFromSheet(true);
      const mins = Math.max(2, parseInt(localStorage.getItem('bpcl_sheet_autosync_min') || '5', 10) || 5);
      setInterval(() => { if (document.visibilityState === 'visible') syncFromSheet(true); }, mins * 60000);
    }
  }

  /* ---------- Google Sheet feed (same workbook as the uptime data) ---------- */
  function setChip(state, text) {
    const chip = $('tsSheetChip');
    if (!chip) return;
    chip.className = 'btn ts-drive' + (state === 'ok' ? ' is-connected' : '');
    chip.innerHTML = `<span class="ts-dot ${state === 'ok' ? 'on' : state === 'warn' ? 'warn' : ''}"></span><span>${text}</span>`;
  }

  function ingestSheets(t) {
    const found = !!(t && (t.latest || t.hourly || t.onboarded));
    if (!found) {
      if ($('dataStatus') && !data.latest.length) {
        $('dataStatus').innerHTML = '<span class="ts-dot warn"></span> No tank sheets in the Google workbook yet — add sheets named <b>Last updated stock</b>, <b>Stock hourly</b> and <b>Onboarded tanks</b>.';
      }
      if (!data.latest.length) tryPreloadLocalFiles();
      return;
    }
    if (t.latest) data.latest = t.latest;
    if (t.hourly) data.hourly = t.hourly;
    if (t.onboarded) data.onboarded = t.onboarded;
    source = 'sheet';
    // Heavy redraw only when the page is on screen; otherwise when it is opened
    if (isVisible()) renderDashboard(); else renderPending = true;
    if ($('dataStatus')) $('dataStatus').innerHTML = statusLine('Google Sheet');
    if ($('updatedAt')) $('updatedAt').textContent = 'Stock refreshed at ' + new Date().toLocaleTimeString();
  }

  function markSynced(at, found) {
    lastSyncAt = at || Date.now();
    if (found === false) setChip('warn', 'Google Sheet · no tank sheets');
    else setChip('ok', `Google Sheet · synced ${hhmm(lastSyncAt)}`);
  }
  let lookupTimer = null;
  function refreshLookup() {
    if (!data.latest.length && !data.onboarded.length) return;
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(() => {
      allRO = groupByRO();
      if (isVisible()) renderDashboard(); else renderPending = true;
    }, 50);
  }
  function markLoading() {
    setChip('', 'Google Sheet · loading tank sheets…');
    if ($('dataStatus') && !data.latest.length) $('dataStatus').innerHTML = '<span class="ts-dot"></span> Reading tank sheets from the Google workbook…';
  }
  function markSyncError(msg) {
    setChip('warn', 'Google Sheet · sync failed');
    if ($('dataStatus') && !data.latest.length) $('dataStatus').innerHTML = '<span class="ts-dot warn"></span> ' + esc(msg || 'Could not read the Google Sheet');
  }

  async function syncFromSheet(silent) {
    // Inside the main app: the shared sync refreshes uptime + tank together
    if (typeof window.syncGoogleSheet === 'function') {
      try { await window.syncGoogleSheet(!!silent); }
      catch (e) { markSyncError(e.message); }
      return;
    }
    // Standalone page: read the same workbook directly
    try {
      setChip('', 'Google Sheet · syncing…');
      const url = (window.resolveSheetExportUrl && window.resolveSheetExportUrl()) || standaloneSheetUrl();
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error('Google Sheet could not be read (' + resp.status + ')');
      const buf = await resp.arrayBuffer();
      const fp = window.WorkbookReader.fingerprint(buf);
      if (fp !== standaloneFp || !data.latest.length) {
        const book = await window.WorkbookReader.read(buf);
        ingestSheets({ latest: book.byKind('tank_latest'), hourly: book.byKind('tank_hourly'), onboarded: book.byKind('tank_onboarded') });
        standaloneFp = fp;
        markSynced(Date.now(), !!(book.byKind('tank_latest') || book.byKind('tank_hourly')));
      } else markSynced(Date.now(), true);
      if (!silent && window.showToast) window.showToast('Tank stock synced from Google Sheet', 'success');
    } catch (e) {
      markSyncError(e.message);
      if (!data.latest.length) tryPreloadLocalFiles();
    }
  }
  let standaloneFp = null;
  function standaloneSheetUrl() {
    let u = (localStorage.getItem('bpcl_google_sheet_url') || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS3EE_SNele4ucfWLc38wDtMaSB18jj2OgCw-Ze8D76Xt5657yylbThfpJ3GF9_9-I6bCcudKh4z42o/pub?output=xlsx').trim();
    if (u.includes('pub?output=csv')) u = u.replace('pub?output=csv', 'pub?output=xlsx');
    else if (u.includes('/edit')) u = u.replace(/\/edit.*$/, '/export?format=xlsx');
    return u;
  }

  window.TankStock = { ingestSheets, markSynced, markLoading, markSyncError, syncFromSheet, refreshLookup };

  window.initTankStockDashboard = function() {
    // Events and Drive auto-connect run once; re-opening the menu only refreshes the view
    if (!tankInitDone) { initEvents(); return; }
    if (!sessionStorage.getItem('bpcl_tank_view_manual')) setViewMode(window.innerWidth <= 768 ? 'cards' : 'table');
    if (renderPending) { renderPending = false; renderDashboard(); }
    else if (allRO && allRO.length) drawROTable();
    if (!data.latest.length && window.__sheetSync && !window.__sheetSync.busy && !window.__sheetSync.at) syncFromSheet(true);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEvents);
  } else {
    initEvents();
  }

})();
