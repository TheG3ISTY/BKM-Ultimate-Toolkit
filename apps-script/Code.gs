/**
 * BKM Hit List — Google Sheets backend (Apps Script Web App)
 * ----------------------------------------------------------
 * Container-bound to a Google Sheet. The hit list lives in a tab called
 * "Targets" (auto-created on first use).
 *
 * All data actions are POST with a JSON body sent as text/plain, so the browser
 * makes a "simple" CORS request (no preflight — Apps Script can't answer OPTIONS).
 *
 * SECURITY: every action requires the caller's Torn API key, which is verified
 * server-side to belong to a WHITELISTED faction before anything is read or
 * written. The key is never stored (only a short-lived hashed yes/no is cached).
 * This is the REAL faction gate — the client-side gate is just UX.
 *
 * DYNAMIC CONFIG: the whitelist of factions and the list of MASTERS are stored in
 * Script Properties and edited live by the OWNER through the app's Admin panel —
 * no code change or redeploy needed to add a faction or a master. The OWNER id is
 * the one hardcoded root of trust (below); it can never be changed in-app, so the
 * owner can't be locked out.
 *
 * ROLES: owner (super-admin) ⊃ master (warmaster == listmaster: controls all war
 * rosters + hit-list curation) ⊃ member (anyone in a whitelisted faction: can add,
 * edit name/why, and refresh stats).
 */

// The one hardcoded identity — sole super-admin / owner. Root of trust: always
// passes the gate, is always a master, and is the only one who may edit the
// whitelist or the masters list. Never make this editable in-app.
var OWNER_ID = 4117638;   // TheG3ISTY

// Seed config, used ONLY when the Script Properties are still empty (first run).
// After that the live values in Script Properties win.
var SEED_WHITELIST = {
  '56875': { name: 'Boykisser Meetup', color: '#60a5fa' },  // blue
  '45990': { name: 'Static Hearts',    color: '#f472b6' }   // pink
};
// Masters are assigned PER FACTION for the war lists: { "<playerId>": [factionId, ...] }.
// A master controls only their assigned faction(s)' war roster (+ shared hit-list
// curation). The OWNER is implicitly master of everything and isn't listed here.
var SEED_MASTERS = { '3558000': [45990] };   // Madilynn-SkyBby masters Static Hearts
// Palette auto-assigned to newly whitelisted factions (first unused wins).
var FACTION_COLORS = ['#60a5fa', '#f472b6', '#c084fc', '#fbbf24', '#34d399', '#22d3ee', '#fb923c', '#a3e635'];
var CFG_WHITELIST = 'cfg_whitelist';
var CFG_MASTERS = 'cfg_masters';

// Legacy targets predate the Faction column; treat them as Boykisser Meetup's.
var DEFAULT_FACTION = 56875;

var SHEET_NAME = 'Targets';
// 'Faction' = id of the faction that added the target (auto-detected).
// 'Shared'  = TRUE when the target is an enemy of BOTH factions.
var HEADERS = ['Name', 'Why', 'StatEstimate', 'StatHuman', 'CheckedAt', 'Manual', 'Faction', 'Shared'];
// Faction positions that historically could remove targets (kept for reference;
// delete is now master-only, so this is unused).
var REMOVE_ROLES = ['boykisser', 'dommy mommy', 'leader', 'co-leader'];

// ---- War list: one roster per whitelisted faction, each its own tab + meta ----
// A roster is keyed by the faction id it belongs to. Its sheet/meta names are
// derived from that id, EXCEPT the two original factions keep their legacy names
// so existing data is preserved.
var WAR_LEGACY = {
  '56875': { sheet: 'War',    meta: 'warMeta' },
  '45990': { sheet: 'War_SH', meta: 'warMeta_SH' }
};
// 'Side' = friendly (our faction, shown green) | enemy (target faction, red).
// 'Manual' = TRUE when the stat was hand-entered; such rows are skipped by refreshes.
var WAR_HEADERS = ['Name', 'Position', 'Level', 'Status', 'StatEstimate', 'StatHuman', 'CheckedAt', 'Side', 'Manual'];

