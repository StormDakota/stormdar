// Defaults and pure helpers for warning-polygon styling (kept free of React so they are easy to test).

export const WARNING_DEFAULTS = {
  'Tornado Warning': { on: true, color: '#dc2626', weight: 2.5, fill: 0.12 }, // radar indicated (the base level)
  'Observed Tornado': { on: true, color: '#ff0000', weight: 3.5, fill: 0.2 },
  'PDS Tornado (Particularly Dangerous Situation)': { on: true, color: '#7e22ce', weight: 4, fill: 0.25 },
  'Tornado Emergency': { on: true, color: '#d946ef', weight: 4.5, fill: 0.3 },
  'Severe Thunderstorm Warning': { on: true, color: '#eab308', weight: 2.5, fill: 0.12 },
  'Flash Flood Warning': { on: false, color: '#22c55e', weight: 2.5, fill: 0.12 },
};

const clamp = (n, lo, hi, fallback) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback);

// Merge whatever was saved in localStorage over the defaults, discarding anything malformed.
export function mergeSaved(saved) {
  const out = {};
  for (const [event, d] of Object.entries(WARNING_DEFAULTS)) {
    const s = (saved && saved[event]) || {};
    out[event] = {
      on: typeof s.on === 'boolean' ? s.on : d.on,
      color: typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : d.color,
      weight: clamp(Number(s.weight), 0.5, 8, d.weight),
      fill: clamp(Number(s.fill), 0, 1, d.fill),
    };
  }
  return out;
}

// Leaflet style function for the warning GeoJSON layer. Hidden types also stop catching clicks.
export const warningLayerStyle = (styles) => (feature) => {
  const s = styles[styleKey(feature.properties)];
  if (!s) return { color: '#9ca3af', weight: 2, opacity: 0.8, fillOpacity: 0.1 };
  return { stroke: s.on, fill: s.on, color: s.color, weight: s.weight, opacity: 0.9, fillColor: s.color, fillOpacity: s.fill };
};

// Card titles where the stored key would read oddly.
export const LABELS = { 'Tornado Warning': 'Tornado Warning (radar indicated)' };

// Which tornado level a Tornado Warning is, from the NWS alert parameters (text is the fallback).
export function tornadoTier(p) {
  const params = p.parameters || {};
  const first = (k) => String((params[k] && params[k][0]) || '').toUpperCase();
  const text = `${p.headline || ''} ${p.description || ''}`.toUpperCase();
  const damage = first('tornadoDamageThreat');
  if (damage === 'CATASTROPHIC' || text.includes('TORNADO EMERGENCY')) return 'Tornado Emergency';
  if (damage === 'CONSIDERABLE' || text.includes('PARTICULARLY DANGEROUS SITUATION')) return 'PDS Tornado (Particularly Dangerous Situation)';
  if (first('tornadoDetection') === 'OBSERVED' || /TORNADO\.\.\.OBSERVED/.test(text)) return 'Observed Tornado';
  return 'Tornado Warning';
}

// Key into the style table for a warning's properties.
export const styleKey = (p) => (p.event === 'Tornado Warning' ? tornadoTier(p) : p.event);

// Draw order: more severe levels on top.
const RANK = { 'Flash Flood Warning': 0, 'Severe Thunderstorm Warning': 1, 'Tornado Warning': 2, 'Observed Tornado': 3,
  'PDS Tornado (Particularly Dangerous Situation)': 4, 'Tornado Emergency': 5 };
export const tierRank = (key) => RANK[key] ?? 0;
