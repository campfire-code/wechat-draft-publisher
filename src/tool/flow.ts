// 三条流程的编排（全部通过传入的函数干活，测试里用假函数 / 假网络）：
//   writeArticle   主题 → 大模型写稿
//   illustrate     封面 + 插图（图像模型），插图插进正文
//   runAuto        一键：写稿 → 配图 → 排版 → 篇尾二维码 → 存草稿 → 发预览。到预览为止，发布和群发必须人工确认
//   runVoice       口播（本机视频或抖音链接）→ 提取音频 → 语音转文字 → 校对 → 改写成卡片脚本
import { buildMessages, checkArticle, parseArticle, type Article, type WriteRequest } from './core';
import { appendFooter, coverPrompt, illustrationPrompt, insertAfterLines, pickHeadings, type ImageGen, type Transcribe } from './ai';
import { buildProofreadMessages, buildScriptMessages, parseScript, type CardScript } from './cards';
import { getAccessToken, saveDraft, sendPreview, type Http, type Img, type PublishDeps } from './wechat';

export type Msg = { role: 'system' | 'user'; content: string };
export type Llm = (messages: Msg[], opts?: { temperature?: number; json?: boolean }) => Promise<string>;

export async function writeArticle(llm: Llm, req: WriteRequest): Promise<Omit<Article, 'author'>> {
  if (!req.topic.trim()) throw new Error('先填写文章主题');
  const out = parseArticle(await llm(buildMessages(req), { temperature: 0.7 }));
  if (!out.markdown) throw new Error('大模型没有返回正文，请重试');
  return out;
}

export interface IllustrateDeps {
  genImage: ImageGen;
  /** 把生成的图保存到本机，返回路径 */
  saveImage(img: Img, name: string): Promise<string>;
  /** 封面生成后的处理（例如裁成 2.35:1），不给就原样使用 */
  fitCover?(img: Img): Promise<Img>;
  onStep?(text: string): void;
}

export interface IllustrateResult { markdown: string; cover: Img | null; paths: string[]; failed: string[] }

/**
 * 配图：先生成封面，再给若干小节各生成一张插图并插进正文。
 * 某一张失败不影响其他张，失败原因收集在 failed 里（封面失败也一样，封面为空时存草稿会退回原有的选图办法）。
 */
