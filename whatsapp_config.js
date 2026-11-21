// WhatsApp dealer alert configuration (Monitoring menu)
// Sending goes through the same Google Apps Script backend as Day Monitoring
// (day_monitoring_config.js). The WhatsApp token is stored ONLY in Apps Script
// Script Properties — never put it in this file (it is public on GitHub Pages).
window.WHATSAPP_ALERT_CONFIG = {
  // Default for the "Auto-send" switch on a device that has never set it
  autoSendDefault: false,

  // Messages are only sent automatically between these times (24h, local).
  // Drops found outside this window wait and go out when the window opens.
  sendWindowStart: '08:00',
  sendWindowEnd: '21:00',

  // How often the dashboard re-checks for new drops while open (minutes)
  checkEveryMinutes: 5,

  // Maximum alerts per RO per day (across all alert types)
  maxAlertsPerRoPerDay: 2,

  signature: 'BPCL Belgaum Territory Retail Engineering.'
};
