const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak } = require('docx');
const { v4: uuidv4 } = require('uuid');
const { uploadPdf, cleanupFiles, outputsDir } = require('./upload');

// ─────────────────────────────────────────────
//  Heuristics: detect headings from text lines
// ─────────────────────────────────────────────
function isLikelyHeading(line, avgLen) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.length > 120) return false;           // Too long to be a heading
  if (trimmed.length < 2) return false;
  if (trimmed.endsWith('.') && trimmed.split(' ').length > 6) return false; // Sentences end in period
  if (/^[A-Z0-9\s\-:,]{4,60}$/.test(trimmed)) return true;  // ALL CAPS line
  if (trimmed.length < avgLen * 0.6 && !trimmed.endsWith('.')) return true; // Shorter than avg
  return false;
}

function detectAlignment(line) {
  // Simple heuristic: short centered lines often have lots of leading spaces
  return AlignmentType.LEFT;
}

// ─────────────────────────────────────────────
//  Parse extracted text into structured blocks
// ─────────────────────────────────────────────
function buildDocxParagraphs(text) {
  const rawLines = text.split('\n');
  const paragraphs = [];

  // Compute average non-empty line length for heading detection
  const nonEmpty = rawLines.filter(l => l.trim().length > 0);
  const avgLen = nonEmpty.length
    ? nonEmpty.reduce((s, l) => s + l.trim().length, 0) / nonEmpty.length
    : 60;

  let buffer = [];

  const flushBuffer = () => {
    if (!buffer.length) return;
    const combined = buffer.join(' ').trim();
    if (combined) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: combined, size: 24 })],
          spacing: { after: 160 },
          alignment: AlignmentType.LEFT,
        })
      );
    }
    buffer = [];
  };

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // Blank line → flush buffer, paragraph break
    if (!trimmed) {
      flushBuffer();
      continue;
    }

    // Page break marker inserted by pdf-parse
    if (trimmed === '\f' || trimmed.startsWith('\x0c')) {
      flushBuffer();
      paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
      continue;
    }

    // Heading detection
    if (isLikelyHeading(trimmed, avgLen)) {
      flushBuffer();
      const isMainHeading = /^[A-Z0-9\s\-]{4,50}$/.test(trimmed) && trimmed.length < 50;
      paragraphs.push(
        new Paragraph({
          text: trimmed,
          heading: isMainHeading ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
        })
      );
      continue;
    }

    // Bullet / list detection
    if (/^[\u2022\u2023\u25E6\u2043\-\*]\s/.test(trimmed) || /^\d+[\.\)]\s/.test(trimmed)) {
      flushBuffer();
      const bulletText = trimmed.replace(/^[\u2022\u2023\u25E6\u2043\-\*]\s*/, '').replace(/^\d+[\.\)]\s*/, '');
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: bulletText, size: 24 })],
          bullet: { level: 0 },
          spacing: { after: 80 },
        })
      );
      continue;
    }

    // Check if line wraps (doesn't end with sentence-ending punctuation and next line continues)
    const endsAbruptly = !trimmed.match(/[.!?:;]$/) && i < rawLines.length - 1;
    if (endsAbruptly && rawLines[i + 1]?.trim()) {
      buffer.push(trimmed);
    } else {
      buffer.push(trimmed);
      flushBuffer();
    }
  }

  flushBuffer();
  return paragraphs;
}

// ─────────────────────────────────────────────
//  Route: POST /api/pdf2word
// ─────────────────────────────────────────────
router.post('/', uploadPdf.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    const originalName = req.file.originalname.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const buf = fs.readFileSync(req.file.path);

    // ── Step 1: Extract text with pdf-parse ──
    let pdfData;
    try {
      pdfData = await pdfParse(buf, {
        max: 0, // parse all pages
        // Custom page renderer to preserve some structure
        pagerender: async (pageData) => {
          const textContent = await pageData.getTextContent();
          let lastY = null;
          let text = '';
          for (const item of textContent.items) {
            if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
              text += '\n';
            }
            text += item.str;
            lastY = item.transform[5];
          }
          return text + '\n\f'; // form feed = page break marker
        }
      });
    } catch (parseErr) {
      return res.status(422).json({
        error: 'Could not extract text from this PDF. It may be scanned/image-based. ' + parseErr.message
      });
    }

    const extractedText = pdfData.text;
    const pageCount = pdfData.numpages;

    if (!extractedText || extractedText.trim().length < 10) {
      return res.status(422).json({
        error: 'No extractable text found. This PDF may be scanned or image-based. Try an OCR tool first.'
      });
    }

    // ── Step 2: Build DOCX document ──
    const bodyParagraphs = buildDocxParagraphs(extractedText);

    // Add a title paragraph at the top
    const titlePara = new Paragraph({
      text: originalName,
      heading: HeadingLevel.TITLE,
      spacing: { after: 400 },
    });

    const doc = new Document({
      title: originalName,
      description: `Converted from ${req.file.originalname} by All In One File Converter`,
      styles: {
        default: {
          document: {
            run: { font: 'Calibri', size: 24, color: '1a1a1a' },
            paragraph: { spacing: { line: 276 } }
          }
        }
      },
      sections: [
        {
          properties: {
            page: {
              margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } // 1 inch margins
            }
          },
          children: [titlePara, ...bodyParagraphs],
        }
      ]
    });

    // ── Step 3: Save DOCX ──
    const outName = `${originalName.slice(0, 40)}_${uuidv4().slice(0,8)}.docx`;
    const outPath = path.join(outputsDir, outName);
    const docBuffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outPath, docBuffer);

    // Auto-delete after 1 hour
    setTimeout(() => cleanupFiles(outPath), 3600000);

    res.json({
      success: true,
      filename: outName,
      downloadUrl: `/outputs/${outName}`,
      outputSize: docBuffer.length,
      pageCount,
      wordCount: extractedText.split(/\s+/).filter(Boolean).length,
      charCount: extractedText.length,
    });

  } catch (err) {
    console.error('PDF→Word error:', err);
    res.status(500).json({ error: 'Conversion failed: ' + err.message });
  } finally {
    cleanupFiles(uploadedPath);
  }
});

module.exports = router;
