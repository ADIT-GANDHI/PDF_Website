/**
 * FreeStyle Libre NFC UID → Serial Number Converter
 *
 * HOW TO SET UP:
 * 1. In your Google Sheet, go to Extensions → Apps Script
 * 2. Paste this entire file, replacing any existing code
 * 3. Click Save (Ctrl+S)
 * 4. Run installTrigger() ONCE from the menu (Run → installTrigger)
 *    This installs the automatic onEdit trigger permanently.
 * 5. Done! Any UID typed or pasted into column A will instantly
 *    produce the serial number in column B of the same row.
 *
 * To convert all existing data in column A at once, run: processAll()
 *
 * Column layout:
 *   Column A  →  UID  (e.g.  E0:07:A0:00:64:30:BD:8F  or  8F:BD:30:64:00:A0:07:E0)
 *   Column B  ←  Serial number written here automatically
 */

// ─── Core conversion algorithm ────────────────────────────────────────────────

var CHARSET = "0123456789ACDEFGHJKLMNPQRTUVWXYZ";

function uidToSerial(uid) {
  if (!uid || typeof uid !== "string") return "INVALID";

  var bytes = uid.trim().split(":").map(function(h) { return parseInt(h, 16); });

  if (bytes.length !== 8 || bytes.some(isNaN)) return "INVALID UID";

  // Normalize to MSB-first (0xE0 manufacturer byte at index 0)
  if (bytes[7] === 0xE0) bytes = bytes.reverse();
  if (bytes[0] !== 0xE0) return "NOT A LIBRE UID";

  // Skip first 2 bytes (E0 = NXP manufacturer, 07 = NXP code)
  var b = bytes.slice(2); // b = [b0, b1, b2, b3, b4, b5]

  // Extract ten 5-bit indices using 8-bit (mod-256) arithmetic
  var idx = [
    (b[0] >> 3),
    ((b[0] << 2) + (b[1] >> 6)),
    (b[1] >> 1),
    ((b[1] << 4) + (b[2] >> 4)),
    ((b[2] << 1) + (b[3] >> 7)),
    (b[3] >> 2),
    ((b[3] << 3) + (b[4] >> 5)),
    (b[4]),
    (b[5] >> 3),
    (b[5] << 2)
  ];

  return "0" + idx.map(function(i) { return CHARSET[i & 0x1F]; }).join("");
}

// ─── Auto-convert: fires whenever any cell is edited ──────────────────────────

function onEditTrigger(e) {
  var range = e.range;
  var sheet = range.getSheet();

  // Only act on column A edits
  if (range.getColumn() !== 1) return;

  var firstRow = range.getRow();
  var numRows  = range.getNumRows();

  for (var i = 0; i < numRows; i++) {
    var row      = firstRow + i;
    var uidCell  = sheet.getRange(row, 1); // column A
    var outCell  = sheet.getRange(row, 2); // column B
    var uid      = uidCell.getValue().toString().trim();

    if (uid === "") {
      outCell.clearContent();
    } else {
      outCell.setValue(uidToSerial(uid));
    }
  }
}

// ─── Batch: convert every non-empty cell already in column A ──────────────────

function processAll() {
  var sheet    = SpreadsheetApp.getActiveSheet();
  var lastRow  = sheet.getLastRow();

  if (lastRow < 1) {
    SpreadsheetApp.getUi().alert("Sheet is empty — nothing to process.");
    return;
  }

  var converted = 0;
  for (var row = 1; row <= lastRow; row++) {
    var uid = sheet.getRange(row, 1).getValue().toString().trim();
    if (uid === "") continue;
    sheet.getRange(row, 2).setValue(uidToSerial(uid));
    converted++;
  }

  SpreadsheetApp.getUi().alert("Done! Converted " + converted + " UID(s).");
}

// ─── Installer: run this ONCE to attach the trigger permanently ───────────────

function installTrigger() {
  // Remove any existing copies of our trigger to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "onEditTrigger") {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Install a fresh installable onEdit trigger
  ScriptApp.newTrigger("onEditTrigger")
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  SpreadsheetApp.getUi().alert(
    "Trigger installed!\n\n" +
    "From now on, any UID you type or paste into column A\n" +
    "will be converted automatically in column B.\n\n" +
    "To convert existing data, run processAll()."
  );
}
