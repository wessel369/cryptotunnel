import * as THREE from 'three'
import { buildGhostTunnels, buildTunnel, type Frame, type TunnelBuild } from '../tunnel/geometry'
import type { Candle, TunnelSample } from '../data/market'
import { LiveFeed } from './LiveFeed'
import {
  applyCameraRig,
  DEFAULT_CONTROLS,
  VIEW_META,
  type CameraControls,
  type ViewMode,
} from '../camera/rig'

export type { ViewMode, CameraControls } from '../camera/rig'

export type WorldState = {
  progress: number
  view: ViewMode
  velocity: number
  echo: boolean
  laser: boolean
  controls: CameraControls
}

export class TunnelWorld {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2500)
  readonly clock = new THREE.Clock()
  readonly liveFeed = new LiveFeed()

  private renderer: THREE.WebGLRenderer
  private tunnel: TunnelBuild | null = null
  private ghosts: THREE.Group | null = null
  private laserLine: THREE.Line | null = null
  private echoRing: THREE.Mesh | null = null
  private keyLight: THREE.PointLight
  private fillLight: THREE.DirectionalLight
  private feedLight: THREE.PointLight
  private state: WorldState = {
    progress: 0.97,
    view: 'live',
    velocity: 0.35,
    echo: false,
    laser: false,
    controls: { ...DEFAULT_CONTROLS, ...VIEW_META.live.defaults },
  }
  private animId = 0
  private keys = new Set<string>()

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
      alpha: false,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x04080d, 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.25

    this.scene.fog = new THREE.FogExp2(0x071018, 0.008)
    this.scene.background = new THREE.Color(0x04080d)

    const amb = new THREE.AmbientLight(0x2a4050, 0.85)
    this.scene.add(amb)

    this.keyLight = new THREE.PointLight(0x3ee0c4, 3.4, 120)
    this.scene.add(this.keyLight)

    this.fillLight = new THREE.DirectionalLight(0xff8a5c, 0.85)
    this.fillLight.position.set(-8, 12, -10)
    this.scene.add(this.fillLight)

    this.feedLight = new THREE.PointLight(0x7cf0d8, 0, 40)
    this.scene.add(this.feedLight)

    const hemi = new THREE.HemisphereLight(0x6ec8ff, 0x1a0c08, 0.35)
    this.scene.add(hemi)

    this.scene.add(this.liveFeed.group)
    this.liveFeed.setVisible(true)
    this.feedLight.intensity = 3.2

    window.addEventListener('keydown', (e) => this.keys.add(e.code))
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
  }

  setSamples(samples: TunnelSample[]) {
    if (this.tunnel) this.scene.remove(this.tunnel.group)
    if (this.ghosts) this.scene.remove(this.ghosts)

    this.tunnel = buildTunnel(samples)
    this.scene.add(this.tunnel.group)

    this.ghosts = buildGhostTunnels(this.tunnel.frames, this.tunnel.path)
    this.scene.add(this.ghosts)

    const laserGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, -20),
    ])
    this.laserLine = new THREE.Line(
      laserGeo,
      new THREE.LineBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.85 }),
    )
    this.laserLine.visible = false
    this.scene.add(this.laserLine)

    this.echoRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.4, 0.06, 8, 48),
      new THREE.MeshBasicMaterial({
        color: 0xf0c75e,
        transparent: true,
        opacity: 0.7,
      }),
    )
    this.echoRing.visible = false
    this.scene.add(this.echoRing)

    this.state.progress = this.state.view === 'live' ? 0.97 : 0.78
    this.tintForBias(samples[samples.length - 1]?.ghostBias ?? 0)
    this.anchorLiveFeed()
  }

  getState(): WorldState {
    return {
      ...this.state,
      controls: { ...this.state.controls },
    }
  }

  setView(view: ViewMode, applyPreset = true) {
    this.state.view = view
    if (applyPreset) {
      this.state.controls = {
        ...DEFAULT_CONTROLS,
        ...VIEW_META[view].defaults,
      }
    }
    const live = view === 'live'
    this.liveFeed.setVisible(live)
    this.feedLight.intensity = live ? 3.2 : 0
    if (live) this.state.progress = 0.97
  }

  setControls(partial: Partial<CameraControls>) {
    this.state.controls = { ...this.state.controls, ...partial }
    if (partial.fov != null) {
      this.state.controls.fov = THREE.MathUtils.clamp(partial.fov, 35, 100)
    }
    if (partial.distance != null) {
      this.state.controls.distance = THREE.MathUtils.clamp(partial.distance, 0, 2.5)
    }
    if (partial.height != null) {
      this.state.controls.height = THREE.MathUtils.clamp(partial.height, -1, 1)
    }
    if (partial.yaw != null) {
      this.state.controls.yaw = THREE.MathUtils.clamp(partial.yaw, -1, 1)
    }
    if (partial.pitch != null) {
      this.state.controls.pitch = THREE.MathUtils.clamp(partial.pitch, -1, 1)
    }
    if (partial.lag != null) {
      this.state.controls.lag = THREE.MathUtils.clamp(partial.lag, 0, 1)
    }
    if (partial.lookAhead != null) {
      this.state.controls.lookAhead = THREE.MathUtils.clamp(partial.lookAhead, 0, 1)
    }
    if (partial.orbit != null) {
      this.state.controls.orbit = THREE.MathUtils.clamp(partial.orbit, 0, 1)
    }
    if (partial.roll != null) {
      this.state.controls.roll = THREE.MathUtils.clamp(partial.roll, 0, 1)
    }
    if (partial.tilt != null) {
      this.state.controls.tilt = THREE.MathUtils.clamp(partial.tilt, -1, 1)
    }
  }

  pushLiveCandles(candles: Candle[], label = 'BTCUSDT') {
    this.liveFeed.ingest(candles, label)
    this.anchorLiveFeed()
  }

  setProgress(v: number) {
    this.state.progress = THREE.MathUtils.clamp(v, 0, 1)
  }

  /** @deprecated use setControls({ pitch }) */
  setPitch(v: number) {
    this.setControls({ pitch: THREE.MathUtils.clamp(v, -1, 1) })
  }

  setVelocity(v: number) {
    this.state.velocity = THREE.MathUtils.clamp(v, 0, 1.5)
  }

  toggleEcho(on?: boolean) {
    this.state.echo = on ?? !this.state.echo
  }

  toggleLaser(on?: boolean) {
    this.state.laser = on ?? !this.state.laser
  }

  currentFrame(): Frame | null {
    if (!this.tunnel) return null
    const i = Math.round(this.state.progress * (this.tunnel.frames.length - 1))
    return this.tunnel.frames[THREE.MathUtils.clamp(i, 0, this.tunnel.frames.length - 1)]!
  }

  resize(w: number, h: number) {
    this.camera.aspect = Math.max(0.1, w / Math.max(1, h))
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, true)
  }

  start() {
    const tick = () => {
      this.animId = requestAnimationFrame(tick)
      this.update(this.clock.getDelta())
      this.renderer.render(this.scene, this.camera)
    }
    tick()
  }

  stop() {
    cancelAnimationFrame(this.animId)
  }

  private tintForBias(bias: number) {
    if (bias > 0.2) {
      this.keyLight.color.set(0x3ee0c4)
      this.fillLight.color.set(0x7cf0d8)
      ;(this.scene.fog as THREE.FogExp2).color.set(0x061820)
      this.renderer.setClearColor(0x041018, 1)
    } else if (bias < -0.2) {
      this.keyLight.color.set(0xff6b4a)
      this.fillLight.color.set(0xff9a7a)
      ;(this.scene.fog as THREE.FogExp2).color.set(0x140808)
      this.renderer.setClearColor(0x0c0606, 1)
    } else {
      this.keyLight.color.set(0x9aa4b2)
      this.fillLight.color.set(0xc0c8d0)
      ;(this.scene.fog as THREE.FogExp2).color.set(0x0a0e12)
      this.renderer.setClearColor(0x07090c, 1)
    }
  }

  private anchorLiveFeed() {
    if (!this.tunnel) return
    // Live road starts just beyond the tentacle tip, aligned with its reach
    const tip = this.tunnel.path.getPointAt(0.999)
    const tan = this.tunnel.path.getTangentAt(0.999).normalize()
    this.liveFeed.group.position.copy(tip).addScaledVector(tan, 4)
    const ahead = tip.clone().addScaledVector(tan, 20)
    this.liveFeed.group.lookAt(ahead)
    // Undo lookAt tilt so the road lays flat-forward in local Z
    this.liveFeed.group.up.set(0, 1, 0)
    this.feedLight.position.copy(this.liveFeed.group.position).add(new THREE.Vector3(0, 4, 0))
  }

  private nudgeControls(dt: number) {
    const c = this.state.controls
    const speed = dt * 0.55
    if (this.keys.has('KeyQ')) this.setControls({ yaw: c.yaw - speed })
    if (this.keys.has('KeyE')) this.setControls({ yaw: c.yaw + speed })
    if (this.keys.has('KeyR')) this.setControls({ height: c.height + speed })
    if (this.keys.has('KeyF')) this.setControls({ height: c.height - speed })
    if (this.keys.has('KeyZ')) this.setControls({ distance: c.distance - speed })
    if (this.keys.has('KeyX')) this.setControls({ distance: c.distance + speed })
    if (this.keys.has('KeyC')) this.setControls({ fov: c.fov - speed * 40 })
    if (this.keys.has('KeyV')) this.setControls({ fov: c.fov + speed * 40 })
    if (this.keys.has('KeyT')) this.setControls({ tilt: c.tilt - speed })
    if (this.keys.has('KeyG')) this.setControls({ tilt: c.tilt + speed })
  }

  private update(dt: number) {
    if (!this.tunnel) return

    const live = this.state.view === 'live'
    this.nudgeControls(dt)

    if (!live) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
        this.state.progress = Math.min(1, this.state.progress + dt * this.state.velocity * 0.12)
      }
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
        this.state.progress = Math.max(0, this.state.progress - dt * this.state.velocity * 0.12)
      }
      if (this.state.velocity > 0.85 && !this.keys.has('KeyS')) {
        this.state.progress = Math.min(1, this.state.progress + dt * 0.015)
      }
    } else {
      this.state.progress = THREE.MathUtils.lerp(this.state.progress, 0.97, 0.08)
    }
    if (this.keys.has('KeyA')) {
      this.setControls({ pitch: this.state.controls.pitch - dt * 0.6 })
    }
    if (this.keys.has('KeyD')) {
      this.setControls({ pitch: this.state.controls.pitch + dt * 0.6 })
    }

    const t = THREE.MathUtils.clamp(this.state.progress, 0.001, 0.999)
    const pos = this.tunnel.path.getPointAt(t)
    const lookAmt = 0.015 + this.state.controls.lookAhead * 0.1
    const lookT = Math.min(0.999, t + lookAmt)
    const look = this.tunnel.path.getPointAt(lookT)
    const tangent = this.tunnel.path.getTangentAt(t).normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize()
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0)

    if (live) this.anchorLiveFeed()

    let camPos = pos
    let camTan = tangent
    let camLook = look
    let camUp = up
    let camSide = side
    let feedWorld: THREE.Vector3 | undefined

    if (live) {
      // Drive along the live candle road (local → world)
      const driveU = 0.72 + this.state.controls.lookAhead * 0.18
      const drive = this.liveFeed.getDriveSample(driveU)
      if (drive) {
        this.liveFeed.group.updateMatrixWorld(true)
        camPos = this.liveFeed.group.localToWorld(drive.pos.clone())
        camLook = this.liveFeed.group.localToWorld(drive.look.clone())
        camTan = drive.tangent.clone().transformDirection(this.liveFeed.group.matrixWorld).normalize()
        camUp = drive.up.clone().transformDirection(this.liveFeed.group.matrixWorld).normalize()
        camSide = drive.side.clone().transformDirection(this.liveFeed.group.matrixWorld).normalize()
        feedWorld = camPos.clone()
      }
    }

    applyCameraRig(this.camera, this.state.view, this.state.controls, {
      pos: camPos,
      tangent: camTan,
      look: camLook,
      up: camUp,
      side: camSide,
      feed: feedWorld,
      time: this.clock.elapsedTime,
    })

    this.keyLight.position.copy(live && feedWorld ? feedWorld : pos).add(new THREE.Vector3(0, 2.5, 0))
    // Pull fog back when zoomed out so the wide shot stays readable
    const fog = this.scene.fog as THREE.FogExp2
    fog.density = THREE.MathUtils.lerp(0.01, 0.0025, Math.min(1, this.state.controls.distance / 2.5))
    this.liveFeed.update(dt)
    if (live) {
      this.feedLight.intensity = 2.4 + Math.sin(this.clock.elapsedTime * 3) * 0.6
    }

    const frame = this.currentFrame()
    if (frame) this.tintForBias(frame.sample.ghostBias)

    if (this.laserLine) {
      const laserOk =
        this.state.laser &&
        (this.state.view === 'cockpit' || this.state.view === 'chase' || this.state.view === 'rail')
      this.laserLine.visible = laserOk
      if (laserOk) {
        const origin = this.camera.position.clone()
        const dir = new THREE.Vector3()
        this.camera.getWorldDirection(dir)
        const s = frame?.sample
        if (s) {
          const sideSign = s.resistWick > s.supportWick ? 1 : -1
          dir.add(new THREE.Vector3(sideSign * 0.15, s.ceilingPressure * 0.1, 0)).normalize()
        }
        const hit = origin.clone().addScaledVector(dir, 12 + (frame?.radius ?? 3) * 1.2)
        this.laserLine.geometry.setFromPoints([origin, hit])
      }
    }

    if (this.echoRing && frame) {
      const show = this.state.echo && frame.sample.echo > 0.55 && !live
      this.echoRing.visible = show
      if (show) {
        this.echoRing.position.copy(frame.center)
        this.echoRing.lookAt(frame.center.clone().add(frame.tangent))
        const pulse = 0.85 + Math.sin(this.clock.elapsedTime * 4) * 0.15
        this.echoRing.scale.setScalar(pulse * (1.2 + frame.sample.echo))
      }
    }

    // Pulse ribs near the traveler so the conduit feels alive as you move
    const frameCount = this.tunnel.frames.length
    const traveler = this.state.progress * (frameCount - 1)
    for (const mat of this.tunnel.ribMats) {
      const idx = Number(mat.userData.index ?? 0)
      const dist = Math.abs(idx - traveler)
      const near = Math.max(0, 1 - dist / 18)
      const base = Number(mat.userData.baseOpacity ?? 0.2)
      mat.opacity = base * (0.55 + near * 1.6 + Math.sin(this.clock.elapsedTime * 3 + idx * 0.08) * 0.08)
    }

    if (this.ghosts) {
      this.ghosts.visible = this.state.progress > 0.82 && !live
      this.ghosts.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshBasicMaterial) {
          const base = Number(obj.material.userData.baseOpacity ?? 0.15)
          obj.material.opacity = base * (0.75 + Math.sin(this.clock.elapsedTime * 2) * 0.15)
        }
      })
    }
  }
}
