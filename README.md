# BPCL Belgaum Territory Automation Daily Monitoring Dashboard

An elegant, fully responsive, and dynamic dashboard built for daily monitoring, tracking, and comparing the online uptime status of retail outlet technologies (Automation, ATG, EVCS, PINELAB/IOT). 

This application operates entirely in the browser (static frontend) and utilizes local **IndexedDB** for secure and persistent data logs. No backend server is required, making it 100% compatible with static hosting environments such as **GitHub Pages**.

## 🚀 Key Features

* **Neumorphic Interface**: Beautiful, responsive, soft-shadow neumorphic UI tailored for both **Laptops & Mobile screens**.
* **Yesterday vs Today Status Comparison**: A dedicated *Monitoring* tab comparing daily 10 PM status runs against today's active data to instantly spot drops (`Drop 🔴 ⬇️`) and upgrades (`Improvement 🟢 ⬆️`).
* **Dynamic Header Filters**: Instant filter dropdowns in both the *Day Monitoring* and *Monitoring* tables.
* **Role-Based Access Control (RBAC)**: Secure scoping for Admins, Territory Managers, Engineering Officers, Sales Officers, and Vendors (passwords and logs stored locally).
* **Tactile KPI Modals**: Clickable raised KPI buttons displaying detailed lists with custom CSV exporting.

---

## 🌐 Deploy to GitHub Pages (Access Anywhere / Mobile)

Since the app is purely frontend, you can deploy it to **GitHub Pages** in under a minute:

1. **Upload Code to GitHub**:
   - Create a new public repository on GitHub (e.g. `automation-dashboard`).
   - Push this directory's files to your repository:
     ```bash
     git add .
     git commit -m "Initial commit of responsive monitoring dashboard"
     git branch -M main
     git remote add origin https://github.com/YOUR_USERNAME/automation-dashboard.git
     git push -u origin main
     ```

2. **Enable GitHub Pages**:
   - Go to your repository on GitHub.com.
   - Click on the **Settings** tab.
   - Select **Pages** from the left-hand sidebar navigation.
   - Under *Build and deployment*, set the Source to **Deploy from a branch**.
   - Under *Branch*, select **main** (and `/root` folder), then click **Save**.

3. **Open the Dashboard**:
   - GitHub will generate a link for you, typically: `https://YOUR_USERNAME.github.io/automation-dashboard/`
   - You can immediately open this link on your **Mobile Phone, Tablet, or Laptop** to access the dashboard on the go!

---

## 🛠 Local Development / Host Locally
To run locally, simply start a static server in this directory:
```bash
python -m http.server 8000
```
Then open `http://localhost:8000` in your web browser.


## ☁️ Shared Day Monitoring + Google Drive

The Day Monitoring **Responsibility/Dependency and Complaint Remarks** are now designed for shared cloud storage. Browser `localStorage` is retained only as an offline fallback.

### One-time Google Apps Script setup

1. Open `Code.gs` in Google Apps Script.
2. Change `API_KEY: 'CHANGE_THIS_KEY'` to your own value.
3. Run `setupBackend()` once and authorize Google Sheets/Drive access.
4. Deploy → New deployment → Web app.
5. Execute as **Me** and allow access to **Anyone**.
6. Copy the `/exec` URL into `day_monitoring_config.js` as `apiUrl`.
7. Use the same API key in `day_monitoring_config.js`.
8. Reload the GitHub Pages application.

The backend creates:
- `BPCL Automation Shared Day Monitoring` Google Sheet
- `DayMonitoring` sheet for shared current/historical records
- `DayMonitoringSnapshots` sheet for archive log
- `Automation Daily Archive` folder in Google Drive

### Daily workflow

Changes to Responsibility/Remarks are automatically synchronized to the shared sheet. The **Save Daily Data to Drive** button creates/replaces the day's CSV snapshot in the shared Google Drive folder. The frontend also auto-syncs current Day Monitoring rows every 10 minutes, and the Apps Script runs an automatic nightly Drive backup around 11:55 PM.

> Important: the existing local login is a frontend-only login. It is not suitable as a security boundary for sensitive data. The Apps Script API key is also a shared application credential, not a user identity system.


### Fully automatic daily backup

