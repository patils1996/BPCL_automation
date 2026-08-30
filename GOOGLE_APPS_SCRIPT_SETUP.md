# Google Drive / Shared Day Monitoring Setup

## 1. Deploy the backend
1. Open Google Apps Script and create a project.
2. Copy the contents of `Code.gs`.
3. Change `API_KEY` to a private value you choose.
4. If the existing Drive folder is not accessible to the Google account running the script, remove/change `DRIVE_FOLDER_ID`.
5. Run `setupBackend()` once and approve permissions.
6. Deploy > New deployment > Web app.
7. Execute as **Me**.
8. Who has access: **Anyone**.
9. Copy the `/exec` URL.

## 2. Configure the GitHub Pages frontend
Open `day_monitoring_config.js` and set:
- `apiUrl` = the Apps Script `/exec` URL
- `apiKey` = the same value used in `Code.gs`

Then push the project to GitHub Pages.

## 3. What is synchronized
The Day Monitoring Responsibility and Complaint Remarks are saved centrally by date + ROID + Territory. Every user loads the same values. Each update also records the user name and timestamp.

The browser still keeps a local fallback if the network is unavailable.

## 4. Daily Drive archive
Click **Save Daily Data to Drive** in Day Monitoring. The backend:
- saves/updates the day's rows,
- creates `Automation_Day_Monitoring_YYYY-MM-DD.csv`,
- stores it in the configured Drive folder,
- records the Drive file URL in `DayMonitoringSnapshots`.

## Security note
Do not publish API keys or other passwords in GitHub. The existing project contains credentials in `sync_config.json`; rotate those credentials if they are real and remove secrets from the public repository.


### Fully automatic daily backup

After `setupBackend()` is run, the Apps Script installs a time-driven trigger named `automaticDailyBackup`. It runs approximately every day at **11:55 PM** using the Apps Script project timezone and archives the shared Day Monitoring data to Google Drive without the dashboard being open.

For India time, set the Apps Script project timezone to **Asia/Kolkata (GMT+05:30)** before/after running setup.

The GitHub Pages dashboard automatically pushes the current offline/partially-online Day Monitoring rows to the shared backend every 10 minutes and immediately after a fresh live-data sync. Dependency/Responsibility and Complaint Remarks continue to sync whenever changed.

You can run `testDailyBackupNow()` manually from Apps Script to verify the Drive archive before waiting for the nightly trigger.
