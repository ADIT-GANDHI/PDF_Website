const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');
const { uploadPdf, cleanupFiles, outputsDir } = require('./upload');

router.post('/', uploadPdf.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded.' });

    const level = parseInt(req.body.level) || 2; // 1=low, 2=medium, 3=high
    const buf = fs.readFileSync(req.file.path);
    const srcDoc = await PDFDocument.load(buf, { ignoreEncryption: true });

    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    pages.forEach(p => newDoc.addPage(p));

    // Copy metadata
    try { newDoc.setTitle(srcDoc.getTitle() || ''); } catch(e) {}
    try { newDoc.setAuthor(srcDoc.getAuthor() || ''); } catch(e) {}

    const saveOpts = {
      useObjectStreams: level >= 2,
      addDefaultPage: false,
      objectsPerTick: level === 3 ? 50 : 100
    };

    const bytes = await newDoc.save(saveOpts);
    const outName = `compressed_${uuidv4()}.pdf`;
    const outPath = path.join(outputsDir, outName);
    fs.writeFileSync(outPath, bytes);
    setTimeout(() => cleanupFiles(outPath), 3600000);

    const originalSize = req.file.size;
    const outputSize = bytes.byteLength;
    const savedBytes = originalSize - outputSize;
    const savedPercent = Math.max(0, Math.round((savedBytes / originalSize) * 100));

    res.json({
      success: true,
      filename: outName,
      downloadUrl: `/outputs/${outName}`,
      originalSize,
      outputSize,
      savedBytes,
      savedPercent,
      pageCount: newDoc.getPageCount()
    });

  } catch (err) {
    console.error('Compress error:', err);
    res.status(500).json({ error: 'Failed to compress PDF: ' + err.message });
  } finally {
    cleanupFiles(uploadedPath);
  }
});

module.exports = router;
