#!/usr/bin/env node
// Builds the app icon family from build/icon-source.png — the blue speech
// bubble that is the product's mark. The artwork is no longer drawn here; the
// only thing still rendered procedurally is the tile it sits on: a dark
// neutral superellipse (spanning 824/1024 of the canvas, the macOS HIG
// proportion) washed #20232C → #0E0F13, so the bubble's blue is the icon's
// only hue.
//
// Pipeline, all of it dependency-free:
//   1. sips decodes the source PNG to a BMP, parsed below (macOS ships sips,
//      and iconutil already made this script macOS-only — no image deps, which
//      is the repo's iron rule).
//   2. The near-white studio background is keyed out by flood-filling from the
//      border and un-premultiplying the anti-aliased edge band. It is a flood
//      fill and NOT a "remove everything white" pass on purpose: the three
//      dots inside the bubble are white too, and are never reached from the
//      border, so they survive as opaque white.
//   3. The keyed bubble is cropped to its alpha bounding box, area-resampled
//      to 0.62 of the canvas wide, and composited over the tile (with a soft
//      blurred drop shadow) to make the 1024 master.
//   4. Every other size is box-filtered down from that master.
//
// Outputs: build/icon.icns (10 iconset entries), build/icon.ico (256/64/48/
// 32/16, PNG entries) and resources/icon.png (512, used by the splash window,
// the README and the E2E's upload fixture).
//
// Deterministic: same source in, byte-identical files out. Run it with
//   node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SIZE = 1024
const SS = 3 // tile supersample factor
const TILE_R = 0.402 // superellipse radius in unit space — 824/1024 across
const TILE_N = 4.5 // superellipse exponent (unchanged from the drawn tile)
const BUBBLE_W = 0.62 // keyed bubble's bbox width, as a fraction of the canvas
const KEY_TOL = 26 // flood-fill tolerance around the measured background
const KEY_BAND = 3 // px the background region is dilated by to catch the AA edge
const KEY_FLOOR = 6 // colour distance below which a pixel is simply background
const REF_R = 6 // px searched for the local opaque colour when un-premultiplying
const SHADOW_DY = 12 // px the bubble's shadow is offset down
const SHADOW_BLUR = 9 // px radius of each of the three box-blur passes
const SHADOW_A = 0.3 // peak shadow opacity

const mix = (a, b, t) => a + (b - a) * t
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// Source decode: sips → BMP → RGBA

