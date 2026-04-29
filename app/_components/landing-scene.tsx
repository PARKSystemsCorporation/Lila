'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

const RING_CONFIGS = [
  { radius: 4.5, count: 36, tiltX:  0.05, tiltZ:  0.0,  color: 0xf59e0b, spin:  0.10 },
  { radius: 6.4, count: 52, tiltX:  0.65, tiltZ:  0.18, color: 0xfb923c, spin: -0.07 },
  { radius: 8.4, count: 72, tiltX: -0.50, tiltZ: -0.22, color: 0xef4444, spin:  0.05 },
] as const

function makeDotTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0.0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,255,255,0.85)')
  grad.addColorStop(0.55, 'rgba(255,255,255,0.18)')
  grad.addColorStop(1.0, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  return tex
}

interface RingHandle {
  group: THREE.Group
  points: THREE.Points
  line: THREE.Line
  worldPositions: () => THREE.Vector3[]
  spin: number
  color: number
  count: number
}

export default function LandingScene() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = ref.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x070a12, 0.04)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200)
    camera.position.set(0, 1.4, 18)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const dotTex = makeDotTexture()

    const root = new THREE.Group()
    scene.add(root)

    const rings: RingHandle[] = RING_CONFIGS.map((cfg) => {
      const group = new THREE.Group()
      group.rotation.x = cfg.tiltX
      group.rotation.z = cfg.tiltZ

      const localPositions: THREE.Vector3[] = []
      const dotPositions = new Float32Array(cfg.count * 3)
      for (let i = 0; i < cfg.count; i++) {
        const t = (i / cfg.count) * Math.PI * 2
        const r = cfg.radius + (Math.random() - 0.5) * 0.06
        const x = Math.cos(t) * r
        const y = (Math.random() - 0.5) * 0.05
        const z = Math.sin(t) * r
        localPositions.push(new THREE.Vector3(x, y, z))
        dotPositions[i * 3] = x
        dotPositions[i * 3 + 1] = y
        dotPositions[i * 3 + 2] = z
      }

      const dotGeo = new THREE.BufferGeometry()
      dotGeo.setAttribute('position', new THREE.BufferAttribute(dotPositions, 3))
      const dotMat = new THREE.PointsMaterial({
        color: cfg.color,
        size: 0.35,
        map: dotTex,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const points = new THREE.Points(dotGeo, dotMat)
      group.add(points)

      const segs = 256
      const linePts = new Float32Array((segs + 1) * 3)
      for (let i = 0; i <= segs; i++) {
        const t = (i / segs) * Math.PI * 2
        linePts[i * 3] = Math.cos(t) * cfg.radius
        linePts[i * 3 + 1] = 0
        linePts[i * 3 + 2] = Math.sin(t) * cfg.radius
      }
      const lineGeo = new THREE.BufferGeometry()
      lineGeo.setAttribute('position', new THREE.BufferAttribute(linePts, 3))
      const lineMat = new THREE.LineBasicMaterial({
        color: cfg.color,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const line = new THREE.LineLoop(lineGeo, lineMat)
      group.add(line)

      root.add(group)

      return {
        group,
        points,
        line,
        spin: cfg.spin,
        color: cfg.color,
        count: cfg.count,
        worldPositions: () => {
          group.updateMatrixWorld()
          return localPositions.map((p) => p.clone().applyMatrix4(group.matrixWorld))
        },
      }
    })

    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffb347,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.28, 24, 24), coreMat)
    scene.add(core)

    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.10,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const halo = new THREE.Mesh(new THREE.SphereGeometry(1.4, 32, 32), haloMat)
    scene.add(halo)

    const STREAM_COUNT = 220
    const streamPos = new Float32Array(STREAM_COUNT * 3)
    const streamRing = new Int32Array(STREAM_COUNT)
    const streamPhase = new Float32Array(STREAM_COUNT)
    const streamSpeed = new Float32Array(STREAM_COUNT)
    for (let i = 0; i < STREAM_COUNT; i++) {
      const ringIdx = i % rings.length
      streamRing[i] = ringIdx
      streamPhase[i] = Math.random() * Math.PI * 2
      streamSpeed[i] = 0.20 + Math.random() * 0.45
    }
    const streamGeo = new THREE.BufferGeometry()
    streamGeo.setAttribute('position', new THREE.BufferAttribute(streamPos, 3))
    const streamColors = new Float32Array(STREAM_COUNT * 3)
    for (let i = 0; i < STREAM_COUNT; i++) {
      const c = new THREE.Color(RING_CONFIGS[streamRing[i]].color)
      streamColors[i * 3] = c.r
      streamColors[i * 3 + 1] = c.g
      streamColors[i * 3 + 2] = c.b
    }
    streamGeo.setAttribute('color', new THREE.BufferAttribute(streamColors, 3))
    const streamMat = new THREE.PointsMaterial({
      size: 0.18,
      map: dotTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const streamPts = new THREE.Points(streamGeo, streamMat)
    scene.add(streamPts)

    interface Flash {
      line: THREE.Line
      curve: THREE.QuadraticBezierCurve3
      life: number
      maxLife: number
      head: THREE.Mesh
    }
    const flashes: Flash[] = []
    const flashHeadGeo = new THREE.SphereGeometry(0.14, 12, 12)

    const spawnFlash = () => {
      if (rings.length < 2) return
      const a = Math.floor(Math.random() * rings.length)
      let b = Math.floor(Math.random() * rings.length)
      if (b === a) b = (a + 1) % rings.length

      const ra = rings[a]
      const rb = rings[b]
      const wpA = ra.worldPositions()
      const wpB = rb.worldPositions()
      const p1 = wpA[Math.floor(Math.random() * wpA.length)].clone()
      const p2 = wpB[Math.floor(Math.random() * wpB.length)].clone()
      const mid = p1.clone().add(p2).multiplyScalar(0.5).multiplyScalar(0.45)
      mid.y += (Math.random() - 0.5) * 1.2

      const curve = new THREE.QuadraticBezierCurve3(p1, mid, p2)
      const segs = 36
      const pts = curve.getPoints(segs)
      const arr = new Float32Array((segs + 1) * 3)
      for (let i = 0; i <= segs; i++) {
        arr[i * 3] = pts[i].x
        arr[i * 3 + 1] = pts[i].y
        arr[i * 3 + 2] = pts[i].z
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
      const mat = new THREE.LineBasicMaterial({
        color: 0xffd166,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const line = new THREE.Line(geo, mat)
      scene.add(line)

      const headMat = new THREE.MeshBasicMaterial({
        color: 0xffe6a8,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const head = new THREE.Mesh(flashHeadGeo, headMat)
      head.position.copy(p1)
      scene.add(head)

      flashes.push({ line, curve, life: 0, maxLife: 0.55 + Math.random() * 0.35, head })
    }

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
      pointer.tx = ((e.clientX - rect.left) / rect.width - 0.5) * 0.6
      pointer.ty = ((e.clientY - rect.top) / rect.height - 0.5) * 0.4
    }
    mount.addEventListener('pointermove', onPointer)

    const clock = new THREE.Clock()
    let raf = 0
    let visible = true
    const onVis = () => { visible = !document.hidden }
    document.addEventListener('visibilitychange', onVis)

    let nextFlashAt = 0.4

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (!visible) return

      const dt = Math.min(clock.getDelta(), 0.05)
      const t = clock.getElapsedTime()

      pointer.x += (pointer.tx - pointer.x) * 0.05
      pointer.y += (pointer.ty - pointer.y) * 0.05
      root.rotation.y += dt * 0.05
      root.rotation.x = pointer.y * 0.6 + Math.sin(t * 0.13) * 0.04
      root.rotation.z = pointer.x * 0.25

      rings.forEach((r) => { r.group.rotation.y += dt * r.spin })

      const s = 1 + Math.sin(t * 2.2) * 0.18
      core.scale.setScalar(s)
      halo.scale.setScalar(1 + Math.sin(t * 1.6 + 0.7) * 0.12)
      ;(halo.material as THREE.MeshBasicMaterial).opacity = 0.08 + (Math.sin(t * 1.6) + 1) * 0.04

      const sp = streamGeo.attributes.position as THREE.BufferAttribute
      for (let i = 0; i < STREAM_COUNT; i++) {
        const ringIdx = streamRing[i]
        const ring = rings[ringIdx]
        const cfg = RING_CONFIGS[ringIdx]
        streamPhase[i] += dt * streamSpeed[i]
        const a = streamPhase[i]
        const x = Math.cos(a) * cfg.radius
        const z = Math.sin(a) * cfg.radius
        const v = new THREE.Vector3(x, 0, z).applyEuler(ring.group.rotation)
        sp.setXYZ(i, v.x, v.y, v.z)
      }
      sp.needsUpdate = true

      if (t > nextFlashAt) {
        spawnFlash()
        nextFlashAt = t + 0.25 + Math.random() * 0.55
      }

      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i]
        f.life += dt
        const k = f.life / f.maxLife
        const fade = Math.max(0, 1 - k)
        ;(f.line.material as THREE.LineBasicMaterial).opacity = fade * 0.9
        const headT = Math.min(1, k * 1.4)
        f.head.position.copy(f.curve.getPoint(headT))
        ;(f.head.material as THREE.MeshBasicMaterial).opacity = fade
        f.head.scale.setScalar(0.6 + (1 - fade) * 1.4)
        if (f.life >= f.maxLife) {
          scene.remove(f.line)
          scene.remove(f.head)
          f.line.geometry.dispose()
          ;(f.line.material as THREE.LineBasicMaterial).dispose()
          ;(f.head.material as THREE.MeshBasicMaterial).dispose()
          flashes.splice(i, 1)
        }
      }

      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      mount.removeEventListener('pointermove', onPointer)
      flashes.forEach((f) => {
        scene.remove(f.line)
        scene.remove(f.head)
        f.line.geometry.dispose()
        ;(f.line.material as THREE.LineBasicMaterial).dispose()
        ;(f.head.material as THREE.MeshBasicMaterial).dispose()
      })
      rings.forEach((r) => {
        r.points.geometry.dispose()
        ;(r.points.material as THREE.PointsMaterial).dispose()
        r.line.geometry.dispose()
        ;(r.line.material as THREE.LineBasicMaterial).dispose()
      })
      streamGeo.dispose()
      streamMat.dispose()
      flashHeadGeo.dispose()
      coreMat.dispose()
      haloMat.dispose()
      core.geometry.dispose()
      halo.geometry.dispose()
      dotTex.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={ref} className="absolute inset-0" aria-hidden />
}
