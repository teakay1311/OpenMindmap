import { Asset, embeddedBitmap, ImageAttachment, LIMITS, uuid } from '../core/types'

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  const bytes = new Uint8Array(buffer)
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i]
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= bytes[i] + i
    h2 = Math.imul(h2, 0x85ebca6b)
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}-${bytes.length}`
}

/** Both image entry points create one complete attachment command. */
export async function readImage(file: File): Promise<{ asset: Asset; image: ImageAttachment }> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Chỉ nhận tệp ảnh PNG/JPEG/WebP/GIF')
  if (file.size > LIMITS.imageBytes) throw new Error('Ảnh quá lớn. Hãy chọn ảnh nhỏ hơn')
  const [buffer, dataUrl] = await Promise.all([
    file.arrayBuffer(),
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Không đọc được tệp ảnh'))
      reader.readAsDataURL(file)
    }),
  ])
  const [dimensions, hash] = await Promise.all([
    decodeEmbeddedBitmap(dataUrl),
    sha256Hex(buffer),
  ])
  const id = uuid()
  return {
    asset: { id, mime: file.type || 'image/png', ...dimensions, hash, data_url: dataUrl },
    image: { asset_id: id, fit: 'contain', placement: 'below', width_fraction: 0.5 },
  }
}

export async function decodeEmbeddedBitmap(dataUrl: string): Promise<{ width: number; height: number }> {
  if (!embeddedBitmap(dataUrl)) throw new Error('Dữ liệu ảnh không hợp lệ')
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('Tệp ảnh không hợp lệ hoặc không giải mã được'))
    image.src = dataUrl
  })
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > LIMITS.imagePixels) throw new Error('Kích thước ảnh vượt giới hạn cho phép')
  return dimensions
}
