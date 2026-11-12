import * as THREE from 'three'

export type ViewMode =
  | 'cockpit'
  | 'chase'
  | 'rail'
  | 'drone'
  | 'nose'
  | 'orbital'
  | 'live'
  | 'free'

export type CameraControls = {
  /** Dolly distance / follow gap (0..2.5 — higher pulls much farther out) */
  distance: number
  /** Vertical offset (−1..1) */
  height: number
  /** Lateral / yaw orbit offset (−1..1) */
  yaw: number
  /** Look angle up/down (−1..1 → aim toward ceiling / floor) */
  pitch: number
  /** Field of view in degrees */
  fov: number
  /** Position lerp / lag (0 = sticky, 1 = syrupy) */
  lag: number
  /** How far ahead to look along the path (0..1) */
  lookAhead: number
  /** Auto orbit speed (0 = still; only spins when you raise this) */
  orbit: number
  /** Bank / roll response (0..1) */
  roll: number
  /** Absolute Dutch-angle tilt (−1..1 → lean left/right) */
  tilt: number
}

export const DEFAULT_CONTROLS: CameraControls = {
  distance: 0.45,
  height: 0.15,
  yaw: 0,
  pitch: 0,
  fov: 62,
  lag: 0.35,
  lookAhead: 0.4,
  orbit: 0,
  roll: 0.35,
  tilt: 0,
}

export const VIEW_META: Record<
  ViewMode,
  { label: string; blurb: string; primary?: boolean; defaults?: Partial<CameraControls> }
> = {
  live: {
    label: 'Live price',
    blurb: 'Drive the live candle road — hills are price',
    primary: true,
    defaults: {
      distance: 0.22,
      height: 0.12,
      yaw: 0,
      pitch: -0.05,
      fov: 58,
      lag: 0.28,
      lookAhead: 0.55,
      orbit: 0,
      roll: 0.2,
      tilt: 0,
    },
  },
  cockpit: {
    label: 'Inside',
    blurb: 'Inside the tentacle — taper and tip show where price is reaching',
    primary: true,
    defaults: { distance: 0.1, height: 0, fov: 72, lag: 0.2, lookAhead: 0.2, roll: 0.15 },
  },
  chase: {
    label: 'Follow',
    blurb: 'Ride behind your position through time',
    primary: true,
    defaults: { distance: 0.55, height: 0.25, fov: 62, lag: 0.35, lookAhead: 0.45, roll: 0.4 },
  },
  orbital: {
    label: 'Big picture',
    blurb: 'Zoom out and see the whole shape of the move',
    primary: true,
    defaults: { distance: 0.75, height: 0.55, yaw: 0.35, fov: 55, lag: 0.4, lookAhead: 0.6, orbit: 0 },
  },
  rail: {
    label: 'Side view',
    blurb: 'Look along the wall — support vs resistance',
    defaults: { distance: 0.5, height: 0.1, yaw: 0.7, fov: 60, lag: 0.3, lookAhead: 0.5, roll: 0.2 },
  },
  drone: {
    label: 'From above',
    blurb: 'Bird’s-eye map of peaks and valleys',
    defaults: { distance: 0.65, height: 0.85, yaw: 0.15, fov: 52, lag: 0.4, lookAhead: 0.55, orbit: 0 },
  },
  nose: {
    label: 'Looking back',
    blurb: 'Face the past — see price coming at you',
    defaults: { distance: 0.5, height: 0.2, fov: 68, lag: 0.25, lookAhead: 0.15, roll: 0.25 },
  },
  free: {
    label: 'Orbit free',
    blurb: 'Spin around your spot with the camera sliders',
    defaults: { distance: 0.6, height: 0.35, yaw: 0.4, fov: 60, lag: 0.25, lookAhead: 0.4, orbit: 0 },
  },
}

export type RigSample = {
  pos: THREE.Vector3
  tangent: THREE.Vector3
  look: THREE.Vector3
  up: THREE.Vector3
  side: THREE.Vector3
  feed?: THREE.Vector3
  time: number
}

