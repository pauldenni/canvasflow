/**
 * Shape outlines for CanvasFlow shape cards.
 *
 * Each shape is drawn for a card's actual width and height (in canvas units),
 * not stretched from a fixed viewBox, so pills stay round-ended, circles
 * become ellipses cleanly and cylinder caps keep their proportions when a
 * card is resized.
 *
 * `insets` say how far the label must sit from each edge (top, right,
 * bottom, left) so the text stays inside the shape.
 */

export type ShapeId =
  | "rectangle" | "ellipse" | "diamond" | "triangle"
  | "terminator" | "cloud" | "star" | "arrow"
  | "parallelogram" | "hexagon" | "octagon" | "double-arrow"
  | "speech" | "cylinder" | "process" | "brace";

export interface ShapeGeometry {
  /** Filled and stroked outline (stroked only when `open`). */
  outline: string;
  /** Extra stroked-only detail lines (cylinder rim, process bars). */
  lines?: string;
  /** True for shapes with no fill, e.g. the brace. */
  open?: boolean;
  /** Label padding: top, right, bottom, left. */
  insets: [number, number, number, number];
}

export interface ShapeDef {
  id: ShapeId;
  label: string;
  size: { width: number; height: number };
  draw: (box: Box) => ShapeGeometry;
}

export interface Box {
  x0: number; y0: number; x1: number; y1: number;
  w: number; h: number; cx: number; cy: number;
  /** Size of one canvas pixel in this drawing: 1 on the canvas, smaller for picker icons. */
  scale: number;
  /** Outline width in canvas pixels. */
  stroke: number;
}

/** Stroke width in canvas units; the outline is inset by half of it. */
export const SHAPE_STROKE = 1;

/**
 * Corner radius matching an Obsidian card (--radius-m, 8px). The outline runs
 * down the middle of the stroke, so its radius is half a stroke smaller to
 * make the outer edge match a card's.
 */
const cardRadius = (b: Box) => Math.max(1, 8 - b.stroke / 2) * b.scale;

const n = (v: number) => (Math.round(v * 100) / 100).toString();
const pt = (x: number, y: number) => `${n(x)} ${n(y)}`;
const poly = (points: Array<[number, number]>) =>
  points.map(([x, y], i) => `${i ? "L" : "M"}${pt(x, y)}`).join(" ") + " Z";

function roundedRect(b: Box, r: number): string {
  const { x0, y0, x1, y1 } = b;
  r = Math.max(0, Math.min(r, b.w / 2, b.h / 2));
  if (r === 0) return poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  return [
    `M${pt(x0 + r, y0)}`, `H${n(x1 - r)}`, `A${n(r)} ${n(r)} 0 0 1 ${pt(x1, y0 + r)}`,
    `V${n(y1 - r)}`, `A${n(r)} ${n(r)} 0 0 1 ${pt(x1 - r, y1)}`,
    `H${n(x0 + r)}`, `A${n(r)} ${n(r)} 0 0 1 ${pt(x0, y1 - r)}`,
    `V${n(y0 + r)}`, `A${n(r)} ${n(r)} 0 0 1 ${pt(x0 + r, y0)}`, "Z",
  ].join(" ");
}

function cloud(b: Box): string {
  const { cx, cy, w, h } = b;
  const perimeter = Math.PI * (3 * (w + h) / 2 - Math.sqrt((3 * w / 2 + h / 2) * (w / 2 + 3 * h / 2)));
  const count = Math.max(7, Math.min(14, Math.round(perimeter / 48)));
  let rx = w / 2 * 0.8;
  let ry = h / 2 * 0.8;

  // Points spaced evenly by distance along the ellipse, so wide clouds get
  // even bumps instead of big ones at the ends.
  const ringPoints = (): Array<[number, number]> => {
    const steps = 360;
    const samples: Array<[number, number]> = [];
    const lengths = [0];
    for (let s = 0; s <= steps; s++) {
      const a = -Math.PI / 2 + (s * 2 * Math.PI) / steps;
      samples.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      if (s) lengths.push(lengths[s - 1] + Math.hypot(samples[s][0] - samples[s - 1][0], samples[s][1] - samples[s - 1][1]));
    }
    const total = lengths[steps];
    const pts: Array<[number, number]> = [];
    let s = 0;
    for (let k = 0; k < count; k++) {
      const target = (total * (k + (k % 2 ? 0.06 : 0))) / count;
      while (s < steps && lengths[s + 1] < target) s++;
      pts.push(samples[s]);
    }
    return pts;
  };

  const build = () => {
    const pts = ringPoints();
    const arcs = pts.map((p, k) => {
      const q = pts[(k + 1) % count];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const chord = Math.hypot(dx, dy);
      const r = chord * (k % 2 ? 0.6 : 0.54);
      const bulge = r - Math.sqrt(Math.max(0, r * r - chord * chord / 4));
      // Outward is to the left of travel (clockwise on screen).
      const peak: [number, number] = [(p[0] + q[0]) / 2 + (dy / chord) * bulge, (p[1] + q[1]) / 2 - (dx / chord) * bulge];
      return { q, r, peak };
    });
    return { pts, arcs };
  };

  // Shrink the ring until every bump fits inside the box.
  let shape = build();
  for (let i = 0; i < 4; i++) {
    const maxX = Math.max(...shape.arcs.map(a => Math.abs(a.peak[0] - cx)));
    const maxY = Math.max(...shape.arcs.map(a => Math.abs(a.peak[1] - cy)));
    rx -= maxX - w / 2;
    ry -= maxY - h / 2;
    shape = build();
  }

  const [start] = shape.pts;
  return `M${pt(start[0], start[1])} ` +
    shape.arcs.map(a => `A${n(a.r)} ${n(a.r)} 0 0 1 ${pt(a.q[0], a.q[1])}`).join(" ") + " Z";
}

