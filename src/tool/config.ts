// 本工具自己的设置（公众号、配图模型、语音识别、篇尾二维码、二次确认）。纯函数：读取时补默认值，不依赖界面。
// 大模型（写稿、改写）用框架的「设置」；这里的配图模型和语音识别是另外两组接口，同样由用户自己填写，密钥只保存在本机。

export interface ModelCfg {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface WxCred {
  appId: string;
  appSecret: string;
  /** 预览要发给的微信号（对方需要关注了这个公众号） */
  previewWx: string;
}

export interface AppCfg {
  image: ModelCfg & {
    /** 是否自动配图 */
    enabled: boolean;
    /** 图片尺寸，写接口支持的值，例如 1024x1024 */
    size: string;
    /** 插图张数（不含封面） */
    count: number;
  };
  asr: ModelCfg & { language: string; proofread: boolean };
  /** 篇尾二维码图片的本机路径 */
  qrPath: string;
  /** 二维码上方的一句话，可不填 */
  qrText: string;
  /** 发布、群发前是否要二次确认。默认开启 */
  confirm: boolean;
}

export const WECHAT_KEY = 'w02.wechat';
export const CFG_KEY = 'w02.cfg';

export const EMPTY_CRED: WxCred = { appId: '', appSecret: '', previewWx: '' };

export const DEFAULT_CFG: AppCfg = {
  image: { baseUrl: '', apiKey: '', model: '', enabled: false, size: '1024x1024', count: 3 },
  asr: { baseUrl: '', apiKey: '', model: '', language: 'zh', proofread: true },
  qrPath: '',
  qrText: '',
  confirm: true,
};

const obj = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
const str = (r: Record<string, unknown>, k: string, d: string) => (typeof r[k] === 'string' ? (r[k] as string) : d);
const bool = (r: Record<string, unknown>, k: string, d: boolean) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : d);
const num = (r: Record<string, unknown>, k: string, d: number, lo: number, hi: number) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? Math.min(hi, Math.max(lo, Math.round(r[k] as number))) : d);

export function readCred(raw: unknown): WxCred {
  const o = obj(raw);
  return { appId: str(o, 'appId', '').trim(), appSecret: str(o, 'appSecret', '').trim(), previewWx: str(o, 'previewWx', '').trim() };
}

export function readCfg(raw: unknown): AppCfg {
  const o = obj(raw);
  const i = obj(o.image);
  const a = obj(o.asr);
  const d = DEFAULT_CFG;
  return {
    image: {
      baseUrl: str(i, 'baseUrl', ''), apiKey: str(i, 'apiKey', ''), model: str(i, 'model', ''),
      enabled: bool(i, 'enabled', d.image.enabled), size: str(i, 'size', d.image.size) || d.image.size, count: num(i, 'count', d.image.count, 0, 6),
    },
    asr: { baseUrl: str(a, 'baseUrl', ''), apiKey: str(a, 'apiKey', ''), model: str(a, 'model', ''), language: str(a, 'language', d.asr.language), proofread: bool(a, 'proofread', d.asr.proofread) },
    qrPath: str(o, 'qrPath', ''),
    qrText: str(o, 'qrText', ''),
    confirm: bool(o, 'confirm', true),
  };
}

export const modelReady = (c: ModelCfg) => Boolean(c.baseUrl.trim() && c.apiKey.trim() && c.model.trim());
export const credReady = (c: WxCred) => Boolean(c.appId && c.appSecret);
/** 自动配图可用：开关打开且接口填全 */
export const imageReady = (c: AppCfg) => c.image.enabled && modelReady(c.image);

/** 图片尺寸写成「宽x宽」才接受，避免把乱写的值发给接口 */
export const validSize = (s: string) => /^\d{3,4}x\d{3,4}$/.test(s.trim());
