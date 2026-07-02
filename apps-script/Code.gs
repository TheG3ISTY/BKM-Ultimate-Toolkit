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
      default:         out = { ok: false, error: 'unknown_action' };
    }
  } finally {
    lock.releaseLock();
  }
  // Tell the client the caller's remove permission (+ position) on every response.
  out.mayRemove = mayRemove;
  out.position = member.position;
  return json(out);
}

/* ---------- Torn faction verification (cached 5 min, key hashed) ---------- */
// Returns { ok: <in faction 56875>, position: <faction rank string> }.
function memberInfo(key) {
  var cache = CacheService.getScriptCache();
  var ck = cacheKey(key);
  var hit = cache.get(ck);
  if (hit) { try { var p = JSON.parse(hit); if (p && typeof p.ok === 'boolean') return p; } catch (e) {} }
  var info = { ok: false, position: '' };
  try {
    var resp = UrlFetchApp.fetch(
      'https://api.torn.com/user/?selections=profile&key=' + encodeURIComponent(key) + '&comment=BKMSheet',
      { muteHttpExceptions: true }
    );
    var data = JSON.parse(resp.getContentText());
    if (data && !data.error && data.faction && Number(data.faction.faction_id) === FACTION_ID) {
      info.ok = true;
      info.position = String(data.faction.position || '');
    }
  } catch (err) {}
  cache.put(ck, JSON.stringify(info), 300);
  return info;
}
function canRemove(position) {
  return REMOVE_ROLES.indexOf(String(position || '').trim().toLowerCase()) !== -1;
}
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

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
