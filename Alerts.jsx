import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { CATEGORIES, KINDS, LABELS, catalogRows, drawRank } from './alertCatalog';

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400';

function Icon({ children, className = 'h-5 w-5' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const Eye = ({ off }) => (
  <Icon><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" />{off && <path d="M3 3l18 18" />}</Icon>
);

function Switch({ on, onChange, label }) {
  return (
    <button
      role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-blue-500' : 'bg-slate-600'} ${focusRing}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[1.4rem]' : 'left-0.5'}`} />
    </button>
  );
}

/* ---------------- popup shown when you click a shape on the map ---------------- */

// Built from DOM nodes so NWS text is never parsed as HTML.
export function alertPopup(a, style) {
  const root = document.createElement('div');
  root.className = 'max-w-xs p-1 font-sans text-gray-900';
  const h = document.createElement('h3');
  h.className = 'border-b pb-1 text-sm font-bold';
  h.style.color = style.color;
  h.textContent = LABELS[a.key] && a.key === 'Tornado Warning' ? a.event : a.key;
  const exp = document.createElement('p');
  exp.className = 'mt-1 text-[10px] font-semibold text-gray-500';
  exp.textContent = a.expires ? `Expires: ${new Date(a.expires).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  const body = document.createElement('div');
  body.className = 'mt-2 max-h-24 overflow-y-auto whitespace-pre-line rounded bg-gray-100 p-1.5 font-mono text-[11px] text-gray-700';
  body.textContent = a.description || a.headline || 'No summary available.';
  root.append(h, exp, body);
  return root;
}

/* ---------------- Current Alerts panel ---------------- */

const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function detailLines(a) {
  const P = (k) => (a.params[k] && a.params[k][0]) || '';
  const lines = [];
  if (P('maxWindGust')) lines.push(['Wind', P('maxWindGust')]);
  if (P('maxHailSize')) lines.push(['Hail', `${P('maxHailSize')} in`]);
  if (P('tornadoDetection')) lines.push(['Tornado', titleCase(P('tornadoDetection'))]);
  if (P('flashFloodDetection')) lines.push(['Flash flood', titleCase(P('flashFloodDetection'))]);
  const threat = P('tornadoDamageThreat') || P('thunderstormDamageThreat') || P('flashFloodDamageThreat');
  if (threat) lines.push(['Damage threat', titleCase(threat)]);
  return lines;
}

function timeLeft(iso) {
  const m = iso ? Math.round((new Date(iso) - Date.now()) / 60000) : NaN;
  if (Number.isNaN(m)) return '';
  if (m <= 0) return 'Expired';
  if (m < 60) return `Expires in ${m} minute${m === 1 ? '' : 's'}`;
  if (m < 24 * 60) return `Expires in ${Math.floor(m / 60)} hr ${m % 60} min`;
  return `Expires ${new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function AlertCard({ a, style, hasShape, hidden, onFocus }) {
  const [open, setOpen] = useState(false);
  const lines = detailLines(a);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/70 p-3 text-sm" style={{ borderLeft: `4px solid ${style.color}` }}>
      <p className="line-clamp-2 font-medium text-gray-100">{a.areaDesc}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] font-semibold">
        {a.states.map((s) => <span key={s} className="rounded bg-slate-700 px-1.5 py-0.5 text-gray-200">{s}</span>)}
        {a.sender && <span className="rounded bg-slate-700 px-1.5 py-0.5 text-gray-200">{a.sender}</span>}
      </div>
      {lines.map(([k, v]) => <p key={k} className="mt-1 text-xs text-gray-300">{k}: <span className="font-semibold text-gray-100">{v}</span></p>)}
      <p className="mt-1 text-xs text-gray-400">{timeLeft(a.expires)}</p>

      {open && (
        <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-line rounded bg-slate-900/70 p-2 font-mono text-[11px] text-gray-300">
          {a.description || a.headline}
          {a.instruction && `\n\n${a.instruction}`}
        </div>
      )}
      <div className="mt-2 flex gap-4 text-xs">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`text-blue-400 hover:underline ${focusRing}`}>{open ? 'Hide details' : 'Details'}</button>
        <button onClick={() => onFocus(a)} disabled={!hasShape} className={`text-blue-400 hover:underline disabled:text-gray-500 disabled:no-underline ${focusRing}`}>
          {hasShape ? 'Zoom to' : hidden ? 'Hidden on map' : 'No map shape'}
        </button>
      </div>
    </div>
  );
}

function CurrentAlertsPanel({ api, onClose, onOpenSettings, onFocus }) {
  const [filter, setFilter] = useState('all');
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 60000); return () => clearInterval(id); }, []); // keeps "expires in" fresh
  const shapeIds = useMemo(() => new Set(api.features.map((f) => f.id)), [api.features]);

  const sections = KINDS.filter(([k]) => filter === 'all' || filter === k).map(([kind, title]) => {
    const list = api.enabled.filter((a) => a.kind === kind);
    const groups = {};
    list.forEach((a) => { (groups[a.key] ||= []).push(a); });
    const ordered = Object.entries(groups).sort(([x], [y]) => drawRank(y, kind) - drawRank(x, kind) || x.localeCompare(y));
    return { kind, title, list, ordered };
  });

  return (
    <div className="absolute right-3 top-[4.5rem] z-[1100] flex max-h-[calc(100%-5.5rem)] w-[22rem] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 text-gray-200 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 className="text-lg font-semibold text-white">
          Current Alerts <span className="ml-1 rounded-full bg-slate-700 px-2 py-0.5 text-sm">{api.enabled.length}</span>
        </h2>
        <button onClick={onClose} aria-label="Close alerts" className={`rounded p-1 text-gray-400 hover:text-white ${focusRing}`}><Icon><path d="M6 6l12 12M18 6L6 18" /></Icon></button>
      </div>

      <div className="flex gap-2 px-4 py-3" role="radiogroup" aria-label="Alert type">
        {[['all', 'All'], ['warning', 'Warnings'], ['watch', 'Watches'], ['advisory', 'Advisories']].map(([k, label]) => (
          <button
            key={k} role="radio" aria-checked={filter === k} onClick={() => setFilter(k)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${filter === k ? 'bg-yellow-400 text-slate-900' : 'bg-slate-700 text-gray-200 hover:bg-slate-600'} ${focusRing}`}
          >
            {label}
          </button>
        ))}
      </div>

      <button onClick={onOpenSettings} className={`mx-4 mb-3 flex items-center justify-center gap-2 rounded-lg bg-slate-700 py-2 text-sm font-semibold text-yellow-300 hover:bg-slate-600 ${focusRing}`}>
        <Icon className="h-4 w-4"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></Icon>
        Alert Settings
      </button>

      <div className="flex-1 overflow-y-auto border-t border-slate-800 px-4 pb-4">
        {api.status === 'ERROR' && <p className="pt-3 text-sm text-red-400">{api.error}</p>}
        {api.status === 'LOADING' && <p className="pt-3 text-sm text-gray-400">Loading alerts...</p>}

        {sections.map(({ kind, title, list, ordered }) => (
          <section key={kind} className="border-b border-slate-800 py-3 last:border-0">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">{title} <span className="ml-1 rounded-full bg-slate-700 px-2 py-0.5 text-xs">{list.length}</span></h3>
              <button
                onClick={() => api.toggleKind(kind)} aria-pressed={!api.hidden.has(kind)}
                aria-label={api.hidden.has(kind) ? `Show ${title} on the map` : `Hide ${title} from the map`}
                title={api.hidden.has(kind) ? 'Hidden on the map' : 'Shown on the map'}
                className={`rounded p-1 ${api.hidden.has(kind) ? 'text-gray-500' : 'text-gray-200'} hover:text-white ${focusRing}`}
              >
                <Eye off={api.hidden.has(kind)} />
              </button>
            </div>
            {ordered.map(([key, items]) => {
              const style = api.styleOf(key);
              return (
                <div key={key} className="mt-2 space-y-2">
                  <p className="flex items-center gap-2 text-sm font-semibold text-gray-100">
                    <span className="h-3 w-3 shrink-0 rounded-sm border border-white/60" style={{ backgroundColor: style.color }} />
                    {LABELS[key] && key === 'Tornado Warning' ? 'Tornado Warning' : key}
                    <span className="rounded-full bg-slate-700 px-2 text-xs">{items.length}</span>
                  </p>
                  {items.map((a) => <AlertCard key={a.id} a={a} style={style} hasShape={shapeIds.has(a.id)} hidden={api.hidden.has(a.kind)} onFocus={onFocus} />)}
                </div>
              );
            })}
          </section>
        ))}

        {api.status === 'OK' && !api.enabled.length && (
          <p className="pt-3 text-sm text-gray-400">No active alerts for the types you've turned on. Open Alert Settings to choose more.</p>
        )}
        {api.updated && <p className="pt-2 text-[10px] text-gray-500">Live &middot; updated {api.updated.toLocaleTimeString()}</p>}
      </div>
    </div>
  );
}

