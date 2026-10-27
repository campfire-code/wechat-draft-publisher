// 流程编排：大模型 / 图像 / 语音用假函数，公众号接口用假网络。重点：一键流程到预览为止，不会发布或群发。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { confirmCopy, gate, illustrate, runAuto, runVoice, writeArticle, type AutoInput, type Llm } from './flow';
import { clearTokenCache, type Http, type Img, type PublishDeps } from './wechat';

const fx = (n: string) => readFileSync(join(process.cwd(), 'src/tool/fixtures', n), 'utf8');
const PNG: Img = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]), mime: 'image/png' };
const REPLY = '标题：咖啡馆会员怎么做\n摘要：三个做法。\n正文：\n## 先算账\n\n一段。\n\n## 换特权\n\n又一段。\n\n## 给理由\n\n再一段。';

describe('写稿', () => {
  it('主题为空不调用大模型；有主题就解析成文章', async () => {
    let n = 0;
    const llm: Llm = async () => { n++; return REPLY; };
    await expect(writeArticle(llm, { topic: ' ', outline: '', refs: '', words: 800, style: 'dry' })).rejects.toThrow('先填写文章主题');
    expect(n).toBe(0);
    const a = await writeArticle(llm, { topic: '会员', outline: '', refs: '', words: 800, style: 'dry' });
    expect(a.title).toBe('咖啡馆会员怎么做');
    expect(a.markdown).toContain('## 先算账');
  });
});

describe('配图', () => {
  it('封面 + 每个选中的小节一张插图；单张失败不影响其他张', async () => {
    const prompts: string[] = [];
    let k = 0;
    const saved: string[] = [];
    const r = await illustrate(
      { genImage: async (p) => { prompts.push(p); if (++k === 3) throw new Error('额度用完'); return PNG; }, saveImage: async (_i, name) => { saved.push(name); return `/tmp/${name}.png`; } },
      { title: '标题', digest: '摘要', markdown: '## 甲\n正文\n## 乙\n正文\n## 丙\n正文' }, 3,
    );
    expect(prompts).toHaveLength(4);
    expect(r.cover).toBe(PNG);
    expect(r.paths).toHaveLength(2);
    expect(r.failed).toEqual(['插图「乙」：额度用完']);
    expect(r.markdown).toContain('## 甲\n\n![](/tmp/');
    expect(r.markdown).toContain('## 丙\n\n![](/tmp/');
    expect(r.markdown).not.toContain('## 乙\n\n![]');
  });
  it('封面生成失败也记录在 failed 里；已有封面时不再生成封面', async () => {
    const r = await illustrate({ genImage: async () => { throw new Error('网络不通'); }, saveImage: async () => '' }, { title: 't', digest: '', markdown: '没有小标题' }, 3);
    expect(r.cover).toBeNull();
    expect(r.failed).toEqual(['封面：网络不通']);
    let n = 0;
    await illustrate({ genImage: async () => { n++; return PNG; }, saveImage: async () => '' }, { title: 't', digest: '', markdown: '## a' }, 1, false);
    expect(n).toBe(1);
  });
});

describe('一键到预览', () => {
  beforeEach(() => clearTokenCache());
  function setup() {
    const calls: { url: string; body?: string }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      const f = url.includes('/token?') ? 'token-ok.json' : url.includes('uploadimg') ? 'uploadimg-ok.json' : url.includes('add_material') ? 'add-material-ok.json' : url.includes('mass/preview') ? 'preview-ok.json' : 'draft-add-ok.json';
      return { status: 200, text: async () => fx(f) };
    };
    const steps: string[] = [];
    const publish: PublishDeps = { http, loadImage: async () => PNG, fitImage: async (i) => i, makeCover: async () => PNG, onStep: (t) => steps.push(t) };
    return { calls, publish, steps };
  }
  const input: AutoInput = {
    req: { topic: '会员', outline: '', refs: '', words: 800, style: 'dry' }, author: '作者', theme: 'default', illustrations: 2,
    qrPath: '/tmp/qr.png', qrText: '扫码加群', appId: 'wxA', appSecret: 'S', previewWx: 'my_wx',
  };
  const render = async (md: string) => `<section id="wenyan">${md.replace(/!\[\]\(([^)]*)\)/g, '<img src="$1">')}</section>`;

  it('写稿 → 配图 → 排版 → 二维码 → 存草稿 → 发预览；不调用群发和发布接口', async () => {
    const { calls, publish, steps } = setup();
    const r = await runAuto(
      { llm: async () => REPLY, render, publish, illustrate: { genImage: async () => PNG, saveImage: async (_i, n) => `/tmp/${n}.png` } },
      input,
    );
    const names = calls.map((c) => c.url.split('?')[0].split('/cgi-bin/')[1]);
    expect(names).toEqual(['token', 'media/uploadimg', 'media/uploadimg', 'media/uploadimg', 'material/add_material', 'draft/add', 'message/mass/preview']);
    expect(names.some((n) => n.includes('sendall') || n.includes('freepublish'))).toBe(false);
    const draft = JSON.parse(calls[5].body!).articles[0];
    expect(draft.title).toBe('咖啡馆会员怎么做');
    expect(draft.author).toBe('作者');
    expect(draft.content).toContain('扫码加群');
    expect(draft.content).not.toContain('/tmp/qr.png');
    expect(JSON.parse(calls[6].body!)).toMatchObject({ towxname: 'my_wx', mpnews: { media_id: 'DRAFT_MEDIA_ID' } });
    expect(r).toMatchObject({ mediaId: 'DRAFT_MEDIA_ID', previewed: true, failed: [] });
    expect(r.article.markdown).toContain('![](/tmp/');
    expect(steps[0]).toBe('正在写稿…');
    expect(steps).toContain('正在发送预览…');
  });
  it('没填预览微信号时存完草稿就停，不发预览；不开配图时不调用图像模型', async () => {
    const { calls, publish } = setup();
    const r = await runAuto({ llm: async () => REPLY, render, publish }, { ...input, previewWx: ' ', qrPath: '' });
    expect(r.previewed).toBe(false);
    expect(calls.some((c) => c.url.includes('mass/preview'))).toBe(false);
    expect(calls.filter((c) => c.url.includes('uploadimg'))).toHaveLength(0);
  });
  it('大模型没返回正文时在写稿这一步就停，不碰公众号', async () => {
    const { calls, publish } = setup();
    await expect(runAuto({ llm: async () => '标题：只有标题', render, publish }, input)).rejects.toThrow('没有返回正文');
    expect(calls).toHaveLength(0);
  });
});

