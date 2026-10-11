//! The 3D view of a GDS: the materials of the PDK's 2.5D stack script with
//! their slabs, each cell the top cell places with its shapes evaluated per
//! slab, the placements and the top cell's own shapes. A boolean between
//! layers is evaluated within one cell or within the top cell, never across
//! the hierarchy: a contact in a cell over poly of another cell is not split,
//! which the place-and-route cells of the supported PDKs never need. A region
//! clips the top cell's shapes and keeps the cells placed in it whole.

use crate::gds::{self, Geometry, Library};
use crate::layer_properties::{self, LayerStyle};
use crate::layer_stack::{self, Expr, Material};
use crate::masks::{self, ByLayer, Flattened, MaskShapes};
use anyhow::{bail, Result};
use i_overlay::core::{fill_rule::FillRule, overlay::Overlay, overlay_rule::OverlayRule};
use i_overlay::i_float::int::point::IntPoint;
use i_overlay::i_shape::int::shape::IntShapes;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

#[derive(Serialize, Debug)]
pub struct SolidView {
    pub dbu: u32,
    pub top: String,
    #[serde(rename = "box")]
    pub bounds: [i32; 4],
    /// In script order.
    pub materials: Vec<SolidMaterial>,
    pub slabs: Vec<Slab>,
    pub cells: Vec<SolidCell>,
    /// cell index, x, y, orientation code
    pub instances: Vec<[i32; 4]>,
    /// The top cell's own shapes, per slab.
    pub shapes: Vec<SolidShapes>,
}
#[derive(Serialize, Debug)]
pub struct SolidMaterial {
    pub name: String,
    /// `#rrggbb`
    pub fill: String,
    /// GDS `layer/datatype` when the material shows one layer.
    pub source: Option<String>,
}
/// Shapes of a material between two heights in µm.
#[derive(Serialize, Debug)]
pub struct Slab {
    pub material: usize,
    pub zstart: f64,
    pub zstop: f64,
}
#[derive(Serialize, Debug)]
pub struct SolidCell {
    pub name: String,
    #[serde(rename = "box")]
    pub bounds: [i32; 4],
    /// By slab index.
    pub slabs: BTreeMap<String, SolidShapes>,
}
#[derive(Serialize, Default, Clone, PartialEq, Eq, Debug)]
pub struct SolidShapes {
    /// Flat x0, y0, x1, y1.
    pub boxes: Vec<i32>,
    pub polygons: Vec<Polygon>,
}
/// Flat x, y of the outer ring followed by its holes, and the point index at
/// which each hole starts.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct Polygon(pub Vec<i32>, pub Vec<u32>);

impl SolidShapes {
    fn is_empty(&self) -> bool {
        self.boxes.is_empty() && self.polygons.is_empty()
    }
}

/// The view of everything, or of `region` (database units): the top cell's
/// shapes clipped to it and the placements meeting it, whole.
pub fn view(
    gds: &Path,
    layer_file: &Path,
    stack_file: &Path,
    region: Option<[i32; 4]>,
) -> Result<SolidView> {
    build(
        &gds::read(gds)?,
        &layer_properties::read(layer_file)?,
        &layer_stack::read(stack_file)?,
        region,
    )
}

