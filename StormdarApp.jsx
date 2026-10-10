import { useEffect, useState } from 'react';
import {
  MapContainer, TileLayer, Pane, CircleMarker, Popup, GeoJSON, useMap,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { NEXRAD_STATIONS } from './nexradStations'; // export const NEXRAD_STATIONS = [ ... ]
import { useOutlook, OutlookPanel } from './Outlook';
import { outlookStyle } from './outlookUtils';
import { useAlerts } from './useAlerts';
import { AlertsControl, alertPopup } from './Alerts';
import {
  useTropicsSettings, useTropics, useOutlookAreas, TropicsLayers, OutlookLayers, TropicsPanel, boundsOfStorm, boundsOfDisturbance,
} from './Tropics';
import { useReportSettings, useReportFeed, ReportsPanel, ReportMarkers } from './Reports';

const API = ''; // proxied to the radar server by vite.config.js
const FRAMES = 6;
const REFRESH_MS = 120000;

const PRODUCTS = [
  { code: 'REF', label: 'Base Reflectivity', lo: 'Light rain', hi: 'Heavy rain / hail' },
  { code: 'VEL', label: 'Base Velocity', lo: 'Toward radar', hi: 'Away from radar' },
  { code: 'CC', label: 'Correlation Coefficient (CC)', lo: 'Debris / non-rain', hi: 'Pure precipitation' },
];

const distKm = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

function MapFlyTo({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lon], Math.max(map.getZoom(), target.zoom || 7), { duration: 1 });
  }, [target, map]);
  return null;
}

function MapFitBounds({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.fitBounds(target.b, { maxZoom: 9, padding: [40, 40] });
  }, [target, map]);
  return null;
}

function MapResizer() {
  const map = useMap();
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}

