// Pure helpers for NWS alerts: categories, kinds, default styles, normalizing and drawing. No React in here.

export const CATEGORIES = ['General', 'Severe', 'Winter', 'Hydro', 'Wind/Air', 'Fire/Heat', 'Tropical', 'Marine', 'Other'];
export const KINDS = [['warning', 'Warnings'], ['watch', 'Watches'], ['advisory', 'Advisories'], ['statement', 'Statements']];

export const TORNADO_TIERS = ['Observed Tornado', 'PDS Tornado (Particularly Dangerous Situation)', 'Tornado Emergency'];
export const LABELS = { 'Tornado Warning': 'Tornado Warning (radar indicated)' };

// Standard NWS event names, so every type can be switched on or off before it ever appears.
const NAMES = ('911 Telephone Outage Emergency|Administrative Message|Air Quality Alert|Air Stagnation Advisory|Arroyo And Small Stream Flood Advisory|' +
  'Ashfall Advisory|Ashfall Warning|Avalanche Advisory|Avalanche Warning|Avalanche Watch|Beach Hazards Statement|Blizzard Warning|Blizzard Watch|' +
  'Blowing Dust Advisory|Blowing Dust Warning|Brisk Wind Advisory|Child Abduction Emergency|Civil Danger Warning|Civil Emergency Message|' +
  'Coastal Flood Advisory|Coastal Flood Statement|Coastal Flood Warning|Coastal Flood Watch|Dense Fog Advisory|Dense Smoke Advisory|Dust Advisory|' +
  'Dust Storm Warning|Earthquake Warning|Evacuation - Immediate|Excessive Heat Warning|Excessive Heat Watch|Extreme Cold Warning|Extreme Cold Watch|' +
  'Extreme Fire Danger|Extreme Heat Warning|Extreme Heat Watch|Extreme Wind Warning|Fire Warning|Fire Weather Watch|Flash Flood Statement|' +
  'Flash Flood Warning|Flash Flood Watch|Flood Advisory|Flood Statement|Flood Warning|Flood Watch|Freeze Warning|Freeze Watch|Freezing Fog Advisory|' +
  'Freezing Rain Advisory|Freezing Spray Advisory|Frost Advisory|Gale Warning|Gale Watch|Hard Freeze Warning|Hard Freeze Watch|' +
  'Hazardous Materials Warning|Hazardous Seas Warning|Hazardous Seas Watch|Hazardous Weather Outlook|Heat Advisory|Heavy Freezing Spray Warning|' +
  'Heavy Freezing Spray Watch|High Surf Advisory|High Surf Warning|High Wind Warning|High Wind Watch|Hurricane Force Wind Warning|' +
  'Hurricane Force Wind Watch|Hurricane Local Statement|Hurricane Warning|Hurricane Watch|Hydrologic Advisory|Hydrologic Outlook|Ice Storm Warning|' +
  'Lake Effect Snow Advisory|Lake Effect Snow Warning|Lake Effect Snow Watch|Lake Wind Advisory|Lakeshore Flood Advisory|Lakeshore Flood Statement|' +
  'Lakeshore Flood Warning|Lakeshore Flood Watch|Law Enforcement Warning|Local Area Emergency|Low Water Advisory|Marine Weather Statement|' +
  'Nuclear Power Plant Warning|Radiological Hazard Warning|Red Flag Warning|Rip Current Statement|Severe Thunderstorm Warning|' +
  'Severe Thunderstorm Watch|Severe Weather Statement|Shelter In Place Warning|Short Term Forecast|Small Craft Advisory|' +
  'Small Craft Advisory For Hazardous Seas|Small Craft Advisory For Rough Bar|Small Craft Advisory For Winds|Small Stream Flood Advisory|' +
  'Snow Squall Warning|Special Marine Warning|Special Weather Statement|Storm Surge Warning|Storm Surge Watch|Storm Warning|Storm Watch|' +
  'Tornado Warning|Tornado Watch|Tropical Depression Local Statement|Tropical Storm Local Statement|Tropical Storm Warning|Tropical Storm Watch|' +
  'Tsunami Advisory|Tsunami Warning|Tsunami Watch|Typhoon Local Statement|Typhoon Warning|Typhoon Watch|Urban And Small Stream Flood Advisory|' +
  'Volcano Warning|Wind Advisory|Wind Chill Advisory|Wind Chill Warning|Wind Chill Watch|Winter Storm Warning|Winter Storm Watch|' +
  'Winter Weather Advisory').split('|');