After `setupBackend()` is run, the Apps Script installs a time-driven trigger named `automaticDailyBackup`. It runs approximately every day at **11:55 PM** using the Apps Script project timezone and archives the shared Day Monitoring data to Google Drive without the dashboard being open.

For India time, set the Apps Script project timezone to **Asia/Kolkata (GMT+05:30)** before/after running setup.

The GitHub Pages dashboard automatically pushes the current offline/partially-online Day Monitoring rows to the shared backend every 10 minutes and immediately after a fresh live-data sync. Dependency/Responsibility and Complaint Remarks continue to sync whenever changed.

You can run `testDailyBackupNow()` manually from Apps Script to verify the Drive archive before waiting for the nightly trigger.

## 📊 Comparison menu (3-Day EOD Root-Cause Engine, v4)

* **Real data only.** Each day's EOD comes from (in priority order): a 10:00 PM capture → the Google Sheet sync / upload closest to 10:00 PM that day → the currently loaded data (today only, marked *Live / provisional*). No synthetic history is generated.
* **Data coverage strip** shows the last 14 days and the source of each. Click a day to compare it with the two days before it.
* **Status basis**: *Column V* (RO's Online) or *MPD/ATG* telemetry. A warning appears when Column V contradicts telemetry (e.g. all ROs "Offline" while MPDs/tanks are online).
* **Classification**: Equipment Issue (down days coincide with MPD/ATG faults) · Possible Dealer Issue (down 2+ days with healthy telemetry) · Requires Verification (single-day drop, or Online with a fault) · Normal.
* **Hotspots** by Sales Area / EO / SO / Vendor, trend column, sortable headers, Excel export (Summary, Outlet Comparison, Hotspots).
* **Import past day** adds an old MIS file to history for a chosen date without touching live data.
* Auto-capture runs at 10:00 PM while the dashboard is open (it syncs the sheet first). Snapshots are stored in IndexedDB.

## 💬 WhatsApp dealer alerts (Monitoring menu)

Status drops vs yesterday ~10 PM trigger WhatsApp alerts to the dealer: Offline → check internet connection; MPD down → Turn ON all MPDs; ATG down → restart ATG; every alert → raise a complaint if a technical fault persists. Sending is automatic through the Apps Script backend (WhatsApp Cloud API) or one-click via WhatsApp. Setup: see `WHATSAPP_ALERTS_SETUP.md`.

## 🎨 UI refresh (Nov 2026)

The interface was refreshed without changing any data logic:

* `ui-refresh.css` — design layer loaded after `styles.css` (tokens, cards, KPI tiles, tables with sticky headers, status pills, buttons, forms, modals, login, responsive rules). Delete the `<link>` to fall back to the old look.
* `ui-refresh.js` — keeps the header title/breadcrumb in sync with the active tab, adds a tooltip + "data loaded" dot to the file meta, and sets Chart.js defaults (font, tooltip, legend).
* Header rebuilt into a title row (breadcrumb, page title, actions, user menu) and a status row (territory, date/time, outlet count, loaded file).
* Sidebar grouped into Overview / Monitoring / Summaries / Data; tabs are matched by `data-tab`, which also fixes Mappings Database never showing as active.
* New split-panel sign-in screen.
* Service worker cache bumped to `v15` so browsers pick up the new files; missing `manifest.json` / icon entries were removed from the pre-cache list (they made the whole offline cache fail).

## 📑 Day End MIS Exporter (REPORTS → Day End MIS Exporter)

Builds the day-end automation MIS from stored snapshots. Every upload / Sheet sync is saved in the browser database; the **last snapshot of each date is that day's Day End**.

* **Pick:** report date (or live data), snapshot, comparison day (defaults to the previous Day End), status basis (equipment count or Column V) and Sales Area / TE / Vendor filters.
* **Preview:** KPI cards with day-on-day deltas, plus Sales Area / TE / SO / Vendor tables and Offline, Partial and Changes lists. On phones the RO lists turn into cards.
* **Export Excel MIS:** up to 9 sheets: MIS Summary, Sales Area, TE Wise, SO Wise, Vendor Wise, Offline ROs (with consecutive offline days), Partial ROs, Day-on-Day Changes and RO Wise Detail. Includes responsibility/remarks, % formats and filters.
* **Share Excel** (phones/tablets), **WhatsApp Summary** (copy or open WhatsApp) and **Print / PDF** (A4 landscape).

## 📤 Share (every page)

* **Share button** (bottom-right, on every page) opens the BPCL share sheet with a preview of the page. You can:
  * send a **WhatsApp** text summary (the text can be edited first),
  * share the page as an **Image** or an A4 **PDF** through the phone's share menu (WhatsApp, Gmail, Teams…),
  * or **download** the image or PDF, or copy the text.
* Images include a BPCL-branded header and footer, and capture full tables, not just the visible part.
* The Dashboard KPI pop-ups (Partially Online, Offline, MPD, Tank…) now have **CSV · Image · Share** buttons.
* `html2canvas.min.js` and `jspdf.umd.min.js` are bundled locally (they load only when needed and work offline).

## ☑️ Multi-select filters (all pages)

Every filter dropdown that starts with "All …" now accepts several choices at once, for example Fully Online + Offline, or two sales areas:
- RO Explorer, Day Monitoring, Monitoring, 3-Day Comparison, MIS Dashboard, Outlets Status, RO-Wise Tank Stock and Day End MIS.
- The Dashboard has a filter bar at the top (Sales Area, Territory Engineer, Vendor, Uptime Status, Technology) using the same dropdowns. It shows how many filters are active and has a **Clear filters** button.

Each dropdown has Select all, Clear and Done buttons, plus search when there are many options. On phones it opens as a bottom sheet. The logic lives in `multiselect.js` / `multiselect.css`; use `MS.vals(id)` and `MS.ok(values, v)` in filter code.

## 🗺️ Territory filter (all menus)

- **Where it is:** the **Territory** dropdown is in the Dashboard filter bar, the MIS Dashboard filter bar, the Tank Stock filters, and a navy strip at the top of every other menu.
- **What it does:** choosing territories in any of these applies to **every menu**. That covers the Dashboard, summaries, RO Explorer, Day Monitoring, Monitoring, Comparison, Performance Trend, Outlets Status, MIS, Day End MIS and Tank Stock.
- **Memory:** the choice is remembered on the device. **Clear filters** resets it.
- **Where the values come from:** the `Territory` column of the uptime Excel (`State Office` and `Region` are read too). Snapshots saved before this update have no territory recorded, so they stay visible under any territory.
- **For developers:** the logic is in `scope_filter.js` (`GlobalScope.get / match / set`).
- **MIS Dashboard:** it now has its own filter bar (Territory, Sales Area, TE, Vendor, RO Status, Technology), and its KPIs, bars and table follow it.

## Google Sheet sync — one workbook for Uptime + Tank Stock (v11)

All data now comes from the **same published Google workbook** (no Google Drive connection needed).
Keep these tabs in it (names are matched loosely, order does not matter):

| Sheet | Used for | Name must contain |
|---|---|---|
| 1. Raw Data | Automation uptime monitoring (unchanged format) | `Raw Data` (or "uptime" / "automation") |
| 2. Last updated stock | Tank latest stock | `last` / `latest` / `current` + `stock` |
| 3. Stock hourly | Tank hourly trend | `hourly` |
| 4. Onboarded tanks | Tank mapping / online status | `onboard` (or "tank master" / "tank list") |
| TE-SO Mapping, HistoryArchive | Optional, as before | — |

**How updates reach the app**
- On login the sheet is read, and again every **5 minutes** while the page is open (and when you return to the tab). Change the interval with `localStorage.bpcl_sheet_autosync_min`.
- "Sync Sheet" / "Sync from Sheet" forces a refresh at any time.
- If the workbook has not changed, nothing is re-processed ("Already up to date").
- Google's *Publish to web* copy can take up to ~5 minutes to show new edits.
- Tank Stock takes each outlet's territory / sales area from the uptime sheet (by RO code), so the global Territory filter works the same on every menu.

**Speed changes**
- The workbook is read in a background worker (`xlsx_worker.js`), so the page never freezes.
- Two-stage read: the uptime sheet is ready in ~1–2 s; the large hourly tank sheet follows in the background.
- Unchanged workbooks are skipped by a fingerprint check.
- New history snapshots no longer store a full copy of the workbook, and identical snapshots are skipped.
- History records are cached in memory instead of being re-read from the database on every screen.