function star(b: Box): string {
  // A five-point star whose top point and bottom points touch the box.
  const rx = b.w / (2 * Math.sin((72 * Math.PI) / 180));
  const ry = b.h / (1 + Math.cos((36 * Math.PI) / 180));
  const cy = b.y0 + ry;
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const f = k % 2 ? 0.4 : 1;
    pts.push([b.cx + rx * f * Math.cos(a), cy + ry * f * Math.sin(a)]);
  }
  return poly(pts);
}

export const SHAPES: ShapeDef[] = [
  {
    id: "rectangle", label: "Rectangle", size: { width: 240, height: 120 },
    draw: b => ({ outline: roundedRect(b, cardRadius(b)), insets: [0, 0, 0, 0] }),
  },
  {
    id: "ellipse", label: "Circle", size: { width: 180, height: 180 },
    draw: b => ({
      outline: `M${pt(b.x0, b.cy)} A${n(b.w / 2)} ${n(b.h / 2)} 0 1 1 ${pt(b.x1, b.cy)} A${n(b.w / 2)} ${n(b.h / 2)} 0 1 1 ${pt(b.x0, b.cy)} Z`,
      insets: [b.h * 0.146, b.w * 0.146, b.h * 0.146, b.w * 0.146],
    }),
  },
  {
    id: "diamond", label: "Diamond", size: { width: 200, height: 200 },
    draw: b => ({
      outline: poly([[b.cx, b.y0], [b.x1, b.cy], [b.cx, b.y1], [b.x0, b.cy]]),
      insets: [b.h * 0.25, b.w * 0.25, b.h * 0.25, b.w * 0.25],
    }),
  },
  {
    id: "triangle", label: "Triangle", size: { width: 220, height: 180 },
    draw: b => ({
      outline: poly([[b.cx, b.y0], [b.x1, b.y1], [b.x0, b.y1]]),
      insets: [b.h * 0.45, b.w * 0.27, b.h * 0.04, b.w * 0.27],
    }),
  },
  {
    id: "terminator", label: "Rounded rectangle", size: { width: 240, height: 90 },
    draw: b => {
      const r = Math.min(b.h, b.w) / 2;
      return { outline: roundedRect(b, r), insets: [0, r * 0.4, 0, r * 0.4] };
    },
  },
  {
    id: "cloud", label: "Cloud", size: { width: 260, height: 170 },
    draw: b => ({ outline: cloud(b), insets: [b.h * 0.2, b.w * 0.16, b.h * 0.2, b.w * 0.16] }),
  },
  {
    id: "star", label: "Star", size: { width: 200, height: 190 },
    draw: b => ({ outline: star(b), insets: [b.h * 0.36, b.w * 0.3, b.h * 0.28, b.w * 0.3] }),
  },
  {
    id: "arrow", label: "Arrow", size: { width: 240, height: 120 },
    draw: b => {
      const head = Math.min(b.w * 0.4, b.h * 0.75);
      const shaft = b.h / 4;
      return {
        outline: poly([
          [b.x0, b.cy - shaft], [b.x1 - head, b.cy - shaft], [b.x1 - head, b.y0], [b.x1, b.cy],
          [b.x1 - head, b.y1], [b.x1 - head, b.cy + shaft], [b.x0, b.cy + shaft],
        ]),
        insets: [b.h * 0.25, head * 0.6, b.h * 0.25, 0],
      };
    },
  },
  {
    id: "parallelogram", label: "Parallelogram", size: { width: 240, height: 120 },
    draw: b => {
      const skew = Math.min(b.w * 0.25, b.h * 0.5);
      return {
        outline: poly([[b.x0 + skew, b.y0], [b.x1, b.y0], [b.x1 - skew, b.y1], [b.x0, b.y1]]),
        insets: [0, skew * 0.7, 0, skew * 0.7],
      };
    },
  },
  {
    id: "hexagon", label: "Hexagon", size: { width: 240, height: 130 },
    draw: b => {
      const p = Math.min(b.w * 0.25, b.h * 0.29);
      return {
        outline: poly([[b.x0 + p, b.y0], [b.x1 - p, b.y0], [b.x1, b.cy], [b.x1 - p, b.y1], [b.x0 + p, b.y1], [b.x0, b.cy]]),
        insets: [0, p * 0.8, 0, p * 0.8],
      };
    },
  },
  {
    id: "octagon", label: "Octagon", size: { width: 180, height: 180 },
    draw: b => {
      const c = Math.min(b.w, b.h) * 0.29;
      return {
        outline: poly([
          [b.x0 + c, b.y0], [b.x1 - c, b.y0], [b.x1, b.y0 + c], [b.x1, b.y1 - c],
          [b.x1 - c, b.y1], [b.x0 + c, b.y1], [b.x0, b.y1 - c], [b.x0, b.y0 + c],
        ]),
        insets: [c * 0.3, c * 0.5, c * 0.3, c * 0.5],
      };
    },
  },
  {
    id: "double-arrow", label: "Double arrow", size: { width: 260, height: 120 },
    draw: b => {
      const head = Math.min(b.w * 0.3, b.h * 0.75);
      const shaft = b.h / 4;
      return {
        outline: poly([
          [b.x0, b.cy], [b.x0 + head, b.y0], [b.x0 + head, b.cy - shaft], [b.x1 - head, b.cy - shaft],
          [b.x1 - head, b.y0], [b.x1, b.cy], [b.x1 - head, b.y1], [b.x1 - head, b.cy + shaft],
          [b.x0 + head, b.cy + shaft], [b.x0 + head, b.y1],
        ]),
        insets: [b.h * 0.25, head * 0.6, b.h * 0.25, head * 0.6],
      };
    },
  },
  {
    id: "speech", label: "Speech bubble", size: { width: 240, height: 150 },
    draw: b => {
      const tail = Math.min(b.h * 0.22, 22);
      const yb = b.y1 - tail;
      const r = Math.max(0, Math.min(10, b.w / 4, (yb - b.y0) / 4));
      const xa = b.x0 + b.w * 0.2;
      const xb = xa + Math.min(b.w * 0.14, 24);
      const outline = [
        `M${pt(b.x0 + r, b.y0)}`, `H${n(b.x1 - r)}`, `A${n(r)} ${n(r)} 0 0 1 ${pt(b.x1, b.y0 + r)}`,
        `V${n(yb - r)}`, `A${n(r)} ${n(r)} 0 0 1 ${pt(b.x1 - r, yb)}`,
        `H${n(xb)}`, `L${pt(xa, b.y1)}`, `L${pt(xa, yb)}`,
        `H${n(b.x0 + r)}`, `A${n(r)} ${n(r)} 0 0 1 ${pt(b.x0, yb - r)}`,
        `V${n(b.y0 + r)}`, `A${n(r)} ${n(r)} 0 0 1 ${pt(b.x0 + r, b.y0)}`, "Z",
      ].join(" ");
      return { outline, insets: [0, 0, tail, 0] };
    },
  },
  {
    id: "cylinder", label: "Cylinder", size: { width: 160, height: 190 },
    draw: b => {
      const rx = b.w / 2;
      const ry = Math.min(b.h * 0.14, b.w * 0.2);
      const top = b.y0 + ry;
      const bottom = b.y1 - ry;
      return {
        outline: `M${pt(b.x0, top)} A${n(rx)} ${n(ry)} 0 0 1 ${pt(b.x1, top)} V${n(bottom)} A${n(rx)} ${n(ry)} 0 0 1 ${pt(b.x0, bottom)} Z`,
        lines: `M${pt(b.x0, top)} A${n(rx)} ${n(ry)} 0 0 0 ${pt(b.x1, top)}`,
        insets: [ry * 2, 0, ry * 0.6, 0],
      };
    },
  },
  {
    id: "process", label: "Predefined process", size: { width: 260, height: 120 },
    draw: b => {
      const bar = Math.min(b.w * 0.1, 16);
      return {
        outline: roundedRect(b, cardRadius(b)),
        lines: `M${pt(b.x0 + bar, b.y0)} V${n(b.y1)} M${pt(b.x1 - bar, b.y0)} V${n(b.y1)}`,
        insets: [0, bar + 2, 0, bar + 2],
      };
    },
  },
  {
    id: "brace", label: "Brace note", size: { width: 240, height: 140 },
    draw: b => {
      const bw = Math.min(b.w * 0.12, b.h * 0.25, 22);
      const xm = b.x0 + bw / 2;
      const tip = b.x0 + bw;
      const r = Math.min(bw / 2, b.h / 8);
      return {
        outline: [
          `M${pt(b.x0, b.y0)}`, `C${pt(xm, b.y0)} ${pt(xm, b.y0)} ${pt(xm, b.y0 + r)}`,
          `V${n(b.cy - r)}`, `C${pt(xm, b.cy)} ${pt(xm, b.cy)} ${pt(tip, b.cy)}`,
          `C${pt(xm, b.cy)} ${pt(xm, b.cy)} ${pt(xm, b.cy + r)}`,
          `V${n(b.y1 - r)}`, `C${pt(xm, b.y1)} ${pt(xm, b.y1)} ${pt(b.x0, b.y1)}`,
        ].join(" "),
        open: true,
        insets: [0, 0, 0, bw + 6],
      };
    },
  },
];

