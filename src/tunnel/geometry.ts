import * as THREE from 'three'
import type { TunnelSample } from '../data/market'

export type TunnelBuild = {
  group: THREE.Group
  path: THREE.CatmullRomCurve3
  length: number
  frames: Frame[]
  ribMats: THREE.MeshBasicMaterial[]
}

export type Frame = {
  center: THREE.Vector3
  tangent: THREE.Vector3
  normal: THREE.Vector3
  binormal: THREE.Vector3
  radius: number
  sample: TunnelSample
  /** 0 at base (past) → 1 at tip (now) */
  u: number
}

const RADIAL = 36
const TIP_SEGMENTS = 36

function closeScale(samples: TunnelSample[]) {
  const closes = samples.map((s) => s.close)
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  return { min, max, span: Math.max(1e-9, max - min) }
}

/** Vertical placement shared by price path and the 21-day average. */
function levelY(price: number, min: number, span: number) {
  return ((price - min) / span - 0.5) * 18
}

function priceToY(samples: TunnelSample[], i: number, scale = closeScale(samples)): number {
  return levelY(samples[i]!.close, scale.min, scale.span) + samples[i]!.macroSlope * 2.5
}

function toneColor(s: TunnelSample, tipBoost = 0): THREE.Color {
  const bull = Math.max(0, s.macroSlope)
  const bear = Math.max(0, -s.macroSlope)
  const vol = s.volatility
  return new THREE.Color(
    0.14 + bear * 0.82 + vol * 0.1 + tipBoost * 0.15,
    0.22 + bull * 0.62 - bear * 0.08 + tipBoost * 0.2,
    0.3 + bull * 0.52 - bear * 0.16 + tipBoost * 0.25,
  )
}

/** Long thin cone: thick at history base, needle tip at now. */
function taperRadius(u: number, volatility: number, slopeAbs: number): number {
  // Ease so most length stays thin; base flares like a tentacle root
  const flare = Math.pow(1 - u, 1.65)
  const base = 0.22 + flare * 3.4
  return base + volatility * (0.35 + flare * 1.1) + slopeAbs * flare * 0.35
}

/** Gold 21-day SMA ribbon — a level the tentacle climbs through. */
function buildSmaLine(frames: Frame[], samples: TunnelSample[]): THREE.Group {
  const group = new THREE.Group()
  group.name = 'sma21'
  const scale = closeScale(samples)
  const pts: THREE.Vector3[] = []
  for (const f of frames) {
    if (f.u > 0.82 || f.sample.sma21 == null) continue
    pts.push(new THREE.Vector3(f.center.x, levelY(f.sample.sma21, scale.min, scale.span), f.center.z))
  }
  if (pts.length < 2) return group

  const curve = new THREE.CatmullRomCurve3(pts)
  group.add(
    new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.min(pts.length * 2, 400), 0.07, 8, false),
      new THREE.MeshBasicMaterial({ color: 0xf0c75e, transparent: true, opacity: 0.95 }),
    ),
  )

  const last = pts[pts.length - 1]!
  const bead = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xf0c75e }),
  )
  bead.position.copy(last)
  group.add(bead)

  const tag = makeTagSprite('21d MA')
  tag.position.copy(last).add(new THREE.Vector3(1.4, 0.7, 0))
  tag.scale.set(3.4, 0.9, 1)
  group.add(tag)
  return group
}

function makeTagSprite(text: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'rgba(28, 22, 6, 0.72)'
  ctx.fillRect(8, 16, canvas.width - 16, canvas.height - 32)
  ctx.strokeStyle = '#f0c75e'
  ctx.lineWidth = 4
  ctx.strokeRect(8, 16, canvas.width - 16, canvas.height - 32)
  ctx.font = '700 64px "Chakra Petch", sans-serif'
  ctx.fillStyle = '#f0c75e'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace
  return new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }))
}

