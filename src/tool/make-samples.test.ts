// @vitest-environment jsdom
// 生成 samples/ 里的示例文件（只在设置了 MAKE_SAMPLES=1 时运行）
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { htmlDocument } from './core';
import { renderWechat } from './render';
import { SAMPLE, SAMPLE_SCRIPT, SAMPLE_VOICE_TEXT } from './sample';

it.runIf(process.env.MAKE_SAMPLES === '1')('生成示例文件', async () => {
  writeFileSync('samples/示例文章.md', SAMPLE.markdown + '\n');
  writeFileSync('samples/示例写稿要求.txt', '主题：社区咖啡馆怎么做会员\n提纲：\n为什么折扣留不住熟客\n用特权代替折扣\n每周给一个回来的理由\n参考资料：某社区咖啡馆开业半年办了 600 张会员卡，复购率约 12%。\n');
  writeFileSync('samples/示例口播稿.txt', SAMPLE_VOICE_TEXT);
  writeFileSync('samples/示例卡片脚本.json', JSON.stringify(SAMPLE_SCRIPT, null, 2) + '\n');
  writeFileSync('samples/示例导出-默认主题.html', htmlDocument(SAMPLE.title, await renderWechat(SAMPLE.markdown, 'default')));
});