export async function illustrate(deps: IllustrateDeps, a: { title: string; digest: string; markdown: string }, count: number, withCover = true): Promise<IllustrateResult> {
  const step = deps.onStep ?? (() => {});
  const failed: string[] = [];
  const paths: string[] = [];
  let cover: Img | null = null;
  const stamp = Date.now().toString(36);
  if (withCover) {
    step('正在生成封面图…');
    try {
      cover = await deps.genImage(coverPrompt(a.title, a.digest));
      if (deps.fitCover) cover = await deps.fitCover(cover);
    } catch (e) { failed.push(`封面：${e instanceof Error ? e.message : String(e)}`); }
  }
  const picks = pickHeadings(a.markdown, count);
  const items: { line: number; src: string }[] = [];
  for (let i = 0; i < picks.length; i++) {
    step(`正在生成插图 ${i + 1}/${picks.length}…`);
    try {
      const img = await deps.genImage(illustrationPrompt(a.title, picks[i].text));
      const p = await deps.saveImage(img, `配图-${stamp}-${i + 1}`);
      paths.push(p);
      items.push({ line: picks[i].line, src: p });
    } catch (e) {
      failed.push(`插图「${picks[i].text}」：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { markdown: insertAfterLines(a.markdown, items), cover, paths, failed };
}

export interface AutoDeps {
  llm: Llm;
  render(markdown: string, theme: string): Promise<string>;
  publish: PublishDeps;
  illustrate?: IllustrateDeps;
}

export interface AutoInput {
  req: WriteRequest;
  author: string;
  theme: string;
  illustrations: number;
  /** 篇尾二维码图片路径与一句话，没有就不加 */
  qrPath: string;
  qrText: string;
  appId: string;
  appSecret: string;
  /** 预览微信号，没填就不发预览 */
  previewWx: string;
  cover?: Img | null;
}

export interface AutoResult {
  article: Article;
  html: string;
  mediaId: string;
  previewed: boolean;
  failed: string[];
  coverFrom: string;
}

/** 一键流程。不会发布或群发：发布 / 群发由人确认预览后手动触发 */
export async function runAuto(deps: AutoDeps, input: AutoInput): Promise<AutoResult> {
  const step = deps.publish.onStep ?? (() => {});
  step('正在写稿…');
  const w = await writeArticle(deps.llm, input.req);
  let article: Article = { ...w, author: input.author };
  let cover = input.cover ?? null;
  let failed: string[] = [];
  if (deps.illustrate) {
    const r = await illustrate({ ...deps.illustrate, onStep: step }, article, input.illustrations, !cover);
    article = { ...article, markdown: r.markdown };
    cover = cover ?? r.cover;
    failed = r.failed;
  }
  const problems = checkArticle(article);
  if (problems.length) throw new Error(problems.join('；'));
  step('正在排版…');
  const html = appendFooter(await deps.render(article.markdown, input.theme), input.qrPath, input.qrText);
  const r = await saveDraft(deps.publish, { appId: input.appId, appSecret: input.appSecret, title: article.title, author: article.author, digest: article.digest, html, cover });
  let previewed = false;
  if (input.previewWx.trim()) {
    step('正在发送预览…');
    const token = await getAccessToken(deps.publish.http, input.appId, input.appSecret);
    await sendPreview(deps.publish.http, token, input.previewWx, r.mediaId);
    previewed = true;
  }
  return { article, html, mediaId: r.mediaId, previewed, failed, coverFrom: r.coverFrom };
}

// ---------- 口播 → 卡片脚本 ----------

export interface VoiceDeps {
  llm: Llm;
  transcribe: Transcribe;
  /** 抖音链接：下载视频存到本机并返回路径 */
  fetchVideo(shareText: string): Promise<string>;
  /** 从视频里提取单声道 16kHz 的 wav，返回字节 */
  extractAudio(videoPath: string): Promise<Uint8Array>;
  onStep?(text: string): void;
}

export type VoiceSource = { kind: 'link'; text: string } | { kind: 'file'; path: string };

export interface VoiceResult { transcript: string; script: CardScript; videoPath: string }

export async function runVoice(deps: VoiceDeps, src: VoiceSource, opts: { cards: number; proofread: boolean }): Promise<VoiceResult> {
  const step = deps.onStep ?? (() => {});
  const videoPath = src.kind === 'link' ? await deps.fetchVideo(src.text) : src.path;
  step('正在提取音频…');
  const wav = await deps.extractAudio(videoPath);
  step('正在把语音转成文字…');
  let transcript = await deps.transcribe(wav, 'audio.wav', 'audio/wav');
  if (opts.proofread) {
    step('正在校对文字…');
    try {
      const fixed = (await deps.llm(buildProofreadMessages(transcript), { temperature: 0.2 })).trim();
      if (fixed) transcript = fixed;
    } catch { /* 校对失败就用转写原文 */ }
  }
  step('正在改写成卡片脚本…');
  const script = parseScript(await deps.llm(buildScriptMessages(transcript, opts.cards), { temperature: 0.7 }), opts.cards);
  return { transcript, script, videoPath };
}

export type { Http };

// ---------- 发布、群发的二次确认 ----------

export type PublishKind = 'preview' | 'publish' | 'mass';

/**
 * 要不要先问一句：预览发到自己指定的微信号，不需要确认；发布和群发会对外可见，
 * 开着「二次确认」（默认开）时必须先让用户点一次确认才会执行。
 */
export function gate(kind: PublishKind, confirmOn: boolean, confirmed: boolean): 'run' | 'ask' {
  if (kind === 'preview') return 'run';
  return confirmOn && !confirmed ? 'ask' : 'run';
}

export function confirmCopy(kind: Exclude<PublishKind, 'preview'>, title: string, previewed: boolean): { text: string; button: string } {
  const t = `《${title.trim() || '未命名文章'}》`;
  const warn = previewed ? '' : '你还没有给自己发过预览，建议先预览确认排版。';
  if (kind === 'mass') {
    return {
      text: `将向公众号的全部粉丝群发${t}，发出后无法在这里撤回。群发成功后，这份草稿会被微信自动删除。每个公众号的群发次数有限。${warn}`,
      button: '确认群发',
    };
  }
  return { text: `将把${t}提交发布，发布后粉丝可以看到，无法在这里撤回。未认证的公众号可能没有发布接口的权限。${warn}`, button: '确认发布' };
}