function buildFrames(samples: TunnelSample[]): {
  path: THREE.CatmullRomCurve3
  length: number
  frames: Frame[]
  tipPath: THREE.CatmullRomCurve3
} {
  const centers: THREE.Vector3[] = []
  for (let i = 0; i < samples.length; i++) {
    const u = i / Math.max(1, samples.length - 1)
    // Slight organic sway — tentacle writhe with volatility
    const sway = Math.sin(u * Math.PI * 5.5) * samples[i]!.volatility * 0.55
    centers.push(new THREE.Vector3(sway, priceToY(samples, i), i * 1.35))
  }

  const last = samples[samples.length - 1]!
  const tipStart = centers[centers.length - 1]!.clone()
  const tipTan = tipStart
    .clone()
    .sub(centers[centers.length - 2] ?? tipStart.clone().setZ(tipStart.z - 1))
    .normalize()
  if (tipTan.lengthSq() < 1e-6) tipTan.set(0, 0, 1)

  // Tip reaches toward market direction (ghost bias): lift = bull, drop = bear
  const reach = 14 + Math.abs(last.ghostBias) * 22
  const tipPts: THREE.Vector3[] = [tipStart.clone()]
  for (let i = 1; i <= TIP_SEGMENTS; i++) {
    const t = i / TIP_SEGMENTS
    const ease = t * t
    const lift = last.ghostBias * ease * 16
    const curl = Math.sin(t * Math.PI) * last.ghostBias * 1.8
    tipPts.push(
      tipStart
        .clone()
        .addScaledVector(tipTan, t * reach)
        .add(new THREE.Vector3(curl, lift, 0)),
    )
  }

  // Full path = body + reaching tip (camera can travel into the point)
  const fullCenters = [...centers.slice(0, -1), ...tipPts]
  const path = new THREE.CatmullRomCurve3(fullCenters, false, 'catmullrom', 0.2)
  const tipPath = new THREE.CatmullRomCurve3(tipPts, false, 'catmullrom', 0.25)
  const length = path.getLength()

  const bodyCount = samples.length
  const totalCount = bodyCount + TIP_SEGMENTS
  const frames: Frame[] = []

  for (let i = 0; i < totalCount; i++) {
    const t = i / Math.max(1, totalCount - 1)
    const center = path.getPointAt(t)
    const tangent = path.getTangentAt(t).normalize()
    const normal = new THREE.Vector3(0, 1, 0)
    const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize()
    if (binormal.lengthSq() < 1e-6) binormal.set(1, 0, 0)
    normal.crossVectors(binormal, tangent).normalize()

    const inBody = i < bodyCount
    const sample = inBody ? samples[i]! : last
    const bodyU = inBody ? i / Math.max(1, bodyCount - 1) : 1
    // Tip continues tapering to a point
    const tipU = inBody ? 0 : (i - bodyCount + 1) / TIP_SEGMENTS
    const u = inBody ? bodyU * 0.82 : 0.82 + tipU * 0.18
    const radius = inBody
      ? taperRadius(bodyU, sample.volatility, Math.abs(sample.macroSlope))
      : taperRadius(1, sample.volatility, Math.abs(sample.macroSlope)) * Math.pow(1 - tipU, 1.15) + 0.04

    frames.push({ center, tangent, normal, binormal, radius, sample, u })
  }

  return { path, length, frames, tipPath }
}

