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
const FIRST_RING_RADIUS = 230;
const RING_RADIUS_STEP = 170;
const NODE_HALF_WIDTH = 80;

export function layoutExamGraph(ids: readonly string[]): ExamGraphLayout {
  const nodes: ExamGraphPosition[] = [];
  let offset = 0;
  let ring = 0;
  while (offset < ids.length) {
    const capacity = FIRST_RING_CAPACITY + ring * RING_CAPACITY_STEP;
    const count = Math.min(capacity, ids.length - offset);
    const radius = FIRST_RING_RADIUS + ring * RING_RADIUS_STEP;
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
  const radius = nodes.length
    ? FIRST_RING_RADIUS + (ring - 1) * RING_RADIUS_STEP
    : 0;
  return {
    nodes,
    radius,
    extent: Math.max(170, radius + NODE_HALF_WIDTH + 12),
  };
}
