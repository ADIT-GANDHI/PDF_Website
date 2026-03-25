/**
 * PDF Editor Route — /api/pdfeditor
 *
 * Endpoints:
 *  POST /api/pdfeditor/upload      — Upload PDF, cache server-side, return sessionId + page count
 *  GET  /api/pdfeditor/page        — Render a page to PNG (via pdf-to-png-converter or poppler)
 *  POST /api/pdfeditor/save        — Accept annotation JSON + original PDF, bake annotations, return edited PDF
 *  DELETE /api/pdfeditor/session   — Clean up session files early
 *
 * Annotation types supported:
 *   draw, highlight, line, rect, text, eraser
 */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const { PDFDocument, rgb, degrees, StandardFonts, LineCapStyle } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');
const { uploadPdf, cleanupFiles, outputsDir } = require('./upload');

// ─── Session store (in-memory; maps sessionId → { pdfPath, pages, createdAt }) ───
const sessions = new Map();

// Auto-expire sessions after 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions.entries()) {
    if (now - sess.createdAt > 7200000) {
      cleanupFiles(sess.pdfPath);
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ─── Uploads dir for session PDFs ───────────────────────────────────────────
const uploadsDir = path.join(__dirname, '..', 'uploads');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pdfeditor/upload
//   Accepts: multipart/form-data  { file: PDF }
//   Returns: { sessionId, pageCount, originalName, fileSize }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload', uploadPdf.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded.' });

    const buf = fs.readFileSync(uploadedPath);
    const pdfDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    const sessionId = uuidv4();
    // Keep a copy in uploads dir tied to sessionId
    const sessionPdfName = `editor_${sessionId}.pdf`;
    const sessionPdfPath = path.join(uploadsDir, sessionPdfName);
    fs.copyFileSync(uploadedPath, sessionPdfPath);

    sessions.set(sessionId, {
      pdfPath: sessionPdfPath,
      pageCount,
      originalName: req.file.originalname,
      createdAt: Date.now()
    });

    res.json({
      success: true,
      sessionId,
      pageCount,
      originalName: req.file.originalname,
      fileSize: req.file.size
    });
  } catch (err) {
    console.error('Editor upload error:', err);
    res.status(500).json({ error: 'Failed to load PDF: ' + err.message });
  } finally {
    cleanupFiles(uploadedPath);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pdfeditor/save
//   Accepts: JSON body {
//     sessionId: string,
//     annotations: {
//       [pageNum: string]: Annotation[]
//     }
//   }
//   Annotation shape:
//     { tool: 'draw'|'highlight'|'line'|'rect'|'text'|'eraser',
//       color: '#rrggbb', size: number,
//       points?: [{x,y}],       // draw, highlight, eraser
//       x1?,y1?,x2?,y2?: number, // line, rect
//       x?,y?: number,           // text
//       text?: string,           // text
//       canvasWidth: number,     // canvas dimensions at time of annotation
//       canvasHeight: number
//     }
//   Returns: { success, downloadUrl, filename, outputSize }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/save', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { sessionId, annotations = {} } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({ error: 'Invalid or expired session. Please re-upload the PDF.' });
    }

    const sess = sessions.get(sessionId);
    const buf  = fs.readFileSync(sess.pdfPath);
    const pdfDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pages  = pdfDoc.getPages();

    // Embed font for text annotations
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // ── Process each page's annotations ──────────────────────────────────
    for (const [pageNumStr, strokes] of Object.entries(annotations)) {
      const pageIdx = parseInt(pageNumStr, 10) - 1;
      if (pageIdx < 0 || pageIdx >= pages.length) continue;
      if (!Array.isArray(strokes) || strokes.length === 0) continue;

      const page = pages[pageIdx];
      const { width: pdfW, height: pdfH } = page.getSize();

      for (const s of strokes) {
        // Coordinate transform: canvas → PDF space
        // Canvas uses top-left origin; PDF uses bottom-left
        const cW = s.canvasWidth  || 800;
        const cH = s.canvasHeight || 1100;
        const sx = pdfW / cW;
        const sy = pdfH / cH;

        const col = hexToRgb(s.color || '#000000');

        switch (s.tool) {
          case 'draw':
          case 'eraser': {
            // Eraser: draw in white (approximation — true eraser needs content stream editing)
            const strokeCol = s.tool === 'eraser' ? { r: 1, g: 1, b: 1 } : col;
            const pts = s.points || [];
            if (pts.length < 2) break;
            for (let i = 1; i < pts.length; i++) {
              const x1 = pts[i-1].x * sx, y1 = pdfH - pts[i-1].y * sy;
              const x2 = pts[i].x   * sx, y2 = pdfH - pts[i].y   * sy;
              page.drawLine({
                start:     { x: x1, y: y1 },
                end:       { x: x2, y: y2 },
                thickness: Math.max(0.5, s.size * Math.min(sx, sy)),
                color:     rgb(strokeCol.r, strokeCol.g, strokeCol.b),
                opacity:   1,
                lineCap:   LineCapStyle.Round
              });
            }
            break;
          }

          case 'highlight': {
            const pts = s.points || [];
            if (pts.length < 2) break;
            // Draw as semi-transparent thick lines
            for (let i = 1; i < pts.length; i++) {
              const x1 = pts[i-1].x * sx, y1 = pdfH - pts[i-1].y * sy;
              const x2 = pts[i].x   * sx, y2 = pdfH - pts[i].y   * sy;
              page.drawLine({
                start:     { x: x1, y: y1 },
                end:       { x: x2, y: y2 },
                thickness: Math.max(1, s.size * Math.min(sx, sy)),
                color:     rgb(col.r, col.g, col.b),
                opacity:   0.35,
                lineCap:   LineCapStyle.Round
              });
            }
            break;
          }

          case 'line': {
            const x1 = (s.x1 || 0) * sx, y1 = pdfH - (s.y1 || 0) * sy;
            const x2 = (s.x2 || 0) * sx, y2 = pdfH - (s.y2 || 0) * sy;
            page.drawLine({
              start:     { x: x1, y: y1 },
              end:       { x: x2, y: y2 },
              thickness: Math.max(0.5, s.size * Math.min(sx, sy)),
              color:     rgb(col.r, col.g, col.b),
              opacity:   1,
              lineCap:   LineCapStyle.Round
            });
            break;
          }

          case 'rect': {
            const rx  = Math.min(s.x1 || 0, s.x2 || 0) * sx;
            const ry2 = Math.min(s.y1 || 0, s.y2 || 0);
            const rw  = Math.abs((s.x2 || 0) - (s.x1 || 0)) * sx;
            const rh  = Math.abs((s.y2 || 0) - (s.y1 || 0)) * sy;
            if (rw < 1 || rh < 1) break;
            page.drawRectangle({
              x:           rx,
              y:           pdfH - ry2 * sy - rh,
              width:       rw,
              height:      rh,
              borderColor: rgb(col.r, col.g, col.b),
              borderWidth: Math.max(0.5, s.size * Math.min(sx, sy)),
              opacity:     0,
              borderOpacity: 1
            });
            break;
          }

          case 'text': {
            const tx   = (s.x || 0) * sx;
            const ty   = pdfH - (s.y || 0) * sy;
            const fontSize = Math.max(6, (s.size * 4 + 8) * Math.min(sx, sy));
            const lines = (s.text || '').split('\n');
            lines.forEach((line, li) => {
              if (!line) return;
              try {
                page.drawText(line, {
                  x:     tx,
                  y:     ty - li * (fontSize * 1.3),
                  size:  fontSize,
                  font:  helvetica,
                  color: rgb(col.r, col.g, col.b),
                  opacity: 1
                });
              } catch (_) {}
            });
            break;
          }

          default:
            break;
        }
      }
    }

    // ── Save output ───────────────────────────────────────────────────────
    const outBytes  = await pdfDoc.save({ useObjectStreams: true });
    const baseName  = path.basename(sess.originalName, '.pdf');
    const outName   = `edited_${baseName}_${uuidv4().slice(0,8)}.pdf`;
    const outPath   = path.join(outputsDir, outName);
    fs.writeFileSync(outPath, outBytes);
    setTimeout(() => cleanupFiles(outPath), 3600000); // 1 hour

    res.json({
      success:     true,
      filename:    outName,
      downloadUrl: `/outputs/${outName}`,
      outputSize:  outBytes.byteLength,
      pageCount:   pages.length
    });

  } catch (err) {
    console.error('Editor save error:', err);
    res.status(500).json({ error: 'Failed to save PDF: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/pdfeditor/session/:sessionId
//   Immediately cleans up uploaded PDF for a session
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (sessions.has(sessionId)) {
    const sess = sessions.get(sessionId);
    cleanupFiles(sess.pdfPath);
    sessions.delete(sessionId);
    res.json({ success: true, message: 'Session cleaned up.' });
  } else {
    res.status(404).json({ error: 'Session not found.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pdfeditor/health
// ─────────────────────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', activeSessions: sessions.size });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return { r: isNaN(r) ? 0 : r, g: isNaN(g) ? 0 : g, b: isNaN(b) ? 0 : b };
}

module.exports = router;
