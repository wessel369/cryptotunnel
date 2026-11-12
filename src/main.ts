import './style.css'
import { TunnelWorld } from './scene/TunnelWorld'
import {
  biasLabel,
  buildSamples,
  formatPrice,
  applySma21,
  loadDailySma21,
  loadMarket,
  pollLiveCandles,
} from './data/market'
import { VIEW_META, type ViewMode } from './camera/rig'

const PRIMARY = (Object.keys(VIEW_META) as ViewMode[]).filter((v) => VIEW_META[v].primary)
const EXTRA = (Object.keys(VIEW_META) as ViewMode[]).filter((v) => !VIEW_META[v].primary)

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <canvas id="viewport"></canvas>
  <div class="hud">
    <header class="brand">
      <h1>Tunnel Vision</h1>
      <p id="subtitle">Loading…</p>
    </header>

    <aside class="price-card" id="priceCard"></aside>

    <div class="coach" id="coach">
      <p id="coachText"></p>
      <button type="button" id="coachDismiss" class="ghost">Got it</button>
    </div>

    <div class="dock">
      <section class="controls">
        <div class="title">Where am I looking?</div>
        <div class="actions views" id="primaryViews"></div>
        <div class="actions views extras hidden" id="extraViews"></div>
        <p class="view-blurb" id="viewBlurb"></p>
        <div class="actions compact">
          <button type="button" id="toggleExtra" class="ghost">More angles</button>
          <button type="button" id="toggleAdvanced" class="ghost">Camera fine-tune</button>
        </div>

        <div class="simple-sliders">
          <div class="slider">
            <label for="progress">Through time</label>
            <input id="progress" type="range" min="0" max="1000" value="970" />
            <span class="val" id="progressVal">now</span>
          </div>
          <div class="slider">
            <label for="look">Look up / down</label>
            <input id="look" type="range" min="-100" max="100" value="0" />
            <span class="val" id="lookVal">level</span>
          </div>
          <div class="slider">
            <label for="zoom">Closer / farther</label>
            <input id="zoom" type="range" min="0" max="250" value="28" />
            <span class="val" id="zoomVal">near</span>
          </div>
          <div class="slider">
            <label for="turn">Turn</label>
            <input id="turn" type="range" min="-100" max="100" value="22" />
            <span class="val" id="turnVal">right</span>
          </div>
        </div>

        <div class="advanced hidden" id="advanced">
          <div class="title">Fine-tune</div>
          <div class="sliders" id="camSliders"></div>
          <div class="slider">
            <label for="velocity">Travel speed</label>
            <input id="velocity" type="range" min="0" max="150" value="35" />
            <span class="val" id="velocityVal">0.35</span>
          </div>
        </div>

        <div class="actions">
          <button type="button" id="echo">Show echo</button>
          <button type="button" id="laser">Measure</button>
          <button type="button" id="resetCam">Reset view</button>
          <button type="button" id="reload">Refresh data</button>
        </div>
      </section>

      <aside class="guide" id="guide">
        <strong>How to read it</strong>
        <ul>
          <li><span class="swatch up"></span> Tentacle body → price through time</li>
          <li><span class="swatch down"></span> Tip reach → where market is aiming</li>
          <li><span class="swatch jag"></span> Cyan / red ridges → support vs resistance</li>
          <li><span class="swatch live"></span> Live road hills → 1m · tunnel → 15m</li>
          <li><span class="swatch ma"></span> Gold line → 21-day average</li>
        </ul>
        <p class="keys">W/S time · scroll zoom · A/D look · Q/E turn</p>
      </aside>
    </div>
  </div>
