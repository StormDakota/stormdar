import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { drawRank, hash, layerStyle, normalize, resolveStyle, toFeature } from './alertCatalog';

const ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
const POLL_MS = 60000;
const MAX_ZONES = 200; // alerts covering more zones than this are listed but not drawn

/* ---------------- settings: which alert types are on, their looks, hidden groups ---------------- */

const STORE = 'alertSettings';

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && typeof s === 'object') return { styles: s.styles || {}, hiddenKinds: Array.isArray(s.hiddenKinds) ? s.hiddenKinds : [] };
    const legacy = JSON.parse(localStorage.getItem('warningStyles')); // keep choices made before alert settings existed
    if (legacy && typeof legacy === 'object') return { styles: legacy, hiddenKinds: [] };
  } catch { /* fall through to defaults */ }
  return { styles: {}, hiddenKinds: [] };
}

function useAlertSettings() {
  const [settings, setSettings] = useState(loadSettings);
  const change = (fn) =>
    setSettings((s) => {
      const next = fn(s);
      try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });

  const styleOf = useCallback((key) => resolveStyle(key, settings.styles[key]), [settings.styles]);
  const setStyle = (key, patch) => change((s) => ({ ...s, styles: { ...s.styles, [key]: { ...s.styles[key], ...patch } } }));
  const resetStyle = (key) =>
    change((s) => {
      const { on } = s.styles[key] || {};
      const styles = { ...s.styles };
      if (on === undefined) delete styles[key]; else styles[key] = { on }; // keep the on/off choice, drop the look
      return { ...s, styles };
    });
  const setMany = (keys, on) =>
    change((s) => ({ ...s, styles: { ...s.styles, ...Object.fromEntries(keys.map((k) => [k, { ...s.styles[k], on }])) } }));
  const toggleKind = (kind) =>
    change((s) => ({ ...s, hiddenKinds: s.hiddenKinds.includes(kind) ? s.hiddenKinds.filter((k) => k !== kind) : [...s.hiddenKinds, kind] }));

  return { settings, styleOf, setStyle, resetStyle, setMany, toggleKind };
}

/* ---------------- all active NWS alerts, re-checked every minute ---------------- */

function useActiveAlerts() {
  const [state, setState] = useState({ status: 'LOADING', alerts: [], sig: '', updated: null, error: '' });

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetch(ALERTS_URL, { signal: ctrl.signal, headers: { Accept: 'application/geo+json' } })
        .then((r) => { if (!r.ok) throw new Error(`NWS error ${r.status}`); return r.json(); })
        .then((d) => {
          const alerts = (d.features || []).map(normalize);
          const sig = hash(alerts.map((a) => a.id).sort().join('|'));
          // Unchanged set: keep the same array so nothing downstream redraws.
          setState((prev) => ({ status: 'OK', alerts: prev.sig === sig ? prev.alerts : alerts, sig, updated: new Date(), error: '' }));
        })
        .catch((e) => {
          if (e.name !== 'AbortError') setState((s) => ({ ...s, status: s.alerts.length ? 'OK' : 'ERROR', error: e.message })); // keep last good data
        });
    const whenVisible = () => { if (document.visibilityState === 'visible') load(); };
    load();
    const id = setInterval(whenVisible, POLL_MS);
    document.addEventListener('visibilitychange', whenVisible);
    return () => { ctrl.abort(); clearInterval(id); document.removeEventListener('visibilitychange', whenVisible); };
  }, []);

  return state;
}

/* ---------------- everything the UI and the map need ---------------- */

export function useAlerts() {
  const cfg = useAlertSettings();
  const feed = useActiveAlerts();
  const { styleOf } = cfg;
  const hidden = useMemo(() => new Set(cfg.settings.hiddenKinds), [cfg.settings.hiddenKinds]);

  const enabled = useMemo(() => feed.alerts.filter((a) => styleOf(a.key).on), [feed.alerts, styleOf]); // types you switched on
  const onMap = useMemo(() => enabled.filter((a) => !hidden.has(a.kind)), [enabled, hidden]);        // minus hidden groups

  // County/zone alerts have no polygon of their own: fetch their zone shapes once (the server caches them).
  const zoneCache = useRef(new Map());
  const pending = useRef(new Set());
  const [zoneVersion, setZoneVersion] = useState(0);

  useEffect(() => {
    const need = new Set();
    for (const a of onMap) {
      if (a.geometry || a.zones.length > MAX_ZONES) continue;
      for (const z of a.zones) if (!zoneCache.current.has(z) && !pending.current.has(z)) need.add(z);
    }
    if (!need.size) return;
    const list = [...need];
    list.forEach((z) => pending.current.add(z));
    (async () => {
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        try {
          const r = await fetch(`/api/zones?z=${chunk.join(',')}`);
          const j = await r.json();
          for (const z of chunk) if (j.geometries && z in j.geometries) zoneCache.current.set(z, j.geometries[z]); // missing = try again later
        } catch { /* try again on the next check */ }
        chunk.forEach((z) => pending.current.delete(z));
        setZoneVersion((v) => v + 1);
      }
    })();
  }, [onMap]);

  const features = useMemo(
    () => onMap.map((a) => toFeature(a, zoneCache.current)).filter(Boolean)
      .sort((x, y) => drawRank(x.properties.key, x.properties.kind) - drawRank(y.properties.key, y.properties.kind)),
    [onMap, zoneVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const sig = useMemo(() => hash(features.map((f) => f.id).sort().join('|')), [features]);

  const lookupRef = useRef({});
  lookupRef.current = { byId: new Map(feed.alerts.map((a) => [a.id, a])), styleOf };
  const popupInfo = useCallback((id) => {
    const a = lookupRef.current.byId.get(id);
    return a ? { alert: a, style: lookupRef.current.styleOf(a.key) } : null;
  }, []);

  const layer = useMemo(() => layerStyle(styleOf), [styleOf]);
  const counts = useMemo(() => {
    const c = {};
    for (const a of feed.alerts) c[a.key] = (c[a.key] || 0) + 1;
    return c;
  }, [feed.alerts]);

  return {
    ...cfg, hidden, popupInfo, layerStyle: layer, counts, features, sig,
    all: feed.alerts, enabled, status: feed.status, error: feed.error, updated: feed.updated,
  };
}
