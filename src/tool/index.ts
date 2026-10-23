// 工具声明：AI 写稿直发公众号草稿箱（自定义界面：左边写稿，右边公众号样式预览，一键存到草稿箱）。
import { createElement } from 'react';
import { Newspaper } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'w02',
  name: 'AI 写稿直发公众号草稿箱',
  tagline: '输入主题和提纲让 AI 写初稿，手动修改后用 8 套公众号主题排版预览，可复制富文本、导出 HTML，或通过公众号官方接口一键存到草稿箱（自动上传正文图片和封面）。',
  category: '微信私域',
  type: 'text',
  mode: 'custom',
  mainLabel: '写稿',
  icon: Newspaper,
  needsLLM: true,
  params: [],
  // 预览页（preview.html）不读本机设置，直接显示示例文章
  Main: () => createElement(Main, { preview: location.pathname.endsWith('preview.html') }),
};

export default tool;
