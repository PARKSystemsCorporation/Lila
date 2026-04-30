'use client'

// Wide, slow neo-brutalist sculpture. Heavy slabs of dark concrete drift
// past each other at the origin, edges traced in amber so the silhouettes
// read like a brutalist monument from a distance. No stars, no orbits —
// just mass in flux.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

interface SlabSpec {
  size: [number, number, number]
  pos:  [number, number, number]
  rot:  [number, number, number]
  spin: [number, number, number]   // radians per second, very low
  edge: number                     // hex
}

const SLABS: SlabSpec[] = [
  { size: [16, 1.2, 4],   pos: [ 0,    0,   0],  rot: [ 0.05,  0.1,   0.0],  spin: [ 0,      0.012,  0     ], edge: 0xf59e0b },
  { size: [ 1.2, 9, 7],   pos: [-3.4, -1,  -2],  rot: [ 0.0,   0.4,  -0.1],  spin: [ 0,     -0.008,  0     ], edge: 0xfb923c },
  { size: [ 6, 6,  1.0],  pos: [ 4,    1,  -1],  rot: [-0.15,  0.2,   0.05], spin: [ 0.005,  0.006,  0     ], edge: 0xf59e0b },
  { size: [ 3, 0.8, 11],  pos: [ 1,    3,  -3],  rot: [ 0.2,  -0.25,  0.0],  spin: [ 0,      0.010, -0.003 ], edge: 0xea580c },
  { size: [ 1.0, 1.0, 1.0], pos: [-1.2, 2.4, 1.6], rot: [0.3, 0.2, 0.1], spin: [0.02, 0.02, 0.0], edge: 0xfde68a },
  { size: [ 9, 0.6, 0.6], pos: [-2,   -3,   2],  rot: [ 0.1,   0.6,   0.3],  spin: [ 0.003,  0.004,  0     ], edge: 0xfb923c },
]

export default function LandingSculpture() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = ref.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x070a12, 0.045)

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200)
    camera.position.set(0, 1.8, 26)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    // Soft amber rim light + fill so face shading reads concrete-grey, edges glow.
    scene.add(new THREE.AmbientLight(0x1a1f2e, 1.0))
    const rim = new THREE.DirectionalLight(0xf59e0b, 0.55)
    rim.position.set(-6, 8, 4)
    scene.add(rim)
    const fill = new THREE.DirectionalLight(0x38415a, 0.6)
    fill.position.set(8, -2, 6)
    scene.add(fill)

    const root = new THREE.Group()
    scene.add(root)

    interface Slab {
      mesh: THREE.Mesh
      edges: THREE.LineSegments
      spin: THREE.Vector3
    }
    const slabs: Slab[] = SLABS.map((s) => {
      const geo = new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2])
      const mat = new THREE.MeshStandardMaterial({
        color: 0x141821,
        roughness: 0.92,
        metalness: 0.0,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
      mesh.rotation.set(s.rot[0], s.rot[1], s.rot[2])

      const edgeGeo = new THREE.EdgesGeometry(geo, 12)
      const edgeMat = new THREE.LineBasicMaterial({
        color: s.edge,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      })
      const edges = new THREE.LineSegments(edgeGeo, edgeMat)
      mesh.add(edges)

      root.add(mesh)
      return { mesh, edges, spin: new THREE.Vector3(s.spin[0], s.spin[1], s.spin[2]) }
    })

    // Single hairline horizon — a brutalist cue, not an orbit.
    const horizon = (() => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-30, -5.4, 0,  30, -5.4, 0]), 3))
      const m = new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.18 })
      return new THREE.Line(g, m)
    })()
    scene.add(horizon)

    const onResize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
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
      pointer.tx = ((e.clientX - rect.left) / rect.width  - 0.5) * 0.35
      pointer.ty = ((e.clientY - rect.top)  / rect.height - 0.5) * 0.20
    }
    mount.addEventListener('pointermove', onPointer)

    // Pause whenever (a) the tab is hidden, (b) the canvas is scrolled
    // out of view, or (c) the user prefers reduced motion. (c) renders
    // exactly one frame and bails out of the RAF loop entirely.
    let tabVisible = !document.hidden
    let onScreen   = true
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
      const t  = clock.getElapsedTime()

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
      // Render one static frame so the silhouette still anchors the page,
      // then leave the GPU alone.
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
      horizon.geometry.dispose()
      ;(horizon.material as THREE.Material).dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={ref} className="absolute inset-0" aria-hidden />
}
