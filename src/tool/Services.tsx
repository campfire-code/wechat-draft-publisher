// 服务设置：公众号、配图模型、语音识别、篇尾二维码、二次确认。保存在本机，密钥不会上传到别处。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ImageIcon, KeyRound, Loader2, Mic, QrCode, ShieldCheck } from 'lucide-react';
import { fileSrc, pickFiles, settingsStore } from '../kit/platform';
import { useSettings } from '../kit/settings';
import { CFG_KEY, DEFAULT_CFG, EMPTY_CRED, WECHAT_KEY, credReady, imageReady, modelReady, readCfg, readCred, validSize, type AppCfg, type ModelCfg, type WxCred } from './config';
import { clearTokenCache, getAccessToken } from './wechat';
import { tauriHttp } from './net';

export interface Services {
  cred: WxCred;
  cfg: AppCfg;
  saveCred(c: WxCred): Promise<void>;
  patchCfg(p: Partial<AppCfg>): void;
  credOk: boolean;
  imageOk: boolean;
  asrOk: boolean;
}

/** 读取并保存设置。preview 为真时（截图预览页）不读写本机，直接用 seed */
export function useServices(preview: boolean, seed?: { cred?: WxCred; cfg?: AppCfg }): Services {
  const [cred, setCred] = useState<WxCred>(seed?.cred ?? EMPTY_CRED);
  const [cfg, setCfg] = useState<AppCfg>(seed?.cfg ?? DEFAULT_CFG);
  const loaded = useRef(false);
  useEffect(() => {
    if (preview) { loaded.current = true; return; }
    (async () => {
      try {
        const st = await settingsStore();
        setCred(readCred(await st.get(WECHAT_KEY)));
        setCfg(readCfg(await st.get(CFG_KEY)));
      } catch { /* 首次打开 */ }
      loaded.current = true;
    })();
  }, [preview]);
  useEffect(() => {
    if (!loaded.current || preview) return;
    const id = setTimeout(async () => { try { await (await settingsStore()).set(CFG_KEY, cfg); } catch { /* 忽略 */ } }, 500);
    return () => clearTimeout(id);
  }, [cfg, preview]);
  const saveCred = useCallback(async (c: WxCred) => {
    setCred(c);
    if (!preview) { try { await (await settingsStore()).set(WECHAT_KEY, c); } catch { /* 忽略 */ } }
  }, [preview]);
  const patchCfg = useCallback((p: Partial<AppCfg>) => setCfg((o) => ({ ...o, ...p })), []);
  return { cred, cfg, saveCred, patchCfg, credOk: credReady(cred), imageOk: imageReady(cfg), asrOk: modelReady(cfg.asr) };
}

/** 「沿用大模型的地址和密钥」：只复制地址和密钥，模型名要另填（配图、语音识别用的模型和写稿不同） */
function UseLlm({ onUse }: { onUse: (llm: { baseUrl: string; apiKey: string }) => void }) {
  const s = useSettings();
  const ok = Boolean(s.llm.baseUrl && s.llm.apiKey);
  return <button className="k-link" disabled={!ok} title={ok ? '' : '还没有设置大模型'} onClick={() => onUse(s.llm)}>沿用大模型的地址和密钥</button>;
}

function ModelFields({ id, value, onChange, preview, keyHint, modelHint }: { id: string; value: ModelCfg; onChange: (p: Partial<ModelCfg>) => void; preview: boolean; keyHint: string; modelHint: string }) {
  return (
    <>
      <div className="k-field"><label className="k-label" htmlFor={`${id}-url`}>接口地址</label><input id={`${id}-url`} className="k-input" autoComplete="off" value={value.baseUrl} placeholder="例如 https://api.example.com/v1" onChange={(e) => onChange({ baseUrl: e.target.value })} /></div>
      <div className="wd-row wd-two">
        <div className="k-field wd-grow"><label className="k-label" htmlFor={`${id}-key`}>密钥</label><input id={`${id}-key`} className="k-input" type="password" autoComplete="off" value={value.apiKey} placeholder={keyHint} onChange={(e) => onChange({ apiKey: e.target.value })} /></div>
        <div className="k-field wd-grow"><label className="k-label" htmlFor={`${id}-model`}>模型名</label><input id={`${id}-model`} className="k-input" autoComplete="off" value={value.model} placeholder={modelHint} onChange={(e) => onChange({ model: e.target.value })} /></div>
      </div>
      {!preview && <UseLlm onUse={(l) => onChange(l)} />}
    </>
  );
}

