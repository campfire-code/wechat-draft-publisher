// 微信公众号官方接口：获取 access_token、上传正文图片、上传封面（永久素材）、新增草稿。
// 接口地址与参数核对自微信开发者文档（developers.weixin.qq.com/doc/service/api/...），2026-10-23：
//   GET  https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=APPID&secret=APPSECRET
//   POST https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=TOKEN        form-data 字段 media，jpg/png，1MB 以下，返回 url
//   POST https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=TOKEN&type=image  form-data 字段 media，10MB 以下，返回 media_id、url
//   POST https://api.weixin.qq.com/cgi-bin/draft/add?access_token=TOKEN             { articles: [{ title, author, digest, content, thumb_media_id, ... }] }，返回 media_id
// 请求的构造与响应的解析都是纯函数；真正发请求的 http 函数从外面传入，测试里用录制的响应代替。
import { LIMITS, collectImageSrcs, cut, extOf, isWechatImage, replaceImageSrcs } from './core';

const API = 'https://api.weixin.qq.com/cgi-bin';
export const tokenUrl = (appId: string, secret: string) => `${API}/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;
export const uploadImgUrl = (token: string) => `${API}/media/uploadimg?access_token=${encodeURIComponent(token)}`;
export const addMaterialUrl = (token: string, type: 'image' | 'thumb') => `${API}/material/add_material?access_token=${encodeURIComponent(token)}&type=${type}`;
export const draftAddUrl = (token: string) => `${API}/draft/add?access_token=${encodeURIComponent(token)}`;

/** 正文图片上限（uploadimg）与封面图上限（add_material type=image） */
export const CONTENT_IMAGE_MAX = 1024 * 1024;
export const COVER_IMAGE_MAX = 10 * 1024 * 1024;

/**
 * 错误码 → 中文提示。只收录在官方文档里核对过含义的错误码：
 * 获取 access_token 接口页、全局返回码说明页、草稿新增 / 图片上传 / 永久素材接口页。
 */
const ERRORS: Record<number, string> = {
  [-1]: '微信服务器繁忙，请稍后再试',
  40001: 'AppSecret 不对，或 access_token 已失效。请核对 AppSecret，并确认 AppID 与 AppSecret 属于同一个公众号',
  40002: '凭证类型不合法',
  40005: '上传的文件格式不对，正文图片只支持 JPG / PNG',
  40007: '素材 ID 无效（封面图可能已被删除），请重新上传封面',
  40009: '图片太大，正文图片需小于 1MB',
  40013: 'AppID 不对，请检查是否填错（注意大小写和多余空格）',
  40014: 'access_token 不合法或已过期，请重试',
  40125: 'AppSecret 不合法，请检查是否复制完整；忘记了只能在微信开发者平台重置',
  40164: '本机公网 IP 不在公众号的 IP 白名单里',
  40243: 'AppSecret 已被冻结，请到微信开发者平台「我的业务 → 该公众号 → 开发密钥」解冻',
  41001: '缺少 access_token 参数',
  41004: '缺少 AppSecret',
  42001: 'access_token 已过期，请重试',
  44002: '提交的内容为空',
  45002: '正文内容超过长度限制，请精简后再试',
  45003: '标题超过长度限制',
  45004: '摘要超过长度限制',
  45009: '今天的接口调用次数已用完，请明天再试',
  47001: '提交的数据格式有误',
  48001: '这个公众号没有调用该接口的权限（未认证的订阅号可能无法使用草稿接口），请在公众号后台的接口权限里确认',
  50002: '公众号受限，可能已被冻结或注销',
  50004: '该公众号被禁止使用 access_token 接口',
  50007: '公众号已冻结',
  53404: '账号已被限制带货能力',
  53405: '插入的商品信息有误',
  53406: '尚未开通带货能力',
};

export class WxError extends Error {
  constructor(public code: number, public raw: string, message: string) {
    super(message);
  }
}

/** 白名单报错里通常带着微信看到的本机 IP，取出来方便用户直接复制 */
export function ipFromErrmsg(errmsg: string): string | null {
  return errmsg.match(/invalid ip\s+([0-9a-fA-F.:]+)/i)?.[1]?.replace(/,$/, '') ?? null;
}

export function wxErrorText(code: number, errmsg = ''): string {
  const base = ERRORS[code];
  if (code === 40164) {
    const ip = ipFromErrmsg(errmsg);
    return `${base}${ip ? `（微信看到的 IP 是 ${ip}）` : ''}。请打开「微信开发者平台（浏览器搜索即可找到）→ 扫码登录 → 我的业务 → 选择这个公众号」，在「API IP 白名单」里加入这个 IP，保存后几分钟再试`;
  }
  const short = errmsg.replace(/\s*rid:.*$/, '').replace(/,?\s*more details at \S+/, '').trim();
  return base ? `${base}（错误码 ${code}）` : `微信接口返回错误 ${code}${short ? `：${short}` : ''}`;
}

/** 解析微信接口的 JSON：errcode 非 0 时抛出带中文说明的错误 */
export function parseWx<T>(status: number, text: string): T {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WxError(status, text, `微信接口返回了无法识别的内容（HTTP ${status}）`);
  }
  const code = typeof data.errcode === 'number' ? data.errcode : 0;
  if (code !== 0) throw new WxError(code, String(data.errmsg ?? ''), wxErrorText(code, String(data.errmsg ?? '')));
  if (status >= 400) throw new WxError(status, text, `微信接口请求失败（HTTP ${status}）`);
  return data as T;
}

/** 手工拼 multipart/form-data：字段名 media，带文件名和类型，结果可预测，便于测试 */
export function buildMultipart(bytes: Uint8Array, filename: string, mime: string, boundary = `----campfire${Date.now().toString(16)}`): { body: Uint8Array; contentType: string } {
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename.replace(/"/g, '')}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface DraftArticle {
  title: string;
  author: string;
  digest: string;
  /** 已替换成微信图片地址的 HTML 正文 */
  content: string;
  thumbMediaId: string;
  sourceUrl?: string;
  openComment?: boolean;
}

/** 草稿新增接口的请求体；超长字段按接口上限截断 */
export function draftBody(a: DraftArticle): string {
  const art: Record<string, unknown> = {
    article_type: 'news',
    title: cut(a.title.trim(), LIMITS.title),
    content: a.content,
    thumb_media_id: a.thumbMediaId,
    need_open_comment: a.openComment ? 1 : 0,
    only_fans_can_comment: 0,
  };
  if (a.author.trim()) art.author = cut(a.author.trim(), LIMITS.author);
  if (a.digest.trim()) art.digest = cut(a.digest.trim(), LIMITS.digest);
  if (a.sourceUrl?.trim()) art.content_source_url = a.sourceUrl.trim();
  return JSON.stringify({ articles: [art] });
}

// ---------- 发请求（http 从外面传入） ----------

export interface HttpResponse { status: number; text(): Promise<string> }
export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string }) => Promise<HttpResponse>;

const call = async <T>(http: Http, url: string, init?: Parameters<Http>[1]) => {
  const res = await http(url, init);
  return parseWx<T>(res.status, await res.text());
};

/** access_token 缓存：有效期 7200 秒，提前 10 分钟换新；按 AppID 区分 */
const tokenCache = new Map<string, { token: string; expireAt: number }>();
export const clearTokenCache = () => tokenCache.clear();

export async function getAccessToken(http: Http, appId: string, secret: string, now = Date.now()): Promise<string> {
  if (!appId.trim() || !secret.trim()) throw new Error('还没有填写公众号 AppID 和 AppSecret');
  const hit = tokenCache.get(appId);
  if (hit && hit.expireAt - 600_000 > now) return hit.token;
  const r = await call<{ access_token: string; expires_in: number }>(http, tokenUrl(appId.trim(), secret.trim()));
  tokenCache.set(appId, { token: r.access_token, expireAt: now + r.expires_in * 1000 });
  return r.access_token;
}

export async function uploadContentImage(http: Http, token: string, bytes: Uint8Array, mime: string, name: string): Promise<string> {
  const { body, contentType } = buildMultipart(bytes, name, mime);
  const r = await call<{ url: string }>(http, uploadImgUrl(token), { method: 'POST', headers: { 'Content-Type': contentType }, body });
  return r.url.replace(/^http:\/\//i, 'https://');
}

export async function uploadCover(http: Http, token: string, bytes: Uint8Array, mime: string, name: string): Promise<string> {
  const { body, contentType } = buildMultipart(bytes, name, mime);
  const r = await call<{ media_id: string }>(http, addMaterialUrl(token, 'image'), { method: 'POST', headers: { 'Content-Type': contentType }, body });
  return r.media_id;
}

export async function addDraft(http: Http, token: string, a: DraftArticle): Promise<string> {
  const r = await call<{ media_id: string }>(http, draftAddUrl(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: draftBody(a) });
  return r.media_id;
}

export interface Img { bytes: Uint8Array; mime: string }

export interface PublishDeps {
  http: Http;
  /** 读取正文里的图片（网络地址、本机路径、data: 地址） */
  loadImage(src: string): Promise<Img>;
  /** 把图片转成接口接受的格式和大小（正文：JPG/PNG 且小于 1MB） */
  fitImage(img: Img, maxBytes: number, allowGif: boolean): Promise<Img>;
  /** 没有封面也没有正文图片时，按标题生成一张封面 */
  makeCover(title: string): Promise<Img>;
  onStep?(text: string): void;
}

export interface PublishInput {
  appId: string;
  appSecret: string;
  title: string;
  author: string;
  digest: string;
  /** 排版后的 HTML（wenyan 输出） */
  html: string;
  /** 用户选的封面；没有时用正文第一张图，再没有就自动生成 */
  cover?: Img | null;
}

export interface PublishResult { mediaId: string; images: number; coverFrom: 'chosen' | 'content' | 'generated' }

/** 存草稿的完整流程：取 token → 上传正文图片并替换地址 → 上传封面 → 新增草稿 */
export async function saveDraft(deps: PublishDeps, input: PublishInput): Promise<PublishResult> {
  const step = deps.onStep ?? (() => {});
  step('正在连接公众号…');
  const token = await getAccessToken(deps.http, input.appId, input.appSecret);

  const srcs = collectImageSrcs(input.html).filter((s) => !isWechatImage(s));
  const map = new Map<string, string>();
  let firstImage: Img | null = null;
  for (let i = 0; i < srcs.length; i++) {
    step(`正在上传正文图片 ${i + 1}/${srcs.length}…`);
    let img: Img;
    try {
      img = await deps.loadImage(srcs[i]);
    } catch (e) {
      throw new Error(`第 ${i + 1} 张图片读取失败（${srcs[i].slice(0, 80)}）：${e instanceof Error ? e.message : String(e)}`);
    }
    const fit = await deps.fitImage(img, CONTENT_IMAGE_MAX, false);
    firstImage ??= img;
    map.set(srcs[i], await uploadContentImage(deps.http, token, fit.bytes, fit.mime, `image${i + 1}.${extOf(fit.mime)}`));
  }
  const content = replaceImageSrcs(input.html, map);

  step('正在上传封面…');
  let coverFrom: PublishResult['coverFrom'] = 'chosen';
  let cover = input.cover ?? null;
  if (!cover && firstImage) { cover = firstImage; coverFrom = 'content'; }
  if (!cover) { cover = await deps.makeCover(input.title); coverFrom = 'generated'; }
  const fitCover = await deps.fitImage(cover, COVER_IMAGE_MAX, true);
  const thumbMediaId = await uploadCover(deps.http, token, fitCover.bytes, fitCover.mime, `cover.${extOf(fitCover.mime)}`);

  step('正在存入草稿箱…');
  const mediaId = await addDraft(deps.http, token, { title: input.title, author: input.author, digest: input.digest, content, thumbMediaId });
  return { mediaId, images: srcs.length, coverFrom };
}
