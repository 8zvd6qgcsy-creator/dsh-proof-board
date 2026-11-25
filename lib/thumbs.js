// 缩略图：Office 交付物（PPT/Word/Excel）借 Host 的 officeKit 渲染第一页成 PNG，按 mtime 缓存。
// officeKit 不在（没装 office-kit 那一层）或者渲染失败时返回 null，页面退化成「文件卡片」，不影响使用。
// 失败原因留在 lastError 里，/proof-board/api/render-status 能读到，省得去翻进程日志。
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { OFFICE_EXT, readCachedThumb, writeCachedThumb } from './board.js'

const inflight = new Map()
let lastError = null
let warned = false

export const canRender = (item) => OFFICE_EXT.has(item.ext)
export const getLastError = () => lastError

/** 拿一张缩略图（PNG Buffer），拿不到就是 null。同一个文件同时只渲染一次。 */
export async function thumbFor(ctx, workspacePath, item) {
  if (!canRender(item)) return null
  const cached = readCachedThumb(workspacePath, item)
  if (cached) return cached
  const key = `${resolve(workspacePath)}::${item.rel}::${item.mtime}`
  if (inflight.has(key)) return inflight.get(key)
  const job = render(ctx, workspacePath, item)
    .catch((error) => {
      lastError = { rel: item.rel, at: new Date().toISOString(), message: String(error?.message || error), code: error?.code || null }
      if (!warned) {
        warned = true
        console.warn('[proof-board] 缩略图渲染失败，页面会退回文件卡片：', lastError.message)
      }
      return null
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

async function render(ctx, workspacePath, item) {
  const kit = ctx.get('officeKit')
  if (!kit || typeof kit.renderImages !== 'function') {
    lastError = { rel: item.rel, at: new Date().toISOString(), message: 'officeKit 不在这个部署里', code: 'no-office-kit' }
    return null
  }
  const abs = resolve(workspacePath, item.rel)
  const version = `${Date.parse(item.mtime)}:${item.bytes}`
  const request = {
    extension: extname(abs).slice(1).toLowerCase(),
    source: {
      key: item.rel,
      version,
      bytes: item.bytes,
      async read(_signal, maxBytes) {
        const data = readFileSync(abs)
        if (data.length > maxBytes) throw new Error('文件超出渲染上限')
        return { bytes: new Uint8Array(data), version }
      },
    },
    pages: [1],
    dpi: 96,
    maxImages: 1,
    maxPixels: 6_000_000,
    maxDimension: 3200,
    maxBytes: 8 * 1024 * 1024,
  }
  const result = await kit.renderImages(request)
  const image = result?.images?.[0]
  if (!image?.png?.length) {
    lastError = { rel: item.rel, at: new Date().toISOString(), message: '渲染结果里没有图片', code: 'no-image' }
    return null
  }
  const png = Buffer.from(image.png)
  lastError = null
  writeCachedThumb(workspacePath, item, png, { width: image.width, height: image.height })
  return png
}