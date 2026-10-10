import { memo, useEffect, useState } from 'react';
import L from 'leaflet';
import { CircleMarker, GeoJSON, Marker, Pane, Popup, Tooltip } from 'react-leaflet';
import {
  RISK_COLORS, RISK_LABELS, SS_LEGEND, bearingDeg, dirName, disturbanceName, hasFeatures, lastSegment, mph, riskLevel, ssColor, stormLabel, wwColor,
} from './tropicsUtils';

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400';

/* ---------------- settings (remembered) ---------------- */

const DEFAULTS = { on: true, cone: true, track: true, points: true, past: true, warnings: true, outlook: true, areas: true, motion: true, outlookPoints: true, outlookBy: '7day' };
const LAYER_CHOICES = [['cone', 'Cone'], ['track', 'Forecast track'], ['points', 'Forecast points'], ['past', 'Past track'], ['warnings', 'Watches / warnings']];

export function useTropicsSettings() {
  const [settings, setSettings] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('tropicsSettings')) || {};
      return Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, typeof saved[k] === typeof d ? saved[k] : d]));
    } catch { return DEFAULTS; }
  });
  const update = (patch) =>
    setSettings((s) => {
      const next = { ...s, ...patch };
      try { localStorage.setItem('tropicsSettings', JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  return { settings, update };
}

/* ---------------- data ---------------- */

export function useTropics(enabled) {
  const [state, setState] = useState({ status: 'OFF', storms: [], updated: null, error: '' });

  useEffect(() => {
    if (!enabled) { setState({ status: 'OFF', storms: [], updated: null, error: '' }); return; }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, status: 'LOADING' }));
    const load = () =>
      fetch('/api/tropics', { signal: ctrl.signal })
        .then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          return j;
        })
        .then((j) => setState({ status: 'OK', storms: j.storms || [], updated: new Date(), error: '' }))
        .catch((e) => { if (e.name !== 'AbortError') setState((s) => ({ ...s, status: 'ERROR', error: e.message })); });
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 10 * 60e3);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [enabled]);

  return state;
}

// NHC's 7-day outlook: areas where a storm may form ("areas of disturbance").
export function useOutlookAreas(enabled) {
  const [state, setState] = useState({ status: 'OFF', data: null, error: '' });

  useEffect(() => {
    if (!enabled) { setState({ status: 'OFF', data: null, error: '' }); return; }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, status: 'LOADING' }));
    const load = () =>
      fetch('/api/tropics/outlook', { signal: ctrl.signal })
        .then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          return j;
        })
        .then((data) => setState({ status: 'OK', data, error: '' }))
        .catch((e) => { if (e.name !== 'AbortError') setState((s) => ({ ...s, status: 'ERROR', error: e.message })); });
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 10 * 60e3);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [enabled]);

  return state;
}

/* ---------------- map layers ---------------- */

const coneStyle = { color: '#ffffff', weight: 1.5, opacity: 0.9, fillColor: '#ffffff', fillOpacity: 0.2 };
const trackStyle = { color: '#ff3b3b', weight: 2.5, opacity: 0.95, dashArray: '6 4' };
const pastStyle = { color: '#e5e7eb', weight: 2.5, opacity: 0.9 };
const warnStyle = (f) => ({ color: wwColor(f.properties), weight: 6, opacity: 0.9, lineCap: 'round' });

const stormIcon = (color) =>
  L.divIcon({
    className: '',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `<svg viewBox="0 0 24 24" width="34" height="34"><circle cx="12" cy="12" r="11" fill="${color}" stroke="#fff" stroke-width="2"/><path d="M12 5.5c3.6 0 6.5 2.9 6.5 6.5M12 18.5c-3.6 0-6.5-2.9-6.5-6.5M12 8.5c1.9 0 3.5 1.6 3.5 3.5M12 15.5c-1.9 0-3.5-1.6-3.5-3.5" stroke="#0f172a" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="12" cy="12" r="1.6" fill="#0f172a"/></svg>`,
  });

