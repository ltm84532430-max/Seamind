const paths = {
  home: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-6h6v6"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 5.5V21m4-13h8m-8 4h6"/>',
  map: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="m7 11 10-5M7 13l10 5"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6m-6 4h6"/>',
  folder: '<path d="M3 7h7l2 2h9v11H3z"/><path d="M3 7V5h7l2 2"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.2"/><path d="m15.5 15.5 5 5"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 2 3 6.5 7 .9-5.1 4.9 1.2 7-6.1-3.3-6.1 3.3 1.2-7L2 9.4l7-.9z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.5 1.5m11.2 11.2 1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  share: '<path d="M12 16V3m-4 4 4-4 4 4M5 13v8h14v-8"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M12 4v16"/>',
  note: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M10 4v16"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14"/>',
  minus: '<path d="M4 12h16"/>',
  zoom: '<path d="M4 9V4h5m6 0h5v5M4 15v5h5m11-5v5h-5"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  close: '<path d="M5 5 19 19M19 5 5 19"/>',
  arrows: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  sparkle: '<path d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5zM19 17v5m-2.5-2.5h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 .5l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7-.5l-2 2a5 5 0 0 0 7 7l1-1"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M3 6h2M3 12h2M3 18h2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const btn = (label, iconName, cls = '') => `<button class="btn ${cls}">${icon(iconName)}${label}</button>`;
const nav = (screen, label, active) => `<button class="workspace-tab ${active === screen ? 'active' : ''}" data-screen="${screen}">${label}</button>`;

function rail(active) {
  return `<aside class="rail">
    <div class="rail-brand" title="Seamind">S</div>
    <button class="rail-button ${active === 'home' ? 'active' : ''}" data-screen="knowledge-home" title="知识库">${icon('home')}</button>
    <button class="rail-button ${active === 'map' ? 'active' : ''}" data-screen="mindmap-overview" title="思维导图">${icon('map')}</button>
    <button class="rail-button" title="收藏">${icon('star')}</button>
    <div class="rail-spacer"></div><button class="rail-button" title="设置">${icon('settings')}</button><div class="rail-avatar">L</div>
  </aside>`;
}

function topbar(screen) {
  const active = screen.startsWith('mindmap') ? 'map' : 'knowledge';
  return `<header class="topbar"><div class="brand-name">seamind</div>
    <nav class="workspace-tabs">${nav('knowledge-home', '知识库', active === 'knowledge' ? 'knowledge-home' : '')}${nav('mindmap-overview', '思维导图', active === 'map' ? 'mindmap-overview' : '')}</nav>
    <div class="topbar-spacer"></div><div class="global-search">${icon('search', 'sm')} 搜索文档、导图与标签 <kbd>Ctrl K</kbd></div>
    <button class="top-icon" title="通知">${icon('sparkle')}</button><div class="top-avatar">L</div></header>`;
}

function sideItem(label, ico, cls = '', count = '') {
  return `<button class="side-item ${cls}">${icon(ico, 'sm')}<span>${label}</span>${count ? `<span class="side-count">${count}</span>` : ''}</button>`;
}

function sidebar(screen) {
  const isMap = screen.startsWith('mindmap');
  return `<aside class="sidebar"><div class="side-top"><div class="side-title-row"><strong>${isMap ? '思维导图' : '知识库'}</strong><button class="plain-icon" title="新建">${icon('plus', 'sm')}</button></div><div class="side-search">${icon('search', 'sm')} 搜索${isMap ? '导图' : '标题、内容、标签'}…</div></div>
    <div class="side-scroll"><div class="side-section-title">快捷访问</div>
    ${sideItem('全部内容', 'home', !isMap && screen === 'knowledge-home' ? 'active' : '', '56')}
    ${sideItem('最近打开', 'clock', '', '12')}${sideItem('收藏', 'star', '', '8')}
    <div class="side-divider"></div><div class="side-section-title">我的空间 <span>＋</span></div>
    ${sideItem('高频交易项目', 'folder', '', '18')}${sideItem('订单流', 'folder', 'indent', '7')}
    ${sideItem('量化系统', 'file', 'deep', '2')}
    ${sideItem('普通思维导图', 'folder', '', '8')}
    ${sideItem('数据获取', 'map', `indent ${isMap ? 'active' : ''}`)}
    ${sideItem('深度解析计算机网络', 'map', 'indent')}
    ${sideItem('通信原理', 'map', 'indent')}
    ${sideItem('未分类', 'folder', '', '2')}
    </div><div class="side-bottom">${icon('folder', 'sm')} <b>books</b> · 本地工作区 ${icon('chevron', 'sm')}</div></aside>`;
}

function shell(screen, content) {
  const active = screen.startsWith('mindmap') ? 'map' : 'home';
  return `<div class="app">${rail(active)}${topbar(screen)}${sidebar(screen)}<main class="main">${content}</main></div>`;
}

function pageBar(crumb, actions = '') {
  return `<div class="page-bar"><div class="breadcrumbs"><span>我的空间</span><span class="crumb-sep">/</span><strong>${crumb}</strong></div><div class="bar-spacer"></div>${actions}</div>`;
}

function docRow(name, kind, folder, time, map = false) {
  return `<div class="doc-row"><div class="doc-name">${icon(map ? 'map' : 'file', 'sm')}<span>${name}</span></div><span class="doc-meta-kind ${map ? 'map' : ''}">${kind}</span><span>${folder}</span><span>${time}</span></div>`;
}

function knowledgeHome() {
  const content = `${pageBar('知识库', `<span class="save-state"><i></i> 本地内容已同步</span>`)}
  <div class="home-content"><div class="home-inner">
    <div class="home-head"><div><div class="eyebrow">YOUR LIBRARY</div><h1>把想法整理成自己的知识</h1><p>从文档到导图，继续你的思考。</p></div><div class="home-actions">${btn('导入文件', 'share')}${btn('新建文档', 'plus', 'primary')}</div></div>
    <div class="home-summary"><div class="summary-cell"><div class="summary-icon">${icon('file')}</div><div><small>文档</small><strong>39</strong></div></div><div class="summary-cell"><div class="summary-icon orange">${icon('map')}</div><div><small>思维导图</small><strong>17</strong></div></div><div class="summary-cell"><div class="summary-icon blue">${icon('folder')}</div><div><small>知识分类</small><strong>6</strong></div></div></div>
    <div class="home-grid"><section class="section-card"><div class="section-head"><h2>继续阅读</h2><button class="text-link" data-screen="knowledge-document">查看全部 →</button></div>
      <div class="doc-table-head"><span>名称</span><span>类型</span><span>位置</span><span>最近编辑</span></div>
      ${docRow('数据获取', '思维导图', '普通思维导图', '18 分钟前', true)}
      ${docRow('量化系统：数据处理与策略验证', 'Markdown', '订单流', '2 天前')}
      ${docRow('计算机网络全链路进阶规划', 'Markdown', '学习路径', '11 月 06 日')}
      ${docRow('通信原理', '思维导图', '普通思维导图', '10 月 17 日', true)}
      ${docRow('多元微积分：曲面与梯度', 'Markdown', '未分类', '10 月 17 日')}
      ${docRow('订单流数据源整理', 'Markdown', '订单流', '10 月 15 日')}
    </section><div class="side-stack"><section class="section-card"><div class="section-head"><h2>常用分类</h2><button class="text-link">管理分类 →</button></div><div class="collection-list">
      <div class="collection-row"><div class="collection-marker">${icon('folder', 'sm')}</div><div><strong>高频交易项目</strong><small>18 篇内容 · 最近更新 2 天前</small></div>${icon('chevron', 'sm')}</div>
      <div class="collection-row"><div class="collection-marker">${icon('folder', 'sm')}</div><div><strong>普通思维导图</strong><small>8 张导图 · 最近更新 18 分钟前</small></div>${icon('chevron', 'sm')}</div>
      <div class="collection-row"><div class="collection-marker">${icon('folder', 'sm')}</div><div><strong>学习路径</strong><small>5 篇内容 · 最近更新 11 月 06 日</small></div>${icon('chevron', 'sm')}</div>
    </div></section><section class="section-card"><div class="section-head"><h2>快速开始</h2><button class="text-link">所有模板 →</button></div><div class="template-grid"><div class="template-tile">${icon('note', 'sm')}<strong>空白笔记</strong></div><div class="template-tile">${icon('map', 'sm')}<strong>思维导图</strong></div><div class="template-tile">${icon('list', 'sm')}<strong>学习大纲</strong></div><div class="template-tile">${icon('grid', 'sm')}<strong>项目复盘</strong></div></div></section></div></div>
    <p class="home-footnote">最近内容来自本地工作区 · 所有文件保留在你的设备中</p>
  </div></div>`;
  return shell('knowledge-home', content);
}

function readingOne() {
  return `<article class="reading"><div class="doc-path">高频交易项目 / 订单流</div><h1>量化系统：数据处理与策略验证</h1><div class="doc-subtitle"><span>2026 年 11 月 20 日更新</span><span>·</span><span>约 6 分钟阅读</span><span class="pill green">#研究笔记</span></div>
    <p>建立可复现的研究流程，先确认数据来源，再统一清洗口径与回测边界。每一步都留下可追溯的记录。</p>
    <h2>01 / 数据流转</h2><div class="flow"><div class="flow-step">${icon('share', 'sm')}采集</div><div class="flow-arrow">→</div><div class="flow-step">${icon('table', 'sm')}清洗</div><div class="flow-arrow">→</div><div class="flow-step">${icon('code', 'sm')}验证</div></div>
    <h2>02 / 处理原则</h2><ul><li>原始数据与派生字段分离存储，保留来源和时间戳。</li><li>缺失值、异常值和交易时段过滤规则显式记录。</li><li>结果按数据版本、策略版本与运行环境归档。</li></ul>
    <div class="callout">关联导图：<strong>数据获取</strong> · 从研究笔记打开对应的获取流程。</div>
    <h2>03 / 验证清单</h2><p>重点核对时序穿越、样本外结果和交易成本假设。对关键指标保留计算公式与原始证据。</p></article>`;
}

function readingTwo() {
  return `<article class="reading"><div class="doc-path">高频交易项目 / 订单流</div><h1>订单流数据源整理</h1><div class="doc-subtitle"><span>2026 年 11 月 18 日更新</span><span>·</span><span>约 4 分钟阅读</span><span class="pill orange">#数据源</span></div>
    <p>将行情、逐笔和事件数据放在同一张清单中，方便比较覆盖范围、更新频率与可追溯性。</p>
    <h2>数据源对照</h2><table class="small-table"><thead><tr><th>类型</th><th>主要用途</th><th>检查点</th></tr></thead><tbody><tr><td>实时行情</td><td>盘中观察</td><td>断线补传</td></tr><tr><td>历史逐笔</td><td>复盘与回测</td><td>时间对齐</td></tr><tr><td>事件信息</td><td>上下文标注</td><td>来源校验</td></tr></tbody></table>
    <h2>整理方式</h2><ul><li>每个来源建立独立记录，附带采集时间和授权说明。</li><li>对同一指标保留原始值、清洗值和转换规则。</li><li>用导图连接数据入口、处理脚本和研究结论。</li></ul>
    <div class="doc-related"><strong>相关内容</strong><span>数据获取 · 通信原理 · 量化系统</span></div></article>`;
}

function knowledgeDocument() {
  const content = `${pageBar('量化系统：数据处理与策略验证', `<span class="save-state"><i></i> 已保存</span>${btn('在导图中查看', 'map')}${btn('分享', 'share')}`)}
    <div class="doc-tabstrip"><div class="doc-tab active">${icon('file')}量化系统${icon('close', 'close')}</div><div class="doc-tab">${icon('file')}订单流数据源整理${icon('close', 'close')}</div>
    <div class="doc-layout"><button class="layout-control">${icon('sidebar', 'sm')}单页</button><button class="layout-control active">${icon('layout', 'sm')}左右分栏</button><button class="layout-control">${icon('panel', 'sm')}上下分栏</button></div></div>
    <div class="split-stage"><section class="doc-pane"><div class="pane-head">${icon('file', 'sm')}<strong>量化系统：数据处理与策略验证</strong><div class="pane-actions"><div class="mode-switch"><span>编辑</span><span class="active">阅读</span></div><button class="plain-icon">${icon('more', 'sm')}</button></div></div><div class="reading-scroll">${readingOne()}</div></section>
    <section class="doc-pane"><div class="pane-head">${icon('file', 'sm')}<strong>订单流数据源整理</strong><div class="pane-actions"><div class="mode-switch"><span>编辑</span><span class="active">阅读</span></div><button class="plain-icon">${icon('more', 'sm')}</button></div></div><div class="reading-scroll">${readingTwo()}</div></section></div>`;
  return shell('knowledge-document', content);
}

function canvasControls(edit = false) {
  return `<div class="canvas-controls"><button>${icon('minus', 'sm')}</button><span class="zoom-readout">${edit ? '88%' : '100%'}</span><button>${icon('plus', 'sm')}</button><span class="divider"></span><button>${icon('zoom', 'sm')}适应画布</button><span class="divider"></span><button class="${edit ? '' : 'active'}">${icon('map', 'sm')}导图</button><button>${icon('list', 'sm')}大纲</button></div>`;
}

function mapHeader(edit = false) {
  return `<div class="map-topline"><div class="map-title-wrap"><h1>数据获取</h1><span>普通思维导图 · 64 个节点 · 刚刚更新</span></div><div class="bar-spacer"></div>
    <div class="map-toolbar-segment"><span class="${edit ? '' : 'active'}" data-screen="mindmap-overview">浏览</span><span class="${edit ? 'active' : ''}" data-screen="mindmap-edit">编辑</span></div>
    ${btn('主题与样式', 'sparkle')}${btn('导出 HTML', 'share', 'primary')}</div>`;
}

function mapOverview() {
  const content = `${pageBar('数据获取', `<span class="save-state"><i></i> 已保存</span>${btn('返回知识库', 'book', 'quiet')}`)}
  <div class="map-page">${mapHeader()}<div class="map-canvas">
    <svg class="map-wires" viewBox="0 0 1000 700" preserveAspectRatio="none" aria-hidden="true">
      <path d="M185 340 C270 340 270 160 350 160 M185 340 C270 340 270 345 350 345 M185 340 C270 340 270 525 350 525"/>
      <path d="M495 160 C555 160 555 115 625 115 M495 160 C555 160 555 188 625 188"/>
      <path class="orange" d="M495 345 C555 345 555 310 625 310 M495 345 C555 345 555 382 625 382"/>
      <path class="blue" d="M495 525 C555 525 555 500 625 500 M495 525 C555 525 555 570 625 570"/>
    </svg>
    <div class="map-node root">数据获取</div>
    <div class="map-node branch one">天勤量化 <span class="count">4</span></div>
    <div class="map-node branch two orange">数据来源 <span class="count">3</span></div>
    <div class="map-node branch three blue">工具整理 <span class="count">5</span></div>
    <div class="map-node leaf l1">${icon('file')}行情数据接口</div><div class="map-node leaf l2">${icon('code')}订阅与回测</div>
    <div class="map-node leaf l3 selected">${icon('note')}历史数据清单 <span class="pill green">备注</span></div>
    <div class="map-node leaf l4">${icon('table')}字段对照表 <span class="pill">表格</span></div>
    <div class="map-node leaf l5">${icon('code')}数据清洗脚本</div><div class="map-node leaf l6">${icon('image')}流程截图 <span class="pill">图片</span></div>
    <div class="map-content-preview"><strong>字段对照表 · 节点预览</strong><div class="preview-table">${'<span></span>'.repeat(9)}</div><div class="preview-lines"></div><div class="preview-lines short"></div></div>
    <div class="canvas-hint">拖动画布 · 滚轮缩放 · 双击节点展开</div>${canvasControls()}<div class="map-minimap"></div>
  </div></div>`;
  return shell('mindmap-overview', content);
}

function sourceLines() {
  const lines = [
    ['#', '数据获取'], ['##', '天勤量化'], ['###', '行情数据接口'], ['###', '订阅与回测'],
    ['##', '数据来源'], ['###', '历史数据清单'], ['-', '价格、成交与订单流'], ['###', '字段对照表'],
    ['##', '工具整理'], ['###', '数据清洗脚本'], ['###', '流程截图'],
  ];
  return lines.map(([mark, line], i) => `<div class="line ${i === 5 ? 'selected-line' : ''}"><span class="num">${i + 1}</span><span><span class="hash">${mark}</span> ${line}</span></div>`).join('');
}

function mapEditing() {
  const content = `${pageBar('数据获取', `<span class="save-state"><i></i> 自动保存</span>${btn('预览', 'zoom')}`)}
  <div class="map-page">${mapHeader(true)}<div class="editing-stage">
    <section class="source-panel"><div class="source-head">${icon('code', 'sm')}<strong>Markdown 源码</strong><small>第 6 行 / 11 行</small></div><div class="source-editor">${sourceLines()}</div></section>
    <div class="edit-canvas"><svg class="edit-wires" viewBox="0 0 600 700" preserveAspectRatio="none"><path d="M110 340 C170 340 170 200 260 200 M110 340 C170 340 170 350 260 350 M110 340 C170 340 170 510 260 510 M340 350 C370 350 370 305 440 305 M340 350 C370 350 370 390 440 390"/></svg>
      <div class="edit-node root">数据获取</div><div class="edit-node branch-a">天勤量化</div><div class="edit-node branch-b">数据来源</div><div class="edit-node branch-c">工具整理</div><div class="edit-node child-a selected">${icon('note')}历史数据清单</div><div class="edit-node child-b">${icon('table')}字段对照表</div>
      <div class="canvas-hint">源代码和节点位置同步定位</div>${canvasControls(true)}
    </div>
    <aside class="inspector"><div class="inspector-head"><strong>节点详情</strong><button class="plain-icon">${icon('close', 'sm')}</button></div><div class="inspector-tabs"><span class="active">内容</span><span>样式</span><span>关系</span></div>
      <div class="inspector-body"><label class="inspector-label">节点标题</label><div class="field">历史数据清单</div>
        <div class="inspect-block"><label class="inspector-label">Markdown 备注</label><div class="inspect-note">梳理价格、成交与订单流数据的字段，记录来源、更新周期与质量检查规则。</div></div>
        <div class="inspect-block"><label class="inspector-label">附加内容</label><div class="attachment">${icon('table', 'sm')} 字段对照表.xlsx ${icon('chevron', 'sm')}</div></div>
        <div class="inspect-block"><label class="inspector-label">添加到节点</label><div class="quick-actions"><div class="quick-action">${icon('note', 'sm')}备注</div><div class="quick-action">${icon('image', 'sm')}图片</div><div class="quick-action">${icon('code', 'sm')}代码</div></div></div>
        <div class="inspect-block"><label class="inspector-label">关联</label><div class="attachment">${icon('link', 'sm')} 订单流数据源整理 ${icon('chevron', 'sm')}</div></div>
      </div><div class="inspector-foot">${btn('折叠子节点', 'minus')}${btn('添加子节点', 'plus', 'primary')}</div></aside>
  </div></div>`;
  return shell('mindmap-edit', content);
}

const screens = {
  'knowledge-home': knowledgeHome,
  'knowledge-document': knowledgeDocument,
  'mindmap-overview': mapOverview,
  'mindmap-edit': mapEditing,
};
function render(screen = 'knowledge-home') {
  const selected = screens[screen] ? screen : 'knowledge-home';
  document.getElementById('app').innerHTML = screens[selected]();
  document.querySelectorAll('[data-screen]').forEach((target) => target.addEventListener('click', () => {
    const next = target.dataset.screen;
    history.replaceState(null, '', `?screen=${next}`);
    render(next);
  }));
}
render(new URLSearchParams(location.search).get('screen'));
