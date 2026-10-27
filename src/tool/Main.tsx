// 主界面：左边写稿（AI 生成 + 手动编辑），右边公众号样式预览；可复制富文本、导出 HTML、一键存到公众号草稿箱。
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronLeft, CircleCheck, CircleDashed, Copy, FileDown, FileText, ImagePlus, Inbox, Lightbulb, Loader2, Palette, Send, Sparkles, Wand2, X, Zap } from 'lucide-react';
import { defaultOutputDir, ensureDir, fileSrc, fs, pickFiles, reveal, settingsStore } from '../kit/platform';
import { chat, llmReady, useSettings } from '../kit/settings';
import {
  LIMITS, PREFS_KEY, STYLES, charCount, checkArticle, htmlDocument, imageKind, localPath, readPrefs,
  replaceImageSrcs, safeFileName, type Article, type Prefs,
} from './core';
import { appendFooter, buildTopicMessages, generateImage, parseTopics, type ImageGen } from './ai';
import { listThemes, renderWechat } from './render';
import { saveDraft } from './wechat';
import { illustrate, runAuto, writeArticle, type IllustrateDeps } from './flow';
import { loadImage, cropToRatio } from './images';
import { tauriHttp } from './net';
import { TOOL_NAME, publishDeps, saveGenerated } from './deps';
import { SAMPLE } from './sample';
import { ServicesPanel, useServices, type Services } from './Services';
import { DEFAULT_CFG } from './config';
import { PublishBar, type DraftRef } from './Publish';
import { VoiceMode } from './Voice';
import './tool.css';

const DEFAULTS: Prefs = { theme: 'default', coverPath: '', article: SAMPLE, req: { topic: '', outline: '', refs: '', words: 1500, style: 'dry' } };
const WORDS: [number, string][] = [[800, '约 800 字'], [1500, '约 1500 字'], [2500, '约 2500 字']];

type Msg = { kind: 'ok' | 'err'; text: string; path?: string } | null;
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

const PREVIEW_CRED = { appId: 'wx0000000000000000', appSecret: '示例', previewWx: '示例微信号' };

export function Main({ preview }: { preview?: boolean }) {
  const q = new URLSearchParams(location.search);
  const [mode, setMode] = useState<'article' | 'voice'>(q.get('tab') === 'voice' ? 'voice' : 'article');
  const svc = useServices(!!preview, preview ? { cred: PREVIEW_CRED, cfg: { ...DEFAULT_CFG, confirm: true } } : undefined);
  const [llmOk, setLlmOk] = useState(!!preview);
  return (
    <div className="wd-host">
      {!preview && <LlmWatch onChange={setLlmOk} />}
      <div className="wd-modes">
        <div className="k-seg" role="radiogroup" aria-label="工作方式">
          <button role="radio" aria-checked={mode === 'article'} className={mode === 'article' ? 'on' : ''} onClick={() => setMode('article')}>写稿发布</button>
          <button role="radio" aria-checked={mode === 'voice'} className={mode === 'voice' ? 'on' : ''} onClick={() => setMode('voice')}>从口播生成</button>
        </div>
        <span className="k-muted">{mode === 'article' ? '主题或已有稿件 → 排版 → 草稿箱 → 预览 → 发布' : '你自己的口播视频 → 文字 → 图文卡片 → 草稿箱'}</span>
      </div>
      {mode === 'article' ? <ArticleMode preview={!!preview} svc={svc} llmOk={llmOk} /> : <VoiceMode preview={!!preview} svc={svc} llmOk={llmOk} />}
    </div>
  );
}

