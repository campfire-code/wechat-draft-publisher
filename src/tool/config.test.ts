import { describe, expect, it } from 'vitest';
import { DEFAULT_CFG, credReady, imageReady, modelReady, readCfg, readCred, validSize } from './config';

describe('设置读取', () => {
  it('空内容用默认值：二次确认默认开启，配图默认关闭', () => {
    const c = readCfg(undefined);
    expect(c).toEqual(DEFAULT_CFG);
    expect(c.confirm).toBe(true);
    expect(c.image.enabled).toBe(false);
    expect(readCfg('乱七八糟').confirm).toBe(true);
  });
  it('只有明确存了 false 才关闭二次确认；类型不对的字段回退默认', () => {
    expect(readCfg({ confirm: false }).confirm).toBe(false);
    expect(readCfg({ confirm: 'no' }).confirm).toBe(true);
    expect(readCfg({ image: { count: 99 } }).image.count).toBe(6);
    expect(readCfg({ image: { count: -3 } }).image.count).toBe(0);
    expect(readCfg({ image: { size: '' } }).image.size).toBe('1024x1024');
  });
  it('旧版本只存了 AppID 和 AppSecret，读出来预览微信号为空', () => {
    expect(readCred({ appId: ' wxA ', appSecret: 'S' })).toEqual({ appId: 'wxA', appSecret: 'S', previewWx: '' });
    expect(readCred(null)).toEqual({ appId: '', appSecret: '', previewWx: '' });
  });
  it('就绪判断', () => {
    expect(credReady({ appId: 'a', appSecret: '', previewWx: '' })).toBe(false);
    expect(modelReady({ baseUrl: 'u', apiKey: 'k', model: ' ' })).toBe(false);
    const c = readCfg({ image: { enabled: true, baseUrl: 'u', apiKey: 'k', model: 'm' } });
    expect(imageReady(c)).toBe(true);
    expect(imageReady({ ...c, image: { ...c.image, enabled: false } })).toBe(false);
  });
  it('图片尺寸格式', () => {
    expect(validSize('1024x1024')).toBe(true);
    expect(validSize(' 1792x1024 ')).toBe(true);
    expect(validSize('big')).toBe(false);
  });
});
