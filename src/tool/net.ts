// 桌面端请求函数：Tauri HTTP 插件（没有跨域限制），给 wechat.ts 用
import { httpFetch } from '../kit/platform';
import type { Http } from './wechat';

export const tauriHttp: Http = async (url, init = {}) => {
  const res = await httpFetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body as BodyInit | undefined,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, text: () => res.text() };
};
