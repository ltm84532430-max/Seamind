# Pele Mermaid 图表

桌面端支持用 Pele 渲染 Mermaid 语法的 SVG 图表。Pele 图表可在 Markdown 预览和思维导图画布中缩放、平移，并随容器宽度调整布局。

使用 `pele` 代码围栏选择 Pele：

```pele
flowchart LR
  A[开始] --> B[处理] --> C[完成]
```

原有 `mermaid` 代码围栏仍由 Mermaid.js 渲染。Pele 使用自己的布局和视觉样式，支持范围以 Mermaid 12.1.0 内置图表语法为准。Pele 围栏保留 50 KB 源码上限和 SVG 安全过滤；V1 禁止外链、图片和 JavaScript 回调。
