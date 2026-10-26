import { describe, expect, it } from 'vitest';
import {
  buildValidatedLearningPathNodes,
  executeAgentTool,
} from '../src/agent/capabilities';
import type { AgentCapabilities } from '../src/agent/capabilities';
import {
  buildConnectorPath,
  computeLearningPathLayout,
  learningPathToMarkdown,
} from '../src/player/learning-path-layout';
import type {
  LearningPathConnectorStyle,
  LearningPathLayoutMode,
  PositionedPathNode,
} from '../src/player/learning-path-layout';
import type { Overlay } from '../src/player/queue';
import type {
  LearningPathDetail,
  LearningPathNode,
  VideoItem,
} from '../src/player/types';

function makeVideo(
  videoId: string,
  title: string,
  overrides: Partial<VideoItem> = {},
): VideoItem {
  return {
    videoId,
    title,
    channelId: 'UC_TEST',
    channelName: 'Rust Academy',
    durationSeconds: 600,
    publishedText: '2 days ago',
    viewText: '12K views',
    viewCount: 12000,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    isLive: false,
    favorite: false,
    watchLater: false,
    finished: false,
    progressSeconds: null,
    lastWatchedAt: null,
    ...overrides,
  };
}

function makeDiamondDetail(): LearningPathDetail {
  const vIntro = makeVideo('vid_intro01', '1. Ownership Basics');
  const vBorrow = makeVideo('vid_borrw02', '2A. Borrowing & Lifetimes');
  const vTraits = makeVideo('vid_trait03', '2B. Traits & Generics');
  const vBonus = makeVideo('vid_bonus04', 'Bonus: Macros Deep Dive');
  const vAsync = makeVideo('vid_async05', '3. Async Runtime Project');

  const nodes: LearningPathNode[] = [
    {
      nodeId: 'stage-1',
      parentId: null,
      position: 0,
      kind: 'stage',
      title: '阶段一：核心所有权',
      note: '打牢内存模型基础',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: [],
      video: null,
    },
    {
      nodeId: 'n-intro',
      parentId: 'stage-1',
      position: 1,
      kind: 'video',
      title: '所有权与移动语义',
      note: '理解栈与堆',
      videoId: vIntro.videoId,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: [],
      video: vIntro,
    },
    {
      nodeId: 'n-bonus',
      parentId: 'n-intro',
      position: 2,
      kind: 'video',
      title: '声明宏支线拓展',
      note: null,
      videoId: vBonus.videoId,
      startSeconds: 45,
      optional: true,
      prerequisiteIds: ['n-intro'],
      video: vBonus,
    },
    {
      nodeId: 'stage-2',
      parentId: null,
      position: 3,
      kind: 'stage',
      title: '阶段二：并发与抽象',
      note: '双分支并行深入',
      videoId: null,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['n-intro'],
      video: null,
    },
    {
      nodeId: 'n-borrow',
      parentId: 'stage-2',
      position: 4,
      kind: 'video',
      title: '借用检查与生命周期',
      note: null,
      videoId: vBorrow.videoId,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['n-intro'],
      video: vBorrow,
    },
    {
      nodeId: 'n-traits',
      parentId: 'stage-2',
      position: 5,
      kind: 'video',
      title: 'Trait 系统与零成本抽象',
      note: null,
      videoId: vTraits.videoId,
      startSeconds: 0,
      optional: false,
      prerequisiteIds: ['n-intro'],
      video: vTraits,
    },
    {
      nodeId: 'n-async',
      parentId: 'stage-2',
      position: 6,
      kind: 'video',
      title: '手写异步执行器实战',
      note: '汇合两个前置分支',
      videoId: vAsync.videoId,
      startSeconds: 120,
      optional: false,
      prerequisiteIds: ['n-borrow', 'n-traits'],
      video: vAsync,
    },
  ];

  return {
    summary: {
      pathId: 'lp-rust-01',
      title: 'Rust 系统编程进阶路径',
      description: '从所有权到异步运行时的完整视频树',
      nodeCount: nodes.length,
      videoCount: 5,
      finishedCount: 0,
      updatedAt: 1_760_000_000,
    },
    nodes,
  };
}

