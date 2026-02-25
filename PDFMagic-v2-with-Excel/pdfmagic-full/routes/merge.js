const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');
const { uploadMultiPdf, cleanupFiles, outputsDir } = require('./upload');

router.post('/', uploadMultiPdf.array('files', 20), async (req, res) => {
  const uploadedPaths = req.files ? req.files.map(f => f.path) : [];

  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: 'Please upload at least 2 PDF files to merge.' });
    }

    const merged = await PDFDocument.create();

    for (let i = 0; i < req.files.length; i++) {
      const buf = fs.readFileSync(req.files[i].path);
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }

    const bytes = await merged.save({ useObjectStreams: true });
    const outName = `merged_${uuidv4()}.pdf`;
    const outPath = path.join(outputsDir, outName);
    fs.writeFileSync(outPath, bytes);

    // Schedule cleanup of output after 1 hour
    setTimeout(() => cleanupFiles(outPath), 3600000);

    res.json({
      success: true,
      filename: outName,
      downloadUrl: `/outputs/${outName}`,
      originalSize: req.files.reduce((sum, f) => sum + f.size, 0),
      outputSize: bytes.byteLength,
      pagesMerged: req.files.length
    });

  } catch (err) {
    console.error('Merge error:', err);
    res.status(500).json({ error: 'Failed to merge PDFs: ' + err.message });
  } finally {
    cleanupFiles(...uploadedPaths);
  }
});

module.exports = router;
