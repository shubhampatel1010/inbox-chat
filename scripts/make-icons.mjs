#!/usr/bin/env node
/**
 * Generates placeholder PWA icons from the app mark (white speech bubble on
 * the brand blue), writing PNGs directly with Node's built-in zlib — no image
 * library, so no new dependency.
 *
 *   npm run make-icons
 *
 * Replace the output in public/icons/ with client branding when it lands; the
 * filenames referenced by the manifest are stable.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

// --brand and --brand-contrast from styles.css (light theme).
const BRAND = [0x2f, 0x6d, 0xf6]
const WHITE = [0xff, 0xff, 0xff]

// ---------------------------------------------------------------- PNG writer
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** rgba: Uint8Array of size*size*4 */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // Each scanline is prefixed with filter type 0 (None).
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- geometry
/** Signed test: is (px,py) inside a rounded rectangle? Coords are 0..1. */
function inRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r)
  const cy = Math.min(Math.max(py, y + r), y + h - r)
  if (px >= x && px <= x + w && py >= y + r && py <= y + h - r) return true
  if (py >= y && py <= y + h && px >= x + r && px <= x + w - r) return true
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d
  return a >= 0 && b >= 0 && a + b <= 1
}

/**
 * The app mark: a speech bubble, matching the lucide MessageSquare silhouette
 * used in the rail and login screen. `scale` shrinks it toward the centre so a
 * maskable icon keeps its content inside the safe zone.
 */
function inGlyph(px, py, scale) {
  const x = (px - 0.5) / scale + 0.5
  const y = (py - 0.5) / scale + 0.5
  return (
    inRoundRect(x, y, 0.16, 0.22, 0.68, 0.44, 0.1) ||
    inTriangle(x, y, 0.24, 0.6, 0.44, 0.6, 0.24, 0.83)
  )
}

const SS = 4 // supersampling factor per axis

/**
 * @param size      pixel dimensions
 * @param maskable  full-bleed background + shrunken glyph (Android safe zone)
 * @param opaque    no transparency anywhere (iOS rejects alpha on touch icons)
 */
function render(size, { maskable = false, opaque = false } = {}) {
  const rgba = new Uint8Array(size * size * 4)
  // Rounded-square plate for normal icons; full bleed for maskable/apple.
  const plateRadius = maskable || opaque ? 0 : 0.225
  const glyphScale = maskable ? 0.62 : 0.86

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let plate = 0
      let glyph = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size
          const py = (y + (sy + 0.5) / SS) / size
          const onPlate =
            plateRadius === 0 ? true : inRoundRect(px, py, 0, 0, 1, 1, plateRadius)
          if (onPlate) {
            plate++
            if (inGlyph(px, py, glyphScale)) glyph++
          }
        }
      }

      const total = SS * SS
      const plateA = plate / total
      const glyphA = glyph / total
      const i = (y * size + x) * 4

      // Composite white glyph over the brand plate, then the plate over
      // transparency (or over brand itself when fully opaque).
      const mix = (c) => Math.round(BRAND[c] * (1 - glyphA) + WHITE[c] * glyphA)
      rgba[i] = mix(0)
      rgba[i + 1] = mix(1)
      rgba[i + 2] = mix(2)
      rgba[i + 3] = opaque ? 255 : Math.round(plateA * 255)
    }
  }
  return rgba
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'icon-512.png', size: 512, opts: {} },
  { file: 'icon-512-maskable.png', size: 512, opts: { maskable: true } },
  // iOS ignores manifest icons for the home screen and dislikes alpha.
  { file: 'apple-touch-icon.png', size: 180, opts: { opaque: true } },
]

mkdirSync(OUT_DIR, { recursive: true })
for (const { file, size, opts } of TARGETS) {
  const png = encodePng(size, render(size, opts))
  writeFileSync(join(OUT_DIR, file), png)
  console.log(`${file.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`)
}
console.log(`\nWritten to public/icons/`)