function boxesOverlap(a: PositionedPathNode, b: PositionedPathNode): boolean {
  const pad = 4;
  return !(
    a.x + a.width + pad <= b.x ||
    b.x + b.width + pad <= a.x ||
    a.y + a.height + pad <= b.y ||
    b.y + b.height + pad <= a.y
  );
}

describe('computeLearningPathLayout', () => {
  const modes: LearningPathLayoutMode[] = ['tree', 'metro', 'dag', 'lanes'];
  const connectors: LearningPathConnectorStyle[] = [
    'curve',
    'orthogonal',
    'metro',
  ];

  it('lays out all 4 layout modes and 3 connector styles without overlapping cards', () => {
    const detail = makeDiamondDetail();

    for (const mode of modes) {
      for (const connector of connectors) {
        const result = computeLearningPathLayout(detail, {}, mode, connector);
        expect(result.nodes).toHaveLength(detail.nodes.length);
        expect(result.width).toBeGreaterThanOrEqual(720);
        expect(result.height).toBeGreaterThanOrEqual(420);
        expect(result.edges.length).toBeGreaterThan(0);

        for (const positioned of result.nodes) {
          expect(Number.isFinite(positioned.x)).toBe(true);
          expect(Number.isFinite(positioned.y)).toBe(true);
          expect(positioned.x).toBeGreaterThanOrEqual(0);
          expect(positioned.y).toBeGreaterThanOrEqual(0);
        }

        for (let i = 0; i < result.nodes.length; i += 1) {
          for (let j = i + 1; j < result.nodes.length; j += 1) {
            expect(
              boxesOverlap(result.nodes[i], result.nodes[j]),
              `cards ${result.nodes[i].node.nodeId} and ${result.nodes[j].node.nodeId} overlapped in ${mode}/${connector}`,
            ).toBe(false);
          }
        }

        for (const edge of result.edges) {
          expect(edge.pathD.startsWith('M ')).toBe(true);
          expect(edge.pathD.includes('NaN')).toBe(false);
        }
      }
    }
  });

  it('places optional lessons on sidings in metro mode and generates lane headers in lanes mode', () => {
    const detail = makeDiamondDetail();

    const metro = computeLearningPathLayout(detail, {}, 'metro', 'metro');
    const bonusMetro = metro.nodes.find((n) => n.node.nodeId === 'n-bonus');
    const introMetro = metro.nodes.find((n) => n.node.nodeId === 'n-intro');
    expect(introMetro?.row).toBe(0);
    expect(bonusMetro?.row).not.toBe(0);
    expect(metro.edges.some((e) => e.kind === 'siding')).toBe(true);

    const lanes = computeLearningPathLayout(detail, {}, 'lanes', 'orthogonal');
    expect(lanes.laneHeaders).toHaveLength(2);
    expect(lanes.laneHeaders[0].title).toBe('阶段一：核心所有权');
    expect(lanes.laneHeaders[1].title).toBe('阶段二：并发与抽象');

    const dag = computeLearningPathLayout(detail, {}, 'dag', 'curve');
    const introDag = dag.nodes.find((n) => n.node.nodeId === 'n-intro')!;
    const borrowDag = dag.nodes.find((n) => n.node.nodeId === 'n-borrow')!;
    const asyncDag = dag.nodes.find((n) => n.node.nodeId === 'n-async')!;
    expect(introDag.x).toBeLessThan(borrowDag.x);
    expect(borrowDag.x).toBeLessThan(asyncDag.x);
  });

  it('computes prerequisite unlock states, progress ratios, and nextUpNodeId dynamically with Overlay', () => {
    const detail = makeDiamondDetail();

    // Initial state: intro is ready & nextUp; downstream nodes with unmet prerequisites are locked
    const initial = computeLearningPathLayout(detail, {}, 'dag', 'curve');
    expect(initial.nextUpNodeId).toBe('n-intro');
    expect(initial.nodes.find((n) => n.node.nodeId === 'n-intro')?.status).toBe(
      'ready',
    );
    expect(
      initial.nodes.find((n) => n.node.nodeId === 'n-borrow')?.status,
    ).toBe('locked');
    expect(initial.nodes.find((n) => n.node.nodeId === 'n-async')?.status).toBe(
      'locked',
    );

    // Partial progress on intro -> status becomes in_progress
    const halfWatched: Overlay = {
      vid_intro01: { progressSeconds: 240, durationSeconds: 600 },
    };
    const mid = computeLearningPathLayout(detail, halfWatched, 'dag', 'curve');
    const introMid = mid.nodes.find((n) => n.node.nodeId === 'n-intro')!;
    expect(introMid.status).toBe('in_progress');
    expect(introMid.progressRatio).toBeCloseTo(0.4, 3);
    expect(mid.nextUpNodeId).toBe('n-intro');

    // Finish intro + borrow, but NOT traits yet -> async capstone must remain locked
    const partialBranchDone: Overlay = {
      vid_intro01: { finished: true },
      vid_borrw02: { finished: true },
    };
    const partial = computeLearningPathLayout(
      detail,
      partialBranchDone,
      'dag',
      'curve',
    );
    expect(partial.nodes.find((n) => n.node.nodeId === 'stage-1')?.status).toBe(
      'completed',
    );
    expect(
      partial.nodes.find((n) => n.node.nodeId === 'n-traits')?.status,
    ).toBe('ready');
    expect(partial.nodes.find((n) => n.node.nodeId === 'n-async')?.status).toBe(
      'locked',
    );
    // Optional bonus is skipped when choosing mandatory nextUpNodeId
    expect(partial.nextUpNodeId).toBe('n-traits');

    // Finish traits too -> diamond converges, async capstone unlocks and becomes nextUp!
    const bothBranchesDone: Overlay = {
      vid_intro01: { finished: true },
      vid_borrw02: { finished: true },
      vid_trait03: { finished: true },
    };
    const converged = computeLearningPathLayout(
      detail,
      bothBranchesDone,
      'dag',
      'curve',
    );
    const asyncNode = converged.nodes.find((n) => n.node.nodeId === 'n-async')!;
    expect(asyncNode.status).toBe('ready');
    expect(converged.nextUpNodeId).toBe('n-async');
  });

  it('builds connector SVG paths for straight, curve, orthogonal, and metro geometries', () => {
    expect(buildConnectorPath(10, 50, 210, 50, 'curve')).toBe(
      'M 10 50 L 210 50',
    );
    expect(buildConnectorPath(10, 50, 260, 180, 'curve')).toContain(' C ');
    expect(buildConnectorPath(10, 50, 260, 180, 'orthogonal')).toContain(' Q ');
    expect(buildConnectorPath(10, 50, 260, 180, 'metro')).toContain(' L ');
  });
});

