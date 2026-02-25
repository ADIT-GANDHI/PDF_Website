const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');
const { uploadImages, cleanupFiles, outputsDir } = require('./upload');

const PAGE_SIZES = {
  A4:     [595.28, 841.89],
  Letter: [612, 792],
};

router.post('/', uploadImages.array('files', 50), async (req, res) => {
  const uploadedPaths = req.files ? req.files.map(f => f.path) : [];

  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'No image files uploaded.' });
    }

    const pageSize = req.body.pageSize || 'A4';
    const orientation = req.body.orientation || 'portrait';
    const margin = parseInt(req.body.margin) || 20;

    const pdfDoc = await PDFDocument.create();

    for (const file of req.files) {
      const buf = fs.readFileSync(file.path);
      const mime = file.mimetype;

      let img;
      if (mime === 'image/jpeg' || mime === 'image/jpg') {
        img = await pdfDoc.embedJpg(buf);
      } else if (mime === 'image/png') {
        img = await pdfDoc.embedPng(buf);
      } else {
        // For webp/gif/bmp: skip unsupported (client should convert first)
        console.warn(`Skipping unsupported image type: ${mime}`);
        continue;
      }

      const imgW = img.width;
      const imgH = img.height;

      let pageW, pageH;
      if (pageSize === 'fit') {
        pageW = imgW + margin * 2;
        pageH = imgH + margin * 2;
      } else {
        let [pw, ph] = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
        const isLandscape = orientation === 'landscape' ||
          (orientation === 'auto' && imgW > imgH);
        pageW = isLandscape ? ph : pw;
        pageH = isLandscape ? pw : ph;
      }

      const page = pdfDoc.addPage([pageW, pageH]);
      const availW = pageW - margin * 2;
      const availH = pageH - margin * 2;
      const ratio = Math.min(availW / imgW, availH / imgH);
      const drawW = imgW * ratio;
      const drawH = imgH * ratio;
      const x = margin + (availW - drawW) / 2;
      const y = margin + (availH - drawH) / 2;

      page.drawImage(img, { x, y, width: drawW, height: drawH });
    }

    const bytes = await pdfDoc.save({ useObjectStreams: true });
    const outName = `images_${uuidv4()}.pdf`;
    const outPath = path.join(outputsDir, outName);
    fs.writeFileSync(outPath, bytes);
    setTimeout(() => cleanupFiles(outPath), 3600000);

    res.json({
      success: true,
      filename: outName,
      downloadUrl: `/outputs/${outName}`,
      outputSize: bytes.byteLength,
      pageCount: pdfDoc.getPageCount(),
      imagesProcessed: req.files.length
    });

  } catch (err) {
    console.error('Img2PDF error:', err);
    res.status(500).json({ error: 'Failed to create PDF: ' + err.message });
  } finally {
    cleanupFiles(...uploadedPaths);
  }
});

module.exports = router;
