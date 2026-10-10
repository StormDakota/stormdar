import { memo, useEffect, useState } from 'react';
import { CircleMarker, Pane, Popup } from 'react-leaflet';

export const CATEGORIES = {
  tornado: { label: 'Tornado', color: '#ef4444' },
  hail: { label: 'Hail', color: '#22c55e' },
  wind: { label: 'Wind', color: '#3b82f6' },
  flood: { label: 'Flood', color: '#06b6d4' },
  snow: { label: 'Snow / Ice', color: '#bae6fd' },
  fire: { label: 'Fire', color: '#f97316' },
  marine: { label: 'Marine', color: '#818cf8' },
  rain: { label: 'Rain / Fog', color: '#94a3b8' },
  other: { label: 'Other', color: '#eab308' },
};

// Checkbox order matches a 3-column grid.
const SOURCES = {
  lsr: {
    title: 'NWS Local Storm Reports',
    types: ['tornado', 'hail', 'wind', 'flood', 'snow', 'fire', 'marine', 'rain', 'other'],
    defaults: { on: true, hours: 6, types: ['tornado', 'hail', 'wind', 'flood'] },
  },
  spotter: {
    title: 'Spotter Network Reports',
    types: ['tornado', 'hail', 'wind', 'flood', 'snow', 'other'],
    defaults: { on: false, types: ['tornado', 'hail', 'wind', 'flood'] },
  },
};
const HOUR_CHOICES = [1, 3, 6, 12, 24, 48];

/* ---------------- settings (remembered between visits) ---------------- */

const sanitize = (saved) => {
  const out = {};
  for (const [key, src] of Object.entries(SOURCES)) {
    const s = (saved && saved[key]) || {};
    out[key] = {
      on: typeof s.on === 'boolean' ? s.on : src.defaults.on,
      types: Array.isArray(s.types) ? s.types.filter((t) => src.types.includes(t)) : src.defaults.types,
      ...(key === 'lsr' ? { hours: HOUR_CHOICES.includes(s.hours) ? s.hours : src.defaults.hours } : {}),
    };
  }
  return out;
};

export function useReportSettings() {
  const [settings, setSettings] = useState(() => {
    try { return sanitize(JSON.parse(localStorage.getItem('reportSettings'))); } catch { return sanitize(null); }
  });
  const update = (key, patch) =>
    setSettings((s) => {
      const next = { ...s, [key]: { ...s[key], ...patch } };
      try { localStorage.setItem('reportSettings', JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  return { settings, update };
}

/* ---------------- data ---------------- */

// Polls the local server while the source is switched on.
export function useReportFeed(source, enabled, hours) {
  const [state, setState] = useState({ status: 'OFF', reports: [], note: '', updated: null });

  useEffect(() => {
    if (!enabled) { setState({ status: 'OFF', reports: [], note: '', updated: null }); return; }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, status: 'LOADING' }));
    const url = source === 'lsr' ? `/api/reports/lsr?hours=${hours}` : '/api/reports/spotter';
    const load = () =>
      fetch(url, { signal: ctrl.signal })
        .then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          return j;
        })
        .then((j) => setState({ status: 'OK', reports: j.reports || [], note: j.note || '', updated: new Date() }))
        .catch((e) => { if (e.name !== 'AbortError') setState((s) => ({ ...s, status: 'ERROR', error: e.message })); });
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 120000);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [source, enabled, hours]);

  return state;
}

// Spotter reports with a type this source has no checkbox for are filed under "Other".
const shownCategory = (source, cat) => (SOURCES[source].types.includes(cat) ? cat : 'other');
const isShown = (source, types, r) => types.includes(shownCategory(source, r.category));

/* ---------------- map markers ---------------- */

const fmtTime = (t) => {
  const d = t ? new Date(t) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : t || '';
};

