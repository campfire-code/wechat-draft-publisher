// 公众号接口：请求构造、错误码翻译、完整存草稿流程。不访问网络。
// fixtures：token-invalid-appid.json、draft-invalid-token.json 是 2026-10-23 用无效 AppID / 无效 token 实际请求微信接口得到的原始响应；
// 成功响应按微信开发者文档各接口页的返回字段编写（没有真实公众号账号，无法录制）；ip-not-in-whitelist.json 的 errmsg 格式未用真实账号复现。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  WxError, addMaterialUrl, buildMultipart, clearTokenCache, draftAddUrl, draftBody, getAccessToken, ipFromErrmsg, parseWx, saveDraft, tokenUrl, uploadImgUrl,
  type Http, type Img, type PublishDeps,
} from './wechat';

const fx = (n: string) => readFileSync(join(process.cwd(), 'src/tool/fixtures', n), 'utf8');

describe('请求构造', () => {
  it('接口地址与官方文档一致', () => {
    expect(tokenUrl('wx123', 'a&b')).toBe('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=wx123&secret=a%26b');
    expect(uploadImgUrl('T')).toBe('https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=T');
    expect(addMaterialUrl('T', 'image')).toBe('https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=T&type=image');
    expect(draftAddUrl('T')).toBe('https://api.weixin.qq.com/cgi-bin/draft/add?access_token=T');
  });
  it('multipart：字段名 media，带文件名与类型', () => {
    const { body, contentType } = buildMultipart(new Uint8Array([1, 2, 3]), 'a.png', 'image/png', 'BOUND');
    expect(contentType).toBe('multipart/form-data; boundary=BOUND');
    const text = new TextDecoder('latin1').decode(body);
    expect(text.startsWith('--BOUND\r\nContent-Disposition: form-data; name="media"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n\x01\x02\x03\r\n--BOUND--\r\n')).toBe(true);
  });
  it('草稿请求体：超长字段按上限截断，空作者和摘要不提交', () => {
    const b = JSON.parse(draftBody({ title: '标'.repeat(40), author: '', digest: '', content: '<p>x</p>', thumbMediaId: 'M' }));
    expect(b.articles).toHaveLength(1);
    const a = b.articles[0];
    expect(Array.from(a.title as string)).toHaveLength(32);
    expect(a).toMatchObject({ article_type: 'news', content: '<p>x</p>', thumb_media_id: 'M', need_open_comment: 0, only_fans_can_comment: 0 });
    expect('author' in a).toBe(false);
    expect('digest' in a).toBe(false);
    const c = JSON.parse(draftBody({ title: 't', author: '作'.repeat(20), digest: '摘'.repeat(130), content: '', thumbMediaId: 'M' })).articles[0];
    expect(Array.from(c.author as string)).toHaveLength(16);
    expect(Array.from(c.digest as string)).toHaveLength(120);
  });
});

describe('错误码翻译', () => {
  it('真实响应：无效 AppID → 40013', () => {
    expect(() => parseWx(200, fx('token-invalid-appid.json'))).toThrow('AppID 不对');
    try { parseWx(200, fx('token-invalid-appid.json')); } catch (e) { expect((e as WxError).code).toBe(40013); }
  });
  it('真实响应：无效 token → 40001，不带 rid 和英文链接', () => {
    expect(() => parseWx(200, fx('draft-invalid-token.json'))).toThrow(/AppSecret 不对.*（错误码 40001）$/);
  });
  it('40164：提示加白名单并带出 IP', () => {
    expect(ipFromErrmsg('invalid ip 203.0.113.7 ipv6 ::ffff:203.0.113.7, not in whitelist')).toBe('203.0.113.7');
    expect(() => parseWx(200, fx('ip-not-in-whitelist.json'))).toThrow(/IP 白名单.*203\.0\.113\.7.*API IP 白名单/);
  });
  it('未收录的错误码原样给出英文说明；非 JSON 给出 HTTP 状态', () => {
    expect(() => parseWx(200, '{"errcode":99999,"errmsg":"something odd rid: x"}')).toThrow('微信接口返回错误 99999：something odd');
    expect(() => parseWx(502, '<html>bad gateway</html>')).toThrow('HTTP 502');
  });
});