/* ---------- Dynamic config (Script Properties, owner-editable) ---------- */
function getWhitelist() {
  var raw = PropertiesService.getScriptProperties().getProperty(CFG_WHITELIST);
  if (raw) { try { var p = JSON.parse(raw); if (p && typeof p === 'object') return p; } catch (e) {} }
  return SEED_WHITELIST;
}
function saveWhitelist(w) { PropertiesService.getScriptProperties().setProperty(CFG_WHITELIST, JSON.stringify(w)); }
// Master map: { "<playerId>": [factionId, ...] }. Sanitised on read/write.
function getMasterMap() {
  var raw = PropertiesService.getScriptProperties().getProperty(CFG_MASTERS);
  if (raw) { try { var p = JSON.parse(raw); if (p && typeof p === 'object' && !(p instanceof Array)) return sanitizeMap(p); } catch (e) {} }
  return sanitizeMap(SEED_MASTERS);
}
function saveMasterMap(m) { PropertiesService.getScriptProperties().setProperty(CFG_MASTERS, JSON.stringify(sanitizeMap(m))); }
function sanitizeMap(m) {
  var out = {};
  for (var k in m) { if (!m.hasOwnProperty(k)) continue; var pid = Number(k); if (!pid) continue;
    var facs = arrNums(m[k] || []); if (facs.length) out[String(pid)] = facs; }
  return out;
}
function arrNums(a) { var o = []; for (var i = 0; i < (a ? a.length : 0); i++) { var n = Number(a[i]); if (n && o.indexOf(n) === -1) o.push(n); } return o; }
// Pick a stable colour for a new faction: first palette entry not already in use.
function pickColor(wl) {
  var used = {};
  for (var k in wl) { if (wl.hasOwnProperty(k) && wl[k]) used[wl[k].color] = true; }
  for (var i = 0; i < FACTION_COLORS.length; i++) { if (!used[FACTION_COLORS[i]]) return FACTION_COLORS[i]; }
  return FACTION_COLORS[Object.keys(wl).length % FACTION_COLORS.length];
}

function warCfg(fid) {
  fid = Number(fid);
  var leg = WAR_LEGACY[String(fid)];
  return {
    sheet: leg ? leg.sheet : ('War_' + fid),
    meta:  leg ? leg.meta  : ('warMeta_' + fid),
    factionId: fid
  };
}
// The roster a request targets: body.war is a faction id. Falls back to the first
// whitelisted faction if missing/unknown.
function warKeyOf(body) {
  var fid = Number(body && body.war) || 0;
  var wl = getWhitelist();
  if (wl[String(fid)]) return fid;
  var ids = Object.keys(wl);
  return ids.length ? Number(ids[0]) : DEFAULT_FACTION;
}

function doGet(e) {
  // Public config so the client-side gate + UI know the current whitelist before
  // anyone logs in (colours, gate factions). No secrets here.
  return json({ ok: true, service: 'BKM hitlist backend', factions: getWhitelist() });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ ok: false, error: 'bad_request' }); }

  var key = (body.key || '').trim();
  if (!key) return json({ ok: false, error: 'missing_key' });
  var member = memberInfo(key);
  if (!member.ok) return json({ ok: false, error: 'not_verified' });
  var owner = isOwner(member);
  var master = isMaster(member);            // hit-list curation (any master)
  var wkey = warKeyOf(body);
  var warMaster = isWarMaster(member, wkey); // war control (this faction only)
  var pkey = payoutKeyOf(body);
  var payMaster = isWarMaster(member, pkey); // payout edit (this faction's warmasters)

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return json({ ok: false, error: 'busy' }); }
  var out;
  try {
    switch (body.action) {
      case 'list':     out = { ok: true, targets: readAll() }; break;
      case 'add':      out = addTarget(body, member); break;
      case 'update':   out = updateTarget(body); break;
      // Delete + the curation flags (Manual / Shared / Faction) are MASTER-ONLY.
      // Any verified member can still add, edit, and refresh stats.
      case 'delete':   out = master ? deleteTarget(body) : forbiddenTargets(); break;
      case 'setStats': out = setStats(body); break;
      case 'setManual': out = master ? setManual(body)  : forbiddenTargets(); break;
      case 'setShared': out = master ? setShared(body)  : forbiddenTargets(); break;
      // Reassigning a target's faction is OWNER-only (a sensitive cross-faction move).
      case 'setFaction': out = owner ? setFaction(body) : forbiddenTargets(); break;
      // ---- War list (per-roster; body.war selects the faction id) ----
      case 'warStatus':       out = warStatus(member, wkey); break;
      case 'warGenerate':     out = warMaster ? warGenerate(body, wkey)     : forbidden(); break;
      case 'warPullFriendly': out = warMaster ? warPullFriendly(body, wkey) : forbidden(); break;
      case 'warSetStats':     out = warMaster ? warSetStats(body, wkey)     : forbidden(); break;
      case 'warSetManual':    out = warMaster ? warSetManual(body, wkey)    : forbidden(); break;
      case 'warActivate':     out = warMaster ? warSetActive(true, wkey)    : forbidden(); break;
      case 'warDeactivate':   out = warMaster ? warSetActive(false, wkey)   : forbidden(); break;
      case 'warClear':        out = warMaster ? warClear(wkey)              : forbidden(); break;
      // ---- War payout (per faction; body.pay selects the faction id) ----
      case 'payoutStatus':    out = payoutStatus(member, pkey); break;
      case 'payoutSave':      out = payMaster ? payoutSave(body, pkey)             : forbidden(); break;
      case 'payoutSetActive': out = payMaster ? payoutSetActive(!!body.active, pkey) : forbidden(); break;
      case 'payoutClear':     out = payMaster ? payoutClear(pkey)                  : forbidden(); break;
      // ---- Admin (OWNER-ONLY): live whitelist + masters management ----
      case 'adminConfig':        out = owner ? adminConfig()             : forbidden(); break;
      case 'adminAddFaction':    out = owner ? adminAddFaction(body)     : forbidden(); break;
      case 'adminRemoveFaction': out = owner ? adminRemoveFaction(body)  : forbidden(); break;
      case 'adminSetColor':      out = owner ? adminSetColor(body)       : forbidden(); break;
      case 'adminAddMaster':     out = owner ? adminAddMaster(body)      : forbidden(); break;
      case 'adminRemoveMaster':  out = owner ? adminRemoveMaster(body)   : forbidden(); break;
      default:         out = { ok: false, error: 'unknown_action' };
    }
  } finally {
    lock.releaseLock();
  }
  // Identity + config the client needs on every response.
  out.position = member.position;
  out.myFactionId = member.factionId;
  out.myFactionName = member.factionName;
  out.isMaster = master;                    // may curate the hit list
  out.isOwner = owner;
  out.warMasterOf = warMasterOf(member);    // faction war rosters this member controls
  out.factions = getWhitelist();   // keep the client's whitelist/colours fresh
  return json(out);
}

