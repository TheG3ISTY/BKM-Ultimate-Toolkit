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
 * server-side to belong to faction 56875 (Boykisser Meetup) before anything is
 * read or written. The key is never stored (only a short-lived hashed yes/no is
 * cached). This is the REAL faction gate — the client-side gate is just UX.
 */

var FACTION_ID = 56875;
var SHEET_NAME = 'Targets';
var HEADERS = ['Name', 'Why', 'StatEstimate', 'StatHuman', 'CheckedAt'];
// Faction positions allowed to REMOVE targets (compared case-insensitively).
var REMOVE_ROLES = ['boykisser', 'dommy mommy', 'leader', 'co-leader'];

// ---- War list (second tab) ----
// The War list is generated from an enemy faction ID and is master-controlled:
// only this Torn player may generate/edit/activate it. Everyone else in 56875
// can only READ it, and only once the master has activated it.
var MASTER_ID = 4117638;                 // TheG3ISTY — sole War-list master
var WAR_SHEET = 'War';
var WAR_HEADERS = ['Name', 'Position', 'Level', 'Status', 'StatEstimate', 'StatHuman', 'CheckedAt'];
var WAR_META_KEY = 'warMeta';            // stored in Script Properties: { active, factionId, factionName, generatedAt }

function doGet(e) {
  return json({ ok: true, service: 'BKM hitlist backend', hint: 'POST {action, key, ...} as text/plain' });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ ok: false, error: 'bad_request' }); }

  var key = (body.key || '').trim();
  if (!key) return json({ ok: false, error: 'missing_key' });
  var member = memberInfo(key);
  if (!member.ok) return json({ ok: false, error: 'not_verified' });
  var mayRemove = canRemove(member.position);
  var master = isMaster(member);

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return json({ ok: false, error: 'busy' }); }
  var out;
  try {
    switch (body.action) {
      case 'list':     out = { ok: true, targets: readAll() }; break;
      case 'add':      out = addTarget(body); break;
      case 'update':   out = updateTarget(body); break;
      case 'delete':   out = mayRemove ? deleteTarget(body)
                                       : { ok: false, error: 'forbidden', targets: readAll() }; break;
      case 'setStats': out = setStats(body); break;
      // ---- War list ----
      case 'warStatus':     out = warStatus(master); break;
      case 'warGenerate':   out = master ? warGenerate(body)      : forbidden(); break;
      case 'warSetStats':   out = master ? warSetStats(body)      : forbidden(); break;
      case 'warActivate':   out = master ? warSetActive(true)     : forbidden(); break;
      case 'warDeactivate': out = master ? warSetActive(false)    : forbidden(); break;
      case 'warClear':      out = master ? warClear()             : forbidden(); break;
      default:         out = { ok: false, error: 'unknown_action' };
    }
  } finally {
    lock.releaseLock();
  }
  // Tell the client the caller's permissions (+ position) on every response.
  out.mayRemove = mayRemove;
  out.position = member.position;
  out.isMaster = master;
  return json(out);
}

/* ---------- Torn faction verification (cached 5 min, key hashed) ---------- */
// Returns { ok: <in faction 56875>, position: <faction rank string> }.
function memberInfo(key) {
  var cache = CacheService.getScriptCache();
  var ck = cacheKey(key);
  var hit = cache.get(ck);
  if (hit) { try { var p = JSON.parse(hit); if (p && typeof p.ok === 'boolean') return p; } catch (e) {} }
  var info = { ok: false, position: '', playerId: 0 };
  try {
    var resp = UrlFetchApp.fetch(
      'https://api.torn.com/user/?selections=profile&key=' + encodeURIComponent(key) + '&comment=BKMSheet',
      { muteHttpExceptions: true }
    );
    var data = JSON.parse(resp.getContentText());
    if (data && !data.error && data.faction && Number(data.faction.faction_id) === FACTION_ID) {
      info.ok = true;
      info.position = String(data.faction.position || '');
      info.playerId = Number(data.player_id || 0);
    }
  } catch (err) {}
  cache.put(ck, JSON.stringify(info), 300);
  return info;
}
function canRemove(position) {
  return REMOVE_ROLES.indexOf(String(position || '').trim().toLowerCase()) !== -1;
}
function isMaster(member) {
  return !!member && Number(member.playerId) === MASTER_ID;
}
function forbidden() { return { ok: false, error: 'forbidden' }; }
function cacheKey(key) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key);
  return 'v_' + Utilities.base64Encode(d);
}

/* ---------- Sheet helpers ---------- */
function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.getRange('A:A').setNumberFormat('@');  // Name -> plain text (keep "[id]")
    sh.getRange('E:E').setNumberFormat('@');  // CheckedAt -> plain text (keep DD.MM.YYYY HH:mm)
    sh.getRange('C:C').setNumberFormat('0');  // StatEstimate -> integer, no sci-notation
    sh.setFrozenRows(1);
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
      checkedAt: (r[4] === '' || r[4] === null) ? null : String(r[4])
    });
  }
  return out;
}
function findRowById(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var names = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < names.length; i++) {
    if (idFromName(names[i][0]) === id) return i + 2; // 1-based, incl header row
  }
  return -1;
}

