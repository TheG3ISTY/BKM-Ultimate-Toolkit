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

## Factions & roles — managed live from the app (no redeploy)

The whitelist of factions and the list of masters are stored in **Script
Properties** and edited live by the **owner** through the app's **⚙ Admin**
panel — adding a faction or a master needs **no code change and no redeploy**.

- **Owner** = the one hardcoded identity, `var OWNER_ID = 4117638;` (TheG3ISTY).
  Root of trust: always passes the gate, is always a master, is the only one who
  sees the Admin panel, and can never be removed or locked out. This is the ONLY
  thing you edit in code + redeploy for.
- **Masters** (warmaster == listmaster): full control of all war rosters + hit-list
  curation (delete / Manual / Shared / Faction). Owner adds/removes them in Admin.
- **Members**: anyone in a whitelisted faction. Can add targets, edit name/notes,
  and refresh stats.
- Seeds (used only on first run, before anything is saved): whitelist =
  Boykisser Meetup `#56875` + Static Hearts `#45990`; masters = `[4117638, 3558000]`.

**Hit list:** each target records **which faction added it** (auto-detected from
the caller's key). A **Shared** checkbox (master-only) marks a target as an enemy
of *all* factions. The faction filter and row colours are generated from the live
whitelist; new factions get an auto-assigned colour.

## War list — one roster per faction

The **⚔️ War List** view has a **sub-tab per faction** (Boykisser Meetup /
Static Hearts), so both can run a war at once. Each roster is generated from an
enemy faction ID and is **master-controlled**: only that roster's warmaster may
generate, update, activate, or clear it — everyone else gets a **read-only**
view. Non-masters only see a roster once its master has **activated** it.

- Masters are managed live in the **Admin** panel (owner only), not in code.
  **Warmaster and listmaster are one unified role**: a master controls *all* war
  rosters *and* hit-list curation. Each master uses their own API key.
- There is **one war roster per whitelisted faction**, keyed by faction id. The
  two original factions keep their legacy sheet names (`War`, `War_SH`); any newly
  whitelisted faction gets a `War_<id>` tab auto-created on first use.
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