function lerpFov(camera: THREE.PerspectiveCamera, target: number, lag: number) {
  const k = THREE.MathUtils.clamp(1 - lag, 0.04, 0.35)
  camera.fov = THREE.MathUtils.lerp(camera.fov, target, k)
  camera.updateProjectionMatrix()
}

function applyBank(camera: THREE.Camera, reactiveRoll: number, tilt: number) {
  const radians = reactiveRoll * 0.35 + tilt * 0.55
  if (Math.abs(radians) < 1e-4) return
  camera.rotateZ(-radians)
}

/** Compute desired camera pose for the active view + controls. */
export function computeCameraTarget(
  view: ViewMode,
  ctrl: CameraControls,
  s: RigSample,
): { position: THREE.Vector3; target: THREE.Vector3; fov: number; roll: number } {
  const dist = ctrl.distance
  const h = ctrl.height
  const yaw = ctrl.yaw
  const pitch = ctrl.pitch
  const { pos, tangent, look, up, side, feed, time } = s

  // Pitch is applied globally as look-up/down in applyCameraRig; framing uses height/yaw/distance.
  void pitch

  // Pull-back curve: stays gentle near 0, stretches hard past 1 for wide shots
  const pull = dist + Math.max(0, dist - 1) * 1.8

  if (view === 'cockpit') {
    const back = 0.15 + pull * 2.4
    const position = pos
      .clone()
      .addScaledVector(tangent, -back)
      .addScaledVector(up, h * 1.2 + Math.max(0, pull - 0.8) * 2)
      .addScaledVector(side, yaw * 0.8)
    const target = look.clone()
    return { position, target, fov: ctrl.fov, roll: yaw * ctrl.roll * 0.4 }
  }

  if (view === 'chase') {
    const back = 3 + pull * 18
    const position = pos
      .clone()
      .addScaledVector(tangent, -back)
      .addScaledVector(up, 1.2 + h * 5 + Math.max(0, pull - 0.6) * 4)
      .addScaledVector(side, yaw * 4)
    const target = pos.clone().addScaledVector(tangent, 4 + ctrl.lookAhead * 10)
    return { position, target, fov: ctrl.fov, roll: yaw * ctrl.roll }
  }

  if (view === 'rail') {
    const lateral = (0.55 + Math.abs(yaw) * 0.4) * (8 + pull * 18) * Math.sign(yaw || 1)
    const position = pos
      .clone()
      .addScaledVector(side, lateral)
      .addScaledVector(up, 0.6 + h * 4 + Math.max(0, pull - 0.8) * 3)
      .addScaledVector(tangent, -2 + pull * 2)
    const target = pos.clone().addScaledVector(tangent, 6 + ctrl.lookAhead * 12)
    return { position, target, fov: ctrl.fov, roll: -Math.sign(lateral) * ctrl.roll * 0.5 }
  }

  if (view === 'drone') {
    const position = pos
      .clone()
      .addScaledVector(up, 8 + h * 18 + pull * 22)
      .addScaledVector(tangent, -4 - pull * 16)
      .addScaledVector(side, yaw * 10)
    const target = pos.clone().addScaledVector(tangent, 8 + ctrl.lookAhead * 16)
    return { position, target, fov: ctrl.fov, roll: yaw * ctrl.roll * 0.25 }
  }

  if (view === 'nose') {
    // Sit ahead of the traveler, look back toward incoming structure
    const ahead = 4 + pull * 20
    const position = pos
      .clone()
      .addScaledVector(tangent, ahead)
      .addScaledVector(up, 1.4 + h * 4 + Math.max(0, pull - 0.8) * 3)
      .addScaledVector(side, yaw * 3)
    const target = pos.clone().addScaledVector(tangent, -2)
    return { position, target, fov: ctrl.fov, roll: -yaw * ctrl.roll * 0.6 }
  }

  if (view === 'orbital') {
    // Fixed angle from yaw; auto-spin only if orbit > 0
    const angle = yaw * Math.PI + time * ctrl.orbit * 0.55
    const radius = 8 + pull * 36
    const elev = 4 + h * 14 + Math.max(0, pull - 0.5) * 10
    const position = pos
      .clone()
      .addScaledVector(side, Math.cos(angle) * radius)
      .addScaledVector(up, elev)
      .addScaledVector(tangent, -6 - Math.sin(angle) * pull * 4)
    const target = pos.clone().addScaledVector(tangent, 8 + ctrl.lookAhead * 14)
    return { position, target, fov: ctrl.fov, roll: 0 }
  }

  if (view === 'live') {
    // Drive the live road: camera sits on the asphalt looking over the hills
    const roadPos = feed ?? pos
    const back = 2.2 + pull * 16
    const position = roadPos
      .clone()
      .addScaledVector(tangent, -back)
      .addScaledVector(up, 1.1 + h * 4 + Math.max(0, pull - 0.5) * 5)
      .addScaledVector(side, yaw * (3 + pull * 6))
    const target = roadPos
      .clone()
      .addScaledVector(tangent, 4 + ctrl.lookAhead * 12)
      .addScaledVector(up, 0.2)
    // Optional gentle sway if Auto spin is raised
    if (ctrl.orbit > 0.02) {
      position.addScaledVector(side, Math.sin(time * ctrl.orbit * 0.8) * 0.6)
    }
    return { position, target, fov: ctrl.fov, roll: yaw * ctrl.roll * 0.5 }
  }

  // free — spherical orbit; height sets elevation, pitch aims look up/down
  {
    const theta = yaw * Math.PI
    const phi = THREE.MathUtils.lerp(0.25, 1.35, (h + 1) * 0.5)
    const radius = 4 + pull * 40
    const position = pos.clone().add(
      new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * radius,
        Math.cos(phi) * radius,
        Math.sin(phi) * Math.sin(theta) * radius,
      ),
    )
    position.addScaledVector(tangent, -2)
    const target = pos.clone().addScaledVector(tangent, ctrl.lookAhead * 8)
    return { position, target, fov: ctrl.fov, roll: 0 }
  }
}