function Section({ icon, title, status, ok, open, onToggle, children }: { icon: React.ReactNode; title: string; status: string; ok: boolean; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className="k-panel wd-cred" aria-label={title}>
      <button className="wd-cred-hd" aria-expanded={open} onClick={onToggle}>
        {icon}<b>{title}</b><span className={`k-st ${ok ? 'ok' : 'wait'}`}>{status}</span>
        <ChevronDown size={15} className={`wd-chev${open ? ' open' : ''}`} />
      </button>
      {open && <div className="wd-cred-body">{children}</div>}
    </section>
  );
}

export function ServicesPanel({ svc, preview, onMsg }: { svc: Services; preview?: boolean; onMsg(m: { kind: 'ok' | 'err'; text: string }): void }) {
  const { cfg, patchCfg } = svc;
  const [open, setOpen] = useState<string>(svc.credOk || preview ? '' : 'wx');
  const [draft, setDraft] = useState<WxCred>(svc.cred);
  const [testing, setTesting] = useState(false);
  useEffect(() => setDraft(svc.cred), [svc.cred]);
  const tog = (k: string) => setOpen((o) => (o === k ? '' : k));
  const dirty = draft.appId !== svc.cred.appId || draft.appSecret !== svc.cred.appSecret || draft.previewWx !== svc.cred.previewWx;
  const clean = (c: WxCred): WxCred => ({ appId: c.appId.trim(), appSecret: c.appSecret.trim(), previewWx: c.previewWx.trim() });

  async function save() {
    await svc.saveCred(clean(draft));
    onMsg({ kind: 'ok', text: '公众号设置已保存在本机' });
  }
  async function test() {
    setTesting(true);
    const c = clean(draft);
    try {
      await svc.saveCred(c);
      clearTokenCache();
      await getAccessToken(tauriHttp, c.appId, c.appSecret);
      onMsg({ kind: 'ok', text: '连接成功：AppID、AppSecret 和 IP 白名单都没问题' });
      setOpen('');
    } catch (e) {
      setOpen('wx');
      onMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
    setTesting(false);
  }

  return (
    <div className="wd-svc">
      <Section icon={<KeyRound size={15} />} title="公众号" status={svc.credOk ? `已填写 ${svc.cred.appId.slice(0, 6)}…` : '未填写'} ok={svc.credOk} open={open === 'wx'} onToggle={() => tog('wx')}>
        <div className="k-field"><label className="k-label" htmlFor="wd-appid">AppID（公众号 ID）</label><input id="wd-appid" className="k-input" autoComplete="off" value={draft.appId} placeholder="照着后台复制，共 18 位" onChange={(e) => setDraft({ ...draft, appId: e.target.value })} /></div>
        <div className="k-field"><label className="k-label" htmlFor="wd-secret">AppSecret（公众号密钥）</label><input id="wd-secret" className="k-input" type="password" autoComplete="off" value={draft.appSecret} placeholder="开发密钥" onChange={(e) => setDraft({ ...draft, appSecret: e.target.value })} /></div>
        <div className="k-field"><label className="k-label" htmlFor="wd-pvwx">预览微信号（发预览用，对方需要关注了这个公众号）</label><input id="wd-pvwx" className="k-input" autoComplete="off" value={draft.previewWx} placeholder="填你自己的微信号，可不填" onChange={(e) => setDraft({ ...draft, previewWx: e.target.value })} /></div>
        <p className="k-help">
          AppID 和 AppSecret 在「微信开发者平台 → 我的业务 → 你的公众号」里查看，只保存在这台电脑上。<b>还需要把本机的公网 IP 加进同一页面的「API IP 白名单」</b>，否则会提示 IP 不在白名单（提示里会写出微信看到的 IP）。本工具不内置代理；如果你的网络出口 IP 经常变，请改用固定出口。未认证的订阅号可能没有草稿、预览、发布等接口的权限。
        </p>
        <div className="wd-row">
          <button className="k-btn primary" disabled={!dirty} onClick={save}>保存</button>
          <button className="k-btn" disabled={!draft.appId.trim() || !draft.appSecret.trim() || testing} onClick={test}>{testing ? <Loader2 size={15} className="k-spin" /> : null}{testing ? '测试中…' : '保存并测试连接'}</button>
        </div>
      </Section>

      <Section icon={<ImageIcon size={15} />} title="自动配图" status={svc.imageOk ? '已开启' : cfg.image.enabled ? '接口没填全' : '已关闭'} ok={svc.imageOk} open={open === 'img'} onToggle={() => tog('img')}>
        <label className="k-toggle"><input type="checkbox" checked={cfg.image.enabled} onChange={(e) => patchCfg({ image: { ...cfg.image, enabled: e.target.checked } })} />开启自动配图（为文章生成封面和插图）</label>
        <ModelFields id="wd-img" value={cfg.image} preview={!!preview} keyHint="图像模型的密钥" modelHint="图像模型名" onChange={(p) => patchCfg({ image: { ...cfg.image, ...p } })} />
        <div className="wd-row wd-two">
          <div className="k-field"><label className="k-label" htmlFor="wd-img-size">图片尺寸</label><input id="wd-img-size" className="k-input" value={cfg.image.size} placeholder="1024x1024" aria-invalid={!validSize(cfg.image.size)} onChange={(e) => patchCfg({ image: { ...cfg.image, size: e.target.value } })} /></div>
          <div className="k-field"><label className="k-label" htmlFor="wd-img-count">插图张数（不含封面）</label><select id="wd-img-count" className="k-input" value={cfg.image.count} onChange={(e) => patchCfg({ image: { ...cfg.image, count: Number(e.target.value) } })}>{[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} 张</option>)}</select></div>
        </div>
        <p className="k-help">用你自己的图像模型接口（兼容 OpenAI 的 /images/generations 格式），生成的图保存在「下载/AI 写稿直发公众号草稿箱/配图」里。尺寸要写成接口支持的值。图像模型一般按张收费，请留意额度。</p>
      </Section>

      <Section icon={<Mic size={15} />} title="语音识别" status={svc.asrOk ? '已填写' : '未填写'} ok={svc.asrOk} open={open === 'asr'} onToggle={() => tog('asr')}>
        <ModelFields id="wd-asr" value={cfg.asr} preview={!!preview} keyHint="语音识别接口的密钥" modelHint="例如 whisper-1" onChange={(p) => patchCfg({ asr: { ...cfg.asr, ...p } })} />
        <div className="wd-row wd-two">
          <div className="k-field"><label className="k-label" htmlFor="wd-asr-lang">语言代码</label><input id="wd-asr-lang" className="k-input" value={cfg.asr.language} placeholder="zh，留空则自动判断" onChange={(e) => patchCfg({ asr: { ...cfg.asr, language: e.target.value } })} /></div>
          <label className="k-toggle wd-pad"><input type="checkbox" checked={cfg.asr.proofread} onChange={(e) => patchCfg({ asr: { ...cfg.asr, proofread: e.target.checked } })} />识别后用大模型校对错别字</label>
        </div>
        <p className="k-help">用你自己的语音识别接口（兼容 OpenAI 的 /audio/transcriptions 格式），「从口播生成」时使用。</p>
      </Section>

      <Section icon={<QrCode size={15} />} title="篇尾二维码" status={cfg.qrPath ? '已设置' : '未设置'} ok={!!cfg.qrPath} open={open === 'qr'} onToggle={() => tog('qr')}>
        <div className="wd-cover">
          {cfg.qrPath ? <span className="wd-cover-file"><img className="wd-qr-img" src={fileSrc(cfg.qrPath)} alt="" /><span className="k-ellipsis" title={cfg.qrPath}>{cfg.qrPath.split(/[\\/]/).pop()}</span></span> : <span className="k-muted wd-cover-hint">未设置：文章末尾不加二维码</span>}
          <button className="k-link" onClick={async () => { const [p] = await pickFiles(['jpg', 'jpeg', 'png'], '图片'); if (p) patchCfg({ qrPath: p }); }}>选择图片</button>
          {cfg.qrPath && <button className="k-link" onClick={() => patchCfg({ qrPath: '' })}>不加了</button>}
        </div>
        <div className="k-field"><label className="k-label" htmlFor="wd-qr-text">二维码上方的一句话（可不填）</label><input id="wd-qr-text" className="k-input" value={cfg.qrText} placeholder="例如：扫码加入交流群" onChange={(e) => patchCfg({ qrText: e.target.value })} /></div>
        <p className="k-help">二维码图片由你自己上传，存草稿时和正文图片一起传到微信，加在文章末尾。</p>
      </Section>

      <Section icon={<ShieldCheck size={15} />} title="发布安全" status={cfg.confirm ? '二次确认已开' : '二次确认已关'} ok={cfg.confirm} open={open === 'safe'} onToggle={() => tog('safe')}>
        <label className="k-toggle"><input type="checkbox" checked={cfg.confirm} onChange={(e) => patchCfg({ confirm: e.target.checked })} />发布、群发前需要再确认一次（建议保持开启）</label>
        <p className="k-help">群发会推给全部粉丝且无法撤回，每个公众号的群发次数也有限。关闭后，点「群发」「发布」会直接执行。</p>
      </Section>
    </div>
  );
}