/* ---------------- Alert Settings dialog ---------------- */

function RowControls({ k, api }) {
  const s = api.styleOf(k);
  return (
    <div className="space-y-3 border-t border-slate-700 bg-slate-800/40 px-4 py-3 text-xs text-gray-300">
      <label className="flex items-center justify-between">
        Color
        <input type="color" value={s.color} onChange={(e) => api.setStyle(k, { color: e.target.value })} className="h-7 w-16 cursor-pointer rounded border border-slate-600 bg-transparent" />
      </label>
      <label className="block">
        <span className="flex justify-between">Border thickness <span>{s.weight.toFixed(1)}px</span></span>
        <input type="range" min="0.5" max="8" step="0.5" value={s.weight} onChange={(e) => api.setStyle(k, { weight: Number(e.target.value) })} className="mt-1 w-full accent-blue-400" />
      </label>
      <label className="block">
        <span className="flex justify-between">Fill opacity <span>{Math.round(s.fill * 100)}%</span></span>
        <input type="range" min="0" max="1" step="0.05" value={s.fill} onChange={(e) => api.setStyle(k, { fill: Number(e.target.value) })} className="mt-1 w-full accent-blue-400" />
      </label>
      <button onClick={() => api.resetStyle(k)} className={`text-blue-400 hover:underline ${focusRing}`}>Reset to default</button>
    </div>
  );
}

