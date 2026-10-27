// 本机侧的公共依赖：保存生成的图片、存草稿用的图片处理与网络函数。依赖 Tauri 与画布，不做单元测试。
import { defaultOutputDir, ensureDir, fs } from '../kit/platform';
import { extOf } from './core';
import { fitImage, loadImage, makeCover } from './images';
import { tauriHttp } from './net';
import type { PublishDeps } from './wechat';

export const TOOL_NAME = 'AI 写稿直发公众号草稿箱';

/** 生成的图片保存到「下载/工具名/配图」，返回路径 */
export async function saveGenerated(img: { bytes: Uint8Array; mime: string }, name: string): Promise<string> {
  const dir = await fs.join(await defaultOutputDir(TOOL_NAME), '配图');
  await ensureDir(dir);
  const p = await fs.join(dir, `${name}.${extOf(img.mime)}`);
  await fs.writeFile(p, img.bytes);
  return p;
}

export function publishDeps(onStep?: (t: string) => void): PublishDeps {
  return {
    http: tauriHttp, loadImage, fitImage, onStep,
    makeCover: (t) => makeCover(t, getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || undefined),
  };
}

