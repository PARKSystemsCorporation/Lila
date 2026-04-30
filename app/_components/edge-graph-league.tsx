'use client'

import { EdgeGraphLarge, useEdgeGraph, type Sport } from './edge-graph'

interface Props {
  sport: Sport
  tone?: 'amber' | 'orange' | 'red'
}

export default function LeagueEdgeGraph({ sport, tone = 'amber' }: Props) {
  const { payload, live } = useEdgeGraph()
  const series = payload.sports[sport]
  return <EdgeGraphLarge series={series} tone={tone} live={live[sport]} />
}
