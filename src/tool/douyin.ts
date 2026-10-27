// 解析用户自己发布的抖音视频分享链接，取到无水印视频的下载地址。
// 做法（沿用参考实现，按页面结构编写，未联网验证）：短链会跳转到分享页，分享页的 HTML 里嵌了 _ROUTER_DATA（JSON），
// 里面的 item_list[0] 含视频信息，video.play_addr.url_list 里是播放地址（把 playwm 换成 play 即无水印）。
// 抖音可能随时改页面或加风控，解析失败时界面会提示改用本机视频文件。
import type { Http } from './wechat';

export const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** 从分享文案里取出链接（分享文案通常是「复制此链接，打开抖音…https://v.douyin.com/xxxx/」） */
export function extractUrl(text: string): string {
  const m = text.match(/https?:\/\/[^\s,，。]+/);
  if (!m) throw new Error('没有在文字里找到链接，请粘贴抖音的分享链接');
  return m[0];
}

/** 只接受抖音自己的域名，避免把这里当成任意网址的下载器 */
export function isDouyinUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return ['douyin.com', 'iesdouyin.com'].some((d) => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

export interface Aweme { aweme_id?: string; desc?: string; video?: Record<string, { url_list?: string[] }> }

export function parseRouterData(html: string): Aweme {
  const m = html.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
  if (!m) throw new Error('页面里没有找到视频信息（链接可能已失效，或被抖音拦截了）');
  let data: { loaderData?: Record<string, { videoInfoRes?: { item_list?: Aweme[] } }> };
  try { data = JSON.parse(m[1]); } catch { throw new Error('视频信息的格式无法识别'); }
  const ld = data.loaderData ?? {};
  const item = (ld['video_(id)/page'] ?? ld['note_(id)/page'])?.videoInfoRes?.item_list?.[0];
  if (!item) throw new Error('没有找到视频（图集 / 已删除 / 仅自己可见的作品无法解析）');
  return item;
}

export function pickPlayUrl(a: Aweme): string {
  const v = a.video ?? {};
  for (const k of ['play_addr', 'play_addr_h264', 'play_addr_265']) {
    const u = v[k]?.url_list?.[0];
    if (u) return u.replace('playwm', 'play').replace('&watermark=1', '');
  }
  throw new Error('没有找到视频的播放地址');
}

export interface DouyinVideo { id: string; desc: string; bytes: Uint8Array }

/** 取分享页 → 解析 → 下载视频。http 从外面传入（需要支持 bytes()） */
export async function fetchDouyinVideo(http: Http, shareText: string, onStep?: (t: string) => void): Promise<DouyinVideo> {
  const url = extractUrl(shareText);
  if (!isDouyinUrl(url)) throw new Error('这不是抖音的链接（只支持 douyin.com 的分享链接）');
  onStep?.('正在打开分享页…');
  const page = await http(url, { method: 'GET', headers: { 'User-Agent': MOBILE_UA }, timeoutMs: 30_000 });
  if (page.status >= 400) throw new Error(`打开分享页失败（HTTP ${page.status}）`);
  const aweme = parseRouterData(await page.text());
  const playUrl = pickPlayUrl(aweme);
  onStep?.('正在下载视频…');
  const dl = await http(playUrl, { method: 'GET', headers: { 'User-Agent': MOBILE_UA, Referer: 'https://www.douyin.com/' }, timeoutMs: 300_000 });
  if (dl.status >= 400 || !dl.bytes) throw new Error(`下载视频失败（HTTP ${dl.status}）`);
  return { id: String(aweme.aweme_id ?? 'video'), desc: aweme.desc ?? '', bytes: await dl.bytes() };
}
