import { useEffect, useState } from 'react';
import { buildLegend, parseSpcTime, riskAt } from './outlookUtils';

const TYPE_LABELS = { cat: 'Categorical', torn: 'Tornado', wind: 'Wind', hail: 'Hail', prob: 'Severe probability' };
export const typesFor = (day) => (day === 3 ? ['cat', 'prob'] : ['cat', 'torn', 'wind', 'hail']);

// SPC convective outlook for day 1-3 (day 0 = off), via the local server. Re-checked every 10 minutes.
export function useOutlook(day, type) {
  const [state, setState] = useState({ status: 'OFF', data: null, sig: '' });

  useEffect(() => {
    if (!day) { setState({ status: 'OFF', data: null, sig: '' }); return; }
    const ctrl = new AbortController();
    setState({ status: 'LOADING', data: null, sig: '' });
    const load = () =>
      fetch(`/api/outlook/${day}/${type}`, { signal: ctrl.signal })
        .then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          return j;
        })
        .then((data) => {
          const p = data.features?.[0]?.properties || {};
          const sig = `${p.ISSUE ?? ''}-${data.features?.length ?? 0}`;
          setState((s) => (s.sig === sig && s.status === 'OK' ? s : { status: 'OK', data, sig })); // unchanged: keep layer
        })
        .catch((e) => { if (e.name !== 'AbortError') setState((s) => ({ ...s, status: 'ERROR', error: e.message })); });
    load();
    const id = setInterval(load, 10 * 60e3);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [day, type]);

  return state;
}

const fmt = (d) => d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function OutlookPanel({ day, type, setDay, setType, outlook, loc }) {
  const { status, data, error } = outlook;
  const p = data?.features?.[0]?.properties || {};
  const from = parseSpcTime(p.VALID), to = parseSpcTime(p.EXPIRE);
  const legend = buildLegend(data);
  const risk = type === 'cat' ? riskAt(data, loc) : null;

  const pill = (on) =>
    `rounded-lg border px-3 py-1.5 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
      on ? 'border-blue-400 bg-blue-600 text-white' : 'border-slate-700 bg-slate-800 text-gray-300 hover:bg-slate-700'
    }`;

  return (
    <div className="space-y-4">
      <section>
        <p className="mb-1 text-xs font-semibold text-gray-400">Convective outlook (SPC)</p>
        <div className="flex gap-2" role="radiogroup" aria-label="Outlook day">
          {[0, 1, 2, 3].map((d) => (
            <button
              key={d} role="radio" aria-checked={day === d} className={`${pill(day === d)} flex-1`}
              onClick={() => { setDay(d); if (d && !typesFor(d).includes(type)) setType('cat'); }}
            >
              {d === 0 ? 'Off' : `Day ${d}`}
            </button>
          ))}
        </div>
      </section>

      {day > 0 && (
        <section className="flex flex-wrap gap-2" role="radiogroup" aria-label="Outlook type">
          {typesFor(day).map((t) => (
            <button key={t} role="radio" aria-checked={type === t} className={pill(type === t)} onClick={() => setType(t)}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </section>
      )}

      {day === 0 && <p className="text-sm text-gray-400">Pick a day to draw the outlook on the map.</p>}
      {status === 'LOADING' && <p className="text-sm text-gray-400">Loading outlook...</p>}
      {status === 'ERROR' && <p className="text-sm text-red-400">{error}</p>}

      {status === 'OK' && (
        <>
          {data.features?.length ? (
            <>
              {from && to && <p className="text-xs text-gray-400">Valid {fmt(from)} to {fmt(to)}</p>}
              {p.FORECASTER && <p className="text-xs text-gray-500">Forecaster: {p.FORECASTER}</p>}

              {type === 'cat' && (
                <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm">
                  {!loc ? (
                    <p className="text-gray-400">Use "Use my location" on the Radar tab to see your risk here.</p>
                  ) : risk ? (
                    <p><span className="text-gray-400">At your location: </span><span className="font-semibold text-white">{risk.label}</span></p>
                  ) : (
                    <p className="text-gray-400">Nothing outlooked at your location.</p>
                  )}
                </div>
              )}

              <ul className="space-y-1.5">
                {legend.map((l) => (
                  <li key={l.label} className="flex items-center gap-2 text-sm">
                    <span className="h-3 w-5 rounded-sm border border-slate-600" style={{ backgroundColor: l.fill }} />
                    {l.label}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-gray-400">No areas outlooked for this period.</p>
          )}
        </>
      )}
    </div>
  );
}
