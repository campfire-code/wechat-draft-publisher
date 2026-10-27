// 微信公众号官方接口：获取 access_token、上传正文图片、上传封面（永久素材）、新增草稿。
// 接口地址与参数核对自微信开发者文档（developers.weixin.qq.com/doc/service/api/...），2026-10-23：
//   GET  https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=APPID&secret=APPSECRET
//   POST https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=TOKEN        form-data 字段 media，jpg/png，1MB 以下，返回 url
//   POST https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=TOKEN&type=image  form-data 字段 media，10MB 以下，返回 media_id、url
//   POST https://api.weixin.qq.com/cgi-bin/draft/add?access_token=TOKEN             { articles: [{ title, author, digest, content, thumb_media_id, ... }] }，返回 media_id
//        article_type=newspic（图片消息）：image_info.image_list[].image_media_id（永久素材，最多 20 张，首张为封面）、cover_info.crop_percent_list（比例 1_1 / 16_9 / 2.35_1）
//   POST https://api.weixin.qq.com/cgi-bin/message/mass/preview?access_token=TOKEN  { towxname 或 touser, msgtype: 'mpnews', mpnews: { media_id } }；按微信号预览每日 100 次，仅认证号可调用
//   POST https://api.weixin.qq.com/cgi-bin/message/mass/sendall?access_token=TOKEN  { filter: { is_to_all }, msgtype: 'mpnews', mpnews: { media_id }, clientmsgid }，返回 msg_id、msg_data_id
//        mpnews 的 media_id 可直接用草稿接口返回的值，群发成功后该 media_id 失效、草稿自动删除
//   POST https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=TOKEN    { media_id }，返回 publish_id；只代表任务已提交，结果由回调事件通知（本工具收不到回调）
// 请求的构造与响应的解析都是纯函数；真正发请求的 http 函数从外面传入，测试里用录制的响应代替。
import { LIMITS, collectImageSrcs, cut, extOf, isWechatImage, replaceImageSrcs } from './core';

