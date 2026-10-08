// Genererar PNG-ikoner utan beroenden
import zlib from 'zlib';
import fs from 'fs';

const crcT = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]);
};

function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 4;
      const u = x / size, v = y / size;
      let rgb = [15, 23, 42];
      if ((u > 0.18 && u < 0.42 && v > 0.3 && v < 0.7) || (u > 0.58 && u < 0.82 && v > 0.3 && v < 0.7)) rgb = [56, 189, 248];
      if (Math.abs(v - 0.5) < 0.07 && u > 0.38 && u < 0.62) rgb = [52, 211, 153];
      raw[i] = rgb[0]; raw[i + 1] = rgb[1]; raw[i + 2] = rgb[2]; raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [180, 192, 512]) fs.writeFileSync(`docs/icon-${s}.png`, png(s));
console.log('Ikoner skapade');
