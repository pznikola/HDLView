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

pub fn parameter(cell: &Cell, name: &str) -> Option<u64> {
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

// Exact library families and verified interfaces; drive suffixes do not change logic.
fn library(cell: &Cell) -> Option<(&str, &str)> {
    let kind = cell.kind.strip_prefix('\\').unwrap_or(&cell.kind);
    let rest = kind
        .strip_prefix("sky130_fd_sc_hd__")
        .or_else(|| kind.strip_prefix("sg13g2_"))?;
    let family = rest
        .rsplit_once('_')
        .filter(|(_, strength)| strength.parse::<u32>().is_ok())
        .map_or(rest, |(family, _)| family);
    let output = if matches!(
        family,
        "and2"
            | "and3"
            | "and4"
            | "or2"
            | "or3"
            | "or4"
            | "xor2"
            | "buf"
            | "clkbuf"
            | "mux2"
            | "a21o"
            | "a22o"
            | "o21a"
            | "o22a"
    ) {
        "X"
    } else {
        "Y"
    };
    let (symbol, required): (&str, Vec<&str>) = match family {
        "and2" | "nand2" | "or2" | "nor2" | "xor2" | "xnor2" => (
            match family {
                "and2" => "and",
                "nand2" => "nand",
                "or2" => "or",
                "nor2" => "nor",
                "xor2" => "xor",
                _ => "xnor",
            },
            vec!["A", "B", output],
        ),
        "and3" | "nand3" | "or3" | "nor3" => (
            match family {
                "and3" => "and",
                "nand3" => "nand",
                "or3" => "or",
                _ => "nor",
            },
            vec!["A", "B", "C", output],
        ),
        "and4" | "nand4" | "or4" | "nor4" => (
            match family {
                "and4" => "and",
                "nand4" => "nand",
                "or4" => "or",
                _ => "nor",
            },
            vec!["A", "B", "C", "D", output],
        ),
        "buf" | "clkbuf" => ("buffer", vec!["A", "X"]),
        "inv" => ("not", vec!["A", "Y"]),
        "mux2" => ("mux", vec!["A0", "A1", "S", "X"]),
        "a21oi" | "a22oi" | "a21o" | "a22o" | "o21ai" | "o22ai" | "o21a" | "o22a" => {
            let mut pins = vec!["A1", "A2", "B1", output];
            if family.contains("22") {
                pins.push("B2");
            }
            ("compound", pins)
        }
        "dfxtp" | "dfbpq" => ("register", vec!["D", "CLK", "Q"]),
        "dfrtp" | "dfrbpq" => ("register", vec!["D", "CLK", "RESET_B", "Q"]),
        "dfstp" => ("register", vec!["D", "CLK", "SET_B", "Q"]),
        "edfxtp" => ("register", vec!["D", "CLK", "DE", "Q"]),
        "dlxtp" => ("latch", vec!["D", "GATE", "Q"]),
        "conb" => ("constant", vec!["HI", "LO"]),
        "tiehi" => ("constant", vec!["L_HI"]),
        "tielo" => ("constant", vec!["L_LO"]),
        "fill" | "decap" | "tap" | "tapvgnd" | "tapvgnd2" | "tapvpwrvgnd" => ("physical", vec![]),
        _ => return None,
    };
    let logic: BTreeSet<&str> = cell
        .ports
        .iter()
        .filter(|p| !power(&p.name))
        .map(|p| p.name.as_str())
        .collect();
    let expected: BTreeSet<&str> = required.iter().copied().collect();
    if logic != expected {
        return None;
    }
    for pin in &cell.ports {
        if power(&pin.name) {
            continue;
        }
        let out = matches!(
            pin.name.as_str(),
            "X" | "Y" | "Q" | "HI" | "LO" | "L_HI" | "L_LO"
        );
        if pin.bits.len() != 1 || pin.direction != if out { "output" } else { "input" } {
            return None;
        }
    }
    Some((symbol, family))
}
fn power(name: &str) -> bool {
    matches!(name, "VPWR" | "VGND" | "VPB" | "VNB" | "VDD" | "VSS")
}
pub fn is_physical(cell: &Cell) -> bool {
    library(cell).is_some_and(|(symbol, _)| symbol == "physical")
}

// Fine cells encode polarity in their type names. Check both the encoding and
// actual interface before assigning sequential semantics.
fn fine_register(cell: &Cell) -> Option<Vec<(&'static str, PinRole, bool)>> {
    let encoded = cell
        .kind
        .strip_prefix('\\')
        .unwrap_or(&cell.kind)
        .strip_prefix("$_")?
        .strip_suffix('_')?;
    let (family, code) = encoded.split_once('_')?;
    let signs = |bytes: &[u8]| bytes.iter().all(|b| matches!(b, b'P' | b'N'));
    let bytes = code.as_bytes();
    let mut controls = Vec::new();
    match family {
        "DFF" | "DFFE" | "SDFF" | "SDFFE" | "SDFFCE" => {
            let reset = family.starts_with("SD") || bytes.len() >= 3;
            let enable = matches!(family, "DFFE" | "SDFFE" | "SDFFCE");
            let expected = 1 + usize::from(reset) * 2 + usize::from(enable);
            if bytes.len() != expected || !signs(&bytes[..if reset { 2 } else { 1 }]) {
                return None;
            }
            controls.push(("C", PinRole::Clock, bytes[0] == b'P'));
            if reset {
                if !matches!(bytes[2], b'0' | b'1') {
                    return None;
                }
                controls.push(("R", PinRole::Reset, bytes[1] == b'P'));
            }
            if enable {
                let value = bytes[expected - 1];
                if !matches!(value, b'P' | b'N') {
                    return None;
                }
                controls.push(("E", PinRole::Enable, value == b'P'));
            }
        }
        "DFFSR" | "DFFSRE"
            if bytes.len() == if family == "DFFSR" { 3 } else { 4 } && signs(bytes) =>
        {
            controls.extend([
                ("C", PinRole::Clock, bytes[0] == b'P'),
                ("S", PinRole::Set, bytes[1] == b'P'),
                ("R", PinRole::Reset, bytes[2] == b'P'),
            ]);
            if family == "DFFSRE" {
                controls.push(("E", PinRole::Enable, bytes[3] == b'P'));
            }
        }
        "DLATCH" if bytes.len() == 1 && signs(bytes) => {
            controls.push(("E", PinRole::Enable, bytes[0] == b'P'));
        }
        "DLATCHSR" if bytes.len() == 3 && signs(bytes) => {
            controls.extend([
                ("E", PinRole::Enable, bytes[0] == b'P'),
                ("S", PinRole::Set, bytes[1] == b'P'),
                ("R", PinRole::Reset, bytes[2] == b'P'),
            ]);
        }
        _ => return None,
    }
    let expected: BTreeSet<_> = controls
        .iter()
        .map(|(name, _, _)| *name)
        .chain(["D", "Q"])
        .collect();
    if cell
        .ports
        .iter()
        .map(|p| p.name.as_str())
        .collect::<BTreeSet<_>>()
        != expected
        || cell.ports.iter().any(|p| {
            p.bits.len() != 1 || p.direction != if p.name == "Q" { "output" } else { "input" }
        })
    {
        return None;
    }
    Some(controls)
}

pub fn describe(cell: &Cell, node: &mut ViewNode) {
    let kind = cell.kind.strip_prefix('\\').unwrap_or(&cell.kind);
    let lib = library(cell);
    let fine = fine_register(cell);
    let (symbol, title) = lib.unwrap_or_else(|| match kind {
        "$and" | "$_AND_" | "$_ANDNOT_" => ("and", "AND"),
        "$or" | "$_OR_" | "$_ORNOT_" => ("or", "OR"),
        "$xor" | "$_XOR_" => ("xor", "XOR"),
        "$xnor" | "$_XNOR_" => ("xnor", "XNOR"),
        "$_NAND_" => ("nand", "NAND"),
        "$_NOR_" => ("nor", "NOR"),
        "$not" | "$_NOT_" => ("not", "NOT"),
        "$_BUF_" => ("buffer", "BUF"),
        "$_AOI3_" => ("compound", "a21oi"),
        "$_AOI4_" => ("compound", "a22oi"),
        "$_OAI3_" => ("compound", "o21ai"),
        "$_OAI4_" => ("compound", "o22ai"),
        "$logic_and" => ("and", "&&"),
        "$logic_or" => ("or", "||"),
        "$logic_not" => ("not", "!"),
        "$mux" | "$_MUX_" | "$bmux" | "$bwmux" => ("mux", "MUX"),
        "$pmux" => ("mux", "1HOT MUX"),
        "$demux" => ("demux", "DEMUX"),
        "$tribuf" | "$_TBUF_" => ("buffer", "TRI"),
        "$dff" | "$dffe" | "$adff" | "$adffe" | "$sdff" | "$sdffe" | "$sdffce" | "$aldff"
        | "$aldffe" | "$dffsr" | "$dffsre" => ("register", "DFF"),
        _ if fine.is_some() && kind.starts_with("$_DLATCH") => ("latch", "LATCH"),
        _ if fine.is_some() => ("register", "DFF"),
        "$dlatch" | "$adlatch" | "$dlatchsr" | "$_DLATCH_P_" | "$_DLATCH_N_" => ("latch", "LATCH"),
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
        "AlwaysFF" | "AlwaysComb" | "AlwaysLatch" | "Always" | "Initial" | "Final" => {
            ("process", kind)
        }
        "assign" => ("assignment", "assign"),
        "function" => ("function", "function"),
        "task" => ("task", "task"),
        _ if node.child_scope.is_some() => ("module", kind),
        _ => ("unknown", kind),
    });
    let mut annotations = Vec::new();
    let width = parameter(cell, "WIDTH").or_else(|| parameter(cell, "Y_WIDTH"));
    if let Some(width) = width {
        annotations.push(format!("{width} bit{}", if width == 1 { "" } else { "s" }));
    }
    if let Some((family, code)) = kind
        .strip_prefix("$_")
        .and_then(|s| s.strip_suffix('_'))
        .and_then(|s| s.split_once('_'))
    {
        if fine.is_some() && code.len() >= 3 && !family.ends_with("SR") && !family.ends_with("SRE")
        {
            annotations.push(format!(
                "{} reset = {}",
                if family.starts_with("SD") {
                    "sync"
                } else {
                    "async"
                },
                &code[2..3]
            ));
        }
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
    if lib.is_some_and(|(_, family)| matches!(family, "dfrtp" | "dfrbpq")) {
        annotations.push("async reset = 0".into());
    }
    if lib.is_some_and(|(_, family)| family == "dfstp") {
        annotations.push("async set = 1".into());
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
                "CLK" | "C" => PinRole::Clock,
                "EN" | "E" | "GATE" | "DE" | "ALOAD" => PinRole::Enable,
                "ARST" | "SRST" | "R" | "CLR" | "RESET_B" => PinRole::Reset,
                "SET" | "SET_B" | "S" => PinRole::Set,
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
        } else if symbol == "buffer" && matches!(pin.name.as_str(), "EN" | "E") {
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
        if pin.role == PinRole::Enable
            && (symbol == "memory" || matches!(kind, "$tribuf" | "$_TBUF_"))
        {
            pin.polarity = Some(true);
        }
        if matches!(kind, "$_ANDNOT_" | "$_ORNOT_") && pin.name == "B" {
            pin.polarity = Some(false);
        }
        if lib.is_some() {
            match pin.role {
                PinRole::Clock | PinRole::Enable => pin.polarity = Some(true),
                PinRole::Reset | PinRole::Set => pin.polarity = Some(false),
                _ => {}
            }
        } else if let Some(controls) = &fine {
            if let Some((_, role, polarity)) =
                controls.iter().find(|(name, _, _)| *name == pin.name)
            {
                pin.role = role.clone();
                pin.polarity = Some(*polarity);
            }
        }
    }
    node.display = Some(NodeDisplay {
        symbol: symbol.into(),
        title: title.into(),
        annotations,
        detail: cell
            .behavior
            .as_ref()
            .filter(|b| !b.nodes.is_empty())
            .map(|_| node.id.clone()),
        physical_only: symbol == "physical",
        ..Default::default()
    });
}

pub fn view(
    snapshot: &DesignSnapshot,
    scope: &[String],
    focus: Option<&str>,
    limit: usize,
    split: bool,
    options: &SchematicOptions,
) -> Result<GraphView> {
    let sc = snapshot
        .design
        .scopes
        .iter()
        .find(|s| s.path == scope)
        .context("Unknown scope")?;
    let module = &snapshot.design.modules[&sc.module];
    if let Some(detail) = &options.detail {
        if let Some(cell) = module.cells.iter().find(|c| {
            let mut path = scope.to_vec();
            path.push(c.name.clone());
            identity(&snapshot.id, &path, "cell") == *detail
        }) {
            return behavior_view(snapshot, scope, cell, detail, limit);
        }
    }
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
    for node in &mut view.nodes {
        if let Some(cell) = cells
            .get(node.label.as_str())
            .filter(|cell| node.kind == cell.kind)
        {
            describe(cell, node);
        } else {
            let symbol = match node.kind.as_str() {
                "port" => "port",
                "constant" => "constant",
                "off_view" => "connector",
                "undriven" | "unconnected" => "unavailable",
                _ => "unknown",
            };
            node.display = Some(NodeDisplay {
                symbol: symbol.into(),
                title: node.label.clone(),
                ..Default::default()
            });
        }
    }
    // Labels prefer declared user nets; compiler temporaries remain inspectable
    // through identities and tooltips instead of dominating the drawing.
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
        if edge.semantics != EdgeSemantics::Electrical {
            continue;
        }
        let named = edge.signal_ids.iter().find_map(|id| names.get(id));
        edge.label = match named {
            Some(signal) => {
                let positions: Vec<_> = signal
                    .bits
                    .iter()
                    .enumerate()
                    .filter(|(_, bit)| edge.bits.contains(bit))
                    .map(|(i, _)| {
                        signal.offset
                            + if signal.upto {
                                (signal.bits.len() - 1 - i) as i64
                            } else {
                                i as i64
                            }
                    })
                    .collect();
                let slice = if positions.len() < signal.bits.len() {
                    format!(
                        "[{}]",
                        positions
                            .iter()
                            .rev()
                            .map(i64::to_string)
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                } else {
                    String::new()
                };
                format!(
                    "{}{slice}{}",
                    signal.name,
                    if edge.bits.len() > 1 {
                        format!(" /{}", edge.bits.len())
                    } else {
                        String::new()
                    }
                )
            }
            None => {
                if edge.bits.len() > 1 {
                    format!("/{}", edge.bits.len())
                } else {
                    String::new()
                }
            }
        };
    }
    if snapshot.representation == Representation::Elaborated
        && (options.functional_symbols || options.detail.is_some())
    {
        let groups = groups(&view);
        if let Some(detail) = &options.detail {
            let group = groups
                .iter()
                .find(|g| &g.id == detail)
                .context("Unknown schematic detail; rebuild for source behavior metadata")?;
            let members = &group.display.as_ref().context("Group metadata")?.members;
            focus_group(&mut view, members);
            view.detail = Some(detail.clone());
        } else if options.functional_symbols {
            collapse(&mut view, groups);
        }
    } else if options.detail.is_some() {
        bail!("This snapshot has no captured detail for the selected object; rebuild to capture source behavior")
    }
    Ok(view)
}

fn behavior_view(
    snapshot: &DesignSnapshot,
    scope: &[String],
    cell: &Cell,
    detail: &str,
    limit: usize,
) -> Result<GraphView> {
    let body = cell.behavior.as_ref().context(
        "This older snapshot has no captured source behavior; rebuild to enable details",
    )?;
    let signals = graph::signal_refs(snapshot, scope)?;
    let ids: BTreeMap<&str, String> = signals
        .iter()
        .filter_map(|s| s.path.last().map(|name| (name.as_str(), s.id.clone())))
        .collect();
    let limit = limit.clamp(1, 2000);
    let mut nodes: Vec<ViewNode> = body
        .nodes
        .iter()
        .take(limit)
        .map(|n| {
            let id = format!("{detail}:behavior:{}", n.id);
            let signal_ids = if matches!(n.kind.as_str(), "reference" | "assignment") {
                n.signals
                    .iter()
                    .filter_map(|name| ids.get(name.as_str()).cloned())
                    .collect::<Vec<_>>()
            } else {
                vec![]
            };
            let symbol = match n.kind.as_str() {
                "and" | "or" | "xor" | "not" | "mux" | "operator" | "constant" | "function"
                | "task" | "assignment" => n.kind.as_str(),
                "reference" => "connector",
                "if" | "case" | "loop" | "event" | "block" | "return" | "merge" => "behavior",
                _ => "unknown",
            };
            let target = n
                .call
                .as_ref()
                .and_then(|name| {
                    snapshot
                        .design
                        .scopes
                        .iter()
                        .find(|s| s.path == scope)
                        .and_then(|s| {
                            snapshot.design.modules[&s.module]
                                .cells
                                .iter()
                                .find(|c| &c.name == name && c.behavior.is_some())
                        })
                })
                .map(|c| {
                    let mut path = scope.to_vec();
                    path.push(c.name.clone());
                    identity(&snapshot.id, &path, "cell")
                });
            ViewNode {
                id: id.clone(),
                label: n.label.clone(),
                kind: n.kind.clone(),
                ports: vec![
                    ViewPort {
                        id: format!("{id}:in"),
                        label: String::new(),
                        direction: "input".into(),
                        signal_ids: signal_ids.clone(),
                        display: None,
                    },
                    ViewPort {
                        id: format!("{id}:out"),
                        label: String::new(),
                        direction: "output".into(),
                        signal_ids,
                        display: None,
                    },
                ],
                child_scope: None,
                source: n.source.clone(),
                display: Some(NodeDisplay {
                    symbol: symbol.into(),
                    title: n.label.clone(),
                    detail: target,
                    annotations: n
                        .width
                        .map(|width| {
                            format!(
                                "{width} bits{}",
                                if n.signed == Some(true) {
                                    " · signed"
                                } else {
                                    ""
                                }
                            )
                        })
                        .into_iter()
                        .collect(),
                    span: n.span.clone(),
                    ..Default::default()
                }),
            }
        })
        .collect();
    let visible: BTreeSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let edges = body
        .edges
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            let source = format!("{detail}:behavior:{}", e.source);
            let target = format!("{detail}:behavior:{}", e.target);
            if !visible.contains(&source) || !visible.contains(&target) {
                return None;
            }
            // Expressions never acquire invented waveform declarations.
            let signal_ids = if e.semantics == EdgeSemantics::ControlFlow {
                vec![]
            } else {
                nodes
                    .iter()
                    .find(|n| n.id == source)
                    .map(|n| n.ports[1].signal_ids.clone())
                    .unwrap_or_default()
            };
            Some(ViewEdge {
                id: format!("{detail}:behavior-edge:{i}"),
                sources: vec![format!("{source}:out")],
                targets: vec![format!("{target}:in")],
                signal_ids,
                label: e.label.clone(),
                semantics: e.semantics,
                bits: vec![],
            })
        })
        .collect();
    // Allocate a distinct input anchor for every expression operand/branch.
    let mut edges: Vec<ViewEdge> = edges;
    for node in &mut nodes {
        let incoming: Vec<_> = edges
            .iter_mut()
            .filter(|e| e.targets[0] == format!("{}:in", node.id))
            .collect();
        let original = node.ports.remove(0);
        for (i, edge) in incoming.into_iter().enumerate() {
            let id = format!("{}:in:{i}", node.id);
            edge.targets[0] = id.clone();
            node.ports.push(ViewPort {
                id,
                label: edge.label.clone(),
                signal_ids: edge.signal_ids.clone(),
                display: Some(PinDisplay {
                    name: edge.label.clone(),
                    width: 0,
                    bits: vec![],
                    role: if node.kind == "mux" && edge.label == "select" {
                        PinRole::Select
                    } else {
                        PinRole::Data
                    },
                    polarity: None,
                    declared_direction: None,
                    range: None,
                }),
                ..original.clone()
            });
        }
        if node.kind == "return" {
            node.ports.retain(|p| p.direction != "output");
        }
    }
    Ok(GraphView {
        nodes,
        edges,
        signals,
        truncated: body.nodes.len() > limit,
        total_cells: body.nodes.len(),
        hidden_physical_cells: 0,
        omitted_cells: body.nodes.len().saturating_sub(limit),
        detail: Some(detail.into()),
    })
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

fn groups(view: &GraphView) -> Vec<ViewNode> {
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
        let mut ids: Vec<String> = member_ids.into_iter().map(String::from).collect();
        ids.sort();
        let id = format!(
            "{}:group:{}",
            view.nodes
                .first()
                .map(|n| n.id.split(":cell:").next().unwrap_or(&n.id))
                .unwrap_or("view"),
            serde_json::to_string(&ids).expect("string IDs")
        );
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
    let used: BTreeSet<&str> = view
        .edges
        .iter()
        .flat_map(|e| e.sources.iter().chain(&e.targets).map(String::as_str))
        .collect();
    view.nodes
        .retain(|n| n.kind != "constant" || n.ports.iter().any(|p| used.contains(p.id.as_str())));
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
    #[test]
    fn svg_publication_keeps_existing_export_on_invalid_input() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schematic.svg");
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>counter</text></svg>";
        super::save_svg(&path, svg).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), svg);
        assert!(super::save_svg(&path, "not SVG").is_err());
        assert!(super::save_svg(&path.with_extension("sv"), svg).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), svg);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    use super::*;
    use serde_json::json;
    fn snapshot(module: Value) -> DesignSnapshot {
        let design = graph::from_yosys(&json!({"modules":{"top":module}}), "top").unwrap();
        serde_json::from_value(json!({"schema_version":1,"id":"fixture","representation":"elaborated","project":{"name":"fixture","top":"top","sources":[]},"profile":{"provider":"native"},"directory":"/tmp/fixture","design":design,"diagnostics":[],"tool_versions":{},"input_hashes":{},"netlist":null})).unwrap()
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
    #[test]
    fn parameters_and_legacy_cells_preserve_polarity_without_guessing() {
        let s = snapshot(
            json!({"cells":{"ff":{"type":"$adff","parameters":{"CLK_POLARITY":"0","ARST_POLARITY":"0","ARST_VALUE":"0010","WIDTH":"100"},"port_directions":{"D":"input","Q":"output","CLK":"input","ARST":"input"},"connections":{"D":[2,3,4,5],"Q":[6,7,8,9],"CLK":[10],"ARST":[11]}}}}),
        );
        let v = view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
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
        assert!(bytes.get("behavior").is_none());
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
            let v = view(
                &s,
                &["top".into()],
                None,
                2000,
                false,
                &SchematicOptions::default(),
            )
            .unwrap();
            let memory = v.nodes.iter().find(|n| n.label == "memory").unwrap();
            assert_eq!(pin(memory, "RD_CLK").unwrap().role, role);
            assert_eq!(pin(memory, "RD_CLK").unwrap().polarity, expected);
        }
    }
    #[test]
    fn fine_sequential_cells_decode_controls_and_reject_incompatible_interfaces() {
        let mut s = snapshot(
            json!({"cells":{"ff":{"type":"\\$_SDFFE_NN0P_","port_directions":{"D":"input","C":"input","R":"input","E":"input","Q":"output"},"connections":{"D":[2],"C":[3],"R":[4],"E":[5],"Q":[6]}}}}),
        );
        let v = view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
        let ff = v.nodes.iter().find(|n| n.label == "ff").unwrap();
        assert_eq!(ff.display.as_ref().unwrap().symbol, "register");
        assert_eq!(pin(ff, "C").unwrap().polarity, Some(false));
        assert_eq!(pin(ff, "R").unwrap().polarity, Some(false));
        assert_eq!(pin(ff, "E").unwrap().polarity, Some(true));
        s.design.modules.get_mut("top").unwrap().cells[0].ports[0].name = "wrong".into();
        let v = view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
        assert_eq!(
            v.nodes
                .iter()
                .find(|n| n.label == "ff")
                .unwrap()
                .display
                .as_ref()
                .unwrap()
                .symbol,
            "unknown"
        );
    }
    #[test]
    fn source_detail_binds_operands_targets_and_control_flow_separately() {
        let mut s = snapshot(
            json!({"netnames":{"a":{"bits":[2]},"y":{"bits":[3]}},"cells":{"process":{"type":"AlwaysComb","connections":{}}}}),
        );
        s.representation = Representation::Source;
        s.design.modules.get_mut("top").unwrap().cells[0].behavior = Some(serde_json::from_value(json!({"nodes":[{"id":"read","kind":"reference","label":"a","signals":["a"]},{"id":"write","kind":"assignment","label":"y =","signals":["y"]},{"id":"next","kind":"assignment","label":"y =","signals":["y"]}],"edges":[{"source":"read","target":"write","label":"0","semantics":"dependency"},{"source":"write","target":"next","label":"next","semantics":"control_flow"}]})).unwrap());
        let id = identity(&s.id, &["top".into(), "process".into()], "cell");
        let v = view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions {
                detail: Some(id),
                ..Default::default()
            },
        )
        .unwrap();
        let write = v.nodes.iter().find(|n| n.id.ends_with(":write")).unwrap();
        assert!(write
            .ports
            .iter()
            .find(|p| p.direction == "input")
            .unwrap()
            .signal_ids[0]
            .ends_with("\"a\"]"));
        assert!(write
            .ports
            .iter()
            .find(|p| p.direction == "output")
            .unwrap()
            .signal_ids[0]
            .ends_with("\"y\"]"));
        assert!(v
            .edges
            .iter()
            .find(|e| e.semantics == EdgeSemantics::ControlFlow)
            .unwrap()
            .signal_ids
            .is_empty());
        assert!(v
            .nodes
            .iter()
            .find(|n| n.id.ends_with(":read"))
            .unwrap()
            .ports
            .iter()
            .all(|p| p.direction == "output"));
    }
    #[test]
    fn rtl_pins_prefer_declared_aliases_while_gate_pins_keep_endpoint_identity() {
        let mut s = snapshot(
            json!({"netnames":{"$temporary":{"bits":[2],"hide_name":1},"mid":{"bits":[2]}},"cells":{"buf":{"type":"$_BUF_","port_directions":{"A":"input","Y":"output"},"connections":{"A":[2],"Y":[3]}}}}),
        );
        let v = view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
        let buf = v.nodes.iter().find(|n| n.label == "buf").unwrap();
        assert!(buf.ports[0].signal_ids[0].ends_with("\"mid\"]"));
        assert!(buf.ports[0]
            .signal_ids
            .iter()
            .any(|id| id.contains("$temporary")));
        s.representation = Representation::Generic;
        let v = view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
        assert!(
            v.nodes.iter().find(|n| n.label == "buf").unwrap().ports[0].signal_ids[0]
                .ends_with("\"buf\",\"A\"]")
        );
    }
    #[test]
    fn library_catalog_requires_exact_pin_interface_and_keeps_delayed_endpoints() {
        let mut s = snapshot(
            json!({"netnames":{"n":{"bits":[2]}},"cells":{"buf":{"type":"sg13g2_buf_1","port_directions":{"A":"input","X":"output"},"connections":{"A":[2],"X":[3]}},"fill":{"type":"sg13g2_fill_1","connections":{}},"wrong":{"type":"sg13g2_buf_1","port_directions":{"bogus":"input","X":"output"},"connections":{"bogus":[2],"X":[4]}}}}),
        );
        s.representation = Representation::Mapped;
        let v = view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
        assert_eq!(v.hidden_physical_cells, 1);
        let buf = v.nodes.iter().find(|n| n.label == "buf").unwrap();
        assert_eq!(buf.display.as_ref().unwrap().symbol, "buffer");
        assert!(buf.ports[0].signal_ids[0].contains("buf"));
        assert_ne!(buf.ports[0].signal_ids[0], v.signals[0].id);
        assert_eq!(
            v.nodes
                .iter()
                .find(|n| n.label == "wrong")
                .unwrap()
                .display
                .as_ref()
                .unwrap()
                .symbol,
            "unknown"
        );
        assert!(view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions {
                show_physical_cells: true,
                ..Default::default()
            }
        )
        .unwrap()
        .nodes
        .iter()
        .any(|n| n.label == "fill"));
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
        let v = view(
            &s,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions::default(),
        )
        .unwrap();
        let decoder = v
            .nodes
            .iter()
            .find(|n| n.kind == "functional decoder")
            .unwrap();
        assert_eq!(decoder.ports.len(), 5);
        let mut partial = s.clone();
        partial.design.modules.get_mut("top").unwrap().cells.pop();
        assert!(view(
            &partial,
            &["top".into()],
            None,
            2000,
            false,
            &SchematicOptions::default()
        )
        .unwrap()
        .nodes
        .iter()
        .all(|n| n.kind != "functional decoder"));
    }
    #[test]
    fn bounded_views_distinguish_outside_drivers_from_undriven_nets() {
        let s = snapshot(
            json!({"cells":{"a":{"type":"$not","port_directions":{"A":"input","Y":"output"},"connections":{"A":[3],"Y":[4]}},"b":{"type":"$not","port_directions":{"A":"input","Y":"output"},"connections":{"A":[2],"Y":[3]}}}}),
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
        assert!(v.nodes.iter().any(|n| n.kind == "off_view"));
        assert!(v.nodes.iter().all(|n| n.kind != "undriven"));
    }
}
