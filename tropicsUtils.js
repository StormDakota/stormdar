// Small pure helpers for tropical cyclone data (kept free of React so they are easy to test).

export const mph = (kt) => (kt == null ? null : Math.round(kt * 1.15078));

// Saffir-Simpson from sustained wind in knots: 'TD' | 'TS' | 1-5
export function ssCategory(kt) {
  if (kt == null || Number.isNaN(kt)) return null;
  if (kt < 34) return 'TD';
  if (kt < 64) return 'TS';
  if (kt < 83) return 1;
  if (kt < 96) return 2;
  if (kt < 113) return 3;
  if (kt < 137) return 4;
  return 5;
}

const SS_COLORS = { TD: '#5ebaff', TS: '#00faf4', 1: '#ffffcc', 2: '#ffe775', 3: '#ffc140', 4: '#ff8f20', 5: '#ff6060' };
export const ssColor = (kt) => SS_COLORS[ssCategory(kt)] || '#9ca3af';
export const SS_LEGEND = [['TD', 'Depression'], ['TS', 'Tropical storm'], [1, 'Cat 1'], [2, 'Cat 2'], [3, 'Cat 3'], [4, 'Cat 4'], [5, 'Cat 5']]
  .map(([k, label]) => ({ label, color: SS_COLORS[k] }));

export function stormLabel(classification, kt) {
  const c = String(classification || '').toUpperCase();
  if (c === 'HU' || c === 'MH') {
    const cat = ssCategory(kt);
    return typeof cat === 'number' ? `Category ${cat} Hurricane` : 'Hurricane';
  }
  return { TD: 'Tropical Depression', TS: 'Tropical Storm', STS: 'Subtropical Storm', SD: 'Subtropical Depression',
    PTC: 'Post-tropical Cyclone', PC: 'Potential Tropical Cyclone', EX: 'Extratropical Cyclone' }[c] || 'Tropical Cyclone';
}

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const dirName = (deg) => (deg == null || Number.isNaN(deg) ? '' : DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]);

// Watch/warning line color. NHC codes: HWR hurricane warning, HWA hurricane watch, TWR tropical storm warning, TWA tropical storm watch.
export function wwColor(props) {
  const text = Object.values(props || {}).filter((v) => typeof v === 'string').join(' | ');
  const code = (/(?:^|\W)(HWR|HWA|TWR|TWA)(?:\W|$)/i.exec(text) || [])[1];
  const by = { HWR: '#ef4444', HWA: '#ff00ff', TWR: '#3b82f6', TWA: '#facc15' };
  if (code) return by[code.toUpperCase()];
  if (/hurricane warning/i.test(text)) return by.HWR;
  if (/hurricane watch/i.test(text)) return by.HWA;
  if (/tropical storm warning/i.test(text)) return by.TWR;
  if (/tropical storm watch/i.test(text)) return by.TWA;
  return '#b524f7';
}

export const hasFeatures = (fc) => !!(fc && fc.features && fc.features.length);

/* ---------- areas of disturbance (NHC Graphical Tropical Weather Outlook) ---------- */

export const RISK_COLORS = { low: '#ffd400', medium: '#ff8c00', high: '#ff1a1a' };
export const RISK_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };

// 'low' under 40%, 'medium' 40-60%, 'high' over 60%. Uses NHC's own risk text, else the percentage. by = '2day' | '7day'.
export function riskLevel(props, by = '7day') {
  const p = props || {};
  const risk = String(p[by === '2day' ? 'risk2day' : 'risk7day'] ?? '').toLowerCase();
  if (risk.includes('high')) return 'high';
  if (risk.includes('med')) return 'medium';
  if (risk.includes('low')) return 'low';
  const pct = parseInt(p[by === '2day' ? 'prob2day' : 'prob7day'], 10);
  if (Number.isFinite(pct)) return pct > 60 ? 'high' : pct >= 40 ? 'medium' : 'low';
  return 'low';
}

// Compass bearing (degrees) from a to b, both [lon, lat].
export function bearingDeg(a, b) {
  const r = Math.PI / 180;
  const dLon = (b[0] - a[0]) * r;
  const y = Math.sin(dLon) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos(dLon);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

// The last two points of a (multi)line, for drawing an arrowhead.
export function lastSegment(geometry) {
  if (!geometry) return null;
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
  const line = lines[lines.length - 1];
  return line && line.length >= 2 ? [line[line.length - 2], line[line.length - 1]] : null;
}

export const disturbanceName = (p) => [p.basin, p.area != null && p.area !== '' ? `Area ${p.area}` : ''].filter(Boolean).join(' ') || 'Disturbance';
