// One panel card per race. Header (course · off · race name · field
// size), then the top-yield runner pill with intensity bar + velocity
// arrow + edge. Aesthetic matches the rest of the Park: dark slate base,
// amber accents, monospace tracking-heavy labels.

import type { Race } from '../page'

export function RaceCard({ race }: { race: Race }) {
  const sig = race.signal
  const arrow = sig.velocity === 'up' ? '↑' : sig.velocity === 'down' ? '↓' : '→'
  const arrowColor =
    sig.velocity === 'up' ? 'text-emerald-400'
  : sig.velocity === 'down' ? 'text-rose-400'
  : 'text-slate-500'

  return (
    <article className="group border-2 border-amber-500/15 hover:border-amber-300/40 bg-slate-950/70 transition-colors">
      {/* Header */}
      <header className="flex items-baseline justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5">
        <div className="min-w-0 flex items-baseline gap-3 sm:gap-4">
          <span className="font-mono text-sm sm:text-base text-amber-300 tabular-nums whitespace-nowrap">
            {race.off_time || '—'}
          </span>
          <h3 className="font-black tracking-tight uppercase text-white text-base sm:text-lg truncate">
            {race.course || 'Unknown'}
          </h3>
        </div>
        <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-500 whitespace-nowrap">
          {race.field_size}-runner
        </span>
      </header>

      {/* Meta row */}
      <div className="px-4 sm:px-5 pt-1 pb-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] sm:text-[11px] tracking-[0.2em] uppercase text-slate-400">
        <span className="truncate max-w-full">{race.race_name || '—'}</span>
        {race.distance && <span className="text-slate-600">· {race.distance}</span>}
        {race.going    && <span className="text-slate-600">· {race.going}</span>}
        {race.type     && <span className="text-slate-600">· {race.type}</span>}
      </div>

      {/* Top-yield pill */}
      <div className="border-t border-amber-500/15 bg-slate-950/40 px-4 sm:px-5 py-3 sm:py-4">
        {sig.top_runner ? (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-center">
            <div className="min-w-0">
              <div className="font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-500 mb-1">
                top yield {sig.top_runner.number != null ? `· #${sig.top_runner.number}` : ''}
              </div>
              <div className="text-white font-bold text-sm sm:text-base truncate">
                {sig.top_runner.horse}
              </div>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed line-clamp-2">
                {sig.reasoning}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <IntensityBar value={sig.intensity} />
              <div className="flex items-center gap-2 font-mono text-[10px] sm:text-[11px] tabular-nums">
                <span className={arrowColor}>{arrow}</span>
                <span className="text-amber-300">
                  {sig.top_runner.edge_pct != null
                    ? `${sig.top_runner.edge_pct >= 0 ? '+' : ''}${sig.top_runner.edge_pct.toFixed(1)}%`
                    : '—'}
                </span>
              </div>
              <div className="font-mono text-[10px] text-slate-500 tabular-nums">
                {sig.top_runner.odds_decimal != null
                  ? `${sig.top_runner.odds_decimal.toFixed(2)} (fair ${sig.top_runner.fair_decimal?.toFixed(2) ?? '—'})`
                  : 'no price'}
              </div>
            </div>
          </div>
        ) : (
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase text-slate-600">
            no live prices yet
          </p>
        )}
      </div>

      {/* Footer / drill-in stub */}
      <footer className="border-t border-amber-500/10 px-4 sm:px-5 py-2 flex items-center justify-between font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-600">
        <span className="truncate">{race.race_id}</span>
        <button
          type="button"
          disabled
          aria-disabled
          title="full field coming soon"
          className="text-slate-700 cursor-not-allowed"
        >
          view field →
        </button>
      </footer>
    </article>
  )
}

function IntensityBar({ value }: { value: number }) {
  // 10-segment bar; segments fill amber up to value, dim past it.
  const segments = Array.from({ length: 10 }, (_, i) => i < value)
  return (
    <div
      role="meter"
      aria-valuenow={value}
      aria-valuemin={1}
      aria-valuemax={10}
      aria-label={`intensity ${value} of 10`}
      className="flex items-center gap-[2px]"
    >
      {segments.map((on, i) => (
        <span
          key={i}
          className={`block w-[6px] sm:w-[7px] h-3 sm:h-3.5 ${on ? 'bg-amber-400' : 'bg-slate-800'}`}
        />
      ))}
    </div>
  )
}
