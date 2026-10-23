// 公众号排版：基于 @wenyan-md/core（Apache-2.0）。Markdown → HTML → 按主题把样式内联到每个元素上，可直接粘贴进公众号编辑器或提交草稿接口。
import { createWenyanCore, getAllGzhThemes, registerAllBuiltInThemes, type WenyanCoreInstance } from '@wenyan-md/core';

/** wenyan 内置公众号主题的中文名（主题 id 来自 wenyan-core 3.x） */
const ZH: Record<string, string> = {
  default: '默认', orangeheart: '橙心', rainbow: '彩虹', lapis: '青金', pie: '少数派风', maize: '麦穗黄', purple: '淡紫', phycat: '薄荷绿',
};

export function listThemes(): { id: string; name: string }[] {
  registerAllBuiltInThemes();
  return getAllGzhThemes().map((t) => ({ id: t.meta.id, name: ZH[t.meta.id] ?? t.meta.appName ?? t.meta.name }));
}

let core: Promise<WenyanCoreInstance> | null = null;

/** 渲染成公众号 HTML（最外层是 <section id="wenyan">，样式全部内联）。需要浏览器 DOM。 */
export async function renderWechat(markdown: string, themeId: string): Promise<string> {
  const c = await (core ??= createWenyanCore({ isConvertMathJax: true, isWechat: true }));
  const el = document.createElement('section');
  el.id = 'wenyan';
  // 第二个参数 true：不渲染 Mermaid 图（避免加载很大的 mermaid 库）
  el.innerHTML = await c.renderMarkdown(markdown, true);
  return c.applyStylesWithTheme(el, { themeId, hlThemeId: 'solarized-light', isMacStyle: true, isAddFootnote: true });
}
