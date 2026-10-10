/** x' = a·x + c·y, y' = b·x + d·y */
export type Matrix = [number, number, number, number];
/**
 * KLayout's orientation code as a matrix: 0 to 3 are quarter turns
 * anticlockwise, 4 to 7 the same after a mirror at the x axis.
 */
export function orientation(code: number): Matrix {
  const [cos, sin] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ][code % 4] as [number, number];
  return code < 4 ? [cos, sin, -sin, cos] : [cos, sin, sin, -cos];
}
/** The box that a placed cell's own box covers. */
export function placedBox(
  [x0, y0, x1, y1]: readonly number[],
  code: number,
  dx: number,
  dy: number,
): [number, number, number, number] {
  const [a, b, c, d] = orientation(code);
  const xs = [a * x0! + c * y0!, a * x1! + c * y1!];
  const ys = [b * x0! + d * y0!, b * x1! + d * y1!];
  return [
    dx + Math.min(...xs),
    dy + Math.min(...ys),
    dx + Math.max(...xs),
    dy + Math.max(...ys),
  ];
}
/**
 * Mask layers that are not a purpose of a routing or via layer of the
 * technology: a layer file names them `layer.purpose`.
 */
export function besideRouting(
  layers: { name: string; source: string }[],
  routing: string[],
): string[] {
  return layers
    .filter((layer) => !routing.includes(layer.name.split(".")[0]!))
    .map((layer) => layer.source);
}
