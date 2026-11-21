const CACHE_NAME = 'bpcl-dashboard-v53';
const ASSETS = [
  './',
  './index.html',
  './tank_stock_dashboard.html',
  './manifest.json',
  './pwa-install.js',
  './tank_stock.js',
  './day_end_mis.js',
  './day_end_mis.css',
  './territory_performance.js',
  './territory_performance.css',
  './filter_drawer.js',
  './filter_drawer.css',
  './data_freshness.js',
  './data_freshness.css',
  './share_kit.js',
  './share_kit.css',
  './tank_stock_ui.css',
  './overview_layout.css',
  './multiselect.js',
  './multiselect.css',
  './scope_filter.js',
  './workbook_reader.js',
  './xlsx_worker.js',
  './html2canvas.min.js',
  './jspdf.umd.min.js',
  './styles.css',
  './ui-refresh.css',
  './ui-refresh.js',
  './app.js',
  './trend.js',
  './comparison.js',
  './new_logic_dashboard.js',
  './outlets_status.js',
  './whatsapp_alerts.js',
  './whatsapp_config.js',
  './day_monitoring_config.js',
  './sample_data.js',
  './xlsx.full.min.js',
  './chart.umd.min.js',
  './favicon-32x32.png',
  './favicon.ico',
  './bpcl_emblem_official.png',
  './bpcl_logo_card.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(err => console.warn('Cache addAll failed:', err));
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Only handle same-origin GET requests; let API calls (Apps Script, Google Sheets, POSTs) go straight to the network
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Network-first so new deployments show immediately; cached copy keeps the app working offline
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((res) => res || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
