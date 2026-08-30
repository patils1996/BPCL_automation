import os
import sys
import json
import time
import pandas as pd
import requests
from playwright.sync_api import sync_playwright

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync_config.json")

def load_config():
    if not os.path.exists(CONFIG_PATH):
        print(f"Error: Configuration file not found at {CONFIG_PATH}")
        print("Please configure sync_config.json before running.")
        sys.exit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def run():
    config = load_config()
    
    username = config.get("neohos_username")
    password = config.get("neohos_password")
    apps_script_url = config.get("google_apps_script_url")
    territory = config.get("territory_filter", "Belgaum")
    
    if not apps_script_url or "ENTER_YOUR" in apps_script_url:
        print("Error: Please set your 'google_apps_script_url' inside sync_config.json.")
        sys.exit(1)
        
    print("Starting automated HOS data sync...")
    
    with sync_playwright() as p:
        # Launch browser (headless=True for background running)
        browser = p.chromium.launch(headless=False) # Set False to see the process if needed, or True for background
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        
        # 1. Open HOS Website
        print("Opening HOS portal...")
        page.goto("https://neohos.bpclcloud9.com", timeout=60000)
        page.wait_for_load_state("load")
        
        # Check if login is required
        if page.locator("input[type='text'], input[type='password']").count() > 0:
            print("Logging in...")
            # Detect username/password inputs dynamically
            user_input = page.locator("input[type='text'], input[placeholder*='user' i]").first
            pass_input = page.locator("input[type='password']").first
            
            user_input.fill(username)
            pass_input.fill(password)
            
            # Click sign in button
            submit_btn = page.locator("button[type='submit'], .sel-btn, text='Sign In'").first
            submit_btn.click()
            page.wait_for_load_state("load")
            time.sleep(2)
            
        # 2. Select Analytics Portal if visible
        if page.locator("text='Analytics Portal'").count() > 0:
            print("Navigating to Analytics Portal...")
            page.locator("text='Analytics Portal'").click()
            page.wait_for_load_state("load")
            time.sleep(2)
            
        # 3. Direct Navigation to the Uptime Report
        print("Loading Ro Wise Equipment Hourly Performance Monitoring Report...")
        report_url = "https://neohos.bpclcloud9.com/root/reports/66c7b585-aeb6-4d13-aa4b-06df8642e65a"
        page.goto(report_url)
        page.wait_for_load_state("load")
        time.sleep(5) # Allow report visualizations and tables to load
        
        # 4. Open Filter Panel
        print("Opening Filters panel...")
        # Locate the vertical Filters tab on the right edge
        filters_tab = page.locator(".Filters, text='Filters', [title='Filters']").first
        filters_tab.click()
        time.sleep(1)
        
        # 5. Apply Territory Filter
        print(f"Applying territory filter: '{territory}'...")
        # Click "Territories" header to expand options
        page.locator("text='Territories'").first.click()
        time.sleep(1)
        
        # Uncheck 'All' if selected, and check target territory
        # Find option containing target territory name
        target_option = page.locator(f"text='{territory}'").first
        if not target_option.is_visible():
            # If not visible, scroll the filter panel to make it visible
            target_option.scroll_into_view_if_needed()
            
        # Select target territory checkbox
        target_option.click()
        time.sleep(1)
        
        # Click APPLY button inside filter panel
        apply_btn = page.locator("button:has-text('APPLY'), .btn-primary:has-text('APPLY')").first
        apply_btn.click()
        print("Applying filters... (waiting for data reload)")
        time.sleep(5) # Allow table to filter
        
        # Close filters pane
        page.locator("text='Filters'").first.click()
        time.sleep(1)
        
        # 6. Trigger CSV/Excel Export
        print("Exporting data...")
        # Find three dots next to 'Click On' text or container
        dots_menu = page.locator("text='...'").first
        if not dots_menu.is_visible():
            # fallback: find button inside table card header
            dots_menu = page.locator(".table-card-header button, .table-card button").last
            
        # Start download tracking
        with page.expect_download() as download_info:
            dots_menu.click()
            time.sleep(1)
            # Click download export option in popup menu
            export_option = page.locator("text='export data', text='Download', text='CSV', text='Excel'").first
            export_option.click()
            
        download = download_info.value
        download_path = os.path.join(os.getcwd(), download.suggested_filename)
        download.save_as(download_path)
        print(f"Successfully downloaded report data to: {download_path}")
        
        # Close browser
        browser.close()
        
    # 7. Parse downloaded Excel/CSV and POST to Google Sheets Web App
    print("Reading downloaded file...")
    if download_path.endswith('.xlsx') or download_path.endswith('.xls'):
        df = pd.read_excel(download_path)
    else:
        df = pd.read_csv(download_path)
        
    # Replace NaN values with empty strings for JSON compatibility
    df = df.fillna("")
    
    # Convert data frame to nested list (including header row as first list element)
    headers = df.columns.tolist()
    rows = df.values.tolist()
    data_payload = [headers] + rows
    
    print(f"Sending {len(rows)} data rows to Google Sheets Apps Script Web App...")
    response = requests.post(apps_script_url, json=data_payload, timeout=30)
    
    if response.status_code == 200:
        result = response.json()
        if result.get("status") == "success":
            print("✓ Google Sheet updated successfully!")
        else:
            print("❌ Apps Script Error:", result.get("error"))
    else:
        print(f"❌ Failed to POST data. HTTP Status Code: {response.status_code}")
        
    # Clean up local file
    try:
        os.remove(download_path)
        print("Cleaned up temporary download file.")
    except Exception as e:
        print("Warning: Could not remove temporary file:", e)

if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print("Error during execution:", e)
        sys.exit(1)