// sips exits 0 on an input it cannot read — it only prints "not a valid file -
// skipping" and writes nothing — so neither of the two checks below is
// paranoia: without them the failure surfaces as an ENOENT on a temp path the
// finally block has already deleted, which names everything except the actual
// problem.
function decodePng(file) {
  if (!existsSync(file)) {
    console.error(`make-icons: missing source ${file}`)
    console.error("  It is this pipeline's committed source of truth — restore it from git (or")
    console.error('  drop the new artwork there) and re-run. Nothing else here is the artwork.')
    process.exit(1)
  }
  const dir = mkdtempSync(join(tmpdir(), 'chat-icon-'))
  try {
    const bmp = join(dir, 'source.bmp')
    const sips = spawnSync('sips', ['-s', 'format', 'bmp', file, '--out', bmp], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    })
    if (sips.error) {
      console.error(`make-icons: could not run sips (${sips.error.message}) — this script is macOS-only.`)
      process.exit(1)
    }
    if (sips.status !== 0 || !existsSync(bmp)) {
      const why = (sips.stderr || '').trim() || `sips exited ${sips.status}`
      console.error(`make-icons: sips could not decode ${file}\n  ${why}`)
      process.exit(1)
    }
    return parseBmp(readFileSync(bmp))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Enough of BMP for what sips writes: uncompressed 24- or 32-bit, either row
// order (sips emits top-down, i.e. a negative height), rows padded to 4 bytes.
function parseBmp(buf) {
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('not a BMP')
  const dataOffset = buf.readUInt32LE(10)
  const width = buf.readInt32LE(18)
  const signedHeight = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported BMP depth: ${bpp}`)
  if (compression !== 0 && compression !== 3) throw new Error(`compressed BMP: ${compression}`)
  const height = Math.abs(signedHeight)
  const topDown = signedHeight < 0
  const bytes = bpp >> 3
  const stride = (width * bytes + 3) & ~3
  if (dataOffset + stride * height > buf.length) throw new Error('truncated BMP')
  const px = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    let s = dataOffset + (topDown ? y : height - 1 - y) * stride
    let d = y * width * 4
    for (let x = 0; x < width; x++) {
      px[d] = buf[s + 2]
      px[d + 1] = buf[s + 1]
      px[d + 2] = buf[s]
      px[d + 3] = 255 // the source is opaque; a 32-bit alpha byte is ignored
      s += bytes
      d += 4
    }
  }
  return { px, width, height }
}

// ---------------------------------------------------------------------------
// Background keying

// Flood-fill the background in from the border, widen it over the anti-aliased
// edge, and inside that widened region turn "distance from the background
// colour" into alpha, un-premultiplying the colour the artwork was blended
// with white over. Everything the fill never reached — the three white dots
// included — is left exactly as it came in, fully opaque.
function keyBackground(img) {
  const { px, width: W, height: H } = img
  const n = W * H

  // (a) background colour: the mean of a 2px ring around the border
  let br = 0
  let bg_ = 0
  let bb = 0
  let count = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x > 1 && x < W - 2 && y > 1 && y < H - 2) continue
      const i = (y * W + x) * 4
      br += px[i]
      bg_ += px[i + 1]
      bb += px[i + 2]
      count++
    }
  }
  const bg = [br / count, bg_ / count, bb / count]
  const distToBg = (i) => Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2])

  // (b) flood fill from every border pixel over anything near that colour
  const region = new Uint8Array(n)
  const stack = new Int32Array(n)
  let sp = 0
  const push = (i) => {
    if (region[i]) return
    if (distToBg(i) > KEY_TOL) return
    region[i] = 1
    stack[sp++] = i
  }
  for (let x = 0; x < W; x++) {
    push(x)
    push((H - 1) * W + x)
  }
  for (let y = 0; y < H; y++) {
    push(y * W)
    push(y * W + W - 1)
  }
  while (sp > 0) {
    const i = stack[--sp]
    const x = i % W
    const y = (i / W) | 0
    if (x > 0) push(i - 1)
    if (x < W - 1) push(i + 1)
    if (y > 0) push(i - W)
    if (y < H - 1) push(i + W)
  }

  // (c) dilate it by KEY_BAND px — that band is the artwork's soft edge
  let grown = Uint8Array.from(region)
  for (let pass = 0; pass < KEY_BAND; pass++) {
    const next = Uint8Array.from(grown)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!grown[y * W + x]) continue
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx >= 0 && xx < W) next[yy * W + xx] = 1
          }
        }
      }
    }
    grown = next
  }

  // Fallback reference colour: the mean of the opaque pixels bordering the
  // band — i.e. the artwork's own edge colour, used where no local one is
  // found. (The gradient makes a local reference the better one; this is only
  // a floor.)
  let fr = 0
  let fg = 0
  let fb = 0
  let fn = 0
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (grown[i]) continue
      if (!grown[i - 1] && !grown[i + 1] && !grown[i - W] && !grown[i + W]) continue
      fr += px[i * 4]
      fg += px[i * 4 + 1]
      fb += px[i * 4 + 2]
      fn++
    }
  }
  const globalRef = fn > 0 ? [fr / fn, fg / fn, fb / fn] : [0, 0, 0]
  const globalRefD = Math.max(1, Math.hypot(globalRef[0] - bg[0], globalRef[1] - bg[1], globalRef[2] - bg[2]))

  // Nearest opaque pixel within REF_R — its colour is what this edge pixel was
  // blended from, so its distance to the background is the full-alpha scale.
  const localRefDist = (x, y) => {
    let best = Infinity
    let bi = -1
    for (let dy = -REF_R; dy <= REF_R; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= H) continue
      for (let dx = -REF_R; dx <= REF_R; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= W) continue
        const j = yy * W + xx
        if (grown[j]) continue
        const d2 = dx * dx + dy * dy
        if (d2 < best) {
          best = d2
          bi = j
        }
      }
    }
    if (bi < 0) return globalRefD
    return Math.max(1, Math.hypot(px[bi * 4] - bg[0], px[bi * 4 + 1] - bg[1], px[bi * 4 + 2] - bg[2]))
  }

  // (d)+(e) alpha and un-premultiplied colour inside region+band; untouched
  // (opaque) everywhere else
  const out = Buffer.alloc(n * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const o = i * 4
      if (!grown[i]) {
        px.copy(out, o, o, o + 4)
        continue
      }
      const d = distToBg(i)
      if (d <= KEY_FLOOR) continue // stays 0,0,0,0 — pure background
      const a = clamp(d / localRefDist(x, y), 0, 1)
      if (a <= 0) continue
      for (let c = 0; c < 3; c++) {
        out[o + c] = clamp(Math.round((px[o + c] - (1 - a) * bg[c]) / a), 0, 255)
      }
      out[o + 3] = Math.round(a * 255)
    }
  }
  return { px: out, width: W, height: H, bg: bg.map((v) => Math.round(v)) }
}

function alphaBounds(px, W, H) {
  let x0 = W
  let y0 = H
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (px[(y * W + x) * 4 + 3] === 0) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) throw new Error('keyed source is fully transparent')
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

function crop(px, W, r) {
  const out = Buffer.alloc(r.w * r.h * 4)
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * W + r.x) * 4
    px.copy(out, y * r.w * 4, s, s + r.w * 4)
  }
  return out
}

// Separable area (box) resample over premultiplied colour — every destination
// pixel is the coverage-weighted mean of the source interval it spans, which
// is the right filter both for the ~2x reductions here and for the mild
// enlargement of the cropped bubble.
function resampleArea(src, sw, sh, dw, dh) {
  const rx = sw / dw
  const mid = new Float32Array(dw * sh * 4)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const x0 = x * rx
      const x1 = (x + 1) * rx
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let w = 0
      for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
        const wt = Math.min(x1, sx + 1) - Math.max(x0, sx)
        if (wt <= 0) continue
        const i = (y * sw + sx) * 4
        const pa = src[i + 3] / 255
        r += src[i] * pa * wt
        g += src[i + 1] * pa * wt
        b += src[i + 2] * pa * wt
        a += pa * wt
        w += wt
      }
      const o = (y * dw + x) * 4
      mid[o] = r / w
      mid[o + 1] = g / w
      mid[o + 2] = b / w
      mid[o + 3] = a / w
    }
  }
  const ry = sh / dh
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const y0 = y * ry
    const y1 = (y + 1) * ry
    for (let x = 0; x < dw; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let w = 0
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wt = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (wt <= 0) continue
        const i = (sy * dw + x) * 4
        r += mid[i] * wt
        g += mid[i + 1] * wt
        b += mid[i + 2] * wt
        a += mid[i + 3] * wt
        w += wt
      }
      const o = (y * dw + x) * 4
      const alpha = a / w
      out[o] = alpha > 0 ? clamp(Math.round(r / w / alpha), 0, 255) : 0
      out[o + 1] = alpha > 0 ? clamp(Math.round(g / w / alpha), 0, 255) : 0
      out[o + 2] = alpha > 0 ? clamp(Math.round(b / w / alpha), 0, 255) : 0
      out[o + 3] = Math.round(alpha * 255)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Tile

function squircle(x, y, cx, cy, r, n = TILE_N) {
  const dx = Math.abs(x - cx) / r
  const dy = Math.abs(y - cy) / r
  return Math.pow(dx, n) + Math.pow(dy, n) - 1
}

function shadeTile(x, y) {
  const cov = 1 - smooth(-0.02, 0.02, squircle(x, y, 0.5, 0.5, TILE_R))
  if (cov <= 0) return [0, 0, 0, 0]
  // Dark neutral wash: #20232C (top-left) → #0E0F13 (bottom-right)
  const t = clamp((x + y) / 2, 0, 1)
  let r = mix(0x20, 0x0e, t)
  let g = mix(0x23, 0x0f, t)
  let b = mix(0x2c, 0x13, t)
  // …and a very faint cool glow behind the mark, nothing more
  const glow = Math.exp(-(((x - 0.34) ** 2 + (y - 0.3) ** 2) / 0.1)) * 0.16
  r = mix(r, 0x3b, glow)
  g = mix(g, 0x45, glow)
  b = mix(b, 0x60, glow)
  return [r, g, b, 255 * cov]
}

function renderTile(size) {
  const px = Buffer.alloc(size * size * 4)
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = shadeTile((xx + (sx + 0.5) / SS) / size, (yy + (sy + 0.5) / SS) / size)
          r += pr * pa
          g += pg * pa
          b += pb * pa
          a += pa
        }
      }
      const i = (yy * size + xx) * 4
      const alpha = a / (SS * SS)
      px[i] = a > 0 ? Math.round(r / a) : 0
      px[i + 1] = a > 0 ? Math.round(g / a) : 0
      px[i + 2] = a > 0 ? Math.round(b / a) : 0
      px[i + 3] = Math.round(alpha)
    }
  }
  return px
}

// ---------------------------------------------------------------------------
// Compositing

// Three box-blur passes over a single alpha plane ≈ a gaussian, separable and
// cheap. Used for the bubble's drop shadow only.
function blurAlpha(a, W, H, radius) {
  let src = a
  for (let pass = 0; pass < 3; pass++) {
    const h = new Float32Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0
        let n = 0
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          s += src[y * W + xx]
          n++
        }
        h[y * W + x] = s / n
      }
    }
    const v = new Float32Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0
        let n = 0
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          s += h[yy * W + x]
          n++
        }
        v[y * W + x] = s / n
      }
    }
    src = v
  }
  return src
}

// src-over, both sides straight alpha, in place on dst.
function composite(dst, src, W, H) {
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    const sa = src[o + 3] / 255
    if (sa <= 0) continue
    const da = dst[o + 3] / 255
    const outA = sa + da * (1 - sa)
    for (let c = 0; c < 3; c++) {
      dst[o + c] = clamp(Math.round((src[o + c] * sa + dst[o + c] * da * (1 - sa)) / outA), 0, 255)
    }
    dst[o + 3] = Math.round(outA * 255)
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder

function crc32(buf) {
  let c
  const table =
    crc32.table ??
    (crc32.table = Array.from({ length: 256 }, (_, n) => {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      return c >>> 0
    }))
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // Filter byte 0 per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Box-filter downscale, averaging premultiplied colour
function downscale(pixels, from, to) {
  const out = Buffer.alloc(to * to * 4)
  const ratio = from / to
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0
      const y0 = Math.floor(y * ratio)
      const y1 = Math.min(from, Math.ceil((y + 1) * ratio))
      const x0 = Math.floor(x * ratio)
      const x1 = Math.min(from, Math.ceil((x + 1) * ratio))
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * from + xx) * 4
          const pa = pixels[i + 3]
          r += pixels[i] * pa
          g += pixels[i + 1] * pa
          b += pixels[i + 2] * pa
          a += pa
          n++
        }
      }
      const o = (y * to + x) * 4
      out[o] = a ? Math.round(r / a) : 0
      out[o + 1] = a ? Math.round(g / a) : 0
      out[o + 2] = a ? Math.round(b / a) : 0
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// ---------------------------------------------------------------------------

const root = process.cwd()
const buildDir = join(root, 'build')
const sourcePath = join(buildDir, 'icon-source.png')

console.log(`decoding ${sourcePath}…`)
const source = decodePng(sourcePath)
console.log(`  source ${source.width}×${source.height}`)

const keyed = keyBackground(source)
const box = alphaBounds(keyed.px, keyed.width, keyed.height)
console.log(`  background #${keyed.bg.map((v) => v.toString(16).padStart(2, '0')).join('')}`)
console.log(`  bubble bbox ${box.w}×${box.h} at ${box.x},${box.y}`)

const dw = Math.round(SIZE * BUBBLE_W)
const dh = Math.round((dw * box.h) / box.w)
const bubble = resampleArea(crop(keyed.px, keyed.width, box), box.w, box.h, dw, dh)
const ox = Math.round((SIZE - dw) / 2)
const oy = Math.round((SIZE - dh) / 2)
console.log(`  bubble ${dw}×${dh} at ${ox},${oy} (scale ${(dw / box.w).toFixed(3)})`)

console.log('rendering master 1024×1024…')
const master = renderTile(SIZE)

// Shadow: the bubble's own alpha, blurred and pushed down, clipped to the tile
const shadowSrc = new Float32Array(SIZE * SIZE)
for (let y = 0; y < dh; y++) {
  const ty = oy + y + SHADOW_DY
  if (ty < 0 || ty >= SIZE) continue
  for (let x = 0; x < dw; x++) {
    shadowSrc[ty * SIZE + ox + x] = bubble[(y * dw + x) * 4 + 3] / 255
  }
}
const shadow = blurAlpha(shadowSrc, SIZE, SIZE, SHADOW_BLUR)
const shadowLayer = Buffer.alloc(SIZE * SIZE * 4)
for (let i = 0; i < SIZE * SIZE; i++) {
  shadowLayer[i * 4 + 3] = Math.round(clamp(shadow[i] * SHADOW_A, 0, 1) * (master[i * 4 + 3] / 255) * 255)
}
composite(master, shadowLayer, SIZE, SIZE)

// Bubble
const bubbleLayer = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < dh; y++) {
  const s = y * dw * 4
  bubble.copy(bubbleLayer, ((oy + y) * SIZE + ox) * 4, s, s + dw * 4)
}
composite(master, bubbleLayer, SIZE, SIZE)

mkdirSync(buildDir, { recursive: true })
const pngOf = (size) => encodePng(size === SIZE ? master : downscale(master, SIZE, size), size)

// macOS .icns via iconutil
const iconset = join(buildDir, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
const entries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]
for (const [name, size] of entries) writeFileSync(join(iconset, name), pngOf(size))
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
rmSync(iconset, { recursive: true, force: true })
console.log('build/icon.icns written')

// Windows .ico (PNG-compressed entries)
const icoSizes = [256, 64, 48, 32, 16]
const pngs = icoSizes.map((s) => pngOf(s))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(icoSizes.length, 4)
let offset = 6 + 16 * icoSizes.length
const dirs = []
for (let i = 0; i < icoSizes.length; i++) {
  const d = Buffer.alloc(16)
  d[0] = icoSizes[i] === 256 ? 0 : icoSizes[i]
  d[1] = icoSizes[i] === 256 ? 0 : icoSizes[i]
  d[4] = 1 // planes lo
  d[6] = 32 // bpp lo
  d.writeUInt32LE(pngs[i].length, 8)
  d.writeUInt32LE(offset, 12)
  offset += pngs[i].length
  dirs.push(d)
}
writeFileSync(join(buildDir, 'icon.ico'), Buffer.concat([header, ...dirs, ...pngs]))
console.log('build/icon.ico written')

// A renderer-usable copy for the splash window (resources/splash.html), the
// README embed and the E2E's upload fixture — the only three consumers
writeFileSync(join(root, 'resources', 'icon.png'), pngOf(512))
console.log('resources/icon.png written')
