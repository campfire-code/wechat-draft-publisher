// 主界面：左边写稿（AI 生成 + 手动编辑），右边公众号样式预览；可复制富文本、导出 HTML、一键存到公众号草稿箱。
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronLeft, CircleCheck, CircleDashed, Copy, FileDown, FileText, ImagePlus, Inbox, KeyRound, Loader2, Palette, Send, Sparkles, X } from 'lucide-react';
import { defaultOutputDir, ensureDir, fileSrc, fs, pickFiles, reveal, settingsStore } from '../kit/platform';
import { chat, llmReady, useSettings } from '../kit/settings';
import {
  LIMITS, PREFS_KEY, STYLES, WECHAT_KEY, buildMessages, charCount, checkArticle, htmlDocument, imageKind, localPath, parseArticle, readPrefs,
  replaceImageSrcs, safeFileName, type Article, type Prefs,
} from './core';
import { listThemes, renderWechat } from './render';
import { clearTokenCache, getAccessToken, saveDraft } from './wechat';
import { tauriHttp } from './net';
import { SAMPLE } from './sample';
import './tool.css';

const TOOL_NAME = 'AI 写稿直发公众号草稿箱';
const DEFAULTS: Prefs = { theme: 'default', coverPath: '', article: SAMPLE, req: { topic: '', outline: '', refs: '', words: 1500, style: 'dry' } };
const WORDS: [number, string][] = [[800, '约 800 字'], [1500, '约 1500 字'], [2500, '约 2500 字']];

type Msg = { kind: 'ok' | 'err'; text: string; path?: string } | null;
interface WxCred { appId: string; appSecret: string }

function Counter({ value, max }: { value: string; max: number }) {
  const n = charCount(value);
  return <span className={`wd-count k-num${n > max ? ' over' : ''}`}>{n}/{max}</span>;
}

/** 复制富文本：优先用剪贴板接口写入 HTML，不支持时退回选中后复制 */
async function copyRich(html: string, plain: string) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
    return;
  } catch { /* 退回旧办法 */ }
  const div = document.createElement('div');
  div.contentEditable = 'true';
  div.innerHTML = html;
  Object.assign(div.style, { position: 'fixed', left: '-9999px', top: '0' });
  document.body.appendChild(div);
  const range = document.createRange();
  range.selectNodeContents(div);
  const sel = getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('copy');
  sel.removeAllRanges();
  div.remove();
  if (!ok) throw new Error('系统不允许写入剪贴板');
}

/** 跟踪大模型是否已设置；预览页没有本机设置存储，不挂这个组件 */
function LlmWatch({ onChange }: { onChange: (ok: boolean) => void }) {
  const s = useSettings();
  const ok = llmReady(s.llm);
  useEffect(() => onChange(ok), [ok, onChange]);
  return null;
}

