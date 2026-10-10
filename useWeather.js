import { useEffect, useState } from 'react';

const NWS = 'https://api.weather.gov';
const get = (url, signal) =>
  fetch(url, { signal, headers: { Accept: 'application/geo+json' } }).then((r) => {
    if (!r.ok) throw new Error(r.status === 404 ? 'NWS has no data for this point (US only)' : `NWS error ${r.status}`);
    return r.json();
  });

const cToF = (c) => (c == null ? null : Math.round((c * 9) / 5 + 32));
const kmhToMph = (k) => (k == null ? null : Math.round(k * 0.621371));

/** Forecast, hourly, current conditions and active alerts for { lat, lon } from api.weather.gov. */
export function useWeather(loc) {
  const [weather, setWeather] = useState({ status: 'IDLE' });

  useEffect(() => {
    if (!loc) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;

    const load = async (first) => {
      if (first) setWeather({ status: 'LOADING' });
      try {
        const pt = (await get(`${NWS}/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`, signal)).properties;
        const [daily, hourly, alerts, obs] = await Promise.all([
          get(pt.forecast, signal),
          get(pt.forecastHourly, signal),
          get(`${NWS}/alerts/active?point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`, signal),
          get(pt.observationStations, signal)
            .then((st) => {
              const id = st.features?.[0]?.properties?.stationIdentifier;
              return id ? get(`${NWS}/stations/${id}/observations/latest`, signal) : null;
            })
            .catch(() => null), // current obs are a nice-to-have
        ]);
        const o = obs?.properties;
        setWeather({
          status: 'OK',
          place: `${pt.relativeLocation.properties.city}, ${pt.relativeLocation.properties.state}`,
          radarStation: pt.radarStation,
          daily: daily.properties.periods,
          hourly: hourly.properties.periods.slice(0, 12),
          alerts: alerts.features.map((f) => f.properties),
          now: o && {
            tempF: cToF(o.temperature?.value),
            text: o.textDescription,
            humidity: o.relativeHumidity?.value != null ? Math.round(o.relativeHumidity.value) : null,
            windMph: kmhToMph(o.windSpeed?.value),
            time: o.timestamp,
          },
        });
      } catch (e) {
        if (e.name !== 'AbortError') setWeather((w) => ({ ...w, status: 'ERROR', error: e.message }));
      }
    };

    load(true);
    const id = setInterval(() => load(false), 10 * 60e3);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [loc?.lat, loc?.lon]);

  // Alerts change fast, so they get their own once-a-minute refresh (and one when you return to the tab).
  useEffect(() => {
    if (!loc) return;
    const ctrl = new AbortController();
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      get(`${NWS}/alerts/active?point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`, ctrl.signal)
        .then((r) => setWeather((w) => (w.status === 'OK' ? { ...w, alerts: r.features.map((f) => f.properties) } : w)))
        .catch(() => {}); // keep the last good alerts
    };
    const id = setInterval(poll, 60000);
    document.addEventListener('visibilitychange', poll);
    return () => { ctrl.abort(); clearInterval(id); document.removeEventListener('visibilitychange', poll); };
  }, [loc?.lat, loc?.lon]);

  return weather;
}
