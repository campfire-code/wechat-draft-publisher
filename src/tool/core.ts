// 纯函数：写稿提示词、解析大模型输出、字段长度检查、正文图片地址处理。不依赖界面和本机能力，便于单元测试。

export interface Article {
  title: string;
  author: string;
  digest: string;
  /** Markdown 正文（不含标题） */
  markdown: string;
}

export interface WriteRequest {
  topic: string;
  outline: string;
  refs: string;
  /** 目标字数 */
  words: number;
  style: string;
}

export const STYLES: [string, string][] = [
  ['dry', '干货清单'],
  ['story', '故事叙述'],
  ['news', '资讯解读'],
  ['casual', '轻松口语'],
];
const STYLE_HINT: Record<string, string> = {
  dry: '条理清楚的干货文：小标题分段，多用要点列表，给出可以照做的方法和例子',
  story: '用一个具体的人物或场景开头，以故事推进，在故事里讲清道理，结尾回扣开头',
  news: '先用两三句话讲清发生了什么，再解读原因、影响和对读者的意义，观点有依据',
  casual: '像和朋友聊天一样口语化，句子短，适当用设问和感叹，但不油腻、不堆砌网络梗',
};

/** 公众号草稿接口的字段上限（字数按字符计） */
export const LIMITS = { title: 32, author: 16, digest: 120 } as const;

export const charCount = (s: string) => Array.from(s).length;
export const cut = (s: string, n: number) => Array.from(s).slice(0, n).join('');

export function buildMessages(req: WriteRequest): { role: 'system' | 'user'; content: string }[] {
  const style = STYLE_HINT[req.style] ?? STYLE_HINT.dry;
  const system = [
    '你是一名资深的微信公众号编辑，擅长写读者愿意读完、愿意转发的文章。',
    '写作要求：',
    `- 风格：${style}。`,
    '- 标题不超过 30 个字，具体、有信息量，不做标题党，不用「震惊」「必看」之类的词。',
    '- 摘要不超过 100 个字，说清这篇文章能给读者什么。',
    '- 正文用 Markdown：用「## 」做小标题（3～6 个），段落短，每段不超过 4 行；可以用列表、加粗和引用；不要写一级标题，不要放图片，不要写「本文」「笔者」。',
    '- 只依据用户给的主题、提纲和参考资料写，资料里没有的数据和引语不要编造；需要数据但资料没有时，用定性描述。',
    '- 结尾给一个简短的总结或行动建议，不要求关注、点赞、转发。',
    '严格按下面的格式输出，不要输出其他内容，也不要用代码块包起来：',
    '标题：<标题>',
    '摘要：<摘要>',
    '正文：',
    '<Markdown 正文>',
  ].join('\n');
  const parts = [`主题：${req.topic.trim()}`, `篇幅：约 ${req.words} 字`];
  if (req.outline.trim()) parts.push(`提纲：\n${req.outline.trim()}`);
  if (req.refs.trim()) parts.push(`参考资料（只能使用其中的事实）：\n${req.refs.trim().slice(0, 8000)}`);
  return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }];
}

/** 解析大模型输出：优先找「标题：/摘要：/正文：」，其次用第一个 # 标题；容忍代码块包裹和全角/半角冒号 */
export function parseArticle(raw: string): Omit<Article, 'author'> {
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fence = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  let title = '';
  let digest = '';
  let body = text;
  const t = text.match(/^\s*(?:\*\*)?标题(?:\*\*)?\s*[:：]\s*(.+)$/m);
  const d = text.match(/^\s*(?:\*\*)?摘要(?:\*\*)?\s*[:：]\s*(.+)$/m);
  const b = text.match(/^\s*(?:\*\*)?正文(?:\*\*)?\s*[:：]\s*\n?/m);
  if (t) title = t[1].trim();
  if (d) digest = d[1].trim();
  if (b) body = text.slice(b.index! + b[0].length);
  else if (t || d) body = text.split('\n').filter((l) => l !== t?.[0] && l !== d?.[0]).join('\n');
  body = body.trim();
  if (!title) {
    const h = body.match(/^#\s+(.+)$/m);
    if (h) {
      title = h[1].trim();
      body = body.replace(h[0], '').trim();
    }
  }
  // 正文里重复了一级标题时去掉
  if (title) body = body.replace(new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n`), '').trim();
  title = title.replace(/^[《「“"']+|[》」”"']+$/g, '').replace(/\*\*/g, '').trim();
  if (!digest) digest = autoDigest(body);
  return { title, digest, markdown: body };
}

/** 从正文取第一段纯文字作为摘要 */
export function autoDigest(markdown: string, max = 60): string {
  const para = markdown.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|>|[-*+]\s|\d+\.\s|!\[|```|\|)/.test(p)) ?? '';
  const plain = para.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  return charCount(plain) > max ? cut(plain, max - 1) + '…' : plain;
}

