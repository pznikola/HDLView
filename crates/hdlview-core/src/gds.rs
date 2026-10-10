//! Reader for GDSII stream files, as a place-and-route flow writes them: cells
//! with boxes, polygons, placements and texts in integer database units. Paths
//! become polygons and arrays become placements, so a viewer sees one kind of
//! shape and one kind of instance.

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug)]
pub struct Library {
    /// Database units per micron.
    pub dbu: u32,
    pub cells: Vec<Cell>,
    /// The one cell no other cell places.
    pub top: usize,
}
#[derive(Debug, Default)]
pub struct Cell {
    pub name: String,
    pub shapes: Vec<Shape>,
    pub placements: Vec<Placement>,
    pub texts: Vec<Text>,
}
#[derive(Debug)]
pub struct Shape {
    /// GDS layer and datatype.
    pub layer: (u16, u16),
    pub geometry: Geometry,
}
#[derive(Debug)]
pub enum Geometry {
    /// x0, y0, x1, y1
    Box([i32; 4]),
    /// Flat x, y of the hull, without a repeated closing point.
    Polygon(Vec<i32>),
}
#[derive(Debug)]
pub struct Placement {
    pub cell: usize,
    pub x: i32,
    pub y: i32,
    /// 0 to 3 are quarter turns anticlockwise, 4 to 7 the same after a
    /// mirror at the x axis (KLayout's numbering, which the UI shares).
    pub orientation: u8,
}
#[derive(Debug)]
pub struct Text {
    pub layer: (u16, u16),
    pub x: i32,
    pub y: i32,
    pub string: String,
}

const HEADER: u16 = 0x0002;
const BGNLIB: u16 = 0x0102;
const UNITS: u16 = 0x0305;
const ENDLIB: u16 = 0x0400;
const BGNSTR: u16 = 0x0502;
const STRNAME: u16 = 0x0606;
const ENDSTR: u16 = 0x0700;
const BOUNDARY: u16 = 0x0800;
const PATH: u16 = 0x0900;
const SREF: u16 = 0x0a00;
const AREF: u16 = 0x0b00;
const TEXT: u16 = 0x0c00;
const LAYER: u16 = 0x0d02;
const DATATYPE: u16 = 0x0e02;
const WIDTH: u16 = 0x0f03;
const XY: u16 = 0x1003;
const ENDEL: u16 = 0x1100;
const SNAME: u16 = 0x1206;
const COLROW: u16 = 0x1302;
const NODE: u16 = 0x1500;
const TEXTTYPE: u16 = 0x1602;
const STRING: u16 = 0x1906;
const STRANS: u16 = 0x1a01;
const MAG: u16 = 0x1b05;
const ANGLE: u16 = 0x1c05;
const PATHTYPE: u16 = 0x2102;
const BOX: u16 = 0x2d00;
const BOXTYPE: u16 = 0x2e02;
const BGNEXTN: u16 = 0x3003;
const ENDEXTN: u16 = 0x3103;
/// KLayout keeps its own metadata in a cell of this name; it is not a design cell.
const CONTEXT_CELL: &str = "$$$CONTEXT_INFO$$$";

pub fn read(path: &Path) -> Result<Library> {
    let data = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    parse(&data).with_context(|| format!("reading GDS {}", path.display()))
}

/// Records of a stream: a big-endian 16-bit length including this header, the
/// record type and its data type.
struct Records<'a> {
    data: &'a [u8],
    at: usize,
}
impl<'a> Records<'a> {
    fn next(&mut self) -> Result<(u16, &'a [u8])> {
        let header = self
            .data
            .get(self.at..self.at + 4)
            .context("the stream ends inside a record header")?;
        let length = u16::from_be_bytes([header[0], header[1]]) as usize;
        let id = u16::from_be_bytes([header[2], header[3]]);
        if length < 4 {
            bail!("record {id:#06x} at byte {} has length {length}", self.at);
        }
        let body = self
            .data
            .get(self.at + 4..self.at + length)
            .with_context(|| format!("record {id:#06x} at byte {} runs past the end", self.at))?;
        self.at += length;
        Ok((id, body))
    }
}

