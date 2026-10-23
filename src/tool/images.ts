// 本机侧的图片处理：读取正文图片、用画布转码压缩、按标题生成封面。依赖浏览器画布和 Tauri，不做单元测试（逻辑分支在 wechat.ts 里测）。
import { fs, httpFetch } from '../kit/platform';
import { decodeDataUrl, imageKind, localPath, sniffImage } from './core';
import type { Img } from './wechat';

export async function loadImage(src: string): Promise<Img> {
  const kind = imageKind(src);
  let bytes: Uint8Array;
  if (kind === 'data') bytes = decodeDataUrl(src).bytes;
  else if (kind === 'remote') {
    const res = await httpFetch(src, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } else if (kind === 'local') bytes = await fs.readFile(localPath(src));
  else throw new Error('图片要写完整路径或网址（例如 /Users/你/图片/a.png 或 https://…），相对路径找不到文件');
  const mime = sniffImage(bytes);
  if (!mime) throw new Error('不是可识别的图片文件');
  return { bytes, mime };
}

function toBitmapSource(img: Img): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.mime }));
    const el = new Image();
    el.onload = () => { URL.revokeObjectURL(url); resolve(el); };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法解码')); };
    el.src = url;
  });
}

const canvasJpeg = (c: HTMLCanvasElement, q: number) => new Promise<Uint8Array>((resolve, reject) =>
  c.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('图片转码失败'))), 'image/jpeg', q));

/** 满足格式和大小就原样返回；否则转成 JPG，逐步降低质量和尺寸直到小于上限 */
export async function fitImage(img: Img, maxBytes: number, allowGif: boolean): Promise<Img> {
  const okType = img.mime === 'image/jpeg' || img.mime === 'image/png' || (allowGif && img.mime === 'image/gif');
  if (okType && img.bytes.length <= maxBytes) return img;
  const el = await toBitmapSource(img);
  let w = el.naturalWidth;
  let h = el.naturalHeight;
  const maxSide = 1600;
  if (Math.max(w, h) > maxSide) { const s = maxSide / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  for (let round = 0; round < 6; round++) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(el, 0, 0, w, h);
    for (const q of [0.9, 0.8, 0.7, 0.6]) {
      const bytes = await canvasJpeg(c, q);
      if (bytes.length <= maxBytes) return { bytes, mime: 'image/jpeg' };
    }
    w = Math.round(w * 0.75); h = Math.round(h * 0.75);
  }
  throw new Error('图片太大，压缩后仍超过上限，请换一张小一点的图片');
}

/** 按标题生成 900×383（2.35:1）的封面图：主色底 + 白字标题 */
export async function makeCover(title: string, color = '#6D28D9'): Promise<Img> {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 383;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 900, 383);
  grad.addColorStop(0, color);
  grad.addColorStop(1, '#1A1726');
  g.fillStyle = grad;
  g.fillRect(0, 0, 900, 383);
  g.fillStyle = 'rgba(255,255,255,.12)';
  g.beginPath(); g.arc(800, 40, 160, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.font = '700 46px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  // 按宽度折行，最多 3 行
  const chars = Array.from(title.trim() || '未命名文章');
  const lines: string[] = [];
  let cur = '';
  for (const ch of chars) {
    if (g.measureText(cur + ch).width > 760) { lines.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) { lines.length = 3; lines[2] = lines[2].slice(0, -1) + '…'; }
  const lh = 64;
  lines.forEach((l, i) => g.fillText(l, 70, 383 / 2 + (i - (lines.length - 1) / 2) * lh));
  return { bytes: await canvasJpeg(c, 0.9), mime: 'image/jpeg' };
}