export const SHAPES_BY_ID = new Map<string, ShapeDef>(SHAPES.map(s => [s.id, s]));

/** The key on a text card's data that holds its shape id. */
export const SHAPE_KEY = "canvasflowShape";

/**
 * Sides where a shape comes to a point in the middle. A line has to meet
 * these exactly; anywhere else along the side it would stop short of the shape.
 */
export const POINTED_SIDES: Partial<Record<ShapeId, string[]>> = {
  diamond: ["top", "right", "bottom", "left"],
  triangle: ["top"],
  star: ["top"],
  arrow: ["right"],
  "double-arrow": ["left", "right"],
  hexagon: ["left", "right"],
};

/** Draw `shape` for a card `width` x `height`, inset by `inset` on every side. */
export function drawShape(shape: ShapeDef, width: number, height: number, inset = SHAPE_STROKE / 2, scale = 1, stroke = SHAPE_STROKE): ShapeGeometry {
  const x0 = inset;
  const y0 = inset;
  const x1 = Math.max(x0 + 1, width - inset);
  const y1 = Math.max(y0 + 1, height - inset);
  return shape.draw({ x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale, stroke });
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Build an <svg> sized `width` x `height` (user units = pixels) for the shape. */
export function buildShapeSvg(shape: ShapeDef, width: number, height: number, className: string, inset?: number, scale?: number, stroke?: number): SVGSVGElement {
  const geo = drawShape(shape, width, height, inset, scale, stroke);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", `0 0 ${n(width)} ${n(height)}`);
  svg.setAttribute("aria-hidden", "true");

  // Cards are two layers: the box (page background) and the text area over it
  // (the theme's embed background, or a tint for colored cards). The base path
  // is the box; the outline's own fill is the text area.
  if (!geo.open) {
    const base = document.createElementNS(SVG_NS, "path");
    base.setAttribute("class", "canvasflow-shape-base");
    base.setAttribute("d", geo.outline);
    svg.appendChild(base);
  }

  const outline = document.createElementNS(SVG_NS, "path");
  outline.setAttribute("class", geo.open ? "canvasflow-shape-outline is-open" : "canvasflow-shape-outline");
  outline.setAttribute("d", geo.outline);
  svg.appendChild(outline);

  if (geo.lines) {
    const lines = document.createElementNS(SVG_NS, "path");
    lines.setAttribute("class", "canvasflow-shape-lines");
    lines.setAttribute("d", geo.lines);
    svg.appendChild(lines);
  }
  return svg;
}

/** A small icon of the shape, keeping its default proportions. */
export function buildShapeIcon(shape: ShapeDef, box = 26): SVGSVGElement {
  const { width, height } = shape.size;
  const scale = box / Math.max(width, height);
  const w = Math.max(10, width * scale);
  const h = Math.max(10, height * scale);
  const svg = buildShapeSvg(shape, w, h, "canvasflow-shape-icon", 1, scale);
  svg.setAttribute("width", n(w));
  svg.setAttribute("height", n(h));
  return svg;
}
