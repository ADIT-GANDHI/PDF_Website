/**
 * Sign PDF Route — /api/signpdf
 *
 * Endpoints:
 *  GET  /api/signpdf/health              — Health check
 *  POST /api/signpdf/upload              — Upload PDF, store server-side, return sessionId + pageCount
 *  POST /api/signpdf/sign                — Receive placements JSON, embed signature images, return signed PDF
 *  DELETE /api/signpdf/session/:id       — Clean up session files early
 *
 * Placement shape (array):
 *   {
 *     page:         number,      // 1-indexed
 *     x:            number,      // pixels from left of rendered canvas
 *     y:            number,      // pixels from top of rendered canvas
 *     w:            number,      // width in canvas pixels
 *     h:            number,      // height in canvas pixels
 *     canvasWidth:  number,      // full canvas render width (for coordinate mapping)
 *     canvasHeight: number,      // full canvas render height
 *     sigDataURL:   string       // "data:image/png;base64,..."
 *   }
 */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');
const { uploadPdf, cleanupFiles, outputsDir } = require('./upload');

// ─── In-memory session store ────────────────────────────────────────────────
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions.entries()) {
    if (now - sess.createdAt > 7200000) {          // 2 hour TTL
      cleanupFiles(sess.pdfPath);
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

const uploadsDir = path.join(__dirname, '..', 'uploads');

// ─── GET /health ────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', activeSessions: sessions.size });
});

// ─── POST /upload ───────────────────────────────────────────────────────────
router.post('/upload', uploadPdf.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded.' });

    const buf    = fs.readFileSync(uploadedPath);
    const pdfDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    const sessionId      = uuidv4();
    const sessionPdfName = `sign_${sessionId}.pdf`;
    const sessionPdfPath = path.join(uploadsDir, sessionPdfName);
    fs.copyFileSync(uploadedPath, sessionPdfPath);

    sessions.set(sessionId, {
      pdfPath:      sessionPdfPath,
      pageCount,
      originalName: req.file.originalname,
      createdAt:    Date.now()
    });

    res.json({
      success:      true,
      sessionId,
      pageCount,
      originalName: req.file.originalname,
      fileSize:     req.file.size
    });
  } catch (err) {
    console.error('SignPDF upload error:', err);
    res.status(500).json({ error: 'Failed to load PDF: ' + err.message });
  } finally {
    cleanupFiles(uploadedPath);
  }
});

// ─── POST /sign ─────────────────────────────────────────────────────────────
// Body: { sessionId: string, placements: Placement[] }
router.post('/sign', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { sessionId, placements } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({ error: 'Invalid or expired session. Please re-upload the PDF.' });
    }
    if (!Array.isArray(placements) || placements.length === 0) {
      return res.status(400).json({ error: 'No signature placements provided.' });
    }

    const sess   = sessions.get(sessionId);
    const buf    = fs.readFileSync(sess.pdfPath);
    const pdfDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pages  = pdfDoc.getPages();

    // Cache embedded images per unique dataURL to avoid re-embedding duplicates
    const embeddedCache = new Map();

    async function embedSig(dataURL) {
      if (embeddedCache.has(dataURL)) return embeddedCache.get(dataURL);

      const [header, base64] = dataURL.split(',');
      if (!base64) throw new Error('Invalid signature data URL');

      const imgBytes = Buffer.from(base64, 'base64');
      let imgEmbed;

      if (header.includes('image/png')) {
        imgEmbed = await pdfDoc.embedPng(imgBytes);
      } else if (header.includes('image/jpeg') || header.includes('image/jpg')) {
        imgEmbed = await pdfDoc.embedJpg(imgBytes);
      } else {
        // Fallback: try PNG then JPG
        try { imgEmbed = await pdfDoc.embedPng(imgBytes); }
        catch (_) { imgEmbed = await pdfDoc.embedJpg(imgBytes); }
      }

      embeddedCache.set(dataURL, imgEmbed);
      return imgEmbed;
    }

    for (const p of placements) {
      const pgIdx = (p.page || 1) - 1;
      if (pgIdx < 0 || pgIdx >= pages.length) continue;

      const pdfPage = pages[pgIdx];
      const { width: pdfW, height: pdfH } = pdfPage.getSize();

      // Canvas → PDF coordinate mapping
      const cW     = p.canvasWidth  || 816;
      const cH     = p.canvasHeight || 1056;
      const scaleX = pdfW / cW;
      const scaleY = pdfH / cH;

      const x     = (p.x || 0) * scaleX;
      const w     = Math.max(1, (p.w || 150) * scaleX);
      const h     = Math.max(1, (p.h || 50)  * scaleY);
      // PDF origin is bottom-left; canvas origin is top-left
      const y     = pdfH - ((p.y || 0) * scaleY) - h;

      if (!p.sigDataURL) continue;

      try {
        const imgEmbed = await embedSig(p.sigDataURL);
        pdfPage.drawImage(imgEmbed, { x, y, width: w, height: h, opacity: 1.0 });
      } catch (imgErr) {
        console.error(`SignPDF: Failed to embed signature on page ${p.page}:`, imgErr.message);
      }
    }

    // ── Save output ──────────────────────────────────────────────────────
    const outBytes  = await pdfDoc.save({ useObjectStreams: true });
    const baseName  = path.basename(sess.originalName, '.pdf');
    const outName   = `signed_${baseName}_${uuidv4().slice(0, 8)}.pdf`;
    const outPath   = path.join(outputsDir, outName);
    fs.writeFileSync(outPath, outBytes);
    setTimeout(() => cleanupFiles(outPath), 3600000); // 1 hour

    res.json({
      success:     true,
      filename:    outName,
      downloadUrl: `/outputs/${outName}`,
      outputSize:  outBytes.byteLength,
      pageCount:   pages.length,
      signaturesPlaced: placements.length
    });

  } catch (err) {
    console.error('SignPDF sign error:', err);
    res.status(500).json({ error: 'Failed to sign PDF: ' + err.message });
  }
});

// ─── DELETE /session/:id ─────────────────────────────────────────────────────
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

module.exports = router;
