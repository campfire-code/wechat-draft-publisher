// 口播卡片：提示词、脚本解析、折行与排版。字宽用假函数（每个字符宽度等于字号）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_SCRIPT, SAMPLE_VOICE_TEXT } from './sample';
import { CH, CW, SCRIPT, buildProofreadMessages, buildScriptMessages, cardsHtml, checkScript, fitBlock, layoutCards, parseScript, picContent, wrapText, type CardScript, type Measure } from './cards';

const measure: Measure = (size) => (s) => Array.from(s).length * size;
const w10 = (s: string) => Array.from(s).length * 10;

describe('提示词', () => {
  it('校对：只改明显错的，不带任何人名词表', () => {
    const m = buildProofreadMessages('今天天汽不错');
    expect(m[0].content).toContain('只改明显错的');
    expect(m[1].content).toBe('今天天汽不错');
  });
  it('改写：写明张数、标题上限、只输出 JSON', () => {
    const m = buildScriptMessages('原文', 4);
    expect(m[0].content).toContain('共 4 张');
    expect(m[0].content).toContain(`不超过 ${SCRIPT.title} 个字`);
    expect(m[0].content).toContain('只输出 JSON');
    expect(m[1].content).toContain('「原文」');
    expect(buildScriptMessages('x', 99)[0].content).toContain(`共 ${SCRIPT.maxCards} 张`);
  });
});

describe('解析脚本', () => {
  const raw = '{"title":" 标题 ","lead":"引导","cards":[{"headline":"一","body":"甲"},{"headline":"","body":""},{"headline":"二","body":"乙"},{"headline":"三","body":"丙"}]}';
  it('容忍代码块和前后说明；去掉空卡片；超出张数的截掉', () => {
    const s = parseScript('好的，结果如下：\n```json\n' + raw + '\n```', 2);
    expect(s).toEqual({ title: '标题', lead: '引导', cards: [{ headline: '一', body: '甲' }, { headline: '二', body: '乙' }] });
  });
  it('没有 JSON、JSON 坏了、没有卡片都给中文提示', () => {
    expect(() => parseScript('抱歉')).toThrow('没有返回可识别的脚本');
    expect(() => parseScript('{"title":')).toThrow('没有返回可识别的脚本');
    expect(() => parseScript('{"title":"a",}')).toThrow('格式不对');
    expect(() => parseScript('{"title":"a","cards":[]}')).toThrow('没有给出卡片内容');
  });
  it('保存前检查：标题、张数', () => {
    const sc: CardScript = { title: '', lead: '', cards: [] };
    expect(checkScript(sc, 'pic')).toEqual(['标题不能为空', '至少要有一张内容卡片']);
    expect(checkScript({ title: '标'.repeat(33), lead: '', cards: Array(20).fill({ headline: 'a', body: 'b' }) }, 'pic')).toEqual(['标题超过 32 个字（现在 33 个）', '图片消息最多 20 张图，现在有 21 张（含首张）']);
    expect(checkScript({ title: 't', lead: '', cards: [{ headline: 'a', body: 'b' }] }, 'news')).toEqual([]);
  });
  it('图片消息的描述用引导语；图文消息把卡片依次排进正文', () => {
    expect(picContent({ title: '题', lead: '引', cards: [] })).toBe('引');
    expect(picContent({ title: '题', lead: '', cards: [] })).toBe('题');
    const h = cardsHtml(['/a b/1.png', '/c&d/2.png']);
    expect(h.match(/<img/g)).toHaveLength(2);
    expect(h).toContain('src="/c&amp;d/2.png"');
  });
});

describe('折行', () => {
  it('中文逐字折，每行不超过宽度', () => {
    expect(wrapText('一二三四五六七八', 30, w10)).toEqual(['一二三', '四五六', '七八']);
  });
  it('英文单词和数字不拆开', () => {
    expect(wrapText('用Claude写2026年计划', 60, w10)).toEqual(['用', 'Claude', '写2026年', '计划']);
  });
  it('逗号句号不出现在行首：顶到上一行末尾', () => {
    const lines = wrapText('一二三，四五六。', 30, w10);
    expect(lines.every((l) => !/^[，。]/.test(l))).toBe(true);
    expect(lines[0]).toBe('一二三，');
  });
  it('换行符强制换行，末尾空行去掉', () => {
    expect(wrapText('甲\n乙\n\n', 100, w10)).toEqual(['甲', '乙']);
  });
});

describe('排版', () => {
  it('字号：能放下就用最大字号，放不下逐步缩小，缩到最小仍放不下标记 fits=false', () => {
    expect(fitBlock('一二三', measure, true, 200, 96, 2)).toMatchObject({ size: 200, fits: true });
    const r = fitBlock('一'.repeat(30), measure, true, 200, 96, 1);
    expect(r.fits).toBe(false);
    expect(r.size).toBe(96);
  });
  it('一套卡片：首张 + 每个内容卡一张，页码形如 01 / 04', () => {
    const sc: CardScript = { title: '标题', lead: '引导语', cards: [{ headline: '小标题', body: '正文正文' }, { headline: '二', body: '正文' }, { headline: '三', body: '正文' }] };
    const ls = layoutCards(sc, measure);
    expect(ls.map((l) => l.kind)).toEqual(['lead', 'content', 'content', 'content']);
    expect(ls.map((l) => l.page)).toEqual(['01 / 04', '02 / 04', '03 / 04', '04 / 04']);
    expect(ls.every((l) => !l.overflow)).toBe(true);
  });
  it('所有文字都落在画布内；正文太长会缩小字号，实在放不下标记 overflow', () => {
    const long = '很长的正文。'.repeat(33);
    const sc: CardScript = { title: '标题', lead: '引导', cards: [{ headline: '短', body: '一句话' }, { headline: '长', body: long }, { headline: '极长', body: long.repeat(10) }] };
    const [, short, longer, longest] = layoutCards(sc, measure);
    expect(short.body.size).toBe(46);
    expect(longer.body.size).toBeLessThan(46);
    expect(longest.overflow).toBe(true);
    for (const c of [short, longer]) {
      const bottom = c.body.y + c.body.lines.length * c.body.lh;
      expect(bottom).toBeLessThanOrEqual(CH - 200);
      expect(c.body.lines.every((l) => measure(c.body.size, false)(l) <= CW - 220 + c.body.size)).toBe(true);
    }
  });
});

describe('samples 文件', () => {
  const read = (n: string) => readFileSync(join(process.cwd(), 'samples', n), 'utf8').replace(/\r\n/g, '\n');
  it('示例卡片脚本能被解析，且与界面里的示例一致', () => {
    expect(parseScript(read('示例卡片脚本.json'))).toEqual(SAMPLE_SCRIPT);
  });
  it('示例口播稿与代码里的一致，并标明是示例', () => {
    expect(read('示例口播稿.txt')).toBe(SAMPLE_VOICE_TEXT);
    expect(SAMPLE_VOICE_TEXT.startsWith('示例')).toBe(true);
  });
});