/* ---------- Torn faction verification (cached 5 min, key hashed) ---------- */
// Returns { ok:<in a whitelisted faction OR owner>, position, playerId, factionId, factionName }.
function memberInfo(key) {
  var cache = CacheService.getScriptCache();
  var ck = cacheKey(key);
  var hit = cache.get(ck);
  if (hit) {
    try {
      var p = JSON.parse(hit);
      // Honor cached negatives, and cached positives that carry both a playerId
      // and a factionId. Stale pre-upgrade positives re-fetch.
      if (p && typeof p.ok === 'boolean' && (p.ok === false || (p.playerId && p.factionId))) return p;
    } catch (e) {}
  }
  var info = { ok: false, position: '', playerId: 0, factionId: 0, factionName: '' };
  try {
    var resp = UrlFetchApp.fetch(
      'https://api.torn.com/user/?selections=profile&key=' + encodeURIComponent(key) + '&comment=BKMSheet',
      { muteHttpExceptions: true }
    );
    var data = JSON.parse(resp.getContentText());
    if (data && !data.error && data.faction) {
      var fid = Number(data.faction.faction_id);
      var pid = Number(data.player_id || 0);
      var wl = getWhitelist();
      // Owner always passes (can't lock themselves out); everyone else must be
      // in a currently-whitelisted faction.
      if (wl[String(fid)] || pid === OWNER_ID) {
        info.ok = true;
        info.position = String(data.faction.position || '');
        info.playerId = pid;
        info.factionId = fid;
        info.factionName = (wl[String(fid)] && wl[String(fid)].name) || ('Faction ' + fid);
      }
    }
  } catch (err) {}
  cache.put(ck, JSON.stringify(info), 300);
  return info;
}
function isOwner(member)  { return !!member && Number(member.playerId) === OWNER_ID; }
// Hit-list curation ("any master"): owner, or a master of ANY faction. Hit-list
// curation is intentionally NOT scoped per faction.
function isMaster(member) {
  if (!member) return false;
  if (Number(member.playerId) === OWNER_ID) return true;
  return !!getMasterMap()[String(Number(member.playerId))];
}
// War control is PER FACTION: owner, or a master assigned to this faction.
function isWarMaster(member, fid) {
  if (!member) return false;
  if (Number(member.playerId) === OWNER_ID) return true;
  var facs = getMasterMap()[String(Number(member.playerId))];
  return !!facs && facs.indexOf(Number(fid)) !== -1;
}
// The faction war rosters this member may control (owner -> all whitelisted).
function warMasterOf(member) {
  if (!member) return [];
  if (Number(member.playerId) === OWNER_ID) return Object.keys(getWhitelist()).map(Number);
  var facs = getMasterMap()[String(Number(member.playerId))];
  return facs ? facs.slice() : [];
}
function canRemove(position) {
  return REMOVE_ROLES.indexOf(String(position || '').trim().toLowerCase()) !== -1;
}
function forbidden() { return { ok: false, error: 'forbidden' }; }
// Forbidden, but still hand back the current list so the client re-syncs to truth.
function forbiddenTargets() { return { ok: false, error: 'forbidden', targets: readAll() }; }
function cacheKey(key) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key);
  return 'v_' + Utilities.base64Encode(d);
}

