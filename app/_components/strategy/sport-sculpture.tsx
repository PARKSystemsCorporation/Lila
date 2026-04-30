'use client'

// Per-sport brutalist sculpture in the same vocabulary as
// `app/_components/landing-sculpture.tsx`: concrete slabs (BoxGeometry +
// MeshStandardMaterial 0x141821) traced in tone-colored EdgesGeometry,
// low-RPM rotation, fog, intersection-pause, prefers-reduced-motion-aware,
// pointer-driven sway, full dispose on unmount.
//
// Each sport gets its own field of slabs evoking the playing surface —
// NFL goalposts + 50-yd line, NBA arc + free-throw stack, NHL ice rails
// + crease, MLB diamond. ≤6 meshes per scene, identical lighting rig
// to the main landing sculpture for visual continuity.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Sport, Tone } from './copy'

interface Slab {
  size: [number, number, number]
  pos:  [number, number, number]
  rot:  [number, number, number]
  spin: [number, number, number]
  edge: number
}

interface SceneSpec {
  slabs: Slab[]
  rails?: { from: [number, number, number]; to: [number, number, number]; color: number }[]
  arcs?:  { center: [number, number, number]; radius: number; from: number; to: number; color: number }[]
  horizonY?: number
}

const TONE_HEX: Record<Tone, { primary: number; accent: number; soft: number }> = {
  amber:  { primary: 0xf59e0b, accent: 0xfde68a, soft: 0xfb923c },
  orange: { primary: 0xfb923c, accent: 0xfdba74, soft: 0xf59e0b },
  red:    { primary: 0xef4444, accent: 0xfca5a5, soft: 0xfb923c },
}

function nflScene(t: { primary: number; accent: number; soft: number }): SceneSpec {
  return {
    slabs: [
      // crossbar
      { size: [12, 0.5, 0.5], pos: [0, 3.6, 0],   rot: [0, 0, 0],     spin: [0, 0.004, 0], edge: t.primary },
      // uprights
      { size: [0.5, 6,   0.5], pos: [-5.6, 0.6, 0], rot: [0, 0, 0],   spin: [0, 0.004, 0], edge: t.primary },
      { size: [0.5, 6,   0.5], pos: [ 5.6, 0.6, 0], rot: [0, 0, 0],   spin: [0, 0.004, 0], edge: t.primary },
      // base / field slab
      { size: [16, 0.6, 6],   pos: [0, -3,  -1.5], rot: [0.0, 0.0, 0], spin: [0, 0.003, 0], edge: t.soft },
      // flying yardage marker
      { size: [3, 0.4, 0.4],  pos: [-2, -0.5, 2], rot: [0, 0.4, 0],   spin: [0, 0.012, 0], edge: t.accent },
    ],
    horizonY: -3.4,
  }
}

function nbaScene(t: { primary: number; accent: number; soft: number }): SceneSpec {
  return {
    slabs: [
      // baseline slab (court width)
      { size: [14, 0.5, 1.0], pos: [0, -3.6, 0], rot: [0, 0, 0],     spin: [0, 0.003, 0], edge: t.primary },
      // backboard
      { size: [3.5, 2.2, 0.3], pos: [0, 1.6, -0.5], rot: [0, 0, 0], spin: [0, 0.005, 0], edge: t.primary },
      // free-throw lane sides
      { size: [0.4, 5,   0.4], pos: [-2.2, -1, 0], rot: [0, 0, 0], spin: [0, 0.005, 0], edge: t.soft },
      { size: [0.4, 5,   0.4], pos: [ 2.2, -1, 0], rot: [0, 0, 0], spin: [0, 0.005, 0], edge: t.soft },
      // floating perimeter shooter slab
      { size: [4, 0.4, 0.4], pos: [3.2, 0.5, 2], rot: [0, 0.6, 0.1], spin: [0, 0.014, 0.002], edge: t.accent },
    ],
    arcs: [
      // 3pt arc (top of key)
      { center: [0, -1, 0], radius: 5.2, from: Math.PI * 0.15, to: Math.PI * 0.85, color: t.primary },
    ],
    horizonY: -3.8,
  }
}