fn build(
    library: &Library,
    styles: &[LayerStyle],
    materials: &[Material],
    region: Option<[i32; 4]>,
) -> Result<SolidView> {
    let top = &library.cells[library.top];
    let Flattened {
        cells: flattened,
        instances: placements,
        own,
    } = masks::flatten_top(library);
    let meets = |b: [i32; 4]| {
        region.is_none_or(|r| b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1])
    };
    let cell_bounds: Vec<[i32; 4]> = flattened
        .iter()
        .map(|(_, shapes)| {
            shapes
                .values()
                .filter_map(masks::bounds_of)
                .fold(None, masks::union)
                .unwrap_or([0; 4])
        })
        .collect();
    // Cells placed in the region, renumbered in the order the kept placements refer to them.
    let mut numbers: Vec<Option<usize>> = vec![None; flattened.len()];
    let mut kept: Vec<usize> = Vec::new();
    let mut instances = Vec::new();
    let mut bounds = None;
    for placement in &placements {
        let cell = placement[0] as usize;
        let placed = masks::transformed_box(
            placement[3] as u8,
            placement[1],
            placement[2],
            cell_bounds[cell],
        );
        if !meets(placed) {
            continue;
        }
        let number = *numbers[cell].get_or_insert_with(|| {
            kept.push(cell);
            kept.len() - 1
        });
        instances.push([number as i32, placement[1], placement[2], placement[3]]);
        bounds = masks::union(bounds, placed);
    }
    let own: ByLayer = own
        .into_iter()
        .map(|(key, shapes)| Ok((key, clipped(shapes, region)?)))
        .collect::<Result<_>>()?;
    for shapes in own.values() {
        if let Some(b) = masks::bounds_of(shapes) {
            bounds = masks::union(bounds, b);
        }
    }
    let listed: HashMap<(u16, u16), &LayerStyle> = styles
        .iter()
        .map(|style| ((style.layer, style.datatype), style))
        .collect();
    // A slab without shapes in the region is left out, as is a material without slabs.
    let mut out_materials = Vec::new();
    let mut slabs = Vec::new();
    let mut cell_slabs: Vec<BTreeMap<String, SolidShapes>> = vec![BTreeMap::new(); kept.len()];
    let mut top_shapes = Vec::new();
    for (index, material) in materials.iter().enumerate() {
        let source = material.like.or_else(|| single_input(material));
        let style = source.and_then(|key| listed.get(&key));
        let mut material_slabs = 0;
        for part in &material.parts {
            let top = evaluate(&part.expr, &own)?;
            let per_cell = kept
                .iter()
                .map(|&cell| evaluate(&part.expr, &flattened[cell].1))
                .collect::<Result<Vec<_>>>()?;
            if top.is_empty() && per_cell.iter().all(SolidShapes::is_empty) {
                continue;
            }
            let slab = slabs.len();
            slabs.push(Slab {
                material: out_materials.len(),
                zstart: part.zstart,
                zstop: part.zstop,
            });
            top_shapes.push(top);
            for (number, shapes) in per_cell.into_iter().enumerate() {
                if !shapes.is_empty() {
                    cell_slabs[number].insert(slab.to_string(), shapes);
                }
            }
            material_slabs += 1;
        }
        if material_slabs == 0 {
            continue;
        }
        let pair = |(layer, datatype): (u16, u16)| format!("{layer}/{datatype}");
        out_materials.push(SolidMaterial {
            name: material
                .name
                .clone()
                .or_else(|| style.map(|style| style.name.clone()))
                .or_else(|| source.map(pair))
                .unwrap_or_else(|| format!("z{}", index + 1)),
            fill: material
                .fill
                .clone()
                .or_else(|| style.map(|style| style.fill.clone()))
                .unwrap_or_else(|| {
                    let (layer, datatype) = source.unwrap_or((index as u16, 0));
                    layer_properties::default_style(layer, datatype, index).fill
                }),
            source: source.map(pair),
        });
    }
    let cells = kept
        .iter()
        .zip(cell_slabs)
        .map(|(&cell, slabs)| SolidCell {
            name: library.cells[flattened[cell].0].name.clone(),
            bounds: cell_bounds[cell],
            slabs,
        })
        .collect();
    // The shown area is the region itself; whole shapes may reach beyond it.
    let bounds = match (bounds, region) {
        (Some(b), Some(r)) => [
            b[0].max(r[0]),
            b[1].max(r[1]),
            b[2].min(r[2]),
            b[3].min(r[3]),
        ],
        (b, _) => b.unwrap_or([0; 4]),
    };
    Ok(SolidView {
        dbu: library.dbu,
        top: top.name.clone(),
        bounds,
        materials: out_materials,
        slabs,
        cells,
        instances,
        shapes: top_shapes,
    })
}