/* ---------- Actions ---------- */
function addTarget(body) {
  var name = String(body.name || '').trim();
  var id = idFromName(name);
  if (!id) return { ok: false, error: 'bad_name' };
  var sh = sheet();
  if (findRowById(sh, id) !== -1) return { ok: false, error: 'duplicate', targets: readAll() };
  sh.appendRow([name, String(body.why || ''), '', '', '']);
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
  for (var i = 0; i < stats.length; i++) {
    var s = stats[i];
    var row = findRowById(sh, String(s.id));
    if (row === -1) continue;
    sh.getRange(row, 3, 1, 3).setValues([[
      (s.statEstimate === null || s.statEstimate === undefined) ? '' : s.statEstimate,
      (s.statHuman === null || s.statHuman === undefined) ? '' : s.statHuman,
      (s.checkedAt === null || s.checkedAt === undefined) ? '' : s.checkedAt
    ]]);
  }
  return { ok: true, targets: readAll() };
}

/* ---------- War list ---------- */
function warSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(WAR_SHEET);
  if (!sh) sh = ss.insertSheet(WAR_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(WAR_HEADERS);
    sh.getRange('A:A').setNumberFormat('@');  // Name -> plain text (keep "[id]")
    sh.getRange('B:B').setNumberFormat('@');  // Position -> text
    sh.getRange('D:D').setNumberFormat('@');  // Status -> text
    sh.getRange('G:G').setNumberFormat('@');  // CheckedAt -> text
    sh.getRange('E:E').setNumberFormat('0');  // StatEstimate -> integer
    sh.setFrozenRows(1);
  }
  return sh;
}
function warMeta() {
  var raw = PropertiesService.getScriptProperties().getProperty(WAR_META_KEY);
  var m = { active: false, factionId: 0, factionName: '', generatedAt: '' };
  if (raw) { try { var p = JSON.parse(raw); if (p) m = { active: !!p.active, factionId: Number(p.factionId||0), factionName: String(p.factionName||''), generatedAt: String(p.generatedAt||'') }; } catch (e) {} }
  return m;
}
function saveWarMeta(m) {
  PropertiesService.getScriptProperties().setProperty(WAR_META_KEY, JSON.stringify(m));
}
function warReadAll() {
  var sh = warSheet();
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
      checkedAt: (r[6] === '' || r[6] === null) ? null : String(r[6])
    });
  }
  return out;
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
// Read-only status for everyone; the roster itself is only returned when the
// list is active OR the caller is the master (so the master can prep privately).
function warStatus(master) {
  var m = warMeta();
  var out = { ok: true, active: m.active, factionId: m.factionId, factionName: m.factionName, generatedAt: m.generatedAt };
  if (m.active || master) out.war = warReadAll();
  return out;
}
// Pull the enemy faction's roster from Torn and replace the War tab with it.
function warGenerate(body) {
  var fid = parseInt(body.factionId, 10);
  if (!fid) return { ok: false, error: 'bad_faction' };
  var key = String(body.key || '').trim();
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
  var sh = warSheet();
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, WAR_HEADERS.length).clearContent();  // wipe old roster, keep header

  var rows = [];
  for (var pid in members) {
    if (!members.hasOwnProperty(pid)) continue;
    var mm = members[pid] || {};
    var nm = String(mm.name || '') + ' [' + pid + ']';
    var st = mm.status ? String(mm.status.description || mm.status.state || '') : '';
    rows.push([nm, String(mm.position || ''), Number(mm.level || 0), st, '', '', '']);
  }
  if (rows.length) sh.getRange(2, 1, rows.length, WAR_HEADERS.length).setValues(rows);

  var m = warMeta();
  m.factionId = fid;
  m.factionName = String(data.name || ('Faction ' + fid));
  m.generatedAt = nowStr();
  saveWarMeta(m);
  return { ok: true, war: warReadAll(), factionId: m.factionId, factionName: m.factionName, generatedAt: m.generatedAt, active: m.active };
}
function warSetStats(body) {
  var stats = body.stats || [];
  var sh = warSheet();
  for (var i = 0; i < stats.length; i++) {
    var s = stats[i];
    var row = warFindRowById(sh, String(s.id));
    if (row === -1) continue;
    sh.getRange(row, 5, 1, 3).setValues([[
      (s.statEstimate === null || s.statEstimate === undefined) ? '' : s.statEstimate,
      (s.statHuman === null || s.statHuman === undefined) ? '' : s.statHuman,
      (s.checkedAt === null || s.checkedAt === undefined) ? '' : s.checkedAt
    ]]);
  }
  return { ok: true, war: warReadAll() };
}
function warSetActive(flag) {
  var m = warMeta();
  m.active = !!flag;
  saveWarMeta(m);
  return { ok: true, active: m.active, war: warReadAll(), factionId: m.factionId, factionName: m.factionName, generatedAt: m.generatedAt };
}
function warClear() {
  var sh = warSheet();
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, WAR_HEADERS.length).clearContent();
  saveWarMeta({ active: false, factionId: 0, factionName: '', generatedAt: '' });
  return { ok: true, active: false, war: [], factionId: 0, factionName: '', generatedAt: '' };
}
function nowStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