const windOf = (p) => Number(p.maxwind ?? p.intensity ?? p.wind);
const fmtTime = (iso) => (iso && !Number.isNaN(new Date(iso).getTime()) ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function Dot({ f, past }) {
  const p = f.properties || {};
  const kt = windOf(p);
  return (
    <CircleMarker
      center={[f.geometry.coordinates[1], f.geometry.coordinates[0]]} radius={past ? 3.5 : 6}
      pathOptions={{ color: past ? '#0f172a' : '#ffffff', weight: past ? 1 : 1.5, fillColor: ssColor(kt), fillOpacity: 1 }}
    >
      <Popup>
        <div className="font-sans text-xs text-gray-900">
          <p className="font-bold">{past ? 'Past position' : (p.datelbl || `+${p.tau ?? '?'} h`)}</p>
          {Number.isFinite(kt) && <p>{kt} kt ({mph(kt)} mph)</p>}
        </div>
      </Popup>
    </CircleMarker>
  );
}

const StormLayers = memo(function StormLayers({ storm, s }) {
  const k = `${storm.id}-${storm.updated}`;
  const { cone, track, points, past, pastPoints, warnings } = storm.layers;
  const pt = (f) => f.geometry && f.geometry.type === 'Point';
  return (
    <>
      {s.cone && hasFeatures(cone) && <GeoJSON key={`${k}-cone`} data={cone} style={coneStyle} interactive={false} />}
      {s.past && hasFeatures(past) && <GeoJSON key={`${k}-past`} data={past} style={pastStyle} interactive={false} />}
      {s.track && hasFeatures(track) && <GeoJSON key={`${k}-track`} data={track} style={trackStyle} interactive={false} />}
      {s.warnings && hasFeatures(warnings) && <GeoJSON key={`${k}-ww`} data={warnings} style={warnStyle} interactive={false} />}
      {s.past && (pastPoints?.features || []).filter(pt).map((f, i) => <Dot key={`${k}-pp${i}`} f={f} past />)}
      {s.points && (points?.features || []).filter(pt).map((f, i) => <Dot key={`${k}-fp${i}`} f={f} />)}
      {storm.lat != null && storm.lon != null && (
        <Marker position={[storm.lat, storm.lon]} icon={stormIcon(ssColor(storm.intensityKt))}>
          <Tooltip permanent direction="right" offset={[18, 0]}>{storm.name}</Tooltip>
          <Popup>
            <div className="max-w-xs font-sans text-sm text-gray-900">
              <p className="border-b pb-1 font-bold">{stormLabel(storm.classification, storm.intensityKt)} {storm.name}</p>
              {storm.intensityKt != null && <p className="mt-1">Winds {storm.intensityKt} kt ({mph(storm.intensityKt)} mph)</p>}
              {storm.pressureMb != null && <p>Pressure {storm.pressureMb} mb</p>}
              {storm.movementDir != null && <p>Moving {dirName(storm.movementDir)}{storm.movementSpeedMph != null ? ` at ${storm.movementSpeedMph} mph` : ''}</p>}
              {storm.updated && <p className="text-xs text-gray-500">Updated {fmtTime(storm.updated)}</p>}
              {storm.advisoryUrl && storm.advisoryUrl.startsWith('https://www.nhc.noaa.gov/') && (
                <a className="mt-1 inline-block text-xs text-blue-700 underline" href={storm.advisoryUrl} target="_blank" rel="noreferrer">NHC advisory</a>
              )}
            </div>
          </Popup>
        </Marker>
      )}
    </>
  );
});

export function TropicsLayers({ storms, settings }) {
  if (!settings.on || !storms.length) return null;
  return (
    <Pane name="tropics" style={{ zIndex: 420 }}>
      {storms.map((st) => <StormLayers key={st.id} storm={st} s={settings} />)}
    </Pane>
  );
}

const arrowIcon = (color, deg) =>
  L.divIcon({
    className: '', iconSize: [18, 18], iconAnchor: [9, 9],
    html: `<svg viewBox="0 0 24 24" width="18" height="18" style="transform:rotate(${deg}deg)"><path d="M12 2l7 18-7-4-7 4z" fill="${color}" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  });
const crossIcon = (color) =>
  L.divIcon({
    className: '', iconSize: [24, 24], iconAnchor: [12, 12],
    html: `<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5 5l14 14M19 5L5 19" stroke="#0f172a" stroke-width="7" stroke-linecap="round"/><path d="M5 5l14 14M19 5L5 19" stroke="${color}" stroke-width="4" stroke-linecap="round"/></svg>`,
  });

const probLine = (p, by) => {
  const prob = p[by === '2day' ? 'prob2day' : 'prob7day'];
  const level = riskLevel(p, by);
  return `${by === '2day' ? '2-day' : '7-day'}: ${prob || '?'} (${RISK_LABELS[level]})`;
};

// Areas drawn under the named storms; shapes ignore clicks so the map stays easy to use, the X marks carry the details.
export const OutlookLayers = memo(function OutlookLayers({ data, settings }) {
  if (!settings.outlook || !data) return null;
  const by = settings.outlookBy;
  const key = `${data.updated}-${by}`;
  const color = (f) => RISK_COLORS[riskLevel(f.properties, by)];
  return (
    <Pane name="tropics-outlook" style={{ zIndex: 410 }}>
      {settings.areas && hasFeatures(data.areas) && (
        <GeoJSON key={`${key}-a`} data={data.areas} interactive={false} style={(f) => ({ color: color(f), weight: 2.5, opacity: 0.95, fillColor: color(f), fillOpacity: 0.22 })} />
      )}
      {settings.motion && hasFeatures(data.motion) && (
        <GeoJSON key={`${key}-m`} data={data.motion} interactive={false} style={(f) => ({ color: color(f), weight: 2.5, opacity: 0.95, dashArray: '2 6' })} />
      )}
      {settings.motion && (data.motion?.features || []).map((f, i) => {
        const seg = lastSegment(f.geometry);
        return seg ? <Marker key={`${key}-ar${i}`} position={[seg[1][1], seg[1][0]]} icon={arrowIcon(color(f), bearingDeg(seg[0], seg[1]))} interactive={false} /> : null;
      })}
      {settings.outlookPoints && (data.points?.features || []).filter((f) => f.geometry && f.geometry.type === 'Point').map((f, i) => (
        <Marker key={`${key}-pt${i}`} position={[f.geometry.coordinates[1], f.geometry.coordinates[0]]} icon={crossIcon(color(f))}>
          <Popup>
            <div className="font-sans text-xs text-gray-900">
              <p className="border-b pb-1 text-sm font-bold">{disturbanceName(f.properties)}</p>
              <p className="mt-1">{probLine(f.properties, '2day')}</p>
              <p>{probLine(f.properties, '7day')}</p>
              <p className="mt-1 text-gray-500">Chance of becoming a tropical cyclone (NHC outlook)</p>
            </div>
          </Popup>
        </Marker>
      ))}
    </Pane>
  );
});

// Bounds for "Zoom to" on a disturbance: its outlook area if we can match one, else a region around its location.
export function boundsOfDisturbance(data, point) {
  const p = point.properties || {};
  const poly = (data.areas?.features || []).find((f) => f.properties.basin === p.basin && f.properties.area === p.area);
  if (poly) {
    const b = L.geoJSON(poly).getBounds();
    if (b.isValid()) return b;
  }
  return L.latLng(point.geometry.coordinates[1], point.geometry.coordinates[0]).toBounds(900000);
}

/* ---------------- sidebar panel ---------------- */

export function boundsOfStorm(storm) {
  const fc = [storm.layers.cone, storm.layers.track].find(hasFeatures);
  if (fc) {
    const b = L.geoJSON(fc).getBounds();
    if (b.isValid()) return b;
  }
  if (storm.lat != null && storm.lon != null) return L.latLng(storm.lat, storm.lon).toBounds(600000);
  return null;
}

function StormCard({ storm, onFocus }) {
  const label = stormLabel(storm.classification, storm.intensityKt);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm" style={{ borderLeft: `4px solid ${ssColor(storm.intensityKt)}` }}>
      <p className="font-semibold text-white">{storm.name || 'Unnamed'} <span className="font-normal text-gray-400">· {label}</span></p>
      <div className="mt-1 space-y-0.5 text-xs text-gray-300">
        {storm.intensityKt != null && <p>Winds {mph(storm.intensityKt)} mph ({storm.intensityKt} kt){storm.pressureMb != null ? ` · ${storm.pressureMb} mb` : ''}</p>}
        {storm.movementDir != null && <p>Moving {dirName(storm.movementDir)}{storm.movementSpeedMph != null ? ` at ${storm.movementSpeedMph} mph` : ''}</p>}
        {storm.updated && <p className="text-gray-500">Updated {fmtTime(storm.updated)}</p>}
      </div>
      <div className="mt-2 flex gap-4 text-xs">
        <button onClick={() => onFocus(storm)} className={`text-blue-400 hover:underline ${focusRing}`}>Zoom to</button>
        {storm.advisoryUrl && storm.advisoryUrl.startsWith('https://www.nhc.noaa.gov/') && (
          <a href={storm.advisoryUrl} target="_blank" rel="noreferrer" className={`text-blue-400 hover:underline ${focusRing}`}>NHC advisory</a>
        )}
      </div>
    </div>
  );
}