// First match wins, so the order matters (e.g. "Dust Storm Warning" must not be read as a marine "Storm Warning").
const CATEGORY_RULES = [
  ['Severe', /Tornado|Severe Thunderstorm|Severe Weather Statement/],
  ['Tropical', /Hurricane(?! Force)|Tropical|Typhoon|Storm Surge/],
  ['Winter', /Winter|Blizzard|Ice Storm|Snow|Sleet|Freez(?:e|ing)(?! Spray)|Frost|Wind Chill|Cold|Avalanche/],
  ['Marine', /Marine|Gale|^Storm (?:Warning|Watch)$|Small Craft|Hurricane Force|Hazardous Seas|Freezing Spray|Rip Current|Surf|Beach|Tsunami|Coastal Flood|Lakeshore|Low Water/],
  ['Hydro', /Flood|Hydrologic|Stream|\bDam\b|Levee|Arroyo/],
  ['Fire/Heat', /Fire|Red Flag|Heat/],
  ['Wind/Air', /Wind|Dust|Smoke|Fog|Air (?:Quality|Stagnation)|Ashfall|Volcano|Smog/],
  ['General', /Special Weather Statement|Outlook|Short Term Forecast|Statement|Message|Administrative|Test|Emergency|Evacuation|Shelter|Civil|Law Enforcement|Hazardous Materials|Nuclear|Radiological|Earthquake|Child|Telephone|Local Area/],
];
export const categoryOf = (event) => {
  if (TORNADO_TIERS.includes(event)) return 'Severe';
  for (const [cat, re] of CATEGORY_RULES) if (re.test(event)) return cat;
  return 'Other';
};

export const kindOf = (event) =>
  TORNADO_TIERS.includes(event) || /Warning$/.test(event) ? 'warning'
    : /Watch$/.test(event) ? 'watch'
    : /Advisory$/.test(event) ? 'advisory'
    : 'statement';

/* ---------- tornado levels ---------- */

// Which tornado level a Tornado Warning is, from the NWS alert parameters (the text is the fallback).
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
export const styleKey = (p) => (p.event === 'Tornado Warning' ? tornadoTier(p) : p.event);

/* ---------- styles ---------- */

const COLORS = {
  'Tornado Warning': '#dc2626', 'Observed Tornado': '#ff0000', 'PDS Tornado (Particularly Dangerous Situation)': '#7e22ce', 'Tornado Emergency': '#d946ef',
  'Severe Thunderstorm Warning': '#eab308', 'Flash Flood Warning': '#22c55e', 'Tornado Watch': '#facc15', 'Severe Thunderstorm Watch': '#db7093',
  'Flash Flood Watch': '#2e8b57', 'Flood Warning': '#16a34a', 'Flood Watch': '#2e8b57', 'Flood Advisory': '#4ade80', 'Special Marine Warning': '#f97316',
  'Snow Squall Warning': '#38bdf8', 'Winter Storm Warning': '#ff69b4', 'Winter Storm Watch': '#4682b4', 'Winter Weather Advisory': '#7b68ee',
  'Blizzard Warning': '#ff4500', 'Ice Storm Warning': '#8b008b', 'Wind Chill Warning': '#4169e1', 'Extreme Cold Warning': '#2563eb',
  'Excessive Heat Warning': '#c71585', 'Extreme Heat Warning': '#c71585', 'Heat Advisory': '#ff7f50', 'Red Flag Warning': '#ff1493',
  'High Wind Warning': '#daa520', 'Wind Advisory': '#d2b48c', 'Extreme Wind Warning': '#ff8c00', 'Dense Fog Advisory': '#94a3b8',
  'Hurricane Warning': '#dc143c', 'Hurricane Watch': '#ff00ff', 'Tropical Storm Warning': '#b22222', 'Tropical Storm Watch': '#f08080',
  'Storm Surge Warning': '#b524f7', 'Special Weather Statement': '#ffe4b5', 'Freeze Warning': '#6d5acd', 'Frost Advisory': '#6495ed',
  'Gale Warning': '#dda0dd', 'Small Craft Advisory': '#d8bfd8', 'Coastal Flood Warning': '#228b22', 'Dust Storm Warning': '#ffe4c4',
};
const KIND_COLOR = { warning: '#ef4444', watch: '#eab308', advisory: '#38bdf8', statement: '#9ca3af' };
const KIND_LOOK = { warning: { weight: 2.5, fill: 0.12 }, watch: { weight: 1.5, fill: 0.08 }, advisory: { weight: 1.5, fill: 0.08 }, statement: { weight: 1.5, fill: 0.06 } };
const TIER_LOOK = { 'Observed Tornado': { weight: 3.5, fill: 0.2 }, 'PDS Tornado (Particularly Dangerous Situation)': { weight: 4, fill: 0.25 }, 'Tornado Emergency': { weight: 4.5, fill: 0.3 } };
const ON_BY_DEFAULT = new Set(['Tornado Warning', ...TORNADO_TIERS, 'Severe Thunderstorm Warning']);

