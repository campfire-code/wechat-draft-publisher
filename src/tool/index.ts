// 工具声明：AI 写稿直发公众号草稿箱（自定义界面：左边写稿，右边公众号样式预览，一键存到草稿箱）。
import { createElement } from 'react';
import { Newspaper } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'w02',
  name: 'AI 写稿直发公众号草稿箱',
  tagline: '输入主题让 AI 写稿（或粘贴已有稿件），可自动配图、加篇尾二维码，用 8 套主题排版后存到公众号草稿箱，先发预览到你的微信、确认后再发布或群发；也能把你自己的口播视频转成 1080×1440 图文卡片存为草稿。全部走公众号官方接口。',
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
