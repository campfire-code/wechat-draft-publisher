// 大模型之外的两类接口（都兼容 OpenAI 的接口格式，地址、密钥、模型名由用户自己填）：
//   图像：POST {地址}/images/generations   { model, prompt, n, size }，返回 data[0].b64_json 或 data[0].url
//   语音识别：POST {地址}/audio/transcriptions   multipart：file、model、language、response_format，返回 { text }
// 另有选题、配图提示词、配图插入位置等纯函数。请求构造与响应解析都不联网，测试里用假函数 / 假网络。
import { sniffImage } from './core';
import type { ModelCfg } from './config';
import type { Http, Img } from './wechat';

const base = (c: ModelCfg) => c.baseUrl.trim().replace(/\/+$/, '');

function apiError(what: string, status: number, body: string): Error {
  const hint = status === 401 ? '密钥不对或已过期' : status === 404 ? '接口地址或模型名不对' : status === 413 ? '文件太大' : status === 429 ? '调用太频繁或额度用完' : '接口返回错误';
  let detail = body.slice(0, 160);
  try {
    const m = (JSON.parse(body) as { error?: { message?: string } | string }).error;
    detail = (typeof m === 'string' ? m : m?.message ?? detail).slice(0, 160);
  } catch { /* 不是 JSON，原样截取 */ }
  return new Error(`${what}调用失败（${status}，${hint}）${detail ? '：' + detail : ''}`);
}

// ---------- 图像 ----------

export function imageRequest(cfg: ModelCfg, prompt: string, size: string) {
  return {
    url: `${base(cfg)}/images/generations`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey.trim()}` },
    // 不传 response_format：部分模型不接受这个参数，两种返回（b64_json / url）都能处理
    body: JSON.stringify({ model: cfg.model.trim(), prompt, n: 1, size: size.trim() }),
  };
}

export function parseImageResponse(status: number, text: string): { b64: string } | { url: string } {
  if (status >= 400) throw apiError('图像模型', status, text);
  let d: { data?: { b64_json?: string; url?: string }[] };
  try { d = JSON.parse(text); } catch { throw new Error('图像模型返回了无法识别的内容'); }
  const it = d.data?.[0];
  if (it?.b64_json) return { b64: it.b64_json };
  if (it?.url) return { url: it.url };
  throw new Error('图像模型没有返回图片');
}

const fromB64 = (b64: string) => Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));

export type ImageGen = (prompt: string) => Promise<Img>;

/** 生成一张图。http 从外面传入，测试里用假网络 */
export async function generateImage(http: Http, cfg: ModelCfg, size: string, prompt: string): Promise<Img> {
  const req = imageRequest(cfg, prompt, size);
  const res = await http(req.url, { method: 'POST', headers: req.headers, body: req.body, timeoutMs: 180_000 });
  const out = parseImageResponse(res.status, await res.text());
  let bytes: Uint8Array;
  if ('b64' in out) bytes = fromB64(out.b64);
  else {
    const dl = await http(out.url, { method: 'GET', timeoutMs: 120_000 });
    if (dl.status >= 400 || !dl.bytes) throw new Error(`下载生成的图片失败（HTTP ${dl.status}）`);
    bytes = await dl.bytes();
  }
  const mime = sniffImage(bytes);
  if (!mime) throw new Error('图像模型返回的不是可识别的图片');
  return { bytes, mime };
}

// ---------- 语音识别 ----------

export function buildForm(fields: Record<string, string>, file: { field: string; filename: string; mime: string; bytes: Uint8Array }, boundary = `----campfire${Date.now().toString(16)}`) {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename.replace(/"/g, '')}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.bytes, enc.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 常见的上传上限是 25MB（OpenAI 的说明；其他服务商以各自文档为准） */
export const ASR_MAX_BYTES = 25 * 1024 * 1024;

export function transcribeRequest(cfg: ModelCfg, audio: Uint8Array, filename: string, mime: string, language = '', boundary?: string) {
  const fields: Record<string, string> = { model: cfg.model.trim(), response_format: 'json' };
  if (language.trim()) fields.language = language.trim();
  const { body, contentType } = buildForm(fields, { field: 'file', filename, mime, bytes: audio }, boundary);
  return { url: `${base(cfg)}/audio/transcriptions`, headers: { 'Content-Type': contentType, Authorization: `Bearer ${cfg.apiKey.trim()}` }, body };
}

export function parseTranscription(status: number, text: string): string {
  if (status >= 400) throw apiError('语音识别', status, text);
  let t: string | undefined;
  try { t = (JSON.parse(text) as { text?: string }).text; } catch { t = undefined; }
  if (typeof t !== 'string') throw new Error('语音识别返回了无法识别的内容');
  if (!t.trim()) throw new Error('没有识别出文字，请确认视频里有清晰的人声');
  return t.trim();
}

export type Transcribe = (audio: Uint8Array, filename: string, mime: string) => Promise<string>;

export async function transcribeAudio(http: Http, cfg: ModelCfg, language: string, audio: Uint8Array, filename: string, mime: string): Promise<string> {
  if (audio.length > ASR_MAX_BYTES) throw new Error(`音频有 ${(audio.length / 1048576).toFixed(1)}MB，超过常见的 25MB 上限，请先截取较短的一段再试`);
  const req = transcribeRequest(cfg, audio, filename, mime, language);
  const res = await http(req.url, { method: 'POST', headers: req.headers, body: req.body, timeoutMs: 300_000 });
  return parseTranscription(res.status, await res.text());
}

// ---------- 选题 ----------

export function buildTopicMessages(direction: string, n = 3): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: `你是微信公众号的选题编辑。根据用户给的方向，给出 ${n} 个备选标题。要求：每个不超过 30 个字，具体、有信息量或有场景感，不做标题党，不用「震惊」「必看」之类的词。只输出 JSON：{"titles":["标题1","标题2"]}，不要其他内容。` },
    { role: 'user', content: `方向：${direction.trim() || '（用户没写，请选一个适合中小商家和个体经营者的实用话题）'}` },
  ];
}

export function parseTopics(raw: string): string[] {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  let list: unknown[] = [];
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      list = Array.isArray(v) ? v : Array.isArray(v?.titles) ? v.titles : Array.isArray(v?.candidates) ? v.candidates : [];
    } catch { /* 退回按行解析 */ }
  }
  if (!list.length) list = text.split('\n').map((l) => l.replace(/^\s*(?:[-*]|\d+[.、)])\s*/, '').trim()).filter(Boolean);
  return list.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/^[《「“"']+|[》」”"']+$/g, '').trim()).filter(Boolean).slice(0, 5);
}

// ---------- 配图 ----------

const NO_TEXT = '画面里不要出现任何文字、字母、水印和标志，不要出现真实人物的脸，干净、构图简洁';

export function coverPrompt(title: string, digest: string): string {
  return `为一篇微信公众号文章画封面插画。文章标题：「${title.trim()}」。${digest.trim() ? `内容概要：${digest.trim()}。` : ''}风格：现代、简洁、有设计感的扁平插画，色彩柔和，横版构图，主体居中。${NO_TEXT}。`;
}

export function illustrationPrompt(title: string, heading: string): string {
  return `为微信公众号文章《${title.trim()}》里的一节配一张插画，这一节的小标题是「${heading.trim()}」。风格：现代、简洁的扁平插画，色彩柔和，与文章基调一致。${NO_TEXT}。`;
}

export interface HeadingPos { line: number; text: string }

/** 取出 Markdown 里的二级标题（跳过代码块），line 是行号（从 0 开始） */
export function headings(markdown: string): HeadingPos[] {
  const out: HeadingPos[] = [];
  let fence = false;
  markdown.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && l.match(/^##\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ line: i, text: m[1].replace(/[*_`]/g, '').trim() });
  });
  return out;
}