/* ---------- Admin actions (owner-only; enforced in doPost) ---------- */
function adminConfig() { return { ok: true, whitelist: getWhitelist(), masters: getMasterMap() }; }
function adminAddFaction(body) {
  var fid = parseInt(body.factionId, 10);
  if (!fid) return { ok: false, error: 'bad_faction' };
  var res = fetchFactionName(fid, String(body.key || '').trim());
  if (!res.ok) return res;
  var wl = getWhitelist();
  var color = (wl[String(fid)] && wl[String(fid)].color) ? wl[String(fid)].color : pickColor(wl);
  wl[String(fid)] = { name: res.name, color: color };
  saveWhitelist(wl);
  return { ok: true, whitelist: wl, masters: getMasterMap() };
}
function adminSetColor(body) {
  var fid = parseInt(body.factionId, 10) || 0;
  var color = String(body.color || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { ok: false, error: 'bad_color' };
  var wl = getWhitelist();
  if (!wl[String(fid)]) return { ok: false, error: 'bad_faction' };
  wl[String(fid)].color = color;
  saveWhitelist(wl);
  return { ok: true, whitelist: wl, masters: getMasterMap() };
}
function adminRemoveFaction(body) {
  var fid = parseInt(body.factionId, 10) || 0;
  var wl = getWhitelist();
  if (wl[String(fid)]) { delete wl[String(fid)]; saveWhitelist(wl); }
  // Drop that faction from every master's assignments too.
  var m = getMasterMap(), changed = false;
  for (var k in m) { if (!m.hasOwnProperty(k)) continue;
    var f = m[k].filter(function (x) { return x !== fid; });
    if (f.length !== m[k].length) { changed = true; if (f.length) m[k] = f; else delete m[k]; } }
  if (changed) saveMasterMap(m);
  return { ok: true, whitelist: wl, masters: m };
}
// Assign a player as war master of a faction (adds to their faction list).
function adminAddMaster(body) {
  var pid = parseInt(body.playerId, 10);
  var fid = parseInt(body.factionId, 10);
  if (!pid) return { ok: false, error: 'bad_player' };
  if (!getWhitelist()[String(fid)]) return { ok: false, error: 'bad_faction' };
  var m = getMasterMap();
  var facs = m[String(pid)] || [];
  if (facs.indexOf(fid) === -1) facs.push(fid);
  m[String(pid)] = facs;
  saveMasterMap(m);
  return { ok: true, whitelist: getWhitelist(), masters: m };
}
// Remove one faction assignment (factionId given) or the whole master (no factionId).
function adminRemoveMaster(body) {
  var pid = parseInt(body.playerId, 10) || 0;
  var fid = parseInt(body.factionId, 10) || 0;
  var m = getMasterMap();
  if (m[String(pid)]) {
    if (fid) { m[String(pid)] = m[String(pid)].filter(function (x) { return x !== fid; }); if (!m[String(pid)].length) delete m[String(pid)]; }
    else delete m[String(pid)];
    saveMasterMap(m);
  }
  return { ok: true, whitelist: getWhitelist(), masters: m };
}
// Look up a faction's name from Torn using the owner's key.
function fetchFactionName(fid, key) {
  try {
    var resp = UrlFetchApp.fetch(
      'https://api.torn.com/faction/' + fid + '?selections=basic&key=' + encodeURIComponent(key) + '&comment=BKMAdmin',
      { muteHttpExceptions: true }
    );
    var data = JSON.parse(resp.getContentText());
    if (!data || data.error) return { ok: false, error: 'torn_error', detail: (data && data.error) ? data.error.error : '' };
    return { ok: true, name: String(data.name || ('Faction ' + fid)) };
  } catch (err) { return { ok: false, error: 'torn_parse' }; }
}

/* ---------- Sheet helpers ---------- */
// Coerce a cell value (boolean or "TRUE"/"true"/1) to a real boolean.
function truthy(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
// Non-destructive migration: if a live sheet predates a column we now expect,
// append the missing header label(s) to the right.
function ensureHeaders(sh, headers) {
  if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); return; }
  var have = sh.getLastColumn();
  if (have < headers.length) {
    var missing = headers.slice(have);
    sh.getRange(1, have + 1, 1, missing.length).setValues([missing]);
  }
}
function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  var fresh = sh.getLastRow() === 0;
  ensureHeaders(sh, HEADERS);
  if (fresh) {
    sh.getRange('A:A').setNumberFormat('@');  // Name -> plain text (keep "[id]")
    sh.getRange('E:E').setNumberFormat('@');  // CheckedAt -> plain text
    sh.getRange('C:C').setNumberFormat('0');  // StatEstimate -> integer
    sh.getRange('G:G').setNumberFormat('0');  // Faction -> integer id
  }
  return sh;
}
function idFromName(name) {
  var m = /\[(\d+)\]/.exec(name || '');
  return m ? m[1] : null; // string id
}
function readAll() {
  var sh = sheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var name = String(r[0] || '').trim();
    if (!name) continue;
    out.push({
      name: name,
      why: String(r[1] || ''),
      statEstimate: (r[2] === '' || r[2] === null) ? null : Number(r[2]),
      statHuman: (r[3] === '' || r[3] === null) ? null : String(r[3]),
      checkedAt: (r[4] === '' || r[4] === null) ? null : String(r[4]),
      manual: truthy(r[5]),
      faction: (r[6] === '' || r[6] === null) ? DEFAULT_FACTION : Number(r[6]),
      shared: truthy(r[7])
    });
  }
  return out;
}
function findRowById(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var names = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < names.length; i++) {
    if (idFromName(names[i][0]) === id) return i + 2;
  }
  return -1;
}

