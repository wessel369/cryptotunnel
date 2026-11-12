import * as THREE from 'three'
import type { Candle } from '../data/market'

type Pulse = {
  mesh: THREE.Mesh
  born: number
  life: number
}

export type DriveSample = {
  pos: THREE.Vector3
  look: THREE.Vector3
  tangent: THREE.Vector3
  up: THREE.Vector3
  side: THREE.Vector3
}

/**
 * Live ticker as a driveable price road: candle closes become hills,
 * wicks become shoulder berms — you ride toward now.
 */
export class LiveFeed {
  readonly group = new THREE.Group()
  private road = new THREE.Group()
  private pulses: Pulse[] = []
  private lastClose = 0
  private flash = 0
  private priceSprite: THREE.Sprite
  private status = 'awaiting feed'
  private path: THREE.CatmullRomCurve3 | null = null
  private roadLength = 0

  constructor() {
    this.group.name = 'liveFeed'
    this.group.add(this.road)
    this.group.visible = false

    this.priceSprite = makeTextSprite('—', '#3ee0c4')
    this.priceSprite.scale.set(7, 2, 1)
    this.priceSprite.position.set(0, 3.2, 0)
    this.group.add(this.priceSprite)
  }

  setVisible(on: boolean) {
    this.group.visible = on
  }

  getStatus() {
    return this.status
  }

  getLastClose() {
    return this.lastClose
  }

  /** Camera sample along the live road (u 0..1, default near the tip). */
  getDriveSample(u = 0.82): DriveSample | null {
    if (!this.path || this.roadLength < 1e-3) return null
    const t = THREE.MathUtils.clamp(u, 0.02, 0.96)
    const pos = this.path.getPointAt(t)
    const look = this.path.getPointAt(Math.min(0.999, t + 0.08))
    const tangent = this.path.getTangentAt(t).normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize()
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
    // Lift slightly above asphalt
    pos.y += 0.35
    look.y += 0.25
    return { pos, look, tangent, up, side }
  }

