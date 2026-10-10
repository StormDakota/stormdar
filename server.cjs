'use strict';
/**
 * Local NEXRAD Level 3 proxy.
 *
 *   GET /api/radar/:station/:product                    latest scan (metadata + tile URL template)
 *   GET /api/radar/:station/:product/loop?count=6       last N scans, oldest first
 *   GET /api/tiles/:site/:code/:key/:z/:x/:y.png        map tile (?palette=Name picks a color table)
 *   GET /api/outlook/:day/:type   SPC convective outlook GeoJSON (day 1-3; cat|torn|wind|hail, day 3: cat|prob)
 *   GET /api/tropics/outlook        NHC 7-day tropical outlook: areas of disturbance (polygons, motion lines, locations)
 *   GET /api/tropics                 active hurricanes / tropical storms with NHC cone, track, points, watches
 *   GET /api/zones?z=county/TXC001,forecast/TXZ245   NWS zone shapes (cached) for county-based alerts
 *   GET /api/reports/lsr?hours=6      NWS Local Storm Reports (via Iowa Environmental Mesonet)
 *   GET /api/reports/spotter          Spotter Network reports (GRLevelX placefile; set SPOTTER_REPORTS_URL to override)
 *   GET /api/palettes   list color tables;  POST ?name=X (body = .pal text) adds one;  DELETE ?name=X removes one
 *     station  KTLX | TLX
 *     product  REF | VEL | CC | ZDR   or a literal code: N0Q N0B N0U N0G N0C N0X
 *              (N0V / N0W are treated as "velocity", see CHAINS below)
 *
 * Flow: list S3 -> newest file -> parse Level 3 binary -> resample polar bins onto a
 * Web-Mercator-aligned grid -> colorized PNG (data URL) + lat/lon bounds for L.imageOverlay.
 *
 * Needs Node 18+ (global fetch).  npm i pngjs seek-bzip
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const Bunzip = require('seek-bzip');

const PORT = Number(process.env.PORT) || 3001;
const BUCKET = 'https://unidata-nexrad-level3.s3.amazonaws.com';
const RAD = Math.PI / 180;
const EARTH_KM = 6371.0088;
const KM_PER_DEG = EARTH_KM * RAD;

/* ------------------------------------------------------------------ */
/* Product tables                                                      */
/* ------------------------------------------------------------------ */

// Only 8-bit digital products (radial packet 16) are supported.
const KIND = { N0B: 'REF', N0Q: 'REF', N0G: 'VEL', N0U: 'VEL', N0C: 'CC', N0X: 'ZDR' };

// Tried in order; first code with a recent file wins.
const CHAINS = { REF: ['N0B', 'N0Q'], VEL: ['N0G', 'N0U'], CC: ['N0C'], ZDR: ['N0X'] };
const ALIASES = {
  ...CHAINS,
  N0B: ['N0B'], N0Q: ['N0Q'], N0G: ['N0G'], N0U: ['N0U'], N0C: ['N0C'], N0X: ['N0X'],
  N0V: CHAINS.VEL, N0W: CHAINS.VEL, // legacy 16-level velocity: served from the 8-bit products
};

// Fallback decode constants if the product description block looks invalid:  value = (raw - offset) / scale
const FALLBACK = { REF: [2, 66], VEL: [2, 129], CC: [300, -60.5], ZDR: [16, 128] };

// Rough max range (km) per kind; only used to snap the bin size to 0.25/0.5/1/2 km.
const RANGE_GUESS = { REF: 460, VEL: 300, CC: 300, ZDR: 300 };

// Color stops: [value, [r,g,b,a]]
const COLORS = {
  REF: {
    units: 'dBZ', min: 5, interp: false,
    stops: [[5,[4,233,231,255]],[10,[1,159,244,255]],[15,[3,0,244,255]],[20,[2,253,2,255]],[25,[1,197,1,255]],
      [30,[0,142,0,255]],[35,[253,248,2,255]],[40,[229,188,0,255]],[45,[253,149,0,255]],[50,[253,0,0,255]],
      [55,[212,0,0,255]],[60,[188,0,0,255]],[65,[248,0,253,255]],[70,[152,84,198,255]],[75,[255,255,255,255]]],
  },
  VEL: {
    units: 'm/s (negative = toward radar)', min: -100, interp: true,
    stops: [[-35,[0,70,0,255]],[-20,[0,160,0,255]],[-10,[0,235,0,255]],[-1,[150,210,150,160]],
      [1,[210,150,150,160]],[10,[245,0,0,255]],[20,[170,0,0,255]],[35,[90,0,0,255]]],
  },
  CC: {
    units: 'correlation coefficient', min: 0.2, interp: true,
    stops: [[0.2,[90,0,130,255]],[0.5,[0,0,200,255]],[0.7,[0,160,220,255]],[0.8,[0,200,0,255]],
      [0.9,[240,240,0,255]],[0.96,[255,150,0,255]],[0.98,[255,0,0,255]],[1.0,[255,255,255,255]]],
  },
  ZDR: {
    units: 'dB', min: -8, interp: true,
    stops: [[-4,[0,0,140,255]],[-2,[0,120,220,255]],[0,[120,200,120,255]],[1,[240,240,0,255]],
      [2,[255,150,0,255]],[4,[255,0,0,255]],[6,[255,0,255,255]]],
  },
};