`

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!
const world = new TunnelWorld(canvas)

const subtitle = document.querySelector('#subtitle')!
const priceCard = document.querySelector('#priceCard')!
const coach = document.querySelector('#coach')!
const coachText = document.querySelector('#coachText')!
const coachDismiss = document.querySelector('#coachDismiss')!
const primaryViews = document.querySelector('#primaryViews')!
const extraViews = document.querySelector('#extraViews')!
const viewBlurb = document.querySelector('#viewBlurb')!
const camSliders = document.querySelector('#camSliders')!
const advanced = document.querySelector('#advanced')!
const toggleExtra = document.querySelector('#toggleExtra')!
const toggleAdvanced = document.querySelector('#toggleAdvanced')!
const progressEl = document.querySelector<HTMLInputElement>('#progress')!
const lookEl = document.querySelector<HTMLInputElement>('#look')!
const zoomEl = document.querySelector<HTMLInputElement>('#zoom')!
const turnEl = document.querySelector<HTMLInputElement>('#turn')!
const velocityEl = document.querySelector<HTMLInputElement>('#velocity')!
const progressVal = document.querySelector('#progressVal')!
const lookVal = document.querySelector('#lookVal')!
const zoomVal = document.querySelector('#zoomVal')!
const turnVal = document.querySelector('#turnVal')!
const velocityVal = document.querySelector('#velocityVal')!
const laserBtn = document.querySelector('#laser')!
const echoBtn = document.querySelector('#echo')!
const resetCamBtn = document.querySelector('#resetCam')!
const reloadBtn = document.querySelector('#reload')!

type SliderDef = {
  key: keyof ReturnType<typeof world.getState>['controls']
  label: string
  min: number
  max: number
  step: number
  format: (v: number) => string
}

const ADV_SLIDERS: SliderDef[] = [
  { key: 'height', label: 'Camera height', min: -100, max: 100, step: 1, format: (v) => v.toFixed(2) },
  { key: 'fov', label: 'Lens width', min: 35, max: 100, step: 1, format: (v) => `${Math.round(v)}°` },
  { key: 'lag', label: 'Camera smoothness', min: 0, max: 100, step: 1, format: (v) => v.toFixed(2) },
  { key: 'lookAhead', label: 'Look farther ahead', min: 0, max: 100, step: 1, format: (v) => v.toFixed(2) },
  { key: 'orbit', label: 'Auto spin (off=0)', min: 0, max: 100, step: 1, format: (v) => (v < 0.02 ? 'off' : v.toFixed(2)) },
  { key: 'roll', label: 'Banking', min: 0, max: 100, step: 1, format: (v) => v.toFixed(2) },
  { key: 'tilt', label: 'Dutch tilt', min: -100, max: 100, step: 1, format: (v) => v.toFixed(2) },
]

const sliderEls = new Map<string, { input: HTMLInputElement; val: HTMLSpanElement }>()

function unitToInput(key: string, v: number) {
  if (key === 'fov') return v
  return Math.round(v * 100)
}

function inputToUnit(key: string, raw: number) {
  if (key === 'fov') return raw
  return raw / 100
}

for (const def of ADV_SLIDERS) {
  const row = document.createElement('div')
  row.className = 'slider'
  row.innerHTML = `
    <label for="cam-${def.key}">${def.label}</label>
    <input id="cam-${def.key}" type="range" min="${def.min}" max="${def.max}" step="${def.step}" />
    <span class="val"></span>
  `
  camSliders.appendChild(row)
  const input = row.querySelector<HTMLInputElement>('input')!
  const val = row.querySelector<HTMLSpanElement>('.val')!
  sliderEls.set(def.key, { input, val })
  input.addEventListener('input', () => {
    const v = inputToUnit(def.key, Number(input.value))
    world.setControls({ [def.key]: v })
    val.textContent = def.format(v)
  })
}

const viewButtons = new Map<ViewMode, HTMLButtonElement>()

function addViewButton(view: ViewMode, parent: Element) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = VIEW_META[view].label
  btn.title = VIEW_META[view].blurb
  if (view === 'live') btn.classList.add('active')
  parent.appendChild(btn)
  viewButtons.set(view, btn)
  btn.addEventListener('click', () => setView(view))
}

for (const v of PRIMARY) addViewButton(v, primaryViews)
for (const v of EXTRA) addViewButton(v, extraViews)

const TUNNEL_TF = '15m'
const LIVE_TF = '1m'

let liveTimer: number | null = null
let liveSymbol = 'BTCUSDT'
let tunnelInterval = TUNNEL_TF
let liveInterval = LIVE_TF
let lastTickAt = 0
let lastClose = 0
let syncingSliders = false

function tfLabel(interval: string) {
  const m = interval.match(/^(\d+)([mhdw])$/i)
  if (!m) return interval
  const n = Number(m[1])
  const u = m[2]!.toLowerCase()
  const unit =
    u === 'm' ? (n === 1 ? 'minute' : 'minutes') : u === 'h' ? (n === 1 ? 'hour' : 'hours') : u === 'd' ? (n === 1 ? 'day' : 'days') : 'weeks'
  return `${interval} (${n} ${unit})`
}

function activeTimeframe(view: ViewMode) {
  return view === 'live' ? liveInterval : tunnelInterval
}

function smaLine(price: number, sma: number | null) {
  if (sma == null) return '21d MA —'
  const pct = ((price - sma) / sma) * 100
  const side = pct >= 0 ? 'above' : 'below'
  return `21d ${formatPrice(sma)} · ${side} ${Math.abs(pct).toFixed(1)}%`
}

function trendWords(slope: number) {
  if (slope > 0.12) return { text: 'Rising', tone: 'bull' as const }
  if (slope < -0.12) return { text: 'Falling', tone: 'bear' as const }
  return { text: 'Sideways', tone: 'chaos' as const }
}

function lookLabel(v: number) {
  const deg = Math.round(v * 55)
  if (Math.abs(deg) < 4) return 'level'
  return deg > 0 ? `up ${deg}°` : `down ${Math.abs(deg)}°`
}

function zoomLabel(v: number) {
  if (v < 0.25) return 'close'
  if (v < 0.55) return 'near'
  if (v < 0.9) return 'mid'
  if (v < 1.4) return 'far'
  if (v < 2.0) return 'wide'
  return 'horizon'
}

function turnLabel(v: number) {
  if (Math.abs(v) < 0.08) return 'front'
  return v > 0 ? 'right' : 'left'
}

function timeLabel(p: number) {
  if (p > 0.92) return 'now'
  if (p > 0.66) return 'recent'
  if (p > 0.33) return 'mid history'
  return 'far past'
}

function syncSimpleSliders() {
  const st = world.getState()
  if (document.activeElement !== progressEl) {
    progressEl.value = String(Math.round(st.progress * 1000))
    progressVal.textContent = timeLabel(st.progress)
  }
  if (document.activeElement !== lookEl) {
    lookEl.value = String(Math.round(st.controls.pitch * 100))
    lookVal.textContent = lookLabel(st.controls.pitch)
  }
  if (document.activeElement !== zoomEl) {
    zoomEl.value = String(Math.round(st.controls.distance * 100))
    zoomVal.textContent = zoomLabel(st.controls.distance)
  }
  if (document.activeElement !== turnEl) {
  turnEl.value = String(Math.round(st.controls.yaw * 100))
    turnVal.textContent = turnLabel(st.controls.yaw)
}
}

function syncCamSliders() {
  syncingSliders = true
  const c = world.getState().controls
  for (const def of ADV_SLIDERS) {
    const el = sliderEls.get(def.key)!
    const v = c[def.key]
    el.input.value = String(unitToInput(def.key, v))
    el.val.textContent = def.format(v)
  }
  syncingSliders = false
  syncSimpleSliders()
}

function resize() {
  world.resize(window.innerWidth, window.innerHeight)
}

function renderPriceCard() {
  const frame = world.currentFrame()
  if (!frame) {
    priceCard.innerHTML = ''
    return
  }
  const s = frame.sample
  const st = world.getState()
  const liveClose = world.liveFeed.getLastClose() || s.close
  const price = st.view === 'live' ? liveClose : s.close
  const trend = trendWords(s.macroSlope)
  const bias = biasLabel(s.ghostBias)
  const delta = lastClose ? price - lastClose : 0
  const deltaTone = delta > 0 ? 'bull' : delta < 0 ? 'bear' : ''
  const deltaTxt =
    lastClose && delta !== 0
      ? `${delta > 0 ? '+' : ''}${delta.toFixed(price >= 1000 ? 0 : 2)}`
      : '—'
  const volWord =
    s.volatility > 0.66 ? 'Choppy' : s.volatility > 0.33 ? 'Active' : 'Quiet'
  const tf = activeTimeframe(st.view)
  const tick =
    st.view === 'live' && lastTickAt
      ? `Updated ${Math.max(0, Math.round((Date.now() - lastTickAt) / 1000))}s ago`
      : VIEW_META[st.view].label
  const tfHint =
    st.view === 'live'
      ? `Live road · ${tfLabel(tf)} candles`
      : `Tunnel · ${tfLabel(tf)} candles`

  priceCard.innerHTML = `
    <div class="price-main">
      <span class="price-sym">${liveSymbol.replace('USDT', '')}</span>
      <span class="price-tf" title="${tfHint}">${tf}</span>
      <span class="price-num">${formatPrice(price)}</span>
      <span class="price-delta ${deltaTone}">${deltaTxt}</span>
    </div>
    <div class="price-meta">
      <span class="${trend.tone}">${trend.text}</span>
      <span>${volWord}</span>
      <span class="${bias.tone}">${bias.tone === 'chaos' ? 'Unclear next' : bias.tone === 'bull' ? 'Path up' : 'Path down'}</span>
      <span class="ma">${smaLine(price, s.sma21)}</span>
    </div>
    <div class="price-foot">${tfHint} · ${tick}</div>
  `
  lastClose = price
}

function coachFor(view: ViewMode) {
  const map: Record<ViewMode, string> = {
    live: `You’re driving the live ${LIVE_TF} candle road. Hills are price; cyan/red shoulders are wicks.`,
    cockpit: `Inside the ${TUNNEL_TF} tentacle. It thickens in the past and tapers toward now — tip aims with market bias.`,
    chase: `Follow the ${TUNNEL_TF} tentacle through time. The spear tip reaches for direction; ridges are support / resist.`,
    orbital: `See the whole ${TUNNEL_TF} tentacle — long thin cone reaching from history into the next move.`,
    rail: `Side view of the ${TUNNEL_TF} taper. Cyan ridge = support, red = resistance; tip lift = bias.`,
    drone: `From above on ${TUNNEL_TF} candles. Body writhe is price; tip curl shows where it’s reaching.`,
    nose: `Face the past on ${TUNNEL_TF}. The tentacle rushes toward you as you scrub back.`,
    free: `Park the camera on the ${TUNNEL_TF} path. Enable Auto spin only if you want motion.`,
  }
  return map[view]
}

async function refreshLiveFeed() {
  const candles = await pollLiveCandles(liveSymbol, liveInterval, 60)
  world.pushLiveCandles(candles, `${liveSymbol} ${liveInterval}`)
  lastTickAt = Date.now()
}

function stopLivePoll() {
  if (liveTimer != null) {
    window.clearInterval(liveTimer)
    liveTimer = null
  }
}

function startLivePoll() {
  stopLivePoll()
  void refreshLiveFeed()
  liveTimer = window.setInterval(() => {
    void refreshLiveFeed()
  }, 5000)
}

async function boot(symbol = 'BTCUSDT') {
  liveSymbol = symbol
  tunnelInterval = TUNNEL_TF
  liveInterval = LIVE_TF
  subtitle.textContent = `Loading ${symbol}…`
  const market = await loadMarket(symbol, tunnelInterval, 480)
  tunnelInterval = market.interval || TUNNEL_TF
  const samples = buildSamples(market.candles)
  applySma21(samples, await loadDailySma21(symbol))
  world.setSamples(samples)
  const src = market.source === 'binance' ? 'live' : 'demo'
  const view = world.getState().view
  subtitle.textContent = `${market.symbol} · ${src} · ${activeTimeframe(view)}`
  if (view === 'live') void refreshLiveFeed()
}

function setView(view: ViewMode) {
  world.setView(view, true)
  for (const [id, btn] of viewButtons) btn.classList.toggle('active', id === view)
  viewBlurb.textContent = VIEW_META[view].blurb
  coachText.textContent = coachFor(view)
  coach.classList.remove('hidden')
  syncCamSliders()
  if (view === 'live') {
    subtitle.textContent = `${liveSymbol} · live road · ${liveInterval}`
    startLivePoll()
  } else {
    stopLivePoll()
    subtitle.textContent = `${liveSymbol} · ${VIEW_META[view].label.toLowerCase()} · ${tunnelInterval}`
  }
}

progressEl.addEventListener('input', () => {
  const v = Number(progressEl.value) / 1000
  world.setProgress(v)
  progressVal.textContent = timeLabel(v)
})

lookEl.addEventListener('input', () => {
  const v = Number(lookEl.value) / 100
  world.setControls({ pitch: v })
  lookVal.textContent = lookLabel(v)
})

zoomEl.addEventListener('input', () => {
  const v = Number(zoomEl.value) / 100
  world.setControls({ distance: v })
  zoomVal.textContent = zoomLabel(v)
})

turnEl.addEventListener('input', () => {
  const v = Number(turnEl.value) / 100
  world.setControls({ yaw: v })
  turnVal.textContent = turnLabel(v)
})

velocityEl.addEventListener('input', () => {
  const v = Number(velocityEl.value) / 100
  world.setVelocity(v)
  velocityVal.textContent = v.toFixed(2)
})

toggleExtra.addEventListener('click', () => {
  const open = extraViews.classList.toggle('hidden') === false
  toggleExtra.textContent = open ? 'Fewer angles' : 'More angles'
})

toggleAdvanced.addEventListener('click', () => {
  const open = advanced.classList.toggle('hidden') === false
  toggleAdvanced.textContent = open ? 'Hide fine-tune' : 'Camera fine-tune'
  toggleAdvanced.classList.toggle('active', open)
})

coachDismiss.addEventListener('click', () => {
  coach.classList.add('hidden')
})

laserBtn.addEventListener('click', () => {
  world.toggleLaser()
  laserBtn.classList.toggle('active', world.getState().laser)
  laserBtn.textContent = world.getState().laser ? 'Measuring…' : 'Measure'
})

echoBtn.addEventListener('click', () => {
  world.toggleEcho()
  echoBtn.classList.toggle('active', world.getState().echo)
  echoBtn.textContent = world.getState().echo ? 'Echo on' : 'Show echo'
})

resetCamBtn.addEventListener('click', () => {
  setView(world.getState().view)
})

reloadBtn.addEventListener('click', () => {
  void boot()
})

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const st = world.getState()
    const next = Math.min(2.5, Math.max(0, st.controls.distance + e.deltaY * 0.0012))
    world.setControls({ distance: next })
    zoomEl.value = String(Math.round(next * 100))
    zoomVal.textContent = zoomLabel(next)
  },
  { passive: false },
)

setInterval(() => {
  if (!syncingSliders) {
    syncSimpleSliders()
    for (const def of ADV_SLIDERS) {
      const el = sliderEls.get(def.key)!
      if (document.activeElement === el.input) continue
      const v = world.getState().controls[def.key]
      el.input.value = String(unitToInput(def.key, v))
      el.val.textContent = def.format(v)
    }
  }
  renderPriceCard()
}, 120)

window.addEventListener('resize', resize)
resize()
world.start()
void boot().then(() => setView('live'))