export const ReportMarkers = memo(function ReportMarkers({ source, reports, types }) {
  const spotter = source === 'spotter';
  return (
    <Pane name={`reports-${source}`} style={{ zIndex: spotter ? 560 : 550 }}>
      {reports.filter((r) => isShown(source, types, r)).map((r) => (
        <CircleMarker
          key={r.id} center={[r.lat, r.lon]} radius={spotter ? 5 : 6}
          pathOptions={{ color: spotter ? '#ffffff' : '#0f172a', weight: 1.5, fillColor: CATEGORIES[r.category].color, fillOpacity: 0.95 }}
        >
          <Popup>
            <div className="max-w-xs font-sans text-gray-900">
              <p className="border-b pb-1 text-sm font-bold">
                {r.type}{r.magnitude != null && r.magnitude !== '' ? ` (${r.magnitude}${r.unit ? ` ${String(r.unit).toLowerCase()}` : ''})` : ''}
              </p>
              {(r.city || r.county) && <p className="mt-1 text-xs">{[r.city, r.county && `${r.county} Co.`, r.state].filter(Boolean).join(', ')}</p>}
              {r.time && <p className="text-[11px] text-gray-500">{fmtTime(r.time)}{r.source ? ` · ${r.source}` : ''}</p>}
              {(r.remark || r.text) && (
                <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-line rounded bg-gray-100 p-1.5 text-[11px] text-gray-700">{r.remark || r.text}</p>
              )}
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </Pane>
  );
});

/* ---------------- sidebar panel ---------------- */

const focus = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400';

function ReportCard({ source, cfg, update, feed }) {
  const [open, setOpen] = useState(true);
  const src = SOURCES[source];
  const shown = feed.reports.filter((r) => isShown(source, cfg.types, r)).length;

  const toggleType = (t) =>
    update(source, { types: cfg.types.includes(t) ? cfg.types.filter((x) => x !== t) : [...cfg.types, t] });

  return (
    <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-800/60">
      <div className="flex items-center gap-2 pr-2">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`flex-1 px-3 py-3 text-left text-sm font-semibold text-gray-100 ${focus}`}>
          {src.title}
        </button>
        <button
          role="switch" aria-checked={cfg.on} aria-label={`Show ${src.title}`} onClick={() => update(source, { on: !cfg.on })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${cfg.on ? 'bg-blue-500' : 'bg-slate-600'} ${focus}`}
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${cfg.on ? 'left-[1.15rem]' : 'left-0.5'}`} />
        </button>
        <button onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse' : 'Expand'} className={`rounded p-1 text-gray-400 hover:text-gray-200 ${focus}`}>
          <svg viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 8l5 5 5-5" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-slate-700 px-3 py-3 text-sm">
          <p className="text-xs font-semibold text-gray-400">Report Types</p>
          <div className="grid grid-cols-3 gap-x-2 gap-y-3">
            {src.types.map((t) => (
              <label key={t} className="flex cursor-pointer items-center gap-2 text-gray-200">
                <input type="checkbox" checked={cfg.types.includes(t)} onChange={() => toggleType(t)} className="h-4 w-4 shrink-0 accent-yellow-500" />
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: CATEGORIES[t].color }} />
                <span className="truncate">{CATEGORIES[t].label}</span>
              </label>
            ))}
          </div>

          {source === 'lsr' && (
            <label className="flex items-center justify-between text-xs text-gray-300">
              Time window
              <select
                value={cfg.hours} onChange={(e) => update('lsr', { hours: Number(e.target.value) })}
                className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
              >
                {HOUR_CHOICES.map((h) => <option key={h} value={h}>Past {h} hour{h > 1 ? 's' : ''}</option>)}
              </select>
            </label>
          )}

          <p className="text-xs text-gray-400">
            {!cfg.on && 'Switched off.'}
            {cfg.on && feed.status === 'LOADING' && 'Loading...'}
            {cfg.on && feed.status === 'ERROR' && <span className="text-red-400">{feed.error}</span>}
            {cfg.on && feed.status === 'OK' && (feed.note || `${shown} shown of ${feed.reports.length} reports · updated ${feed.updated.toLocaleTimeString()}`)}
          </p>
        </div>
      )}
    </div>
  );
}

export function ReportsPanel({ settings, update, lsr, spotter }) {
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-gray-400">Weather reports</p>
      <ReportCard source="lsr" cfg={settings.lsr} update={update} feed={lsr} />
      <ReportCard source="spotter" cfg={settings.spotter} update={update} feed={spotter} />
    </div>
  );
}
