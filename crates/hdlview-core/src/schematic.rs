//! Semantic display descriptions. Geometry and layout remain frontend concerns.
use crate::{graph, model::*};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::{fs, io::Write, path::Path};

/// Publish an exported view only after the complete SVG has been written.
pub fn save_svg(path: &Path, svg: &str) -> Result<()> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
    {
        bail!("Choose a filename with the .svg extension");
    }
    if svg.len() > 32 * 1024 * 1024 || !svg.starts_with("<svg ") || !svg.ends_with("</svg>") {
        bail!("Invalid or oversized schematic SVG");
    }
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = path.with_file_name(format!(
        ".hdlview-svg-{}-{sequence}.tmp",
        std::process::id()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .with_context(|| format!("Cannot create SVG beside {}", path.display()))?;
    let result: std::io::Result<()> = (|| {
        file.write_all(svg.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.with_context(|| format!("Cannot save SVG {}", path.display()))
}

fn parameter(cell: &Cell, name: &str) -> Option<u64> {
    let value = cell.parameters.get(name)?;
    value.as_u64().or_else(|| {
        let text = value.as_str()?;
        if text.is_empty() || !text.bytes().all(|b| b == b'0' || b == b'1') {
            return None;
        }
        u64::from_str_radix(text, 2).ok()
    })
}

fn memory_flag(cell: &Cell, pin: &str, suffix: &str) -> Option<bool> {
    let width = cell.ports.iter().find(|p| p.name == pin)?.bits.len();
    if !(1..=64).contains(&width) {
        return None;
    }
    let all = u64::MAX >> (64 - width);
    match parameter(cell, &format!("{pin}_{suffix}"))? {
        0 => Some(false),
        value if value == all => Some(true),
        _ => None,
    }
}

/// Symbol and title of a library cell, from its Liberty-derived function.
/// Every connected signal pin must be one the function describes.
fn library<'a>(function: Option<&'a CellFunction>, cell: &Cell) -> Option<(&'a str, &'a str)> {
    let function = function?;
    cell.ports
        .iter()
        .all(|p| power(&p.name) || (p.bits.len() == 1 && function.pins.contains_key(&p.name)))
        .then_some((function.symbol.as_str(), function.title.as_str()))
}
pub(crate) fn power(name: &str) -> bool {
    matches!(name, "VPWR" | "VGND" | "VPB" | "VNB" | "VDD" | "VSS")
}
fn function<'a>(design: &'a Design, cell: &Cell) -> Option<&'a CellFunction> {
    design.modules.get(&cell.kind)?.function.as_ref()
}
pub fn is_physical(design: &Design, cell: &Cell) -> bool {
    library(function(design, cell), cell).is_some_and(|(symbol, _)| symbol == "physical")
}

fn describe(cell: &Cell, function: Option<&CellFunction>, node: &mut ViewNode) {
    let kind = cell.kind.strip_prefix('\\').unwrap_or(&cell.kind);
    let lib = library(function, cell);
    let function = function.filter(|_| lib.is_some());
    let (symbol, title) = lib.unwrap_or_else(|| match kind {
        "$and" => ("and", "AND"),
        "$or" => ("or", "OR"),
        "$xor" => ("xor", "XOR"),
        "$xnor" => ("xnor", "XNOR"),
        "$not" => ("not", "NOT"),
        "$logic_and" => ("and", "&&"),
        "$logic_or" => ("or", "||"),
        "$logic_not" => ("not", "!"),
        "$mux" | "$bmux" | "$bwmux" => ("mux", "MUX"),
        "$pmux" => ("mux", "1HOT MUX"),
        "$demux" => ("demux", "DEMUX"),
        "$tribuf" => ("buffer", "TRI"),
        "$dff" | "$dffe" | "$adff" | "$adffe" | "$sdff" | "$sdffe" | "$sdffce" | "$aldff"
        | "$aldffe" | "$dffsr" | "$dffsre" => ("register", "DFF"),
        "$dlatch" | "$adlatch" | "$dlatchsr" => ("latch", "LATCH"),
        "$mem_v2" | "$mem" | "$memrd" | "$memrd_v2" | "$memwr" | "$memwr_v2" => ("memory", "MEM"),
        "$add" => ("operator", "+"),
        "$sub" => ("operator", "−"),
        "$mul" => ("operator", "×"),
        "$div" | "$divfloor" => ("operator", "÷"),
        "$mod" | "$modfloor" => ("operator", "%"),
        "$eq" => ("operator", "="),
        "$eqx" => ("operator", "==="),
        "$ne" => ("operator", "≠"),
        "$nex" => ("operator", "!=="),
        "$lt" => ("operator", "<"),
        "$le" => ("operator", "≤"),
        "$gt" => ("operator", ">"),
        "$ge" => ("operator", "≥"),
        "$shl" | "$sshl" => ("operator", "≪"),
        "$shr" => ("operator", "≫"),
        "$sshr" => ("operator", ">>>"),
        "$shift" | "$shiftx" => ("operator", "SHIFT"),
        "$neg" => ("operator", "−"),
        "$pos" => ("operator", "+"),
        "$reduce_and" => ("operator", "&"),
        "$reduce_or" | "$reduce_bool" => ("operator", "|"),
        "$reduce_xor" => ("operator", "^"),
        "$reduce_xnor" => ("operator", "~^"),
        _ if node.child_scope.is_some() => ("module", kind),
        _ => ("unknown", kind),
    });
    let mut annotations = Vec::new();
    let width = parameter(cell, "WIDTH").or_else(|| parameter(cell, "Y_WIDTH"));
    if let Some(width) = width {
        annotations.push(format!("{width} bit{}", if width == 1 { "" } else { "s" }));
    }
    if parameter(cell, "A_SIGNED") == Some(1) || parameter(cell, "B_SIGNED") == Some(1) {
        annotations.push("signed operands".into());
    }
    if kind == "$pmux" {
        annotations.push("one-hot; multiple selects undefined".into());
    }
    if kind == "$bwmux" {
        annotations.push("bitwise select".into());
    }
    if kind == "$bmux" {
        annotations.push("binary select".into());
    }
    if matches!(kind, "$aldff" | "$aldffe") {
        annotations.push("asynchronous load".into());
    }
    if matches!(kind, "$sdffce") {
        annotations.push("enable gates synchronous reset".into());
    }
    if symbol == "memory" {
        if let Some(size) = parameter(cell, "SIZE") {
            annotations.push(format!("{size} words"));
        }
        for clock in ["RD_CLK", "WR_CLK"] {
            if let Some(enable) = cell.parameters.get(&format!("{clock}_ENABLE")) {
                annotations.push(format!("{clock} enabled={enable}"));
            }
            if let Some(polarity) = cell.parameters.get(&format!("{clock}_POLARITY")) {
                annotations.push(format!("{clock} polarity={polarity}"));
            }
        }
    }
    for key in ["ARST_VALUE", "SRST_VALUE"] {
        if let Some(value) = cell.parameters.get(key).and_then(Value::as_str) {
            annotations.push(format!(
                "{}={value}",
                if key == "ARST_VALUE" {
                    "async reset"
                } else {
                    "sync reset"
                }
            ));
        }
    }
    for p in &mut node.ports {
        let Some(pin) = p.display.as_mut() else {
            continue;
        };
        if let Some(width) = cell
            .attributes
            .get("formal_widths")
            .and_then(|v| v.get(&pin.name))
            .and_then(Value::as_u64)
        {
            pin.width = width as usize;
        }
        pin.role = if power(&pin.name) && lib.is_some() {
            PinRole::Power
        } else if matches!(symbol, "register" | "latch") {
            match pin.name.as_str() {
                "CLK" => PinRole::Clock,
                "EN" | "ALOAD" => PinRole::Enable,
                "ARST" | "SRST" | "CLR" => PinRole::Reset,
                "SET" => PinRole::Set,
                _ => PinRole::Data,
            }
        } else if symbol == "memory" {
            match pin.name.as_str() {
                "CLK" if parameter(cell, "CLK_ENABLE") == Some(1) => PinRole::Clock,
                "RD_CLK" | "WR_CLK" if memory_flag(cell, &pin.name, "ENABLE") == Some(true) => {
                    PinRole::Clock
                }
                "EN" | "RD_EN" | "WR_EN" => PinRole::Enable,
                _ => PinRole::Data,
            }
        } else if matches!(symbol, "mux" | "demux") && pin.name == "S" {
            PinRole::Select
        } else if symbol == "buffer" && pin.name == "EN" {
            PinRole::Enable
        } else {
            PinRole::Data
        };
        let key = match pin.role {
            PinRole::Clock => "CLK_POLARITY",
            PinRole::Enable if pin.name == "ALOAD" => "ALOAD_POLARITY",
            PinRole::Enable => "EN_POLARITY",
            PinRole::Reset if pin.name == "SRST" => "SRST_POLARITY",
            PinRole::Reset if pin.name == "CLR" => "CLR_POLARITY",
            PinRole::Reset => "ARST_POLARITY",
            PinRole::Set => "SET_POLARITY",
            _ => "",
        };
        pin.polarity = if symbol == "memory" && matches!(pin.name.as_str(), "RD_CLK" | "WR_CLK") {
            if pin.role == PinRole::Clock {
                memory_flag(cell, &pin.name, "POLARITY")
            } else {
                None
            }
        } else {
            parameter(cell, key).map(|v| v != 0)
        };
        if pin.role == PinRole::Enable && (symbol == "memory" || kind == "$tribuf") {
            pin.polarity = Some(true);
        }
        // A read port without a clock, an always-on read enable and a reset
        // tied low do nothing; such pins stay inspectable but are not drawn.
        let tied = |value: &str| {
            !pin.bits.is_empty()
                && pin
                    .bits
                    .iter()
                    .all(|b| matches!(b, Bit::Constant(v) if value.is_empty() || v == value))
        };
        if symbol == "memory"
            && match pin.name.as_str() {
                "RD_CLK" | "WR_CLK" => pin.role != PinRole::Clock && tied(""),
                "RD_EN" => tied("1"),
                "RD_ARST" | "RD_SRST" => tied("0"),
                _ => false,
            }
        {
            pin.role = PinRole::Unused;
        }
        // A two-way multiplexer names its inputs by the select value choosing them.
        if kind == "$mux" {
            match pin.name.as_str() {
                "A" => p.label = "0".into(),
                "B" => p.label = "1".into(),
                _ => {}
            }
        }
        // Only `SRST` resets on the clock.
        pin.asynchronous = pin.name == "ALOAD"
            || (matches!(pin.role, PinRole::Reset | PinRole::Set) && pin.name != "SRST");
        // A library cell's own description outranks every rule above.
        if let Some(known) = function.and_then(|f| f.pins.get(&pin.name)) {
            if pin.role != PinRole::Power {
                pin.role = known.role.clone();
                pin.polarity = known.polarity;
                pin.asynchronous = known.asynchronous;
                if let Some(label) = &known.label {
                    p.label = label.clone();
                }
            }
        }
    }
    // Compiler cells list pins alphabetically. Draw data first, then clock, enable
    // and resets; a memory lists its write side before its read side. Instances
    // keep their declaration order.
    if node.child_scope.is_none() {
        node.ports.sort_by_key(|p| {
            let Some(pin) = &p.display else {
                return 0;
            };
            if p.direction == "output" {
                return 6;
            }
            if symbol == "memory" {
                return u8::from(pin.name.starts_with("RD"));
            }
            match pin.role {
                PinRole::Data => 0,
                PinRole::Clock => 1,
                PinRole::Enable | PinRole::Select if !pin.asynchronous => 2,
                PinRole::Reset | PinRole::Set if !pin.asynchronous => 3,
                PinRole::Power | PinRole::Unused => 5,
                _ => 4,
            }
        });
    }
    node.display = Some(NodeDisplay {
        symbol: symbol.into(),
        title: title.into(),
        annotations,
        compound: function.and_then(|f| f.compound.clone()),
        ..Default::default()
    });
}

type Roles = BTreeMap<String, (PinRole, Option<bool>)>;

/// Pin roles of a primitive cell, as `describe` assigns them.
fn cell_roles(design: &Design, cell: &Cell) -> Roles {
    let mut node = ViewNode {
        id: String::new(),
        label: cell.name.clone(),
        kind: cell.kind.clone(),
        ports: cell
            .ports
            .iter()
            .map(|p| ViewPort {
                id: String::new(),
                label: p.name.clone(),
                direction: p.direction.clone(),
                signal_ids: vec![],
                display: Some(PinDisplay {
                    name: p.name.clone(),
                    width: p.bits.len(),
                    bits: p.bits.clone(),
                    ..PinDisplay::default()
                }),
                feeds: vec![],
            })
            .collect(),
        child_scope: None,
        source: None,
        display: None,
    };
    describe(cell, function(design, cell), &mut node);
    node.ports
        .into_iter()
        .filter_map(|p| p.display.map(|d| (d.name, (d.role, d.polarity))))
        .collect()
}

/// A module input is a clock, or a reset, when every pin it reaches inside the
/// module is one, followed through child instances. Anything else is data.
fn port_roles(design: &Design, module: &str, known: &mut BTreeMap<String, Roles>) -> Roles {
    if let Some(roles) = known.get(module) {
        return roles.clone();
    }
    let Some(m) = design.modules.get(module) else {
        return Roles::new();
    };
    let data = (PinRole::Data, None);
    let mut uses: BTreeMap<&Bit, Vec<(PinRole, Option<bool>)>> = BTreeMap::new();
    for cell in &m.cells {
        let roles = if design.modules.get(&cell.kind).is_some_and(|c| !c.blackbox) {
            port_roles(design, &cell.kind, known)
        } else {
            cell_roles(design, cell)
        };
        for p in cell.ports.iter().filter(|p| p.direction != "output") {
            let role = roles.get(&p.name).unwrap_or(&data);
            for bit in &p.bits {
                uses.entry(bit).or_default().push(role.clone());
            }
        }
    }
    for p in m.ports.iter().filter(|p| p.direction != "input") {
        for bit in &p.bits {
            uses.entry(bit).or_default().push(data.clone());
        }
    }
    let roles: Roles = m
        .ports
        .iter()
        .filter(|p| p.direction == "input")
        .map(|p| {
            let reached: Vec<_> = p
                .bits
                .iter()
                .flat_map(|bit| uses.get(bit).into_iter().flatten())
                .collect();
            let role = match reached.first() {
                Some((role @ (PinRole::Clock | PinRole::Reset), polarity))
                    if reached.iter().all(|(other, _)| other == role) =>
                {
                    let agreed = reached.iter().all(|(_, other)| other == polarity);
                    (role.clone(), polarity.filter(|_| agreed))
                }
                _ => data.clone(),
            };
            (p.name.clone(), role)
        })
        .collect();
    known.insert(module.into(), roles.clone());
    roles
}

/// The declared net a register drives, such as `count` or `count[2]`, when one
/// declaration names every Q bit in order.
fn driven_name(module: &Module, cell: &Cell) -> Option<String> {
    let q = &cell.ports.iter().find(|p| p.name == "Q")?.bits;
    if q.is_empty() {
        return None;
    }
    let declared = || module.signals.iter().filter(|s| !s.hidden);
    if let Some(signal) = declared().find(|s| &s.bits == q) {
        return Some(signal.name.clone());
    }
    declared().find_map(|s| {
        let low = s.bits.windows(q.len()).position(|w| w == q.as_slice())?;
        let index = |i| s.index(i);
        Some(if q.len() == 1 {
            format!("{}[{}]", s.name, index(low))
        } else {
            format!("{}[{}:{}]", s.name, index(low + q.len() - 1), index(low))
        })
    })
}

pub fn view(
    snapshot: &DesignSnapshot,
    scope: &[String],
    focus: Option<&str>,
    limit: usize,
    split: bool,
    options: &SchematicOptions,
) -> Result<GraphView> {
    let sc = snapshot.design.scope(scope).context("Unknown scope")?;
    let module = &snapshot.design.modules[&sc.module];
    let mut view = graph::view_for_schematic(
        snapshot,
        scope,
        focus,
        limit,
        split,
        options.show_physical_cells,
    )?;
    let cells: BTreeMap<_, _> = module
        .cells
        .iter()
        .map(|cell| (cell.name.as_str(), cell))
        .collect();
    let mut instance_roles = BTreeMap::new();
    for node in &mut view.nodes {
        if let Some(cell) = cells
            .get(node.label.as_str())
            .filter(|cell| node.kind == cell.kind)
        {
            describe(cell, function(&snapshot.design, cell), node);
            if node.child_scope.is_some() {
                let roles = port_roles(&snapshot.design, &cell.kind, &mut instance_roles);
                for pin in node.ports.iter_mut().filter_map(|p| p.display.as_mut()) {
                    if let Some((role, polarity)) = roles.get(&pin.name) {
                        pin.role = role.clone();
                        pin.polarity = *polarity;
                    }
                }
            }
            if let Some(display) = node.display.as_mut() {
                if matches!(display.symbol.as_str(), "register" | "latch") {
                    if let Some(name) = driven_name(module, cell) {
                        display.title = name;
                    }
                }
            }
        } else {
            let symbol = match node.kind.as_str() {
                "port" => "port",
                "off_view" => "connector",
                _ => "unknown",
            };
            node.display = Some(NodeDisplay {
                symbol: symbol.into(),
                title: node.label.clone(),
                ..Default::default()
            });
        }
    }
    // Labels name declared user nets; compiler temporaries remain inspectable
    // through identities and tooltips instead of dominating the drawing. Width
    // is drawn from the net itself, so it is not repeated in the name.
    let names: BTreeMap<_, _> = module
        .signals
        .iter()
        .filter(|s| !s.hidden)
        .map(|s| {
            let mut path = scope.to_vec();
            path.push(s.name.clone());
            (identity(&snapshot.id, &path, "signal"), s)
        })
        .collect();
    for edge in &mut view.edges {
        // A wider net is not labelled with a declaration that names only part of it.
        let named = edge
            .signal_ids
            .iter()
            .filter_map(|id| names.get(id))
            .find(|signal| edge.bits.iter().all(|bit| signal.bits.contains(bit)));
        edge.label = match named {
            Some(signal) => {
                let positions: Vec<_> = signal
                    .bits
                    .iter()
                    .enumerate()
                    .filter(|(_, bit)| edge.bits.contains(bit))
                    .map(|(i, _)| signal.index(i))
                    .collect();
                let contiguous = positions
                    .windows(2)
                    .all(|pair| (pair[1] - pair[0]).abs() == 1);
                let slice = match (positions.first(), positions.last()) {
                    _ if positions.len() == signal.bits.len() => String::new(),
                    (Some(low), Some(high)) if contiguous && low != high => {
                        format!("[{high}:{low}]")
                    }
                    _ => format!(
                        "[{}]",
                        positions
                            .iter()
                            .rev()
                            .map(i64::to_string)
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                };
                format!("{}{slice}", signal.name)
            }
            None => String::new(),
        };
    }
    if snapshot.representation == Representation::Elaborated
        && (options.functional_symbols || options.detail.is_some())
    {
        let groups = groups(&view, &identity(&snapshot.id, scope, "scope"));
        if let Some(detail) = &options.detail {
            let group = groups
                .iter()
                .find(|g| &g.id == detail)
                .context("Unknown schematic detail")?;
            let members = &group.display.as_ref().context("Group metadata")?.members;
            focus_group(&mut view, members);
            view.detail = Some(detail.clone());
        } else if options.functional_symbols {
            collapse(&mut view, groups);
        }
    } else if options.detail.is_some() {
        bail!("Only elaborated schematics have detail views")
    }
    Ok(view)
}

fn pin<'a>(n: &'a ViewNode, name: &str) -> Option<&'a PinDisplay> {
    n.ports
        .iter()
        .filter_map(|p| p.display.as_ref())
        .find(|p| p.name == name)
}
fn constant(bits: &[Bit]) -> Option<u64> {
    if bits.len() > 32 {
        return None;
    }
    let mut value = 0;
    for (i, b) in bits.iter().enumerate() {
        match b {
            Bit::Constant(s) if s == "0" => {}
            Bit::Constant(s) if s == "1" => value |= 1 << i,
            _ => return None,
        }
    }
    Some(value)
}

