# PDFMagic — Complete Source Code

## Two versions included:

---

## ✅ Version 1: Browser-Only (RECOMMENDED — Works Immediately)
**File:** `index.html`

Open this single file in any browser. No installation, no server, no npm needed.

### Features (all working):
- 🔀 Merge PDF — combine multiple PDFs
- ✂️ Split PDF — extract pages by range or all
- 🗜️ Compress PDF — reduce file size
- 🖼️ PDF → Images — render pages as JPG/PNG
- 📷 Images → PDF — bundle images into PDF
- 📝 PDF → Word — extract text as .docx
- 📊 Excel → PDF — spreadsheet to PDF table
- 🔢 PDF → Excel — extract tables to .xlsx

### Libraries used (loaded from CDN):
- pdf-lib 1.17.1 — PDF manipulation
- PDF.js 3.11.174 — PDF rendering & text extraction
- SheetJS (xlsx) 0.18.5 — Excel read/write

### How to use:
1. Download `index.html`
2. Open in Chrome, Firefox, Edge or Safari
3. That's it — all processing happens in your browser

---

## 🖥️ Version 2: Node.js Backend
**File:** `PDFMagic-v2-with-Excel.zip`

Full Express.js server with REST API endpoints.

### Setup:
```bash
unzip PDFMagic-v2-with-Excel.zip
cd pdfmagic-full
npm install
npm start
# Open http://localhost:3000
```

### API Endpoints:
- POST /api/merge       — Merge PDFs
- POST /api/split       — Split PDF
- POST /api/compress    — Compress PDF
- POST /api/pdf2img     — PDF to images
- POST /api/img2pdf     — Images to PDF
- POST /api/pdf2word    — PDF to Word
- POST /api/excel2pdf   — Excel to PDF
- POST /api/pdf2excel   — PDF to Excel

### Node.js Dependencies:
- express, multer, cors, morgan
- pdf-lib, pdf-parse, docx, exceljs, archiver, uuid

---

## Privacy
Both versions: files never uploaded to any third-party server.
- Browser version: 100% local, files stay on your device
- Node version: files processed on your own server, auto-deleted after 1 hour