function AlertSettings({ api, onClose }) {
  const [tab, setTab] = useState('Severe');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = useMemo(() => catalogRows([...new Set(api.all.map((a) => a.event))]), [api.all]);
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => (q ? r.label.toLowerCase().includes(q) : r.category === tab));
  const keys = shown.map((r) => r.key);

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 p-3" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Alert Settings" className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 text-gray-200 shadow-2xl">
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-2xl font-semibold text-white">Alert Settings</h2>
          <button onClick={onClose} aria-label="Close settings" className={`rounded p-1 text-gray-400 hover:text-white ${focusRing}`}><Icon className="h-6 w-6"><path d="M6 6l12 12M18 6L6 18" /></Icon></button>
        </div>

        <div className="mx-4 mt-3 flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/60 p-1">
          <div className="flex flex-1 gap-1 overflow-x-auto" role="tablist">
            {CATEGORIES.map((c) => (
              <button
                key={c} role="tab" aria-selected={!q && tab === c} onClick={() => { setTab(c); setQuery(''); setSearching(false); }}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium ${!q && tab === c ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-slate-700'} ${focusRing}`}
              >
                {c}
              </button>
            ))}
          </div>
          <button onClick={() => setSearching((s) => !s)} aria-label="Search alert types" aria-pressed={searching} className={`shrink-0 rounded-lg p-2 text-gray-300 hover:bg-slate-700 ${focusRing}`}>
            <Icon><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></Icon>
          </button>
        </div>

        {searching && (
          <input
            autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all alert types"
            className="mx-4 mt-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
          />
        )}

        <div className="mx-4 mt-2 flex items-center justify-between text-xs text-gray-400">
          <span>{shown.length} alert type{shown.length === 1 ? '' : 's'}{q ? ' found' : ` in ${tab}`}</span>
          <span className="flex gap-3">
            <button onClick={() => api.setMany(keys, true)} className={`text-blue-400 hover:underline ${focusRing}`}>All on</button>
            <button onClick={() => api.setMany(keys, false)} className={`text-blue-400 hover:underline ${focusRing}`}>All off</button>
          </span>
        </div>

        <div className="mt-2 flex-1 overflow-y-auto px-4 pb-4">
          {KINDS.map(([kind, title]) => {
            const list = shown.filter((r) => r.kind === kind);
            if (!list.length) return null;
            return (
              <section key={kind} className="mb-3 overflow-hidden rounded-lg">
                <h3 className="bg-slate-700/70 px-4 py-2 text-base font-semibold text-white">{title}</h3>
                {list.map((r) => {
                  const s = api.styleOf(r.key);
                  const expanded = open === r.key;
                  const n = api.counts[r.key];
                  return (
                    <div key={r.key} className="border-b border-slate-800 bg-slate-800/40 last:border-0">
                      <div className="flex items-center gap-3 px-4 py-3">
                        <span className="h-6 w-6 shrink-0 rounded border border-white/70" style={{ backgroundColor: s.color }} />
                        <span className="flex-1 text-sm font-medium text-gray-100">
                          {r.label}
                          {n > 0 && <span className="ml-2 rounded-full bg-orange-500 px-1.5 text-xs font-bold text-white">{n}</span>}
                        </span>
                        <Switch on={s.on} onChange={(on) => api.setStyle(r.key, { on })} label={`Show ${r.label}`} />
                        <button onClick={() => setOpen(expanded ? null : r.key)} aria-expanded={expanded} aria-label={`Style options for ${r.label}`} className={`rounded p-1 text-gray-400 hover:text-white ${focusRing}`}>
                          <Icon className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`}><path d="M9 6l6 6-6 6" /></Icon>
                        </button>
                      </div>
                      {expanded && <RowControls k={r.key} api={api} />}
                    </div>
                  );
                })}
              </section>
            );
          })}
          {!shown.length && <p className="py-6 text-center text-sm text-gray-500">No alert types match.</p>}
        </div>
      </div>
    </div>
  );
}

/* ---------------- the button in the top-right corner ---------------- */

export function AlertsControl({ api, onFocusBounds }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const focusAlert = (a) => {
    const f = api.features.find((x) => x.id === a.id);
    if (!f) return;
    const bounds = L.geoJSON(f).getBounds();
    if (bounds.isValid()) onFocusBounds(bounds);
  };

  return (
    <>
      <button
        onClick={() => setPanelOpen((o) => !o)} aria-label={`Current alerts (${api.enabled.length})`} aria-expanded={panelOpen}
        className={`absolute right-3 top-3 z-[1100] flex h-12 w-12 items-center justify-center rounded-full bg-yellow-400 text-slate-900 shadow-lg hover:bg-yellow-300 ${focusRing}`}
      >
        <Icon className="h-7 w-7"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /><path d="M12 9v4M12 17h.01" /></Icon>
        {api.enabled.length > 0 && (
          <span className="absolute -left-2 -top-1 min-w-[1.4rem] rounded-full bg-orange-500 px-1.5 text-center text-xs font-bold leading-6 text-white">{api.enabled.length}</span>
        )}
      </button>

      {panelOpen && (
        <CurrentAlertsPanel api={api} onClose={() => setPanelOpen(false)} onOpenSettings={() => setSettingsOpen(true)} onFocus={focusAlert} />
      )}
      {settingsOpen && <AlertSettings api={api} onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
