"""
BPCL Tank Stock - Google Drive Folder Auto-Sync Daemon
Monitors Google Drive File Stream folder (17C1s0lqJ0jCZqc_xmRB2H_YGOro1pUk4 / Test tanks status)
and copies updated Excel workbooks to the dashboard directory.
"""

import os
import sys
import time
import shutil
import hashlib

GDRIVE_FOLDER_ID = "17C1s0lqJ0jCZqc_xmRB2H_YGOro1pUk4"
GDRIVE_DEFAULT_PATH = r"G:\My Drive\TL-PATIL- 2026\Technology\Test tanks status"
LOCAL_WORKSPACE_PATH = os.path.dirname(os.path.abspath(__file__))

FILES = [
    "Stock hourly.xlsx",
    "Last updated stock.xlsx",
    "Onboarded tanks.xlsx"
]

def get_file_hash(path):
    try:
        with open(path, "rb") as f:
            return hashlib.md5(f.read()).hexdigest()
    except Exception:
        return None

def sync_once(drive_path=GDRIVE_DEFAULT_PATH, local_path=LOCAL_WORKSPACE_PATH):
    if not os.path.isdir(drive_path):
        print(f"[WARN] Google Drive folder not found at: {drive_path}")
        print("Ensure Google Drive for desktop is running and drive G: is mounted.")
        return False

    updated = 0
    for name in FILES:
        src = os.path.join(drive_path, name)
        dst = os.path.join(local_path, name)

        if not os.path.isfile(src):
            print(f"[SKIP] Source file missing: {src}")
            continue

        src_hash = get_file_hash(src)
        dst_hash = get_file_hash(dst) if os.path.isfile(dst) else None

        if src_hash != dst_hash:
            shutil.copy2(src, dst)
            print(f"[SYNC] Updated {name} from Google Drive -> Local Workspace")
            updated += 1
        else:
            print(f"[OK] {name} is already up to date.")

    return updated > 0

def watch_loop(interval=30):
    print("=" * 60)
    print("BPCL Tank Stock - Google Drive Watcher Active")
    print(f"Drive Folder ID: {GDRIVE_FOLDER_ID}")
    print(f"Drive Path     : {GDRIVE_DEFAULT_PATH}")
    print(f"Dashboard Path : {LOCAL_WORKSPACE_PATH}")
    print(f"Check Interval : {interval} seconds")
    print("=" * 60)

    while True:
        try:
            sync_once()
        except Exception as e:
            print(f"[ERROR] Sync error: {e}")
        time.sleep(interval)

if __name__ == "__main__":
    if "--watch" in sys.argv:
        watch_loop()
    else:
        sync_once()