function ArticleMode({ preview, svc, llmOk }: { preview: boolean; svc: Services; llmOk: boolean }) {
  const themes = useMemo(() => listThemes(), []);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [html, setHtml] = useState('');
  const [renderErr, setRenderErr] = useState('');
  const [busy, setBusy] = useState<'' | 'ai' | 'save' | 'img' | 'auto' | 'topic'>('');
  const [step, setStep] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [copied, setCopied] = useState(false);
  const [topics, setTopics] = useState<string[]>([]);
  const [draft, setDraft] = useState<DraftRef | null>(preview ? { mediaId: 'PREVIEW', title: SAMPLE.title, kind: 'news' } : null);
  const [previewed, setPreviewed] = useState(false);
  const loaded = useRef(false);
  const mdRef = useRef<HTMLTextAreaElement>(null);
  const { cfg, cred, credOk } = svc;

  const a = prefs.article;
  const setArticle = (p: Partial<Article>) => setPrefs((o) => ({ ...o, article: { ...o.article, ...p } }));
  const setReq = (p: Partial<Prefs['req']>) => setPrefs((o) => ({ ...o, req: { ...o.req, ...p } }));

  // 读取上次的稿子
  useEffect(() => {
    if (preview) { loaded.current = true; return; }
    (async () => {
      try { setPrefs(readPrefs(await (await settingsStore()).get(PREFS_KEY), DEFAULTS)); } catch { /* 首次打开 */ }
      loaded.current = true;
    })();
  }, [preview]);
  useEffect(() => {
    if (!loaded.current || preview) return;
    const id = setTimeout(async () => { try { await (await settingsStore()).set(PREFS_KEY, prefs); } catch { /* 忽略 */ } }, 600);
    return () => clearTimeout(id);
  }, [prefs, preview]);

  // 排版预览（篇尾二维码也算在文章里，所见即所得）
  const md = useDeferredValue(a.markdown);
  useEffect(() => {
    let live = true;
    renderWechat(md, prefs.theme).then((h) => { if (live) { setHtml(appendFooter(h, cfg.qrPath, cfg.qrText)); setRenderErr(''); } }, (e) => live && setRenderErr(String(e instanceof Error ? e.message : e)));
    return () => { live = false; };
  }, [md, prefs.theme, cfg.qrPath, cfg.qrText]);
  // 预览里本机图片换成可显示的地址（提交草稿时用原地址上传）
  const previewHtml = useMemo(() => replaceImageSrcs(html, (s) => (imageKind(s) === 'local' ? fileSrc(localPath(s)) : undefined)), [html]);

  const llm = (messages: Parameters<typeof chat>[0], o?: Parameters<typeof chat>[1]) => chat(messages, o);
  const imageGen: ImageGen = (p) => generateImage(tauriHttp, cfg.image, cfg.image.size, p);
  const illDeps = (): IllustrateDeps => ({ genImage: imageGen, saveImage: saveGenerated, fitCover: (i) => cropToRatio(i, 2.35), onStep: setStep });
  const fail = (e: unknown) => setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });

  async function aiWrite() {
    if (!prefs.req.topic.trim()) { setMsg({ kind: 'err', text: '先填写文章主题' }); return; }
    if (a.markdown.trim() && a.markdown !== SAMPLE.markdown && !confirm('AI 生成的文章会替换当前的标题、摘要和正文，继续吗？')) return;
    setBusy('ai'); setMsg(null);
    try {
      const out = await writeArticle(llm, prefs.req);
      setArticle({ title: out.title, digest: out.digest, markdown: out.markdown });
      setMsg({ kind: 'ok', text: `已生成「${out.title || '未命名'}」，可以直接修改后再存草稿` });
    } catch (e) { fail(e); }
    setBusy('');
  }

  async function suggestTopics() {
    setBusy('topic'); setMsg(null);
    try { setTopics(parseTopics(await chat(buildTopicMessages(prefs.req.topic), { temperature: 0.9 }))); } catch (e) { fail(e); }
    setBusy('');
  }

  /** 一键：写稿 → 配图 → 存草稿 → 发预览。到预览为止，发布和群发要在右侧「发布」里手动确认 */
  async function oneClick() {
    if (!prefs.req.topic.trim()) { setMsg({ kind: 'err', text: '先填写文章主题' }); return; }
    if (!credOk) { setMsg({ kind: 'err', text: '先在「公众号」设置里填写 AppID 和 AppSecret' }); return; }
    if (a.markdown.trim() && a.markdown !== SAMPLE.markdown && !confirm('一键流程会用 AI 新写一篇文章替换当前内容，并直接存入草稿箱，继续吗？')) return;
    setBusy('auto'); setMsg(null); setDraft(null); setPreviewed(false);
    try {
      const cover = prefs.coverPath ? await loadImage(prefs.coverPath) : null;
      const r = await runAuto(
        { llm, render: renderWechat, publish: publishDeps(setStep), illustrate: svc.imageOk ? illDeps() : undefined },
        { req: prefs.req, author: a.author, theme: prefs.theme, illustrations: cfg.image.count, qrPath: cfg.qrPath, qrText: cfg.qrText, appId: cred.appId, appSecret: cred.appSecret, previewWx: cred.previewWx, cover },
      );
      setArticle({ title: r.article.title, digest: r.article.digest, markdown: r.article.markdown });
      setDraft({ mediaId: r.mediaId, title: r.article.title, kind: 'news' });
      setPreviewed(r.previewed);
      const tail = r.previewed ? `预览已发到微信号「${cred.previewWx}」，确认没问题后在下面点「发布」或「群发」` : '没有填预览微信号，没发预览；可以到公众号后台检查，或填好微信号后点「发预览」';
      setMsg({ kind: r.failed.length ? 'err' : 'ok', text: `已写好并存入草稿箱。${tail}${r.failed.length ? `。部分配图失败：${r.failed.join('；')}` : ''}` });
    } catch (e) { fail(e); }
    setStep(''); setBusy('');
  }

  async function aiImages() {
    if (!svc.imageOk) { setMsg({ kind: 'err', text: '先在「自动配图」里开启并填好图像模型的接口' }); return; }
    const problems = checkArticle(a).filter((p) => p.includes('正文') || p.includes('标题不能'));
    if (problems.length) { setMsg({ kind: 'err', text: `先写好标题和正文再配图：${problems.join('；')}` }); return; }
    setBusy('img'); setMsg(null);
    try {
      const r = await illustrate(illDeps(), a, cfg.image.count, !prefs.coverPath);
      setArticle({ markdown: r.markdown });
      if (r.cover) {
        const p = await saveGenerated(r.cover, `封面-${Date.now().toString(36)}`);
        setPrefs((o) => ({ ...o, coverPath: p }));
      }
      const got = `生成了${r.cover ? '封面和' : ''} ${r.paths.length} 张插图`;
      setMsg({ kind: r.failed.length ? 'err' : 'ok', text: r.failed.length ? `${got}；失败：${r.failed.join('；')}` : `${got}，插图已放进正文，图片保存在「下载/${TOOL_NAME}/配图」` });
    } catch (e) { fail(e); }
    setStep(''); setBusy('');
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

  async function publish() {
    setMsg(null);
    const problems = checkArticle(a);
    if (problems.length) { setMsg({ kind: 'err', text: problems.join('；') }); return; }
    if (!credOk) { setMsg({ kind: 'err', text: '先在「公众号」设置里填写 AppID 和 AppSecret' }); return; }
    setBusy('save'); setPreviewed(false);
    try {
      const cover = prefs.coverPath ? await loadImage(prefs.coverPath) : null;
      const r = await saveDraft(publishDeps(setStep), { appId: cred.appId, appSecret: cred.appSecret, title: a.title, author: a.author, digest: a.digest, html, cover });
      const from = { chosen: '你选的封面', content: '正文第一张图作封面', generated: '自动生成的标题封面' }[r.coverFrom];
      setDraft({ mediaId: r.mediaId, title: a.title, kind: 'news' });
      setMsg({ kind: 'ok', text: `已存入草稿箱（上传了 ${r.images} 张正文图片，使用${from}）。可以先「发预览」，确认后再发布或群发` });
    } catch (e) { fail(e); }
    setStep(''); setBusy('');
  }

  const working = busy !== '';
  const cover = prefs.coverPath ? '用你选的图' : svc.imageOk ? '可 AI 生成' : '自动选择';
  return (
    <div className="wd">
      <ol className="wd-flow" aria-label="流程">
        <li className={a.markdown.trim() ? 'done' : 'now'}><FileText size={16} /><span><b>写稿</b><small>AI 起草或自己写</small></span></li>
        <ArrowRight size={16} className="wd-flow-arrow" aria-hidden />
        <li className="done"><Palette size={16} /><span><b>排版配图</b><small>{themes.find((t) => t.id === prefs.theme)?.name ?? '默认'}主题{svc.imageOk ? ' · 可配图' : ''}</small></span></li>
        <ArrowRight size={16} className="wd-flow-arrow" aria-hidden />
        <li className={draft ? 'done' : credOk && html ? 'now' : ''}><Inbox size={16} /><span><b>草稿箱</b><small>{draft ? '已存草稿' : credOk ? '随时可以存' : '先填公众号设置'}</small></span></li>
        <ArrowRight size={16} className="wd-flow-arrow" aria-hidden />
        <li className={previewed ? 'done' : draft ? 'now' : ''}><Send size={16} /><span><b>预览发布</b><small>{previewed ? '已发预览' : '预览后再发布'}</small></span></li>
      </ol>
      <div className="wd-edit">
        <details className="k-panel wd-ai" open={!a.markdown.trim() || undefined}>
          <summary><Sparkles size={15} /><b>AI 写稿</b><span className="k-muted">填主题和提纲，让大模型写初稿；也可以直接在下面粘贴已有稿件</span><ChevronDown size={15} className="wd-chev" /></summary>
          <div className="wd-ai-body">
            <div className="k-field"><label className="k-label wd-lab" htmlFor="wd-topic">主题<button className="k-link" disabled={working || !llmOk} onClick={suggestTopics}>{busy === 'topic' ? <Loader2 size={13} className="k-spin" /> : <Lightbulb size={13} />}没想好？给我几个标题</button></label><input id="wd-topic" className="k-input" value={prefs.req.topic} placeholder="例如：社区咖啡馆怎么做会员" onChange={(e) => setReq({ topic: e.target.value })} /></div>
            {topics.length > 0 && <div className="wd-topics" role="group" aria-label="备选标题">{topics.map((t) => <button key={t} className="k-chip" onClick={() => { setReq({ topic: t }); setTopics([]); }}>{t}</button>)}</div>}
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
              <button className="k-btn primary" disabled={working || !llmOk} onClick={aiWrite}>{busy === 'ai' ? <Loader2 size={15} className="k-spin" /> : <Sparkles size={15} />}{busy === 'ai' ? '正在写…' : '生成文章'}</button>
              <button className="k-btn" disabled={working || !llmOk || !credOk} title="写稿 → 配图 → 存草稿 → 发预览，到预览为止，不会自动发布或群发" onClick={oneClick}>{busy === 'auto' ? <Loader2 size={15} className="k-spin" /> : <Zap size={15} />}{busy === 'auto' ? (step || '进行中…') : '一键到预览'}</button>
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

        <ServicesPanel svc={svc} preview={preview} onMsg={setMsg} />
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
            [true, '封面', cover],
            [credOk, '公众号设置', credOk ? '已填写' : '未填写'],
          ].map(([ok, k, v]) => <li key={String(k)} className={ok ? 'ok' : ''}>{ok ? <CircleCheck size={15} /> : <CircleDashed size={15} />}<span>{k as string}</span><b>{v as string}</b></li>)}
        </ul>

        <div className="wd-actions">
          <button className="k-btn" onClick={doCopy} disabled={!html}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制富文本'}</button>
          <button className="k-btn" onClick={exportHtml} disabled={!html}><FileDown size={15} />导出 HTML</button>
          <button className="k-btn" onClick={aiImages} disabled={working || !svc.imageOk} title={svc.imageOk ? '为文章生成封面和插图' : '先在「自动配图」里开启并填好接口'}>{busy === 'img' ? <Loader2 size={15} className="k-spin" /> : <Wand2 size={15} />}{busy === 'img' ? (step || '生成中…') : 'AI 配图'}</button>
          <button className="k-btn primary" onClick={publish} disabled={working || !html}>{busy === 'save' ? <Loader2 size={15} className="k-spin" /> : <Send size={15} />}{busy === 'save' ? (step || '正在提交…') : '存到草稿箱'}</button>
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

        <PublishBar cred={cred} confirmOn={cfg.confirm} draft={draft} previewed={previewed} onPreviewed={() => setPreviewed(true)} onDone={() => { setDraft(null); setPreviewed(false); }} onMsg={setMsg} />
      </div>
    </div>
  );
}