/* ---------- Hit-list actions ---------- */
// The origin faction is auto-detected from the caller's verified key (member).
function addTarget(body, member) {
  var name = String(body.name || '').trim();
  var id = idFromName(name);
  if (!id) return { ok: false, error: 'bad_name' };
  var sh = sheet();
  if (findRowById(sh, id) !== -1) return { ok: false, error: 'duplicate', targets: readAll() };
  var fac = (member && member.factionId) ? member.factionId : DEFAULT_FACTION;
  sh.appendRow([name, String(body.why || ''), '', '', '', false, fac, false]);
  return { ok: true, targets: readAll() };
}
function updateTarget(body) {
  var id = String(body.id || '');
  var sh = sheet();
  var row = findRowById(sh, id);
  if (row === -1) return { ok: false, error: 'not_found', targets: readAll() };
  if (typeof body.name === 'string') {
    var newName = body.name.trim();
    var newId = idFromName(newName);
    if (!newId) return { ok: false, error: 'bad_name', targets: readAll() };
    var other = findRowById(sh, newId);
    if (other !== -1 && other !== row) return { ok: false, error: 'duplicate', targets: readAll() };
    sh.getRange(row, 1).setValue(newName);
  }
  if (typeof body.why === 'string') sh.getRange(row, 2).setValue(body.why);
  return { ok: true, targets: readAll() };
}
function deleteTarget(body) {
  var id = String(body.id || '');
  var sh = sheet();
  var row = findRowById(sh, id);
  if (row === -1) return { ok: false, error: 'not_found', targets: readAll() };
  sh.deleteRow(row);
  return { ok: true, targets: readAll() };
}
function setStats(body) {
  var stats = body.stats || [];
  var sh = sheet();
  var manualCol = HEADERS.indexOf('Manual') + 1;
  var last = sh.getLastRow();
  var manualVals = last > 1 ? sh.getRange(2, manualCol, last - 1, 1).getValues() : [];
  for (var i = 0; i < stats.length; i++) {
    var s = stats[i];
    var row = findRowById(sh, String(s.id));
    if (row === -1) continue;
    if (manualVals[row - 2] && truthy(manualVals[row - 2][0])) continue;  // manual override: leave untouched
    sh.getRange(row, 3, 1, 3).setValues([[
      (s.statEstimate === null || s.statEstimate === undefined) ? '' : s.statEstimate,
      (s.statHuman === null || s.statHuman === undefined) ? '' : s.statHuman,
      (s.checkedAt === null || s.checkedAt === undefined) ? '' : s.checkedAt
    ]]);
  }
  return { ok: true, targets: readAll() };
}
function setManual(body) {
  var id = String(body.id || '');
  var sh = sheet();
  var row = findRowById(sh, id);
  if (row === -1) return { ok: false, error: 'not_found', targets: readAll() };
  var manual = !!body.manual;
  sh.getRange(row, HEADERS.indexOf('Manual') + 1).setValue(manual);
  if (manual && body.statEstimate !== undefined) {
    sh.getRange(row, 3, 1, 3).setValues([[
      (body.statEstimate === null || body.statEstimate === undefined) ? '' : body.statEstimate,
      (body.statHuman === null || body.statHuman === undefined) ? '' : body.statHuman,
      (body.checkedAt === null || body.checkedAt === undefined) ? '' : body.checkedAt
    ]]);
  }
  return { ok: true, targets: readAll() };
}
function setShared(body) {
  var id = String(body.id || '');
  var sh = sheet();
  var row = findRowById(sh, id);
  if (row === -1) return { ok: false, error: 'not_found', targets: readAll() };
  sh.getRange(row, HEADERS.indexOf('Shared') + 1).setValue(!!body.shared);
  return { ok: true, targets: readAll() };
}
// MASTER: reassign which faction a target belongs to. Only a whitelisted faction id.
function setFaction(body) {
  var fac = Number(body.faction || 0);
  if (!getWhitelist()[String(fac)]) return { ok: false, error: 'bad_faction', targets: readAll() };
  var id = String(body.id || '');
  var sh = sheet();
  var row = findRowById(sh, id);
  if (row === -1) return { ok: false, error: 'not_found', targets: readAll() };
  sh.getRange(row, HEADERS.indexOf('Faction') + 1).setValue(fac);
  return { ok: true, targets: readAll() };
}

