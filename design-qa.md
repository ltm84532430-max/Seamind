# Design QA

## Comparison Target

- Source visual truth: `<本机生成图>` (selected first generated design, 1570 x 1002 px).
- Reference context: `<本机截图>`.
- Implementation: SeaMind at `http://127.0.0.1:1420/`, open in the Codex in-app browser.
- Implementation screenshot: captured in the current verification session through the browser preview; it was not saved as a repository artifact.
- Viewport and device scale factor: screenshot dimensions were not recorded, so pixel and CSS dimensions cannot be normalized.
- State observed: dark theme; default “AI 思维导图工作台” Markdown. This content differs from the selected options map, so it is not a same-state comparison.

## Evidence

- The local page loaded and exposed the editor, map canvas, theme toggle, zoom controls, and rendered Markdown nodes in its accessibility tree.
- The desktop production build completed successfully with `corepack pnpm@9.15.9 --filter @markmap/desktop build`.
- The canvas toolbar now exposes a style menu with “灰阶层级”, “暖色分支”, and “结构卡片”.
- Each preset was selected in the local browser preview; the selected style label updated and the map connectors or node cards visibly changed. The preview was returned to “灰阶层级”.
- The original full-view comparison remains blocked because the preview Markdown does not match the selected source map; a same-state comparison is still needed for visual parity.
- The style selector was checked in dark mode, but map folding and inline node editing were not rechecked in this session.

## Findings

- Style-selector behavior passed visual inspection. No full visual-parity pass/fail finding is claimed without a same-state implementation capture; the layout, typography, colors, editing affordances, and folding state still need comparison against the selected source map.

## Comparison History

- Initial implementation: renderer and canvas styling updated; build succeeded. No normalized screenshot evidence was available for iteration.
- Style-switch correction: added three selectable presets and persistence; all three choices were exercised in the local preview and the build succeeded.

## Follow-up Checklist

- Open the same options Markdown structure in the local preview.
- Capture the selected generated design and implementation at matching viewport dimensions and device scale.
- Compare the full canvas and a focused node/connector region.
- Check dark mode, fold/unfold, and inline node editing; record any fixes and recapture.

final result: style selector passed; full reference comparison blocked
