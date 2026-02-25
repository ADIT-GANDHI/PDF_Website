const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const uploadsDir = path.join(__dirname, '..', 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const pdfFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') cb(null, true);
  else cb(new Error('Only PDF files are allowed'), false);
};

const imageFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Only image files are allowed'), false);
};

const excelMimes = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'text/csv',
  'application/octet-stream',
];
const excelFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const ok = excelMimes.includes(file.mimetype) || ['.xlsx','.xls','.xlsm','.csv'].includes(ext);
  if (ok) cb(null, true);
  else cb(new Error('Only Excel (.xlsx, .xls, .xlsm) or CSV files are allowed'), false);
};

const anyFilter = (req, file, cb) => cb(null, true);

module.exports = {
  uploadPdf:      multer({ storage, fileFilter: pdfFilter,   limits: { fileSize: 100 * 1024 * 1024 } }),
  uploadMultiPdf: multer({ storage, fileFilter: pdfFilter,   limits: { fileSize: 500 * 1024 * 1024 } }),
  uploadImages:   multer({ storage, fileFilter: imageFilter,  limits: { fileSize: 100 * 1024 * 1024 } }),
  uploadExcel:    multer({ storage, fileFilter: excelFilter,  limits: { fileSize: 100 * 1024 * 1024 } }),
  uploadsDir,
  outputsDir: path.join(__dirname, '..', 'outputs'),
  cleanupFiles: (...filePaths) => {
    filePaths.forEach(fp => { try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch(e) {} });
  }
};
