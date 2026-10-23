// @vitest-environment jsdom
// 完整流程（不联网）：模拟大模型输出 → 解析成文章 → 公众号排版 → 存草稿（接口用样例响应）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tool from './index';
import meta from '../../tool.json';
import { buildMessages, checkArticle, parseArticle } from './core';
import { renderWechat } from './render';
import { clearTokenCache, saveDraft, type Http } from './wechat';

const fx = (n: string) => readFileSync(join(process.cwd(), 'src/tool/fixtures', n), 'utf8');

describe('AI 写稿直发公众号草稿箱', () => {
  it('工具声明与 tool.json 一致，需要大模型', () => {
    expect(tool.id).toBe(meta.id);
    expect(tool.name).toBe(meta.name);
    expect(tool.mode).toBe('custom');
    expect(tool.needsLLM).toBe(true);
  });

  it('大模型写稿 → 排版 → 存草稿', async () => {
    const msgs = buildMessages({ topic: '社区咖啡馆怎么做会员', outline: '', refs: '', words: 800, style: 'dry' });
    // 模拟大模型按格式返回（带一张网络图片）
    const reply = '标题：社区咖啡馆的会员怎么做\n摘要：三个做法，让熟客每周多来一次。\n正文：\n## 先算账\n\n一段正文。\n\n![店内](https://example.com/shop.jpg)';
    expect(msgs[1].content).toContain('社区咖啡馆');
    const art = { author: '篝火', ...parseArticle(reply) };
    expect(checkArticle(art)).toEqual([]);
    const html = await renderWechat(art.markdown, 'lapis');

    clearTokenCache();
    const posted: string[] = [];
    const http: Http = async (url, init) => {
      if (url.includes('draft/add')) posted.push(init!.body as string);
      const f = url.includes('/token?') ? 'token-ok.json' : url.includes('uploadimg') ? 'uploadimg-ok.json' : url.includes('add_material') ? 'add-material-ok.json' : 'draft-add-ok.json';
      return { status: 200, text: async () => fx(f) };
    };
    const jpg = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]), mime: 'image/jpeg' };
    const r = await saveDraft({ http, loadImage: async () => jpg, fitImage: async (i) => i, makeCover: async () => jpg }, { appId: 'wxA', appSecret: 'S', ...art, html });
    expect(r.mediaId).toBe('DRAFT_MEDIA_ID');
    const a = JSON.parse(posted[0]).articles[0];
    expect(a).toMatchObject({ title: '社区咖啡馆的会员怎么做', author: '篝火', digest: '三个做法，让熟客每周多来一次。', thumb_media_id: 'COVER_MEDIA_ID' });
    expect(a.content).toContain('<section id="wenyan"');
    expect(a.content).toContain('https://mmbiz.qpic.cn/sz_mmbiz_jpg/SAMPLE/0');
    expect(a.content).not.toContain('example.com/shop.jpg');
  });
});
