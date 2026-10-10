import { useState } from 'react';
import { WARNING_DEFAULTS, LABELS, mergeSaved } from './warningDefaults';

const KEY = 'warningStyles';

// Per-warning-type visibility, color, border thickness and fill opacity, remembered between visits.
export function useWarningStyles() {
  const [styles, setStyles] = useState(() => {
    try { return mergeSaved(JSON.parse(localStorage.getItem(KEY))); } catch { return mergeSaved(null); }
  });
  const save = (next) => {
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  };
  const update = (event, patch) => setStyles((s) => save({ ...s, [event]: { ...s[event], ...patch } }));
  const reset = (event) => setStyles((s) => save({ ...s, [event]: { ...WARNING_DEFAULTS[event], on: s[event].on } }));
  return { styles, update, reset };
}

const focus = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400';

export function WarningStylePanel({ styles, update, reset, counts, hasAlerts, updated }) {
  const [open, setOpen] = useState(null);

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-400">Warnings on map</p>
        {updated && <p className="text-[10px] text-gray-500">Live &middot; updated {updated.toLocaleTimeString()}</p>}
      </div>

      <div className="space-y-2">
        {Object.entries(styles).map(([event, s]) => {
          const expanded = open === event;
          return (
            <div key={event} className="overflow-hidden rounded-lg border border-slate-700 bg-slate-800/60">
              <div className="flex items-center gap-2 pr-3">
                <button
                  onClick={() => setOpen(expanded ? null : event)} aria-expanded={expanded}
                  className={`flex flex-1 items-center gap-2 px-3 py-2 text-left text-sm ${focus}`}
                >
                  <span className="h-4 w-4 shrink-0 rounded border border-white/70" style={{ backgroundColor: s.color }} />
                  <span className="flex-1 font-medium text-gray-100">{LABELS[event] || event}</span>
                  {hasAlerts && <span className="text-xs text-gray-500">({counts[event] || 0})</span>}
                </button>
                <button
                  role="switch" aria-checked={s.on} aria-label={`Show ${event}`} onClick={() => update(event, { on: !s.on })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${s.on ? 'bg-blue-500' : 'bg-slate-600'} ${focus}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${s.on ? 'left-[1.15rem]' : 'left-0.5'}`} />
                </button>
              </div>

              {expanded && (
                <div className="space-y-3 border-t border-slate-700 px-3 py-3 text-xs text-gray-300">
                  <label className="flex items-center justify-between">
                    Color
                    <input
                      type="color" value={s.color} onChange={(e) => update(event, { color: e.target.value })}
                      className="h-7 w-16 cursor-pointer rounded border border-slate-600 bg-transparent"
                    />
                  </label>
                  <label className="block">
                    <span className="flex justify-between">Border thickness <span>{s.weight.toFixed(1)}px</span></span>
                    <input
                      type="range" min="0.5" max="8" step="0.5" value={s.weight}
                      onChange={(e) => update(event, { weight: Number(e.target.value) })}
                      className="mt-1 w-full accent-blue-400"
                    />
                  </label>
                  <label className="block">
                    <span className="flex justify-between">Fill opacity <span>{Math.round(s.fill * 100)}%</span></span>
                    <input
                      type="range" min="0" max="1" step="0.05" value={s.fill}
                      onChange={(e) => update(event, { fill: Number(e.target.value) })}
                      className="mt-1 w-full accent-blue-400"
                    />
                  </label>
                  <button onClick={() => reset(event)} className={`text-blue-400 hover:underline ${focus}`}>Reset to default</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
