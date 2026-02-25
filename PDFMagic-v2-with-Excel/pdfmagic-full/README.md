# PDFMagic — Full-Stack PDF Tools with Node.js Backend

A complete PDF tools web app with a real Express.js backend.

## Features
| Tool | Backend | Method |
|------|---------|--------|
| 🔀 Merge PDF | ✅ Server | pdf-lib |
| ✂️ Split PDF | ✅ Server | pdf-lib + archiver |
| 🗜️ Compress PDF | ✅ Server | pdf-lib |
| 🖼️ PDF → Images | 🌐 Client | PDF.js canvas |
| 📷 Images → PDF | ✅ Server | pdf-lib |
| 📝 **PDF → Word** | ✅ **Server** | pdf-parse + docx |

## Quick Start

### 1. Install Node.js
Download from https://nodejs.org (v16+ required)

### 2. Install dependencies
```bash
cd pdfmagic
npm install
```

### 3. Start the server
```bash
npm start
```

### 4. Open in browser
```
http://localhost:3000
```

---

## Project Structure
```
pdfmagic/
├── server.js              ← Main Express server (port 3000)
├── package.json           ← Dependencies
├── routes/
│   ├── upload.js          ← Shared multer config
│   ├── merge.js           ← POST /api/merge
│   ├── split.js           ← POST /api/split
│   ├── compress.js        ← POST /api/compress
│   ├── pdf2img.js         ← POST /api/pdf2img/info + /zip
│   ├── img2pdf.js         ← POST /api/img2pdf
│   └── pdf2word.js        ← POST /api/pdf2word  ⭐ NEW
├── public/
│   └── index.html         ← Full frontend (served by Express)
├── uploads/               ← Temp upload dir (auto-cleaned)
└── outputs/               ← Generated files (auto-deleted after 1hr)
```

---

## API Reference

### POST /api/merge
Upload multiple PDFs, get one merged PDF.
- **Body (multipart):** `files[]` — 2–20 PDF files
- **Response:** `{ downloadUrl, outputSize, pagesMerged }`

### POST /api/split
Split a PDF by various modes.
- **Body:** `file`, `mode` (all|range|every), `range`, `everyN`
- **Response:** `{ files[], zipUrl? }`

### POST /api/compress
Compress a PDF with object stream optimization.
- **Body:** `file`, `level` (1–3)
- **Response:** `{ downloadUrl, originalSize, outputSize, savedPercent }`

### POST /api/img2pdf
Convert images to a PDF document.
- **Body:** `files[]`, `pageSize` (A4|Letter|fit), `orientation`, `margin`
- **Response:** `{ downloadUrl, pageCount, outputSize }`

### POST /api/pdf2word ⭐
Convert a PDF to a Word (.docx) document.
- **Body:** `file` (PDF)
- **Response:** `{ downloadUrl, pageCount, wordCount, outputSize }`
- **Notes:** Works best with text-based PDFs. Scanned PDFs require OCR first.

---

## PDF → Word: How It Works

1. **Upload** — PDF uploaded via multer to `./uploads/`
2. **Parse** — `pdf-parse` extracts raw text with a custom page renderer that preserves line breaks
3. **Structure detection** — Heuristic analysis detects:
   - Headings (ALL CAPS lines, short lines, no trailing period)
   - Bullet lists (•, -, *, numbered)
   - Page breaks (form feed characters)
   - Wrapped paragraphs (joins lines that belong together)
4. **Build DOCX** — `docx` library assembles a structured Word document with:
   - Proper heading styles (H1, H2)
   - Calibri 12pt body font
   - 1-inch page margins
   - Line spacing and paragraph spacing
5. **Download** — File saved to `./outputs/` and returned as download URL

### Limitations
- **Scanned/image PDFs** → No text to extract (needs OCR)
- **Multi-column layouts** → Text order may be incorrect
- **Tables** → Converted to plain text rows
- **Complex formatting** → Font sizes, colors, images not preserved
- **Encrypted PDFs** → May fail if password-protected

---

## Security & Privacy
- Files are stored in `./uploads/` only during processing, then immediately deleted
- Output files in `./outputs/` are auto-deleted after **1 hour**
- No files are stored permanently
- No external API calls — all processing is local
- Add authentication middleware for production use

## Production Deployment
```bash
# Use PM2 for production
npm install -g pm2
pm2 start server.js --name pdfmagic
pm2 save

# With environment variables
PORT=8080 pm2 start server.js
```

## Dependencies
```
express       Web server
multer        File upload handling
cors          Cross-origin requests
pdf-lib       PDF manipulation (merge/split/compress/img2pdf)
pdf-parse     Text extraction from PDFs
docx          Generate .docx Word files
archiver      ZIP file creation for split outputs
uuid          Unique filenames
morgan        HTTP request logging
```
