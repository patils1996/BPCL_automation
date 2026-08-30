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