export function applyCameraRig(
  camera: THREE.PerspectiveCamera,
  view: ViewMode,
  ctrl: CameraControls,
  sample: RigSample,
) {
  const desired = computeCameraTarget(view, ctrl, sample)
  const follow = THREE.MathUtils.clamp(0.06 + (1 - ctrl.lag) * 0.22, 0.05, 0.35)
  camera.position.lerp(desired.position, follow)

  // Soften look-at, then apply explicit look-up / look-down angle
  const focusKey = '_rigFocus' as const
  const aimKey = '_rigAim' as const
  const cam = camera as THREE.PerspectiveCamera & {
    [focusKey]?: THREE.Vector3
    [aimKey]?: number
  }
  if (!cam[focusKey]) cam[focusKey] = desired.target.clone()
  if (cam[aimKey] == null) cam[aimKey] = 0

  const aimTarget = desired.target.clone()
  const toTarget = aimTarget.clone().sub(desired.position)
  const distToTarget = Math.max(0.5, toTarget.length())
  // ±55° look angle: negative pitch looks down, positive looks up
  const lookRad = ctrl.pitch * THREE.MathUtils.degToRad(55)
  aimTarget.addScaledVector(sample.up, Math.tan(lookRad) * distToTarget)

  cam[focusKey].lerp(aimTarget, follow)
  cam[aimKey] = THREE.MathUtils.lerp(cam[aimKey], lookRad, follow)
  camera.lookAt(cam[focusKey])
  // Extra local pitch for a crisp up/down feel after lookAt
  camera.rotateX(cam[aimKey] * 0.35)

  applyBank(camera, desired.roll, ctrl.tilt)
  lerpFov(camera, desired.fov, ctrl.lag * 0.5)
}