describe('存草稿完整流程', () => {
  beforeEach(() => clearTokenCache());
  const png: Img = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]), mime: 'image/png' };

  function fakeHttp(over: Partial<Record<'token' | 'uploadimg' | 'material' | 'draft', string>> = {}) {
    const calls: { url: string; init?: Parameters<Http>[1] }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, init });
      const key = url.includes('/token?') ? 'token' : url.includes('uploadimg') ? 'uploadimg' : url.includes('add_material') ? 'material' : 'draft';
      const file = { token: 'token-ok.json', uploadimg: 'uploadimg-ok.json', material: 'add-material-ok.json', draft: 'draft-add-ok.json' }[key];
      return { status: 200, text: async () => over[key] ?? fx(file) };
    };
    return { http, calls };
  }
  const deps = (http: Http, log: string[] = []): PublishDeps => ({
    http,
    loadImage: async (src) => { if (src.includes('missing')) throw new Error('文件不存在'); return png; },
    fitImage: async (img) => img,
    makeCover: async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]), mime: 'image/jpeg' }),
    onStep: (t) => log.push(t),
  });
  const html = '<section id="wenyan"><p>文字</p><img src="https://example.com/a.png"><img src="/Users/me/b.png"><img src="https://example.com/a.png"><img src="http://mmbiz.qpic.cn/x/0"></section>';

  it('上传正文图片（去重、跳过微信图）→ 封面用第一张图 → 新增草稿，正文图片地址被替换', async () => {
    const { http, calls } = fakeHttp();
    const log: string[] = [];
    const r = await saveDraft(deps(http, log), { appId: 'wxA', appSecret: 'S', title: '标题', author: '篝火', digest: '摘要', html });
    expect(r).toEqual({ mediaId: 'DRAFT_MEDIA_ID', images: 2, coverFrom: 'content' });
    expect(calls.map((c) => c.url.split('?')[0].split('/cgi-bin/')[1])).toEqual(['token', 'media/uploadimg', 'media/uploadimg', 'material/add_material', 'draft/add']);
    expect(calls[1].url).toContain('access_token=ACCESS_TOKEN_SAMPLE');
    expect(calls[1].init!.headers!['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = JSON.parse(calls[4].init!.body as string).articles[0];
    expect(body.thumb_media_id).toBe('COVER_MEDIA_ID');
    expect(body.content).not.toContain('example.com');
    expect(body.content).not.toContain('/Users/me');
    expect(body.content.match(/https:\/\/mmbiz\.qpic\.cn\/sz_mmbiz_jpg\/SAMPLE\/0/g)).toHaveLength(3);
    expect(body.content).toContain('http://mmbiz.qpic.cn/x/0');
    expect(log).toEqual(['正在连接公众号…', '正在上传正文图片 1/2…', '正在上传正文图片 2/2…', '正在上传封面…', '正在存入草稿箱…']);
  });

  it('没有图片也没选封面时自动生成封面；选了封面就用选的', async () => {
    const a = fakeHttp();
    expect((await saveDraft(deps(a.http), { appId: 'wxA', appSecret: 'S', title: 't', author: '', digest: '', html: '<p>x</p>' })).coverFrom).toBe('generated');
    clearTokenCache();
    const b = fakeHttp();
    expect((await saveDraft(deps(b.http), { appId: 'wxA', appSecret: 'S', title: 't', author: '', digest: '', html: '<p>x</p>', cover: png })).coverFrom).toBe('chosen');
  });

  it('IP 不在白名单时在第一步就停下，并给出中文提示', async () => {
    const { http, calls } = fakeHttp({ token: fx('ip-not-in-whitelist.json') });
    await expect(saveDraft(deps(http), { appId: 'wxA', appSecret: 'S', title: 't', author: '', digest: '', html })).rejects.toThrow('IP 白名单');
    expect(calls).toHaveLength(1);
  });

  it('图片读不到时指出是第几张', async () => {
    const { http } = fakeHttp();
    await expect(saveDraft(deps(http), { appId: 'wxA', appSecret: 'S', title: 't', author: '', digest: '', html: '<img src="/missing.png">' })).rejects.toThrow('第 1 张图片读取失败（/missing.png）：文件不存在');
  });

  it('access_token 缓存：两小时内同一个 AppID 只取一次；没填 AppID 直接提示', async () => {
    const { http, calls } = fakeHttp();
    await getAccessToken(http, 'wxA', 'S', 0);
    await getAccessToken(http, 'wxA', 'S', 3_000_000);
    expect(calls).toHaveLength(1);
    await getAccessToken(http, 'wxA', 'S', 7_000_000);
    expect(calls).toHaveLength(2);
    await expect(getAccessToken(http, '', '', 0)).rejects.toThrow('还没有填写公众号 AppID 和 AppSecret');
  });
});