const API = 'https://api.weixin.qq.com/cgi-bin';
export const tokenUrl = (appId: string, secret: string) => `${API}/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;
export const uploadImgUrl = (token: string) => `${API}/media/uploadimg?access_token=${encodeURIComponent(token)}`;
export const addMaterialUrl = (token: string, type: 'image' | 'thumb') => `${API}/material/add_material?access_token=${encodeURIComponent(token)}&type=${type}`;
export const draftAddUrl = (token: string) => `${API}/draft/add?access_token=${encodeURIComponent(token)}`;
export const previewUrl = (token: string) => `${API}/message/mass/preview?access_token=${encodeURIComponent(token)}`;
export const sendAllUrl = (token: string) => `${API}/message/mass/sendall?access_token=${encodeURIComponent(token)}`;
export const submitUrl = (token: string) => `${API}/freepublish/submit?access_token=${encodeURIComponent(token)}`;

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
  40229: '封面为空，请先给文章设置封面',
  42010: '操作太快，请稍后重试',
  45011: '每分钟调用太频繁，请稍后再试',
  45028: '当前周期内的群发次数已用完',
  45062: '这个公众号已接了广告，不支持用接口群发',
  45065: '这篇文章已经提交过群发（相同的群发 ID 24 小时内不能重复）',
  45066: '相同的群发请求重试太快，请间隔 1 分钟再试',
  48021: '这份草稿是系统自动保存的，不允许群发；请到公众号后台手动保存一次后再试',
  53503: '草稿没有通过发布检查，请到公众号后台打开草稿，按提示修改',
  53504: '这份草稿需要先在公众号后台手动操作（如答题）后才能发布',
  53505: '请先在公众号后台手动保存这份草稿，再发布',
  89504: '群发进入了管理员确认流程，请在 30 分钟内用管理员微信确认',
  89505: '群发进入了管理员确认流程，请在 30 分钟内用管理员微信确认',
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

// ---------- 图片消息（贴图）草稿 ----------

export interface PicDraft {
  title: string;
  /** 图片消息的文字描述，只支持纯文本 */
  content: string;
  /** 永久素材 media_id，首张作封面，最多 20 张 */
  imageMediaIds: string[];
  /** 图片尺寸，用来算封面裁剪 */
  width?: number;
  height?: number;
  openComment?: boolean;
}

export const PIC_MAX_IMAGES = 20;
/** 参考实现里的经验值：图片消息的标题在手机上显示约 20 字，更长会被截断。官方只限制 32 字，这条未核实 */
export const PIC_TITLE_SOFT = 20;
/** 描述文字的保守上限（UTF-8 字节）。官方文档没写明图片消息 content 的长度限制，沿用参考实现的保守值 */
export const PIC_CONTENT_BYTES = 600;

/** 按 UTF-8 字节截断，不切坏字符 */
export function cutBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = enc.encode(ch).length;
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

/** 居中裁剪：给 1_1、16_9、2.35_1 三种预览比例各算一个裁剪框（比例值 0～1） */
export function cropPercentList(w = 1080, h = 1440): { ratio: string; x1: string; y1: string; x2: string; y2: string }[] {
  const src = w / h;
  const f = (n: number) => n.toFixed(6);
  return ([['1_1', 1], ['16_9', 16 / 9], ['2.35_1', 2.35]] as [string, number][]).map(([ratio, t]) => {
    if (t >= src) {
      const pad = (h - w / t) / 2 / h;
      return { ratio, x1: '0', y1: f(pad), x2: '1', y2: f(1 - pad) };
    }
    const pad = (w - h * t) / 2 / w;
    return { ratio, x1: f(pad), y1: '0', x2: f(1 - pad), y2: '1' };
  });
}

export function picDraftBody(d: PicDraft): string {
  const art = {
    article_type: 'newspic',
    title: cut(d.title.trim(), LIMITS.title),
    content: cutBytes(d.content.trim(), PIC_CONTENT_BYTES),
    need_open_comment: d.openComment ? 1 : 0,
    only_fans_can_comment: 0,
    image_info: { image_list: d.imageMediaIds.slice(0, PIC_MAX_IMAGES).map((id) => ({ image_media_id: id })) },
    cover_info: { crop_percent_list: cropPercentList(d.width, d.height) },
  };
  return JSON.stringify({ articles: [art] });
}

// ---------- 预览、发布、群发 ----------

export const previewBody = (wxName: string, mediaId: string) => JSON.stringify({ towxname: wxName.trim(), msgtype: 'mpnews', mpnews: { media_id: mediaId } });

/** 群发 ID：同一份草稿固定一个，重复点击时微信会拒绝重复群发（45065）。不超过 32 字节 */
export const clientMsgId = (mediaId: string) => `w02-${mediaId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`;

export const sendAllBody = (mediaId: string) => JSON.stringify({ filter: { is_to_all: true }, msgtype: 'mpnews', mpnews: { media_id: mediaId }, send_ignore_reprint: 0, clientmsgid: clientMsgId(mediaId) });

export const submitBody = (mediaId: string) => JSON.stringify({ media_id: mediaId });

// ---------- 发请求（http 从外面传入） ----------

export interface HttpResponse { status: number; text(): Promise<string>; /** 下载图片等二进制内容时用 */ bytes?(): Promise<Uint8Array> }
export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string; timeoutMs?: number }) => Promise<HttpResponse>;

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

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/** 新增图片消息草稿 */
export async function addPicDraft(http: Http, token: string, d: PicDraft): Promise<string> {
  const r = await call<{ media_id: string }>(http, draftAddUrl(token), { method: 'POST', headers: JSON_HEADERS, body: picDraftBody(d) });
  return r.media_id;
}

/** 预览：把草稿发到指定微信号（对方需要关注了这个公众号） */
export async function sendPreview(http: Http, token: string, wxName: string, mediaId: string): Promise<void> {
  if (!wxName.trim()) throw new Error('还没有填写预览微信号');
  await call<unknown>(http, previewUrl(token), { method: 'POST', headers: JSON_HEADERS, body: previewBody(wxName, mediaId) });
}

/** 群发给全部粉丝。成功只代表任务已提交；群发后这份草稿会被微信删除 */
export async function massSendAll(http: Http, token: string, mediaId: string): Promise<{ msgId: string; msgDataId: string }> {
  const r = await call<{ msg_id?: number | string; msg_data_id?: number | string }>(http, sendAllUrl(token), { method: 'POST', headers: JSON_HEADERS, body: sendAllBody(mediaId) });
  return { msgId: String(r.msg_id ?? ''), msgDataId: String(r.msg_data_id ?? '') };
}

/** 发布：把草稿提交发布。成功只代表任务已提交，最终结果以公众号后台为准 */
export async function freePublish(http: Http, token: string, mediaId: string): Promise<{ publishId: string }> {
  const r = await call<{ publish_id?: number | string }>(http, submitUrl(token), { method: 'POST', headers: JSON_HEADERS, body: submitBody(mediaId) });
  return { publishId: String(r.publish_id ?? '') };
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

// ---------- 图片消息：上传全部图片 → 新增草稿 ----------

export interface PicInput {
  appId: string;
  appSecret: string;
  title: string;
  content: string;
  /** 按顺序，首张作封面；已经是 PNG / JPG 的卡片图 */
  images: Img[];
  width: number;
  height: number;
  openComment?: boolean;
}

export async function savePicDraft(deps: Pick<PublishDeps, 'http' | 'fitImage' | 'onStep'>, input: PicInput): Promise<{ mediaId: string; images: number }> {
  const step = deps.onStep ?? (() => {});
  if (!input.images.length) throw new Error('没有可上传的图片');
  if (input.images.length > PIC_MAX_IMAGES) throw new Error(`图片消息最多 ${PIC_MAX_IMAGES} 张图，现在有 ${input.images.length} 张`);
  step('正在连接公众号…');
  const token = await getAccessToken(deps.http, input.appId, input.appSecret);
  const ids: string[] = [];
  for (let i = 0; i < input.images.length; i++) {
    step(`正在上传图片 ${i + 1}/${input.images.length}…`);
    const fit = await deps.fitImage(input.images[i], COVER_IMAGE_MAX, true);
    ids.push(await uploadCover(deps.http, token, fit.bytes, fit.mime, `card${i + 1}.${extOf(fit.mime)}`));
  }
  step('正在存入草稿箱…');
  const mediaId = await addPicDraft(deps.http, token, { title: input.title, content: input.content, imageMediaIds: ids, width: input.width, height: input.height, openComment: input.openComment });
  return { mediaId, images: ids.length };
}