fn groups<'a>(view: &'a GraphView, scope_id: &str) -> Vec<ViewNode> {
    let group_id = |members: &[String]| {
        format!(
            "{scope_id}:group:{}",
            serde_json::to_string(members).expect("string IDs")
        )
    };
    let mut candidates: Vec<(String, String, Vec<&ViewNode>)> = Vec::new();
    let mut banks: BTreeMap<Vec<Bit>, Vec<(&ViewNode, u64)>> = BTreeMap::new();
    for n in &view.nodes {
        if n.kind == "$logic_not" {
            if let (Some(a), Some(y)) = (pin(n, "A"), pin(n, "Y")) {
                if y.width == 1 && (1..=5).contains(&a.width) && constant(&a.bits).is_none() {
                    banks.entry(a.bits.clone()).or_default().push((n, 0));
                }
            }
            continue;
        }
        if n.kind != "$eq" {
            continue;
        }
        let (Some(a), Some(b), Some(y)) = (pin(n, "A"), pin(n, "B"), pin(n, "Y")) else {
            continue;
        };
        if y.width != 1 || a.width != b.width || !(1..=5).contains(&a.width) {
            continue;
        }
        let pair = constant(&b.bits)
            .map(|v| (a, v))
            .or_else(|| constant(&a.bits).map(|v| (b, v)));
        if let Some((input, value)) = pair {
            banks
                .entry(input.bits.clone())
                .or_default()
                .push((n, value));
        }
    }
    for (input, mut bank) in banks {
        bank.sort_by_key(|(_, v)| *v);
        bank.dedup_by_key(|(_, value)| *value);
        if bank.len() != 1 << input.len()
            || !bank.iter().enumerate().all(|(i, (_, v))| i as u64 == *v)
        {
            continue;
        }
        candidates.push((
            "decoder".into(),
            format!("DEC {} → {}", input.len(), bank.len()),
            bank.into_iter().map(|(n, _)| n).collect(),
        ));
    }
    let muxes: Vec<&ViewNode> = view.nodes.iter().filter(|n| n.kind == "$mux").collect();
    let producers: BTreeMap<Vec<Bit>, &ViewNode> = muxes
        .iter()
        .filter_map(|n| pin(n, "Y").map(|p| (p.bits.clone(), *n)))
        .collect();
    for root in &muxes {
        let Some(y) = pin(root, "Y") else {
            continue;
        };
        if muxes.iter().any(|other| {
            other.id != root.id
                && ["A", "B"]
                    .iter()
                    .any(|p| pin(other, p).is_some_and(|p| p.bits == y.bits))
        }) {
            continue;
        }
        let mut members = vec![];
        let mut stack = vec![(*root, 0)];
        let mut seen = BTreeSet::new();
        let mut levels: BTreeMap<Vec<Bit>, usize> = BTreeMap::new();
        let mut depth_selects: BTreeMap<usize, Vec<Bit>> = BTreeMap::new();
        let mut uniform_depth = true;
        let mut leaf_depth = None;
        let mut encoder_codes = BTreeSet::new();
        let mut default_code = None;
        let mut encoder = true;
        let mut complete = true;
        while let Some((n, depth)) = stack.pop() {
            if !seen.insert(n.id.clone()) {
                complete = false;
                break;
            }
            let (Some(a), Some(b), Some(sel), Some(out)) =
                (pin(n, "A"), pin(n, "B"), pin(n, "S"), pin(n, "Y"))
            else {
                complete = false;
                break;
            };
            if a.width != y.width || b.width != y.width || out.width != y.width || sel.width != 1 {
                complete = false;
                break;
            }
            *levels.entry(sel.bits.clone()).or_default() += 1;
            if let Some(existing) = depth_selects.get(&depth) {
                uniform_depth &= *existing == sel.bits;
            } else {
                depth_selects.insert(depth, sel.bits.clone());
            }
            members.push(n);
            encoder &= constant(&b.bits).is_some_and(|code| encoder_codes.insert(code))
                && sel.bits.iter().all(|bit| matches!(bit, Bit::Wire(_)));
            for data in [a, b] {
                if let Some(child) = producers.get(&data.bits) {
                    stack.push((*child, depth + 1));
                } else {
                    if let Some(first) = leaf_depth {
                        uniform_depth &= first == depth + 1;
                    } else {
                        leaf_depth = Some(depth + 1);
                    }
                    if constant(&data.bits).is_none() {
                        encoder = false;
                    }
                    if data.name == "A" {
                        default_code = constant(&data.bits);
                    }
                }
            }
            if members.len() > 63 {
                complete = false;
                break;
            }
        }
        if !complete || members.len() < 2 {
            continue;
        }
        // A binary mux tree uses each select once per complete level; priority
        // chains use different predicates and retain their default leaf exactly.
        let mut counts: Vec<usize> = levels.values().copied().collect();
        counts.sort();
        let uniform = uniform_depth
            && counts.iter().enumerate().all(|(i, c)| *c == 1 << i)
            && members.len() + 1 == 1 << counts.len();
        let complete_codes = default_code.is_some_and(|default| {
            let mut codes = encoder_codes.clone();
            codes.insert(default);
            codes.len() == members.len() + 1
                && codes.iter().enumerate().all(|(i, code)| *code == i as u64)
        });
        if encoder && complete_codes && levels.len() == members.len() {
            candidates.push((
                "encoder".into(),
                format!("PRI ENC {} → {}", members.len(), y.width),
                members,
            ));
        } else if uniform {
            candidates.push((
                "mux".into(),
                format!("MUX {}:1", members.len() + 1),
                members,
            ));
        }
    }
    let mut used = BTreeSet::new();
    let mut result = Vec::new();
    for (symbol, title, members) in candidates {
        let member_ids: BTreeSet<&str> = members.iter().map(|n| n.id.as_str()).collect();
        if member_ids.iter().any(|id| used.contains(*id)) {
            continue;
        }
        let member_ports: BTreeSet<&str> = members
            .iter()
            .flat_map(|n| n.ports.iter().map(|p| p.id.as_str()))
            .collect();
        let mut outside = BTreeSet::new();
        let mut internal = BTreeSet::new();
        let mut reject = false;
        for e in &view.edges {
            let has_member = e
                .sources
                .iter()
                .chain(&e.targets)
                .any(|p| member_ports.contains(p.as_str()));
            if !has_member {
                continue;
            }
            if e.sources.len() > 1 && e.sources.iter().any(|p| member_ports.contains(p.as_str())) {
                reject = true;
            }
            let all_member = e
                .sources
                .iter()
                .chain(&e.targets)
                .all(|p| member_ports.contains(p.as_str()));
            if all_member {
                internal.extend(e.signal_ids.clone());
            } else {
                // An intermediate mux output used outside the tree cannot disappear.
                if symbol != "decoder"
                    && e.sources.iter().any(|p| member_ports.contains(p.as_str()))
                    && e.targets.iter().any(|p| member_ports.contains(p.as_str()))
                {
                    reject = true;
                }
                outside.extend(
                    e.sources
                        .iter()
                        .chain(&e.targets)
                        .filter(|p| member_ports.contains(p.as_str()))
                        .cloned(),
                );
            }
        }
        if reject {
            continue;
        }
        // Constant and undriven inputs have no edge, yet remain inputs of the group.
        outside.extend(
            members
                .iter()
                .flat_map(|n| &n.ports)
                .filter(|p| p.feeds.iter().any(|f| !matches!(f, Feed::Net { .. })))
                .map(|p| p.id.clone()),
        );
        let mut ids: Vec<String> = member_ids.into_iter().map(String::from).collect();
        ids.sort();
        let id = group_id(&ids);
        let mut ports: Vec<ViewPort> = Vec::new();
        let mut data_codes = BTreeMap::new();
        if symbol == "mux" {
            let mut stack = vec![(members[0], 0u64)];
            while let Some((node, code)) = stack.pop() {
                for (name, bit) in [("A", 0), ("B", 1)] {
                    if let Some(data) = pin(node, name) {
                        if let Some(child) = members
                            .iter()
                            .find(|n| pin(n, "Y").is_some_and(|p| p.bits == data.bits))
                        {
                            stack.push((child, (code << 1) | bit));
                        } else if let Some(port) = node
                            .ports
                            .iter()
                            .find(|p| p.display.as_ref().is_some_and(|p| p.name == name))
                        {
                            data_codes.insert(port.id.clone(), (code << 1) | bit);
                        }
                    }
                }
            }
        }
        let mut annotations = Vec::new();
        if symbol == "encoder" {
            for (i, member) in members.iter().enumerate() {
                if let Some(code) = pin(member, "B").and_then(|p| constant(&p.bits)) {
                    annotations.push(format!("priority {i} → {code}"));
                }
                if let Some(code) = pin(member, "A").and_then(|p| constant(&p.bits)) {
                    annotations.push(format!("default → {code}"));
                }
            }
        }
        for (member_index, member) in members.iter().enumerate() {
            for port in &member.ports {
                if !outside.contains(&port.id) {
                    continue;
                }
                let Some(meta) = &port.display else {
                    continue;
                };
                if symbol != "mux" && port.direction == "input" && constant(&meta.bits).is_some() {
                    continue;
                }
                if port.direction == "input" {
                    if let Some(existing) = ports.iter_mut().find(|p| {
                        p.direction == "input"
                            && p.display
                                .as_ref()
                                .is_some_and(|d| d.bits == meta.bits && d.role == meta.role)
                    }) {
                        if let Some(code) = data_codes.get(&port.id) {
                            existing.label = format!("{}, [{code}]", existing.label);
                        }
                        continue;
                    }
                }
                let mut port = port.clone();
                if let Some(code) = data_codes.get(&port.id) {
                    port.label = format!("[{code}]");
                }
                if symbol == "decoder" && port.direction == "output" {
                    port.label = format!("[{member_index}]");
                }
                if symbol == "encoder" && meta.role == PinRole::Select {
                    port.label = format!("priority {member_index}");
                    if let Some(d) = &mut port.display {
                        d.role = PinRole::Data;
                    }
                }
                ports.push(port);
            }
        }
        used.extend(ids.clone());
        annotations.push("presentation group · inspect original nodes".into());
        result.push(ViewNode {
            id: id.clone(),
            label: title.clone(),
            kind: format!("functional {symbol}"),
            ports,
            child_scope: None,
            source: members.first().and_then(|n| n.source.clone()),
            display: Some(NodeDisplay {
                symbol,
                title,
                members: ids,
                annotations,
                internal_signal_ids: internal.into_iter().collect(),
                detail: Some(id),
                ..Default::default()
            }),
        });
    }
    // A one-hot multiplexer whose every select is an exclusive comparison of one
    // signal with a distinct constant is a case statement. Draw it as one
    // multiplexer selected by that signal, with data inputs named by case value.
    let owner = |port: &str| {
        view.nodes
            .iter()
            .find(|n| n.ports.iter().any(|p| p.id == port))
    };
    let named = |n: &'a ViewNode, name: &str| -> Vec<&'a ViewPort> {
        n.ports
            .iter()
            .filter(|p| p.display.as_ref().is_some_and(|d| d.name == name))
            .collect()
    };
    for root in view.nodes.iter().filter(|n| n.kind == "$pmux") {
        let (selects, data) = (named(root, "S"), named(root, "B"));
        let (Some(default), Some(output)) = (named(root, "A").pop(), named(root, "Y").pop()) else {
            continue;
        };
        if selects.len() < 2 || selects.len() != data.len() {
            continue;
        }
        let mut members = vec![root];
        let mut internal = BTreeSet::new();
        let mut cases: BTreeMap<u64, &ViewPort> = BTreeMap::new();
        let mut selector: Option<&ViewPort> = None;
        for (select, case) in selects.iter().zip(&data) {
            let Some(edge) = view.edges.iter().find(|e| e.targets.contains(&select.id)) else {
                break;
            };
            let Some(compare) = edge.sources.first().and_then(|id| owner(id)) else {
                break;
            };
            let operand = match compare.kind.as_str() {
                "$logic_not" => named(compare, "A").pop().map(|a| (a, 0)),
                "$eq" => match (named(compare, "A").pop(), named(compare, "B").pop()) {
                    (Some(a), Some(b)) => {
                        let value =
                            |p: &ViewPort| p.display.as_ref().and_then(|d| constant(&d.bits));
                        value(b)
                            .map(|v| (a, v))
                            .or_else(|| value(a).map(|v| (b, v)))
                    }
                    _ => None,
                },
                _ => None,
            };
            let Some((input, value)) = operand else {
                break;
            };
            let bits = |p: &ViewPort| p.display.as_ref().map(|d| d.bits.clone());
            if edge.sources.len() != 1
                || edge.targets.len() != 1
                || bits(input).is_none_or(|b| constant(&b).is_some())
                || selector.is_some_and(|s| bits(s) != bits(input))
                || cases.insert(value, case).is_some()
            {
                break;
            }
            selector.get_or_insert(input);
            members.push(compare);
            internal.extend(edge.signal_ids.clone());
        }
        let Some(selector) = selector else {
            continue;
        };
        let mut ids: Vec<String> = members.iter().map(|n| n.id.clone()).collect();
        ids.sort();
        ids.dedup();
        if cases.len() != selects.len()
            || ids.len() != members.len()
            || ids.iter().any(|id| used.contains(id))
        {
            continue;
        }
        let relabel = |port: &ViewPort, label: String, role: PinRole| {
            let mut port = port.clone();
            port.label = label;
            if let Some(d) = &mut port.display {
                d.role = role;
            }
            port
        };
        // An undefined default is not an input: no case selects it.
        let undefined = default.display.as_ref().is_some_and(|d| {
            d.bits
                .iter()
                .all(|b| matches!(b, Bit::Constant(v) if v == "x"))
        });
        let mut ports: Vec<ViewPort> = cases
            .iter()
            .map(|(value, port)| relabel(port, value.to_string(), PinRole::Data))
            .collect();
        if !undefined {
            ports.push(relabel(default, "default".into(), PinRole::Data));
        }
        let title = format!("MUX {}:1", ports.len());
        ports.push(relabel(selector, "SEL".into(), PinRole::Select));
        ports.push(output.clone());
        let id = group_id(&ids);
        used.extend(ids.clone());
        result.push(ViewNode {
            id: id.clone(),
            label: title.clone(),
            kind: "functional mux".into(),
            ports,
            child_scope: None,
            source: root.source.clone(),
            display: Some(NodeDisplay {
                symbol: "mux".into(),
                title,
                members: ids,
                annotations: vec![
                    "case statement".into(),
                    "presentation group · inspect original nodes".into(),
                ],
                internal_signal_ids: internal.into_iter().collect(),
                detail: Some(id),
                ..Default::default()
            }),
        });
    }
    result
}
fn collapse(view: &mut GraphView, groups: Vec<ViewNode>) {
    for group in groups {
        let Some(display) = &group.display else {
            continue;
        };
        let members: BTreeSet<&str> = display.members.iter().map(String::as_str).collect();
        let original: Vec<&ViewPort> = view
            .nodes
            .iter()
            .filter(|n| members.contains(n.id.as_str()))
            .flat_map(|n| &n.ports)
            .collect();
        let ports: BTreeSet<String> = original.iter().map(|p| p.id.clone()).collect();
        let mut aliases = BTreeMap::new();
        for port in original {
            let replacement = group.ports.iter().find(|p| p.id == port.id).or_else(|| {
                (port.direction == "input")
                    .then(|| {
                        group.ports.iter().find(|p| {
                            p.direction == "input"
                                && p.display
                                    .as_ref()
                                    .zip(port.display.as_ref())
                                    .is_some_and(|(a, b)| a.bits == b.bits && a.role == b.role)
                        })
                    })
                    .flatten()
            });
            if let Some(p) = replacement {
                aliases.insert(port.id.clone(), p.id.clone());
            }
        }
        view.edges.retain(|e| {
            !e.sources
                .iter()
                .chain(&e.targets)
                .all(|p| ports.contains(p))
        });
        for edge in &mut view.edges {
            for endpoints in [&mut edge.sources, &mut edge.targets] {
                endpoints.retain(|p| !ports.contains(p) || aliases.contains_key(p));
                for p in endpoints.iter_mut() {
                    if let Some(next) = aliases.get(p) {
                        *p = next.clone();
                    }
                }
                endpoints.sort();
                endpoints.dedup();
            }
        }
        view.edges
            .retain(|e| !e.sources.is_empty() && !e.targets.is_empty());
        view.nodes.retain(|n| !members.contains(n.id.as_str()));
        view.nodes.push(group);
    }
}
fn focus_group(view: &mut GraphView, members: &[String]) {
    let member_ids: BTreeSet<&str> = members.iter().map(String::as_str).collect();
    let ports: BTreeSet<String> = view
        .nodes
        .iter()
        .filter(|n| member_ids.contains(n.id.as_str()))
        .flat_map(|n| n.ports.iter().map(|p| p.id.clone()))
        .collect();
    view.edges.retain(|e| {
        e.sources
            .iter()
            .chain(&e.targets)
            .any(|p| ports.contains(p))
    });
    let used: BTreeSet<String> = view
        .edges
        .iter()
        .flat_map(|e| e.sources.iter().chain(&e.targets).cloned())
        .collect();
    view.nodes.retain(|n| {
        member_ids.contains(n.id.as_str()) || n.ports.iter().any(|p| used.contains(&p.id))
    });
    for n in &mut view.nodes {
        if !member_ids.contains(n.id.as_str()) {
            n.ports.retain(|p| used.contains(&p.id));
            n.display = Some(NodeDisplay {
                symbol: "connector".into(),
                title: n.label.clone(),
                ..Default::default()
            });
            n.child_scope = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn snapshot(module: Value) -> DesignSnapshot {
        snapshot_of(graph::from_yosys(&json!({"modules":{"top":module}}), "top").unwrap())
    }
    fn snapshot_of(design: Design) -> DesignSnapshot {
        serde_json::from_value(json!({"schema_version":2,"id":"fixture","representation":"elaborated","project":{"schema_version":3,"name":"fixture","top":"top","sources":[]},"profile":{"provider":"native"},"directory":"/tmp/fixture","design":design,"diagnostics":[],"tool_versions":{},"input_hashes":{},"artifact_hashes":{},"source_origins":{},"netlist":null,"sdf":{}})).unwrap()
    }
    fn mux(a: u64, b: u64, s: u64, y: u64) -> Value {
        json!({"type":"$mux","parameters":{"WIDTH":"1"},"port_directions":{"A":"input","B":"input","S":"input","Y":"output"},"connections":{"A":[a],"B":[b],"S":[s],"Y":[y]}})
    }
    fn tree(exposed: bool) -> DesignSnapshot {
        let mut module = json!({"ports":{"a":{"direction":"input","bits":[2]},"b":{"direction":"input","bits":[3]},"c":{"direction":"input","bits":[4]},"d":{"direction":"input","bits":[5]},"s":{"direction":"input","bits":[6,7]},"y":{"direction":"output","bits":[10]}},"netnames":{"mid":{"bits":[8]},"y":{"bits":[10]}},"cells":{"low":mux(2,3,6,8),"high":mux(4,5,6,9),"root":mux(8,9,7,10)}});
        if exposed {
            module["ports"]["probe"] = json!({"direction":"output","bits":[8]});
        }
        snapshot(module)
    }
    fn draw(s: &DesignSnapshot) -> GraphView {
        view(
            s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap()
    }
    #[test]
    fn svg_publication_keeps_existing_export_on_invalid_input() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schematic.svg");
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>counter</text></svg>";
        save_svg(&path, svg).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), svg);
        assert!(save_svg(&path, "not SVG").is_err());
        assert!(save_svg(&path.with_extension("sv"), svg).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), svg);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    #[test]
    fn parameters_preserve_polarity_and_absent_ones_are_not_serialized() {
        let s = snapshot(
            json!({"cells":{"ff":{"type":"$adff","parameters":{"CLK_POLARITY":"0","ARST_POLARITY":"0","ARST_VALUE":"0010","WIDTH":"100"},"port_directions":{"D":"input","Q":"output","CLK":"input","ARST":"input"},"connections":{"D":[2,3,4,5],"Q":[6,7,8,9],"CLK":[10],"ARST":[11]}}}}),
        );
        let v = draw(&s);
        let ff = v.nodes.iter().find(|n| n.label == "ff").unwrap();
        assert_eq!(pin(ff, "CLK").unwrap().polarity, Some(false));
        assert_eq!(pin(ff, "ARST").unwrap().role, PinRole::Reset);
        assert!(ff
            .display
            .as_ref()
            .unwrap()
            .annotations
            .contains(&"async reset=0010".into()));
        let old: Cell = serde_json::from_value(
            json!({"name":"old","kind":"$dff","ports":[],"source":null,"attributes":{}}),
        )
        .unwrap();
        let bytes = serde_json::to_value(old).unwrap();
        assert!(bytes.get("parameters").is_none());
    }
    #[test]
    fn memory_clock_masks_do_not_invent_uniform_polarity_or_invert_async_inputs() {
        let mut s = snapshot(
            json!({"cells":{"memory":{"type":"$mem_v2","parameters":{"RD_CLK_ENABLE":"11","RD_CLK_POLARITY":"01"},"port_directions":{"RD_CLK":"input"},"connections":{"RD_CLK":[2,3]}}}}),
        );
        for (enable, polarity, role, expected) in [
            ("11", "01", PinRole::Clock, None),
            ("01", "01", PinRole::Data, None),
            ("00", "00", PinRole::Data, None),
            ("11", "00", PinRole::Clock, Some(false)),
            ("11", "11", PinRole::Clock, Some(true)),
        ] {
            let cell = &mut s.design.modules.get_mut("top").unwrap().cells[0];
            cell.parameters
                .insert("RD_CLK_ENABLE".into(), json!(enable));
            cell.parameters
                .insert("RD_CLK_POLARITY".into(), json!(polarity));
            let v = draw(&s);
            let memory = v.nodes.iter().find(|n| n.label == "memory").unwrap();
            assert_eq!(pin(memory, "RD_CLK").unwrap().role, role);
            assert_eq!(pin(memory, "RD_CLK").unwrap().polarity, expected);
        }
    }
    #[test]
    fn rtl_pins_prefer_declared_aliases_while_gate_pins_keep_endpoint_identity() {
        let mut s = snapshot(
            json!({"netnames":{"$temporary":{"bits":[2],"hide_name":1},"mid":{"bits":[2]}},"cells":{"buf":{"type":"$not","port_directions":{"A":"input","Y":"output"},"connections":{"A":[2],"Y":[3]}}}}),
        );
        let v = draw(&s);
        let buf = v.nodes.iter().find(|n| n.label == "buf").unwrap();
        assert!(buf.ports[0].signal_ids[0].ends_with("\"mid\"]"));
        assert!(buf.ports[0]
            .signal_ids
            .iter()
            .any(|id| id.contains("$temporary")));
        s.representation = Representation::Mapped;
        let v = draw(&s);
        assert!(
            v.nodes.iter().find(|n| n.label == "buf").unwrap().ports[0].signal_ids[0]
                .ends_with("\"buf\",\"A\"]")
        );
    }
    #[test]
    fn mux_group_retains_identity_and_reveals_original_structure() {
        let s = tree(false);
        let scope = vec!["top".into()];
        let v = view(&s, &scope, None, 2000, false, &SchematicOptions::default()).unwrap();
        let group = v.nodes.iter().find(|n| n.kind == "functional mux").unwrap();
        let d = group.display.as_ref().unwrap();
        assert_eq!(d.members.len(), 3);
        assert!(d.internal_signal_ids.iter().any(|id| id.contains("mid")));
        let original = view(
            &s,
            &scope,
            None,
            2000,
            false,
            &SchematicOptions {
                functional_symbols: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            v.signals.iter().map(|s| &s.id).collect::<Vec<_>>(),
            original.signals.iter().map(|s| &s.id).collect::<Vec<_>>()
        );
        let ports: BTreeSet<_> = v
            .nodes
            .iter()
            .flat_map(|n| n.ports.iter().map(|p| &p.id))
            .collect();
        assert!(v.edges.iter().all(|e| e
            .sources
            .iter()
            .chain(&e.targets)
            .all(|p| ports.contains(p))));
        let detail = view(
            &s,
            &scope,
            None,
            2000,
            false,
            &SchematicOptions {
                detail: Some(group.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(detail.nodes.iter().filter(|n| n.kind == "$mux").count(), 3);
        assert!(view(
            &tree(true),
            &scope,
            None,
            2000,
            false,
            &SchematicOptions::default()
        )
        .unwrap()
        .nodes
        .iter()
        .all(|n| n.kind != "functional mux"));
    }
    #[test]
    fn complete_decoder_bank_groups_but_partial_bank_does_not() {
        let mut cells = serde_json::Map::new();
        for i in 0..4 {
            cells.insert(format!("eq{i}"),json!({"type":"$eq","port_directions":{"A":"input","B":"input","Y":"output"},"connections":{"A":[2,3],"B":[if i&1==0 {"0"} else {"1"},if i&2==0 {"0"} else {"1"}],"Y":[10+i]}}));
        }
        let s = snapshot(
            json!({"ports":{"in":{"direction":"input","bits":[2,3]},"out":{"direction":"output","bits":[10,11,12,13]}},"cells":cells}),
        );
        let v = draw(&s);
        let decoder = v
            .nodes
            .iter()
            .find(|n| n.kind == "functional decoder")
            .unwrap();
        assert_eq!(decoder.ports.len(), 5);
        let mut partial = s.clone();
        partial.design.modules.get_mut("top").unwrap().cells.pop();
        assert!(draw(&partial)
            .nodes
            .iter()
            .all(|n| n.kind != "functional decoder"));
    }
    #[test]
    fn bounded_views_end_a_cut_bus_in_one_connector_and_mark_undriven_pins() {
        let s = snapshot(
            json!({"cells":{"a":{"type":"$and","port_directions":{"A":"input","B":"input","Y":"output"},"connections":{"A":[3,5],"B":[8,9],"Y":[4,6]}},"b":{"type":"$not","port_directions":{"A":"input","Y":"output"},"connections":{"A":[2,7],"Y":[3,5]}}}}),
        );
        let v = view(
            &s,
            &["top".into()],
            None,
            1,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
        let outside: Vec<_> = v.nodes.iter().filter(|n| n.kind == "off_view").collect();
        assert_eq!(outside.len(), 1);
        assert_eq!(outside[0].ports[0].display.as_ref().unwrap().width, 2);
        let a = v.nodes.iter().find(|n| n.label == "a").unwrap();
        assert!(matches!(
            a.ports[0].feeds.as_slice(),
            [Feed::Net { width: 2, label, .. }] if label.is_empty()
        ));
        assert_eq!(a.ports[1].feeds, vec![Feed::Undriven { width: 2 }]);
        assert_eq!(v.nodes.len(), 2);
    }
    #[test]
    fn a_bus_is_one_net_and_each_load_records_the_part_it_takes() {
        let s = snapshot(json!({
            "ports":{"a":{"direction":"input","bits":[2,3,4,5,6,7,8,9]},"y":{"direction":"output","bits":[10,11,12,13]},"any":{"direction":"output","bits":[14]}},
            "netnames":{"a":{"bits":[2,3,4,5,6,7,8,9],"offset":8}},
            "cells":{
                "low":{"type":"$not","port_directions":{"A":"input","Y":"output"},"connections":{"A":[2,3,4,5],"Y":[10,11,12,13]}},
                "wide":{"type":"$reduce_or","port_directions":{"A":"input","Y":"output"},"connections":{"A":[2,3,4,5,6,7,8,9],"Y":[14]}},
                "sign":{"type":"$and","port_directions":{"A":"input","B":"input","Y":"output"},"connections":{"A":[9,9,9,9],"B":["1","0","0",20],"Y":[15,16,17,18]}}}}));
        let v = draw(&s);
        // Constants, unread outputs and undriven inputs add no node.
        assert_eq!(v.nodes.len(), 6);
        let port = |cell: &str, pin: &str| {
            v.nodes
                .iter()
                .find(|n| n.label == cell)
                .and_then(|n| {
                    n.ports
                        .iter()
                        .find(|p| p.display.as_ref().is_some_and(|d| d.name == pin))
                })
                .unwrap()
        };
        let bus: Vec<_> = v
            .edges
            .iter()
            .filter(|e| e.sources == [port("a", "a").id.clone()])
            .collect();
        assert_eq!(bus.len(), 1);
        assert_eq!(bus[0].bits.len(), 8);
        assert_eq!(bus[0].targets.len(), 3);
        let net = |width, label: &str| Feed::Net {
            edge: bus[0].id.clone(),
            width,
            label: label.into(),
        };
        assert_eq!(port("wide", "A").feeds, vec![net(8, "")]);
        assert_eq!(port("low", "A").feeds, vec![net(4, "[11:8]")]);
        assert_eq!(port("sign", "A").feeds, vec![net(4, "[15] ×4")]);
        assert_eq!(
            port("sign", "B").feeds,
            vec![
                Feed::Constant {
                    width: 3,
                    label: "3'b001".into()
                },
                Feed::Undriven { width: 1 }
            ]
        );
        assert!(v
            .edges
            .iter()
            .all(|e| !e.sources.contains(&port("sign", "Y").id)));
    }
    fn case_statement(shared: bool) -> DesignSnapshot {
        let compare = |value: &str, y: u64| json!({"type":"$eq","port_directions":{"A":"input","B":"input","Y":"output"},"connections":{"A":[2,3],"B":[&value[1..2],&value[0..1]],"Y":[y]}});
        let mut module = json!({
            "ports":{"sel":{"direction":"input","bits":[2,3]},"a":{"direction":"input","bits":[4]},"b":{"direction":"input","bits":[5]},"c":{"direction":"input","bits":[6]},"y":{"direction":"output","bits":[10]}},
            "netnames":{"sel":{"bits":[2,3]}},
            "cells":{
                "zero":{"type":"$logic_not","port_directions":{"A":"input","Y":"output"},"connections":{"A":[2,3],"Y":[7]}},
                "two":compare("10",8),
                "three":compare("11",9),
                "case":{"type":"$pmux","port_directions":{"A":"input","B":"input","S":"input","Y":"output"},"connections":{"A":["x"],"B":[4,5,6],"S":[7,8,9],"Y":[10]}}}});
        if shared {
            module["ports"]["probe"] = json!({"direction":"output","bits":[8]});
        }
        snapshot(module)
    }
    #[test]
    fn a_case_statement_folds_into_one_multiplexer_selected_by_its_signal() {
        let scope = vec!["top".to_string()];
        let v = view(
            &case_statement(false),
            &scope,
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
        let mux = v.nodes.iter().find(|n| n.kind == "functional mux").unwrap();
        let display = mux.display.as_ref().unwrap();
        assert_eq!(display.title, "MUX 3:1");
        assert_eq!(display.members.len(), 4);
        // Data inputs are named by case value; the undefined default is no input.
        assert_eq!(
            mux.ports
                .iter()
                .map(|p| (p.label.as_str(), p.display.as_ref().unwrap().role.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("0", PinRole::Data),
                ("2", PinRole::Data),
                ("3", PinRole::Data),
                ("SEL", PinRole::Select),
                ("Y", PinRole::Data)
            ]
        );
        assert!(v.nodes.iter().all(|n| n.kind != "$eq" && n.kind != "$pmux"));
        let select = &mux.ports[3];
        assert!(v.edges.iter().any(|e| e.targets == [select.id.clone()]));
        let detail = view(
            &case_statement(false),
            &scope,
            None,
            2000,
            false,
            &SchematicOptions {
                detail: Some(mux.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(detail.nodes.iter().filter(|n| n.kind == "$eq").count(), 2);
        // A comparison read elsewhere must stay visible, so nothing folds; the
        // one-hot multiplexer then shows one data and one select pin per case.
        let v = view(
            &case_statement(true),
            &scope,
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
        assert!(v.nodes.iter().all(|n| n.kind != "functional mux"));
        let raw = v.nodes.iter().find(|n| n.kind == "$pmux").unwrap();
        assert_eq!(
            raw.ports
                .iter()
                .map(|p| p.label.as_str())
                .collect::<Vec<_>>(),
            vec!["A", "B0", "B1", "B2", "S0", "S1", "S2", "Y"]
        );
    }
    #[test]
    fn an_instance_pin_is_a_clock_only_when_every_pin_it_reaches_is_one() {
        let flop = |d: u64, q: u64| json!({"type":"$dff","parameters":{"CLK_POLARITY":"1","WIDTH":"1"},"port_directions":{"D":"input","Q":"output","CLK":"input"},"connections":{"D":[d],"Q":[q],"CLK":[2]}});
        let design = graph::from_yosys(
            &json!({"modules":{
                "top":{"ports":{"clk":{"direction":"input","bits":[2]},"gated":{"direction":"input","bits":[3]}},"netnames":{},
                    "cells":{"u":{"type":"mid","port_directions":{"clk":"input","gated":"input","q":"output"},"connections":{"clk":[2],"gated":[3],"q":[4]}}}},
                "mid":{"ports":{"clk":{"direction":"input","bits":[2]},"gated":{"direction":"input","bits":[3]},"q":{"direction":"output","bits":[5]}},"netnames":{},
                    "cells":{"leaf":{"type":"leaf","port_directions":{"clk":"input","d":"input","q":"output"},"connections":{"clk":[2],"d":[3],"q":[5]}}}},
                "leaf":{"ports":{"clk":{"direction":"input","bits":[2]},"d":{"direction":"input","bits":[3]},"q":{"direction":"output","bits":[4]}},"netnames":{},
                    "cells":{"a":flop(3,5),"b":flop(5,4)}}}}),
            "top",
        )
        .unwrap();
        let s = snapshot_of(design);
        let v = draw(&s);
        let instance = v.nodes.iter().find(|n| n.label == "u").unwrap();
        let role = |name: &str| {
            let pin = instance
                .ports
                .iter()
                .filter_map(|p| p.display.as_ref())
                .find(|d| d.name == name)
                .unwrap();
            (pin.role.clone(), pin.polarity)
        };
        assert_eq!(role("clk"), (PinRole::Clock, Some(true)));
        assert_eq!(role("gated"), (PinRole::Data, None));
    }
    #[test]
    fn memory_controls_tied_to_their_inactive_value_are_not_drawn() {
        let s = snapshot(
            json!({"cells":{"m":{"type":"$mem_v2","parameters":{"RD_CLK_ENABLE":"0","WR_CLK_ENABLE":"1","WR_CLK_POLARITY":"1"},
                "port_directions":{"RD_ADDR":"input","RD_DATA":"output","RD_CLK":"input","RD_EN":"input","RD_ARST":"input","RD_SRST":"input","WR_ADDR":"input","WR_DATA":"input","WR_EN":"input","WR_CLK":"input"},
                "connections":{"RD_ADDR":[2],"RD_DATA":[3],"RD_CLK":["x"],"RD_EN":["1"],"RD_ARST":["0"],"RD_SRST":["0"],"WR_ADDR":[2],"WR_DATA":[4],"WR_EN":[5],"WR_CLK":[6]}}}}),
        );
        let v = draw(&s);
        let unused: Vec<_> = v.nodes[0]
            .ports
            .iter()
            .filter_map(|p| p.display.as_ref())
            .filter(|d| d.role == PinRole::Unused)
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(unused, vec!["RD_ARST", "RD_CLK", "RD_EN", "RD_SRST"]);
    }
    #[test]
    fn library_cells_are_drawn_from_their_function_and_keep_endpoint_identity() {
        let cells = json!({
            "gate":{"type":"and2b","port_directions":{"A_N":"input","B":"input","X":"output"},"connections":{"A_N":[2],"B":[3],"X":[4]}},
            "odd":{"type":"and2b","port_directions":{"A_N":"input","Z":"input","X":"output"},"connections":{"A_N":[2],"Z":[3],"X":[5]}},
            "bare":{"type":"undescribed","port_directions":{"A":"input"},"connections":{"A":[2]}},
            "cap":{"type":"decap","port_directions":{"VPWR":"inout","VGND":"inout"},"connections":{"VPWR":[7],"VGND":[8]}}});
        let mut s = snapshot(json!({"netnames":{"n":{"bits":[2]}},"cells":cells}));
        s.representation = Representation::Mapped;
        let mut library = |name: &str, function: CellFunction| {
            s.design.modules.insert(
                name.into(),
                Module {
                    name: name.into(),
                    ports: vec![],
                    signals: vec![],
                    cells: vec![],
                    blackbox: true,
                    function: Some(function),
                },
            );
        };
        let inverted = CellPin {
            polarity: Some(false),
            ..Default::default()
        };
        library(
            "and2b",
            CellFunction {
                symbol: "and".into(),
                title: "AND".into(),
                pins: [
                    ("A_N".to_string(), inverted),
                    ("B".to_string(), CellPin::default()),
                    ("X".to_string(), CellPin::default()),
                ]
                .into(),
                compound: None,
            },
        );
        library(
            "decap",
            CellFunction {
                symbol: "physical".into(),
                title: "decap".into(),
                ..Default::default()
            },
        );
        let v = draw(&s);
        assert_eq!(v.hidden_physical_cells, 1);
        let gate = v.nodes.iter().find(|n| n.label == "gate").unwrap();
        assert_eq!(gate.display.as_ref().unwrap().symbol, "and");
        // A gate pin is its own endpoint, distinct from the net it connects to.
        assert!(gate.ports[0].signal_ids[0].contains("gate"));
        assert_ne!(gate.ports[0].signal_ids[0], v.signals[0].id);
        let polarity = |name: &str| pin(gate, name).unwrap().polarity;
        assert_eq!((polarity("A_N"), polarity("B")), (Some(false), None));
        let shown = view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions {
                show_physical_cells: true,
                ..Default::default()
            },
        )
        .unwrap();
        let symbol = |label: &str| {
            let node = shown.nodes.iter().find(|n| n.label == label).unwrap();
            node.display.as_ref().unwrap().symbol.clone()
        };
        assert_eq!(symbol("cap"), "physical");
        // A pin the function does not describe, or a cell without a function,
        // stays an explicit unknown.
        assert_eq!(symbol("odd"), "unknown");
        assert_eq!(symbol("bare"), "unknown");
    }
    #[test]
    fn a_grouped_mux_keeps_its_constant_data_input() {
        let mut s = tree(false);
        let low = s
            .design
            .modules
            .get_mut("top")
            .unwrap()
            .cells
            .iter_mut()
            .find(|c| c.name == "low")
            .unwrap();
        low.ports.iter_mut().find(|p| p.name == "A").unwrap().bits =
            vec![Bit::Constant("0".into())];
        let v = draw(&s);
        let group = v.nodes.iter().find(|n| n.kind == "functional mux").unwrap();
        assert!(group.ports.iter().any(|p| p.feeds
            == [Feed::Constant {
                width: 1,
                label: "1'b0".into()
            }]));
    }
}
