//! The mask view of a GDS: its layers with the layer file's names, colours and
//! patterns, each cell the top cell places flattened into its own coordinates,
//! the placements, the top cell's own shapes and its labels.

use crate::gds::{self, Geometry, Library};
use crate::layer_properties::{self, LayerStyle};
use anyhow::Result;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

#[derive(Serialize)]
pub struct MaskView {
    pub dbu: u32,
    pub top: String,
    #[serde(rename = "box")]
    pub bounds: [i32; 4],
    /// Bottom first.
    pub layers: Vec<MaskLayer>,
    pub cells: Vec<MaskCell>,
    /// cell index, x, y, orientation code
    pub instances: Vec<[i32; 4]>,
    /// The top cell's own shapes, per layer.
    pub shapes: Vec<MaskShapes>,
    pub labels: Vec<Label>,
}
#[derive(Serialize)]
pub struct MaskLayer {
    pub name: String,
    /// GDS `layer/datatype`
    pub source: String,
    pub fill: String,
    pub frame: String,
    pub pattern: Vec<String>,
    pub visible: bool,
    /// The layer's position in the layer file, which shifts its pattern rows.
    pub offset: usize,
}
#[derive(Serialize)]
pub struct MaskCell {
    pub name: String,
    #[serde(rename = "box")]
    pub bounds: [i32; 4],
    /// By layer index.
    pub layers: BTreeMap<String, MaskShapes>,
}
#[derive(Serialize, Default, Clone)]
pub struct MaskShapes {
    /// Flat x0, y0, x1, y1.
    pub boxes: Vec<i32>,
    /// Flat x, y each.
    pub polygons: Vec<Vec<i32>>,
}
/// layer index, x, y, text
#[derive(Serialize)]
pub struct Label(pub usize, pub i32, pub i32, pub String);

pub fn view(gds: &Path, layer_file: &Path) -> Result<MaskView> {
    build(&gds::read(gds)?, &layer_properties::read(layer_file)?)
}

/// A point of a cell where a placement with this orientation code and origin puts it.
fn transform(code: u8, dx: i32, dy: i32, x: i32, y: i32) -> (i32, i32) {
    let (cos, sin) = [(1, 0), (0, 1), (-1, 0), (0, -1)][code as usize % 4];
    if code < 4 {
        (dx + cos * x - sin * y, dy + sin * x + cos * y)
    } else {
        (dx + cos * x + sin * y, dy + sin * x - cos * y)
    }
}
fn transformed_box(code: u8, dx: i32, dy: i32, b: [i32; 4]) -> [i32; 4] {
    let (p, q) = (
        transform(code, dx, dy, b[0], b[1]),
        transform(code, dx, dy, b[2], b[3]),
    );
    [p.0.min(q.0), p.1.min(q.1), p.0.max(q.0), p.1.max(q.1)]
}
fn union(a: Option<[i32; 4]>, b: [i32; 4]) -> Option<[i32; 4]> {
    Some(match a {
        Some(a) => [
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[2].max(b[2]),
            a[3].max(b[3]),
        ],
        None => b,
    })
}
fn polygon_bounds(points: &[i32]) -> [i32; 4] {
    let xs = points.iter().step_by(2);
    let ys = points.iter().skip(1).step_by(2);
    [
        *xs.clone().min().unwrap_or(&0),
        *ys.clone().min().unwrap_or(&0),
        *xs.max().unwrap_or(&0),
        *ys.max().unwrap_or(&0),
    ]
}

/// Shapes by GDS layer.
type ByLayer = HashMap<(u16, u16), MaskShapes>;

/// The shapes of a cell and everything below it, in the cell's coordinates.
fn flatten(library: &Library, cell: usize, code: u8, dx: i32, dy: i32, out: &mut ByLayer) {
    for shape in &library.cells[cell].shapes {
        let layer = out.entry(shape.layer).or_default();
        match &shape.geometry {
            Geometry::Box(b) => layer.boxes.extend(transformed_box(code, dx, dy, *b)),
            Geometry::Polygon(points) => layer.polygons.push(
                points
                    .chunks_exact(2)
                    .flat_map(|p| {
                        let (x, y) = transform(code, dx, dy, p[0], p[1]);
                        [x, y]
                    })
                    .collect(),
            ),
        }
    }
    for placement in &library.cells[cell].placements {
        let (x, y) = transform(code, dx, dy, placement.x, placement.y);
        // Mirror codes compose as KLayout's fixpoint transforms: a mirror flips the turn.
        let composed = if code < 4 {
            (code + placement.orientation % 4) % 4 + placement.orientation / 4 * 4
        } else {
            (4 + code - placement.orientation % 4) % 4 + (1 - placement.orientation / 4) * 4
        };
        flatten(library, placement.cell, composed, x, y, out);
    }
}
fn bounds_of(shapes: &MaskShapes) -> Option<[i32; 4]> {
    let mut b = None;
    for part in shapes.boxes.chunks_exact(4) {
        b = union(b, [part[0], part[1], part[2], part[3]]);
    }
    for polygon in &shapes.polygons {
        b = union(b, polygon_bounds(polygon));
    }
    b
}