describe('buildValidatedLearningPathNodes & learningPathToMarkdown', () => {
  it('parses YouTube URLs with timestamps, supports diamond DAGs, and merges append_nodes', () => {
    const created = buildValidatedLearningPathNodes(
      [
        {
          nodeId: 'root-1',
          title: 'Foundation',
          videoUrlOrId: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s',
        },
        {
          nodeId: 'branch-a',
          parentId: 'root-1',
          title: 'Branch A',
          videoUrlOrId: 'https://youtu.be/3JZ_D3ELwOQ?t=30',
        },
        {
          nodeId: 'branch-b',
          parentId: 'root-1',
          title: 'Branch B',
          videoUrlOrId: '9bZkp7q19f0',
          optional: true,
        },
        {
          nodeId: 'capstone',
          parentId: 'branch-a',
          prerequisiteIds: ['branch-a', 'branch-b'],
          title: 'Capstone',
        },
      ],
      null,
      'create',
    );

    expect(created).toHaveLength(4);
    expect(created[0].videoId).toBe('dQw4w9WgXcQ');
    expect(created[0].startSeconds).toBe(95);
    expect(created[1].videoId).toBe('3JZ_D3ELwOQ');
    expect(created[1].startSeconds).toBe(30);
    expect(created[2].videoId).toBe('9bZkp7q19f0');
    expect(created[2].optional).toBe(true);
    expect(created[3].kind).toBe('stage');

    // Test append_nodes against existing detail
    const existingDetail = makeDiamondDetail();
    const appended = buildValidatedLearningPathNodes(
      [
        {
          nodeId: 'n-tokio-prod',
          parentId: 'n-async',
          prerequisiteIds: ['n-async'],
          title: 'Tokio 生产环境调优',
          videoUrlOrId: 'dQw4w9WgXcQ',
        },
      ],
      existingDetail,
      'append_nodes',
    );
    expect(appended).toHaveLength(existingDetail.nodes.length + 1);
    const tail = appended.at(-1)!;
    expect(tail.nodeId).toBe('n-tokio-prod');
    expect(tail.position).toBe(7);
  });

  it('rejects cycles, missing references, duplicate IDs, and invalid YouTube URLs', () => {
    expect(() =>
      buildValidatedLearningPathNodes(
        [
          { nodeId: 'a', title: 'A', prerequisiteIds: ['b'] },
          { nodeId: 'b', title: 'B', prerequisiteIds: ['a'] },
        ],
        null,
        'create',
      ),
    ).toThrow(/循环依赖/);

    expect(() =>
      buildValidatedLearningPathNodes(
        [{ nodeId: 'a', parentId: 'ghost', title: 'A' }],
        null,
        'create',
      ),
    ).toThrow(/不存在的父节点/);

    expect(() =>
      buildValidatedLearningPathNodes(
        [
          { nodeId: 'dup', title: 'One' },
          { nodeId: 'dup', title: 'Two' },
        ],
        null,
        'create',
      ),
    ).toThrow(/重复/);

    expect(() =>
      buildValidatedLearningPathNodes(
        [
          {
            nodeId: 'bad-vid',
            title: 'Bad Link',
            videoUrlOrId: 'https://example.com/not-youtube',
          },
        ],
        null,
        'create',
      ),
    ).toThrow(/不是有效的 YouTube/);
  });

  it('executes learning_path_propose via executeAgentTool and exports structured Markdown', async () => {
    const detail = makeDiamondDetail();
    const md = learningPathToMarkdown(detail);
    expect(md).toContain('# Rust 系统编程进阶路径');
    expect(md).toContain('## 阶段一：核心所有权');
    expect(md).toContain('#### 声明宏支线拓展（选修）');
    expect(md).toContain('https://www.youtube.com/watch?v=vid_bonus04&t=45s');

    const capabilities: AgentCapabilities = {
      getCurrentMindmap: () => {
        throw new Error('unused');
      },
      searchLibrary: async () => [],
      readDocument: async () => {
        throw new Error('unused');
      },
      proposeNodeEdit: () => {
        throw new Error('unused');
      },
      proposeNodeBranch: () => {
        throw new Error('unused');
      },
      searchYouTubeVideos: async (query) => [
        {
          videoId: 'dQw4w9WgXcQ',
          title: `Result for ${query}`,
          channelId: 'UC_TEST',
          channelName: 'Rust Academy',
          durationSeconds: 600,
          viewCount: 12000,
          viewText: '12K views',
          thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
        },
      ],
      listLearningPaths: async () => [detail.summary],
      getLearningPath: async (pathId) =>
        pathId === detail.summary.pathId ? detail : null,
      proposeLearningPath: async (args) => {
        const validated = buildValidatedLearningPathNodes(
          args.nodes,
          null,
          args.mode,
        );
        return {
          mode: args.mode,
          input: {
            pathId: args.pathId,
            title: args.title,
            description: args.description ?? null,
            nodes: validated,
          },
          existingTitle: null,
          existingNodeCount: 0,
          addedNodeCount: validated.length,
          videoCount: validated.filter((n) => Boolean(n.videoId)).length,
          stageCount: validated.filter((n) => !n.videoId).length,
          rationale: args.rationale,
        };
      },
    };

    const searchTrace = await executeAgentTool(
      'player_search_youtube',
      JSON.stringify({ query: 'rust ownership', limit: 3 }),
      capabilities,
    );
    expect(searchTrace.permission).toBe('read');
    expect(
      (searchTrace.result.results as { videoId: string }[])[0].videoId,
    ).toBe('dQw4w9WgXcQ');

    const proposeTrace = await executeAgentTool(
      'learning_path_propose',
      JSON.stringify({
        mode: 'create',
        title: 'Rust 快速入门',
        rationale: '按官方文档顺序递进',
        nodes: [
          {
            nodeId: 'step-1',
            title: 'Ownership Intro',
            videoUrlOrId: 'dQw4w9WgXcQ',
          },
        ],
      }),
      capabilities,
    );
    expect(proposeTrace.permission).toBe('user_approval');
    expect(proposeTrace.learningPathProposal?.videoCount).toBe(1);
    expect(proposeTrace.learningPathProposal?.input.title).toBe(
      'Rust 快速入门',
    );
  });
});