function colorAt(spec, v) {
  if (v < spec.min) return null;
  const st = spec.stops;
  if (v <= st[0][0]) return st[0][1];
  if (v >= st[st.length - 1][0]) return st[st.length - 1][1];
  let i = 0;
  while (i < st.length - 1 && st[i + 1][0] <= v) i++;
  if (!spec.interp) return st[i][1];
  const t = (v - st[i][0]) / (st[i + 1][0] - st[i][0]);
  return st[i][1].map((c, k) => Math.round(c + (st[i + 1][1][k] - c) * t));
}

/* ------------------------------------------------------------------ */
/* Color tables (palettes)                                             */
/* ------------------------------------------------------------------ */

// Extra built-in tables besides each kind's "Default" (the COLORS above).
const EXTRA = {
  REF: {
    Smooth: { units: 'dBZ', min: 5, interp: true,
      stops: [[5,[90,200,255,170]],[20,[0,200,60,255]],[35,[255,235,0,255]],[45,[255,140,0,255]],[55,[230,0,0,255]],[65,[255,0,255,255]],[75,[255,255,255,255]]] },
    Grayscale: { units: 'dBZ', min: 5, interp: true, stops: [[5,[70,70,70,200]],[75,[255,255,255,255]]] },
  },
  VEL: {
    Bright: { units: 'm/s (negative = toward radar)', min: -100, interp: true,
      stops: [[-30,[0,255,255,255]],[-15,[0,220,0,255]],[-1,[110,110,110,120]],[1,[110,110,110,120]],[15,[255,60,60,255]],[30,[255,255,0,255]]] },
  },
  CC: {
    'Debris focus': { units: 'correlation coefficient', min: 0.2, interp: true,
      stops: [[0.2,[255,0,255,255]],[0.6,[255,0,0,255]],[0.8,[255,160,0,255]],[0.9,[255,255,0,255]],[0.96,[90,90,90,120]],[1.0,[70,70,70,90]]] },
  },
  ZDR: {},
};

const PAL_DIR = path.join(__dirname, 'palettes'); // drop GRLevelX-style .pal files here
const PALETTES = { REF: new Map(), VEL: new Map(), CC: new Map(), ZDR: new Map() };
let paletteGen = 0; // bumped on every rebuild so cached lookup tables / tiles never go stale

const makeSpec = (kind, name, def, builtin) => ({
  id: `${kind}:${name}:${paletteGen}`, units: def.units, min: def.min, interp: def.interp, stops: def.stops, builtin,
  color: (v) => colorAt(def, v),
});

// Parses a GRLevelX / GR2Analyst-style .pal file (Product, Units, Color, Color4, SolidColor, SolidColor4).
function parsePal(text) {
  let product = '', units = '';
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.replace(/;.*$/, '').trim().match(/^([A-Za-z0-9]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const args = m[2].trim().split(/[\s,]+/).filter(Boolean);
    if (key === 'product') product = (args[0] || '').toUpperCase();
    else if (key === 'units') units = (args[0] || '').toUpperCase();
    else if (['color', 'color4', 'solidcolor', 'solidcolor4'].includes(key)) {
      const nums = args.map(Number);
      const w = key.endsWith('4') ? 4 : 3; // channels per color
      if (nums.length < 1 + w || nums.some((n) => !Number.isFinite(n))) continue;
      const rgba = (c) => [c[0], c[1], c[2], w === 4 ? c[3] : 255];
      entries.push({
        v: nums[0],
        c1: rgba(nums.slice(1, 1 + w)),
        c2: nums.length >= 1 + 2 * w ? rgba(nums.slice(1 + w, 1 + 2 * w)) : null,
        solid: key.startsWith('solid'),
      });
    }
  }
  const kind = { BR: 'REF', BV: 'VEL', SRV: 'VEL', SRM: 'VEL', CC: 'CC', DR: 'ZDR', ZDR: 'ZDR' }[product] ||
    { DBZ: 'REF', KTS: 'VEL', KT: 'VEL', MPH: 'VEL', MPS: 'VEL', 'M/S': 'VEL' }[units];
  if (!kind) throw new Error('Could not tell the product type. Add a line like "Product: BR", "BV", "CC" or "DR".');
  if (entries.length < 2) throw new Error('Need at least two Color lines.');
  const k = kind === 'VEL' ? { KTS: 0.514444, KT: 0.514444, MPH: 0.44704 }[units] || 1 : 1; // velocities are stored in m/s
  entries.forEach((e) => { e.v *= k; });
  entries.sort((x, y) => x.v - y.v);

  const min = entries[0].v, max = entries[entries.length - 1].v;
  const color = (v) => {
    if (v < min) return null;
    let i = entries.length - 1;
    if (v < max) { i = 0; while (entries[i + 1].v <= v) i++; }
    const e = entries[i], n = entries[i + 1];
    if (!n || e.solid) return e.c1;
    const end = e.c2 || n.c1;
    const t = (v - e.v) / (n.v - e.v);
    return e.c1.map((c, j) => Math.round(c + (end[j] - c) * t));
  };
  const stops = [];
  for (let j = 0; j < 24; j++) { // sampled copy, just for drawing the legend
    const v = min + ((max - min) * j) / 23;
    const c = color(v);
    if (c) stops.push([Number(v.toFixed(2)), c]);
  }
  return { kind, spec: { units: COLORS[kind].units, min, interp: true, stops, color } };
}

function rebuildPalettes() {
  paletteGen++;
  for (const kind of Object.keys(PALETTES)) {
    PALETTES[kind].clear();
    PALETTES[kind].set('Default', makeSpec(kind, 'Default', COLORS[kind], true));
    for (const [name, def] of Object.entries(EXTRA[kind])) PALETTES[kind].set(name, makeSpec(kind, name, def, true));
  }
  fs.mkdirSync(PAL_DIR, { recursive: true });
  for (const file of fs.readdirSync(PAL_DIR)) {
    if (!/\.pal$/i.test(file)) continue;
    try {
      const name = file.replace(/\.pal$/i, '');
      const { kind, spec } = parsePal(fs.readFileSync(path.join(PAL_DIR, file), 'utf8'));
      PALETTES[kind].set(name, { ...spec, id: `${kind}:${name}:${paletteGen}`, builtin: false });
    } catch (e) {
      console.warn(`Skipping palette ${file}: ${e.message}`);
    }
  }
}

function savePalette(rawName, text) {
  const name = rawName.replace(/\.pal$/i, '').replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 40) || 'custom';
  try { parsePal(text); } catch (e) { throw httpError(400, e.message); } // validate before saving
  fs.mkdirSync(PAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(PAL_DIR, `${name}.pal`), text);
  rebuildPalettes();
  return name;
}

