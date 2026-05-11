// Vega's watchlist — commodity ETFs, leveraged indices, global macro.
// No biotech, no retail. Extracted so agent-brief can read it without
// depending on analyst-loop (which imports back into agent-brief).

export const WATCHLIST = {
  commodity: ['GLD', 'SLV', 'USO', 'GDX', 'UNG', 'CPER', 'PDBC'],
  leveraged: ['SPXL', 'TQQQ', 'UPRO', 'QLD', 'SOXL'],
  macro:     ['TLT', 'HYG', 'UUP', 'EEM', 'EFA', 'FXI', 'EWJ', 'VWO'],
}

export const WATCHLIST_ALL = [
  ...WATCHLIST.commodity,
  ...WATCHLIST.leveraged,
  ...WATCHLIST.macro,
]
