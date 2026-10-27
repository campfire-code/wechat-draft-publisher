// 「从口播生成」：只处理你自己的视频。本机视频文件，或粘贴你自己发布的抖音分享链接 →
// 提取音频 → 语音转文字（你自己填的语音识别接口）→ 大模型改写成图文卡片脚本 → 渲染 1080×1440 卡片 → 存为公众号图片消息或图文草稿。
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FileText, FileVideo, FolderOpen, Image as ImageIcon, Inbox, Loader2, Mic, Plus, Send, Sparkles, Trash2, X } from 'lucide-react';
import { defaultOutputDir, ensureDir, fs, pickFiles, reveal, runFfmpeg } from '../kit/platform';
import { chat } from '../kit/settings';
import { useDroppedFiles } from '../kit/parts';
import { transcribeAudio } from './ai';
import { CH, CW, SCRIPT, checkScript, cardsHtml, picContent, type CardScript } from './cards';
import { CARD_TEMPLATES, cardTemplate, drawCard, measurer, renderCardPngs } from './cardsRender';
import { layoutCards } from './cards';
import { fetchDouyinVideo } from './douyin';
import { runVoice } from './flow';
import { tauriHttp } from './net';
import { PublishBar, type DraftRef } from './Publish';
import { safeFileName } from './core';
import { loadImage } from './images';
import { saveDraft, savePicDraft } from './wechat';