const pickPalette = (kind, name) => PALETTES[kind].get(name) || PALETTES[kind].get('Default');

const listPalettes = () =>
  Object.fromEntries(Object.entries(PALETTES).map(([kind, m]) => [kind,
    [...m.entries()].map(([name, sp]) => ({ id: sp.id, name, units: sp.units, interp: sp.interp, builtin: sp.builtin, stops: sp.stops }))]));

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => (size > max ? reject(httpError(413, 'File too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function buildLut(spec, scale, offset, leading) {
  const lut = new Uint8Array(256 * 4); // transparent by default
  for (let raw = leading; raw < 256; raw++) {
    const c = spec.color((raw - offset) / scale);
    if (c) lut.set(c, raw * 4);
  }
  return lut;
}

rebuildPalettes();

/* ------------------------------------------------------------------ */
/* S3                                                                  */
/* ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

// Key layout: {SITE}_{PRODUCT}_{YYYY}_{MM}_{DD}_{HH}_{MM}_{SS}, e.g. TLX_N0B_2026_09_30_18_03_12
async function findRecentKeys(site, code, count) {
  let found = [];
  for (let h = 0; h < 6 && found.length < count; h++) { // walk back hour by hour
    const d = new Date(Date.now() - h * 3600e3);
    const prefix = `${site}_${code}_${d.getUTCFullYear()}_${pad2(d.getUTCMonth() + 1)}_${pad2(d.getUTCDate())}_${pad2(d.getUTCHours())}`;
    const res = await fetch(`${BUCKET}/?list-type=2&prefix=${prefix}`);
    if (!res.ok) throw httpError(502, `S3 listing failed (${res.status})`);
    const keys = [...(await res.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    found = [...keys.sort(), ...found]; // timestamps sort lexicographically; older hours go in front
  }
  return found.slice(-count); // oldest -> newest
}

async function fetchObject(key) {
  const res = await fetch(`${BUCKET}/${key}`);
  if (!res.ok) throw httpError(502, `S3 download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/* ------------------------------------------------------------------ */
/* Level 3 parser (ICD 2620001: message header + product description   */
/* block + symbology block, radial packet 16)                          */
/* ------------------------------------------------------------------ */

function parseLevel3(raw, kind) {
  // Find the message header regardless of WMO/AWIPS text header variants:
  // divider (-1) at byte 18, and the message code equals the PDB product code at byte 30.
  let m = -1;
  for (let i = 0; i < 120 && i + 120 < raw.length; i++) {
    const code = raw.readInt16BE(i);
    if (code > 0 && code < 300 && raw.readInt16BE(i + 18) === -1 && raw.readInt16BE(i + 30) === code) { m = i; break; }
  }
  if (m < 0) throw httpError(502, 'Level 3 message header not found');
  let msg = raw.subarray(m);

  // Symbology onward is bzip2-compressed in modern files (starts right after the 120-byte header+PDB).
  const bz = msg.indexOf('BZh', 100, 'latin1');
  if (bz >= 100 && bz < 200) {
    msg = Buffer.concat([msg.subarray(0, bz), Bunzip.decode(msg.subarray(bz))]);
  }

  const productCode = msg.readInt16BE(30);
  // Standard 8-bit decode: value = (raw - offset) / scale, raw 0 = below threshold, 1 = range folded.
  // The PDB halfwords at 60/64 are encoded differently across products (floats vs scaled ints), so the
  // known constants are always used; the PDB values are only reported for debugging (?meta=1).
  const [scale, offset] = FALLBACK[kind];
  const leading = 2;
  const pdbScale = msg.readFloatBE(60), pdbOffset = msg.readFloatBE(64);

  const site = {
    lat: msg.readInt32BE(20) / 1000,
    lon: msg.readInt32BE(24) / 1000,
    heightFt: msg.readInt16BE(28),
  };
  const info = {
    productCode,
    vcp: msg.readInt16BE(34),
    elevationDeg: msg.readInt16BE(58) / 10,
    scanTime: new Date((msg.readUInt16BE(40) - 1) * 86400e3 + msg.readUInt32BE(42) * 1000).toISOString(),
  };

  // Symbology block: 10-byte header, then layer (6-byte header), then packets.
  let symOff = msg.readInt32BE(108) * 2;
  const isSym = (o) => o > 0 && o + 10 < msg.length && msg.readInt16BE(o) === -1 && msg.readInt16BE(o + 2) === 1;
  if (!isSym(symOff)) { // offset unexpected: look for the symbology block header (-1, block ID 1)
    symOff = -1;
    for (let o = 100; o < Math.min(msg.length - 10, 400); o += 2) if (isSym(o)) { symOff = o; break; }
    if (symOff < 0) throw httpError(502, 'Symbology block not found');
  }
  let p = symOff + 16;
  const packet = msg.readUInt16BE(p);
  if (packet !== 16) {
    throw httpError(415, `Unsupported radial packet 0x${packet.toString(16)} (only 8-bit digital, packet 16)`);
  }
  const firstBin = msg.readUInt16BE(p + 2);
  const nBins = msg.readUInt16BE(p + 4);
  const nRad = msg.readUInt16BE(p + 12);
  p += 14;

  const data = new Uint8Array(nRad * nBins);
  const azLut = new Int16Array(3600).fill(-1); // 0.1-degree azimuth -> radial index
  for (let r = 0; r < nRad; r++) {
    const nBytes = msg.readUInt16BE(p);
    const start = msg.readUInt16BE(p + 2); // tenths of a degree
    const delta = Math.max(1, msg.readUInt16BE(p + 4));
    p += 6;
    if (p + nBytes > msg.length) throw httpError(502, 'Truncated radial data');
    data.set(msg.subarray(p, p + Math.min(nBytes, nBins)), r * nBins);
    p += nBytes + (nBytes & 1);
    for (let k = 0; k < delta; k++) azLut[(start + k) % 3600] = r;
  }

  // Snap bin size to a standard gate spacing using the expected max range for this kind.
  const guess = RANGE_GUESS[kind];
  const binKm = [0.25, 0.5, 1, 2].reduce((best, c) =>
    Math.abs(Math.log((c * nBins) / guess)) < Math.abs(Math.log((best * nBins) / guess)) ? c : best);

  return { site, info, data, azLut, nBins, nRad, firstBin, binKm, scale, offset, leading, pdbScale, pdbOffset };
}

/* ------------------------------------------------------------------ */
/* Polar -> Web Mercator rasterizer, run per map tile (sharp at any    */
/* zoom, limited only by the radar's own gate spacing)                 */
/* ------------------------------------------------------------------ */

const TILE = 256;

function geometry(parsed) {
  const { site, info, nBins, firstBin, binKm } = parsed;
  const groundKm = (firstBin + nBins) * binKm * Math.cos(info.elevationDeg * RAD);
  const dLat = groundKm / KM_PER_DEG;
  const dLon = groundKm / (KM_PER_DEG * Math.cos(site.lat * RAD));
  return { south: site.lat - dLat, north: site.lat + dLat, west: site.lon - dLon, east: site.lon + dLon, groundKm };
}

// phis[j] = latitude (radians) of pixel row j; lams[i] = longitude (radians) of pixel column i.
function rasterize(parsed, lut, phis, lams, out) {
  const { site, info, data, azLut, nBins, firstBin, binKm } = parsed;
  const cosE = Math.cos(info.elevationDeg * RAD);
  const phi0 = site.lat * RAD, lam0 = site.lon * RAD;
  const cosPhi0 = Math.cos(phi0), sinPhi0 = Math.sin(phi0);
  const W = lams.length, H = phis.length;
  const sHalf = new Float64Array(W), sD = new Float64Array(W), cD = new Float64Array(W);
  for (let i = 0; i < W; i++) {
    const d = lams[i] - lam0;
    sHalf[i] = Math.sin(d / 2); sD[i] = Math.sin(d); cD[i] = Math.cos(d);
  }
  for (let j = 0; j < H; j++) {
    const phi = phis[j], sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
    const sHP = Math.sin((phi - phi0) / 2);
    for (let i = 0; i < W; i++) {
      const a = sHP * sHP + cosPhi0 * cosPhi * sHalf[i] * sHalf[i]; // haversine
      const ground = 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
      const bin = Math.floor(ground / cosE / binKm) - firstBin;
      if (bin < 0 || bin >= nBins) continue;
      const brg = Math.atan2(sD[i] * cosPhi, cosPhi0 * sinPhi - sinPhi0 * cosPhi * cD[i]);
      const r = azLut[Math.floor((((brg / RAD) + 360) % 360) * 10) % 3600];
      if (r < 0) continue;
      const c = data[r * nBins + bin] * 4;
      if (lut[c + 3] === 0) continue;
      const o = (j * W + i) * 4;
      out[o] = lut[c]; out[o + 1] = lut[c + 1]; out[o + 2] = lut[c + 2]; out[o + 3] = lut[c + 3];
    }
  }
}

const tileLat = (n, fy) => Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / n))); // radians
let blank = null;
const blankPng = () => (blank ||= PNG.sync.write(new PNG({ width: TILE, height: TILE })));

