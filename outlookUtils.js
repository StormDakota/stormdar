// Helpers for SPC convective outlook GeoJSON (plain JS so they are easy to test).

const FALLBACK = {
  TSTM: ['#c1e9c1', '#55bb55'], MRGL: ['#7fc57f', '#005500'], SLGT: ['#f6f67f', '#ddaa00'],
  ENH: ['#e6c27f', '#ff9900'], MDT: ['#e67f7f', '#cc0000'], HIGH: ['#ff7fff', '#ff00ff'],
};

// Uses the colors SPC ships in the file (fill / stroke); falls back to the standard category colors.
export const outlookStyle = (f) => {
  const p = f.properties || {};
  const fb = FALLBACK[p.LABEL] || ['#999999', '#666666'];
  return { color: p.stroke || fb[1], weight: 2, opacity: 0.9, fillColor: p.fill || fb[0], fillOpacity: 0.45 };
};

// SPC times look like 202609301200 (UTC).
export const parseSpcTime = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s ?? ''));
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : null;
};

// One legend entry per distinct label in the loaded file, lowest risk first.
export function buildLegend(data) {
  const seen = new Map();
  for (const f of data?.features || []) {
    const p = f.properties || {};
    const label = p.LABEL2 || p.LABEL;
    if (!label || seen.has(label)) continue;
    seen.set(label, { label, fill: p.fill || (FALLBACK[p.LABEL] || [])[0] || '#999999', dn: Number(p.DN) || 0 });
  }
  return [...seen.values()].sort((a, b) => a.dn - b.dn);
}

const inRing = (pt, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolygon = (pt, rings) => inRing(pt, rings[0]) && !rings.slice(1).some((r) => inRing(pt, r)); // rings[1..] are holes

// Highest-category feature containing { lat, lon }, or null.
export function riskAt(data, loc) {
  if (!data || !loc) return null;
  const pt = [loc.lon, loc.lat];
  let best = null;
  for (const f of data.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (polys.some((poly) => inPolygon(pt, poly))) {
      const dn = Number(f.properties?.DN) || 0;
      if (!best || dn > best.dn) best = { dn, label: f.properties?.LABEL2 || f.properties?.LABEL || 'Outlooked' };
    }
  }
  return best;
}
