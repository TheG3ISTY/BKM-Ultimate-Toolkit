# Google Sheets sync — one-time setup (~10 min)

This turns a Google Sheet into the shared, faction-only backend for the hit list.
Do these steps once, then send Claude the **Web app URL**.

## 1. Create the Sheet
- Go to <https://sheets.new> (a blank Google Sheet). Name it e.g. **BKM Hit List**.
- Leave it empty — don't add tabs or headers. The script builds a `Targets` tab automatically.

## 2. Add the script
- In the Sheet: **Extensions → Apps Script**.
- Delete whatever's in the editor, then paste the entire contents of [`Code.gs`](./Code.gs).
- Click the **Save** icon (💾).

## 3. Deploy as a Web App
- Top-right: **Deploy → New deployment**.
- Click the ⚙ gear → choose **Web app**.
- Set:
  - **Description:** `BKM hitlist API`
  - **Execute as:** **Me**
  - **Who has access:** **Anyone**   ← required so the app can call it without a Google login
- Click **Deploy**.

## 4. Authorize (one time)
- Google will ask you to authorize. Pick your account.
- You'll see **“Google hasn't verified this app.”** That's normal for a personal script.
  → Click **Advanced** → **Go to BKM Hit List (unsafe)** → **Allow**.
- (You're granting it access to *your* spreadsheet and permission to call the Torn API. No secrets are stored.)

## 5. Copy the URL
- After deploying, copy the **Web app URL** — it ends in **`/exec`**, like:
  `https://script.google.com/macros/s/AKfy..................../exec`
- **Send that URL to Claude.** That's it on your end.

---

## War list (second tab)

The app has a second view, **War List**, generated from an enemy faction ID.
It's **master-controlled**: only one Torn player may generate, update, activate,
or clear it. Everyone else in the faction can only *read* it, and only once the
master has **activated** it (before that, only the master sees it).

- The master is pinned in `Code.gs` as `var MASTER_ID = 4117638;` (TheG3ISTY).
  To hand the tool to someone else, change that number to their Torn player ID
  and redeploy (see below).
- The roster is written to a separate **`War`** sheet tab (auto-created).
  Activation state lives in Script Properties, not a cell.
- Generating pulls the enemy faction's members via Torn's public `faction/{id}`
  data, using the master's own key. No extra permissions or Full-access key needed.

**After pasting the updated `Code.gs`, you must redeploy** for the War actions to
go live: **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy.**
The `/exec` URL stays the same, so `index.html` needs no change.

---

### Notes
- **“Anyone” access is safe here:** every action requires a Torn API key that the
  script verifies belongs to faction **56875** before reading or writing. Randoms
  who find the URL can't do anything.
- **If the script is ever updated:** in Apps Script, **Deploy → Manage deployments
  → ✏️ edit → Version: New version → Deploy.** The `/exec` URL stays the same.
- The Sheet stays **private** — don't share/publish it. Access flows only through
  the verified script, so the list is not publicly readable.
