// 抖音分享链接解析。fixtures/douyin-share.html 是按参考页面结构构造的示例页（没有联网录制），
// 所以这里只能验证解析逻辑，真实页面是否仍是这个结构需要用户用自己的链接验证。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractUrl, fetchDouyinVideo, isDouyinUrl, parseRouterData, pickPlayUrl } from './douyin';
import type { Http } from './wechat';

const page = readFileSync(join(process.cwd(), 'src/tool/fixtures/douyin-share.html'), 'utf8');

describe('分享链接', () => {
  it('从分享文案里取出链接，标点不算在链接里', () => {
    expect(extractUrl('0.00 复制此链接，打开Dou音搜索，直接观看视频！ https://v.douyin.com/AbCd123/，')).toBe('https://v.douyin.com/AbCd123/');
    expect(() => extractUrl('没有链接')).toThrow('没有在文字里找到链接');
  });
  it('只接受抖音自己的域名', () => {
    expect(isDouyinUrl('https://v.douyin.com/x/')).toBe(true);
    expect(isDouyinUrl('https://www.iesdouyin.com/share/video/1/')).toBe(true);
    expect(isDouyinUrl('https://douyin.com.evil.example/x')).toBe(false);
    expect(isDouyinUrl('https://example.com/x')).toBe(false);
    expect(isDouyinUrl('not a url')).toBe(false);
  });
});

describe('解析页面', () => {
  it('取到视频信息，播放地址去水印', () => {
    const a = parseRouterData(page);
    expect(a.aweme_id).toBe('7000000000000000001');
    expect(pickPlayUrl(a)).toBe('https://media.example.com/aweme/v1/play/?video_id=v0200&ratio=720p&line=0');
  });
  it('页面没有数据、没有视频、没有播放地址时给出提示', () => {
    expect(() => parseRouterData('<html></html>')).toThrow('没有找到视频信息');
    expect(() => parseRouterData('<script>_ROUTER_DATA = {"loaderData":{}}</script>')).toThrow('没有找到视频');
    expect(() => pickPlayUrl({ video: {} })).toThrow('没有找到视频的播放地址');
  });
});

describe('取视频', () => {
  const video = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  it('打开分享页 → 下载播放地址；手机 UA；步骤提示', async () => {
    const calls: { url: string; ua?: string }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, ua: init?.headers?.['User-Agent'] });
      return url.startsWith('https://v.douyin.com/') ? { status: 200, text: async () => page } : { status: 200, text: async () => '', bytes: async () => video };
    };
    const steps: string[] = [];
    const v = await fetchDouyinVideo(http, '看看 https://v.douyin.com/AbCd123/ 复制', (t) => steps.push(t));
    expect(v).toEqual({ id: '7000000000000000001', desc: '示例口播', bytes: video });
    expect(calls).toHaveLength(2);
    expect(calls[0].ua).toMatch(/iPhone/);
    expect(calls[1].url).toBe('https://media.example.com/aweme/v1/play/?video_id=v0200&ratio=720p&line=0');
    expect(steps).toEqual(['正在打开分享页…', '正在下载视频…']);
  });
  it('不是抖音链接时不发请求；页面或下载失败有中文提示', async () => {
    let n = 0;
    const bad: Http = async () => { n++; return { status: 403, text: async () => '' }; };
    await expect(fetchDouyinVideo(bad, 'https://example.com/a')).rejects.toThrow('这不是抖音的链接');
    expect(n).toBe(0);
    await expect(fetchDouyinVideo(bad, 'https://v.douyin.com/x/')).rejects.toThrow('打开分享页失败（HTTP 403）');
    const noDl: Http = async (url) => (url.includes('v.douyin.com') ? { status: 200, text: async () => page } : { status: 404, text: async () => '' });
    await expect(fetchDouyinVideo(noDl, 'https://v.douyin.com/x/')).rejects.toThrow('下载视频失败（HTTP 404）');
  });
});
