/* ==========================================================================
   filter_drawer.js — page filters in a slide-out side drawer
   --------------------------------------------------------------------------
   Every `.dash-filter-bar` (Dashboard, MIS Dashboard) is moved into a panel
   that slides in from the right. Nothing is left on the page itself: a slim
   "Filters" tab sits on the right edge (with the number of active filters),
   and the drawer opens by tapping that tab or swiping in from the right edge.
   The selects keep their IDs and listeners, so filters still apply live.
   ========================================================================== */
(function () {
  'use strict';

  var drawers = [];
  var openOne = null;
  var lastFocus = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function vals(sel) {
    if (window.MS) return MS.vals(sel);
    return sel.value ? [sel.value] : [];
  }
  function optText(sel, v) {
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === v) return sel.options[i].textContent;
    return v;
  }
  function fieldLabel(sel) {
    var lab = sel.closest('.dfb-field');
    var span = lab && lab.querySelector(':scope > span');
    if (!span) return sel.getAttribute('aria-label') || '';
    var t = span.cloneNode(true);
    t.querySelectorAll('em').forEach(function (e) { e.remove(); });
    return t.textContent.trim();
  }

  var ICON_FILTER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function build(bar, idx) {
    if (bar.dataset.fdDone) return;
    bar.dataset.fdDone = '1';
    var title = bar.getAttribute('aria-label') || 'Filters';
    var id = 'fd-' + idx;

    // 1. slim trigger row where the bar was
    var row = document.createElement('div');
    row.className = 'fd-row';
    row.hidden = true;               // filters no longer take space on the page
    row.setAttribute('data-share-hide', '');
    row.innerHTML =
      '<button type="button" class="fd-open" aria-haspopup="dialog" aria-controls="' + id + '" aria-expanded="false">' +
        ICON_FILTER + '<span>Filters</span><span class="fd-badge" hidden></span>' +
      '</button>' +
      '<div class="fd-chips" aria-live="polite"></div>' +
      '<button type="button" class="fd-clear-inline" hidden>Clear all</button>';
    bar.parentNode.insertBefore(row, bar);

    // 2. drawer on <body> (fixed, outside any card/transform)
    var backdrop = document.createElement('div');
    backdrop.className = 'fd-backdrop';
    var drawer = document.createElement('aside');
    drawer.className = 'fd-drawer';
    drawer.id = id;
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', id + '-t');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML =
      '<div class="fd-head">' +
        '<div class="fd-title">' + ICON_FILTER + '<span id="' + id + '-t">' + esc(title) + '</span><span class="fd-badge" hidden></span></div>' +
        '<button type="button" class="fd-close" aria-label="Close filters">' + ICON_X.replace(/12/g, '18') + '</button>' +
      '</div>' +
      '<div class="fd-body"></div>' +
      '<div class="fd-foot">' +
        '<button type="button" class="fd-clear">Clear all</button>' +
        '<button type="button" class="fd-done">Show results</button>' +
      '</div>';
    drawer.querySelector('.fd-body').appendChild(bar);
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    var d = { bar: bar, row: row, drawer: drawer, backdrop: backdrop, btn: row.querySelector('.fd-open'), total: 0 };
    drawers.push(d);

    d.btn.addEventListener('click', function () { open(d); });
    backdrop.addEventListener('click', function () { close(d); });
    drawer.querySelector('.fd-close').addEventListener('click', function () { close(d); });
    drawer.querySelector('.fd-done').addEventListener('click', function () { close(d); });
    drawer.querySelector('.fd-clear').addEventListener('click', function () { clearAll(d); });
    row.querySelector('.fd-clear-inline').addEventListener('click', function () { clearAll(d); });
    row.querySelector('.fd-chips').addEventListener('click', function (e) {
      var b = e.target.closest('.fd-chip-x');
      if (!b) return;
      var sel = document.getElementById(b.dataset.sel);
      if (!sel) return;
      var keep = vals(sel).filter(function (v) { return v !== b.dataset.val; });
      if (window.MS) MS.set(sel, keep); else sel.value = keep[0] || '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(function () { sync(d); }, 0);
    });

    bar.addEventListener('change', function () { setTimeout(function () { sync(d); }, 0); });
    // pages update their own "n active" counter on every render (also after
    // the shared Territory changes elsewhere) → mirror it
    var count = bar.querySelector('.dfb-count');
    if (count && window.MutationObserver) {
      new MutationObserver(function () { sync(d); }).observe(count, { childList: true, characterData: true, subtree: true, attributes: true });
    }
    sync(d);
  }

  function sync(d) {
    var chips = [];
    var total = 0;
    d.bar.querySelectorAll('select[id]').forEach(function (sel) {
      var v = vals(sel);
      if (!v.length) return;
      total += v.length;
      var label = fieldLabel(sel);
      v.forEach(function (x) {
        chips.push('<span class="fd-chip"><span class="fd-chip-k">' + esc(label) + ':</span> ' + esc(optText(sel, x)) +
          '<button type="button" class="fd-chip-x" data-sel="' + esc(sel.id) + '" data-val="' + esc(x) + '" aria-label="Remove ' + esc(label + ' ' + optText(sel, x)) + '">' + ICON_X + '</button></span>');
      });
    });
    var box = d.row.querySelector('.fd-chips');
    box.innerHTML = chips.length ? chips.join('') : '<span class="fd-none">No filters applied — showing all outlets</span>';
    [d.row, d.drawer].forEach(function (scope) {
      scope.querySelectorAll('.fd-badge').forEach(function (b) { b.hidden = !total; b.textContent = total; });
    });
    d.row.querySelector('.fd-clear-inline').hidden = !total;
    d.total = total;
    updateEdge();
    d.drawer.querySelector('.fd-clear').disabled = !total;
    d.btn.classList.toggle('fd-active', !!total);
  }

  function clearAll(d) {
    var reset = d.bar.querySelector('.dfb-reset');
    if (reset) { reset.click(); }
    else {
      d.bar.querySelectorAll('select[id]').forEach(function (sel) {
        if (window.MS) MS.set(sel, []); else sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    setTimeout(function () { sync(d); }, 0);
  }

  function open(d) {
    if (openOne && openOne !== d) close(openOne, true);
    openOne = d;
    lastFocus = document.activeElement;
    d.drawer.setAttribute('aria-hidden', 'false');
    d.btn.setAttribute('aria-expanded', 'true');
    if (edge) edge.setAttribute('aria-expanded', 'true');
    d.drawer.classList.add('fd-show');
    d.backdrop.classList.add('fd-show');
    document.body.classList.add('fd-lock');
    sync(d);
    setTimeout(function () {
      var first = d.drawer.querySelector('.ms-btn, select, button.fd-close');
      if (first) first.focus();
    }, 220);
  }

  function close(d, silent) {
    if (!d) return;
    d.drawer.classList.remove('fd-show');
    d.backdrop.classList.remove('fd-show');
    d.drawer.setAttribute('aria-hidden', 'true');
    d.btn.setAttribute('aria-expanded', 'false');
    if (edge) edge.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('fd-lock');
    if (openOne === d) openOne = null;
    if (!silent && lastFocus && document.contains(lastFocus) && lastFocus.offsetParent !== null) lastFocus.focus();
    else if (!silent && edge && !edge.hidden) edge.focus();
  }

  // Esc closes the drawer — unless a dropdown inside it is open (Esc closes that first)
  window.addEventListener('keydown', function (e) {
    if (!openOne) return;
    if (e.key === 'Escape') {
      if (document.body.classList.contains('ms-is-open') || document.querySelector('.ms-panel')) return;
      close(openOne);
    } else if (e.key === 'Tab') {
      // keep focus inside the drawer
      var f = Array.prototype.filter.call(openOne.drawer.querySelectorAll('button, select, input, [tabindex]:not([tabindex="-1"])'),
        function (el) { return !el.disabled && el.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  }, true);

  // close when the user switches menu
  document.addEventListener('click', function (e) {
    if (openOne && e.target.closest('.sidebar .menu-item')) close(openOne, true);
  });

  // ---- right-edge "Filters" tab + swipe gesture --------------------------
  var edge = null;

  // the drawer that belongs to the page on screen (its bar's old spot is visible)
  function current() {
    for (var i = 0; i < drawers.length; i++) {
      var r = drawers[i].row;
      var panel = r.closest('.tab-panel');
      if (panel && !panel.classList.contains('active')) continue;
      var sec = r.closest('#automation-overview-sec');
      if (sec && getComputedStyle(sec).display === 'none') continue;   // EVCS mode
      if (r.parentNode && r.parentNode.offsetParent === null && !panel) continue;
      return drawers[i];
    }
    return null;
  }

  function updateEdge() {
    if (!edge) return;
    var d = current();
    var loggedIn = !document.getElementById('login-overlay') || getComputedStyle(document.getElementById('login-overlay')).display === 'none';
    edge.hidden = !d || !loggedIn;
    if (!d) return;
    edge.setAttribute('aria-controls', d.drawer.id);
    var b = edge.querySelector('.fd-badge');
    b.hidden = !d.total; b.textContent = d.total;
    edge.classList.toggle('fd-active', !!d.total);
    edge.setAttribute('aria-label', 'Open filters' + (d.total ? ' (' + d.total + ' active)' : ''));
  }

  function buildEdge() {
    edge = document.createElement('button');
    edge.type = 'button';
    edge.className = 'fd-edge';
    edge.hidden = true;
    edge.setAttribute('aria-haspopup', 'dialog');
    edge.setAttribute('aria-expanded', 'false');
    edge.setAttribute('data-share-hide', '');
    edge.innerHTML = '<span class="fd-edge-grip" aria-hidden="true"></span>' + ICON_FILTER +
      '<span class="fd-edge-txt">Filters</span><span class="fd-badge" hidden></span>';
    edge.addEventListener('click', function () { var d = current(); if (d) open(d); });
    document.body.appendChild(edge);

    // keep it in sync with the page on screen
    if (window.MutationObserver) {
      new MutationObserver(updateEdge).observe(document.body, { attributes: true, attributeFilter: ['data-tab', 'class'] });
      var lo = document.getElementById('login-overlay');
      if (lo) new MutationObserver(updateEdge).observe(lo, { attributes: true, attributeFilter: ['style'] });
      var sec = document.getElementById('automation-overview-sec');
      if (sec) new MutationObserver(updateEdge).observe(sec, { attributes: true, attributeFilter: ['style'] });
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest('.sidebar .menu-item')) setTimeout(updateEdge, 0);
    });
    updateEdge();
  }

  // Swipe: from the right edge (or on the tab) leftwards → open;
  //        on the open drawer rightwards → close.
  var sw = null;
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { sw = null; return; }
    var t = e.touches[0], w = window.innerWidth;
    if (openOne) {
      if (openOne.drawer.contains(e.target) && !e.target.closest('.ms-panel')) sw = { x: t.clientX, y: t.clientY, mode: 'close' };
      else sw = null;
      return;
    }
    var onEdge = t.clientX >= w - 24 || (edge && !edge.hidden && edge.contains(e.target));
    sw = (onEdge && current()) ? { x: t.clientX, y: t.clientY, mode: 'open' } : null;
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!sw) return;
    var t = e.touches[0], dx = t.clientX - sw.x, dy = Math.abs(t.clientY - sw.y);
    if (dy > 60 && dy > Math.abs(dx)) { sw = null; return; }            // vertical scroll
    if (sw.mode === 'open' && dx < -40) { var d = current(); sw = null; if (d) open(d); }
    else if (sw.mode === 'close' && dx > 70 && dy < 50) { sw = null; close(openOne); }
  }, { passive: true });
  document.addEventListener('touchend', function () { sw = null; }, { passive: true });

  function init() {
    document.querySelectorAll('.dash-filter-bar').forEach(build);
    buildEdge();
  }
  // after multiselect.js has turned the selects into dropdowns
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); });
  else setTimeout(init, 0);

  window.FilterDrawer = {
    open: function (i) { if (drawers[i || 0]) open(drawers[i || 0]); },
    close: function () { close(openOne); },
    refresh: function () { drawers.forEach(sync); updateEdge(); }
  };
})();
