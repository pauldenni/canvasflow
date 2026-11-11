/**
 * Right-angled routing for elbow lines between two cards.
 *
 * Each end leaves its card straight out from its side for a short lead, then
 * we try a handful of simple orthogonal routes between the two lead points
 * and keep the best one: never doubling back on itself, avoiding the two
 * cards, then fewest turns, then shortest.
 */

export type Side = "top" | "bottom" | "left" | "right";
export type Point = { x: number; y: number };
export type Box = { minX: number; minY: number; maxX: number; maxY: number };

export const SIDE_DIR: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * @param start  where the line starts (on the card, or at the arrowhead gap)
 * @param p1     the end of the lead out of the first card
 * @param p2     the end of the lead out of the second card
 * @param end    where the line ends
 */
export function routeElbow(start: Point, p1: Point, p2: Point, end: Point, boxes: Box[]): Point[] {
  const xs = [p1.x, p2.x, (p1.x + p2.x) / 2];
  const ys = [p1.y, p2.y, (p1.y + p2.y) / 2];

  // Clear-of-the-cards lanes, for routes that have to go around.
  const MARGIN = 24;
  for (const box of boxes) {
    xs.push(box.minX - MARGIN, box.maxX + MARGIN);
    ys.push(box.minY - MARGIN, box.maxY + MARGIN);
  }

  const middles: Point[][] = [
    [{ x: p2.x, y: p1.y }],
    [{ x: p1.x, y: p2.y }],
  ];
  for (const x of xs) middles.push([{ x, y: p1.y }, { x, y: p2.y }]);
  for (const y of ys) middles.push([{ x: p1.x, y }, { x: p2.x, y }]);
  // Around a card: out to a lane, across, and back in.
  for (const x of xs) for (const y of ys) {
    middles.push([{ x: p1.x, y }, { x, y }, { x, y: p2.y }]);
    middles.push([{ x, y: p1.y }, { x, y }, { x: p2.x, y }]);
  }

  let best: Point[] | null = null;
  let bestScore: number[] | null = null;
  for (const middle of middles) {
    const points = simplify([start, p1, ...middle, p2, end]);
    const score = scoreRoute(points, boxes);
    if (!bestScore || less(score, bestScore)) {
      best = points;
      bestScore = score;
    }
  }
  return best ?? simplify([start, p1, p2, end]);
}

/** [doubling back, crossing a card, not right-angled, turns, length]; lower is better. */
function scoreRoute(points: Point[], boxes: Box[]): number[] {
  let reversals = 0;
  let crossings = 0;
  let diagonal = 0;
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) diagonal++;
    if (i >= 2) {
      const p = points[i - 2];
      const dot = (a.x - p.x) * (b.x - a.x) + (a.y - p.y) * (b.y - a.y);
      if (dot < -0.01) reversals++;
    }
    // The first and last segments are the leads, which touch the cards by design.
    if (i > 1 && i < points.length - 1) {
      for (const box of boxes) if (crossesBox(a, b, box)) crossings++;
    }
  }
  return [reversals, crossings, diagonal, points.length - 2, length];
}

function less(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 0.01) return a[i] < b[i];
  }
  return false;
}

/** Does an axis-aligned segment pass through the inside of a box? */
function crossesBox(a: Point, b: Point, box: Box): boolean {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  return maxX > box.minX + 1 && minX < box.maxX - 1 && maxY > box.minY + 1 && minY < box.maxY - 1;
}

/** Drop repeated points and points in the middle of a straight run. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    if (out.length >= 2) {
      const prev = out[out.length - 2];
      const sameLine =
        (Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) ||
        (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01);
      const forward = (last.x - prev.x) * (p.x - last.x) + (last.y - prev.y) * (p.y - last.y) >= 0;
      if (sameLine && forward) out.pop();
    }
    out.push(p);
  }
  return out;
}
