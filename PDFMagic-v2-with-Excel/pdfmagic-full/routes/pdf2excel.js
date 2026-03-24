const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const ExcelJS = require('exceljs');
const { v4: uuidv4 } = require('uuid');
const { uploadPdf, cleanupFiles, outputsDir } = require('./upload');

// ─────────────────────────────────────────────
//  Smart table detection from raw PDF text
// ─────────────────────────────────────────────

/**
 * Split a line into columns using whitespace patterns.
 * Returns an array of cell strings.
 */
function splitIntoColumns(line) {
  // Match sequences of non-whitespace (with optional single spaces inside words)
  // Splitting on 2+ consecutive spaces gives good column separation
  return line.split(/\s{2,}/).map(s => s.trim()).filter((s, i, arr) => {
    // Keep empty strings only in the middle (not leading/trailing)
    return s !== '' || (i > 0 && i < arr.length - 1);
  });
}

/**
 * Detect if a row looks like a header (ALL CAPS, short words, no numbers).
 */
function isHeaderRow(cols) {
  if (!cols.length) return false;
  const joined = cols.join(' ');
  const hasAllCaps = /^[A-Z\s\d#\/\-_(),.]+$/.test(joined);
  const isShort = cols.every(c => c.length < 40);
  return hasAllCaps && isShort && cols.length >= 2;
}

/**
 * Try to detect if a value is numeric.
 */
function parseNumeric(str) {
  if (!str) return null;
  // Remove commas, currency symbols, percent
  const clean = str.replace(/[$,£€¥%]/g, '').trim();
  const num = Number(clean);
  return !isNaN(num) && clean !== '' ? num : null;
}

/**
 * Group lines into table blocks and metadata blocks.
 * Returns array of: { type: 'table'|'text', data, title? }
 */
function parseTextIntoBlocks(rawText) {
  const lines = rawText.split('\n').map(l => l.trimEnd());
  const blocks = [];

  let currentTable = null;
  let currentMeta  = [];
  let pendingTitle = '';

  const flushMeta = () => {
    if (currentMeta.length > 0) {
      blocks.push({ type: 'text', lines: [...currentMeta] });
      currentMeta = [];
    }
  };
  const flushTable = () => {
    if (currentTable && currentTable.rows.length > 0) {
      blocks.push({ type: 'table', title: currentTable.title, rows: currentTable.rows });
      currentTable = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      // Blank line ends a table block
      if (currentTable) flushTable();
      pendingTitle = '';
      continue;
    }

    // Page break
    if (trimmed === '\f' || trimmed.startsWith('\x0c')) {
      flushTable(); flushMeta();
      blocks.push({ type: 'pagebreak' });
      continue;
    }

    const cols = splitIntoColumns(line);

    // A line with 2+ columns suggests tabular data
    if (cols.length >= 2) {
      if (!currentTable) {
        flushMeta();
        currentTable = { title: pendingTitle, rows: [] };
      }
      currentTable.rows.push(cols);
    } else {
      // Single-column line
      if (currentTable) {
        // Allow 1-2 single-column lines inside a table (subtitles, etc.)
        if (cols.length === 1 && currentTable.rows.length > 0) {
          flushTable();
        }
      }
      if (!currentTable) {
        // Could be a section title for the next table
        pendingTitle = trimmed;
        currentMeta.push(trimmed);
      }
    }
  }

  flushTable();
  flushMeta();

  return blocks;
}

// ─────────────────────────────────────────────
//  Build Excel workbook from blocks
// ─────────────────────────────────────────────
async function buildWorkbook(blocks, originalName, options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'All In One File Converter';
  workbook.created = new Date();

  // ── Overview sheet with metadata ──
  const overviewSheet = workbook.addWorksheet('Overview');
  overviewSheet.getColumn(1).width = 20;
  overviewSheet.getColumn(2).width = 50;

  const titleRow = overviewSheet.addRow(['All In One File Converter']);
  titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
  overviewSheet.mergeCells(`A1:B1`);
  titleRow.height = 24;

  overviewSheet.addRow(['Source file', originalName]);
  overviewSheet.addRow(['Converted on', new Date().toLocaleString()]);
  overviewSheet.addRow(['Tool', 'All In One File Converter — PDF to Excel']);
  overviewSheet.addRow([]);

  const textBlocks = blocks.filter(b => b.type === 'text');
  if (textBlocks.length > 0) {
    overviewSheet.addRow(['Extracted Text / Metadata']).getCell(1).font = { bold: true };
    textBlocks.forEach(b => {
      b.lines.forEach(line => overviewSheet.addRow(['', line]));
    });
  }

  // Style overview
  overviewSheet.eachRow(row => {
    row.eachCell(cell => {
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } }
      };
    });
  });

  // ── One sheet per table block ──
  const tableBlocks = blocks.filter(b => b.type === 'table');

  if (tableBlocks.length === 0) {
    // No tables detected — dump all text into one sheet as rows
    const rawSheet = workbook.addWorksheet('Extracted Data');
    rawSheet.getColumn(1).width = 80;

    const hdr = rawSheet.addRow(['Extracted Content']);
    hdr.getCell(1).font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    hdr.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    hdr.height = 20;

    blocks.filter(b => b.type === 'text').forEach(b => {
      b.lines.forEach(line => {
        if (line.trim()) rawSheet.addRow([line.trim()]);
      });
    });
  } else {
    tableBlocks.forEach((block, idx) => {
      const sheetName = block.title
        ? block.title.slice(0, 28).replace(/[*?:/\\[\]]/g, '_')
        : `Table ${idx + 1}`;
      const sheet = workbook.addWorksheet(sheetName);

      if (!block.rows.length) return;

      // Normalize columns — use max col count
      const maxCols = Math.max(...block.rows.map(r => r.length));

      // Add title row above data if we have a title
      if (block.title) {
        const titleR = sheet.addRow([block.title]);
        titleR.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF1E3A8A' } };
        sheet.mergeCells(1, 1, 1, maxCols);
        titleR.height = 20;
        sheet.addRow([]); // spacer
      }

      // Write rows
      block.rows.forEach((cols, ri) => {
        // Pad to maxCols
        const padded = [...cols];
        while (padded.length < maxCols) padded.push('');

        const exRow = sheet.addRow(padded);
        const isHeader = ri === 0;

        exRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
          const val = padded[colNum - 1] || '';
          // Try numeric
          const num = parseNumeric(val);
          if (num !== null && !isHeader) {
            cell.value = num;
            cell.numFmt = val.includes('%') ? '0.00%' : (val.includes('.') ? '#,##0.00' : '#,##0');
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
          } else {
            cell.value = val;
            cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
          }

          // Header row styling
          if (isHeader) {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            exRow.height = 22;
          } else if (ri % 2 === 0) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } };
          }

          cell.border = {
            top:    { style: 'thin', color: { argb: 'FFD1D5DB' } },
            left:   { style: 'thin', color: { argb: 'FFD1D5DB' } },
            bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
            right:  { style: 'thin', color: { argb: 'FFD1D5DB' } },
          };
        });
      });

      // Auto-fit column widths
      for (let c = 1; c <= maxCols; c++) {
        const col = sheet.getColumn(c);
        let maxW = 8;
        sheet.eachRow(row => {
          const cell = row.getCell(c);
          const len = (cell.value ? String(cell.value) : '').length;
          maxW = Math.max(maxW, len + 2);
        });
        col.width = Math.min(maxW, 40);
      }

      // Freeze header row
      const freezeRow = block.title ? 3 : 2;
      sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: freezeRow - 1 }];

      // AutoFilter on header row
      if (block.rows.length > 1) {
        sheet.autoFilter = {
          from: { row: freezeRow - 1, column: 1 },
          to:   { row: freezeRow - 1, column: maxCols }
        };
      }
    });
  }

  return workbook;
}

