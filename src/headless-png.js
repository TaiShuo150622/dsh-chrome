/**
 * Device-pixel PNG/JPEG frame helpers for the headless backend: parse a frame
 * size without decoding, decode/crop the top-left PNG prefix, and re-encode a
 * cropped RGB/RGBA buffer. Pure byte-level functions, no browser state.
 *
 * Chrome screencast frames are 8-bit, non-interlaced RGB/RGBA PNGs; anything
 * else (16-bit, palette, interlaced) makes `decodePngFrame` return null and the
 * caller keeps the capture path. The decoded pixels are cached on the frame
 * object by `src/headless.js`, so repeated crops of an unchanged page skip the
 * decode.
 */
import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CHANNELS = new Map([[0, 1], [2, 3], [4, 2], [6, 4]])
const PNG_CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function pngCrc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) crc = PNG_CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const chunk = Buffer.allocUnsafe(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'ascii')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(pngCrc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
  return chunk
}

const paethPredictor = (left, up, upLeft) => {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

// Per-row PNG unfiltering (filters 0..4) for the top-left prefix of the image.
// A crop only needs the rows/columns above-left of it: every PNG filter
// references just the previous pixels in the same row and the row above, so
// decoding the `maxRows` x `maxColumns` prefix is exact. A top-of-viewport clip
// therefore decodes a fraction of a full frame. Branches are per row and the
// left-neighbour prefix is peeled out of the inner loop.
function unfilterPngRows(filtered, width, height, channels, maxColumns, maxRows) {
  const sourceStride = width * channels
  const columns = Math.max(1, Math.min(width, maxColumns))
  const rows = Math.max(1, Math.min(height, maxRows))
  const stride = columns * channels
  if (filtered.length < (rows - 1) * (sourceStride + 1) + 1 + stride) return null
  const out = Buffer.allocUnsafe(stride * rows)
  let previous = null
  let inputOffset = 0
  let outputOffset = 0
  for (let y = 0; y < rows; y += 1) {
    const filter = filtered[inputOffset]
    inputOffset += 1
    const row = out.subarray(outputOffset, outputOffset + stride)
    if (filter === 0) {
      filtered.copy(out, outputOffset, inputOffset, inputOffset + stride)
    } else if (filter === 2) {
      if (previous) {
        for (let x = 0; x < stride; x += 1) row[x] = (filtered[inputOffset + x] + previous[x]) & 0xff
      } else {
        filtered.copy(out, outputOffset, inputOffset, inputOffset + stride)
      }
    } else if (filter === 1) {
      const head = Math.min(channels, stride)
      for (let x = 0; x < head; x += 1) row[x] = filtered[inputOffset + x]
      for (let x = head; x < stride; x += 1) row[x] = (filtered[inputOffset + x] + row[x - channels]) & 0xff
    } else if (filter === 3) {
      const head = Math.min(channels, stride)
      for (let x = 0; x < head; x += 1) row[x] = filtered[inputOffset + x]
      for (let x = head; x < stride; x += 1) {
        const up = previous ? previous[x] : 0
        row[x] = (filtered[inputOffset + x] + ((row[x - channels] + up) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      const head = Math.min(channels, stride)
      for (let x = 0; x < head; x += 1) row[x] = (filtered[inputOffset + x] + (previous ? previous[x] : 0)) & 0xff
      for (let x = head; x < stride; x += 1) {
        const left = row[x - channels]
        const up = previous ? previous[x] : 0
        const upLeft = previous ? previous[x - channels] : 0
        row[x] = (filtered[inputOffset + x] + paethPredictor(left, up, upLeft)) & 0xff
      }
    } else {
      return null
    }
    previous = row
    inputOffset += sourceStride
    outputOffset += stride
  }
  return { pixels: out, width: columns, height: rows }
}

// Cheap IHDR-only parse: the device-pixel size of a frame before paying for a
// decode (needed to convert the CSS-px clip into frame pixels).
export function pngFrameSize(buffer) {
  if (!buffer || buffer.length < 24) return null
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!width || !height) return null
  return { width, height }
}

// Cheap SOF-only parse of a JPEG frame: same job as pngFrameSize (turn the CSS
// px clip into source pixels) without decoding anything. Segments are walked
// marker to marker, so the cost is a few hundred bytes of header, not the
// entropy-coded image. Returns null for anything that is not a well-formed
// JPEG header (the caller then keeps the capture path).
export function jpegFrameSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null
    const marker = buffer[offset + 1]
    if (marker === 0xff) {
      offset += 1 // fill byte before a marker
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > buffer.length) return null
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (length < 7) return null
      const height = buffer.readUInt16BE(offset + 5)
      const width = buffer.readUInt16BE(offset + 7)
      if (!width || !height) return null
      return { width, height }
    }
    offset += 2 + length
  }
  return null
}

export function decodePngFrame(buffer, { maxColumns = 0, maxRows = 0 } = {}) {
  if (!buffer || buffer.length < PNG_SIGNATURE.length) return null
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null
  let offset = PNG_SIGNATURE.length
  let header = null
  const dataChunks = []
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (offset + 12 + length > buffer.length) return null
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      if (length < 13) return null
      const width = data.readUInt32BE(0)
      const height = data.readUInt32BE(4)
      const bitDepth = data[8]
      const colorType = data[9]
      const interlace = data[12]
      const channels = PNG_CHANNELS.get(colorType)
      if (!channels || bitDepth !== 8 || interlace !== 0 || width <= 0 || height <= 0) return null
      header = { width, height, channels }
    } else if (type === 'IDAT') {
      dataChunks.push(data)
    }
    offset += 12 + length
    if (type === 'IEND') break
  }
  if (!header || dataChunks.length === 0) return null
  let filtered
  try {
    filtered = zlib.inflateSync(Buffer.concat(dataChunks))
  } catch {
    return null
  }
  const decoded = unfilterPngRows(
    filtered,
    header.width,
    header.height,
    header.channels,
    maxColumns || header.width,
    maxRows || header.height,
  )
  if (!decoded) return null
  return {
    width: header.width,
    height: header.height,
    decodedWidth: decoded.width,
    decodedHeight: decoded.height,
    channels: header.channels,
    pixels: decoded.pixels,
  }
}

// Re-encode a cropped RGB/RGBA buffer as a PNG. Filter 0 (none) plus zlib level
// 6 keeps the encode in the low single-digit milliseconds even for a large
// region; the output is 1.3-2x the size of Chrome's own encoder, which does not
// matter for the image that is handed to the model.
export function encodePngFrame(width, height, channels, pixels) {
  const colorType = channels === 3 ? 2 : channels === 4 ? 6 : channels === 1 ? 0 : 4
  const stride = width * channels
  const filtered = Buffer.allocUnsafe((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    filtered[y * (stride + 1)] = 0
    pixels.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = colorType
  const compressed = zlib.deflateSync(filtered)
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))])
}