function renderTile(parsed, spec, z, x, y) {
  const n = 2 ** z;
  const g = geometry(parsed);
  const tWest = (x / n) * 360 - 180, tEast = ((x + 1) / n) * 360 - 180;
  const tNorth = tileLat(n, y) / RAD, tSouth = tileLat(n, y + 1) / RAD;
  if (tEast < g.west || tWest > g.east || tNorth < g.south || tSouth > g.north) return blankPng();

  parsed.luts ||= {};
  const lut = (parsed.luts[spec.id] ||= buildLut(spec, parsed.scale, parsed.offset, parsed.leading));
  const phis = new Float64Array(TILE), lams = new Float64Array(TILE);
  for (let k = 0; k < TILE; k++) {
    phis[k] = tileLat(n, y + (k + 0.5) / TILE);
    lams[k] = (((x + (k + 0.5) / TILE) / n) * 360 - 180) * RAD;
  }
  const png = new PNG({ width: TILE, height: TILE });
  rasterize(parsed, lut, phis, lams, png.data);
  return PNG.sync.write(png);
}

/* ------------------------------------------------------------------ */
/* Orchestration + HTTP                                                */
/* ------------------------------------------------------------------ */

const parsedCache = new Map(); // object key -> Promise<parsed scan>
const tileCache = new Map();   // `${key}/${z}/${x}/${y}` -> PNG buffer

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// SPC convective outlooks (day 1-3). Fetched here so the browser never hits SPC directly (CORS).
const OUTLOOK_TYPES = { 1: ['cat', 'torn', 'wind', 'hail'], 2: ['cat', 'torn', 'wind', 'hail'], 3: ['cat', 'prob'] };
const outlookCache = new Map(); // "day:type" -> { at, body }