/// The shapes within a region, cut at its edges; everything without one.
fn clipped(shapes: MaskShapes, region: Option<[i32; 4]>) -> Result<MaskShapes> {
    let Some(r) = region else {
        return Ok(shapes);
    };
    let mut out = MaskShapes::default();
    for b in shapes.boxes.chunks_exact(4) {
        let cut = [
            b[0].max(r[0]),
            b[1].max(r[1]),
            b[2].min(r[2]),
            b[3].min(r[3]),
        ];
        if cut[0] <= cut[2] && cut[1] <= cut[3] {
            out.boxes.extend(cut);
        }
    }
    let window = SolidShapes {
        boxes: r.to_vec(),
        polygons: Vec::new(),
    };
    for points in shapes.polygons {
        let b = masks::polygon_bounds(&points);
        if b[0] >= r[0] && b[1] >= r[1] && b[2] <= r[2] && b[3] <= r[3] {
            out.polygons.push(points);
            continue;
        }
        if b[0] > r[2] || b[2] < r[0] || b[1] > r[3] || b[3] < r[1] {
            continue;
        }
        let inside = SolidShapes {
            boxes: Vec::new(),
            polygons: vec![Polygon(points, Vec::new())],
        };
        let cut = overlay(&inside, &window, OverlayRule::Intersect)?;
        out.boxes.extend(cut.boxes);
        // A clipped polygon cannot gain a hole; the box's edges only cut it.
        out.polygons
            .extend(cut.polygons.into_iter().map(|Polygon(points, _)| points));
    }
    Ok(out)
}

/// The one GDS layer a material shows, when every part is that layer.
fn single_input(material: &Material) -> Option<(u16, u16)> {
    let mut parts = material.parts.iter();
    let key = match &parts.next()?.expr {
        Expr::Input(layer, datatype) => (*layer, *datatype),
        _ => return None,
    };
    parts
        .all(|part| part.expr == Expr::Input(key.0, key.1))
        .then_some(key)
}

fn evaluate(expr: &Expr, shapes: &ByLayer) -> Result<SolidShapes> {
    Ok(match expr {
        Expr::Input(layer, datatype) => shapes
            .get(&(*layer, *datatype))
            .map(|layer| SolidShapes {
                boxes: layer.boxes.clone(),
                polygons: layer
                    .polygons
                    .iter()
                    .map(|points| Polygon(points.clone(), Vec::new()))
                    .collect(),
            })
            .unwrap_or_default(),
        Expr::Or(a, b) => {
            let mut result = evaluate(a, shapes)?;
            let right = evaluate(b, shapes)?;
            result.boxes.extend(right.boxes);
            result.polygons.extend(right.polygons);
            result
        }
        Expr::And(a, b) => {
            let (left, right) = (evaluate(a, shapes)?, evaluate(b, shapes)?);
            if left.is_empty() || right.is_empty() {
                SolidShapes::default()
            } else {
                overlay(&left, &right, OverlayRule::Intersect)?
            }
        }
        // Also with nothing to take away, so the result is merged as KLayout's is.
        Expr::Diff(a, b) => {
            let (left, right) = (evaluate(a, shapes)?, evaluate(b, shapes)?);
            if left.is_empty() {
                left
            } else {
                overlay(&left, &right, OverlayRule::Difference)?
            }
        }
    })
}

/// `i_overlay` combines coordinates within ±2^30.
const LIMIT: i32 = 1 << 30;

