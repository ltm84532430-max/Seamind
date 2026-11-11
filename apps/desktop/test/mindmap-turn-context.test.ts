import { describe, expect, it } from 'vitest';
import { buildMindmapTurnContext } from '../src/agent/mindmap-context';
import { agentProfiles } from '../src/agent/profiles';

const markdown =
  '# 整张导图\n\n' + '- 节点说明保持完整，不进入本轮摘要。\n'.repeat(80);

describe('mindmap turn context', () => {
  it('sends the target brief and asks for a fresh read', () => {
    const message = buildMindmapTurnContext({
      title: '信号处理',
      revision: 7,
      relativePath: 'notes/signal.md',
      nodeCount: 12,
      truncated: false,
      target: {
        nodeId: 'node-4',
        nodePath: '0.1',
        label: '采样定理',
      },
    });
    expect(message).toContain('mindmap_get_current');
    expect(message).toContain('当前目标优先于历史轮次');
    expect(message).toContain('"revision":7');
    expect(message).toContain('"nodeId":"node-4"');
    expect(message).toContain('"label":"采样定理"');
    expect(message).not.toContain('节点说明保持完整');
    expect(message).not.toContain('<current_mindmap_context>');
    expect(message.length).toBeLessThan(800);
    expect(markdown.length).toBeGreaterThan(message.length);
  });

  it('tells the mindmap profiles to read the map before proposing', () => {
    for (const id of ['drilldown', 'visualization'] as const) {
      expect(agentProfiles[id].systemPrompt).toContain('mindmap_get_current');
    }
    expect(agentProfiles.drilldown.contextOverflowMessage).toContain(
      '已读取的导图',
    );
  });
});