/** Continuous tentacle skin — long thin cone shell. */
function buildSkin(frames: Frame[]): THREE.Mesh {
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!
    const tipBoost = Math.max(0, f.u - 0.75) * 2
    const c = toneColor(f.sample, tipBoost)
    for (let r = 0; r <= RADIAL; r++) {
      const a = (r / RADIAL) * Math.PI * 2
      const sx = 1 + (Math.cos(a) < 0 ? f.sample.supportWick * 0.14 : f.sample.resistWick * 0.14)
      const sy = 1 + (Math.sin(a) > 0 ? f.sample.ceilingPressure * 0.12 : f.sample.valley * 0.1)
      const sucker =
        Math.sin(a) < -0.35
          ? Math.max(0, Math.sin(i * 0.55 + a * 3)) * 0.1 * (1 - f.u)
          : 0
      const p = f.center
        .clone()
        .addScaledVector(f.binormal, Math.cos(a) * f.radius * sx)
        .addScaledVector(f.normal, Math.sin(a) * f.radius * sy)
      if (sucker) p.addScaledVector(f.normal, -sucker * f.radius)
      positions.push(p.x, p.y, p.z)
      colors.push(c.r, c.g, c.b)
    }
  }

  for (let i = 0; i < frames.length - 1; i++) {
    for (let r = 0; r < RADIAL; r++) {
      const a = i * (RADIAL + 1) + r
      const b = a + RADIAL + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()

  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.38,
      metalness: 0.35,
      transparent: true,
      opacity: 0.78,
      emissive: new THREE.Color(0x0a1c22),
      emissiveIntensity: 0.45,
    }),
  )
}

/** Inner glow filament — the nerve of the tentacle. */
function buildNerve(frames: Frame[]): THREE.Mesh {
  const pts = frames.map((f) => f.center.clone())
  const curve = new THREE.CatmullRomCurve3(pts)
  return new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.min(frames.length * 2, 720), 0.04, 6, false),
    new THREE.MeshBasicMaterial({
      color: 0x9af7e4,
      transparent: true,
      opacity: 0.85,
    }),
  )
}

/** Annular bands that shrink toward the tip — motion + scale cues. */
function buildBands(frames: Frame[]): { group: THREE.Group; mats: THREE.MeshBasicMaterial[] } {
  const group = new THREE.Group()
  const mats: THREE.MeshBasicMaterial[] = []
  const step = Math.max(2, Math.floor(frames.length / 64))

  for (let i = 0; i < frames.length; i += step) {
    const f = frames[i]!
    if (f.radius < 0.08) continue
    const c = toneColor(f.sample, Math.max(0, f.u - 0.7) * 2)
    const mat = new THREE.MeshBasicMaterial({
      color: c,
      transparent: true,
      opacity: 0.16 + (1 - f.u) * 0.12 + f.sample.volatility * 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    mat.userData.baseOpacity = mat.opacity
    mat.userData.index = i
    mats.push(mat)

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.028 + (1 - f.u) * 0.03, 6, 40),
      mat,
    )
    ring.scale.set(f.radius * 1.02, f.radius * 0.92, 1)
    ring.position.copy(f.center)
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.tangent.clone().normalize())
    group.add(ring)
  }

  return { group, mats }
}

/** Twin ridges — support / resist — hugging the tapering body. */
function buildRidges(frames: Frame[]): THREE.Group {
  const group = new THREE.Group()
  const left: THREE.Vector3[] = []
  const right: THREE.Vector3[] = []
  for (const f of frames) {
    if (f.radius < 0.06) continue
    left.push(
      f.center
        .clone()
        .addScaledVector(f.binormal, -(f.radius * 0.95 + f.sample.supportWick * 0.25))
        .addScaledVector(f.normal, -f.radius * 0.1),
    )
    right.push(
      f.center
        .clone()
        .addScaledVector(f.binormal, f.radius * 0.95 + f.sample.resistWick * 0.25)
        .addScaledVector(f.normal, -f.radius * 0.1),
    )
  }
  if (left.length < 2) return group
  const segs = Math.min(left.length * 2, 600)
  const r0 = Math.max(0.02, frames[0]!.radius * 0.04)
  group.add(
    new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(left), segs, r0, 5, false),
      new THREE.MeshBasicMaterial({ color: 0x3ee0c4, transparent: true, opacity: 0.5 }),
    ),
  )
  group.add(
    new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(right), segs, r0, 5, false),
      new THREE.MeshBasicMaterial({ color: 0xff6b4a, transparent: true, opacity: 0.5 }),
    ),
  )
  return group
}

