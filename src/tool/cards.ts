// 「从口播生成」的纯逻辑：口播校对与改写的提示词、解析大模型输出、1080×1440 卡片的文字排版（折行、字号、分页位置）。
// 画布绘制在 cardsRender.ts；这里的排版通过传入的 measure 函数量字宽，测试里用等宽假函数。
import { cut } from './core';

export interface CardItem { headline: string; body: string }
export interface CardScript { title: string; lead: string; cards: CardItem[] }

/** 卡片文字的建议长度（提示词里要求大模型遵守；用户可以改，超出时排版会缩小字号） */
export const SCRIPT = { title: 20, lead: 30, headline: 12, bodyMin: 50, bodyMax: 80, cards: 6, maxCards: 19 } as const;

type Msg = { role: 'system' | 'user'; content: string };

export function buildProofreadMessages(text: string): Msg[] {
  return [
    {
      role: 'system',
      content: [
        '你是语音转写的校对员，给一段口播转写稿修正错别字。规则：',
        '1. 只改明显错的字词，不改写句子，不增删任何信息。',
        '2. 同音错字按上下文修正。',
        '3. 英文专有名词（产品名、软件名）按通用拼写还原；拿不准的原样保留，在后面加「（？）」。',
        '4. 补上合理的标点（逗号、句号、问号），不加引号、括号和 Markdown。',
        '直接输出修正后的全文，不要任何解释。',
      ].join('\n'),
    },
    { role: 'user', content: text.slice(0, 12000) },
  ];
}

export function buildScriptMessages(transcript: string, cards: number = SCRIPT.cards): Msg[] {
  const n = Math.min(SCRIPT.maxCards, Math.max(1, Math.round(cards)));
  const system = [
    '你是资深的公众号图片消息（贴图）编辑。把一段口播原文改写成一组「图文卡片」脚本，读者一张张滑着看。',
    '【标题】',
    `- 不超过 ${SCRIPT.title} 个字（含标点），用对比、反差或反常识的角度亮出核心观点，让人想点开。`,
    '- 不要用「深度解析」「一文读懂」「全面盘点」「X 的几个真相」这类空话。',
    '【引导语】',
    `- 放在第一张卡片上，点出这组卡片在讲什么，不超过 ${SCRIPT.lead} 个字。`,
    '【内容卡片】',
    `- 共 ${n} 张。每张有小标题（不超过 ${SCRIPT.headline} 个字）和正文（${SCRIPT.bodyMin}～${SCRIPT.bodyMax} 个字）。`,
    '- 口语化，有信息量，有节奏。只依据原文，不编造数据和事例。',
    '只输出 JSON，不要代码块，不要其他文字：',
    '{"title":"…","lead":"…","cards":[{"headline":"…","body":"…"}]}',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `口播原文：\n「${transcript.trim().slice(0, 12000)}」` }];
}

/** 解析大模型输出的脚本：容忍代码块和前后说明文字；卡片数超出 max 时截掉多的 */
export function parseScript(raw: string, max: number = SCRIPT.cards): CardScript {
  const text = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('大模型没有返回可识别的脚本，请重试');
  let v: { title?: unknown; lead?: unknown; cards?: unknown };
  try { v = JSON.parse(m[0]); } catch { throw new Error('大模型返回的脚本格式不对，请重试'); }
  const s = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const cards = (Array.isArray(v.cards) ? v.cards : [])
    .map((c: { headline?: unknown; body?: unknown }) => ({ headline: s(c?.headline), body: s(c?.body) }))
    .filter((c) => c.headline || c.body)
    .slice(0, Math.max(1, Math.min(SCRIPT.maxCards, max)));
  if (!cards.length) throw new Error('大模型没有给出卡片内容，请重试');
  return { title: s(v.title), lead: s(v.lead), cards };
}

/** 保存前的检查，返回要提示的问题 */
export function checkScript(sc: CardScript, saveAs: 'pic' | 'news'): string[] {
  const out: string[] = [];
  if (!sc.title.trim()) out.push('标题不能为空');
  else if (Array.from(sc.title).length > 32) out.push(`标题超过 32 个字（现在 ${Array.from(sc.title).length} 个）`);
  if (!sc.cards.length) out.push('至少要有一张内容卡片');
  if (saveAs === 'pic' && sc.cards.length + 1 > 20) out.push(`图片消息最多 20 张图，现在有 ${sc.cards.length + 1} 张（含首张）`);
  return out;
}

/** 图片消息的文字描述：用引导语（纯文本） */
export const picContent = (sc: CardScript) => cut(sc.lead.trim() || sc.title.trim(), 200);

