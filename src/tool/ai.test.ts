// 图像 / 语音识别接口的请求构造与响应解析、选题、配图位置、篇尾二维码。网络用假函数。
import { describe, expect, it } from 'vitest';
import {
  ASR_MAX_BYTES, appendFooter, buildForm, buildTopicMessages, coverCropRect, coverPrompt, generateImage, headings, illustrationPrompt, imageRequest,
  insertAfterLines, parseImageResponse, parseTopics, parseTranscription, pickHeadings, transcribeAudio, transcribeRequest,
} from './ai';
import type { Http } from './wechat';

const cfg = { baseUrl: 'https://img.example.com/v1/', apiKey: 'KEY', model: 'm1' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe('图像模型', () => {
  it('请求：地址去掉多余斜杠，带密钥，不传 response_format', () => {
    const r = imageRequest(cfg, '画一只猫', ' 1024x1024 ');
    expect(r.url).toBe('https://img.example.com/v1/images/generations');
    expect(r.headers.Authorization).toBe('Bearer KEY');
    expect(JSON.parse(r.body)).toEqual({ model: 'm1', prompt: '画一只猫', n: 1, size: '1024x1024' });
  });
  it('响应：b64_json、url、错误、空', () => {
    expect(parseImageResponse(200, JSON.stringify({ data: [{ b64_json: 'AAA' }] }))).toEqual({ b64: 'AAA' });
    expect(parseImageResponse(200, JSON.stringify({ data: [{ url: 'https://x/y.png' }] }))).toEqual({ url: 'https://x/y.png' });
    expect(() => parseImageResponse(401, '{"error":{"message":"bad key"}}')).toThrow('图像模型调用失败（401，密钥不对或已过期）：bad key');
    expect(() => parseImageResponse(200, '{"data":[]}')).toThrow('没有返回图片');
    expect(() => parseImageResponse(200, 'oops')).toThrow('无法识别');
  });
  it('生成：返回 base64 时直接解码；返回网址时再下载；不是图片就报错', async () => {
    const posted: string[] = [];
    const a: Http = async (url, init) => { posted.push(url); expect(init?.method).toBe('POST'); return { status: 200, text: async () => JSON.stringify({ data: [{ b64_json: b64(PNG) }] }) }; };
    const img = await generateImage(a, cfg, '1024x1024', 'p');
    expect(img.mime).toBe('image/png');
    expect(Array.from(img.bytes)).toEqual(Array.from(PNG));

    const calls: string[] = [];
    const b: Http = async (url) => {
      calls.push(url);
      return url.endsWith('/images/generations')
        ? { status: 200, text: async () => JSON.stringify({ data: [{ url: 'https://cdn.example.com/a.png' }] }) }
        : { status: 200, text: async () => '', bytes: async () => PNG };
    };
    expect((await generateImage(b, cfg, '1024x1024', 'p')).mime).toBe('image/png');
    expect(calls).toEqual(['https://img.example.com/v1/images/generations', 'https://cdn.example.com/a.png']);

    const c: Http = async () => ({ status: 200, text: async () => JSON.stringify({ data: [{ b64_json: btoa('not an image at all') }] }) });
    await expect(generateImage(c, cfg, '1024x1024', 'p')).rejects.toThrow('不是可识别的图片');
  });
});

describe('语音识别', () => {
  it('multipart：字段与文件都在，文件内容原样', () => {
    const { body, contentType } = buildForm({ model: 'm', language: 'zh' }, { field: 'file', filename: 'a.wav', mime: 'audio/wav', bytes: new Uint8Array([1, 2, 3]) }, 'B');
    expect(contentType).toBe('multipart/form-data; boundary=B');
    const t = new TextDecoder('latin1').decode(body);
    expect(t).toBe('--B\r\nContent-Disposition: form-data; name="model"\r\n\r\nm\r\n--B\r\nContent-Disposition: form-data; name="language"\r\n\r\nzh\r\n--B\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n\x01\x02\x03\r\n--B--\r\n');
  });
  it('请求：地址、密钥头、language 留空时不传', () => {
    const r = transcribeRequest({ baseUrl: 'https://asr.example.com/v1', apiKey: 'K', model: 'whisper-1' }, new Uint8Array([9]), 'a.wav', 'audio/wav', '', 'B');
    expect(r.url).toBe('https://asr.example.com/v1/audio/transcriptions');
    expect(r.headers.Authorization).toBe('Bearer K');
    const t = new TextDecoder().decode(r.body);
    expect(t).toContain('name="model"\r\n\r\nwhisper-1');
    expect(t).toContain('name="response_format"\r\n\r\njson');
    expect(t).not.toContain('name="language"');
  });
  it('响应：取 text；空文字、错误、非 JSON 都有中文提示', () => {
    expect(parseTranscription(200, '{"text":" 你好 "}')).toBe('你好');
    expect(() => parseTranscription(200, '{"text":" "}')).toThrow('没有识别出文字');
    expect(() => parseTranscription(413, 'too big')).toThrow('语音识别调用失败（413，文件太大）');
    expect(() => parseTranscription(200, '<html>')).toThrow('无法识别');
  });
  it('超过 25MB 不发请求', async () => {
    let called = false;
    const http: Http = async () => { called = true; return { status: 200, text: async () => '{}' }; };
    await expect(transcribeAudio(http, cfg, 'zh', new Uint8Array(ASR_MAX_BYTES + 1), 'a.wav', 'audio/wav')).rejects.toThrow('超过常见的 25MB 上限');
    expect(called).toBe(false);
  });
});

describe('选题', () => {
  it('提示词要求只输出 JSON；解析容忍代码块、对象、数组、按行', () => {
    expect(buildTopicMessages('咖啡馆', 3)[0].content).toContain('3 个备选标题');
    expect(parseTopics('```json\n{"titles":["《甲》","乙"]}\n```')).toEqual(['甲', '乙']);
    expect(parseTopics('{"candidates":["甲"]}')).toEqual(['甲']);
    expect(parseTopics('["甲","乙"]')).toEqual(['甲', '乙']);
    expect(parseTopics('1. 甲\n2、乙\n- 丙')).toEqual(['甲', '乙', '丙']);
  });
});

describe('配图', () => {
  const md = '开头\n\n## 一、甲\n\n正文\n\n```\n## 代码里的不算\n```\n\n## 二、**乙**\n\n## 三、丙\n\n## 四、丁';
  it('只认代码块之外的二级标题，行号从 0 开始', () => {
    expect(headings(md)).toEqual([{ line: 2, text: '一、甲' }, { line: 10, text: '二、乙' }, { line: 12, text: '三、丙' }, { line: 14, text: '四、丁' }]);
  });
  it('挑选：数量不够全给，够了均匀挑，0 张不挑', () => {
    expect(pickHeadings(md, 9)).toHaveLength(4);
    expect(pickHeadings(md, 2).map((h) => h.text)).toEqual(['一、甲', '三、丙']);
    expect(pickHeadings(md, 0)).toEqual([]);
    expect(pickHeadings('没有小标题', 3)).toEqual([]);
  });
  it('插入：图片放在标题行后面，多处插入互不错位，路径里的空格和反斜杠被处理', () => {
    const out = insertAfterLines('## A\n正文\n## B\n正文', [{ line: 0, src: 'C:\\图 片\\1.png' }, { line: 2, src: '/tmp/2.png' }]);
    expect(out).toBe('## A\n\n![](C:/%E5%9B%BE%20%E7%89%87/1.png)\n正文\n## B\n\n![](/tmp/2.png)\n正文');
  });
  it('提示词不含文字要求之外的个人信息，并要求画面无文字', () => {
    expect(coverPrompt('标题', '概要')).toContain('「标题」');
    expect(illustrationPrompt('标题', '小节')).toContain('「小节」');
    expect(coverPrompt('t', '')).toContain('不要出现任何文字');
  });
  it('封面裁剪：方图裁成 2.35:1 取中间一条；已经更宽的裁左右', () => {
    expect(coverCropRect(1000, 1000, 2.35)).toEqual({ sx: 0, sy: 287, sw: 1000, sh: 426 });
    expect(coverCropRect(3000, 1000, 2.35)).toEqual({ sx: 325, sy: 0, sw: 2350, sh: 1000 });
  });
});

describe('篇尾二维码', () => {
  it('加在最外层 section 的末尾；没有二维码时原样返回；文字做转义', () => {
    expect(appendFooter('<section><p>x</p></section>', '', '')).toBe('<section><p>x</p></section>');
    const out = appendFooter('<section id="wenyan"><p>x</p></section>\n', '/a b/qr.png', '扫码 <加群>');
    expect(out.startsWith('<section id="wenyan"><p>x</p>')).toBe(true);
    expect(out.trimEnd().endsWith('</section></section>')).toBe(true);
    expect(out).toContain('src="/a b/qr.png"');
    expect(out).toContain('扫码 &lt;加群>');
    expect(appendFooter('<p>x</p>', 'q.png')).toContain('<img src="q.png"');
  });
});
