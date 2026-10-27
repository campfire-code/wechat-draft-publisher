// 反向检查：发布的源码、说明、样例里不能带出写死的密钥、公众号凭据、服务器地址、本机路径、手机号。
// 只用通用模式匹配，不写出任何具体的品牌名或域名。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const toolFiles = walk(join(root, 'src/tool')).filter((f) => /\.(ts|tsx|css|json|html)$/.test(f) && !/\.test\.ts$/.test(f));
const docs = ['README.md', 'CHANGELOG.md', 'THIRD_PARTY_LICENSES.md', 'tool.json', ...walk(join(root, 'samples')).map((f) => f.slice(root.length + 1))].map((f) => join(root, f));
const targets = [...toolFiles, ...docs];

const PATTERNS: [string, RegExp][] = [
  // 203.0.113.x 是文档专用的示例网段（RFC 5737），可以出现
  ['IPv4 地址', /\b(?!203\.0\.113\.)(?:\d{1,3}\.){3}\d{1,3}\b(?!\.\d)/],
  ['sk- 开头的密钥', /\bsk-[A-Za-z0-9]{16,}/],
  ['32 位十六进制串（像 AppSecret）', /\b[0-9a-f]{32}\b/i],
  ['真实 AppID 形态（wx + 16 位非全零十六进制）', /\bwx(?!0{16}\b)[0-9a-f]{16}\b/],
  ['带端口的代理地址', /https?:\/\/[^\s"'`]+:\d{4,5}\//],
  ['个人目录', /\/Users\/[A-Za-z0-9_-]+|[A-Z]:\\Users\\/],
  ['手机号', /\b1[3-9]\d{9}\b/],
  ['Bearer 令牌', /Bearer [A-Za-z0-9_-]{24,}/],
];

describe('不带出个人信息', () => {
  it('有文件可查', () => expect(targets.length).toBeGreaterThan(10));
  for (const [name, re] of PATTERNS) {
    it(`没有${name}`, () => {
      const hits = targets.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
      expect(hits).toEqual([]);
    });
  }
  it('没有自动启动本机命令行的代码（不依赖外部命令行代理或远程网络工具）', () => {
    const hits = toolFiles.filter((f) => /child_process|execSync|spawnSync|ssh\s/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
    expect(hits).toEqual([]);
  });
});