export function defaultStyle(key) {
  const kind = kindOf(key);
  const look = TIER_LOOK[key] || KIND_LOOK[kind];
  return { on: ON_BY_DEFAULT.has(key), color: COLORS[key] || KIND_COLOR[kind], weight: look.weight, fill: look.fill };
}

const clamp = (n, lo, hi, fallback) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback);

// Defaults with any saved overrides on top; malformed saved values are ignored.
export function resolveStyle(key, override) {
  const d = defaultStyle(key);
  const o = override || {};
  return {
    on: typeof o.on === 'boolean' ? o.on : d.on,
    color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : d.color,
    weight: clamp(Number(o.weight), 0.5, 8, d.weight),
    fill: clamp(Number(o.fill), 0, 1, d.fill),
  };
}

// Settings rows for every known event plus any unusual ones currently active; tornado levels sit under Tornado Warning.
export function catalogRows(activeEvents = []) {
  const sortName = (k) => { const i = TORNADO_TIERS.indexOf(k); return i >= 0 ? `Tornado Warning ${i + 1}` : k; };
  const keys = [...new Set([...NAMES, ...TORNADO_TIERS, ...activeEvents])];
  return keys
    .map((key) => ({ key, label: LABELS[key] || key, category: categoryOf(key), kind: kindOf(key) }))
    .sort((a, b) => sortName(a.key).localeCompare(sortName(b.key)));
}

// More severe things are drawn on top.
export const drawRank = (key, kind) =>
  ({ statement: 0, advisory: 1, watch: 2, warning: 3 }[kind] ?? 0) * 10 + (TORNADO_TIERS.indexOf(key) + 1);

export const layerStyle = (styleOf) => (feature) => {
  const s = styleOf(feature.properties.key);
  return { color: s.color, weight: s.weight, opacity: 0.9, fillColor: s.color, fillOpacity: s.fill };
};

/* ---------- alerts ---------- */

export const hash = (str) => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export function normalize(f) {
  const p = f.properties || {};
  const event = p.event || 'Alert';
  const ugc = (p.geocode && p.geocode.UGC) || [];
  return {
    id: f.id || p.id,
    event, key: styleKey({ ...p, event }), kind: kindOf(event), category: categoryOf(event),
    headline: p.headline || '', description: p.description || '', instruction: p.instruction || '',
    areaDesc: p.areaDesc || '', sender: String(p.senderName || '').replace(/^NWS /, ''),
    expires: p.ends || p.expires || null, severity: p.severity || '',
    geometry: f.geometry || null,
    zones: (p.affectedZones || []).map((u) => String(u).split('/zones/')[1]).filter(Boolean),
    states: [...new Set(ugc.map((u) => String(u).slice(0, 2)))].slice(0, 4),
    params: p.parameters || {},
  };
}

// Polygon alerts use their own shape; zone-based ones are stitched together from the zones fetched so far.
export function toFeature(a, zoneGeo) {
  let g = a.geometry && /Polygon/.test(a.geometry.type) ? a.geometry : null;
  if (!g) {
    const polys = [];
    for (const z of a.zones) {
      const zg = zoneGeo.get(z);
      if (!zg) continue;
      if (zg.type === 'Polygon') polys.push(zg.coordinates);
      else for (const c of zg.coordinates) polys.push(c);
    }
    if (!polys.length) return null;
    g = { type: 'MultiPolygon', coordinates: polys };
  }
  return { type: 'Feature', id: a.id, geometry: g, properties: { id: a.id, key: a.key, kind: a.kind } };
}
