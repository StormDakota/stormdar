const SEVERITY = {
  Tornado: 'border-red-700 bg-red-900/40 text-red-200',
  Severe: 'border-yellow-700 bg-yellow-900/30 text-yellow-200',
};
const alertStyle = (event) =>
  Object.entries(SEVERITY).find(([k]) => event.includes(k))?.[1] || 'border-slate-600 bg-slate-800 text-gray-200';

const hourLabel = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric' });

export default function WeatherPanel({ weather, locating, geoError, onUseLocation }) {
  const { status, place, now, alerts = [], hourly = [], daily = [], error } = weather;

  if (status === 'IDLE') {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-sm">
        <p className="font-semibold text-white">See the weather where you are</p>
        <p className="mt-1 text-gray-400">Use your location, or click anywhere on the map.</p>
        <button
          onClick={onUseLocation}
          disabled={locating}
          className="mt-3 w-full rounded-lg bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
        >
          {locating ? 'Finding you...' : 'Use my location'}
        </button>
        {geoError && <p className="mt-2 text-xs text-red-400">{geoError}</p>}
      </div>
    );
  }

  if (status === 'LOADING') return <p className="text-sm text-gray-400">Loading forecast...</p>;
  if (status === 'ERROR' && !daily.length) return <p className="text-sm text-red-400">{error}</p>;

  const temp = now?.tempF ?? hourly[0]?.temperature;
  return (
    <div className="space-y-4">
      <section>
        <div className="flex items-start justify-between">
          <p className="text-sm text-gray-400">{place}</p>
          <button onClick={onUseLocation} className="text-xs text-blue-400 hover:underline">Use my location</button>
        </div>
        <p className="text-5xl font-light text-white">{temp}&deg;</p>
        <p className="text-sm text-gray-300">{now?.text || hourly[0]?.shortForecast}</p>
        <p className="mt-1 text-xs text-gray-400">
          {now?.humidity != null && `Humidity ${now.humidity}%`}
          {now?.windMph != null && ` · Wind ${now.windMph} mph`}
        </p>
      </section>

      {alerts.length > 0 && (
        <section className="space-y-2">
          {alerts.map((a) => (
            <div key={a.id} className={`rounded-lg border p-2 text-xs ${alertStyle(a.event)}`}>
              <p className="font-semibold">{a.event}</p>
              <p className="mt-0.5 line-clamp-3 opacity-90">{a.headline}</p>
            </div>
          ))}
        </section>
      )}

      <section>
        <p className="mb-1 text-xs font-semibold text-gray-400">Next 12 hours</p>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {hourly.map((h) => (
            <div key={h.startTime} className="min-w-[3rem] text-center text-xs">
              <p className="text-gray-400">{hourLabel(h.startTime)}</p>
              <p className="text-sm font-medium text-white">{h.temperature}&deg;</p>
              <p className="text-sky-400">{h.probabilityOfPrecipitation?.value ?? 0}%</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <p className="mb-1 text-xs font-semibold text-gray-400">Forecast</p>
        <ul className="divide-y divide-slate-800">
          {daily.slice(0, 10).map((p) => (
            <li key={p.number} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-gray-100">{p.name}</p>
                <p className="truncate text-xs text-gray-400">{p.shortForecast}</p>
              </div>
              <p className="shrink-0 text-white">
                {p.temperature}&deg;
                <span className="ml-2 text-xs text-sky-400">{p.probabilityOfPrecipitation?.value ?? 0}%</span>
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