async function getOutlook(day, type) {
  if (!OUTLOOK_TYPES[day]?.includes(type)) throw httpError(400, 'Unknown outlook (days 1-3; cat, torn, wind, hail, or prob for day 3)');
  const k = `${day}:${type}`;
  const hit = outlookCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.body;
  const res = await fetch(`https://www.spc.noaa.gov/products/outlook/day${day}otlk_${type}.nolyr.geojson`, {
    headers: { 'User-Agent': 'stormdar-local (personal use)' },
  });
  if (!res.ok) throw httpError(502, `SPC returned ${res.status}`);
  const body = await res.text();
  try { JSON.parse(body); } catch { throw httpError(502, 'SPC returned something that was not JSON'); }
  outlookCache.set(k, { at: Date.now(), body });
  return body;
}

function getParsed(code, key) {
  if (!parsedCache.has(key)) {
    const p = fetchObject(key).then((buf) => parseLevel3(buf, KIND[code]));
    p.catch(() => parsedCache.delete(key)); // don't cache failures
    parsedCache.set(key, p);
    if (parsedCache.size > 30) parsedCache.delete(parsedCache.keys().next().value);
  }
  return parsedCache.get(key);
}

async function buildMeta(site, code, key) {
  const parsed = await getParsed(code, key);
  const kind = KIND[code];
  const def = PALETTES[kind].get('Default');
  parsed.stats ||= (() => {
    let minRaw = 255, maxRaw = 0, validBins = 0;
    for (const v of parsed.data) if (v >= 2) { validBins++; if (v < minRaw) minRaw = v; if (v > maxRaw) maxRaw = v; }
    return { radials: parsed.nRad, binsPerRadial: parsed.nBins, validBins, minRaw, maxRaw };
  })();
  const g = geometry(parsed);
  return {
    station: site,
    product: code,
    kind,
    objectKey: key,
    scanTime: parsed.info.scanTime,
    vcp: parsed.info.vcp,
    elevationDeg: parsed.info.elevationDeg,
    site: parsed.site,
    binKm: parsed.binKm,
    units: def.units,
    legend: def.stops,
    interp: def.interp,
    decode: { scale: parsed.scale, offset: parsed.offset, pdbScale: parsed.pdbScale, pdbOffset: parsed.pdbOffset },
    stats: parsed.stats,
    bounds: [[g.south, g.west], [g.north, g.east]], // Leaflet [[lat, lng], [lat, lng]]
    rangeKm: g.groundKm,
    tiles: `/api/tiles/${site}/${code}/${key}/{z}/{x}/{y}.png`, // Leaflet TileLayer template
  };
}