/** 选哪几个小节配图：均匀挑 count 个，第一个小节之前不配 */
export function pickHeadings(markdown: string, count: number): HeadingPos[] {
  const hs = headings(markdown);
  if (count <= 0 || !hs.length) return [];
  if (hs.length <= count) return hs;
  const out: HeadingPos[] = [];
  for (let i = 0; i < count; i++) out.push(hs[Math.floor((i * hs.length) / count)]);
  return out;
}

/** 在指定标题行的后面插入图片（标题行号来自 headings；从后往前插，行号不乱） */
export function insertAfterLines(markdown: string, items: { line: number; src: string }[]): string {
  const lines = markdown.split('\n');
  for (const it of [...items].sort((a, b) => b.line - a.line)) {
    lines.splice(it.line + 1, 0, '', `![](${encodeURI(it.src.replace(/\\/g, '/'))})`);
  }
  return lines.join('\n');
}

/** 把图片裁成指定宽高比时的居中裁剪区域 */
export function coverCropRect(w: number, h: number, ratio: number): { sx: number; sy: number; sw: number; sh: number } {
  if (w / h > ratio) { const sw = Math.round(h * ratio); return { sx: Math.round((w - sw) / 2), sy: 0, sw, sh: h }; }
  const sh = Math.round(w / ratio);
  return { sx: 0, sy: Math.round((h - sh) / 2), sw: w, sh };
}

// ---------- 篇尾 ----------

/** 在排版后的正文末尾加二维码（图片地址由存草稿流程统一上传）和一句话 */
export function appendFooter(html: string, qrSrc: string, text = ''): string {
  if (!qrSrc.trim()) return html;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const line = text.trim() ? `<p style="text-align:center;font-size:15px;color:#555;margin:0 0 12px;">${esc(text.trim())}</p>` : '';
  const footer = `<section style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e5e5;text-align:center;">${line}<p style="text-align:center;margin:0;"><img src="${esc(qrSrc.trim())}" style="width:50%;max-width:260px;" /></p></section>`;
  const end = html.search(/<\/section>\s*$/);
  return end >= 0 ? html.slice(0, end) + footer + html.slice(end) : html + footer;
}
