const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');
const { uploadExcel, cleanupFiles, outputsDir } = require('./upload');

// ─────────────────────────────────────────────
//  Colour helpers
// ─────────────────────────────────────────────
function hexToRgb(hex) {
  if (!hex || hex.length < 6) return null;
  // ExcelJS returns ARGB (8 chars) or RGB (6 chars)
  const clean = hex.replace(/^FF/i, '').slice(-6);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return rgb(r, g, b);
}

function safeColor(colorObj, fallback) {
  try {
    if (colorObj && colorObj.argb) return hexToRgb(colorObj.argb) || fallback;
  } catch (e) {}
  return fallback;
}

// ─────────────────────────────────────────────
//  Route: POST /api/excel2pdf
// ─────────────────────────────────────────────
router.post('/', uploadExcel.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ error: 'No Excel file uploaded.' });

    const orientation = req.body.orientation || 'landscape'; // landscape | portrait
    const fitToPage  = req.body.fitToPage  !== 'false';     // shrink cols to fit

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    const pdfDoc   = await PDFDocument.create();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontReg  = await pdfDoc.embedFont(StandardFonts.Helvetica);

    let totalSheets = 0;

    for (const worksheet of workbook.worksheets) {
      if (worksheet.state === 'hidden') continue;

      // ── Collect all cell data ──────────────────────────────────────────
      const rows = [];
      let maxCol = 0;

      worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
        const cells = [];
        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
          maxCol = Math.max(maxCol, colNum);
          let value = '';
          if (cell.value !== null && cell.value !== undefined) {
            if (typeof cell.value === 'object') {
              if (cell.value.result !== undefined)      value = String(cell.value.result);
              else if (cell.value.text !== undefined)   value = String(cell.value.text);
              else if (cell.value.hyperlink !== undefined) value = String(cell.value.text || cell.value.hyperlink);
              else                                      value = String(cell.value);
            } else {
              value = String(cell.value);
            }
          }
          cells.push({
            value,
            colNum,
            isBold:   !!(cell.font && cell.font.bold),
            bgColor:  safeColor(cell.fill && cell.fill.fgColor, null),
            fgColor:  safeColor(cell.font && cell.font.color, rgb(0.05, 0.05, 0.05)),
            align:    (cell.alignment && cell.alignment.horizontal) || 'left',
          });
        });
        rows.push({ cells, rowNum, isHeader: rowNum === 1 });
      });

      if (!rows.length) continue;

      // ── Determine column widths ────────────────────────────────────────
      const PAGE_W = orientation === 'landscape' ? 841.89 : 595.28;
      const PAGE_H = orientation === 'landscape' ? 595.28 : 841.89;
      const MARGIN = 36;
      const USABLE_W = PAGE_W - MARGIN * 2;
      const ROW_H = 18;
      const FONT_SIZE = 8;
      const HEADER_H = 22;

      // Compute natural col widths from data
      const colWidths = Array(maxCol + 1).fill(0);
      rows.forEach(({ cells }) => {
        cells.forEach(({ value, colNum }) => {
          const w = Math.min(value.length * (FONT_SIZE * 0.55) + 10, 200);
          colWidths[colNum] = Math.max(colWidths[colNum], w, 30);
        });
      });

      // Get Excel-defined widths as a hint
      for (let c = 1; c <= maxCol; c++) {
        const col = worksheet.getColumn(c);
        if (col.width) colWidths[c] = Math.min(col.width * 6.5, 240);
      }

      let totalNatural = colWidths.slice(1, maxCol + 1).reduce((s, w) => s + w, 0);

      // Scale to fit if needed
      let scale = 1;
      if (fitToPage && totalNatural > USABLE_W) {
        scale = USABLE_W / totalNatural;
      }
      const finalColWidths = colWidths.map(w => w * scale);

      // ── Paginate rows ──────────────────────────────────────────────────
      // Each "page" holds as many rows as fit
      const rowsPerPage = Math.floor((PAGE_H - MARGIN * 2 - HEADER_H) / ROW_H);
      const pageChunks = [];
      for (let i = 0; i < rows.length; i += rowsPerPage) {
        pageChunks.push(rows.slice(i, i + rowsPerPage));
      }

      // ── Draw pages ────────────────────────────────────────────────────
      for (const [pageIdx, chunk] of pageChunks.entries()) {
        const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        totalSheets++;

        // Sheet name header bar
        page.drawRectangle({
          x: MARGIN, y: PAGE_H - MARGIN - 20,
          width: USABLE_W, height: 20,
          color: rgb(0.11, 0.11, 0.27),
        });
        page.drawText(`${worksheet.name}${pageChunks.length > 1 ? ` (page ${pageIdx + 1}/${pageChunks.length})` : ''}`, {
          x: MARGIN + 6, y: PAGE_H - MARGIN - 14,
          size: 8, font: fontBold, color: rgb(1, 1, 1),
        });

        let y = PAGE_H - MARGIN - 20;

        for (const [rowIdx, row] of chunk.entries()) {
          const isFirstRow = row.rowNum === 1 && pageIdx === 0;
          const rh = isFirstRow ? HEADER_H : ROW_H;
          y -= rh;

          // Alternating row background
          if (!isFirstRow && rowIdx % 2 === 0) {
            page.drawRectangle({
              x: MARGIN, y,
              width: USABLE_W, height: rh,
              color: rgb(0.97, 0.97, 0.98),
            });
          }

          // Cell backgrounds & text
          let x = MARGIN;
          for (let c = 1; c <= maxCol; c++) {
            const cw = finalColWidths[c] || 40;
            const cellData = row.cells.find(cc => cc.colNum === c);

            if (cellData) {
              // Custom background
              if (cellData.bgColor) {
                page.drawRectangle({ x, y, width: cw, height: rh, color: cellData.bgColor });
              }
              // Header row special bg
              if (isFirstRow) {
                page.drawRectangle({ x, y, width: cw, height: rh, color: rgb(0.18, 0.33, 0.6) });
              }

              // Clip text to cell width
              const maxChars = Math.max(2, Math.floor(cw / (FONT_SIZE * 0.55)) - 1);
              const text = cellData.value.length > maxChars
                ? cellData.value.slice(0, maxChars - 1) + '…'
                : cellData.value;

              const textColor = isFirstRow ? rgb(1, 1, 1) : (cellData.fgColor || rgb(0.05, 0.05, 0.05));
              const font = (isFirstRow || cellData.isBold) ? fontBold : fontReg;

              page.drawText(text, {
                x: x + 3, y: y + (rh - FONT_SIZE) / 2,
                size: isFirstRow ? FONT_SIZE + 1 : FONT_SIZE,
                font, color: textColor,
                maxWidth: cw - 4,
              });
            }

            // Cell border
            page.drawRectangle({
              x, y, width: cw, height: rh,
              borderColor: rgb(0.82, 0.82, 0.88),
              borderWidth: 0.4,
              color: undefined,
            });

            x += cw;
          }
        }

        // Page number footer
        page.drawText(`Generated by PDFMagic · Page ${pageIdx + 1}`, {
          x: MARGIN, y: MARGIN - 14,
          size: 6, font: fontReg, color: rgb(0.6, 0.6, 0.6),
        });
      }
    }

    if (totalSheets === 0) {
      return res.status(422).json({ error: 'No visible sheets with data found in this workbook.' });
    }

    const bytes = await pdfDoc.save({ useObjectStreams: true });
    const outName = `excel_to_pdf_${uuidv4().slice(0, 8)}.pdf`;
    const outPath = path.join(outputsDir, outName);
    fs.writeFileSync(outPath, bytes);
    setTimeout(() => cleanupFiles(outPath), 3600000);

    res.json({
      success: true,
      filename: outName,
      downloadUrl: `/outputs/${outName}`,
      outputSize: bytes.byteLength,
      pageCount: pdfDoc.getPageCount(),
      sheetCount: workbook.worksheets.filter(s => s.state !== 'hidden').length,
    });

  } catch (err) {
    console.error('Excel→PDF error:', err);
    res.status(500).json({ error: 'Conversion failed: ' + err.message });
  } finally {
    cleanupFiles(uploadedPath);
  }
});

module.exports = router;