// Returns an array of scan descriptions (oldest -> newest); count = 1 gives just the latest scan.
async function getRadar(stationParam, productParam, count = 1) {
  const id = stationParam.toUpperCase();
  const site = id.length === 4 ? id.slice(1) : id; // KTLX -> TLX
  if (!/^[A-Z0-9]{3}$/.test(site)) throw httpError(400, 'Bad station id');
  const chain = ALIASES[productParam.toUpperCase()];
  if (!chain) throw httpError(400, `Unknown product. Use REF, VEL, CC, ZDR or ${Object.keys(KIND).join(', ')}`);

  for (const code of chain) {
    const keys = await findRecentKeys(site, code, count);
    if (keys.length) return Promise.all(keys.map((k) => buildMeta(site, code, k)));
  }
  throw httpError(404, `No recent ${productParam} files for ${site}`);
}

/* ------------------------------------------------------------------ */
/* Weather reports: NWS Local Storm Reports (IEM) + Spotter Network    */
/* ------------------------------------------------------------------ */

// First matching rule wins, so order matters (e.g. "EXTR WIND CHILL" must hit snow before wind).
const REPORT_RULES = [
  ['tornado', /TORNADO|FUNNEL|WALL CLOUD|WATER ?SPOUT/],
  ['marine', /MARINE|RIP CURRENT|SEICHE|SURF|TIDE|SURGE/],
  ['hail', /HAIL/],
  ['snow', /SNOW|SLEET|ICE|FREEZ|BLIZZARD|AVALANCHE|WIND CHILL|COLD|FROST/],
  ['wind', /WND|WIND|DOWNBURST|MICROBURST/],
  ['flood', /FLOOD|DEBRIS FLOW|LANDSLIDE|MUDSLIDE|DAM |LEVEE/],
  ['fire', /FIRE|SMOKE/],
  ['rain', /RAIN|FOG|DRIZZLE|MIST/],
];
const classify = (text) => {
  const t = String(text || '').toUpperCase();
  for (const [cat, re] of REPORT_RULES) if (re.test(t)) return cat;
  return 'other';
};

const reportCache = new Map(); // key -> { at, body }
async function cached(key, ttlMs, producer) {
  const hit = reportCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body;
  const body = await producer();
  reportCache.set(key, { at: Date.now(), body });
  return body;
}
const UA = { 'User-Agent': 'stormdar-local (personal use)' };

// NWS Local Storm Reports via the Iowa Environmental Mesonet GeoJSON service.
function getLsr(hoursParam) {
  const hours = Math.min(72, Math.max(1, Math.round(Number(hoursParam)) || 6));
  return cached(`lsr:${hours}`, 2 * 60e3, async () => {
    const res = await fetch(`https://mesonet.agron.iastate.edu/geojson/lsr.geojson?hours=${hours}`, { headers: UA });
    if (!res.ok) throw httpError(502, `IEM returned ${res.status}`);
    const gj = await res.json();
    const reports = (gj.features || [])
      .filter((f) => Array.isArray(f.geometry?.coordinates))
      .map((f, i) => {
        const p = f.properties || {};
        const type = p.typetext || p.type || '';
        return {
          id: `lsr-${i}-${p.valid || ''}`,
          lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
          time: p.valid || p.utc_valid || null,
          type, category: classify(type),
          magnitude: p.magnitude ?? p.mag ?? null, unit: p.unit ?? null,
          city: p.city || '', county: p.county || '', state: p.state || '',
          source: p.source || '', remark: p.remark || '', wfo: p.wfo || '',
        };
      });
    return { hours, reports };
  });
}