/* ---------- War list (per-roster, keyed by faction id) ---------- */
function warSheet(wkey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = warCfg(wkey).sheet;
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var fresh = sh.getLastRow() === 0;
  ensureHeaders(sh, WAR_HEADERS);
  if (fresh) {
    sh.getRange('A:A').setNumberFormat('@');  // Name
    sh.getRange('B:B').setNumberFormat('@');  // Position
    sh.getRange('D:D').setNumberFormat('@');  // Status
    sh.getRange('G:G').setNumberFormat('@');  // CheckedAt
    sh.getRange('H:H').setNumberFormat('@');  // Side
    sh.getRange('E:E').setNumberFormat('0');  // StatEstimate
  }
  return sh;
}
function warMeta(wkey) {
  var raw = PropertiesService.getScriptProperties().getProperty(warCfg(wkey).meta);
  var m = { active: false, factionId: 0, factionName: '', generatedAt: '' };
  if (raw) { try { var p = JSON.parse(raw); if (p) m = { active: !!p.active, factionId: Number(p.factionId||0), factionName: String(p.factionName||''), generatedAt: String(p.generatedAt||'') }; } catch (e) {} }
  return m;
}
function saveWarMeta(wkey, m) {
  PropertiesService.getScriptProperties().setProperty(warCfg(wkey).meta, JSON.stringify(m));
}
function warReadAll(wkey) {
  var sh = warSheet(wkey);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, WAR_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var name = String(r[0] || '').trim();
    if (!name) continue;
    out.push({
      name: name,
      position: String(r[1] || ''),
      level: (r[2] === '' || r[2] === null) ? null : Number(r[2]),
      status: String(r[3] || ''),
      statEstimate: (r[4] === '' || r[4] === null) ? null : Number(r[4]),
      statHuman: (r[5] === '' || r[5] === null) ? null : String(r[5]),
      checkedAt: (r[6] === '' || r[6] === null) ? null : String(r[6]),
      side: (String(r[7] || '').toLowerCase() === 'friendly') ? 'friendly' : 'enemy',
      manual: truthy(r[8])
    });
  }
  return out;
}
function warObjToRow(x) {
  return [
    x.name,
    x.position || '',
    (x.level === null || x.level === undefined) ? '' : x.level,
    x.status || '',
    (x.statEstimate === null || x.statEstimate === undefined) ? '' : x.statEstimate,
    (x.statHuman === null || x.statHuman === undefined) ? '' : x.statHuman,
    (x.checkedAt === null || x.checkedAt === undefined) ? '' : x.checkedAt,
    (x.side === 'friendly') ? 'friendly' : 'enemy',
    !!x.manual
  ];
}
function fetchFactionRows(fid, key, side) {
  var data;
  try {
    var resp = UrlFetchApp.fetch(
      'https://api.torn.com/faction/' + fid + '?selections=basic&key=' + encodeURIComponent(key) + '&comment=BKMWar',
      { muteHttpExceptions: true }
    );
    data = JSON.parse(resp.getContentText());
  } catch (err) { return { ok: false, error: 'torn_parse' }; }
  if (!data || data.error) return { ok: false, error: 'torn_error', detail: (data && data.error) ? data.error.error : '' };
  var members = data.members || {};
  var rows = [];
  for (var pid in members) {
    if (!members.hasOwnProperty(pid)) continue;
    var mm = members[pid] || {};
    var nm = String(mm.name || '') + ' [' + pid + ']';
    var st = mm.status ? String(mm.status.description || mm.status.state || '') : '';
    rows.push([nm, String(mm.position || ''), Number(mm.level || 0), st, '', '', '', side, false]);
  }
  return { ok: true, rows: rows, name: String(data.name || ('Faction ' + fid)) };
}
function warReplaceSide(sh, wkey, side, newRows) {
  var keep = warReadAll(wkey).filter(function (x) { return x.side !== side; }).map(warObjToRow);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, WAR_HEADERS.length).clearContent();
  var rows = keep.concat(newRows);
  if (rows.length) sh.getRange(2, 1, rows.length, WAR_HEADERS.length).setValues(rows);
}
function warFindRowById(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var names = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < names.length; i++) {
    if (idFromName(names[i][0]) === id) return i + 2;
  }
  return -1;
}
function warEnvelope(wkey) {
  var m = warMeta(wkey);
  return {
    ok: true, war: wkey, roster: warReadAll(wkey),
    active: m.active, factionId: m.factionId, factionName: m.factionName, generatedAt: m.generatedAt
  };
}
function warStatus(member, wkey) {
  var master = isWarMaster(member, wkey);
  var m = warMeta(wkey);
  var out = { ok: true, war: wkey, active: m.active, master: master };
  if (m.active || master) {
    out.factionId = m.factionId;
    out.factionName = m.factionName;
    out.generatedAt = m.generatedAt;
    out.roster = warReadAll(wkey);
  }
  return out;
}
function warGenerate(body, wkey) {
  var fid = parseInt(body.factionId, 10);
  if (!fid) return { ok: false, error: 'bad_faction' };
  var res = fetchFactionRows(fid, String(body.key || '').trim(), 'enemy');
  if (!res.ok) return res;
  var sh = warSheet(wkey);
  warReplaceSide(sh, wkey, 'enemy', res.rows);
  var m = warMeta(wkey);
  m.factionId = fid;
  m.factionName = res.name;
  m.generatedAt = nowStr();
  saveWarMeta(wkey, m);
  return warEnvelope(wkey);
}
// Pull the roster's OWN faction (green side); "our" faction == the roster's id.
function warPullFriendly(body, wkey) {
  var res = fetchFactionRows(warCfg(wkey).factionId, String(body.key || '').trim(), 'friendly');
  if (!res.ok) return res;
  var sh = warSheet(wkey);
  warReplaceSide(sh, wkey, 'friendly', res.rows);
  return warEnvelope(wkey);
}
function warSetStats(body, wkey) {
  var stats = body.stats || [];
  var sh = warSheet(wkey);
  var manualCol = WAR_HEADERS.indexOf('Manual') + 1;
  var last = sh.getLastRow();
  var manualVals = last > 1 ? sh.getRange(2, manualCol, last - 1, 1).getValues() : [];
  for (var i = 0; i < stats.length; i++) {
    var s = stats[i];
    var row = warFindRowById(sh, String(s.id));
    if (row === -1) continue;
    if (manualVals[row - 2] && truthy(manualVals[row - 2][0])) continue;
    sh.getRange(row, 5, 1, 3).setValues([[
      (s.statEstimate === null || s.statEstimate === undefined) ? '' : s.statEstimate,
      (s.statHuman === null || s.statHuman === undefined) ? '' : s.statHuman,
      (s.checkedAt === null || s.checkedAt === undefined) ? '' : s.checkedAt
    ]]);
  }
  return warEnvelope(wkey);
}
function warSetManual(body, wkey) {
  var id = String(body.id || '');
  var sh = warSheet(wkey);
  var row = warFindRowById(sh, id);
  if (row === -1) return { ok: false, error: 'not_found', war: wkey, roster: warReadAll(wkey) };
  var manual = !!body.manual;
  sh.getRange(row, WAR_HEADERS.indexOf('Manual') + 1).setValue(manual);
  if (manual && body.statEstimate !== undefined) {
    sh.getRange(row, 5, 1, 3).setValues([[
      (body.statEstimate === null || body.statEstimate === undefined) ? '' : body.statEstimate,
      (body.statHuman === null || body.statHuman === undefined) ? '' : body.statHuman,
      (body.checkedAt === null || body.checkedAt === undefined) ? '' : body.checkedAt
    ]]);
  }
  return warEnvelope(wkey);
}
function warSetActive(flag, wkey) {
  var m = warMeta(wkey);
  m.active = !!flag;
  saveWarMeta(wkey, m);
  return warEnvelope(wkey);
}
function warClear(wkey) {
  var sh = warSheet(wkey);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, WAR_HEADERS.length).clearContent();
  saveWarMeta(wkey, { active: false, factionId: 0, factionName: '', generatedAt: '' });
  return { ok: true, war: wkey, active: false, roster: [], factionId: 0, factionName: '', generatedAt: '' };
}
/* ---------- War payout calculator (one per faction) ---------- */
// Members live in a per-faction sheet; the tunable params + publish flag live in
// a Script Property. Warmasters of a faction edit its payout; members of that
// faction can READ it once it's published (active).
var PAYOUT_HEADERS = ['Name', 'Mult', 'Hits', 'Respect', 'ChainBonus', 'Xanax'];
function payoutCfg(fid) { fid = Number(fid); return { sheet: 'Payout_' + fid, meta: 'payoutMeta_' + fid, factionId: fid }; }
function payoutKeyOf(body) {
  var fid = Number(body && body.pay) || 0;
  var wl = getWhitelist();
  if (wl[String(fid)]) return fid;
  var ids = Object.keys(wl);
  return ids.length ? Number(ids[0]) : DEFAULT_FACTION;
}
function defaultPayoutParams() { return { warPayout: 0, expenses: 0, memberPct: 80, factionPct: 20, hitPct: 50, respectPct: 50, salaryEach: 0, xanaxPrice: 0 }; }
function sanitizePayoutParams(p) {
  p = p || {}; var d = defaultPayoutParams(), o = {};
  for (var k in d) { if (!d.hasOwnProperty(k)) continue; var v = Number(p[k]); o[k] = isFinite(v) ? v : d[k]; }
  return o;
}
function payoutMeta(fid) {
  var raw = PropertiesService.getScriptProperties().getProperty(payoutCfg(fid).meta);
  var m = { active: false, params: defaultPayoutParams(), updatedAt: '' };
  if (raw) { try { var p = JSON.parse(raw); if (p) { m.active = !!p.active; m.updatedAt = String(p.updatedAt || ''); m.params = sanitizePayoutParams(p.params); } } catch (e) {} }
  return m;
}
function savePayoutMeta(fid, m) {
  PropertiesService.getScriptProperties().setProperty(payoutCfg(fid).meta,
    JSON.stringify({ active: !!m.active, params: sanitizePayoutParams(m.params), updatedAt: String(m.updatedAt || '') }));
}
function payoutSheet(fid) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = payoutCfg(fid).sheet;
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var fresh = sh.getLastRow() === 0;
  ensureHeaders(sh, PAYOUT_HEADERS);
  if (fresh) { sh.getRange('A:A').setNumberFormat('@'); }   // Name -> plain text
  return sh;
}
function payoutReadAll(fid) {
  var sh = payoutSheet(fid);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, PAYOUT_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var name = String(r[0] || '').trim();
    if (!name && !r[2] && !r[3] && !r[5]) continue;   // skip fully-blank rows
    out.push({
      name: name,
      mult: (r[1] === '' || r[1] === null) ? 1 : Number(r[1]),
      hits: Number(r[2]) || 0,
      respect: Number(r[3]) || 0,
      chain: Number(r[4]) || 0,
      xanax: Number(r[5]) || 0
    });
  }
  return out;
}
function payoutSaveMembers(fid, members) {
  var sh = payoutSheet(fid);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, PAYOUT_HEADERS.length).clearContent();
  var rows = (members || []).map(function (m) {
    return [String(m.name || ''), (m.mult == null ? 1 : Number(m.mult) || 0), Number(m.hits) || 0, Number(m.respect) || 0, Number(m.chain) || 0, Number(m.xanax) || 0];
  });
  if (rows.length) sh.getRange(2, 1, rows.length, PAYOUT_HEADERS.length).setValues(rows);
}
function payoutEnvelope(fid) {
  var m = payoutMeta(fid);
  return { ok: true, pay: fid, active: m.active, params: m.params, members: payoutReadAll(fid), updatedAt: m.updatedAt };
}
// Warmasters of the faction see it always; members of that faction see it once
// published (active). Other factions can't read it.
function payoutStatus(member, fid) {
  var master = isWarMaster(member, fid);
  var m = payoutMeta(fid);
  var same = Number(member.factionId) === Number(fid);
  var out = { ok: true, pay: fid, active: m.active, master: master };
  if (master || (m.active && same)) {
    out.params = m.params; out.members = payoutReadAll(fid); out.updatedAt = m.updatedAt; out.canRead = true;
  } else { out.canRead = false; }
  return out;
}
function payoutSave(body, fid) {
  var m = payoutMeta(fid);
  if (body.params) m.params = sanitizePayoutParams(body.params);
  m.updatedAt = nowStr();
  savePayoutMeta(fid, m);
  if (body.members != null) payoutSaveMembers(fid, body.members);
  return payoutEnvelope(fid);
}
function payoutSetActive(flag, fid) { var m = payoutMeta(fid); m.active = !!flag; savePayoutMeta(fid, m); return payoutEnvelope(fid); }
function payoutClear(fid) {
  var sh = payoutSheet(fid);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, PAYOUT_HEADERS.length).clearContent();
  savePayoutMeta(fid, { active: false, params: defaultPayoutParams(), updatedAt: '' });
  return payoutEnvelope(fid);
}

function nowStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
