const { cpSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const dest = join(__dirname, '..', 'public', 'pdf-assets');
mkdirSync(dest, { recursive: true });
for (const dir of ['standard_fonts', 'cmaps', 'wasm']) {
  cpSync(join(__dirname, '..', 'node_modules', 'pdfjs-dist', dir), join(dest, dir), { recursive: true });
}
