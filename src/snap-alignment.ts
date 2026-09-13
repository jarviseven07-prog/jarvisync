// 拖动节点时的吸附对齐：节点边缘/中心与其他节点的边缘/中心距离
// 在 SNAP_THRESHOLD 内时自动对齐，并生成对齐参考线位置。
export const SNAP_THRESHOLD = 9;

export type SnapGuide = { x?: number; y?: number };
export type SnapAlignment = {
  guides: SnapGuide[];
  dx: number;
  dy: number;
};

export type SnapNode = {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number } | null;
};

export function collectAlignment(moving: SnapNode, others: SnapNode[]): SnapAlignment {
  const width = moving.measured?.width ?? 0;
  const height = moving.measured?.height ?? 0;
  const moveLeft = moving.position.x;
  const moveTop = moving.position.y;
  const moveCenterX = moveLeft + width / 2;
  const moveCenterY = moveTop + height / 2;

  const xs: Array<{ offset: number; value: number }> = [];
  const ys: Array<{ offset: number; value: number }> = [];
  for (const other of others) {
    if (other.id === moving.id || !other.measured?.width || !other.measured?.height) continue;
    const left = other.position.x;
    const top = other.position.y;
    const right = left + other.measured.width;
    const bottom = top + other.measured.height;
    const centerX = left + other.measured.width / 2;
    const centerY = top + other.measured.height / 2;
    for (const value of [moveLeft, moveCenterX, moveLeft + width]) {
      for (const target of [left, centerX, right]) {
        xs.push({ offset: target - value, value: target });
      }
    }
    for (const value of [moveTop, moveCenterY, moveTop + height]) {
      for (const target of [top, centerY, bottom]) {
        ys.push({ offset: target - value, value: target });
      }
    }
  }

  // 选最多对齐关系共享的偏移；并列时取更近的。参考线取该偏移下的一个对齐位置。
  const pick = (entries: Array<{ offset: number; value: number }>) => {
    let best: number | null = null;
    let bestCount = 0;
    for (const { offset } of entries) {
      if (Math.abs(offset) > SNAP_THRESHOLD) continue;
      const count = entries.filter((item) => Math.abs(item.offset - offset) < 0.5).length;
      if (count > bestCount || (count === bestCount && best !== null && Math.abs(offset) < Math.abs(best))) {
        best = offset;
        bestCount = count;
      }
    }
    return best === null ? null : { offset: best, count: bestCount };
  };

  const x = pick(xs);
  const y = pick(ys);
  const guides: SnapGuide[] = [];
  if (x) {
    const guide = xs.find((item) => Math.abs(item.offset - x.offset) < 0.5);
    if (guide) guides.push({ x: guide.value });
  }
  if (y) {
    const guide = ys.find((item) => Math.abs(item.offset - y.offset) < 0.5);
    if (guide) guides.push({ y: guide.value });
  }
  return { guides, dx: x?.offset ?? 0, dy: y?.offset ?? 0 };
}
