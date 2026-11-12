export type Candle = {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type MarketBundle = {
  symbol: string
  interval: string
  candles: Candle[]
  source: 'binance' | 'synthetic'
}

export type TunnelSample = {
  /** Progress along tunnel (0 = oldest / far, 1 = newest / near) */
  u: number
  time: number
  close: number
  open: number
  high: number
  low: number
  volume: number
  /** Macro trend slope (−1..1) */
  macroSlope: number
  /** Normalized volatility 0..1 */
  volatility: number
  /** Wick pressure left (support) / right (resistance) */
  supportWick: number
  resistWick: number
  /** Ceiling pressure (short-term selling) 0..1 */
  ceilingPressure: number
  /** Local peak / valley strength */
  peak: number
  valley: number
  /** Echo similarity to prior structure 0..1 */
  echo: number
  ghostBias: number
  /** 21-day simple moving average of daily closes, or null if unavailable */
  sma21: number | null
}

const BINANCE = 'https://api.binance.com/api/v3/klines'

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0] ?? 0
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i]! : values[i]! * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

function rollingStd(values: number[], period: number): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - period + 1)
    const slice = values.slice(start, i + 1)
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length
    const v = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length
    out.push(Math.sqrt(v))
  }
  return out
}

function normalize(values: number[], floor = 0.05): number[] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(1e-9, max - min)
  return values.map((v) => floor + ((v - min) / span) * (1 - floor))
}

/** Synthetic BTC-like path with cycles, traps, and consolidations. */
export function synthesizeCandles(count = 420, seed = 42): Candle[] {
  let s = seed
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }

  const candles: Candle[] = []
  let price = 64000
  const t0 = Date.now() - count * 15 * 60 * 1000

  for (let i = 0; i < count; i++) {
    const phase = i / count
    const macro = Math.sin(phase * Math.PI * 2.4) * 0.012
    const micro = Math.sin(phase * Math.PI * 18) * 0.004
    const shock = rand() > 0.97 ? (rand() - 0.5) * 0.04 : 0
    const drift = macro + micro + shock + (rand() - 0.48) * 0.003
    const o = price
    const c = Math.max(1000, price * (1 + drift))
    const wickUp = Math.abs(rand() - 0.35) * price * 0.006
    const wickDn = Math.abs(rand() - 0.4) * price * 0.006
    const h = Math.max(o, c) + wickUp
    const l = Math.min(o, c) - wickDn
    const v = 40 + rand() * 220 + Math.abs(drift) * 8000
    candles.push({ t: t0 + i * 15 * 60 * 1000, o, h, l, c, v })
    price = c
  }
  return candles
}

/** Lightweight poll for the live price road (defaults to 1m for faster ticks). */
export async function pollLiveCandles(
  symbol = 'BTCUSDT',
  interval = '1m',
  limit = 60,
): Promise<Candle[]> {
  try {
    const url = `${BINANCE}?symbol=${symbol}&interval=${interval}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`binance ${res.status}`)
    const raw = (await res.json()) as unknown[]
    return raw.map((row) => {
      const r = row as (string | number)[]
      return {
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
      }
    })
  } catch {
    return synthesizeCandles(limit, Date.now() % 100000)
  }
}

export async function loadMarket(
  symbol = 'BTCUSDT',
  interval = '15m',
  limit = 500,
): Promise<MarketBundle> {
  try {
    const url = `${BINANCE}?symbol=${symbol}&interval=${interval}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`binance ${res.status}`)
    const raw = (await res.json()) as unknown[]
    const candles: Candle[] = raw.map((row) => {
      const r = row as (string | number)[]
      return {
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
      }
    })
    if (candles.length < 32) throw new Error('too few candles')
    return { symbol, interval, candles, source: 'binance' }
  } catch {
    return {
      symbol,
      interval,
      candles: synthesizeCandles(limit),
      source: 'synthetic',
    }
  }
}