export default function StormdarApp() {
  const [tab, setTab] = useState('radar');
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem('sidebarOpen') !== '0'; } catch { return true; }
  });
  const toggleSidebar = () =>
    setSidebarOpen((open) => {
      try { localStorage.setItem('sidebarOpen', open ? '0' : '1'); } catch { /* storage unavailable */ }
      return !open;
    });
  const [loc, setLoc] = useState(null);
  const [flyTarget, setFlyTarget] = useState(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState('');

  const [station, setStation] = useState(NEXRAD_STATIONS.find((s) => s.id === 'KTLX') || NEXRAD_STATIONS[0]);
  const [product, setProduct] = useState(PRODUCTS[0]);
  const [opacity, setOpacity] = useState(0.85);
  const [frames, setFrames] = useState([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [radarStatus, setRadarStatus] = useState('LOADING');
  const [radarError, setRadarError] = useState('');

  const alertApi = useAlerts(); // all NWS alerts, your on/off choices and styles
  const [fitTarget, setFitTarget] = useState(null);

  // Hurricane tracks (NHC)
  const tropicsCfg = useTropicsSettings();
  const tropics = useTropics(tropicsCfg.settings.on);
  const outlookAreas = useOutlookAreas(tropicsCfg.settings.outlook);

  // Weather reports (NWS Local Storm Reports, Spotter Network)
  const reportCfg = useReportSettings();
  const lsr = useReportFeed('lsr', reportCfg.settings.lsr.on, reportCfg.settings.lsr.hours);
  const spotter = useReportFeed('spotter', reportCfg.settings.spotter.on);

  // SPC convective outlook (day 0 = off)
  const [outlookDay, setOutlookDay] = useState(0);
  const [outlookType, setOutlookType] = useState('cat');
  const outlook = useOutlook(outlookDay, outlookType);

  // Color tables
  const [palettes, setPalettes] = useState(null);
  const [palMsg, setPalMsg] = useState('');
  const [choice, setChoice] = useState(() => {
    try { return JSON.parse(localStorage.getItem('radarPalettes')) || {}; } catch { return {}; }
  });
  const choosePalette = (kind, name) =>
    setChoice((c) => {
      const next = { ...c, [kind]: name };
      try { localStorage.setItem('radarPalettes', JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });

  const pickLocation = (p) => { setLoc(p); setFlyTarget({ ...p, zoom: 7 }); };

  const useMyLocation = () => {
    if (!navigator.geolocation) return setGeoError('This browser has no geolocation.');
    setLocating(true); setGeoError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); pickLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude }); },
      (err) => { setLocating(false); setGeoError(err.message || 'Could not get your location.'); },
      { timeout: 10000 }
    );
  };

  // Follow the location: switch to the nearest radar site.
  useEffect(() => {
    if (!loc) return;
    setStation([...NEXRAD_STATIONS].sort((a, b) => distKm(loc, a) - distKm(loc, b))[0]);
  }, [loc]);

  useEffect(() => {
    fetch(`${API}/api/palettes`).then((r) => r.json()).then(setPalettes).catch(() => {});
  }, []);

  // Radar loop from the local proxy
  useEffect(() => {
    const ctrl = new AbortController();
    setFrames([]); setRadarStatus('LOADING'); setRadarError('');
    const load = async () => {
      try {
        const res = await fetch(`${API}/api/radar/${station.id}/${product.code}/loop?count=${FRAMES}`, { signal: ctrl.signal });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setFrames(json.frames); setIdx(json.frames.length - 1); setRadarStatus('ONLINE');
      } catch (e) {
        if (e.name !== 'AbortError') { setRadarStatus('ERROR'); setRadarError(e.message); }
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [station.id, product.code]);

  // Animate; hold on the newest frame a little longer
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const t = setTimeout(() => setIdx((i) => (i + 1) % frames.length), idx === frames.length - 1 ? 1200 : 450);
    return () => clearTimeout(t);
  }, [playing, frames, idx]);

  const kindList = palettes?.[product.code] || [];
  const sel = kindList.find((p) => p.name === choice[product.code]) || kindList[0];
  const paletteName = sel?.name ?? 'Default';

  const importPalette = async (file) => {
    if (!file) return;
    try {
      const res = await fetch(`${API}/api/palettes?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: await file.text() });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setPalettes(json.palettes);
      const kind = Object.keys(json.palettes).find((k) => json.palettes[k].some((p) => p.name === json.saved));
      const prod = PRODUCTS.find((p) => p.code === kind);
      if (prod) { setProduct(prod); choosePalette(kind, json.saved); setPalMsg(`Added "${json.saved}"`); }
      else setPalMsg(`Added "${json.saved}" (for a product this app doesn't show)`);
    } catch (e) {
      setPalMsg(e.message);
    }
  };

  const removePalette = async () => {
    if (!sel || sel.builtin) return;
    try {
      const res = await fetch(`${API}/api/palettes?name=${encodeURIComponent(sel.name)}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setPalettes(json.palettes);
      choosePalette(product.code, 'Default');
      setPalMsg(`Removed "${sel.name}"`);
    } catch (e) {
      setPalMsg(e.message);
    }
  };

  const cur = frames[idx];
  const statusStyle = {
    ONLINE: 'border-green-800 bg-green-900/50 text-green-400',
    LOADING: 'border-yellow-800 bg-yellow-900/50 text-yellow-400',
    ERROR: 'border-red-800 bg-red-900/50 text-red-400',
  }[radarStatus];

  return (
    <div className="flex h-screen w-screen flex-col-reverse overflow-hidden bg-slate-950 text-gray-200 md:flex-row">
      {/* Panel: bottom sheet on phones, sidebar on desktop */}
      <aside
        aria-hidden={!sidebarOpen}
        className={`flex shrink-0 flex-col overflow-hidden bg-slate-900 transition-all duration-300 ${
          sidebarOpen ? 'h-[48vh] border-t border-slate-800 md:h-full md:w-96 md:border-r md:border-t-0' : 'invisible h-0 md:h-full md:w-0'
        }`}
      >
        <nav className="flex border-b border-slate-800 md:min-w-[24rem]" role="tablist">
          {[['radar', 'Radar'], ['outlook', 'Outlook'], ['reports', 'Reports'], ['tropics', 'Tropics']].map(([k, label]) => (
            <button
              key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`flex-1 py-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 ${
                tab === k ? 'border-b-2 border-blue-400 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto p-4 md:min-w-[24rem]">
          {tab === 'tropics' ? (
            <TropicsPanel
              settings={tropicsCfg.settings} update={tropicsCfg.update} tropics={tropics}
              onFocus={(st) => { const b = boundsOfStorm(st); if (b) setFitTarget({ b, n: Date.now() }); }}
              outlook={outlookAreas}
              onFocusArea={(pt) => setFitTarget({ b: boundsOfDisturbance(outlookAreas.data, pt), n: Date.now() })}
            />
          ) : tab === 'reports' ? (
            <ReportsPanel settings={reportCfg.settings} update={reportCfg.update} lsr={lsr} spotter={spotter} />
          ) : tab === 'outlook' ? (
            <OutlookPanel day={outlookDay} type={outlookType} setDay={setOutlookDay} setType={setOutlookType} outlook={outlook} loc={loc} />
          ) : (
            <div className="space-y-4">
              <section className="flex items-start justify-between rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                <div>
                  <p className="text-xl font-semibold text-white">{station.id}</p>
                  <p className="text-sm text-gray-400">{station.name}</p>
                  {cur && <p className="mt-1 text-xs text-gray-400">Scan {new Date(cur.scanTime).toLocaleTimeString()} &middot; {cur.elevationDeg}&deg; tilt</p>}
                  {radarStatus === 'ERROR' && <p className="mt-1 text-xs text-red-400">{radarError}</p>}
                </div>
                <span className={`rounded border px-2 py-0.5 font-mono text-[10px] ${statusStyle}`}>{radarStatus}</span>
              </section>

              <section>
                <button
                  onClick={useMyLocation} disabled={locating}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  {locating ? 'Finding you...' : loc ? 'Jump to my nearest radar' : 'Use my location'}
                </button>
                {geoError && <p className="mt-1 text-xs text-red-400">{geoError}</p>}
              </section>

              <section className="space-y-1.5" role="radiogroup" aria-label="Radar product">
                {PRODUCTS.map((p) => {
                  const on = p.code === product.code;
                  return (
                    <button
                      key={p.code} role="radio" aria-checked={on} onClick={() => setProduct(p)}
                      className={`w-full rounded-lg border px-3 py-1.5 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                        on ? 'border-blue-400 bg-blue-600 text-white' : 'border-slate-700 bg-slate-800 text-gray-300 hover:bg-slate-700'
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </section>

              <section>
                <label className="block text-xs font-semibold text-gray-400" htmlFor="palette">Color table</label>
                <select
                  id="palette" value={paletteName} onChange={(e) => choosePalette(product.code, e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
                >
                  {kindList.map((p) => <option key={p.name} value={p.name}>{p.name}{p.builtin ? '' : ' (custom)'}</option>)}
                </select>
                <div className="mt-2 flex items-center gap-4 text-xs">
                  <label className="cursor-pointer text-blue-400 hover:underline">
                    Import a .pal file
                    <input type="file" accept=".pal,.txt" className="hidden" onChange={(e) => { importPalette(e.target.files[0]); e.target.value = ''; }} />
                  </label>
                  {sel && !sel.builtin && (
                    <button onClick={removePalette} className="text-red-400 hover:underline">Remove this table</button>
                  )}
                </div>
                {palMsg && <p className="mt-1 text-xs text-gray-400">{palMsg}</p>}
              </section>

              <section>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setPlaying((p) => !p)} disabled={frames.length < 2}
                    className="w-16 rounded-lg bg-slate-800 py-1.5 text-sm hover:bg-slate-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  >
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <input
                    type="range" min="0" max={Math.max(0, frames.length - 1)} value={idx} aria-label="Radar frame"
                    onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }}
                    className="flex-1 accent-blue-400"
                  />
                </div>
                <label className="mt-2 block text-xs text-gray-400">
                  Opacity
                  <input type="range" min="0.2" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="mt-1 w-full accent-blue-400" />
                </label>
              </section>

              <section>
                <p className="mb-1 text-xs font-semibold text-gray-400">Scale{sel ? ` (${sel.units})` : ''}</p>
                {sel?.interp ? (
                  <div className="h-3 rounded" style={{ background: `linear-gradient(to right, ${sel.stops.map(([, c]) => `rgb(${c[0]},${c[1]},${c[2]})`).join(',')})` }} />
                ) : (
                  <div className="flex h-3 overflow-hidden rounded bg-slate-800">
                    {(sel?.stops || []).map(([v, c]) => (
                      <div key={v} className="h-full flex-1" style={{ backgroundColor: `rgb(${c[0]},${c[1]},${c[2]})` }} title={String(v)} />
                    ))}
                  </div>
                )}
                <div className="mt-1 flex justify-between text-[10px] text-gray-400">
                  <span>{sel ? `${sel.stops[0][0]} ` : ''}{product.lo}</span>
                  <span>{product.hi}{sel ? ` ${sel.stops[sel.stops.length - 1][0]}` : ''}</span>
                </div>
              </section>
            </div>
          )}
        </div>
      </aside>

      <main className="relative min-h-0 flex-1">
        <button
          onClick={toggleSidebar} aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'} aria-expanded={sidebarOpen}
          className="absolute bottom-0 left-1/2 z-[1000] flex h-6 w-14 -translate-x-1/2 items-center justify-center rounded-t-lg border border-b-0 border-slate-600 bg-slate-900/90 text-gray-200 shadow hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 md:bottom-auto md:left-0 md:top-1/2 md:h-14 md:w-6 md:-translate-y-1/2 md:translate-x-0 md:rounded-l-none md:rounded-r-lg md:border-b md:border-l-0"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`h-4 w-4 transition-transform ${sidebarOpen ? '-rotate-90 md:rotate-0' : 'rotate-90 md:rotate-180'}`}>
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </button>
        <AlertsControl api={alertApi} onFocusBounds={(b) => setFitTarget({ b, n: Date.now() })} />
        <MapContainer center={[37.8, -96]} zoom={4} minZoom={3} className="h-full w-full">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            className="basemap-dark"
          />

          {/* Outlook sits under the radar and ignores clicks, so the map stays easy to pan and tap */}
          {outlookDay > 0 && outlook.data && (
            <Pane name="outlook" style={{ zIndex: 300 }}>
              <GeoJSON key={`${outlookDay}-${outlookType}-${outlook.sig}`} data={outlook.data} style={outlookStyle} interactive={false} />
            </Pane>
          )}

          {/* Radar is drawn as map tiles, so it stays sharp when zooming. All frames stay mounted (preloaded); only the current one is visible */}
          <Pane name="radar" style={{ zIndex: 350 }}>
            {frames.map((f, i) => (
              <TileLayer key={f.objectKey} url={`${f.tiles}?palette=${encodeURIComponent(paletteName)}&v=${encodeURIComponent(sel?.id ?? '')}`} opacity={i === idx ? opacity : 0} maxZoom={18} />
            ))}
          </Pane>

          {alertApi.features.length > 0 && (
            <GeoJSON
              key={alertApi.sig}
              data={{ type: 'FeatureCollection', features: alertApi.features }}
              style={alertApi.layerStyle}
              onEachFeature={(f, layer) =>
                layer.bindPopup(() => {
                  const info = alertApi.popupInfo(f.properties.id);
                  return info ? alertPopup(info.alert, info.style) : 'Alert';
                })}
            />
          )}

          <OutlookLayers data={outlookAreas.data} settings={tropicsCfg.settings} />
          <TropicsLayers storms={tropics.storms} settings={tropicsCfg.settings} />

          <ReportMarkers source="lsr" reports={lsr.reports} types={reportCfg.settings.lsr.types} />
          <ReportMarkers source="spotter" reports={spotter.reports} types={reportCfg.settings.spotter.types} />

          {NEXRAD_STATIONS.map((s) => {
            const active = s.id === station.id;
            return (
              <CircleMarker
                key={s.id} center={[s.lat, s.lon]} radius={active ? 11 : 8}
                pathOptions={{ color: active ? '#93c5fd' : '#0f172a', weight: active ? 2 : 1, fillColor: active ? '#3b82f6' : '#6b7280', fillOpacity: 0.95, bubblingMouseEvents: false }}
                eventHandlers={{ click: () => { setStation(s); setTab('radar'); } }}
              >
                <Popup><p className="font-bold">{s.id}</p><p className="text-xs">{s.name}</p></Popup>
              </CircleMarker>
            );
          })}

          {loc && (
            <CircleMarker center={[loc.lat, loc.lon]} radius={6} interactive={false}
              pathOptions={{ color: '#fff', weight: 2, fillColor: '#f97316', fillOpacity: 1 }} />
          )}

          <MapResizer />
          <MapFitBounds target={fitTarget} />
          <MapFlyTo target={flyTarget} />
        </MapContainer>
      </main>
    </div>
  );
}
