/**
 * Regenerates the app icon set for the PWA: public/icons/icon.svg plus the PNGs
 * (favicon-size, 192 and 512 for the manifest, a maskable 512 for Android
 * launchers, and a 180 for iOS). Run with: npm run icons
 *
 * The mark is the app's own palette — a light 3x3 board with square corners on
 * the dark page background, one accent cell (the digit you just played) and two
 * empty cells, so it reads as a puzzle in progress. The geometry lives in one
 * place: the same rects feed the SVG and the PNGs, so the committed assets and
 * this script cannot drift apart.
 *
 * PNGs are written by hand (node:zlib + a CRC32) rather than pulled in from an
 * image library: the art is axis-aligned rectangles, so there is nothing to
 * antialias and no dependency to install.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

/* the app's palette, straight from public/style.css */
const COLORS = {
  bg: "#0f151d" /* --bg: the page behind the board */,
  cell: "#c2d1e1" /* the board's own light cells */,
  accent: "#f58742" /* --accent: the player colour */,
};

/** [column, row, fill] on a 3x3 board. The two holes read as unsolved cells. */
const BOARD = [
  ["0,0", "cell"],
  ["1,0", "cell"],
  ["2,0", "empty"],
  ["0,1", "cell"],
  ["1,1", "accent"],
  ["2,1", "cell"],
  ["0,2", "empty"],
  ["1,2", "cell"],
  ["2,2", "cell"],
];

/* Everything is laid out in a 512x512 design box. `board` is the 3x3 grid:
   cell size and gap, in design units. The safe variant keeps the whole mark
   inside the central 80% circle that Android launchers mask down to, so a
   maskable icon loses nothing to a circular or squircle crop. */
const DESIGN = 512;
const GRID = {
  full: { cell: 96, gap: 16 } /* 320 wide: the mark fills the icon */,
  safe: { cell: 78, gap: 13 } /* 260 wide: inside the maskable safe zone */,
  bold: { cell: 76, gap: 40 } /* 308 wide: gutters stay >= 2px at 32px */,
};

/** The 3x3 board, scaled to a given canvas size, as integer device rects. */
function rects(size, grid) {
  const span = grid.cell * 3 + grid.gap * 2;
  const origin = (DESIGN - span) / 2;
  const out = [];
  for (const [at, fill] of BOARD) {
    if (fill === "empty") continue;
    const [col, row] = at.split(",").map(Number);
    const x0 = origin + col * (grid.cell + grid.gap);
    const y0 = origin + row * (grid.cell + grid.gap);
    /* round on the device grid so small sizes stay crisp instead of blurring a
       half-pixel edge */
    const dx0 = Math.round((x0 / DESIGN) * size);
    const dy0 = Math.round((y0 / DESIGN) * size);
    const dx1 = Math.round(((x0 + grid.cell) / DESIGN) * size);
    const dy1 = Math.round(((y0 + grid.cell) / DESIGN) * size);
    out.push({ dx0, dy0, dx1, dy1, fill });
  }
  return out;
}

/* ------------------------------------------------------------------ svg ---- */

function svg(grid) {
  const span = grid.cell * 3 + grid.gap * 2;
  const origin = (DESIGN - span) / 2;
  /* at design scale the rounding is a no-op, so these are exact design units */
  const tiles = rects(DESIGN, grid).map(
    (r) =>
      `    <rect x="${r.dx0}" y="${r.dy0}" width="${r.dx1 - r.dx0}" height="${r.dy1 - r.dy0}" fill="${COLORS[r.fill]}"/>`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DESIGN} ${DESIGN}" width="${DESIGN}" height="${DESIGN}" role="img">`,
    `  <title>SudokuCoop</title>`,
    `  <rect width="${DESIGN}" height="${DESIGN}" fill="${COLORS.bg}"/>`,
    `  <g>${tiles.join("\n  ")}</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

/* ----------------------------------------------------------------- png ---- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++)
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
};

/* PNG is big-endian throughout, so write the 32-bit fields explicitly */
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
};

/**
 * A single-colour PNG of `size` pixels: background first, then each board tile
 * painted as a hard-edged rectangle (filter 0 = no prediction, which for flat
 * blocks of colour compresses to almost nothing).
 */
function png(size, grid) {
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const bg = hex(COLORS.bg);
  /* one row of RGB, then copy it around — the art is blocky, so rows repeat */
  const stride = size * 3;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < size; x++) {
      row[x * 3] = bg[0];
      row[x * 3 + 1] = bg[1];
      row[x * 3 + 2] = bg[2];
    }
    rows.push(row);
  }
  for (const r of rects(size, grid)) {
    const rgb = hex(COLORS[r.fill]);
    for (let y = r.dy0; y < r.dy1; y++) {
      const row = rows[y];
      for (let x = r.dx0; x < r.dx1; x++) {
        row[x * 3] = rgb[0];
        row[x * 3 + 1] = rgb[1];
        row[x * 3 + 2] = rgb[2];
      }
    }
  }
  const raw = Buffer.concat(
    rows.map((row) => Buffer.concat([Buffer.alloc(1), row])),
  );
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; /* bit depth */
  ihdr[9] = 2; /* truecolour RGB */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- output ---- */

const OUT = path.join(__dirname, "..", "public", "icons");
const FILES = [
  /* name, canvas size, grid, kind */
  ["icon.svg", DESIGN, GRID.full, "svg"],
  ["favicon.svg", DESIGN, GRID.full, "svg"],
  ["icon-32.png", 32, GRID.bold, "png"],
  ["icon-192.png", 192, GRID.full, "png"],
  ["icon-512.png", DESIGN, GRID.full, "png"],
  ["icon-maskable-512.png", DESIGN, GRID.safe, "png"],
  ["apple-touch-icon.png", 180, GRID.full, "png"],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, grid, kind] of FILES) {
  const bytes = kind === "svg" ? svg(grid) : png(size, grid);
  const file = path.join(OUT, name);
  fs.writeFileSync(file, bytes);
  const n = Buffer.byteLength(bytes);
  console.log(
    `  ${path.relative(path.join(__dirname, ".."), file)}  ${n} bytes`,
  );
}