function OutlookSection({ settings, update, outlook, onFocus }) {
  const points = (outlook.data?.points?.features || []).filter((f) => f.geometry && f.geometry.type === 'Point');
  const by = settings.outlookBy;
  return (
    <section className="space-y-3 border-t border-slate-800 pt-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-400">Areas of disturbance (NHC outlook)</p>
        <button
          role="switch" aria-checked={settings.outlook} aria-label="Show areas of disturbance" onClick={() => update({ outlook: !settings.outlook })}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${settings.outlook ? 'bg-blue-500' : 'bg-slate-600'} ${focusRing}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${settings.outlook ? 'left-[1.4rem]' : 'left-0.5'}`} />
        </button>
      </div>

      {settings.outlook && (
        <>
          {outlook.status === 'LOADING' && <p className="text-sm text-gray-400">Loading outlook...</p>}
          {outlook.status === 'ERROR' && <p className="text-sm text-red-400">{outlook.error}</p>}
          {outlook.status === 'OK' && !points.length && !hasFeatures(outlook.data?.areas) && (
            <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm text-gray-300">No areas of disturbance in NHC's current 7-day outlook.</p>
          )}

          <div className="space-y-2">
            {points.map((f, i) => {
              const p = f.properties;
              return (
                <div key={i} className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm" style={{ borderLeft: `4px solid ${RISK_COLORS[riskLevel(p, by)]}` }}>
                  <p className="font-semibold text-white">{disturbanceName(p)}</p>
                  <p className="mt-1 text-xs text-gray-300">{probLine(p, '2day')}</p>
                  <p className="text-xs text-gray-300">{probLine(p, '7day')}</p>
                  <button onClick={() => onFocus(f)} className={`mt-2 text-xs text-blue-400 hover:underline ${focusRing}`}>Zoom to</button>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
            {[['areas', 'Areas'], ['motion', 'Motion arrows'], ['outlookPoints', 'Locations (X)']].map(([k, label]) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
                <input type="checkbox" checked={settings[k]} onChange={(e) => update({ [k]: e.target.checked })} className="h-4 w-4 accent-yellow-500" />
                {label}
              </label>
            ))}
          </div>

          <div role="radiogroup" aria-label="Color by" className="flex items-center gap-2 text-xs text-gray-300">
            Color by
            {[['7day', '7-day chance'], ['2day', '2-day chance']].map(([k, label]) => (
              <button
                key={k} role="radio" aria-checked={by === k} onClick={() => update({ outlookBy: k })}
                className={`rounded-full px-3 py-1 font-semibold ${by === k ? 'bg-yellow-400 text-slate-900' : 'bg-slate-700 text-gray-200 hover:bg-slate-600'} ${focusRing}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-gray-300">
            {[['low', 'Low (under 40%)'], ['medium', 'Medium (40-60%)'], ['high', 'High (over 60%)']].map(([k, label]) => (
              <span key={k} className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm" style={{ backgroundColor: RISK_COLORS[k] }} />{label}</span>
            ))}
          </div>
          <p className="text-[11px] text-gray-500">Chance of a disturbance becoming a tropical or subtropical cyclone. The shaded area is where it may form over the next 7 days.</p>
        </>
      )}
    </section>
  );
}

