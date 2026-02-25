const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const { uploadPdf, cleanupFiles, outputsDir } = require('./upload');

function parsePageRange(str, total) {
  const pages = new Set();
  str.split(',').forEach(part => {
    part = part.trim();
    if (part.includes('-')) {
      let [a, b] = part.split('-').map(Number);
      b = Math.min(b, total);
      for (let i = a; i <= b; i++) if (i >= 1) pages.add(i);
    } else {
      const n = parseInt(part);
      if (n >= 1 && n <= total) pages.add(n);
    }
  });
  return [...pages].sort((a, b) => a - b);
}

router.post('/', uploadPdf.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;

  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded.' });

    const { mode = 'all', range = '', everyN = '1' } = req.body;
    const buf = fs.readFileSync(req.file.path);
    const srcDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();

    const outputFiles = [];

    async function extractPages(indices, filename) {
      const newDoc = await PDFDocument.create();
      const pages = await newDoc.copyPages(srcDoc, indices);
      pages.forEach(p => newDoc.addPage(p));
      const bytes = await newDoc.save({ useObjectStreams: true });
      const outPath = path.join(outputsDir, filename);
      fs.writeFileSync(outPath, bytes);
      setTimeout(() => cleanupFiles(outPath), 3600000);
      return { filename, size: bytes.byteLength };
    }

    if (mode === 'all') {
      for (let i = 0; i < totalPages; i++) {
        const fname = `page_${i + 1}_${uuidv4().slice(0,8)}.pdf`;
        outputFiles.push(await extractPages([i], fname));
      }
    } else if (mode === 'range') {
      const pages = parsePageRange(range, totalPages);
      if (!pages.length) return res.status(400).json({ error: 'Invalid page range.' });
      const fname = `pages_${uuidv4().slice(0,8)}.pdf`;
      outputFiles.push(await extractPages(pages.map(p => p - 1), fname));
    } else if (mode === 'every') {
      const n = Math.max(1, parseInt(everyN) || 1);
      let chunk = 0;
      for (let i = 0; i < totalPages; i += n) {
        chunk++;
        const end = Math.min(i + n, totalPages);
        const indices = Array.from({ length: end - i }, (_, j) => i + j);
        const fname = `part_${chunk}_${uuidv4().slice(0,8)}.pdf`;
        outputFiles.push(await extractPages(indices, fname));
      }
    }

    // If only one file, return it directly
    if (outputFiles.length === 1) {
      return res.json({
        success: true,
        mode: 'single',
        files: outputFiles.map(f => ({ ...f, downloadUrl: `/outputs/${f.filename}` })),
        totalPages
      });
    }

    // Multiple files: create a ZIP
    const zipName = `split_${uuidv4()}.zip`;
    const zipPath = path.join(outputsDir, zipName);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      outputFiles.forEach(f => {
        archive.file(path.join(outputsDir, f.filename), { name: f.filename });
      });
      archive.finalize();
    });
    setTimeout(() => cleanupFiles(zipPath), 3600000);

    res.json({
      success: true,
      mode: 'zip',
      zipUrl: `/outputs/${zipName}`,
      zipName,
      files: outputFiles.map(f => ({ ...f, downloadUrl: `/outputs/${f.filename}` })),
      totalPages
    });

  } catch (err) {
    console.error('Split error:', err);
    res.status(500).json({ error: 'Failed to split PDF: ' + err.message });
  } finally {
    cleanupFiles(uploadedPath);
  }
});

module.exports = router;