/** 存草稿前的检查，返回要提示用户的问题（空数组表示可以提交） */
export function checkArticle(a: Article): string[] {
  const out: string[] = [];
  if (!a.title.trim()) out.push('标题不能为空');
  else if (charCount(a.title) > LIMITS.title) out.push(`标题超过 ${LIMITS.title} 个字（现在 ${charCount(a.title)} 个）`);
  if (charCount(a.author) > LIMITS.author) out.push(`作者超过 ${LIMITS.author} 个字`);
  if (charCount(a.digest) > LIMITS.digest) out.push(`摘要超过 ${LIMITS.digest} 个字（现在 ${charCount(a.digest)} 个）`);
  if (!a.markdown.trim()) out.push('正文不能为空');
  return out;
}

// ---------- 正文图片 ----------

/** 按出现顺序取出 HTML 里所有 <img> 的 src（去重） */
export function collectImageSrcs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const src = decodeAttr(m[2] ?? m[3] ?? '');
    if (src && !out.includes(src)) out.push(src);
  }
  return out;
}

/** 把 <img> 的 src 按映射替换；映射里没有的保持不变 */
export function replaceImageSrcs(html: string, map: Map<string, string> | ((src: string) => string | undefined)): string {
  const get = typeof map === 'function' ? map : (s: string) => map.get(s);
  return html.replace(/(<img\b[^>]*?\ssrc\s*=\s*)("([^"]*)"|'([^']*)')/gi, (all, pre: string, _q, d?: string, s?: string) => {
    const next = get(decodeAttr(d ?? s ?? ''));
    return next == null ? all : `${pre}"${next.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  });
}

const decodeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** 已经在微信服务器上的图片不用再传 */
export const isWechatImage = (src: string) => /^https?:\/\/mmbiz\.(qpic|qlogo)\.cn\//i.test(src);

export type ImageKind = 'remote' | 'data' | 'local' | 'relative';
export function imageKind(src: string): ImageKind {
  if (/^https?:\/\//i.test(src)) return 'remote';
  if (/^data:image\//i.test(src)) return 'data';
  if (/^file:\/\//i.test(src) || src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('\\\\')) return 'local';
  return 'relative';
}

/** file:// 地址或 Windows / macOS 路径 → 本机路径 */
export function localPath(src: string): string {
  if (!/^file:\/\//i.test(src)) return decodeURI(src);
  const p = decodeURI(src.replace(/^file:\/\//i, ''));
  return /^\/[a-zA-Z]:\//.test(p) ? p.slice(1) : p;
}

export function decodeDataUrl(src: string): { bytes: Uint8Array; mime: string } {
  const m = src.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!m) throw new Error('图片地址格式不对');
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return { bytes, mime: m[1] };
}

/** 按文件头判断图片格式 */
export function sniffImage(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/bmp' | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}

export const extOf = (mime: string) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' } as Record<string, string>)[mime] ?? 'bin';

/** 导出用的完整 HTML 文件 */
export function htmlDocument(title: string, body: string): string {
  const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc}</title>\n</head>\n<body style="margin:0;background:#fff">\n<div style="max-width:677px;margin:0 auto;padding:20px 16px">\n<h1 style="font-size:22px;line-height:1.4;margin:0 0 20px;color:#222">${esc}</h1>\n${body}\n</div>\n</body>\n</html>\n`;
}

/** 文件名里不能出现的字符换掉 */
export const safeFileName = (s: string) => (s.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || '未命名文章').slice(0, 60);

// ---------- 偏好与草稿 ----------

export interface Prefs {
  theme: string;
  article: Article;
  req: WriteRequest;
  coverPath: string;
}
export const PREFS_KEY = 'w02.prefs';

export function readPrefs(raw: unknown, fallback: Prefs): Prefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const s = (r: Record<string, unknown>, k: string, d: string) => (typeof r[k] === 'string' ? (r[k] as string) : d);
  const a = obj(o.article);
  const q = obj(o.req);
  return {
    theme: s(o, 'theme', fallback.theme),
    coverPath: s(o, 'coverPath', ''),
    article: { title: s(a, 'title', fallback.article.title), author: s(a, 'author', fallback.article.author), digest: s(a, 'digest', fallback.article.digest), markdown: s(a, 'markdown', fallback.article.markdown) },
    req: { topic: s(q, 'topic', ''), outline: s(q, 'outline', ''), refs: s(q, 'refs', ''), style: s(q, 'style', 'dry'), words: typeof q.words === 'number' ? q.words : 1500 },
  };
}