  /** Rebuild road from newest candles (oldest → newest / hills ahead). */
  ingest(candles: Candle[], label = 'BTCUSDT') {
    if (!candles.length) return
    const newest = candles[candles.length - 1]!
    const changed = newest.c !== this.lastClose || newest.t !== candles.at(-2)?.t
    const delta = this.lastClose ? newest.c - this.lastClose : 0
    this.lastClose = newest.c
    this.status = `${label} · live`

    while (this.road.children.length) {
      const child = this.road.children.pop()!
      this.disposeObject(child)
    }

    const slice = candles.slice(-64)
    const highs = slice.map((c) => c.h)
    const lows = slice.map((c) => c.l)
    const min = Math.min(...lows)
    const max = Math.max(...highs)
    const span = Math.max(1e-9, max - min)
    const step = 1.15
    const halfW = 1.35

    const centers: THREE.Vector3[] = []
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i]!
      const y = ((c.c - min) / span - 0.5) * 5.5
      centers.push(new THREE.Vector3(0, y, i * step))
    }
    this.path = new THREE.CatmullRomCurve3(centers, false, 'catmullrom', 0.2)
    this.roadLength = this.path.getLength()

    // Asphalt ribbon
    const positions: number[] = []
    const colors: number[] = []
    const indices: number[] = []
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i]!
      const bull = c.c >= c.o
      const t = i / Math.max(1, slice.length - 1)
      const center = this.path.getPointAt(t)
      const tangent = this.path.getTangentAt(t).normalize()
      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize()
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
      const left = center.clone().addScaledVector(side, -halfW)
      const right = center.clone().addScaledVector(side, halfW)
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z)
      const cr = bull ? 0.12 : 0.55
      const cg = bull ? 0.45 : 0.18
      const cb = bull ? 0.42 : 0.14
      // Fade older asphalt
      const fade = 0.35 + t * 0.65
      colors.push(cr * fade, cg * fade, cb * fade, cr * fade, cg * fade, cb * fade)
    }
    for (let i = 0; i < slice.length - 1; i++) {
      const a = i * 2
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
    const roadGeo = new THREE.BufferGeometry()
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    roadGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    roadGeo.setIndex(indices)
    roadGeo.computeVertexNormals()
    this.road.add(
      new THREE.Mesh(
        roadGeo,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          roughness: 0.7,
          metalness: 0.15,
          emissive: new THREE.Color(0x061410),
          emissiveIntensity: 0.4,
        }),
      ),
    )

    // Center dashed line
    const dashPts: THREE.Vector3[] = []
    for (let i = 0; i < slice.length - 1; i += 2) {
      const t0 = i / Math.max(1, slice.length - 1)
      const t1 = Math.min(1, (i + 1) / Math.max(1, slice.length - 1))
      dashPts.push(
        this.path.getPointAt(t0).clone().add(new THREE.Vector3(0, 0.03, 0)),
        this.path.getPointAt(t1).clone().add(new THREE.Vector3(0, 0.03, 0)),
      )
    }
    this.road.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(dashPts),
        new THREE.LineBasicMaterial({ color: 0xe8f7ff, transparent: true, opacity: 0.7 }),
      ),
    )

    // Shoulder berms from wicks (hills beside the road)
    const leftShoulder: THREE.Vector3[] = []
    const rightShoulder: THREE.Vector3[] = []
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i]!
      const t = i / Math.max(1, slice.length - 1)
      const center = this.path.getPointAt(t)
      const tangent = this.path.getTangentAt(t).normalize()
      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize()
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
      const hi = ((c.h - min) / span - 0.5) * 5.5
      const lo = ((c.l - min) / span - 0.5) * 5.5
      leftShoulder.push(
        center
          .clone()
          .addScaledVector(side, -(halfW + 0.55))
          .setY(lo),
      )
      rightShoulder.push(
        center
          .clone()
          .addScaledVector(side, halfW + 0.55)
          .setY(hi),
      )
    }
    this.road.add(makeShoulderMesh(leftShoulder, halfW * 0.55, 0x3ee0c4))
    this.road.add(makeShoulderMesh(rightShoulder, halfW * 0.55, 0xff6b4a))

    // Edge rails
    this.road.add(
      new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(leftShoulder), slice.length * 2, 0.045, 5, false),
        new THREE.MeshBasicMaterial({ color: 0x3ee0c4, transparent: true, opacity: 0.55 }),
      ),
    )
    this.road.add(
      new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rightShoulder), slice.length * 2, 0.045, 5, false),
        new THREE.MeshBasicMaterial({ color: 0xff6b4a, transparent: true, opacity: 0.55 }),
      ),
    )

    // Mile markers / candle posts along the verge
    for (let i = 0; i < slice.length; i += 3) {
      const c = slice[i]!
      const t = i / Math.max(1, slice.length - 1)
      const center = this.path.getPointAt(t)
      const tangent = this.path.getTangentAt(t).normalize()
      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize()
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
      const bull = c.c >= c.o
      const body = Math.max(0.15, Math.abs(c.c - c.o) / span)
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.35 + body * 2.2, 0.12),
        new THREE.MeshStandardMaterial({
          color: bull ? 0x3ee0c4 : 0xff6b4a,
          emissive: bull ? 0x0a3d36 : 0x4a1208,
          emissiveIntensity: 0.7,
          roughness: 0.4,
        }),
      )
      post.position.copy(center).addScaledVector(side, halfW + 0.95)
      post.position.y += 0.2 + body
      this.road.add(post)
    }

    // Horizon glow at the tip (now)
    const tip = this.path.getPointAt(0.999)
    const tipTan = this.path.getTangentAt(0.999).normalize()
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 16, 16),
      new THREE.MeshBasicMaterial({
        color: delta >= 0 ? 0x7cf0d8 : 0xff9a7a,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    glow.position.copy(tip).addScaledVector(tipTan, 1.2).add(new THREE.Vector3(0, 0.4, 0))
    this.road.add(glow)

    this.priceSprite.position.copy(tip).add(new THREE.Vector3(0, 2.6, 0)).addScaledVector(tipTan, 0.5)

    const sign = delta > 0 ? '▲' : delta < 0 ? '▼' : '•'
    const tone = delta > 0 ? '#3ee0c4' : delta < 0 ? '#ff6b4a' : '#9aa4b2'
    this.replaceSprite(`${sign} ${format(newest.c)}`, tone)

    if (changed) {
      this.flash = 1
      this.spawnPulse(delta >= 0 ? 0x3ee0c4 : 0xff6b4a, tip)
    }
  }

  update(dt: number) {
    if (!this.group.visible) return
    this.flash = Math.max(0, this.flash - dt * 1.4)
    this.priceSprite.material.opacity = 0.75 + this.flash * 0.25

    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i]!
      p.born += dt
      const t = p.born / p.life
      const s = 1 + t * 6
      p.mesh.scale.set(s, 1, s)
      const mat = p.mesh.material as THREE.MeshBasicMaterial
      mat.opacity = Math.max(0, 0.5 * (1 - t))
      if (t >= 1) {
        this.group.remove(p.mesh)
        p.mesh.geometry.dispose()
        mat.dispose()
        this.pulses.splice(i, 1)
      }
    }
  }

  private spawnPulse(color: number, at: THREE.Vector3) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.85, 40),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.position.copy(at)
    mesh.position.y += 0.06
    this.group.add(mesh)
    this.pulses.push({ mesh, born: 0, life: 1.0 })
  }

  private replaceSprite(text: string, color: string) {
    const next = makeTextSprite(text, color)
    next.scale.copy(this.priceSprite.scale)
    next.position.copy(this.priceSprite.position)
    this.group.remove(this.priceSprite)
    const old = this.priceSprite.material as THREE.SpriteMaterial
    old.map?.dispose()
    old.dispose()
    this.priceSprite = next
    this.group.add(this.priceSprite)
  }

  private disposeObject(obj: THREE.Object3D) {
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose()
        const m = (o as THREE.Mesh).material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
      }
    })
  }
}

function makeShoulderMesh(centers: THREE.Vector3[], width: number, color: number): THREE.Mesh {
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i]!
    const prev = centers[Math.max(0, i - 1)]!
    const next = centers[Math.min(centers.length - 1, i + 1)]!
    const tan = next.clone().sub(prev).normalize()
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize()
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
    const a = c.clone().addScaledVector(side, -width * 0.5)
    const b = c.clone().addScaledVector(side, width * 0.5)
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z)
  }
  for (let i = 0; i < centers.length - 1; i++) {
    const a = i * 2
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      roughness: 0.8,
      metalness: 0.05,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.2,
      depthWrite: false,
    }),
  )
}

function format(n: number) {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return n.toPrecision(5)
}

function makeTextSprite(text: string, color: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'rgba(4, 12, 16, 0.35)'
  ctx.fillRect(40, 40, canvas.width - 80, canvas.height - 80)
  ctx.strokeStyle = color
  ctx.lineWidth = 4
  ctx.strokeRect(40, 40, canvas.width - 80, canvas.height - 80)
  ctx.font = '700 96px "Chakra Petch", sans-serif'
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace
  return new THREE.Sprite(
    new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }),
  )
}
