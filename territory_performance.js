// territory_performance.js — REPORTS › Territory Performance
// ---------------------------------------------------------------------------
// Territory-wise MPD / ATG / Auto RSP details, Equipment uptime and 2-slot
// uptime, with a ranking that follows the metric the user clicks:
//
//   • Equipment uptime  = Σ online (MPD + ATG) ÷ Σ onboarded (MPD + ATG)
//       (MPD / ATG equipment uptime = Σ online ÷ Σ onboarded for that unit)
//   • 2-slot uptime     = average of row-level "Avg RO Online%" when present,
//       otherwise the mean of MPD 2-slot and ATG 2-slot
//       (MPD / ATG 2-slot = arithmetic average of row-level MPD Online% /
//        Tank Online%, same rule as the MIS Dashboard)
//
// The ranking always compares every territory in the data (it ignores the
// global Territory filter); territories picked in that filter are highlighted.
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const state = { basis: 'equipment', level: 'territory' };   // basis: equipment | twoslot
  let lastGroups = [];

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = v => Number.isFinite(v) ? (v * 100).toFixed(2) + '%' : '—';
  const n0 = v => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const num = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const validPct = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
  const isYes = v => /^(yes|y|true|1)$/i.test(String(v ?? '').trim());

  // Outlets before the global Territory filter (role scope still applied in app.js)
  function sourceROs() {
    if (Array.isArray(window.__unscopedROs) && window.__unscopedROs.length) return window.__unscopedROs;
    return Array.isArray(window.calculatedROs) ? window.calculatedROs : [];
  }

  function statusOf(ro) {
    const s = String(ro.new_logic_status || ro.status || '').toLowerCase();
    if (s.includes('fully')) return 'fully';
    if (s.includes('partial')) return 'partial';
    if (s.includes('off')) return 'offline';
    return 'other';
  }

  function keyOf(ro) {
    if (state.level === 'area') return String(ro.sales_area || '').trim() || 'Unassigned';
    return String(ro.territory || '').trim() || 'Unassigned';
  }

  function aggregate(list, name) {
    const g = {
      name, ros: list.length, rsp: 0, fully: 0, partial: 0, offline: 0,
      onbM: 0, onlM: 0, onbT: 0, onlT: 0, mpd2v: [], atg2v: [], ro2v: []
    };
    list.forEach(ro => {
      g.onbM += num(ro.onb_mpd); g.onlM += num(ro.onl_mpd);
      g.onbT += num(ro.onb_tnk); g.onlT += num(ro.onl_tnk);
      if (isYes(ro.auto_rsp)) g.rsp++;
      const s = statusOf(ro); if (s in g) g[s]++;
      if (validPct(ro.mpd_online_pct)) g.mpd2v.push(Number(ro.mpd_online_pct));
      if (validPct(ro.tank_online_pct)) g.atg2v.push(Number(ro.tank_online_pct));
      if (validPct(ro.avg_ro_online_pct)) g.ro2v.push(Number(ro.avg_ro_online_pct));
    });
    g.mpdEq = g.onbM ? g.onlM / g.onbM : NaN;
    g.atgEq = g.onbT ? g.onlT / g.onbT : NaN;
    g.eq = (g.onbM + g.onbT) ? (g.onlM + g.onlT) / (g.onbM + g.onbT) : NaN;
    g.mpd2 = avg(g.mpd2v);
    g.atg2 = avg(g.atg2v);
    if (g.ro2v.length) g.two = avg(g.ro2v);
    else {
      const parts = [g.mpd2, g.atg2].filter(Number.isFinite);
      g.two = parts.length ? avg(parts) : NaN;
    }
    g.rspPct = g.ros ? g.rsp / g.ros : NaN;
    g.offM = g.onbM - g.onlM; g.offT = g.onbT - g.onlT;
    delete g.mpd2v; delete g.atg2v; delete g.ro2v;
    return g;
  }

  const metric = g => state.basis === 'twoslot' ? g.two : g.eq;
  const tieMetric = g => state.basis === 'twoslot' ? g.eq : g.two;
  const fin = v => Number.isFinite(v) ? v : -1;

  function rankGroups(groups) {
    groups.sort((a, b) => fin(metric(b)) - fin(metric(a)) || fin(tieMetric(b)) - fin(tieMetric(a)) || b.ros - a.ros || a.name.localeCompare(b.name));
    let prev = null, rank = 0;
    groups.forEach((g, i) => {
      const m = metric(g);
      // equal uptime (to 2 decimals) shares the same rank
      if (prev === null || (Number.isFinite(m) ? m.toFixed(4) : 'x') !== prev) rank = i + 1;
      g.rank = Number.isFinite(m) ? rank : null;
      prev = Number.isFinite(m) ? m.toFixed(4) : 'x';
    });
    return groups;
  }

  function scopeSelected() { return window.GlobalScope ? GlobalScope.get() : []; }

  // ---------------------------------------------------------------- render
  function render() {
    const panel = $('tab-territory-performance');
    if (!panel) return;
    const all = sourceROs();
    const hasData = all.length > 0 && window.dashboardMode !== 'evcs';
    $('tp-empty').style.display = hasData ? 'none' : 'block';
    $('tp-body').style.display = hasData ? 'block' : 'none';
    if (!hasData) return;

    const sel = scopeSelected();
    const inScope = all.filter(ro => !window.GlobalScope || GlobalScope.match(ro.territory));

    // Ranking population: territory level compares all territories;
    // sales-area level ranks areas inside the selected territory scope.
    const pop = state.level === 'territory' ? all : inScope;
    const buckets = new Map();
    pop.forEach(ro => { const k = keyOf(ro); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(ro); });
    const groups = rankGroups([...buckets.entries()].map(([k, list]) => aggregate(list, k)));
    lastGroups = groups;

    // KPI cards: selected territory scope (or everything)
    const k = aggregate(inScope, 'scope');
    $('tp-scope-label').textContent = sel.length ? sel.join(', ') : 'All territories';
    setCard('tp-k-mpd', k.mpdEq, `${n0(k.onlM)} online / ${n0(k.onbM)} onboarded · ${n0(k.offM)} offline`);
    setCard('tp-k-atg', k.atgEq, `${n0(k.onlT)} online / ${n0(k.onbT)} onboarded · ${n0(k.offT)} offline`);
    setCard('tp-k-rsp', k.rspPct, `${n0(k.rsp)} of ${n0(k.ros)} outlets on Auto RSP`);
    setCard('tp-k-eq', k.eq, `MPD ${pct(k.mpdEq)} · ATG ${pct(k.atgEq)}`);
    setCard('tp-k-two', k.two, `MPD ${pct(k.mpd2)} · ATG ${pct(k.atg2)}`);

    // Basis toggles
    document.querySelectorAll('#tab-territory-performance [data-tp-basis]').forEach(el => {
      const on = el.dataset.tpBasis === state.basis;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      const chip = el.querySelector('.tp-kchip');
      if (chip) chip.textContent = on ? 'Ranking by this' : 'Click to rank';
    });
    document.querySelectorAll('#tab-territory-performance [data-tp-level]').forEach(el => {
      const on = el.dataset.tpLevel === state.level;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    const lvl = state.level === 'area' ? 'Sales Area' : 'Territory';
    const basisLabel = state.basis === 'twoslot' ? '2-Slot Uptime' : 'Equipment Uptime';
    $('tp-rank-title').textContent = `${lvl} Ranking · by ${basisLabel}`;
    $('tp-rank-sub').textContent = state.level === 'territory'
      ? `${groups.length} territor${groups.length === 1 ? 'y' : 'ies'} compared · ranking ignores the Territory filter${sel.length ? '; selected territory highlighted' : ''}`
      : `${groups.length} sales area${groups.length === 1 ? '' : 's'} in ${sel.length ? sel.join(', ') : 'all territories'}`;
    document.querySelectorAll('#tab-territory-performance .tp-lvl').forEach(el => { el.textContent = lvl; });

    renderPodium(groups);
    renderRanking(groups, sel);
    renderEquipment(groups, sel);
    renderTwoSlot(groups, sel);
  }

  function setCard(id, v, sub) {
    const el = $(id); if (!el) return;
    el.querySelector('.tp-kv').textContent = pct(v);
    el.querySelector('.tp-ks').textContent = sub;
    const bar = el.querySelector('.tp-kbar i');
    if (bar) bar.style.width = (Number.isFinite(v) ? Math.max(0, Math.min(100, v * 100)) : 0) + '%';
  }

  const isSel = (g, sel) => state.level === 'territory' && sel.length && sel.includes(g.name);
  const band = v => !Number.isFinite(v) ? '' : v >= 0.95 ? 'ok' : v >= 0.85 ? 'warn' : 'bad';
  const rankBadge = r => r == null ? '<span class="tp-rank">—</span>'
    : `<span class="tp-rank${r <= 3 ? ' tp-rank-' + r : ''}">${r}</span>`;
  const cell = v => `<td class="num"><span class="tp-pct ${band(v)}">${pct(v)}</span></td>`;

  function renderPodium(groups) {
    const el = $('tp-podium'); if (!el) return;
    const top = groups.filter(g => g.rank != null).slice(0, 3);
    const worst = groups.filter(g => g.rank != null).slice(-1)[0];
    if (!top.length) { el.innerHTML = ''; return; }
    const lbl = state.basis === 'twoslot' ? '2-slot' : 'Equipment';
    el.innerHTML = top.map(g => `
      <div class="tp-pod tp-pod-${g.rank <= 3 ? g.rank : 'x'}">
        <div class="tp-pod-rank">#${g.rank}</div>
        <div class="tp-pod-name" title="${esc(g.name)}">${esc(g.name)}</div>
        <div class="tp-pod-val">${pct(metric(g))}</div>
        <div class="tp-pod-sub">${lbl} uptime · ${n0(g.ros)} ROs</div>
      </div>`).join('') +
      (worst && groups.length > 3 ? `
      <div class="tp-pod tp-pod-low">
        <div class="tp-pod-rank">#${worst.rank} · lowest</div>
        <div class="tp-pod-name" title="${esc(worst.name)}">${esc(worst.name)}</div>
        <div class="tp-pod-val">${pct(metric(worst))}</div>
        <div class="tp-pod-sub">${lbl} uptime · ${n0(worst.ros)} ROs</div>
      </div>` : '');
  }

  function renderRanking(groups, sel) {
    const best = groups.find(g => Number.isFinite(metric(g)));
    const top = best ? metric(best) : NaN;
    $('tp-rank-body').innerHTML = groups.map(g => {
      const m = metric(g);
      const gap = Number.isFinite(m) && Number.isFinite(top) ? (m - top) * 100 : NaN;
      const w = Number.isFinite(m) ? Math.max(0, Math.min(100, m * 100)) : 0;
      return `<tr class="${isSel(g, sel) ? 'tp-sel' : ''}">
        <td class="ctr">${rankBadge(g.rank)}</td>
        <td class="tp-name">${esc(g.name)}</td>
        <td class="num">${n0(g.ros)}</td>
        <td><div class="tp-barcell"><div class="tp-bar"><i class="${band(m)}" style="width:${w}%"></i></div><b>${pct(m)}</b></div></td>
        <td class="num ${state.basis === 'equipment' ? 'tp-on' : ''}">${pct(g.eq)}</td>
        <td class="num ${state.basis === 'twoslot' ? 'tp-on' : ''}">${pct(g.two)}</td>
        <td class="num tp-gap">${g.rank === 1 || !Number.isFinite(gap) ? '—' : gap.toFixed(2) + ' pp'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="tp-none">No data</td></tr>';
  }

  function renderEquipment(groups, sel) {
    const t = aggregate(groups.length ? sourcePop() : [], 'Total');
    const row = (g, cls, rankCell) => `<tr class="${cls}">
        <td class="ctr">${rankCell}</td>
        <td class="tp-name">${esc(g.name)}</td>
        <td class="num">${n0(g.ros)}</td>
        <td class="num">${n0(g.onbM)}</td><td class="num">${n0(g.onlM)}</td><td class="num">${n0(g.offM)}</td>${cell(g.mpdEq)}
        <td class="num">${n0(g.onbT)}</td><td class="num">${n0(g.onlT)}</td><td class="num">${n0(g.offT)}</td>${cell(g.atgEq)}
        <td class="num">${n0(g.rsp)}</td><td class="num">${pct(g.rspPct)}</td>
        <td class="num ${state.basis === 'equipment' ? 'tp-on' : ''}"><b>${pct(g.eq)}</b></td>
      </tr>`;
    $('tp-eq-body').innerHTML = groups.map(g => row(g, isSel(g, sel) ? 'tp-sel' : '', rankBadge(g.rank))).join('');
    $('tp-eq-foot').innerHTML = groups.length ? row(t, 'tp-total', '') : '';
  }

  function renderTwoSlot(groups, sel) {
    const t = aggregate(groups.length ? sourcePop() : [], 'Total');
    const row = (g, cls, rankCell) => `<tr class="${cls}">
        <td class="ctr">${rankCell}</td>
        <td class="tp-name">${esc(g.name)}</td>
        <td class="num">${n0(g.ros)}</td>
        ${cell(g.mpd2)}${cell(g.atg2)}
        <td class="num ${state.basis === 'twoslot' ? 'tp-on' : ''}"><b>${pct(g.two)}</b></td>
        <td class="num">${n0(g.fully)}</td><td class="num">${n0(g.partial)}</td><td class="num">${n0(g.offline)}</td>
        ${cell(g.ros ? g.fully / g.ros : NaN)}
      </tr>`;
    $('tp-two-body').innerHTML = groups.map(g => row(g, isSel(g, sel) ? 'tp-sel' : '', rankBadge(g.rank))).join('');
    $('tp-two-foot').innerHTML = groups.length ? row(t, 'tp-total', '') : '';
  }

  // population used for the ranking (for the Total row)
  function sourcePop() {
    const all = sourceROs();
    return state.level === 'territory' ? all : all.filter(ro => !window.GlobalScope || GlobalScope.match(ro.territory));
  }

  // ---------------------------------------------------------------- export
  function exportCsv() {
    if (!lastGroups.length) { if (window.showToast) showToast('No data to export', 'error'); return; }
    const lvl = state.level === 'area' ? 'Sales Area' : 'Territory';
    const H = ['Rank (' + (state.basis === 'twoslot' ? '2-Slot' : 'Equipment') + ')', lvl, 'ROs',
      'MPD Onboarded', 'MPD Online', 'MPD Offline', 'MPD Equipment Uptime %',
      'ATG Onboarded', 'ATG Online', 'ATG Offline', 'ATG Equipment Uptime %',
      'Auto RSP ROs', 'Auto RSP %', 'Equipment Uptime %',
      'MPD 2-Slot %', 'ATG 2-Slot %', '2-Slot Uptime %', 'Fully Online', 'Partially Online', 'Offline'];
    const p = v => Number.isFinite(v) ? (v * 100).toFixed(2) : '';
    const rows = lastGroups.map(g => [g.rank ?? '', g.name, g.ros, g.onbM, g.onlM, g.offM, p(g.mpdEq), g.onbT, g.onlT, g.offT, p(g.atgEq),
      g.rsp, p(g.rspPct), p(g.eq), p(g.mpd2), p(g.atg2), p(g.two), g.fully, g.partial, g.offline]);
    const csv = [H, ...rows].map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Territory_Performance_${state.level}_${state.basis}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------- wiring
  function setBasis(b) {
    if (b !== 'equipment' && b !== 'twoslot') return;
    state.basis = b;
    try { localStorage.setItem('bpcl_tp_basis', b); } catch (e) { /* ignore */ }
    render();
  }
  function setLevel(l) {
    if (l !== 'territory' && l !== 'area') return;
    state.level = l;
    render();
  }

  function init() {
    try { const b = localStorage.getItem('bpcl_tp_basis'); if (b === 'equipment' || b === 'twoslot') state.basis = b; } catch (e) { /* ignore */ }
    const panel = $('tab-territory-performance');
    if (!panel) return;
    panel.addEventListener('click', e => {
      const b = e.target.closest('[data-tp-basis]');
      if (b) { setBasis(b.dataset.tpBasis); return; }
      const l = e.target.closest('[data-tp-level]');
      if (l) { setLevel(l.dataset.tpLevel); return; }
      if (e.target.closest('#tp-export')) exportCsv();
    });
    panel.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tp-kpi[data-tp-basis]')) {
        e.preventDefault(); setBasis(e.target.dataset.tpBasis);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Re-render when the shared dataset changes and this page is open
  window.renderTerritoryPerformance = function () {
    const p = $('tab-territory-performance');
    if (p && p.classList.contains('active')) render();
  };
  window.TerritoryPerformance = { render, setBasis, setLevel, exportCsv, state };
})();