describe('口播 → 卡片脚本', () => {
  const script = '{"title":"标题","lead":"引导","cards":[{"headline":"一","body":"甲"},{"headline":"二","body":"乙"}]}';
  function deps(over: Partial<Parameters<typeof runVoice>[0]> = {}) {
    const log: string[] = [];
    const d: Parameters<typeof runVoice>[0] = {
      llm: async (m) => { log.push('llm:' + m[0].content.slice(0, 6)); return m[0].content.includes('校对') ? '校对后的文字' : script; },
      transcribe: async (audio, name, mime) => { log.push(`asr:${audio.length}:${name}:${mime}`); return '原始转写'; },
      fetchVideo: async (t) => { log.push('fetch:' + t); return '/tmp/v.mp4'; },
      extractAudio: async (p) => { log.push('audio:' + p); return new Uint8Array(5); },
      onStep: (t) => log.push('step:' + t),
      ...over,
    };
    return { d, log };
  }
  it('本机文件：提取音频 → 转写 → 校对 → 改写；不会去抓链接', async () => {
    const { d, log } = deps();
    const r = await runVoice(d, { kind: 'file', path: '/tmp/a.mp4' }, { cards: 2, proofread: true });
    expect(r.transcript).toBe('校对后的文字');
    expect(r.script.cards).toHaveLength(2);
    expect(r.videoPath).toBe('/tmp/a.mp4');
    expect(log.filter((l) => !l.startsWith('step:')).map((l) => l.split(':')[0])).toEqual(['audio', 'asr', 'llm', 'llm']);
    expect(log.some((l) => l.startsWith('fetch'))).toBe(false);
    expect(log).toContain('asr:5:audio.wav:audio/wav');
  });
  it('抖音链接：先下载视频再处理', async () => {
    const { d, log } = deps();
    const r = await runVoice(d, { kind: 'link', text: 'https://v.douyin.com/x/' }, { cards: 2, proofread: false });
    expect(r.videoPath).toBe('/tmp/v.mp4');
    expect(r.transcript).toBe('原始转写');
    expect(log[0]).toBe('fetch:https://v.douyin.com/x/');
    expect(log.filter((l) => l.startsWith('llm:'))).toHaveLength(1);
  });
  it('校对失败就用转写原文；转写失败直接报错', async () => {
    let n = 0;
    const { d } = deps({ llm: async (m) => { if (m[0].content.includes('校对') && ++n) throw new Error('断网'); return script; } });
    expect((await runVoice(d, { kind: 'file', path: 'a' }, { cards: 2, proofread: true })).transcript).toBe('原始转写');
    const { d: d2 } = deps({ transcribe: async () => { throw new Error('语音识别调用失败'); } });
    await expect(runVoice(d2, { kind: 'file', path: 'a' }, { cards: 2, proofread: true })).rejects.toThrow('语音识别调用失败');
  });
});

describe('发布、群发的二次确认', () => {
  it('预览不需要确认；发布和群发在确认开着时必须先问，确认后才执行', () => {
    expect(gate('preview', true, false)).toBe('run');
    expect(gate('mass', true, false)).toBe('ask');
    expect(gate('publish', true, false)).toBe('ask');
    expect(gate('mass', true, true)).toBe('run');
  });
  it('用户关掉二次确认后才会直接执行', () => {
    expect(gate('mass', false, false)).toBe('run');
    expect(gate('publish', false, false)).toBe('run');
  });
  it('确认文案：写明标题、不可撤回；没发过预览时提醒', () => {
    const m = confirmCopy('mass', '我的文章', false);
    expect(m.text).toContain('《我的文章》');
    expect(m.text).toContain('全部粉丝');
    expect(m.text).toContain('无法在这里撤回');
    expect(m.text).toContain('还没有给自己发过预览');
    expect(m.button).toBe('确认群发');
    expect(confirmCopy('mass', '我的文章', true).text).not.toContain('还没有给自己发过预览');
    expect(confirmCopy('publish', '', true).button).toBe('确认发布');
  });
});