/** Bright spear tip — where the tentacle is reaching. */
function buildTipFlare(frames: Frame[]): THREE.Group {
  const group = new THREE.Group()
  const tip = frames[frames.length - 1]!
  const near = frames[Math.max(0, frames.length - 8)]!
  const dir = tip.center.clone().sub(near.center).normalize()

  const spear = new THREE.Mesh(
    new THREE.ConeGeometry(Math.max(0.12, tip.radius * 4.5), 2.4, 16, 1, true),
    new THREE.MeshStandardMaterial({
      color: tip.sample.ghostBias >= 0 ? 0x3ee0c4 : 0xff6b4a,
      emissive: tip.sample.ghostBias >= 0 ? 0x0a3d36 : 0x4a1208,
      emissiveIntensity: 1.1,
      transparent: true,
      opacity: 0.85,
      roughness: 0.25,
      metalness: 0.4,
      side: THREE.DoubleSide,
    }),
  )
  spear.position.copy(tip.center).addScaledVector(dir, 0.9)
  spear.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  group.add(spear)

  // Soft aura at the point
  const aura = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 16, 16),
    new THREE.MeshBasicMaterial({
      color: tip.sample.ghostBias >= 0 ? 0x7cf0d8 : 0xff9a7a,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  aura.position.copy(tip.center).addScaledVector(dir, 1.6)
  group.add(aura)
  return group
}

export function buildTunnel(samples: TunnelSample[]): TunnelBuild {
  const group = new THREE.Group()
  group.name = 'tunnel'

  const { path, length, frames } = buildFrames(samples)

  const skin = buildSkin(frames)
  skin.name = 'skin'
  group.add(skin)
  group.add(buildNerve(frames))
  group.add(buildRidges(frames))

  const { group: bands, mats: ribMats } = buildBands(frames)
  group.add(bands)
  group.add(buildTipFlare(frames))
  group.add(buildSmaLine(frames, samples))

  return { group, path, length, frames, ribMats }
}

/** Alternate tip reaches — faint ghost tentacles probing other directions. */
export function buildGhostTunnels(
  frames: Frame[],
  path: THREE.CatmullRomCurve3,
): THREE.Group {
  const group = new THREE.Group()
  group.name = 'ghosts'

  const last = frames[frames.length - 1]!
  const bias = last.sample.ghostBias
  // Start from ~82% along path (body tip before reach) so ghosts fork outward
  const forkT = 0.82
  const start = path.getPointAt(forkT)
  const tan = path.getTangentAt(forkT).normalize()

  const variants: { bias: number; color: number; opacity: number }[] = []
  if (Math.abs(bias) < 0.22) {
    variants.push(
      { bias: 0.7, color: 0x3ee0c4, opacity: 0.16 },
      { bias: -0.7, color: 0xff6b4a, opacity: 0.16 },
      { bias: 0.05, color: 0x9aa4b2, opacity: 0.1 },
    )
  } else if (bias > 0) {
    variants.push({ bias: bias * 1.15, color: 0x3ee0c4, opacity: 0.22 })
    variants.push({ bias: -bias * 0.45, color: 0xff6b4a, opacity: 0.1 })
  } else {
    variants.push({ bias: bias * 1.15, color: 0xff6b4a, opacity: 0.22 })
    variants.push({ bias: -bias * 0.45, color: 0x3ee0c4, opacity: 0.1 })
  }

  for (const v of variants) {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < 24; i++) {
      const t = i / 23
      const ease = t * t
      pts.push(
        start
          .clone()
          .addScaledVector(tan, t * 28)
          .add(new THREE.Vector3(Math.sin(t * 4) * (1 - Math.abs(v.bias)) * 0.8, v.bias * ease * 14, 0)),
      )
    }
    const curve = new THREE.CatmullRomCurve3(pts)
    // Tapered ghost cone via tube with shrinking radius approximation (wireframe cone look)
    const mat = new THREE.MeshBasicMaterial({
      color: v.color,
      transparent: true,
      opacity: v.opacity,
      wireframe: true,
      depthWrite: false,
    })
    mat.userData.baseOpacity = v.opacity
    group.add(
      new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 1.1 * (1 - Math.abs(v.bias) * 0.3), 10, false), mat),
    )
  }

  return group
}
