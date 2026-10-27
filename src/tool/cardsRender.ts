// 卡片画布绘制：用页面里的 canvas（兼容 macOS 系统网页引擎与 Windows WebView2），不用 OffscreenCanvas。
// 模板配色是画进图片里的，所以这里写死颜色。依赖浏览器画布，不做单元测试（排版逻辑在 cards.ts 里测）。
import { CH, CW, MARGIN, layoutCards, type CardLayout, type CardScript, type Measure } from './cards';

const SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Microsoft YaHei UI","Noto Sans CJK SC","Source Han Sans SC",sans-serif';
const SERIF = '"Songti SC","STSong","SimSun","Noto Serif CJK SC","Source Han Serif SC",serif';

type G = CanvasRenderingContext2D;
export interface CardTemplate {
  id: string;
  name: string;
  font: 'sans' | 'serif';
  ink: string;
  muted: string;
  accent: string;
  swatch: [string, string];
  paint(g: G): void;
}

export const CARD_TEMPLATES: CardTemplate[] = [
  {
    id: 'paper', name: '米白纸张', font: 'serif', ink: '#1C1A16', muted: '#8A8070', accent: '#1C1A16', swatch: ['#F3EEE2', '#1C1A16'],
    paint(g) {
      g.fillStyle = '#F3EEE2';
      g.fillRect(0, 0, CW, CH);
      g.fillStyle = 'rgba(120,100,70,.05)';
      for (let i = 0; i < 1800; i++) g.fillRect((i * 7919) % CW, (i * 104729) % CH, 2, 2);
    },
  },
  {
    id: 'mint', name: '清新薄荷', font: 'sans', ink: '#123A2E', muted: '#6E8F82', accent: '#1F9D72', swatch: ['#DDF4EA', '#1F9D72'],
    paint(g) {
      const gr = g.createLinearGradient(0, 0, CW, CH);
      gr.addColorStop(0, '#E4F6EE');
      gr.addColorStop(1, '#BFE5D5');
      g.fillStyle = gr;
      g.fillRect(0, 0, CW, CH);
      g.fillStyle = 'rgba(255,255,255,.7)';
      g.beginPath(); g.roundRect(48, 48, CW - 96, CH - 96, 48); g.fill();
    },
  },
  {
    id: 'ink', name: '深色墨黑', font: 'sans', ink: '#F2EFE8', muted: '#9C968A', accent: '#E8B86A', swatch: ['#17181C', '#E8B86A'],
    paint(g) {
      g.fillStyle = '#17181C';
      g.fillRect(0, 0, CW, CH);
      g.strokeStyle = 'rgba(232,184,106,.45)';
      g.lineWidth = 2;
      g.strokeRect(54, 54, CW - 108, CH - 108);
    },
  },
];

export const cardTemplate = (id: string) => CARD_TEMPLATES.find((t) => t.id === id) ?? CARD_TEMPLATES[0];

const family = (t: CardTemplate) => (t.font === 'serif' ? SERIF : SANS);
const font = (t: CardTemplate, size: number, bold: boolean) => `${bold ? 700 : 400} ${size}px ${family(t)}`;

let mctx: G | null = null;
export function measurer(t: CardTemplate): Measure {
  mctx ??= document.createElement('canvas').getContext('2d')!;
  const g = mctx;
  return (size, bold) => {
    const f = font(t, size, bold);
    return (s) => { g.font = f; return g.measureText(s).width; };
  };
}

/** 画一张卡片；scale=1 时 canvas 为 1080×1440（导出用），缩略图用更小的 scale */
export function drawCard(canvas: HTMLCanvasElement, c: CardLayout, t: CardTemplate, signature: string, scale = 1) {
  const cw = Math.round(CW * scale);
  const ch = Math.round(CH * scale);
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  const g = canvas.getContext('2d')!;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.clearRect(0, 0, CW, CH);
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  t.paint(g);

  // 页码 + 细线
  g.font = font(t, 36, false);
  g.fillStyle = t.ink;
  g.fillText(c.page, MARGIN, 120);
  const pw = g.measureText(c.page).width;
  g.fillStyle = t.accent;
  g.fillRect(MARGIN, 160, Math.max(110, pw + 20), 3);

  // 标题
  g.font = font(t, c.title.size, true);
  g.fillStyle = t.ink;
  c.title.lines.forEach((l, i) => g.fillText(l, MARGIN, c.title.y + c.title.lh * i + c.title.lh / 2));
  // 标题最后一行下的强调线
  const last = c.title.lines[c.title.lines.length - 1] ?? '';
  const ly = c.title.y + c.title.lh * c.title.lines.length + 6;
  g.fillStyle = t.accent;
  g.beginPath(); g.roundRect(MARGIN, ly, Math.min(g.measureText(last).width, c.kind === 'lead' ? 520 : 360), 8, 4); g.fill();

  // 正文
  g.font = font(t, c.body.size, false);
  g.fillStyle = t.ink;
  c.body.lines.forEach((l, i) => g.fillText(l, MARGIN, c.body.y + c.body.lh * i + c.body.lh / 2));

  // 页脚：署名
  if (signature.trim()) {
    g.font = font(t, 34, false);
    g.fillStyle = t.muted;
    g.fillText(signature.trim().slice(0, 30), MARGIN, CH - 130);
  }
}

export function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => canvas.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('生成图片失败'))), 'image/png'));
}

/** 排版并画出整套卡片，返回 PNG */
export async function renderCardPngs(sc: CardScript, t: CardTemplate, signature: string): Promise<{ layouts: CardLayout[]; pngs: Uint8Array[] }> {
  const layouts = layoutCards(sc, measurer(t));
  const canvas = document.createElement('canvas');
  const pngs: Uint8Array[] = [];
  for (const l of layouts) {
    drawCard(canvas, l, t, signature);
    pngs.push(await canvasPng(canvas));
  }
  return { layouts, pngs };
}
