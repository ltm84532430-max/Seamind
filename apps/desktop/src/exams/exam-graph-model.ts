export interface ExamGraphPosition {
  id: string;
  x: number;
  y: number;
  ring: number;
  order: number;
}

export interface ExamGraphLayout {
  nodes: ExamGraphPosition[];
  radius: number;
  extent: number;
}

const FIRST_RING_CAPACITY = 8;
const RING_CAPACITY_STEP = 6;
const NODE_HALF_WIDTH = 90;

export function layoutExamGraph(ids: readonly string[]): ExamGraphLayout {
  const nodes: ExamGraphPosition[] = [];
  let offset = 0;
  let ring = 0;

  // 根据首环节点数量自适应半径，当只有1~3份试卷时紧凑聚合，避免极端空旷；节点充裕时保持标准轨道步进
  const baseRadius =
    ids.length <= 1 ? 165 : ids.length <= 3 ? 185 : ids.length <= 5 ? 210 : 230;
  const ringStep = 170;

  while (offset < ids.length) {
    const capacity = FIRST_RING_CAPACITY + ring * RING_CAPACITY_STEP;
    const count = Math.min(capacity, ids.length - offset);
    const radius = baseRadius + ring * ringStep;
    for (let index = 0; index < count; index += 1) {
      // 首个节点始终在正上方；稳定排序保证刷新后节点不会无故跳位。
      const angle = (2 * Math.PI * index) / count - Math.PI / 2;
      nodes.push({
        id: ids[offset + index],
        x: Math.round(radius * Math.cos(angle)),
        y: Math.round(radius * Math.sin(angle)),
        ring: ring + 1,
        order: offset + index + 1,
      });
    }
    offset += count;
    ring += 1;
  }
  const radius = nodes.length ? baseRadius + (ring - 1) * ringStep : 0;
  return {
    nodes,
    radius,
    extent: Math.max(160, radius + NODE_HALF_WIDTH + 16),
  };
}
