'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

const ROWS = [
  { y:  3.0, color: 0xf59e0b, speed:  1.6, count: 30 },
  { y:  1.0, color: 0xfb923c, speed: -2.1, count: 36 },
  { y: -1.0, color: 0xef4444, speed:  1.3, count: 28 },
  { y: -3.0, color: 0xfb923c, speed: -1.8, count: 34 },
] as const

function makePillTexture(): THREE.CanvasTexture {
  const w = 128, h = 64
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  const pad = 8
  ctx.fillStyle = 'white'
  ctx.beginPath()
  const r = (h - pad * 2) / 2
  ctx.moveTo(pad + r, pad)
  ctx.lineTo(w - pad - r, pad)
  ctx.arc(w - pad - r, pad + r, r, -Math.PI / 2, Math.PI / 2)
  ctx.lineTo(pad + r, h - pad)
  ctx.arc(pad + r, pad + r, r, Math.PI / 2, -Math.PI / 2)
  ctx.closePath()
  ctx.fill()
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  return tex
}

interface Pill { mesh: THREE.Mesh; speed: number; bound: number }

export default function SportsTicker() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = ref.current
    if (!mount) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(0, 0, 12)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const pillTex = makePillTexture()
    const pills: Pill[] = []

    ROWS.forEach((row) => {
      const widthBound = 22
      const spacing = (widthBound * 2) / row.count
      for (let i = 0; i < row.count; i++) {
        const w = 0.6 + Math.random() * 1.4
        const h = 0.32
        const geo = new THREE.PlaneGeometry(w, h)
        const mat = new THREE.MeshBasicMaterial({
          color: row.color,
          map: pillTex,
          transparent: true,
          opacity: 0.18 + Math.random() * 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
        const mesh = new THREE.Mesh(geo, mat)
        mesh.position.set(-widthBound + i * spacing + (Math.random() - 0.5) * spacing, row.y + (Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.6)
        scene.add(mesh)
        pills.push({ mesh, speed: row.speed * (0.85 + Math.random() * 0.3), bound: widthBound })
      }
    })

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight
      if (!w || !h) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
    }
    onResize()
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    const clock = new THREE.Clock()
    let raf = 0
    let visible = true
    const onVis = () => { visible = !document.hidden }
    document.addEventListener('visibilitychange', onVis)

    const animate = () => {
      raf = requestAnimationFrame(animate)
      if (!visible) return
      const dt = Math.min(clock.getDelta(), 0.06)
      for (const p of pills) {
        p.mesh.position.x += p.speed * dt
        if (p.speed > 0 && p.mesh.position.x > p.bound) p.mesh.position.x = -p.bound
        if (p.speed < 0 && p.mesh.position.x < -p.bound) p.mesh.position.x = p.bound
      }
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      pills.forEach((p) => {
        scene.remove(p.mesh)
        p.mesh.geometry.dispose()
        ;(p.mesh.material as THREE.MeshBasicMaterial).dispose()
      })
      pillTex.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={ref} className="absolute inset-0" aria-hidden />
}