function nhlScene(t: { primary: number; accent: number; soft: number }): SceneSpec {
  return {
    slabs: [
      // far rail
      { size: [16, 0.4, 0.4], pos: [0,  3, -1], rot: [0.05, 0, 0], spin: [0, 0.0035, 0], edge: t.primary },
      // near rail
      { size: [16, 0.4, 0.4], pos: [0, -3,  1], rot: [-0.05, 0, 0], spin: [0, 0.0035, 0], edge: t.primary },
      // goal frame top
      { size: [2.6, 0.3, 0.3], pos: [-5.5, 0.6, 0], rot: [0, 0, 0], spin: [0, 0.005, 0], edge: t.soft },
      // goal posts
      { size: [0.3, 1.6, 0.3], pos: [-6.7, -0.2, 0], rot: [0, 0, 0], spin: [0, 0.005, 0], edge: t.soft },
      { size: [0.3, 1.6, 0.3], pos: [-4.3, -0.2, 0], rot: [0, 0, 0], spin: [0, 0.005, 0], edge: t.soft },
      // floating puck slab
      { size: [0.7, 0.25, 0.7], pos: [2, 0, 1.5], rot: [0.2, 0.4, 0.1], spin: [0.02, 0.03, 0], edge: t.accent },
    ],
    arcs: [
      // crease arc
      { center: [-5.5, -0.6, 0], radius: 1.4, from: 0, to: Math.PI, color: t.accent },
    ],
    horizonY: -3.4,
  }
}

function mlbScene(t: { primary: number; accent: number; soft: number }): SceneSpec {
  return {
    slabs: [
      // home plate
      { size: [1.4, 0.4, 1.4], pos: [0, -3, 1.5], rot: [0, Math.PI / 4, 0], spin: [0, 0.003, 0], edge: t.primary },
      // 1b
      { size: [1.0, 0.4, 1.0], pos: [4.2, -1.5, -1], rot: [0, Math.PI / 4, 0], spin: [0, 0.003, 0], edge: t.soft },
      // 2b
      { size: [1.0, 0.4, 1.0], pos: [0, 0.2, -3.5], rot: [0, Math.PI / 4, 0], spin: [0, 0.003, 0], edge: t.soft },
      // 3b
      { size: [1.0, 0.4, 1.0], pos: [-4.2, -1.5, -1], rot: [0, Math.PI / 4, 0], spin: [0, 0.003, 0], edge: t.soft },
      // pitcher's mound disc
      { size: [1.6, 0.5, 1.6], pos: [0, -1.6, -0.5], rot: [0, 0, 0], spin: [0, 0.005, 0], edge: t.accent },
      // floating bat slab
      { size: [3.5, 0.3, 0.3], pos: [3, 1.5, 1.5], rot: [0, 0.3, -0.4], spin: [0, 0.012, 0], edge: t.accent },
    ],
    horizonY: -3.6,
  }
}

const SCENES: Record<Sport, (t: { primary: number; accent: number; soft: number }) => SceneSpec> = {
  NFL: nflScene,
  NBA: nbaScene,
  NHL: nhlScene,
  MLB: mlbScene,
}