fn build(library: &Library, styles: &[LayerStyle]) -> Result<MaskView> {
    let top = &library.cells[library.top];
    // Each cell the top places, flattened once; the placements refer to it by number.
    let mut numbers: HashMap<usize, usize> = HashMap::new();
    let mut flattened: Vec<(usize, ByLayer)> = Vec::new();
    let mut instances = Vec::with_capacity(top.placements.len());
    for placement in &top.placements {
        let number = *numbers.entry(placement.cell).or_insert_with(|| {
            let mut shapes = HashMap::new();
            flatten(library, placement.cell, 0, 0, 0, &mut shapes);
            flattened.push((placement.cell, shapes));
            flattened.len() - 1
        });
        instances.push([
            number as i32,
            placement.x,
            placement.y,
            placement.orientation as i32,
        ]);
    }
    let mut own: ByLayer = HashMap::new();
    for shape in &top.shapes {
        let layer = own.entry(shape.layer).or_default();
        match &shape.geometry {
            Geometry::Box(b) => layer.boxes.extend(b),
            Geometry::Polygon(points) => layer.polygons.push(points.clone()),
        }
    }
    // Layers with anything on them, in the file's order; unlisted ones after, by number.
    let mut used: Vec<(u16, u16)> = own.keys().copied().collect();
    used.extend(top.texts.iter().map(|text| text.layer));
    used.extend(
        flattened
            .iter()
            .flat_map(|(_, shapes)| shapes.keys().copied()),
    );
    used.sort_unstable();
    used.dedup();
    let listed: HashMap<(u16, u16), usize> = styles
        .iter()
        .enumerate()
        .map(|(leaf, style)| ((style.layer, style.datatype), leaf))
        .collect();
    let mut order: Vec<(usize, (u16, u16))> = used
        .iter()
        .map(|&key| (listed.get(&key).copied().unwrap_or(styles.len()), key))
        .collect();
    order.sort();
    let mut index: HashMap<(u16, u16), usize> = HashMap::new();
    let mut layers = Vec::with_capacity(order.len());
    for (leaf, key) in order {
        let style = styles.get(leaf).cloned().unwrap_or_else(|| {
            layer_properties::default_style(key.0, key.1, styles.len() + layers.len())
        });
        index.insert(key, layers.len());
        layers.push(MaskLayer {
            name: style.name,
            source: format!("{}/{}", key.0, key.1),
            fill: style.fill,
            frame: style.frame,
            pattern: style.pattern,
            visible: style.visible,
            offset: if leaf < styles.len() {
                leaf
            } else {
                styles.len() + layers.len()
            },
        });
    }
    let by_layer = |mut shapes: ByLayer| -> BTreeMap<String, MaskShapes> {
        shapes
            .drain()
            .map(|(key, shapes)| (index[&key].to_string(), shapes))
            .collect()
    };
    let mut bounds = None;
    let cells: Vec<MaskCell> = flattened
        .into_iter()
        .map(|(cell, shapes)| {
            let layers = by_layer(shapes);
            let cell_bounds = layers.values().filter_map(bounds_of).fold(None, union);
            MaskCell {
                name: library.cells[cell].name.clone(),
                bounds: cell_bounds.unwrap_or([0; 4]),
                layers,
            }
        })
        .collect();
    for instance in &instances {
        let cell = &cells[instance[0] as usize];
        bounds = union(
            bounds,
            transformed_box(instance[3] as u8, instance[1], instance[2], cell.bounds),
        );
    }
    let mut shapes = vec![MaskShapes::default(); layers.len()];
    for (key, layer_shapes) in own {
        if let Some(b) = bounds_of(&layer_shapes) {
            bounds = union(bounds, b);
        }
        shapes[index[&key]] = layer_shapes;
    }
    let labels = top
        .texts
        .iter()
        .map(|text| Label(index[&text.layer], text.x, text.y, text.string.clone()))
        .collect();
    Ok(MaskView {
        dbu: library.dbu,
        top: top.name.clone(),
        bounds: bounds.unwrap_or([0; 4]),
        layers,
        cells,
        instances,
        shapes,
        labels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gds::tests::{boundary, cell, library, sref};

    #[test]
    fn cells_are_flattened_into_their_own_coordinates_and_layers_follow_the_file() {
        let data = library(&[
            cell(
                "leaf",
                &[
                    boundary(1, 0, &[0, 0, 0, 1, 2, 1, 2, 0]),
                    boundary(5, 0, &[0, 0, 1, 0, 1, 1]),
                ],
            ),
            // The leaf sits in the block turned a quarter and mirrored.
            cell(
                "block",
                &[
                    boundary(2, 0, &[0, 0, 0, 3, 3, 3, 3, 0]),
                    sref("leaf", 10, 10, true, 90.0),
                ],
            ),
            cell(
                "top",
                &[
                    boundary(3, 0, &[0, 0, 0, 100, 100, 100, 100, 0]),
                    sref("block", 20, 30, false, 0.0),
                    sref("block", 50, 30, false, 180.0),
                ],
            ),
        ]);
        let gds = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(gds.path(), data).unwrap();
        let styles = vec![
            LayerStyle {
                layer: 3,
                datatype: 0,
                name: "outline".into(),
                fill: "#111111".into(),
                frame: "#111111".into(),
                pattern: vec!["*".into()],
                visible: true,
            },
            LayerStyle {
                layer: 7,
                datatype: 0,
                name: "unused".into(),
                fill: "#222222".into(),
                frame: "#222222".into(),
                pattern: vec!["*".into()],
                visible: true,
            },
            LayerStyle {
                layer: 1,
                datatype: 0,
                name: "poly".into(),
                fill: "#333333".into(),
                frame: "#333333".into(),
                pattern: vec![".".into()],
                visible: false,
            },
        ];
        let view = build(&gds::read(gds.path()).unwrap(), &styles).unwrap();
        let names: Vec<(&str, &str, usize, bool)> = view
            .layers
            .iter()
            .map(|l| (l.name.as_str(), l.source.as_str(), l.offset, l.visible))
            .collect();
        assert_eq!(
            names,
            vec![
                ("outline", "3/0", 0, true),
                ("poly", "1/0", 2, false),
                ("2/0", "2/0", 5, true),
                ("5/0", "5/0", 6, true)
            ]
        );
        assert_eq!(view.layers[2].fill, "#c080ff");
        assert_eq!(view.cells.len(), 1);
        let block = &view.cells[0];
        assert_eq!(block.name, "block");
        // Mirror at x then a quarter turn: (x, y) -> (y, x) about the origin, placed at 10, 10.
        assert_eq!(block.layers["1"].boxes, vec![10, 10, 11, 12]);
        assert_eq!(
            block.layers["3"].polygons,
            vec![vec![10, 10, 10, 11, 11, 11]]
        );
        assert_eq!(block.layers["2"].boxes, vec![0, 0, 3, 3]);
        assert_eq!(block.bounds, [0, 0, 11, 12]);
        assert_eq!(view.instances, vec![[0, 20, 30, 0], [0, 50, 30, 2]]);
        assert_eq!(view.shapes[0].boxes, vec![0, 0, 100, 100]);
        assert_eq!(view.bounds, [0, 0, 100, 100]);
        assert_eq!(view.top, "top");
        assert_eq!(view.dbu, 1000);
    }

    #[test]
    fn placing_a_placed_cell_composes_orientations() {
        // Every pair of codes, checked against the point transform applied twice.
        for outer in 0..8u8 {
            for inner in 0..8u8 {
                let composed = if outer < 4 {
                    (outer + inner % 4) % 4 + inner / 4 * 4
                } else {
                    (4 + outer - inner % 4) % 4 + (1 - inner / 4) * 4
                };
                let (x, y) = transform(inner, 0, 0, 3, 7);
                assert_eq!(
                    transform(outer, 0, 0, x, y),
                    transform(composed, 0, 0, 3, 7),
                    "{outer} then {inner}"
                );
            }
        }
    }
}