import { TOOL_NAME, publishDeps } from './deps';
import { SAMPLE_SCRIPT } from './sample';
import { ServicesPanel, type Services } from './Services';

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'flv', 'mp3', 'm4a', 'wav', 'aac'];

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function Thumb({ script, index, tpl, signature }: { script: CardScript; index: number; tpl: string; signature: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const t = cardTemplate(tpl);
  const layouts = useMemo(() => layoutCards(script, measurer(t)), [script, t]);
  useEffect(() => {
    if (ref.current && layouts[index]) drawCard(ref.current, layouts[index], t, signature, 0.25);
  }, [layouts, index, t, signature]);
  return <canvas ref={ref} className={`wd-thumb${layouts[index]?.overflow ? ' over' : ''}`} aria-label={`第 ${index + 1} 张卡片`} />;
}

export function VoiceMode({ preview, svc, llmOk }: { preview: boolean; svc: Services; llmOk: boolean }) {
  const [src, setSrc] = useState<'file' | 'link'>('file');
  const [file, setFile] = useState('');
  const [link, setLink] = useState('');
  const [mine, setMine] = useState(false);
  const [cards, setCards] = useState(6);
  const [tpl, setTpl] = useState('paper');
  const [signature, setSignature] = useState('');
  const [saveAs, setSaveAs] = useState<'pic' | 'news'>('pic');
  const [transcript, setTranscript] = useState(preview ? '示例：口播转写出来的文字会显示在这里，可以先看一眼再决定要不要继续改写。' : '');
  const [script, setScript] = useState<CardScript | null>(preview ? SAMPLE_SCRIPT : null);
  const [busy, setBusy] = useState<'' | 'gen' | 'save' | 'export'>('');
  const [step, setStep] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; path?: string } | null>(null);
  const [draft, setDraft] = useState<DraftRef | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const { cfg, cred, credOk, asrOk } = svc;

  const hover = useDroppedFiles((paths) => {
    const p = paths.find((x) => VIDEO_EXT.includes((x.split('.').pop() ?? '').toLowerCase()));
    if (p) { setSrc('file'); setFile(p); }
  });
  const fail = (e: unknown) => setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });

  const layouts = useMemo(() => (script ? layoutCards(script, measurer(cardTemplate(tpl))) : []), [script, tpl]);
  const overflowCount = layouts.filter((l) => l.overflow).length;

  async function workDir(sub: string) {
    const dir = await fs.join(await defaultOutputDir(TOOL_NAME), sub);
    await ensureDir(dir);
    return dir;
  }

  async function generate() {
    if (src === 'file' && !file) { setMsg({ kind: 'err', text: '先选择一个视频或音频文件' }); return; }
    if (src === 'link' && !link.trim()) { setMsg({ kind: 'err', text: '先粘贴你自己的抖音分享链接' }); return; }
    if (src === 'link' && !mine) { setMsg({ kind: 'err', text: '请先确认这是你自己发布的视频' }); return; }
    if (!asrOk) { setMsg({ kind: 'err', text: '先在「语音识别」里填写接口地址、密钥和模型名' }); return; }
    if (!llmOk) { setMsg({ kind: 'err', text: '还没有设置大模型，请到顶部「设置」里填写' }); return; }
    setBusy('gen'); setMsg(null); setDraft(null); setPreviewed(false);
    try {
      const dir = await workDir('口播素材');
      const r = await runVoice(
        {
          llm: (m, o) => chat(m, o),
          transcribe: (audio, name, mime) => transcribeAudio(tauriHttp, cfg.asr, cfg.asr.language, audio, name, mime),
          fetchVideo: async (text) => {
            const v = await fetchDouyinVideo(tauriHttp, text, setStep);
            const p = await fs.join(dir, `${safeFileName(v.id)}.mp4`);
            await fs.writeFile(p, v.bytes);
            return p;
          },
          extractAudio: async (video) => {
            const out = await fs.join(dir, `${safeFileName(baseName(video).replace(/\.[^.]+$/, ''))}.wav`);
            await runFfmpeg(['-i', video, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', out]);
            return fs.readFile(out);
          },
          onStep: setStep,
        },
        src === 'link' ? { kind: 'link', text: link } : { kind: 'file', path: file },
        { cards, proofread: cfg.asr.proofread },
      );
      setTranscript(r.transcript);
      setScript(r.script);
      setMsg({ kind: 'ok', text: `已改写成 ${r.script.cards.length + 1} 张卡片（含首张），可以直接修改文字，满意后存到草稿箱` });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      fail(src === 'link' && /页面|分享页|视频|链接/.test(text) ? new Error(`${text}。抖音链接解析可能失效，可以改用「本机视频」：把视频保存到电脑后选择文件`) : e);
    }
    setStep(''); setBusy('');
  }

  const patch = (p: Partial<CardScript>) => setScript((s) => (s ? { ...s, ...p } : s));
  const patchCard = (i: number, p: Partial<CardScript['cards'][number]>) => setScript((s) => (s ? { ...s, cards: s.cards.map((c, k) => (k === i ? { ...c, ...p } : c)) } : s));

  /** 把整套卡片写到本机文件夹，返回路径列表 */
  async function writeCards(sc: CardScript) {
    const { pngs } = await renderCardPngs(sc, cardTemplate(tpl), signature);
    const dir = await workDir(`口播卡片/${safeFileName(sc.title)}`);
    const paths: string[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const p = await fs.join(dir, `卡片-${String(i + 1).padStart(2, '0')}.png`);
      await fs.writeFile(p, pngs[i]);
      paths.push(p);
    }
    return { dir, paths, pngs };
  }

  async function exportCards() {
    if (!script) return;
    setBusy('export'); setMsg(null);
    try {
      const { dir, paths } = await writeCards(script);
      setMsg({ kind: 'ok', text: `已导出 ${paths.length} 张卡片图（${CW}×${CH}）`, path: paths[0] ?? dir });
    } catch (e) { fail(e); }
    setBusy('');
  }

  async function saveToDraft() {
    if (!script) return;
    const problems = checkScript(script, saveAs);
    if (problems.length) { setMsg({ kind: 'err', text: problems.join('；') }); return; }
    if (!credOk) { setMsg({ kind: 'err', text: '先在「公众号」设置里填写 AppID 和 AppSecret' }); return; }
    setBusy('save'); setMsg(null); setPreviewed(false);
    try {
      setStep('正在绘制卡片…');
      const { paths, pngs } = await writeCards(script);
      let mediaId: string;
      if (saveAs === 'pic') {
        const r = await savePicDraft(publishDeps(setStep), { appId: cred.appId, appSecret: cred.appSecret, title: script.title, content: picContent(script), images: pngs.map((bytes) => ({ bytes, mime: 'image/png' })), width: CW, height: CH, openComment: true });
        mediaId = r.mediaId;
      } else {
        const first = await loadImage(paths[0]);
        const r = await saveDraft(publishDeps(setStep), { appId: cred.appId, appSecret: cred.appSecret, title: script.title, author: '', digest: script.lead, html: cardsHtml(paths), cover: first });
        mediaId = r.mediaId;
      }
      setDraft({ mediaId, title: script.title, kind: saveAs === 'pic' ? 'newspic' : 'news' });
      setMsg({ kind: 'ok', text: `已存入草稿箱（${saveAs === 'pic' ? '图片消息' : '图文消息'}，${paths.length} 张卡片）。可以先「发预览」，确认后再发布` });
    } catch (e) { fail(e); }
    setStep(''); setBusy('');
  }

  const working = busy !== '';
  return (
    <div className="wd">
      <ol className="wd-flow" aria-label="流程">
        <li className={transcript ? 'done' : 'now'}><FileVideo size={16} /><span><b>你的口播</b><small>本机视频或自己的链接</small></span></li>
        <ArrowRight size={16} className="wd-flow-arrow" aria-hidden />
        <li className={transcript ? 'done' : ''}><Mic size={16} /><span><b>转成文字</b><small>语音识别 + 校对</small></span></li>
        <ArrowRight size={16} className="wd-flow-arrow" aria-hidden />
        <li className={script ? 'done' : ''}><ImageIcon size={16} /><span><b>卡片</b><small>{script ? `${script.cards.length + 1} 张 ${CW}×${CH}` : '改写并排版'}</small></span></li>
        <ArrowRight size={16} className="wd-flow-arrow" aria-hidden />
        <li className={draft ? 'done' : script ? 'now' : ''}><Inbox size={16} /><span><b>草稿箱</b><small>{draft ? '已存草稿' : '图片消息或图文'}</small></span></li>
      </ol>

      <div className="wd-edit">
        <section className={`k-panel wd-form${hover ? ' wd-drop' : ''}`} aria-label="口播来源">
          <div className="wd-row">
            <div className="k-seg" role="radiogroup" aria-label="来源">
              <button role="radio" aria-checked={src === 'file'} className={src === 'file' ? 'on' : ''} onClick={() => setSrc('file')}>本机视频</button>
              <button role="radio" aria-checked={src === 'link'} className={src === 'link' ? 'on' : ''} onClick={() => setSrc('link')}>我的抖音链接</button>
            </div>
          </div>
          {src === 'file' ? (
            <div className="wd-cover">
              {file ? <span className="wd-cover-file"><FileVideo size={16} /><span className="k-ellipsis" title={file}>{baseName(file)}</span><button className="k-icon-btn" aria-label="换一个文件" onClick={() => setFile('')}><X size={14} /></button></span> : <span className="k-muted wd-cover-hint">{preview ? '示例：我的口播.mp4' : '把你的口播视频（或音频）拖进窗口，或点右边选择'}</span>}
              <button className="k-link" onClick={async () => { const [p] = await pickFiles(VIDEO_EXT, '视频或音频'); if (p) setFile(p); }}>选择文件</button>
            </div>
          ) : (
            <>
              <div className="k-field"><label className="k-label" htmlFor="wd-link">抖音分享链接（可以连同分享文案一起粘贴）</label><textarea id="wd-link" className="k-input k-textarea" rows={2} value={link} placeholder="https://v.douyin.com/…" onChange={(e) => setLink(e.target.value)} /></div>
              <label className="k-toggle"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />这是我自己发布的视频</label>
              <p className="k-help">只用于处理你自己的作品。解析依赖抖音的分享页，页面改版或被拦截时会失败，失败后请把视频存到电脑，改用「本机视频」。</p>
            </>
          )}
          <div className="wd-row wd-two">
            <div className="k-field"><label className="k-label" htmlFor="wd-ncards">内容卡片数（另有 1 张首张）</label><select id="wd-ncards" className="k-input" value={cards} onChange={(e) => setCards(Number(e.target.value))}>{[3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n} 张</option>)}</select></div>
            <div className="k-field wd-grow"><label className="k-label" htmlFor="wd-sign">卡片页脚署名（可不填）</label><input id="wd-sign" className="k-input" value={signature} placeholder="例如你的账号名" onChange={(e) => setSignature(e.target.value)} /></div>
          </div>
          <div className="wd-row">
            <button className="k-btn primary" disabled={working || !llmOk || !asrOk} onClick={generate}>{busy === 'gen' ? <Loader2 size={15} className="k-spin" /> : <Sparkles size={15} />}{busy === 'gen' ? (step || '进行中…') : '识别并改写成卡片'}</button>
            {!asrOk && <span className="k-muted">先在下面「语音识别」里填好接口</span>}
            {asrOk && !llmOk && <span className="k-muted">还没有设置大模型，请到顶部「设置」里填写</span>}
          </div>
        </section>

        {transcript && (
          <details className="k-panel wd-ai" aria-label="识别出的文字">
            <summary><FileText size={15} /><b>识别出的文字</b><span className="k-muted">{Array.from(transcript).length} 字</span></summary>
            <div className="wd-ai-body"><textarea className="k-input k-textarea" rows={5} value={transcript} readOnly aria-label="口播文字" /></div>
          </details>
        )}

        {script && (
          <section className="k-panel wd-form" aria-label="卡片脚本">
            <div className="k-field">
              <label className="k-label wd-lab" htmlFor="wd-vt">标题<span className={`wd-count k-num${Array.from(script.title).length > SCRIPT.title ? ' over' : ''}`}>{Array.from(script.title).length}/{SCRIPT.title}</span></label>
              <input id="wd-vt" className="k-input" value={script.title} onChange={(e) => patch({ title: e.target.value })} />
            </div>
            <div className="k-field"><label className="k-label" htmlFor="wd-vl">首张引导语</label><input id="wd-vl" className="k-input" value={script.lead} onChange={(e) => patch({ lead: e.target.value })} /></div>
            {script.cards.map((c, i) => (
              <div className="wd-card-edit" key={i}>
                <div className="wd-row">
                  <span className="k-num wd-card-no">{String(i + 2).padStart(2, '0')}</span>
                  <input className="k-input wd-grow" aria-label={`第 ${i + 1} 张小标题`} value={c.headline} placeholder="小标题" onChange={(e) => patchCard(i, { headline: e.target.value })} />
                  <button className="k-icon-btn" aria-label={`删除第 ${i + 1} 张`} title="删除这张" onClick={() => setScript((s) => (s ? { ...s, cards: s.cards.filter((_, k) => k !== i) } : s))}><Trash2 size={14} /></button>
                </div>
                <textarea className="k-input k-textarea" rows={3} aria-label={`第 ${i + 1} 张正文`} value={c.body} placeholder="正文" onChange={(e) => patchCard(i, { body: e.target.value })} />
              </div>
            ))}
            <div className="wd-row">
              <button className="k-btn" disabled={script.cards.length >= SCRIPT.maxCards} onClick={() => setScript((s) => (s ? { ...s, cards: [...s.cards, { headline: '', body: '' }] } : s))}><Plus size={15} />加一张</button>
            </div>
          </section>
        )}

        <ServicesPanel svc={svc} preview={preview} onMsg={setMsg} />
      </div>

      <div className="wd-side">
        <div className="wd-stage">
          <div className="wd-stage-hd"><b>卡片预览</b><span className="k-muted">{CW}×{CH}，3:4</span></div>
          <div className="wd-themes" role="radiogroup" aria-label="卡片模板">
            {CARD_TEMPLATES.map((t) => <button key={t.id} role="radio" aria-checked={tpl === t.id} className={`k-chip${tpl === t.id ? ' on' : ''}`} onClick={() => setTpl(t.id)}>{t.name}</button>)}
          </div>
          {script ? (
            <div className="wd-thumbs">{layouts.map((_, i) => <Thumb key={i} script={script} index={i} tpl={tpl} signature={signature} />)}</div>
          ) : <p className="k-muted wd-empty-note">识别并改写后，这里会显示整套卡片。</p>}
          {overflowCount > 0 && <p className="k-err-text">有 {overflowCount} 张卡片文字太多（红框），请精简文字或拆成两张。</p>}
        </div>

        <div className="wd-save-as">
          <span className="k-label">存为</span>
          <div className="k-seg" role="radiogroup" aria-label="存为">
            <button role="radio" aria-checked={saveAs === 'pic'} className={saveAs === 'pic' ? 'on' : ''} onClick={() => setSaveAs('pic')}>图片消息</button>
            <button role="radio" aria-checked={saveAs === 'news'} className={saveAs === 'news' ? 'on' : ''} onClick={() => setSaveAs('news')}>图文消息</button>
          </div>
        </div>
        <div className="wd-actions">
          <button className="k-btn" disabled={!script || working} onClick={exportCards}>{busy === 'export' ? <Loader2 size={15} className="k-spin" /> : <FolderOpen size={15} />}导出卡片图</button>
          <button className="k-btn primary" disabled={!script || working} onClick={saveToDraft}>{busy === 'save' ? <Loader2 size={15} className="k-spin" /> : <Send size={15} />}{busy === 'save' ? (step || '正在提交…') : '存到草稿箱'}</button>
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