function arcGeometry(center: [number, number, number], radius: number, from: number, to: number): THREE.BufferGeometry {
  const segs = 64
  const pts: number[] = []
  for (let i = 0; i <= segs; i++) {
    const a = from + (to - from) * (i / segs)
    pts.push(center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius, center[2])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
  return g
}

interface Props {
  sport: Sport
  tone: Tone
  className?: string
}

export default function SportSculpture({ sport, tone, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = ref.current
    if (!mount) return

    const palette = TONE_HEX[tone]
    const spec = SCENES[sport](palette)

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x070a12, 0.045)

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200)
    camera.position.set(0, 1.8, 26)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0x1a1f2e, 1.0))
    const rim = new THREE.DirectionalLight(palette.primary, 0.55)
    rim.position.set(-6, 8, 4)
    scene.add(rim)
    const fill = new THREE.DirectionalLight(0x38415a, 0.6)
    fill.position.set(8, -2, 6)
    scene.add(fill)

    const root = new THREE.Group()
    scene.add(root)

    interface SlabHandle {
      mesh: THREE.Mesh
      edges: THREE.LineSegments
      spin: THREE.Vector3
    }

    const slabs: SlabHandle[] = spec.slabs.map((s) => {
      const geo = new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2])
      const mat = new THREE.MeshStandardMaterial({ color: 0x141821, roughness: 0.92, metalness: 0.0 })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
      mesh.rotation.set(s.rot[0], s.rot[1], s.rot[2])

      const edgeGeo = new THREE.EdgesGeometry(geo, 12)
      const edgeMat = new THREE.LineBasicMaterial({ color: s.edge, transparent: true, opacity: 0.78, depthWrite: false })
      const edges = new THREE.LineSegments(edgeGeo, edgeMat)
      mesh.add(edges)

      root.add(mesh)
      return { mesh, edges, spin: new THREE.Vector3(s.spin[0], s.spin[1], s.spin[2]) }
    })

    const arcs: { line: THREE.Line; geo: THREE.BufferGeometry; mat: THREE.LineBasicMaterial }[] = (spec.arcs ?? []).map((a) => {
      const geo = arcGeometry(a.center, a.radius, a.from, a.to)
      const mat = new THREE.LineBasicMaterial({ color: a.color, transparent: true, opacity: 0.6 })
      const line = new THREE.Line(geo, mat)
      root.add(line)
      return { line, geo, mat }
    })

    const horizonY = spec.horizonY ?? -3.4
    const horizonGeo = new THREE.BufferGeometry()
    horizonGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-30, horizonY, 0, 30, horizonY, 0]), 3))
    const horizonMat = new THREE.LineBasicMaterial({ color: palette.primary, transparent: true, opacity: 0.18 })
    const horizon = new THREE.Line(horizonGeo, horizonMat)
    scene.add(horizon)

    const onResize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
    }
    onResize()
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 }
    const onPointer = (e: PointerEvent) => {
      const rect = mount.getBoundingClientRect()
      pointer.tx = ((e.clientX - rect.left) / rect.width  - 0.5) * 0.30
      pointer.ty = ((e.clientY - rect.top)  / rect.height - 0.5) * 0.18
    }
    mount.addEventListener('pointermove', onPointer)

    let tabVisible = !document.hidden
    let onScreen = true
    const onVis = () => { tabVisible = !document.hidden }
    document.addEventListener('visibilitychange', onVis)

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) onScreen = e.isIntersecting },
      { root: null, threshold: 0 },
    )
    io.observe(mount)

    const clock = new THREE.Clock()
    let raf = 0

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (!tabVisible || !onScreen) return

      const dt = Math.min(clock.getDelta(), 0.05)
      const t = clock.getElapsedTime()

      pointer.x += (pointer.tx - pointer.x) * 0.04
      pointer.y += (pointer.ty - pointer.y) * 0.04
      root.rotation.y = pointer.x + Math.sin(t * 0.04) * 0.10
      root.rotation.x = pointer.y + Math.sin(t * 0.03) * 0.04

      for (const s of slabs) {
        s.mesh.rotation.x += s.spin.x * dt
        s.mesh.rotation.y += s.spin.y * dt
        s.mesh.rotation.z += s.spin.z * dt
      }

      renderer.render(scene, camera)
    }

    if (reducedMotion) {
      renderer.render(scene, camera)
    } else {
      animate()
    }

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      mount.removeEventListener('pointermove', onPointer)
      slabs.forEach((s) => {
        s.mesh.geometry.dispose()
        ;(s.mesh.material as THREE.Material).dispose()
        s.edges.geometry.dispose()
        ;(s.edges.material as THREE.Material).dispose()
      })
      arcs.forEach((a) => {
        a.geo.dispose()
        a.mat.dispose()
      })
      horizonGeo.dispose()
      horizonMat.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [sport, tone])

  return <div ref={ref} className={className ?? 'absolute inset-0'} aria-hidden />
}
