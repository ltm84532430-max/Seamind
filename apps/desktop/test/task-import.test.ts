import { describe, expect, it } from 'vitest';
import type { LearningPathDetail, LearningPathNode } from '../src/player/types';
import { videoImportCandidate } from '../src/tasks/legacy-import';

const node = (
  nodeId: string,
  overrides: Partial<LearningPathNode> = {},
): LearningPathNode => ({
  nodeId,
  parentId: null,
  position: 0,
  kind: 'checkpoint',
  title: nodeId,
  note: null,
  videoId: null,
  startSeconds: 0,
  optional: false,
  prerequisiteIds: [],
  video: null,
  ...overrides,
});

const detail = (nodes: LearningPathNode[]): LearningPathDetail => ({
  summary: {
    pathId: 'path-1',
    title: 'Course',
    description: null,
    createdAt: 0,
    updatedAt: 0,
    nodeCount: nodes.length,
    videoCount: 1,
    finishedCount: 0,
  },
  nodes,
});

describe('legacy learning path preview', () => {
  it('preserves parent, multiple prerequisites, video timestamp and stable origin keys', () => {
    const input = detail([
      node('stage'),
      node('first', { parentId: 'stage' }),
      node('second', {
        parentId: 'stage',
        prerequisiteIds: ['first', 'stage'],
        optional: true,
        kind: 'video',
        videoId: 'video123456',
        startSeconds: 37,
      }),
    ]);
    const preview = videoImportCandidate(input);
    const again = videoImportCandidate(input);
    const [stage, first, second] = preview.draft.tasks;
    expect(second.parentId).toBe(stage.id);
    expect(second.prerequisiteIds).toEqual([first.id, stage.id]);
    expect(second.optional).toBe(true);
    expect(second.resources[0]).toMatchObject({
      kind: 'youtube',
      resourceId: 'video123456',
      startSeconds: 37,
    });
    expect(preview.key).toBe(again.key);
    expect(preview.draft.tasks.map((item) => item.originKey)).toEqual(
      again.draft.tasks.map((item) => item.originKey),
    );
    expect(input.nodes[2].prerequisiteIds).toEqual(['first', 'stage']);
  });

  it('refuses a path with missing prerequisite instead of silently dropping it', () => {
    expect(() =>
      videoImportCandidate(
        detail([node('item', { prerequisiteIds: ['missing'] })]),
      ),
    ).toThrow();
  });
});
