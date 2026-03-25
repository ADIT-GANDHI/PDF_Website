const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

['uploads', 'outputs'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/merge',      require('./routes/merge'));
app.use('/api/split',      require('./routes/split'));
app.use('/api/compress',   require('./routes/compress'));
app.use('/api/pdf2img',    require('./routes/pdf2img'));
app.use('/api/img2pdf',    require('./routes/img2pdf'));
app.use('/api/pdf2word',   require('./routes/pdf2word'));
app.use('/api/excel2pdf',  require('./routes/excel2pdf'));
app.use('/api/pdf2excel',  require('./routes/pdf2excel'));
app.use('/api/pdfeditor',  require('./routes/pdfeditor'));
app.use('/api/signpdf',    require('./routes/signpdf'));

app.use('/outputs', express.static(path.join(__dirname, 'outputs'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);
  }
}));
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.1.0' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

setInterval(() => {
  const dir = path.join(__dirname, 'outputs');
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  fs.readdirSync(dir).forEach(file => {
    try {
      const fp = path.join(dir, file);
      if (now - fs.statSync(fp).mtimeMs > 3600000) fs.unlinkSync(fp);
    } catch(e) {}
  });
}, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n🚀 All In One File Converter v1.1 running at http://localhost:${PORT}`);
  console.log(`✅ Routes: merge, split, compress, pdf2img, img2pdf, pdf2word, excel2pdf, pdf2excel, pdfeditor, signpdf\n`);
});
