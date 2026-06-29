const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');

async function generate() {
  let svgData = fs.readFileSync('public/logo.svg', 'utf8');
  svgData = svgData.replace('<svg ', '<svg width="200" height="220" ');
  const svgBuffer = Buffer.from(svgData);
  const dataUrl = 'data:image/svg+xml;base64,' + svgBuffer.toString('base64');
  const img = await loadImage(dataUrl);

  for (const size of [192, 512]) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0e1a33';
    ctx.fillRect(0, 0, size, size);
    const padding = size * 0.1;
    const drawSize = size - padding * 2;
    const scale = Math.min(drawSize / img.width, drawSize / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    fs.writeFileSync(`public/icon-${size}.png`, canvas.toBuffer('image/png'));
    console.log(`Generated icon-${size}.png`);
  }

  // Maskable icon (larger safe zone padding)
  const canvas = createCanvas(512, 512);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0e1a33';
  ctx.fillRect(0, 0, 512, 512);
  const padding = 512 * 0.2;
  const drawSize = 512 - padding * 2;
  const scale = Math.min(drawSize / img.width, drawSize / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (512 - w) / 2, (512 - h) / 2, w, h);
  fs.writeFileSync('public/icon-maskable-512.png', canvas.toBuffer('image/png'));
  console.log('Generated icon-maskable-512.png');
}

generate().catch(err => { console.error(err); process.exit(1); });