/** 图文消息：把卡片图依次排进正文 */
export function cardsHtml(srcs: string[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<section>${srcs.map((s) => `<p style="text-align:center;margin:0 0 10px;"><img src="${esc(s)}" style="width:100%;" /></p>`).join('')}</section>`;
}

// ---------- 卡片排版 ----------

export const CW = 1080;
export const CH = 1440;
export const MARGIN = 110;
const TEXT_W = CW - MARGIN * 2;
/** 正文区域的底边（再往下是页脚） */
const BODY_BOTTOM = CH - 200;

/** 量字宽：给定字号和是否加粗，返回量一段文字宽度的函数 */
export type Measure = (size: number, bold: boolean) => (s: string) => number;

const TOKEN = /[A-Za-z0-9][A-Za-z0-9'’.%+\-]*|\s|[\s\S]/gu;
const NO_LINE_START = new Set('，。、；：？！）」』】》〉…—,.;:?!)]}%'.split(''));

/** 折行：英文单词和数字不拆，中文逐字；逗号句号等不出现在行首；\n 强制换行 */
export function wrapText(text: string, width: number, w: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    let cur = '';
    for (const tok of para.match(TOKEN) ?? []) {
      if (!cur && /^\s$/.test(tok)) continue;
      if (cur && w(cur + tok) > width) {
        if (NO_LINE_START.has(tok)) { lines.push(cur + tok); cur = ''; continue; }
        lines.push(cur.trimEnd());
        cur = /^\s$/.test(tok) ? '' : tok;
      } else cur += tok;
    }
    lines.push(cur.trimEnd());
  }
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface Block { size: number; lh: number; y: number; lines: string[] }
export interface CardLayout {
  kind: 'lead' | 'content';
  /** 页码，例如 01 / 07 */
  page: string;
  title: Block;
  body: Block;
  /** 文字多到缩到最小字号也放不下 */
  overflow: boolean;
}

/** 在最大 / 最小字号之间找到能放进 maxLines 行的最大字号 */
export function fitBlock(text: string, measure: Measure, bold: boolean, maxSize: number, minSize: number, maxLines: number): { size: number; lines: string[]; fits: boolean } {
  for (let size = maxSize; size >= minSize; size -= 4) {
    const lines = wrapText(text, TEXT_W, measure(size, bold));
    if (lines.length <= maxLines) return { size, lines, fits: true };
  }
  return { size: minSize, lines: wrapText(text, TEXT_W, measure(minSize, bold)), fits: false };
}

const TITLE_LH = 1.2;
const BODY_SIZE = 46;
const BODY_LH = 1.6;

export function layoutCards(sc: CardScript, measure: Measure): CardLayout[] {
  const total = sc.cards.length + 1;
  const pg = (i: number) => `${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  const out: CardLayout[] = [];

  // 首张：大标题 + 引导语
  const t = fitBlock(sc.title || " ", measure, true, 160, 88, 3);
  const tlh = t.size * TITLE_LH;
  const title: Block = { size: t.size, lh: tlh, y: 320, lines: t.lines };
  const leadY = title.y + tlh * t.lines.length + 110;
  const leadLines = wrapText(sc.lead, TEXT_W, measure(BODY_SIZE, false));
  out.push({
    kind: 'lead', page: pg(0), title,
    body: { size: BODY_SIZE, lh: BODY_SIZE * BODY_LH, y: leadY, lines: leadLines },
    overflow: !t.fits || leadY + leadLines.length * BODY_SIZE * BODY_LH > BODY_BOTTOM,
  });

  // 内容卡：小标题 + 正文，正文太长时缩小字号
  sc.cards.forEach((c, i) => {
    const h = fitBlock(c.headline || ' ', measure, true, 104, 64, 2);
    const hlh = h.size * TITLE_LH;
    const head: Block = { size: h.size, lh: hlh, y: 320, lines: h.lines };
    const by = head.y + hlh * h.lines.length + 110;
    let size = BODY_SIZE;
    let lines = wrapText(c.body, TEXT_W, measure(size, false));
    while (by + lines.length * size * BODY_LH > BODY_BOTTOM && size > 30) {
      size -= 2;
      lines = wrapText(c.body, TEXT_W, measure(size, false));
    }
    out.push({ kind: 'content', page: pg(i + 1), title: head, body: { size, lh: size * BODY_LH, y: by, lines }, overflow: !h.fits || by + lines.length * size * BODY_LH > BODY_BOTTOM });
  });
  return out;
}