/// A ring oriented as the non-zero fill rule expects: outer rings
/// anticlockwise, holes clockwise.
fn ring(points: &[i32], hole: bool) -> Result<Vec<IntPoint<i32>>> {
    if points.iter().any(|value| value.abs() >= LIMIT) {
        bail!("a coordinate beyond ±2^30 database units cannot be combined with another layer");
    }
    let mut ring: Vec<IntPoint<i32>> = points
        .chunks_exact(2)
        .map(|p| IntPoint::new(p[0], p[1]))
        .collect();
    let doubled_area: i64 = ring
        .iter()
        .zip(ring.iter().cycle().skip(1))
        .map(|(a, b)| a.x as i64 * b.y as i64 - b.x as i64 * a.y as i64)
        .sum();
    if (doubled_area < 0) != hole {
        ring.reverse();
    }
    Ok(ring)
}
fn contours(shapes: &SolidShapes) -> Result<IntShapes<i32>> {
    let mut out = Vec::new();
    for b in shapes.boxes.chunks_exact(4) {
        out.push(vec![ring(
            &[b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]],
            false,
        )?]);
    }
    for Polygon(points, holes) in &shapes.polygons {
        let mut shape = Vec::new();
        let mut from = 0;
        for end in holes
            .iter()
            .map(|&hole| hole as usize * 2)
            .chain([points.len()])
        {
            shape.push(ring(&points[from..end], !shape.is_empty())?);
            from = end;
        }
        out.push(shape);
    }
    Ok(out)
}
fn overlay(a: &SolidShapes, b: &SolidShapes, rule: OverlayRule) -> Result<SolidShapes> {
    let result =
        Overlay::from_subj_and_clip(&contours(a)?, &contours(b)?).overlay(rule, FillRule::NonZero);
    let mut out = SolidShapes::default();
    for shape in result {
        let mut points = Vec::new();
        let mut holes = Vec::new();
        for (index, contour) in shape.iter().enumerate() {
            if index > 0 {
                holes.push((points.len() / 2) as u32);
            }
            points.extend(contour.iter().flat_map(|p| [p.x, p.y]));
        }
        match gds::polygon(points) {
            Geometry::Box(b) if holes.is_empty() => out.boxes.extend(b),
            Geometry::Box(b) => out.polygons.push(Polygon(
                vec![b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]],
                holes,
            )),
            Geometry::Polygon(points) => out.polygons.push(Polygon(points, holes)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gds::tests::{boundary, cell, library, sref};

    fn style(layer: u16, datatype: u16, name: &str, fill: &str) -> LayerStyle {
        LayerStyle {
            layer,
            datatype,
            name: name.into(),
            fill: fill.into(),
            frame: fill.into(),
            pattern: vec!["*".into()],
            visible: true,
        }
    }
    fn stack(script: &str) -> Vec<Material> {
        layer_stack::parse(&format!(
            "<klayout-macro><text>{script}</text></klayout-macro>"
        ))
        .unwrap()
    }
    /// A leaf with poly and two contacts, one over the poly; the top places the
    /// leaf twice and routes met1 near each placement.
    fn fixture() -> Library {
        let data = library(&[
            cell(
                "leaf",
                &[
                    boundary(66, 20, &[0, 0, 0, 20, 100, 20, 100, 0]),
                    boundary(66, 44, &[10, 5, 10, 15, 20, 15, 20, 5]),
                    boundary(66, 44, &[50, 50, 50, 60, 60, 60, 60, 50]),
                ],
            ),
            cell(
                "top",
                &[
                    sref("leaf", 1000, 1000, false, 0.0),
                    sref("leaf", 5000, 5000, true, 0.0),
                    boundary(68, 20, &[0, 0, 0, 100, 3000, 100, 3000, 0]),
                    boundary(68, 20, &[6000, 6000, 6000, 6200, 6100, 6200, 6100, 6000]),
                ],
            ),
        ]);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), data).unwrap();
        gds::read(file.path()).unwrap()
    }
    const SCRIPT: &str = r#"
poly = input(66, 20)
licon = input(66, 44)
met1 = input(68, 20)
z(poly, height: 250.nm, name: "poly")
zz(name: "licon", like: "66/44") do
  over = licon &amp; poly
  z(over, zstart: 250.nm, height: 400.nm)
  z(licon - over, zstart: 0.nm, height: 650.nm)
end
z(met1, height: 300.nm)
z(poly - licon, zstart: 2, height: 1, name: "ring")
z(input(99, 0), height: 1)
"#;
    fn styles() -> Vec<LayerStyle> {
        vec![
            style(66, 20, "poly.drawing", "#00ff00"),
            style(66, 44, "licon.drawing", "#112233"),
            style(68, 20, "met1.drawing", "#0000ff"),
        ]
    }

    #[test]
    fn materials_get_their_slabs_from_the_script_and_their_looks_from_the_layer_file() {
        let view = build(&fixture(), &styles(), &stack(SCRIPT), None).unwrap();
        let names: Vec<&str> = view.materials.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["poly", "licon", "met1.drawing", "ring"]);
        let fills: Vec<&str> = view.materials.iter().map(|m| m.fill.as_str()).collect();
        assert_eq!(&fills[..3], ["#00ff00", "#112233", "#0000ff"]);
        assert!(fills[3].starts_with('#'));
        let sources: Vec<Option<&str>> =
            view.materials.iter().map(|m| m.source.as_deref()).collect();
        assert_eq!(sources, [Some("66/20"), Some("66/44"), Some("68/20"), None]);
        let ranges: Vec<(usize, f64, f64)> = view
            .slabs
            .iter()
            .map(|s| (s.material, s.zstart, s.zstop))
            .collect();
        assert_eq!(ranges.len(), 5);
        assert_eq!(ranges[0], (0, 0.0, 0.25));
        assert_eq!((ranges[1].0, ranges[1].1), (1, 0.25));
        assert!((ranges[1].2 - 0.65).abs() < 1e-9 && (ranges[2].2 - 0.65).abs() < 1e-9);
        assert_eq!((ranges[3].0, ranges[4].0), (2, 3));
        assert_eq!((ranges[4].1, ranges[4].2), (2.0, 3.0));
        // The contact over poly and the one beside it have different heights.
        assert_eq!(view.cells.len(), 1);
        let leaf = &view.cells[0];
        assert_eq!(leaf.name, "leaf");
        assert_eq!(leaf.bounds, [0, 0, 100, 60]);
        assert_eq!(leaf.slabs["0"].boxes, [0, 0, 100, 20]);
        assert_eq!(leaf.slabs["1"].boxes, [10, 5, 20, 15]);
        assert_eq!(leaf.slabs["2"].boxes, [50, 50, 60, 60]);
        // Poly without its contact is a ring: an outer box with the contact as a hole.
        let Polygon(points, holes) = &leaf.slabs["4"].polygons[0];
        assert_eq!(holes, &[4]);
        let outer: Vec<i32> = points[..8].to_vec();
        assert_eq!(masks::polygon_bounds(&outer), [0, 0, 100, 20]);
        assert_eq!(masks::polygon_bounds(&points[8..]), [10, 5, 20, 15]);
        assert_eq!(leaf.slabs["4"].boxes, Vec::<i32>::new());
        assert!(!leaf.slabs.contains_key("3"));
        assert_eq!(
            view.shapes[3].boxes,
            [0, 0, 3000, 100, 6000, 6000, 6100, 6200]
        );
        assert!(view.shapes[0].is_empty() && view.shapes[4].is_empty());
        assert_eq!(view.instances, [[0, 1000, 1000, 0], [0, 5000, 5000, 4]]);
        assert_eq!(view.bounds, [0, 0, 6100, 6200]);
    }

    #[test]
    fn a_region_keeps_whole_placements_and_shapes_meeting_it() {
        let library = fixture();
        let view = build(
            &library,
            &styles(),
            &stack(SCRIPT),
            Some([0, 0, 4000, 4000]),
        )
        .unwrap();
        assert_eq!(view.instances, [[0, 1000, 1000, 0]]);
        assert_eq!(view.shapes[3].boxes, [0, 0, 3000, 100]);
        assert_eq!(view.bounds, [0, 0, 3000, 1060]);
        let view = build(
            &library,
            &styles(),
            &stack(SCRIPT),
            Some([500, 500, 2000, 1500]),
        )
        .unwrap();
        assert_eq!(view.instances, [[0, 1000, 1000, 0]]);
        assert_eq!(view.bounds, [1000, 1000, 1100, 1060]);
        // Top shapes are cut at the region's edges; a placed cell stays whole.
        let view = build(
            &library,
            &styles(),
            &stack(SCRIPT),
            Some([1050, 0, 3500, 1010]),
        )
        .unwrap();
        assert_eq!(view.instances, [[0, 1000, 1000, 0]]);
        assert_eq!(view.cells[0].slabs["0"].boxes, [0, 0, 100, 20]);
        assert_eq!(view.shapes[3].boxes, [1050, 0, 3000, 100]);
        assert_eq!(view.bounds, [1050, 0, 3000, 1010]);
        let view = build(
            &library,
            &styles(),
            &stack(SCRIPT),
            Some([4000, 4000, 7000, 7000]),
        )
        .unwrap();
        assert_eq!(view.instances, [[0, 5000, 5000, 4]]);
        assert_eq!(view.cells.len(), 1);
        assert_eq!(view.shapes[3].boxes, [6000, 6000, 6100, 6200]);
        let view = build(
            &library,
            &styles(),
            &stack(SCRIPT),
            Some([2000, 2000, 2500, 2500]),
        )
        .unwrap();
        assert!(view.instances.is_empty() && view.cells.is_empty() && view.materials.is_empty());
    }

    #[test]
    fn a_polygon_crossing_the_region_is_cut_at_its_edge() {
        // An L shape whose foot reaches past the region's right edge.
        let data = library(&[cell(
            "top",
            &[boundary(
                68,
                20,
                &[0, 0, 0, 300, 100, 300, 100, 100, 400, 100, 400, 0],
            )],
        )]);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), data).unwrap();
        let library = gds::read(file.path()).unwrap();
        let script = "z(input(68, 20), height: 1)";
        let view = build(&library, &[], &stack(script), Some([-10, -10, 250, 500])).unwrap();
        let Polygon(points, holes) = &view.shapes[0].polygons[0];
        assert!(holes.is_empty());
        assert_eq!(masks::polygon_bounds(points), [0, 0, 250, 300]);
        let doubled: i64 = points
            .chunks_exact(2)
            .zip(points.chunks_exact(2).cycle().skip(1))
            .map(|(a, b)| a[0] as i64 * b[1] as i64 - b[0] as i64 * a[1] as i64)
            .sum();
        assert_eq!(doubled.abs() / 2, 100 * 300 + 150 * 100);
        let whole = build(&library, &[], &stack(script), Some([-10, -10, 500, 500])).unwrap();
        assert_eq!(whole.shapes[0].polygons[0].0.len(), 12);
        let outside = build(&library, &[], &stack(script), Some([600, 0, 700, 100])).unwrap();
        assert!(outside.materials.is_empty());
    }

    #[test]
    fn a_coordinate_beyond_the_boolean_range_is_an_error() {
        let data = library(&[cell(
            "top",
            &[
                boundary(1, 0, &[0, 0, 0, 10, 10, 10, 10, 0]),
                boundary(2, 0, &[0, 0, 0, 10, LIMIT, 10, LIMIT, 0]),
            ],
        )]);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), data).unwrap();
        let library = gds::read(file.path()).unwrap();
        let error = build(
            &library,
            &[],
            &stack("z(input(1) &amp; input(2), height: 1)"),
            None,
        )
        .unwrap_err();
        assert!(error.to_string().contains("beyond ±2^30"));
        let view = build(
            &library,
            &[],
            &stack("z(input(1) | input(2), height: 1)"),
            None,
        )
        .unwrap();
        assert_eq!(view.materials[0].name, "z1");
        assert_eq!(view.shapes[0].boxes.len(), 8);
    }
}
