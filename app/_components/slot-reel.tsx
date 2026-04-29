'use client'

import { useEffect, useRef, useState } from 'react'

interface Props {
  final: string
  fakes: string[]
  delay?: number
  duration?: number
  className?: string
}

export default function SlotReel({ final, fakes, delay = 0, duration = 1400, className = '' }: Props) {
  const [display, setDisplay] = useState<string>(fakes[0] ?? final)
  const [settled, setSettled] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let cancelled = false
    let t: ReturnType<typeof setTimeout> | null = null

    const start = Date.now()
    let interval = 38

    const tick = () => {
      if (cancelled) return
      const elapsed = Date.now() - start
      if (elapsed >= duration) {
        setDisplay(final)
        setSettled(true)
        return
      }
      const idx = Math.floor(Math.random() * fakes.length)
      setDisplay(fakes[idx] ?? final)
      const k = elapsed / duration
      interval = 32 + k * k * 220
      t = setTimeout(tick, interval)
    }

    const startTimer = setTimeout(tick, delay)
    return () => {
      cancelled = true
      clearTimeout(startTimer)
      if (t) clearTimeout(t)
    }
  }, [final, fakes, delay, duration])

  return (
    <span
      ref={ref}
      data-settled={settled}
      className={`inline-block tabular-nums transition-[color,text-shadow] duration-300 ${
        settled ? '' : 'text-amber-300/90'
      } ${className}`}
    >
      {display}
    </span>
  )
}
