// 预览 / 群发 / 发布 / 图片消息草稿：请求构造、错误提示、完整调用顺序。不访问网络。
// fixtures：preview-ok、sendall-ok、submit-ok、sendall-no-quota 按微信开发者文档各接口页的返回字段编写（没有真实公众号账号，无法录制）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PIC_MAX_IMAGES, clearTokenCache, clientMsgId, cropPercentList, cutBytes, freePublish, getAccessToken, massSendAll, parseWx, picDraftBody, previewBody, previewUrl,
  savePicDraft, sendAllBody, sendAllUrl, sendPreview, submitBody, submitUrl, type Http, type Img,
} from './wechat';

const fx = (n: string) => readFileSync(join(process.cwd(), 'src/tool/fixtures', n), 'utf8');

describe('请求构造', () => {
  it('接口地址与官方文档一致', () => {
    expect(previewUrl('T')).toBe('https://api.weixin.qq.com/cgi-bin/message/mass/preview?access_token=T');
    expect(sendAllUrl('T')).toBe('https://api.weixin.qq.com/cgi-bin/message/mass/sendall?access_token=T');
    expect(submitUrl('T')).toBe('https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=T');
  });
  it('预览：按微信号（towxname），消息类型 mpnews', () => {
    expect(JSON.parse(previewBody(' my_wx ', 'M1'))).toEqual({ towxname: 'my_wx', msgtype: 'mpnews', mpnews: { media_id: 'M1' } });
  });
  it('群发：发给全部粉丝，带固定的群发 ID（同一份草稿重复点击会被微信拒绝）', () => {
    const b = JSON.parse(sendAllBody('abc-DEF_123456789012345678901234567890'));
    expect(b).toMatchObject({ filter: { is_to_all: true }, msgtype: 'mpnews', mpnews: { media_id: 'abc-DEF_123456789012345678901234567890' }, send_ignore_reprint: 0 });
    expect(b.clientmsgid).toBe(clientMsgId('abc-DEF_123456789012345678901234567890'));
    expect(new TextEncoder().encode(b.clientmsgid).length).toBeLessThanOrEqual(32);
    expect(sendAllBody('X')).toBe(sendAllBody('X'));
  });
  it('发布：只传 media_id', () => {
    expect(JSON.parse(submitBody('M'))).toEqual({ media_id: 'M' });
  });
  it('图片消息草稿：newspic、图片列表、封面裁剪三种比例；标题按 32 字截断；描述按字节截断', () => {
    const b = JSON.parse(picDraftBody({ title: '标'.repeat(40), content: '描'.repeat(300), imageMediaIds: ['a', 'b'], openComment: true })).articles[0];
    expect(b.article_type).toBe('newspic');
    expect(Array.from(b.title as string)).toHaveLength(32);
    expect(new TextEncoder().encode(b.content).length).toBeLessThanOrEqual(600);
    expect(b.image_info.image_list).toEqual([{ image_media_id: 'a' }, { image_media_id: 'b' }]);
    expect(b.need_open_comment).toBe(1);
    expect(b.cover_info.crop_percent_list.map((c: { ratio: string }) => c.ratio)).toEqual(['1_1', '16_9', '2.35_1']);
  });
  it('封面裁剪：3:4 的图裁成 1:1 去掉上下各 12.5%，横向比例同理', () => {
    const [sq, wide] = cropPercentList(1080, 1440);
    expect(sq).toEqual({ ratio: '1_1', x1: '0', y1: '0.125000', x2: '1', y2: '0.875000' });
    expect(wide.y1).toBe('0.289063');
    // 比原图更窄的目标比例才需要裁左右：用一张很宽的图验证
    expect(cropPercentList(2000, 1000)[0]).toEqual({ ratio: '1_1', x1: '0.250000', y1: '0', x2: '0.750000', y2: '1' });
  });
  it('按字节截断不切坏汉字', () => {
    expect(cutBytes('你好世界', 7)).toBe('你好');
    expect(cutBytes('abc', 10)).toBe('abc');
  });
  it('图片消息最多 20 张', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}`);
    expect(JSON.parse(picDraftBody({ title: 't', content: '', imageMediaIds: ids })).articles[0].image_info.image_list).toHaveLength(PIC_MAX_IMAGES);
  });
});

describe('错误提示', () => {
  it('群发次数用完、已接广告、重复群发、系统自动保存的草稿、需要管理员确认', () => {
    expect(() => parseWx(200, fx('sendall-no-quota.json'))).toThrow('群发次数已用完（错误码 45028）');
    expect(() => parseWx(200, '{"errcode":45062,"errmsg":"x"}')).toThrow('不支持用接口群发');
    expect(() => parseWx(200, '{"errcode":45065,"errmsg":"x"}')).toThrow('已经提交过群发');
    expect(() => parseWx(200, '{"errcode":48021,"errmsg":"x"}')).toThrow('系统自动保存');
    expect(() => parseWx(200, '{"errcode":89504,"errmsg":"x"}')).toThrow('管理员');
    expect(() => parseWx(200, '{"errcode":53503,"errmsg":"x"}')).toThrow('发布检查');
  });
});

describe('预览 → 群发 / 发布的调用', () => {
  beforeEach(() => clearTokenCache());
  const png: Img = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]), mime: 'image/png' };
  function fake(files: Record<string, string> = {}) {
    const calls: { url: string; body?: string }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      const f = url.includes('/token?') ? 'token-ok.json' : url.includes('mass/preview') ? 'preview-ok.json' : url.includes('mass/sendall') ? 'sendall-ok.json' : url.includes('freepublish') ? 'submit-ok.json'
        : url.includes('add_material') ? 'add-material-ok.json' : 'draft-add-ok.json';
      return { status: 200, text: async () => files[f] ?? fx(f) };
    };
    return { http, calls };
  }

  it('预览：没填微信号直接提示，不发请求；填了就发 towxname', async () => {
    const { http, calls } = fake();
    await expect(sendPreview(http, 'T', ' ', 'M')).rejects.toThrow('还没有填写预览微信号');
    expect(calls).toHaveLength(0);
    await sendPreview(http, 'T', 'my_wx', 'M');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body!).towxname).toBe('my_wx');
  });
  it('群发：返回任务号；失败时抛出中文错误', async () => {
    expect(await massSendAll(fake().http, 'T', 'M')).toEqual({ msgId: '1000000001', msgDataId: '2247483650' });
    await expect(massSendAll(fake({ 'sendall-ok.json': fx('sendall-no-quota.json') }).http, 'T', 'M')).rejects.toThrow('群发次数已用完');
  });
  it('发布：返回 publish_id', async () => {
    expect(await freePublish(fake().http, 'T', 'M')).toEqual({ publishId: '100000001' });
  });
  it('图片消息：每张图依次上传成永久素材，再新增 newspic 草稿', async () => {
    const { http, calls } = fake();
    const log: string[] = [];
    const r = await savePicDraft({ http, fitImage: async (i) => i, onStep: (t) => log.push(t) }, { appId: 'wxA', appSecret: 'S', title: '标题', content: '引导语', images: [png, png, png], width: 1080, height: 1440 });
    expect(r).toEqual({ mediaId: 'DRAFT_MEDIA_ID', images: 3 });
    expect(calls.map((c) => c.url.split('?')[0].split('/cgi-bin/')[1])).toEqual(['token', 'material/add_material', 'material/add_material', 'material/add_material', 'draft/add']);
    expect(calls[1].url).toContain('type=image');
    const art = JSON.parse(calls[4].body!).articles[0];
    expect(art.image_info.image_list).toHaveLength(3);
    expect(art.image_info.image_list[0].image_media_id).toBe('COVER_MEDIA_ID');
    expect(log).toEqual(['正在连接公众号…', '正在上传图片 1/3…', '正在上传图片 2/3…', '正在上传图片 3/3…', '正在存入草稿箱…']);
  });
  it('图片消息：没有图或超过 20 张时不发请求', async () => {
    const { http, calls } = fake();
    await expect(savePicDraft({ http, fitImage: async (i) => i }, { appId: 'a', appSecret: 's', title: 't', content: '', images: [], width: 1, height: 1 })).rejects.toThrow('没有可上传的图片');
    await expect(savePicDraft({ http, fitImage: async (i) => i }, { appId: 'a', appSecret: 's', title: 't', content: '', images: Array(21).fill(png), width: 1, height: 1 })).rejects.toThrow('最多 20 张');
    expect(calls).toHaveLength(0);
  });
  it('token 缓存沿用：预览和群发之间不会重复取', async () => {
    const { http, calls } = fake();
    const t = await getAccessToken(http, 'wxA', 'S', 0);
    await sendPreview(http, t, 'w', 'M');
    await getAccessToken(http, 'wxA', 'S', 1000);
    expect(calls.filter((c) => c.url.includes('/token?'))).toHaveLength(1);
  });
});
