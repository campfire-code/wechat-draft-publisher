// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { listThemes, renderWechat } from './render';

describe('公众号排版（wenyan）', () => {
  it('内置主题都有中文名', () => {
    const t = listThemes();
    expect(t.length).toBeGreaterThanOrEqual(8);
    expect(t.find((x) => x.id === 'default')?.name).toBe('默认');
    expect(t.every((x) => x.name)).toBe(true);
  });
  it('Markdown 渲染为内联样式的 HTML，外链转脚注，图片地址保留', async () => {
    const html = await renderWechat('## 小标题\n\n正文**加粗**，见[官网](https://example.com)。\n\n![图](https://example.com/a.png)\n\n```js\nconst a = 1;\n```', 'orangeheart');
    expect(html.startsWith('<section id="wenyan"')).toBe(true);
    expect(html).toMatch(/<h2[^>]*style="[^"]+"/);
    expect(html).toContain('<strong');
    expect(html).toContain('https://example.com/a.png');
    expect(html).toMatch(/参考链接|\[1\]/);
  });
  it('不同主题输出不同样式', async () => {
    const a = await renderWechat('## 标题', 'default');
    const b = await renderWechat('## 标题', 'lapis');
    expect(a).not.toBe(b);
  });
});
