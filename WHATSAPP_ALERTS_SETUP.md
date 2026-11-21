# WhatsApp Dealer Alerts — Setup (Monitoring menu)

The Monitoring menu compares current status with yesterday's ~10:00 PM data. For every **drop** it can WhatsApp the dealer automatically:

| Current status | Message tells the dealer to |
|---|---|
| Offline | Make sure the internet connection works (router/modem ON, SIM/broadband active with data balance), the automation FCC is ON and the HOS status is green |
| Partial – MPD not communicating | Turn ON all MPDs and check they are connected |
| Partial – ATG not communicating | Restart the ATG console and check it is powered ON |
| Partial – both | Both of the above |
| Every alert | If the problem continues or there is any technical fault, raise a complaint with the automation vendor / helpdesk and share the complaint number with the SO |

Each RO gets at most one alert per alert type per day (and at most 2 per day in total). Alerts go out only between 08:00 and 21:00; drops found later wait for the next morning. Change these in `whatsapp_config.js`.

Without the steps below, the **WhatsApp** button on each dropped row still works: it opens WhatsApp with the message pre-filled, and you press send.

---

## 1. WhatsApp Business Platform (Meta)

1. In Meta Business Suite / developers.facebook.com, create an app with **WhatsApp** and add the business phone number that will send alerts. Use the number/business account your office is allowed to use for BPCL communication.
2. Create a **permanent access token** (System User with `whatsapp_business_messaging` permission).
3. Note the **Phone number ID** (not the phone number itself).
4. Create a message template:
   * **Name:** `ro_automation_alert`
   * **Category:** Utility
   * **Language:** English (`en`)
   * **Body** (copy exactly; the variables are filled by the backend):

```
*BPCL Automation Alert*
RO: {{1}} (CC {{2}})
Current Status: {{3}}
Yesterday Status: was {{4}} as of {{5}}

*Action needed:* {{6}}

If the problem continues after these checks, or there is any technical fault in the equipment, please raise a complaint with the Automation vendor / automation helpdesk immediately and share the complaint number with your Sales Officer.

– BPCL Belgaum Territory Retail Engineering.
```

   Sample values for approval: `S.B.KARADI PETROLEUM`, `159846`, `Offline`, `Fully Online`, `11:15 PM, 14 Nov`, `Your outlet automation is showing OFFLINE. Please make sure the internet connection is working (router/modem ON, SIM or broadband active with data balance) and that the automation FCC is switched ON and the HOS status is green.`

5. Dealers should agree to receive WhatsApp alerts from this number (Meta requires opt-in for business-initiated messages).

## 2. Apps Script backend

1. Paste the updated `Code.gs` into the existing Apps Script project (the same one used for Day Monitoring).
2. **Project Settings → Script properties**, add:

| Property | Value |
|---|---|
| `WA_TOKEN` | permanent access token |
| `WA_PHONE_NUMBER_ID` | phone number ID |
| `WA_TEMPLATE` | `ro_automation_alert` (optional, this is the default) |
| `WA_LANG` | `en` (optional) |
| `ADMIN_KEY` | a private password for uploading dealer numbers |
| `WA_TEST_NUMBER` | your own WhatsApp number, for testing |
| `WA_DAILY_LIMIT` | optional, default 300 |

3. Run `setupWhatsAppAlerts()` once (creates the `DealerContacts` and `WhatsAppAlertLog` sheets), then `testWhatsAppAlert()` to receive a sample on your phone.
4. **Deploy → Manage deployments → Edit → New version** (the `/exec` URL stays the same).

The token never goes into the website files.

## 3. Dealer numbers

1. Monitoring → **Contacts template** downloads an Excel with every CC code and RO name.
2. Fill **Dealer Name** and **WhatsApp Number** (10-digit or with 91).
3. **Upload dealer numbers** and enter the `ADMIN_KEY` when asked. Numbers are stored in the `DealerContacts` sheet; the dashboard only ever shows them masked. You can also edit that sheet directly (set **Active** to `N` to stop alerts to a dealer).

## 4. Turn on automatic sending

In Monitoring, switch on **Auto-send alerts for new drops** on the computer that keeps the dashboard open. It checks after every Sheet sync and every 5 minutes. Every send is recorded in `WhatsAppAlertLog` and in **Show today's log**. Several open dashboards will not double-send: the backend de-duplicates.