// ─────────────────────────────────────────────
//  Route: POST /api/pdf2excel
// ─────────────────────────────────────────────
router.post('/', uploadPdf.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded.' });

    const originalName = req.file.originalname.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const buf = fs.readFileSync(req.file.path);

    // ── Step 1: Extract text ──
    let pdfData;
    try {
      pdfData = await pdfParse(buf, {
        max: 0,
        pagerender: async (pageData) => {
          const content = await pageData.getTextContent();
          // Group items by Y-position to reconstruct rows
          const lineMap = {};
          content.items.forEach(item => {
            const y = Math.round(item.transform[5]);
            if (!lineMap[y]) lineMap[y] = [];
            lineMap[y].push({ x: item.transform[4], str: item.str });
          });

          // Sort lines top-to-bottom (PDF Y is inverted)
          const ys = Object.keys(lineMap).map(Number).sort((a, b) => b - a);
          return ys.map(y => {
            const items = lineMap[y].sort((a, b) => a.x - b.x);
            // Insert spacing between items based on X gap
            let line = '';
            for (let i = 0; i < items.length; i++) {
              if (i > 0) {
                const gap = items[i].x - (items[i - 1].x + items[i - 1].str.length * 4);
                line += gap > 10 ? '   ' : ' ';
              }
              line += items[i].str;
            }
            return line;
          }).join('\n') + '\n\f';
        }
      });
    } catch (err) {
      return res.status(422).json({
        error: 'Could not extract text from PDF. It may be scanned/image-based. ' + err.message
      });
    }

    if (!pdfData.text || pdfData.text.trim().length < 5) {
      return res.status(422).json({
        error: 'No extractable text found. This PDF may be scanned. Try an OCR tool first.'
      });
    }

    // ── Step 2: Parse into blocks ──
    const blocks = parseTextIntoBlocks(pdfData.text);

    // ── Step 3: Build workbook ──
    const workbook = await buildWorkbook(blocks, req.file.originalname);

    // ── Step 4: Save ──
    const outName = `${originalName.slice(0, 40)}_${uuidv4().slice(0, 8)}.xlsx`;
    const outPath = path.join(outputsDir, outName);
    await workbook.xlsx.writeFile(outPath);
    setTimeout(() => cleanupFiles(outPath), 3600000);

    const stats = fs.statSync(outPath);
    const tableCount = blocks.filter(b => b.type === 'table').length;

    res.json({
      success: true,
      filename: outName,
      downloadUrl: `/outputs/${outName}`,
      outputSize: stats.size,
      pageCount: pdfData.numpages,
      tableCount,
      sheetCount: workbook.worksheets.length,
      wordCount: pdfData.text.split(/\s+/).filter(Boolean).length,
    });

  } catch (err) {
    console.error('PDF→Excel error:', err);
    res.status(500).json({ error: 'Conversion failed: ' + err.message });
  } finally {
    cleanupFiles(uploadedPath);
  }
});

module.exports = router;
