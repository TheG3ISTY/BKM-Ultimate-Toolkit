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

## Two factions

The tool now serves **two whitelisted factions**: Boykisser Meetup `#56875`
and Static Hearts `#45990`. Anyone with a key from either faction can enter.

- **Hit list:** each target records **which faction added it** (auto-detected
  from the caller's key — no dropdown). A **Shared** checkbox marks a target as
  an enemy of *both* factions. The list has a faction filter (All / Boykisser
  Meetup / Static Hearts / Shared) and colours rows by origin: Boykisser Meetup
  **blue**, Static Hearts **pink**, Shared **purple**.
- To whitelist more factions later, add them to `var FACTIONS = {...}` at the
  top of `Code.gs` and redeploy.

## War list — one roster per faction

The **⚔️ War List** view has a **sub-tab per faction** (Boykisser Meetup /
Static Hearts), so both can run a war at once. Each roster is generated from an
enemy faction ID and is **master-controlled**: only that roster's warmaster may
generate, update, activate, or clear it — everyone else gets a **read-only**
view. Non-masters only see a roster once its master has **activated** it.

- Masters are configured in `Code.gs` as `var MASTERS = [...]` (Torn player IDs).
  **Warmaster and listmaster are one unified role**: a master controls *both* war
  rosters *and* hit-list curation (delete / Manual / Shared / Faction). Currently
  `[4117638, 3558000]` (TheG3ISTY, Madilynn-SkyBby). Add or remove an ID and
  redeploy to change who has control. Each master uses their own API key.
- Each roster is written to its own tab (auto-created): **`War`** (Boykisser
  Meetup) and **`War_SH`** (Static Hearts). Activation state lives in Script
  Properties, not a cell.
- Generating pulls the enemy faction's members via Torn's public `faction/{id}`
  data, using the master's own key. No extra permissions or Full-access key needed.

**After pasting the updated `Code.gs`, you must redeploy** for the changes to
go live: **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy.**
The `/exec` URL stays the same, so `index.html` needs no change. Existing sheets
migrate non-destructively: the new `Faction`/`Shared` columns are appended and
legacy targets default to Boykisser Meetup.

---

### Notes
- **“Anyone” access is safe here:** every action requires a Torn API key that the
  script verifies belongs to a **whitelisted faction** (`56875` or `45990`) before
  reading or writing. Randoms who find the URL can't do anything.
- **If the script is ever updated:** in Apps Script, **Deploy → Manage deployments
  → ✏️ edit → Version: New version → Deploy.** The `/exec` URL stays the same.
- The Sheet stays **private** — don't share/publish it. Access flows only through
  the verified script, so the list is not publicly readable.