export function TropicsPanel({ settings, update, tropics, onFocus, outlook, onFocusArea }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-400">Hurricane tracks (NHC)</p>
        <button
          role="switch" aria-checked={settings.on} aria-label="Show hurricane tracks" onClick={() => update({ on: !settings.on })}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${settings.on ? 'bg-blue-500' : 'bg-slate-600'} ${focusRing}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${settings.on ? 'left-[1.4rem]' : 'left-0.5'}`} />
        </button>
      </div>

      {settings.on && (
        <>
          {tropics.status === 'LOADING' && <p className="text-sm text-gray-400">Loading storms...</p>}
          {tropics.status === 'ERROR' && <p className="text-sm text-red-400">{tropics.error}</p>}
          {tropics.status === 'OK' && !tropics.storms.length && (
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm text-gray-300">
              No active tropical cyclones right now in the Atlantic, East Pacific or Central Pacific.
              <p className="mt-1 text-xs text-gray-500">Tracks appear here and on the map as soon as the National Hurricane Center names a system.</p>
            </div>
          )}
          <div className="space-y-2">{tropics.storms.map((st) => <StormCard key={st.id} storm={st} onFocus={onFocus} />)}</div>

          <section>
            <p className="mb-2 text-xs font-semibold text-gray-400">Map layers</p>
            <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
              {LAYER_CHOICES.map(([k, label]) => (
                <label key={k} className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
                  <input type="checkbox" checked={settings[k]} onChange={(e) => update({ [k]: e.target.checked })} className="h-4 w-4 accent-yellow-500" />
                  {label}
                </label>
              ))}
            </div>
          </section>

          <section>
            <p className="mb-2 text-xs font-semibold text-gray-400">Intensity colors</p>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {SS_LEGEND.map((l) => (
                <span key={l.label} className="flex items-center gap-1.5 text-xs text-gray-300">
                  <span className="h-3 w-3 rounded-full border border-slate-500" style={{ backgroundColor: l.color }} />{l.label}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-gray-500">
              Cone: where the center may track, about 2 in 3 of the time. Storm impacts can reach well outside it.
            </p>
          </section>

          {tropics.updated && <p className="text-[10px] text-gray-500">Checked {tropics.updated.toLocaleTimeString()}</p>}
        </>
      )}
      <OutlookSection settings={settings} update={update} outlook={outlook} onFocus={onFocusArea} />
    </div>
  );
}