export function buildSamples(candles: Candle[]): TunnelSample[] {
  const closes = candles.map((c) => c.c)
  const vols = candles.map((c) => c.v)
  const macro = ema(closes, 48)
  const fast = ema(closes, 8)
  const volSeries = rollingStd(
    closes.map((c, i) => (i ? (c - closes[i - 1]!) / closes[i - 1]! : 0)),
    14,
  )
  const volN = normalize(volSeries)
  const voluN = normalize(vols)

  const samples: TunnelSample[] = []
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!
    const m0 = macro[Math.max(0, i - 6)]!
    const m1 = macro[i]!
    const macroSlope = Math.tanh(((m1 - m0) / m0) * 40)
    const range = Math.max(1e-9, c.h - c.l)
    const supportWick = (Math.min(c.o, c.c) - c.l) / range
    const resistWick = (c.h - Math.max(c.o, c.c)) / range
    const ceilingPressure = Math.min(
      1,
      resistWick * 0.65 + Math.max(0, -macroSlope) * 0.35 + volN[i]! * 0.2,
    )

    // Local extrema via neighborhood
    let peak = 0
    let valley = 0
    if (i > 2 && i < candles.length - 2) {
      const win = closes.slice(i - 2, i + 3)
      const hi = Math.max(...win)
      const lo = Math.min(...win)
      if (c.h >= hi * 0.999) peak = resistWick
      if (c.l <= lo * 1.001) valley = supportWick
    }

    // Echo: similarity of recent window to earlier window
    let echo = 0
    if (i > 40) {
      const a = closes.slice(i - 12, i)
      const b = closes.slice(i - 36, i - 24)
      if (a.length === 12 && b.length === 12) {
        const na = normalize(a, 0)
        const nb = normalize(b, 0)
        let d = 0
        for (let k = 0; k < 12; k++) d += Math.abs(na[k]! - nb[k]!)
        echo = Math.max(0, 1 - d / 6)
      }
    }

    const momentum = Math.tanh(((fast[i]! - macro[i]!) / macro[i]!) * 55)
    const ghostBias = Math.max(
      -1,
      Math.min(1, macroSlope * 0.55 + momentum * 0.35 - ceilingPressure * 0.25),
    )

    samples.push({
      u: candles.length <= 1 ? 0 : i / (candles.length - 1),
      time: c.t,
      close: c.c,
      open: c.o,
      high: c.h,
      low: c.l,
      volume: voluN[i]!,
      macroSlope,
      volatility: volN[i]!,
      supportWick,
      resistWick,
      ceilingPressure,
      peak,
      valley,
      echo,
      ghostBias,
      sma21: null,
    })
  }
  return samples
}

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= period) sum -= values[i - period]!
    out.push(i >= period - 1 ? sum / period : null)
  }
  return out
}

/** Daily 21-SMA points (candle open time → average). Null when the daily feed is unavailable. */
export async function loadDailySma21(
  symbol = 'BTCUSDT',
): Promise<{ t: number; sma: number }[] | null> {
  try {
    const url = `${BINANCE}?symbol=${symbol}&interval=1d&limit=80`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`binance ${res.status}`)
    const raw = (await res.json()) as unknown[]
    const candles = raw.map((row) => {
      const r = row as (string | number)[]
      return { t: Number(r[0]), c: Number(r[4]) }
    })
    const series = sma(
      candles.map((c) => c.c),
      21,
    )
    const points = candles
      .map((c, i) => (series[i] == null ? null : { t: c.t, sma: series[i]! }))
      .filter((p): p is { t: number; sma: number } => p != null)
    return points.length ? points : null
  } catch {
    return null
  }
}

/** Stamp each tunnel sample with the 21-day SMA in effect at that time. */
export function applySma21(samples: TunnelSample[], points: { t: number; sma: number }[] | null) {
  if (!points?.length) {
    for (const s of samples) s.sma21 = null
    return
  }
  let j = 0
  for (const s of samples) {
    while (j + 1 < points.length && points[j + 1]!.t <= s.time) j++
    s.sma21 = points[j]!.t <= s.time ? points[j]!.sma : null
  }
}

export function formatPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return n.toPrecision(4)
}

export function biasLabel(bias: number): { text: string; tone: 'bull' | 'bear' | 'chaos' } {
  if (bias > 0.22) return { text: 'Bullish ghost path', tone: 'bull' }
  if (bias < -0.22) return { text: 'Bearish ghost path', tone: 'bear' }
  return { text: 'Chaos / low conviction', tone: 'chaos' }
}
