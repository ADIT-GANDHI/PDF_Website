const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const { uploadPdf, cleanupFiles, outputsDir } = require('./upload');

// PDF to images is handled client-side using PDF.js canvas rendering.
// This route is provided as a passthrough endpoint for metadata + ZIP packaging
// when server-side rendering is desired via an external tool like pdf-poppler (optional).
// For the current setup, we return a signal to use client-side rendering.

router.post('/info', uploadPdf.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded.' });

    // Return file info and a temp URL so the client can fetch it for PDF.js rendering
    const sessionId = uuidv4();
    const tempName = `temp_${sessionId}.pdf`;
    const tempPath = path.join(outputsDir, tempName);
    fs.copyFileSync(req.file.path, tempPath);
    setTimeout(() => cleanupFiles(tempPath), 1800000); // 30 min

    res.json({
      success: true,
      fileUrl: `/outputs/${tempName}`,
      sessionId,
      originalName: req.file.originalname,
      fileSize: req.file.size
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    cleanupFiles(uploadedPath);
  }
});

// Receive rendered images from client and bundle into ZIP
router.post('/zip', express.json({ limit: '200mb' }), async (req, res) => {
  try {
    const { images, format } = req.body; // images: [{dataUrl, name}]
    if (!images || !images.length) return res.status(400).json({ error: 'No images provided.' });

    const zipName = `pdf_images_${uuidv4()}.zip`;
    const zipPath = path.join(outputsDir, zipName);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      images.forEach(({ dataUrl, name }) => {
        const base64 = dataUrl.split(',')[1];
        const buf = Buffer.from(base64, 'base64');
        archive.append(buf, { name });
      });
      archive.finalize();
    });

    setTimeout(() => cleanupFiles(zipPath), 3600000);

    res.json({
      success: true,
      zipUrl: `/outputs/${zipName}`,
      zipName,
      imageCount: images.length
    });
  } catch (err) {
    console.error('PDF2Img ZIP error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