fn i16s(body: &[u8]) -> Vec<i16> {
    body.chunks_exact(2)
        .map(|b| i16::from_be_bytes([b[0], b[1]]))
        .collect()
}
fn i32s(body: &[u8]) -> Vec<i32> {
    body.chunks_exact(4)
        .map(|b| i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}
/// An 8-byte real: sign, excess-64 exponent of 16, 56-bit mantissa below the point.
fn real8(body: &[u8]) -> Result<f64> {
    let b: &[u8; 8] = body
        .get(..8)
        .and_then(|b| b.try_into().ok())
        .context("a real is shorter than 8 bytes")?;
    let mantissa = b[1..].iter().fold(0f64, |m, &byte| m * 256.0 + byte as f64) / 2f64.powi(56);
    let exponent = (b[0] & 0x7f) as i32 - 64;
    let value = mantissa * 16f64.powi(exponent);
    Ok(if b[0] & 0x80 != 0 { -value } else { value })
}
fn string(body: &[u8]) -> String {
    let end = body.iter().position(|&b| b == 0).unwrap_or(body.len());
    String::from_utf8_lossy(&body[..end]).into_owned()
}

/// A placement before its cell name is resolved.
struct Reference {
    name: String,
    x: i32,
    y: i32,
    orientation: u8,
}

fn parse(data: &[u8]) -> Result<Library> {
    let mut records = Records { data, at: 0 };
    if records.next()?.0 != HEADER {
        bail!("not a GDS stream: no HEADER record");
    }
    if records.next()?.0 != BGNLIB {
        bail!("not a GDS stream: no BGNLIB record");
    }
    let dbu = loop {
        let (id, body) = records.next()?;
        match id {
            UNITS => {
                let per_micron = 1.0 / (real8(body.get(8..).unwrap_or_default())? * 1e6);
                if !(per_micron.is_finite() && per_micron >= 1.0) {
                    bail!("UNITS gives {per_micron} database units per micron");
                }
                break per_micron.round() as u32;
            }
            BGNSTR | ENDLIB => bail!("no UNITS record before the first cell"),
            _ => {}
        }
    };
    let mut cells: Vec<Cell> = Vec::new();
    let mut references: Vec<Vec<Reference>> = Vec::new();
    loop {
        let (id, _) = records.next()?;
        match id {
            BGNSTR => {
                let (cell, refs) = structure(&mut records)?;
                if cell.name != CONTEXT_CELL {
                    cells.push(cell);
                    references.push(refs);
                }
            }
            ENDLIB => break,
            _ => {}
        }
    }
    let index: HashMap<&str, usize> = cells
        .iter()
        .enumerate()
        .map(|(number, cell)| (cell.name.as_str(), number))
        .collect();
    let mut placed = vec![false; cells.len()];
    let mut placements = Vec::with_capacity(cells.len());
    for (cell, refs) in cells.iter().zip(references) {
        let mut own = Vec::with_capacity(refs.len());
        for reference in refs {
            let target = *index.get(reference.name.as_str()).with_context(|| {
                format!(
                    "{} places {}, which the stream does not define",
                    cell.name, reference.name
                )
            })?;
            placed[target] = true;
            own.push(Placement {
                cell: target,
                x: reference.x,
                y: reference.y,
                orientation: reference.orientation,
            });
        }
        placements.push(own);
    }
    for (cell, own) in cells.iter_mut().zip(placements) {
        cell.placements = own;
    }
    let tops: Vec<usize> = (0..cells.len()).filter(|&i| !placed[i]).collect();
    let top = match tops.as_slice() {
        [top] => *top,
        [] => bail!("the stream has no top cell"),
        many => bail!(
            "the stream has several top cells: {}",
            many.iter()
                .map(|&i| cells[i].name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    Ok(Library { dbu, cells, top })
}

/// The records of an element up to ENDEL. Records the viewer has no use for
/// (ELFLAGS, PLEX, PRESENTATION, properties) are passed over.
#[derive(Default)]
struct Element {
    layer: u16,
    datatype: u16,
    path_type: i16,
    width: i32,
    begin_extension: Option<i32>,
    end_extension: Option<i32>,
    xy: Vec<i32>,
    name: String,
    columns: i16,
    rows: i16,
    mirror: bool,
    magnification: f64,
    angle: f64,
    string: String,
}
fn element(records: &mut Records) -> Result<Element> {
    let mut e = Element {
        magnification: 1.0,
        ..Element::default()
    };
    let first = |body: &[u8], what: &str| -> Result<i16> {
        i16s(body)
            .first()
            .copied()
            .with_context(|| format!("empty {what} record"))
    };
    loop {
        let (id, body) = records.next()?;
        match id {
            LAYER => e.layer = first(body, "LAYER")? as u16,
            DATATYPE | TEXTTYPE | BOXTYPE => e.datatype = first(body, "DATATYPE")? as u16,
            PATHTYPE => e.path_type = first(body, "PATHTYPE")?,
            WIDTH => e.width = i32s(body).first().copied().context("empty WIDTH record")?,
            BGNEXTN => e.begin_extension = i32s(body).first().copied(),
            ENDEXTN => e.end_extension = i32s(body).first().copied(),
            // Long point lists continue in further XY records.
            XY => e.xy.extend(i32s(body)),
            SNAME => e.name = string(body),
            COLROW => {
                let values = i16s(body);
                e.columns = values.first().copied().unwrap_or(1).max(1);
                e.rows = values.get(1).copied().unwrap_or(1).max(1);
            }
            STRANS => e.mirror = (first(body, "STRANS")? as u16) & 0x8000 != 0,
            MAG => e.magnification = real8(body)?,
            ANGLE => e.angle = real8(body)?,
            STRING => e.string = string(body),
            ENDEL => return Ok(e),
            BGNSTR | ENDSTR | ENDLIB => bail!("an element has no ENDEL record"),
            _ => {}
        }
    }
}

fn structure(records: &mut Records) -> Result<(Cell, Vec<Reference>)> {
    let mut cell = Cell::default();
    let mut references = Vec::new();
    loop {
        let (id, body) = records.next()?;
        match id {
            STRNAME => cell.name = string(body),
            ENDSTR => return Ok((cell, references)),
            ENDLIB => bail!("{} has no ENDSTR record", cell.name),
            BOUNDARY => {
                let e = element(records)?;
                let mut points = e.xy;
                if points.len() >= 4 && points[..2] == points[points.len() - 2..] {
                    points.truncate(points.len() - 2);
                }
                if points.len() >= 6 {
                    cell.shapes.push(Shape {
                        layer: (e.layer, e.datatype),
                        geometry: polygon(points),
                    });
                }
            }
            BOX => {
                let e = element(records)?;
                if let Some(b) = bounds(&e.xy) {
                    cell.shapes.push(Shape {
                        layer: (e.layer, e.datatype),
                        geometry: Geometry::Box(b),
                    });
                }
            }
            PATH => {
                let e = element(records)?;
                let round = e.path_type == 1;
                // Round and square ends overhang by half the width unless told otherwise.
                let default = if round || e.path_type == 2 {
                    e.width / 2
                } else {
                    0
                };
                let hull = path_hull(
                    &e.xy,
                    e.width,
                    round,
                    e.begin_extension.unwrap_or(default),
                    e.end_extension.unwrap_or(default),
                );
                if hull.len() >= 6 {
                    cell.shapes.push(Shape {
                        layer: (e.layer, e.datatype),
                        geometry: polygon(hull),
                    });
                }
            }
            SREF | AREF => {
                let e = element(records)?;
                let turns = e.angle / 90.0;
                if (turns - turns.round()).abs() > 1e-9 || (e.magnification - 1.0).abs() > 1e-9 {
                    bail!(
                        "{} is placed in {} at {}° with magnification {}; only unmagnified quarter turns are supported",
                        e.name, cell.name, e.angle, e.magnification
                    );
                }
                let orientation =
                    (turns.round().rem_euclid(4.0)) as u8 + if e.mirror { 4 } else { 0 };
                let origin = (
                    *e.xy
                        .first()
                        .with_context(|| format!("{} is placed without XY", e.name))?,
                    *e.xy.get(1).unwrap_or(&0),
                );
                let mut place = |x, y| {
                    references.push(Reference {
                        name: e.name.clone(),
                        x,
                        y,
                        orientation,
                    })
                };
                if id == SREF {
                    place(origin.0, origin.1);
                } else {
                    // The second and third points span the whole array in parent coordinates.
                    let point = |n: usize| -> Result<(i32, i32)> {
                        match e.xy.get(2 * n..2 * n + 2) {
                            Some(&[x, y]) => Ok((x, y)),
                            _ => bail!("{} is an array with fewer than 3 points", e.name),
                        }
                    };
                    let (p1, p2) = (point(1)?, point(2)?);
                    let (columns, rows) = (e.columns as i32, e.rows as i32);
                    let column = (p1.0 - origin.0, p1.1 - origin.1);
                    let row = (p2.0 - origin.0, p2.1 - origin.1);
                    if column.0 % columns != 0
                        || column.1 % columns != 0
                        || row.0 % rows != 0
                        || row.1 % rows != 0
                    {
                        bail!(
                            "the array of {} in {} has a pitch off the database grid",
                            e.name,
                            cell.name
                        );
                    }
                    let column = (column.0 / columns, column.1 / columns);
                    let row = (row.0 / rows, row.1 / rows);
                    for c in 0..columns {
                        for r in 0..rows {
                            place(
                                origin.0 + c * column.0 + r * row.0,
                                origin.1 + c * column.1 + r * row.1,
                            );
                        }
                    }
                }
            }
            TEXT => {
                let e = element(records)?;
                if let [x, y, ..] = e.xy[..] {
                    cell.texts.push(Text {
                        layer: (e.layer, e.datatype),
                        x,
                        y,
                        string: e.string,
                    });
                }
            }
            NODE => {
                element(records)?;
            }
            _ => {}
        }
    }
}

fn bounds(points: &[i32]) -> Option<[i32; 4]> {
    let xs = points.iter().step_by(2);
    let ys = points.iter().skip(1).step_by(2);
    Some([
        *xs.clone().min()?,
        *ys.clone().min()?,
        *xs.max()?,
        *ys.max()?,
    ])
}
/// A four-point axis-parallel ring is a box; anything else stays a polygon.
fn polygon(points: Vec<i32>) -> Geometry {
    if let [x0, y0, x1, y1, x2, y2, x3, y3] = points[..] {
        let upright = x0 == x1 && y1 == y2 && x2 == x3 && y3 == y0;
        let flat = y0 == y1 && x1 == x2 && y2 == y3 && x3 == x0;
        if upright || flat {
            return Geometry::Box([x0.min(x2), y0.min(y2), x0.max(x2), y0.max(y2)]);
        }
    }
    Geometry::Polygon(points)
}

/// Points of a full circle in a round path end.
const CIRCLE_POINTS: usize = 16;
/// The hull of a path of the given width: both sides offset by half the width,
/// mitred corners cut at half the width along each segment, and round ends as
/// half circles of `CIRCLE_POINTS` points or square ends with the given
/// extensions. Flat x, y, rounded to database units.
fn path_hull(xy: &[i32], width: i32, round: bool, begin: i32, end: i32) -> Vec<i32> {
    let mut spine: Vec<(f64, f64)> = Vec::new();
    for point in xy.chunks_exact(2) {
        let point = (point[0] as f64, point[1] as f64);
        if spine.last() == Some(&point) {
            continue;
        }
        // A point on the straight line between its neighbours changes nothing.
        if let [.., a, b] = spine[..] {
            let (u, v) = ((b.0 - a.0, b.1 - a.1), (point.0 - b.0, point.1 - b.1));
            if u.0 * v.1 - u.1 * v.0 == 0.0 && u.0 * v.0 + u.1 * v.1 > 0.0 {
                spine.pop();
            }
        }
        spine.push(point);
    }
    if spine.is_empty() {
        return Vec::new();
    }
    let half = width.abs() as f64 / 2.0;
    let mut hull = side(&spine, (1.0, 0.0), half, round, begin as f64, end as f64);
    spine.reverse();
    hull.extend(side(
        &spine,
        (-1.0, 0.0),
        half,
        round,
        end as f64,
        begin as f64,
    ));
    hull.iter()
        .flat_map(|&(x, y)| [x.round() as i32, y.round() as i32])
        .collect()
}
/// The left side of a path from its start to its end, with the start's cap
/// before and the end's cap after it. A single point is an infinitesimal
/// segment in the `alone` direction.
fn side(
    spine: &[(f64, f64)],
    alone: (f64, f64),
    half: f64,
    round: bool,
    begin: f64,
    end: f64,
) -> Vec<(f64, f64)> {
    let unit = |a: (f64, f64), b: (f64, f64)| {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let length = (dx * dx + dy * dy).sqrt();
        (dx / length, dy / length)
    };
    let direction = |i: usize| {
        if spine.len() < 2 {
            alone
        } else {
            unit(spine[i], spine[i + 1])
        }
    };
    let left = |(dx, dy): (f64, f64)| (-dy * half, dx * half);
    let add = |p: (f64, f64), d: (f64, f64), l: f64, n: (f64, f64)| {
        (p.0 + d.0 * l + n.0, p.1 + d.1 * l + n.1)
    };
    let mut points = Vec::new();
    let first = spine[0];
    let last = spine[spine.len() - 1];
    let d0 = direction(0);
    let d1 = direction(spine.len().saturating_sub(2));
    // Each cap is a quarter circle from the tip to the side, circumscribing the
    // true arc so the polygon is never inside it.
    let step = std::f64::consts::PI / (2.0 * CIRCLE_POINTS as f64);
    let arc = |p: (f64, f64), along: f64, d: (f64, f64), from_tip: bool| -> Vec<(f64, f64)> {
        let n = left(d);
        let scale = 1.0 / step.cos();
        (0..CIRCLE_POINTS / 2)
            .map(|k| {
                let theta = step * (2 * k + 1) as f64;
                let (t, s) = if from_tip {
                    (theta.cos(), theta.sin())
                } else {
                    (theta.sin(), theta.cos())
                };
                (
                    p.0 + (d.0 * along * t + n.0 * s) * scale,
                    p.1 + (d.1 * along * t + n.1 * s) * scale,
                )
            })
            .collect()
    };
    if round {
        points.extend(arc(first, -begin, d0, true));
    } else {
        points.push(add(first, d0, -begin, left(d0)));
    }
    for i in 1..spine.len().saturating_sub(1) {
        let p = spine[i];
        let (din, dout) = (direction(i - 1), direction(i));
        let (n, nn) = (left(din), left(dout));
        let cross = din.0 * dout.1 - din.1 * dout.0;
        if cross.abs() < 1e-12 {
            // Straight on was removed; this is a reversal.
            points.push(add(p, din, half, n));
            points.push(add(p, dout, -half, nn));
            continue;
        }
        // Where the two offset lines meet, measured along each segment.
        let l_in = ((nn.0 - n.0) * dout.1 - (nn.1 - n.1) * dout.0) / cross;
        let l_out = ((n.0 - nn.0) * din.1 - (n.1 - nn.1) * din.0) / cross;
        let before = spine[i - 1];
        let after = spine[i + 1];
        let length =
            |a: (f64, f64), b: (f64, f64)| ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        if l_in < -(length(before, p) + half) - 1e-9 || l_out < -(length(p, after) + half) - 1e-9 {
            // Segments shorter than the offset: fold through the spine point.
            points.push(add(p, din, 0.0, n));
            points.push(p);
            points.push(add(p, dout, 0.0, nn));
        } else if l_in < half + 1e-9 && l_out < half + 1e-9 {
            points.push(add(p, din, l_in, n));
        } else {
            points.push(add(p, din, l_in.min(half), n));
            points.push(add(p, dout, -l_out.min(half), nn));
        }
    }
    if round {
        points.extend(arc(last, end, d1, false));
    } else {
        points.push(add(last, d1, end, left(d1)));
    }
    points
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A record with its body, as the stream frames it.
    pub fn record(id: u16, body: &[u8]) -> Vec<u8> {
        let mut r = ((body.len() + 4) as u16).to_be_bytes().to_vec();
        r.extend(id.to_be_bytes());
        r.extend(body);
        r
    }
    pub fn i16s(values: &[i16]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_be_bytes()).collect()
    }
    pub fn i32s(values: &[i32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_be_bytes()).collect()
    }
    pub fn real(value: f64) -> Vec<u8> {
        if value == 0.0 {
            return vec![0; 8];
        }
        let sign = if value < 0.0 { 0x80 } else { 0 };
        let mut exponent = 0i32;
        let mut mantissa = value.abs();
        while mantissa >= 1.0 {
            mantissa /= 16.0;
            exponent += 1;
        }
        while mantissa < 1.0 / 16.0 {
            mantissa *= 16.0;
            exponent -= 1;
        }
        let bits = ((mantissa * 2f64.powi(56)).round() as u64).to_be_bytes();
        let mut r = vec![sign | (exponent + 64) as u8];
        r.extend(&bits[1..]);
        r
    }
    pub fn text(s: &str) -> Vec<u8> {
        let mut r = s.as_bytes().to_vec();
        if r.len() % 2 == 1 {
            r.push(0);
        }
        r
    }
    /// A library of 1 nm units holding the given cells.
    pub fn library(cells: &[Vec<u8>]) -> Vec<u8> {
        let mut units = real(0.001);
        units.extend(real(1e-9));
        let mut s = record(HEADER, &i16s(&[600]));
        s.extend(record(BGNLIB, &[0; 24]));
        s.extend(record(0x0206, &text("lib")));
        s.extend(record(UNITS, &units));
        for cell in cells {
            s.extend(cell);
        }
        s.extend(record(ENDLIB, &[]));
        s
    }
    pub fn cell(name: &str, elements: &[Vec<u8>]) -> Vec<u8> {
        let mut s = record(BGNSTR, &[0; 24]);
        s.extend(record(STRNAME, &text(name)));
        for e in elements {
            s.extend(e);
        }
        s.extend(record(ENDSTR, &[]));
        s
    }
    pub fn boundary(layer: i16, datatype: i16, xy: &[i32]) -> Vec<u8> {
        let mut s = record(BOUNDARY, &[]);
        s.extend(record(LAYER, &i16s(&[layer])));
        s.extend(record(DATATYPE, &i16s(&[datatype])));
        s.extend(record(XY, &i32s(xy)));
        s.extend(record(ENDEL, &[]));
        s
    }
    pub fn sref(name: &str, x: i32, y: i32, mirror: bool, angle: f64) -> Vec<u8> {
        let mut s = record(SREF, &[]);
        s.extend(record(SNAME, &text(name)));
        s.extend(record(STRANS, &i16s(&[if mirror { -32768 } else { 0 }])));
        s.extend(record(ANGLE, &real(angle)));
        s.extend(record(XY, &i32s(&[x, y])));
        s.extend(record(ENDEL, &[]));
        s
    }
    fn path(path_type: i16, width: i32, extensions: Option<(i32, i32)>, xy: &[i32]) -> Vec<u8> {
        let mut s = record(PATH, &[]);
        s.extend(record(LAYER, &i16s(&[1])));
        s.extend(record(DATATYPE, &i16s(&[0])));
        s.extend(record(PATHTYPE, &i16s(&[path_type])));
        s.extend(record(WIDTH, &i32s(&[width])));
        if let Some((begin, end)) = extensions {
            s.extend(record(BGNEXTN, &i32s(&[begin])));
            s.extend(record(ENDEXTN, &i32s(&[end])));
        }
        s.extend(record(XY, &i32s(xy)));
        s.extend(record(ENDEL, &[]));
        s
    }
    fn shapes(cell: &Cell) -> Vec<(u16, u16, Vec<i32>)> {
        cell.shapes
            .iter()
            .map(|s| {
                let points = match &s.geometry {
                    Geometry::Box(b) => b.to_vec(),
                    Geometry::Polygon(p) => p.clone(),
                };
                (s.layer.0, s.layer.1, points)
            })
            .collect()
    }

    #[test]
    fn reals_round_trip_and_units_give_database_units_per_micron() {
        for value in [0.001, 1e-9, 1.0, -2.5, 1234.5678, 1e-20] {
            assert!((real8(&real(value)).unwrap() - value).abs() <= value.abs() * 1e-15);
        }
        let lib = parse(&library(&[cell("top", &[])])).unwrap();
        assert_eq!(lib.dbu, 1000);
        assert_eq!(lib.cells[lib.top].name, "top");
    }

    #[test]
    fn rings_become_boxes_when_rectangular_and_polygons_otherwise() {
        let lib = parse(&library(&[cell(
            "top",
            &[
                boundary(66, 20, &[0, 0, 0, 5, 10, 5, 10, 0, 0, 0]),
                boundary(66, 20, &[10, 0, 0, 0, 0, 5, 10, 5]),
                boundary(67, 44, &[0, 0, 10, 0, 10, 10, 5, 10, 5, 5, 0, 5, 0, 0]),
                boundary(67, 44, &[0, 0, 10, 0]),
            ],
        )]))
        .unwrap();
        assert_eq!(
            shapes(&lib.cells[0]),
            vec![
                (66, 20, vec![0, 0, 10, 5]),
                (66, 20, vec![0, 0, 10, 5]),
                (67, 44, vec![0, 0, 10, 0, 10, 10, 5, 10, 5, 5, 0, 5]),
            ]
        );
    }

    #[test]
    fn long_point_lists_continue_in_further_xy_records() {
        let mut s = record(BOUNDARY, &[]);
        s.extend(record(LAYER, &i16s(&[1])));
        s.extend(record(DATATYPE, &i16s(&[0])));
        s.extend(record(XY, &i32s(&[0, 0, 10, 0, 10, 10])));
        s.extend(record(XY, &i32s(&[5, 10, 5, 5, 0, 5])));
        s.extend(record(ENDEL, &[]));
        let lib = parse(&library(&[cell("top", &[s])])).unwrap();
        assert_eq!(
            shapes(&lib.cells[0])[0].2,
            vec![0, 0, 10, 0, 10, 10, 5, 10, 5, 5, 0, 5]
        );
    }

    #[test]
    fn paths_become_hulls_with_their_end_style() {
        let hull = |elements: &[Vec<u8>]| {
            shapes(&parse(&library(&[cell("top", elements)])).unwrap().cells[0])
        };
        // Flush, square and explicit ends of a straight path.
        assert_eq!(
            hull(&[path(0, 10, None, &[0, 0, 100, 0])])[0].2,
            vec![0, -5, 100, 5]
        );
        assert_eq!(
            hull(&[path(2, 10, None, &[0, 0, 100, 0])])[0].2,
            vec![-5, -5, 105, 5]
        );
        assert_eq!(
            hull(&[path(4, 10, Some((2, 7)), &[0, 0, 100, 0])])[0].2,
            vec![-2, -5, 107, 5]
        );
        // A corner is mitred at half the width.
        assert_eq!(
            hull(&[path(0, 10, None, &[0, 0, 100, 0, 100, 100])])[0].2,
            vec![0, 5, 95, 5, 95, 100, 105, 100, 105, -5, 0, -5]
        );
        // Round ends add half circles that reach half the width past the end.
        let round = &hull(&[path(1, 10, None, &[0, 0, 100, 0])])[0].2;
        assert_eq!(round.len(), 2 * 2 * CIRCLE_POINTS);
        let xs = round.iter().step_by(2);
        assert_eq!((xs.clone().min(), xs.max()), (Some(&-5), Some(&105)));
        // A single point is a box the size of the ends.
        assert_eq!(
            hull(&[path(2, 10, None, &[50, 50])])[0].2,
            vec![45, 45, 55, 55]
        );
        // A zero-width path is kept as a line.
        assert_eq!(
            hull(&[path(0, 0, None, &[0, 0, 100, 0])])[0].2,
            vec![0, 0, 100, 0]
        );
    }

    #[test]
    fn placements_carry_orientation_codes_and_arrays_expand() {
        let mut aref = record(AREF, &[]);
        aref.extend(record(SNAME, &text("leaf")));
        aref.extend(record(COLROW, &i16s(&[3, 2])));
        aref.extend(record(XY, &i32s(&[10, 20, 310, 20, 10, 220])));
        aref.extend(record(ENDEL, &[]));
        let lib = parse(&library(&[
            cell("leaf", &[boundary(1, 0, &[0, 0, 0, 1, 1, 1, 1, 0])]),
            cell(
                "top",
                &[
                    sref("leaf", 1, 2, false, 0.0),
                    sref("leaf", 0, 0, false, 90.0),
                    sref("leaf", 0, 0, false, 270.0),
                    sref("leaf", 0, 0, true, 0.0),
                    sref("leaf", 0, 0, true, 180.0),
                    aref,
                ],
            ),
        ]))
        .unwrap();
        assert_eq!(lib.top, 1);
        let placed: Vec<(usize, i32, i32, u8)> = lib.cells[1]
            .placements
            .iter()
            .map(|p| (p.cell, p.x, p.y, p.orientation))
            .collect();
        assert_eq!(
            placed,
            vec![
                (0, 1, 2, 0),
                (0, 0, 0, 1),
                (0, 0, 0, 3),
                (0, 0, 0, 4),
                (0, 0, 0, 6),
                (0, 10, 20, 0),
                (0, 10, 120, 0),
                (0, 110, 20, 0),
                (0, 110, 120, 0),
                (0, 210, 20, 0),
                (0, 210, 120, 0),
            ]
        );
    }

    #[test]
    fn texts_keep_their_layer_position_and_string() {
        let mut t = record(TEXT, &[]);
        t.extend(record(LAYER, &i16s(&[68])));
        t.extend(record(TEXTTYPE, &i16s(&[5])));
        t.extend(record(0x1701, &i16s(&[5])));
        t.extend(record(XY, &i32s(&[7, 8])));
        t.extend(record(STRING, &text("clk")));
        t.extend(record(ENDEL, &[]));
        let lib = parse(&library(&[cell("top", &[t])])).unwrap();
        let text = &lib.cells[0].texts[0];
        assert_eq!(
            (text.layer, text.x, text.y, text.string.as_str()),
            ((68, 5), 7, 8, "clk")
        );
    }

    #[test]
    fn malformed_streams_are_errors_that_name_the_problem() {
        let error = |data: Vec<u8>| parse(&data).unwrap_err().to_string();
        assert!(error(b"not a stream".to_vec()).contains("runs past the end"));
        assert!(error(record(0x0206, &[0; 4])[..3].to_vec()).contains("inside a record header"));
        assert!(error(record(0x0206, &[])).contains("HEADER"));
        let mut cut = library(&[cell("top", &[])]);
        cut.truncate(cut.len() - 2);
        assert!(error(cut).contains("inside a record header"));
        assert_eq!(
            error(library(&[cell(
                "top",
                &[sref("missing", 0, 0, false, 0.0)]
            )])),
            "top places missing, which the stream does not define"
        );
        assert_eq!(
            error(library(&[cell("a", &[]), cell("b", &[])])),
            "the stream has several top cells: a, b"
        );
        assert!(error(library(&[
            cell("leaf", &[]),
            cell("top", &[sref("leaf", 0, 0, false, 45.0)])
        ]))
        .contains("45°"));
        let mut mag = record(SREF, &[]);
        mag.extend(record(SNAME, &text("leaf")));
        mag.extend(record(MAG, &real(2.0)));
        mag.extend(record(XY, &i32s(&[0, 0])));
        mag.extend(record(ENDEL, &[]));
        assert!(
            error(library(&[cell("leaf", &[]), cell("top", &[mag])])).contains("magnification 2")
        );
        let context = cell(CONTEXT_CELL, &[]);
        assert_eq!(
            parse(&library(&[context, cell("top", &[])]))
                .unwrap()
                .cells
                .len(),
            1
        );
    }
}