// Splits "a, b, "c, d", e" on commas that are outside double quotes.
function splitArgs(str) {
  const out = [];
  let cur = '', quoted = false;
  for (const ch of str) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Minimal GRLevelX placefile reader: Icon lines (optionally inside Object blocks) become reports.
function parsePlacefile(text) {
  const reports = [];
  let obj = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const args = splitArgs(m[2]);
    if (key === 'object') obj = { lat: Number(args[0]), lon: Number(args[1]) };
    else if (key === 'end') obj = null;
    else if (key === 'icon') {
      const lat = obj ? obj.lat : Number(args[0]);
      const lon = obj ? obj.lon : Number(args[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const hover = args.slice(5).join(', ').replace(/\\n/g, '\n').trim();
      const head = hover.split('\n')[0];
      let category = classify(head);
      if (category === 'other') category = classify(hover);
      reports.push({ id: `sn-${reports.length}`, lat, lon, time: null, type: head || 'Report', category, text: hover });
    }
  }
  return reports;
}

function getSpotterReports() {
  const feed = process.env.SPOTTER_REPORTS_URL || 'https://www.spotternetwork.org/feeds/reports.txt';
  return cached('spotter', 2 * 60e3, async () => {
    const res = await fetch(feed, { headers: UA });
    if (!res.ok) throw httpError(502, `Spotter Network feed returned ${res.status}`);
    const text = await res.text();
    const reports = parsePlacefile(text);
    const note = !reports.length && !/(^|\n)\s*(Icon|Object):/i.test(text) ? 'The feed had no recognizable report entries.' : '';
    return { reports, note };
  });
}

/* ------------------------------------------------------------------ */
/* NWS zone shapes, for alerts that are issued by county / zone         */
/* ------------------------------------------------------------------ */

const zoneCache = new Map(); // "county/TXC001" -> geometry | null
const roundCoords = (c) => (typeof c[0] === 'number' ? c.map((n) => Math.round(n * 1000) / 1000) : c.map(roundCoords)); // ~100 m, keeps payloads small

async function getZoneGeometry(zpath) {
  if (zoneCache.has(zpath)) return zoneCache.get(zpath);
  const res = await fetch(`https://api.weather.gov/zones/${zpath}`, { headers: { ...UA, Accept: 'application/geo+json' } });
  let geom = null;
  if (res.ok) {
    const g = (await res.json()).geometry;
    if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon')) geom = { type: g.type, coordinates: roundCoords(g.coordinates) };
  } else if (res.status !== 404) {
    throw httpError(502, `NWS zones returned ${res.status}`);
  }
  zoneCache.set(zpath, geom);
  if (zoneCache.size > 4000) zoneCache.delete(zoneCache.keys().next().value);
  return geom;
}

// Zones that fail are left out of the reply so the browser retries them later.
async function getZones(list) {
  const paths = [...new Set(list)].filter((p) => /^[a-z]+\/[A-Z0-9]{5,7}$/.test(p)).slice(0, 150);
  const geometries = {};
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const p = paths[next++];
      try { geometries[p] = await getZoneGeometry(p); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { geometries };
}

/* ------------------------------------------------------------------ */
/* Hurricanes: NHC active storms + their forecast / past track layers  */
/* ------------------------------------------------------------------ */

const NHC_STORMS = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const TROPICAL_SVC = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
// Layer names in the NHC service are "<bin> <suffix>", e.g. "AT1 Forecast Cone" (AT = Atlantic, EP = East Pacific, CP = Central Pacific).
const STORM_LAYERS = { cone: 'Forecast Cone', track: 'Forecast Track', points: 'Forecast Points', past: 'Past Track', pastPoints: 'Past Points', warnings: 'Watch-Warning' };
const emptyFc = () => ({ type: 'FeatureCollection', features: [] });
const lowerKeys = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));

function numOrNull(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
// Accepts a plain number or text like "25.1N" / "80.2W" (S and W are negative).
function coordOf(numeric, text) {
  if (numeric != null && numeric !== '' && Number.isFinite(Number(numeric))) return Number(numeric);
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([NSEW])?/i.exec(String(text || ''));
  if (!m) return null;
  const x = parseFloat(m[1]);
  return m[2] && /[SW]/i.test(m[2]) ? -Math.abs(x) : x;
}

function getTropicsLayerList() {
  return cached('tropics-layer-list', 6 * 3600e3, async () => {
    const res = await fetch(`${TROPICAL_SVC}?f=json`, { headers: UA });
    if (!res.ok) throw httpError(502, `NHC map service returned ${res.status}`);
    return ((await res.json()).layers || []).map((l) => ({ id: l.id, name: l.name, type: l.type, geometryType: l.geometryType || '' }));
  });
}
async function getTropicsLayerIds() {
  return Object.fromEntries((await getTropicsLayerList()).map((l) => [l.name, l.id]));
}

async function queryTropicalLayer(id) {
  const res = await fetch(`${TROPICAL_SVC}/${id}/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=4`, { headers: UA });
  if (!res.ok) throw httpError(502, `NHC layer returned ${res.status}`);
  const j = await res.json();
  return {
    type: 'FeatureCollection',
    features: (j.features || []).filter((f) => f.geometry).map((f) => ({ type: 'Feature', geometry: f.geometry, properties: lowerKeys(f.properties) })),
  };
}

// NHC's Graphical Tropical Weather Outlook: areas where a storm may form in the next 7 days (the "areas of disturbance").
// Matched by geometry so a renamed layer still works: polygons = areas, lines = expected motion, points = current locations.
function getOutlookAreas() {
  return cached('tropics-outlook', 10 * 60e3, async () => {
    const list = (await getTropicsLayerList()).filter((l) => l.type === 'Feature Layer' && /seven[- ]day/i.test(l.name));
    const pick = (geo) => list.find((l) => l.geometryType === geo);
    const run = async (l) => { try { return l ? await queryTropicalLayer(l.id) : emptyFc(); } catch { return emptyFc(); } };
    const [areas, motion, points] = await Promise.all([run(pick('esriGeometryPolygon')), run(pick('esriGeometryPolyline')), run(pick('esriGeometryPoint'))]);
    return { areas, motion, points, updated: new Date().toISOString() };
  });
}

function getTropics() {
  return cached('tropics', 10 * 60e3, async () => {
    const res = await fetch(NHC_STORMS, { headers: UA });
    if (!res.ok) throw httpError(502, `NHC returned ${res.status}`);
    const active = (await res.json()).activeStorms;
    const list = Array.isArray(active) ? active : [];
    const ids = list.length ? await getTropicsLayerIds() : {};

    const storms = await Promise.all(list.map(async (s) => {
      const bin = String(s.binNumber || '').toUpperCase();
      const layers = {};
      await Promise.all(Object.entries(STORM_LAYERS).map(async ([key, suffix]) => {
        const id = ids[`${bin} ${suffix}`];
        try { layers[key] = id == null ? emptyFc() : await queryTropicalLayer(id); } catch { layers[key] = emptyFc(); }
      }));
      return {
        id: s.id, name: s.name || '', bin, classification: s.classification || '',
        intensityKt: numOrNull(s.intensity), pressureMb: numOrNull(s.pressure),
        lat: coordOf(s.latitudeNumeric, s.latitude), lon: coordOf(s.longitudeNumeric, s.longitude),
        movementDir: numOrNull(s.movementDir), movementSpeedMph: numOrNull(s.movementSpeed),
        updated: s.lastUpdate || null,
        advisoryUrl: (s.publicAdvisory && s.publicAdvisory.url) || null,
        layers,
      };
    }));
    return { storms, updated: new Date().toISOString() };
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // local dev only
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const url = new URL(req.url, 'http://localhost');

    const t = url.pathname.match(/^\/api\/tiles\/([A-Z0-9]{3})\/(N0[A-Z])\/([A-Za-z0-9_]+)\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (t) {
      const [, site, code, key] = t;
      const [z, x, y] = t.slice(4).map(Number);
      const n = 2 ** z;
      const okKey = /^[A-Z0-9]{3}_N0[A-Z]_\d{4}(_\d{2}){5}$/.test(key) && key.startsWith(`${site}_${code}_`);
      if (!KIND[code] || !okKey || z > 20 || x >= n || y >= n) return send(400, { error: 'Bad tile request' });
      const spec = pickPalette(KIND[code], url.searchParams.get('palette'));
      const tk = `${spec.id}/${key}/${z}/${x}/${y}`;
      let png = tileCache.get(tk);
      if (!png) {
        png = renderTile(await getParsed(code, key), spec, z, x, y);
        tileCache.set(tk, png);
        if (tileCache.size > 3000) tileCache.delete(tileCache.keys().next().value);
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      return res.end(png);
    }

    if (url.pathname === '/api/palettes') {
      if (req.method === 'DELETE') { // remove a custom table
        const name = (url.searchParams.get('name') || '').replace(/[^A-Za-z0-9 _.-]/g, '');
        const file = path.join(PAL_DIR, `${name}.pal`);
        if (!name || !fs.existsSync(file)) return send(404, { error: 'No such custom color table' });
        fs.unlinkSync(file);
        rebuildPalettes();
        return send(200, { palettes: listPalettes() });
      }
      if (req.method === 'POST') { // import a .pal file
        const saved = savePalette(url.searchParams.get('name') || 'custom', await readBody(req, 200000));
        return send(200, { saved, palettes: listPalettes() });
      }
      return send(200, listPalettes());
    }

    const o = url.pathname.match(/^\/api\/outlook\/(\d)\/([a-z]+)$/);
    if (o) {
      const body = await getOutlook(Number(o[1]), o[2]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    }

    if (url.pathname === '/api/tropics/outlook') return send(200, await getOutlookAreas());
    if (url.pathname === '/api/tropics') return send(200, await getTropics());
    if (url.pathname === '/api/zones') return send(200, await getZones((url.searchParams.get('z') || '').split(',')));
    if (url.pathname === '/api/reports/lsr') return send(200, await getLsr(url.searchParams.get('hours')));
    if (url.pathname === '/api/reports/spotter') return send(200, await getSpotterReports());

    const m = url.pathname.match(/^\/api\/radar\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)(\/loop)?$/);
    if (!m) return send(404, { error: 'Use /api/radar/:station/:product[/loop?count=6]' });
    if (m[3]) {
      const count = Math.min(12, Math.max(2, parseInt(url.searchParams.get('count') || '6', 10) || 6));
      return send(200, { frames: await getRadar(m[1], m[2], count) });
    }
    send(200, (await getRadar(m[1], m[2]))[0]);
  } catch (e) {
    console.error(e);
    send(e.status || 500, { error: e.message });
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`NEXRAD proxy on http://localhost:${PORT}`));
else module.exports = { getOutlookAreas, getTropics, getZones, classify, parsePlacefile, rasterize, renderTile, geometry, buildLut, parsePal, pickPalette, listPalettes, savePalette };