export function Main({ preview }: { preview?: boolean }) {
  const [llmOk, setLlmOk] = useState(!!preview);
  const themes = useMemo(() => listThemes(), []);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [cred, setCred] = useState<WxCred>({ appId: '', appSecret: '' });
  const [credDraft, setCredDraft] = useState<WxCred>({ appId: '', appSecret: '' });
  const [showCred, setShowCred] = useState(false);
  const [html, setHtml] = useState('');
  const [renderErr, setRenderErr] = useState('');
  const [busy, setBusy] = useState<'' | 'ai' | 'save'>('');
  const [step, setStep] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const loaded = useRef(false);
  const mdRef = useRef<HTMLTextAreaElement>(null);

  const a = prefs.article;
  const setArticle = (p: Partial<Article>) => setPrefs((o) => ({ ...o, article: { ...o.article, ...p } }));
  const setReq = (p: Partial<Prefs['req']>) => setPrefs((o) => ({ ...o, req: { ...o.req, ...p } }));

  // 读取上次的稿子和公众号设置
  useEffect(() => {
    if (preview) { loaded.current = true; return; }
    (async () => {
      try {
        const st = await settingsStore();
        setPrefs(readPrefs(await st.get(PREFS_KEY), DEFAULTS));
        const c = (await st.get<WxCred>(WECHAT_KEY)) ?? { appId: '', appSecret: '' };
        setCred(c);
        setCredDraft(c);
        if (!c.appId) setShowCred(true);
      } catch { /* 首次打开 */ }
      loaded.current = true;
    })();
  }, [preview]);
  useEffect(() => {
    if (!loaded.current || preview) return;
    const id = setTimeout(async () => { try { await (await settingsStore()).set(PREFS_KEY, prefs); } catch { /* 忽略 */ } }, 600);
    return () => clearTimeout(id);
  }, [prefs, preview]);

  // 排版预览
  const md = useDeferredValue(a.markdown);
  useEffect(() => {
    let live = true;
    renderWechat(md, prefs.theme).then((h) => { if (live) { setHtml(h); setRenderErr(''); } }, (e) => live && setRenderErr(String(e instanceof Error ? e.message : e)));
    return () => { live = false; };
  }, [md, prefs.theme]);
  // 预览里本机图片换成可显示的地址（提交草稿时用原地址上传）
  const previewHtml = useMemo(() => replaceImageSrcs(html, (s) => (imageKind(s) === 'local' ? fileSrc(localPath(s)) : undefined)), [html]);

  const credOk = !!(cred.appId && cred.appSecret);

  async function aiWrite() {
    if (!prefs.req.topic.trim()) { setMsg({ kind: 'err', text: '先填写文章主题' }); return; }
    if (a.markdown.trim() && a.markdown !== SAMPLE.markdown && !confirm('AI 生成的文章会替换当前的标题、摘要和正文，继续吗？')) return;
    setBusy('ai'); setMsg(null);
    try {
      const out = parseArticle(await chat(buildMessages(prefs.req), { temperature: 0.7 }));
      if (!out.markdown) throw new Error('大模型没有返回正文，请重试');
      setArticle({ title: out.title, digest: out.digest, markdown: out.markdown });
      setMsg({ kind: 'ok', text: `已生成「${out.title || '未命名'}」，可以直接修改后再存草稿` });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
    setBusy('');
  }

  async function insertImage() {
    const [p] = await pickFiles(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'], '图片');
    if (!p) return;
    const ta = mdRef.current;
    const pos = ta ? ta.selectionStart : a.markdown.length;
    const snippet = `\n\n![](${encodeURI(p.replace(/\\/g, '/'))})\n\n`;
    setArticle({ markdown: a.markdown.slice(0, pos) + snippet + a.markdown.slice(pos) });
  }

  async function doCopy() {
    try {
      await copyRich(html, a.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      const local = /<img[^>]+src="(?!https?:)/i.test(html);
      setMsg({ kind: 'ok', text: `已复制，到公众号编辑器里粘贴即可${local ? '。本机图片粘贴后需要在编辑器里重新上传；用「存到草稿箱」会自动上传' : ''}` });
    } catch (e) {
      setMsg({ kind: 'err', text: `复制失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function exportHtml() {
    try {
      const dir = await defaultOutputDir(TOOL_NAME);
      await ensureDir(dir);
      const path = await fs.join(dir, `${safeFileName(a.title)}.html`);
      await fs.writeTextFile(path, htmlDocument(a.title, html));
      setMsg({ kind: 'ok', text: `已导出 ${path.split(/[\\/]/).pop()}`, path });
    } catch (e) {
      setMsg({ kind: 'err', text: `导出失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function saveCred() {
    const c = { appId: credDraft.appId.trim(), appSecret: credDraft.appSecret.trim() };
    setCred(c);
    try { await (await settingsStore()).set(WECHAT_KEY, c); } catch { /* 预览页 */ }
    setMsg({ kind: 'ok', text: '公众号设置已保存在本机' });
    if (c.appId && c.appSecret) setShowCred(false);
  }

  async function publish() {
    setMsg(null);
    const problems = checkArticle(a);
    if (problems.length) { setMsg({ kind: 'err', text: problems.join('；') }); return; }
    if (!credOk) { setShowCred(true); setMsg({ kind: 'err', text: '先在「公众号设置」里填写 AppID 和 AppSecret' }); return; }
    setBusy('save');
    try {
      const { loadImage, fitImage, makeCover } = await import('./images');
      const cover = prefs.coverPath ? await loadImage(prefs.coverPath) : null;
      const r = await saveDraft(
        { http: tauriHttp, loadImage, fitImage, makeCover: (t) => makeCover(t, getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || undefined), onStep: setStep },
        { appId: cred.appId, appSecret: cred.appSecret, title: a.title, author: a.author, digest: a.digest, html, cover },
      );
      const from = { chosen: '你选的封面', content: '正文第一张图作封面', generated: '自动生成的标题封面' }[r.coverFrom];
      setMsg({ kind: 'ok', text: `已存入草稿箱（上传了 ${r.images} 张正文图片，使用${from}）。到公众号后台的草稿箱里检查后再发表` });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
    setStep('');
    setBusy('');
  }

  return (
    <div className="wd-host"><div className="wd">
      {!preview && <LlmWatch onChange={setLlmOk} />}
      <ol className="wd-flow" aria-label="三步流程">
        <li className={a.markdown.trim() ? 'done' : 'now'}><FileText size={16} /><span><b>写稿</b><small>AI 起草或自己写</small></span></li>
        <ArrowRight size={16} className="wd-flow-arrow" aria-hidden />
        <li className="done"><Palette size={16} /><span><b>排版</b><small>{themes.find((t) => t.id === prefs.theme)?.name ?? '默认'}主题</small></span></li>
        <ArrowRight size={16} className="wd-flow-arrow" aria-hidden />
        <li className={credOk && html ? 'now' : ''}><Inbox size={16} /><span><b>草稿箱</b><small>{credOk ? '随时可以存' : '先填公众号设置'}</small></span></li>
      </ol>
      <div className="wd-edit">
        <details className="k-panel wd-ai" open={!a.markdown.trim() || undefined}>
          <summary><Sparkles size={15} /><b>AI 写稿</b><span className="k-muted">填主题和提纲，让大模型写初稿</span><ChevronDown size={15} className="wd-chev" /></summary>
          <div className="wd-ai-body">
            <div className="k-field"><label className="k-label" htmlFor="wd-topic">主题</label><input id="wd-topic" className="k-input" value={prefs.req.topic} placeholder="例如：社区咖啡馆怎么做会员" onChange={(e) => setReq({ topic: e.target.value })} /></div>
            <div className="k-field"><label className="k-label" htmlFor="wd-outline">提纲（可不填）</label><textarea id="wd-outline" className="k-input k-textarea" rows={3} value={prefs.req.outline} placeholder={'每行一个要点，例如：\n为什么折扣留不住人\n用特权代替折扣'} onChange={(e) => setReq({ outline: e.target.value })} /></div>
            <div className="k-field"><label className="k-label" htmlFor="wd-refs">参考资料（可不填，AI 只用里面的事实）</label><textarea id="wd-refs" className="k-input k-textarea" rows={3} value={prefs.req.refs} placeholder="粘贴新闻、数据、采访记录等" onChange={(e) => setReq({ refs: e.target.value })} /></div>
            <div className="wd-row">
              <div className="k-seg" role="radiogroup" aria-label="风格">
                {STYLES.map(([v, l]) => <button key={v} role="radio" aria-checked={prefs.req.style === v} className={prefs.req.style === v ? 'on' : ''} onClick={() => setReq({ style: v })}>{l}</button>)}
              </div>
              <select className="k-input wd-words" aria-label="篇幅" value={prefs.req.words} onChange={(e) => setReq({ words: Number(e.target.value) })}>
                {WORDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="wd-row">
              <button className="k-btn primary" disabled={busy !== '' || !llmOk} onClick={aiWrite}>{busy === 'ai' ? <Loader2 size={15} className="k-spin" /> : <Sparkles size={15} />}{busy === 'ai' ? '正在写…' : '生成文章'}</button>
              {!llmOk && <span className="k-muted">还没有设置大模型，请到顶部「设置」里填写</span>}
            </div>
          </div>
        </details>

        <section className="k-panel wd-form" aria-label="文章">
          <div className="k-field">
            <label className="k-label wd-lab" htmlFor="wd-title">标题<Counter value={a.title} max={LIMITS.title} /></label>
            <input id="wd-title" className="k-input" value={a.title} placeholder="文章标题" onChange={(e) => setArticle({ title: e.target.value })} />
          </div>
          <div className="wd-row wd-two">
            <div className="k-field wd-author">
              <label className="k-label wd-lab" htmlFor="wd-author">作者<Counter value={a.author} max={LIMITS.author} /></label>
              <input id="wd-author" className="k-input" value={a.author} placeholder="可不填" onChange={(e) => setArticle({ author: e.target.value })} />
            </div>
            <div className="k-field wd-grow">
              <label className="k-label wd-lab" htmlFor="wd-digest">摘要<Counter value={a.digest} max={LIMITS.digest} /></label>
              <input id="wd-digest" className="k-input" value={a.digest} placeholder="不填时微信自动截取正文开头" onChange={(e) => setArticle({ digest: e.target.value })} />
            </div>
          </div>
          <div className="k-field wd-grow">
            <span className="k-label wd-lab"><label htmlFor="wd-md">正文（Markdown）</label><button className="k-link" onClick={insertImage}><ImagePlus size={14} />插入本机图片</button></span>
            <textarea id="wd-md" ref={mdRef} className="k-input k-textarea wd-md" value={a.markdown} spellCheck={false} onChange={(e) => setArticle({ markdown: e.target.value })} />
          </div>
        </section>
      </div>

      <div className="wd-side">
        <div className="wd-stage">
          <div className="wd-stage-hd"><b>公众号里的样子</b><span className="k-muted">换主题立即刷新</span></div>
          <div className="wd-themes" role="radiogroup" aria-label="排版主题">
            {themes.map((t) => <button key={t.id} role="radio" aria-checked={prefs.theme === t.id} className={`k-chip${prefs.theme === t.id ? ' on' : ''}`} onClick={() => setPrefs((o) => ({ ...o, theme: t.id }))}>{t.name}</button>)}
          </div>
          <div className="wd-phone" aria-label="公众号预览">
            <div className="wd-phone-bar"><ChevronLeft size={16} /><span>公众号文章</span><i aria-hidden>···</i></div>
            {/* 预览区模拟手机里的公众号文章，始终是白底（文章样式由排版主题决定，与软件的亮暗色无关） */}
            <article className="wd-paper">
              <h1 className="wd-art-title">{a.title || '未命名文章'}</h1>
              <p className="wd-art-meta">{a.author || '作者'}<span>公众号名称</span></p>
              {renderErr ? <p className="k-err-text">排版出错：{renderErr}</p> : <div dangerouslySetInnerHTML={{ __html: previewHtml }} />}
            </article>
          </div>
        </div>

        <ul className="wd-check" aria-label="存草稿前检查">
          {[
            [!!a.title.trim(), '标题', a.title.trim() ? `${charCount(a.title)}/${LIMITS.title} 字` : '还没填'],
            [!!a.markdown.trim(), '正文', `${charCount(a.markdown)} 字`],
            [true, '封面', prefs.coverPath ? '用你选的图' : '自动选择'],
            [credOk, '公众号设置', credOk ? '已填写' : '未填写'],
          ].map(([ok, k, v]) => <li key={String(k)} className={ok ? 'ok' : ''}>{ok ? <CircleCheck size={15} /> : <CircleDashed size={15} />}<span>{k as string}</span><b>{v as string}</b></li>)}
        </ul>

        <div className="wd-actions">
          <button className="k-btn" onClick={doCopy} disabled={!html}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制富文本'}</button>
          <button className="k-btn" onClick={exportHtml} disabled={!html}><FileDown size={15} />导出 HTML</button>
          <button className="k-btn primary" onClick={publish} disabled={busy !== '' || !html}>{busy === 'save' ? <Loader2 size={15} className="k-spin" /> : <Send size={15} />}{busy === 'save' ? (step || '正在提交…') : '存到草稿箱'}</button>
        </div>

        <div className="wd-cover">
          <span className="k-label">封面</span>
          {prefs.coverPath ? (
            <span className="wd-cover-file">
              <img src={fileSrc(prefs.coverPath)} alt="" />
              <span className="k-ellipsis" title={prefs.coverPath}>{prefs.coverPath.split(/[\\/]/).pop()}</span>
              <button className="k-icon-btn" aria-label="不用这张封面" title="不用这张封面" onClick={() => setPrefs((o) => ({ ...o, coverPath: '' }))}><X size={14} /></button>
            </span>
          ) : <span className="k-muted wd-cover-hint">未选择：用正文第一张图，没有图就按标题自动生成</span>}
          <button className="k-link" onClick={async () => { const [p] = await pickFiles(['jpg', 'jpeg', 'png', 'gif', 'bmp'], '图片'); if (p) setPrefs((o) => ({ ...o, coverPath: p })); }}>选择图片</button>
        </div>

        {msg && (
          <div className={`k-notice ${msg.kind}`} role="alert">
            <span>{msg.text}</span>
            {msg.path && <button className="k-btn" onClick={() => reveal(msg.path!)}>在文件夹中显示</button>}
            <button className="k-icon-btn" aria-label="关闭提示" onClick={() => setMsg(null)}><X size={14} /></button>
          </div>
        )}

        <section className="k-panel wd-cred" aria-label="公众号设置">
          <button className="wd-cred-hd" aria-expanded={showCred} onClick={() => setShowCred((v) => !v)}>
            <KeyRound size={15} /><b>公众号设置</b>
            <span className={`k-st ${credOk ? 'ok' : 'wait'}`}>{credOk ? `已填写 ${cred.appId.slice(0, 6)}…` : '未填写'}</span>
            <ChevronDown size={15} className={`wd-chev${showCred ? ' open' : ''}`} />
          </button>
          {showCred && (
            <div className="wd-cred-body">
              <div className="k-field"><label className="k-label" htmlFor="wd-appid">AppID（公众号 ID）</label><input id="wd-appid" className="k-input" autoComplete="off" value={credDraft.appId} placeholder="照着后台复制，共 18 位" onChange={(e) => setCredDraft({ ...credDraft, appId: e.target.value })} /></div>
              <div className="k-field"><label className="k-label" htmlFor="wd-secret">AppSecret（公众号密钥）</label><input id="wd-secret" className="k-input" type="password" autoComplete="off" value={credDraft.appSecret} placeholder="开发密钥" onChange={(e) => setCredDraft({ ...credDraft, appSecret: e.target.value })} /></div>
              <p className="k-help">
                AppID（公众号 ID）和 AppSecret（公众号密钥）在「微信开发者平台 → 我的业务 → 你的公众号」里查看，只保存在这台电脑上。<b>还需要把本机的公网 IP 加进同一页面的「API IP 白名单」</b>，否则会提示 IP 不在白名单（提示里会写出你的 IP）。未认证的订阅号可能没有草稿接口权限。
              </p>
              <div className="wd-row">
                <button className="k-btn primary" disabled={credDraft.appId === cred.appId && credDraft.appSecret === cred.appSecret} onClick={saveCred}>保存</button>
                <button className="k-btn" disabled={!credDraft.appId.trim() || !credDraft.appSecret.trim() || testing} onClick={async () => {
                  setTesting(true); setMsg(null);
                  try { await saveCred(); clearTokenCache(); await getAccessToken(tauriHttp, credDraft.appId.trim(), credDraft.appSecret.trim()); setMsg({ kind: 'ok', text: '连接成功：AppID、AppSecret 和 IP 白名单都没问题' }); }
                  catch (e) { setShowCred(true); setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); }
                  setTesting(false);
                }}>{testing ? <Loader2 size={15} className="k-spin" /> : null}{testing ? '测试中…' : '保存并测试连接'}</button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div></div>
  );
}
