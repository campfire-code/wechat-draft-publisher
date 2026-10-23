import { describe, expect, it } from 'vitest';
import {
  autoDigest, buildMessages, checkArticle, collectImageSrcs, decodeDataUrl, htmlDocument, imageKind, isWechatImage, localPath, parseArticle, readPrefs,
  replaceImageSrcs, safeFileName, sniffImage, type Prefs,
} from './core';

describe('写稿提示词', () => {
  it('带上主题、篇幅、提纲、资料和输出格式', () => {
    const [sys, user] = buildMessages({ topic: '社区咖啡馆怎么做会员', outline: '1. 为什么\n2. 怎么做', refs: '某店复购率 38%', words: 1500, style: 'story' });
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('标题：<标题>');
    expect(sys.content).toContain('以故事推进');
    expect(user.content).toContain('主题：社区咖啡馆怎么做会员');
    expect(user.content).toContain('约 1500 字');
    expect(user.content).toContain('提纲：\n1. 为什么');
    expect(user.content).toContain('某店复购率 38%');
  });
  it('没有提纲和资料时不出现这两段', () => {
    const [, user] = buildMessages({ topic: 'x', outline: ' ', refs: '', words: 800, style: 'nope' });
    expect(user.content).not.toContain('提纲');
    expect(user.content).not.toContain('参考资料');
  });
});

describe('解析大模型输出', () => {
  it('标准格式', () => {
    const r = parseArticle('标题：社区咖啡馆的会员怎么做\n摘要：三个做法，让熟客每周多来一次。\n正文：\n## 一、先算账\n\n内容一段。');
    expect(r).toEqual({ title: '社区咖啡馆的会员怎么做', digest: '三个做法，让熟客每周多来一次。', markdown: '## 一、先算账\n\n内容一段。' });
  });
  it('代码块包裹、加粗字段名、全角冒号、标题带书名号', () => {
    const r = parseArticle('```markdown\n**标题**：《好标题》\n**摘要**: 摘要文字\n**正文**：\n\n## 小节\n\n正文\n```');
    expect(r.title).toBe('好标题');
    expect(r.digest).toBe('摘要文字');
    expect(r.markdown).toBe('## 小节\n\n正文');
  });
  it('只给了 Markdown：用一级标题当标题，第一段当摘要', () => {
    const r = parseArticle('# 我的标题\n\n第一段文字，**重点**在这里。\n\n## 小节\n\n更多');
    expect(r.title).toBe('我的标题');
    expect(r.markdown.startsWith('第一段文字')).toBe(true);
    expect(r.digest).toBe('第一段文字，重点在这里。');
  });
  it('正文开头重复了标题时去掉', () => {
    const r = parseArticle('标题：重复的标题\n摘要：x\n正文：\n# 重复的标题\n\n正文');
    expect(r.markdown).toBe('正文');
  });
  it('自动摘要跳过小标题和列表，超长截断', () => {
    expect(autoDigest('## 标题\n\n- 列表\n\n' + '字'.repeat(100), 20)).toBe('字'.repeat(19) + '…');
  });
});

describe('存草稿前检查', () => {
  it('字数上限与必填', () => {
    expect(checkArticle({ title: '', author: '', digest: '', markdown: '' })).toEqual(['标题不能为空', '正文不能为空']);
    expect(checkArticle({ title: '标'.repeat(33), author: '作'.repeat(17), digest: '摘'.repeat(121), markdown: 'x' })).toEqual([
      '标题超过 32 个字（现在 33 个）', '作者超过 16 个字', '摘要超过 120 个字（现在 121 个）',
    ]);
    expect(checkArticle({ title: '😀'.repeat(32), author: '', digest: '', markdown: 'x' })).toEqual([]);
  });
});

describe('正文图片', () => {
  const html = '<p><img src="https://a.com/1.png" alt="x"><img alt=\'y\' src=\'/Users/me/2.jpg\'><img src="https://a.com/1.png"><img src="a&amp;b.png"></p>';
  it('取出图片地址（去重、解码实体）', () => {
    expect(collectImageSrcs(html)).toEqual(['https://a.com/1.png', '/Users/me/2.jpg', 'a&b.png']);
  });
  it('替换图片地址，其他保持不变', () => {
    const out = replaceImageSrcs(html, new Map([['https://a.com/1.png', 'https://mmbiz.qpic.cn/1'], ['a&b.png', 'https://x/?a=1&b=2']]));
    expect(out).toBe('<p><img src="https://mmbiz.qpic.cn/1" alt="x"><img alt=\'y\' src=\'/Users/me/2.jpg\'><img src="https://mmbiz.qpic.cn/1"><img src="https://x/?a=1&amp;b=2"></p>');
  });
  it('图片来源分类与本机路径', () => {
    expect(imageKind('https://a.com/x.png')).toBe('remote');
    expect(imageKind('data:image/png;base64,AA==')).toBe('data');
    expect(imageKind('/Users/me/a.png')).toBe('local');
    expect(imageKind('C:\\图片\\a.png')).toBe('local');
    expect(imageKind('file:///C:/a.png')).toBe('local');
    expect(imageKind('images/a.png')).toBe('relative');
    expect(localPath('file:///C:/%E5%9B%BE/a.png')).toBe('C:/图/a.png');
    expect(localPath('file:///Users/me/a%20b.png')).toBe('/Users/me/a b.png');
    expect(isWechatImage('http://mmbiz.qpic.cn/sz_mmbiz_png/x/0')).toBe(true);
    expect(isWechatImage('https://example.com/x.png')).toBe(false);
  });
  it('data: 地址与文件头识别', () => {
    const { bytes, mime } = decodeDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
    expect(mime).toBe('image/png');
    expect(sniffImage(bytes)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(new Uint8Array(4))).toBeNull();
  });
});

describe('导出与偏好', () => {
  it('HTML 文件带编码声明和转义后的标题', () => {
    const doc = htmlDocument('A<B> & C', '<section id="wenyan"></section>');
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain('<title>A&lt;B&gt; &amp; C</title>');
    expect(doc).toContain('<section id="wenyan"></section>');
    expect(safeFileName('a/b:c?')).toBe('a b c');
    expect(safeFileName('  ')).toBe('未命名文章');
  });
  it('偏好兜底', () => {
    const fb: Prefs = { theme: 'default', coverPath: '', article: { title: 'T', author: '', digest: '', markdown: 'M' }, req: { topic: '', outline: '', refs: '', words: 1500, style: 'dry' } };
    expect(readPrefs(null, fb)).toEqual(fb);
    expect(readPrefs({ theme: 'lapis', article: { title: 'X', markdown: 3 } }, fb).article).toEqual({ title: 'X', author: '', digest: '', markdown: 'M' });
  });
});
