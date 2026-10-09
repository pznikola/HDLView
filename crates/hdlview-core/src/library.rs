//! What each library cell computes, decoded from the gate networks Yosys
//! builds when it reads a Liberty file. Nothing here looks at a cell's name.
use crate::{model::*, schematic::power};
use std::collections::{BTreeMap, BTreeSet};

/// Functions of the library cells among `modules`; a cell this decoder cannot
/// describe exactly is left out and stays an explicit unknown box.
pub fn functions(modules: &BTreeMap<String, Module>) -> BTreeMap<String, CellFunction> {
    modules
        .iter()
        .filter_map(|(name, module)| Some((name.clone(), function(module)?)))
        .collect()
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

/// A cell with supply pins only, such as a fill, tap or decoupling cell.
pub fn physical(module: &Module) -> Option<CellFunction> {
    module
        .ports
        .iter()
        .all(|p| power(&p.name))
        .then(|| CellFunction {
            symbol: "physical".into(),
            title: module.name.clone(),
            ..Default::default()
        })
}

struct Network<'a> {
    drivers: BTreeMap<&'a Bit, &'a Cell>,
    inputs: BTreeMap<&'a Bit, &'a str>,
}
impl<'a> Network<'a> {
    fn new(module: &'a Module) -> Self {
        Self {
            drivers: module
                .cells
                .iter()
                .flat_map(|c| {
                    c.ports
                        .iter()
                        .filter(|p| p.direction == "output")
                        .flat_map(move |p| p.bits.iter().map(move |bit| (bit, c)))
                })
                .collect(),
            inputs: module
                .ports
                .iter()
                .filter(|p| p.direction == "input")
                .flat_map(|p| p.bits.iter().map(|bit| (bit, p.name.as_str())))
                .collect(),
        }
    }
    fn operand(cell: &'a Cell, pin: &str) -> Option<&'a Bit> {
        cell.ports.iter().find(|p| p.name == pin)?.bits.first()
    }
    /// The library pin a net comes from, and whether through one inverter.
    fn pin(&self, bit: &Bit) -> Option<(&'a str, bool)> {
        if let Some(name) = self.inputs.get(bit) {
            return Some((name, false));
        }
        let not = self.drivers.get(bit).filter(|c| c.kind == "$_NOT_")?;
        Some((self.inputs.get(Self::operand(not, "A")?)?, true))
    }
    fn value(&self, bit: &Bit, known: &BTreeMap<&Bit, bool>, depth: usize) -> Option<bool> {
        if let Some(value) = known.get(bit) {
            return Some(*value);
        }
        if let Bit::Constant(value) = bit {
            return match value.as_str() {
                "0" => Some(false),
                "1" => Some(true),
                _ => None,
            };
        }
        let cell = self.drivers.get(bit).filter(|_| depth < 64)?;
        let read = |pin: &str| self.value(Self::operand(cell, pin)?, known, depth + 1);
        Some(match cell.kind.as_str() {
            "$_BUF_" => read("A")?,
            "$_NOT_" => !read("A")?,
            "$_AND_" => read("A")? & read("B")?,
            "$_NAND_" => !(read("A")? & read("B")?),
            "$_OR_" => read("A")? | read("B")?,
            "$_NOR_" => !(read("A")? | read("B")?),
            "$_XOR_" => read("A")? ^ read("B")?,
            "$_XNOR_" => !(read("A")? ^ read("B")?),
            "$_ANDNOT_" => read("A")? & !read("B")?,
            "$_ORNOT_" => read("A")? | !read("B")?,
            "$_MUX_" => {
                if read("S")? {
                    read("B")?
                } else {
                    read("A")?
                }
            }
            _ => return None,
        })
    }
    /// Truth table of `bit` over at most six variables; row `r` sets variable
    /// `i` to bit `i` of `r`.
    fn table(&self, bit: &Bit, variables: &[&Bit]) -> Option<u64> {
        if variables.len() > 6 {
            return None;
        }
        (0..1u64 << variables.len()).try_fold(0, |table, row| {
            let known = variables
                .iter()
                .enumerate()
                .map(|(i, variable)| (*variable, row >> i & 1 == 1))
                .collect();
            Some(table | u64::from(self.value(bit, &known, 0)?) << row)
        })
    }
}

fn data() -> CellPin {
    CellPin::default()
}
fn control(role: PinRole, polarity: bool, asynchronous: bool) -> CellPin {
    CellPin {
        role,
        polarity: Some(polarity),
        asynchronous,
        label: None,
    }
}

fn function(module: &Module) -> Option<CellFunction> {
    if module.ports.iter().any(|p| p.bits.len() != 1) {
        return None;
    }
    let inputs: Vec<&Port> = module
        .ports
        .iter()
        .filter(|p| p.direction == "input")
        .collect();
    let outputs: Vec<&Port> = module
        .ports
        .iter()
        .filter(|p| p.direction == "output")
        .collect();
    if let Some(function) = physical(module) {
        return Some(function);
    }
    let network = Network::new(module);
    let mut pins: BTreeMap<String, CellPin> = module
        .ports
        .iter()
        .map(|p| (p.name.clone(), data()))
        .collect();
    let storage: Vec<_> = module
        .cells
        .iter()
        .filter_map(|c| Some((c, fine_register(c)?)))
        .collect();
    if let [(cell, controls)] = storage.as_slice() {
        // A control is a library pin only when it reaches the storage element
        // directly or through one inverter; anything else stays data.
        for (name, role, polarity) in controls {
            let Some((pin, inverted)) = Network::operand(cell, name).and_then(|b| network.pin(b))
            else {
                continue;
            };
            let asynchronous =
                matches!(role, PinRole::Reset | PinRole::Set) && !cell.kind.starts_with("$_SD");
            pins.insert(
                pin.into(),
                control(role.clone(), polarity ^ inverted, asynchronous),
            );
        }
        let q = Network::operand(cell, "Q")?;
        let d = Network::operand(cell, "D")?;
        // `D = enable ? data : Q` is a clock enable, whichever way it is written.
        if network.pin(d).is_none() {
            let variables: Vec<&Bit> = inputs
                .iter()
                .filter_map(|p| p.bits.first())
                .chain([q])
                .collect();
            let hold = variables.len() - 1;
            if let Some(table) = network.table(d, &variables) {
                for (enable, value) in (0..hold).flat_map(|e| (0..hold).map(move |v| (e, v))) {
                    for active in [true, false] {
                        let chosen = |row: u64| {
                            let bit = |i: usize| row >> i & 1 == 1;
                            if bit(enable) == active {
                                bit(value)
                            } else {
                                bit(hold)
                            }
                        };
                        if enable != value
                            && (0..1u64 << variables.len())
                                .all(|row| (table >> row & 1 == 1) == chosen(row))
                        {
                            pins.insert(
                                inputs[enable].name.clone(),
                                control(PinRole::Enable, active, false),
                            );
                        }
                    }
                }
            }
        }
        for output in &outputs {
            let bit = output.bits.first()?;
            let inverted = match network.drivers.get(bit) {
                _ if bit == q => false,
                Some(not) if not.kind == "$_NOT_" && Network::operand(not, "A") == Some(q) => true,
                _ => return None,
            };
            if inverted {
                pins.insert(
                    output.name.clone(),
                    CellPin {
                        polarity: Some(false),
                        ..data()
                    },
                );
            }
        }
        let latch = cell.kind.starts_with("$_DLATCH");
        return Some(CellFunction {
            symbol: if latch { "latch" } else { "register" }.into(),
            title: if latch { "LATCH" } else { "DFF" }.into(),
            pins,
            compound: None,
        });
    }
    if !storage.is_empty() || outputs.is_empty() {
        return None;
    }
    let gate = |symbol: &str, title: &str, pins| CellFunction {
        symbol: symbol.into(),
        title: title.into(),
        pins,
        compound: None,
    };
    if outputs
        .iter()
        .all(|p| matches!(p.bits.first(), Some(Bit::Constant(_))))
    {
        return Some(gate("constant", "TIE", pins));
    }
    let [output] = outputs.as_slice() else {
        return None;
    };
    let mut y = output.bits.first()?;
    // A tri-state output is a buffer or inverter with an enable.
    if let Some(tristate) = network.drivers.get(y).filter(|c| c.kind == "$tribuf") {
        let (enable, low) = network.pin(Network::operand(tristate, "EN")?)?;
        pins.insert(enable.into(), control(PinRole::Enable, !low, false));
        y = Network::operand(tristate, "A")?;
        let (_, inverted) = network.pin(y)?;
        return (inputs.len() == 2).then(|| {
            gate(
                if inverted { "not" } else { "buffer" },
                if inverted { "TRI INV" } else { "TRI" },
                pins,
            )
        });
    }
    let variables: Vec<&Bit> = inputs.iter().filter_map(|p| p.bits.first()).collect();
    let n = variables.len();
    let table = network.table(y, &variables)?;
    let rows = 1u64 << n;
    let all = if rows == 64 {
        u64::MAX
    } else {
        (1 << rows) - 1
    };
    let mask = rows - 1;
    let inverting = |pins: &mut BTreeMap<String, CellPin>, inverted: u64| {
        for (i, input) in inputs.iter().enumerate() {
            if inverted >> i & 1 == 1 {
                pins.insert(
                    input.name.clone(),
                    CellPin {
                        polarity: Some(false),
                        ..data()
                    },
                );
            }
        }
    };
    if n == 0 {
        return Some(gate("constant", if table == 1 { "1" } else { "0" }, pins));
    }
    if n == 1 {
        return match table {
            0b10 => Some(gate("buffer", "BUF", pins)),
            0b01 => Some(gate("not", "NOT", pins)),
            _ => None,
        };
    }
    // AND and OR of possibly inverted inputs, drawn with the fewest bubbles:
    // one true row is an AND, or a NOR of the complemented inputs.
    let simple = if table.count_ones() == 1 {
        let row = u64::from(table.trailing_zeros());
        let zeros = n as u32 - row.count_ones();
        Some(if zeros <= row.count_ones() {
            ("and", "AND", !row & mask)
        } else {
            ("nor", "NOR", row)
        })
    } else if (!table & all).count_ones() == 1 {
        let row = u64::from((!table & all).trailing_zeros());
        Some(if row.count_ones() <= n as u32 - row.count_ones() {
            ("or", "OR", row)
        } else {
            ("nand", "NAND", !row & mask)
        })
    } else {
        let parity = (0..rows).fold(0, |t, row| t | u64::from(row.count_ones() % 2) << row);
        match table {
            t if t == parity => Some(("xor", "XOR", 0)),
            t if t == !parity & all => Some(("xnor", "XNOR", 0)),
            _ => None,
        }
    };
    if let Some((symbol, title, inverted)) = simple {
        inverting(&mut pins, inverted);
        return Some(gate(symbol, title, pins));
    }
    let matches = |f: &dyn Fn(u64) -> bool| (0..rows).all(|row| (table >> row & 1 == 1) == f(row));
    // A multiplexer: some pins select which of the others reaches the output.
    for selects in [1usize, 2].into_iter().filter(|k| n == k + (1 << k)) {
        for order in arrangements(n, selects) {
            let rest: Vec<usize> = (0..n).filter(|i| !order.contains(i)).collect();
            for choice in arrangements(rest.len(), rest.len()) {
                for inverted in [false, true] {
                    let chosen = |row: u64| {
                        let code = order
                            .iter()
                            .enumerate()
                            .fold(0, |code, (i, pin)| code | (row >> pin & 1) << i);
                        (row >> rest[choice[code as usize]] & 1 == 1) != inverted
                    };
                    if !matches(&chosen) {
                        continue;
                    }
                    for pin in &order {
                        pins.insert(
                            inputs[*pin].name.clone(),
                            CellPin {
                                role: PinRole::Select,
                                ..data()
                            },
                        );
                    }
                    for (code, pin) in choice.iter().enumerate() {
                        pins.insert(
                            inputs[rest[*pin]].name.clone(),
                            CellPin {
                                label: Some(code.to_string()),
                                ..data()
                            },
                        );
                    }
                    if inverted {
                        pins.insert(
                            output.name.clone(),
                            CellPin {
                                polarity: Some(false),
                                ..data()
                            },
                        );
                    }
                    let title = if selects == 1 { "MUX" } else { "MUX 4:1" };
                    return Some(gate("mux", title, pins));
                }
            }
        }
    }
    // AND-OR and OR-AND cells, optionally inverted, with at most two inverted
    // inputs: try every grouping of the pins.
    let mut inversions: Vec<u64> = (0..rows).filter(|m| m.count_ones() <= 2).collect();
    inversions.sort_by_key(|m| m.count_ones());
    for inverted_inputs in inversions {
        for groups in partitions(n) {
            if groups.len() < 2 || groups.iter().all(|g| g.len() < 2) {
                continue;
            }
            for (first, inverted) in [("and", false), ("and", true), ("or", false), ("or", true)] {
                let computed = |row: u64| {
                    let literal = |pin: &usize| (row ^ inverted_inputs) >> pin & 1 == 1;
                    let value = if first == "and" {
                        groups.iter().any(|g| g.iter().all(literal))
                    } else {
                        groups.iter().all(|g| g.iter().any(literal))
                    };
                    value != inverted
                };
                if !matches(&computed) {
                    continue;
                }
                inverting(&mut pins, inverted_inputs);
                let mut groups = groups.clone();
                groups.sort_by_key(|g| std::cmp::Reverse(g.len()));
                let title = format!(
                    "{}{}{}",
                    if first == "and" { "AO" } else { "OA" },
                    if inverted { "I" } else { "" },
                    groups
                        .iter()
                        .map(|g| g.len().to_string())
                        .collect::<String>()
                );
                return Some(CellFunction {
                    symbol: "compound".into(),
                    title,
                    pins,
                    compound: Some(Compound {
                        first: first.into(),
                        groups: groups
                            .iter()
                            .map(|g| g.iter().map(|pin| inputs[*pin].name.clone()).collect())
                            .collect(),
                        inverted,
                    }),
                });
            }
        }
    }
    None
}

/// Ordered selections of `k` distinct indices below `n`.
fn arrangements(n: usize, k: usize) -> Vec<Vec<usize>> {
    let mut found = vec![vec![]];
    for _ in 0..k {
        found = found
            .into_iter()
            .flat_map(|chosen: Vec<usize>| {
                (0..n)
                    .filter(|i| !chosen.contains(i))
                    .map(|i| chosen.iter().copied().chain([i]).collect())
                    .collect::<Vec<_>>()
            })
            .collect();
    }
    found
}

/// Every way to split indices below `n` into unordered groups.
fn partitions(n: usize) -> Vec<Vec<Vec<usize>>> {
    let mut found: Vec<Vec<Vec<usize>>> = vec![vec![]];
    for index in 0..n {
        found = found
            .into_iter()
            .flat_map(|groups| {
                let mut next: Vec<Vec<Vec<usize>>> = (0..groups.len())
                    .map(|g| {
                        let mut groups = groups.clone();
                        groups[g].push(index);
                        groups
                    })
                    .collect();
                let mut alone = groups;
                alone.push(vec![index]);
                next.push(alone);
                next
            })
            .collect();
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph;
    use serde_json::{json, Value};

    fn cell(kind: &str, pins: &[(&str, u64)]) -> Value {
        let output = |pin: &str| matches!(pin, "Y" | "Q");
        json!({
            "type": kind,
            "port_directions": pins.iter().map(|(p, _)| (p.to_string(), if output(p) { "output" } else { "input" })).collect::<BTreeMap<_, _>>(),
            "connections": pins.iter().map(|(p, bit)| (p.to_string(), vec![*bit])).collect::<BTreeMap<_, _>>(),
        })
    }
    fn decode(ports: &[(&str, &str, u64)], cells: Vec<Value>) -> Option<CellFunction> {
        let ports: BTreeMap<_, _> = ports
            .iter()
            .map(|(name, direction, bit)| {
                (
                    name.to_string(),
                    json!({"direction": direction, "bits": [bit]}),
                )
            })
            .collect();
        let cells: BTreeMap<_, _> = cells
            .into_iter()
            .enumerate()
            .map(|(i, c)| (i.to_string(), c))
            .collect();
        let modules = graph::modules_from_yosys(
            &json!({"modules": {"cell": {"ports": ports, "cells": cells, "netnames": {}}}}),
        )
        .unwrap();
        functions(&modules).remove("cell")
    }

    #[test]
    fn fine_registers_decode_controls_and_reject_incompatible_interfaces() {
        let modules = graph::modules_from_yosys(&json!({"modules": {"cell": {"ports": {}, "netnames": {}, "cells": {
            "ff": cell("$_SDFFE_NN0P_", &[("D", 2), ("C", 3), ("R", 4), ("E", 5), ("Q", 6)]),
            "odd": cell("$_SDFFE_NN0P_", &[("D", 2), ("C", 3), ("wrong", 4), ("E", 5), ("Q", 6)]),
        }}}}))
        .unwrap();
        let cells = &modules["cell"].cells;
        let ff = cells.iter().find(|c| c.name == "ff").unwrap();
        assert_eq!(
            fine_register(ff).unwrap(),
            [
                ("C", PinRole::Clock, false),
                ("R", PinRole::Reset, false),
                ("E", PinRole::Enable, true)
            ]
        );
        assert!(fine_register(cells.iter().find(|c| c.name == "odd").unwrap()).is_none());
    }

    #[test]
    fn a_cell_with_supply_pins_only_is_physical() {
        let module = |ports: Value| {
            graph::modules_from_yosys(
                &json!({"modules": {"fill": {"ports": ports, "cells": {}, "netnames": {}}}}),
            )
            .unwrap()
            .remove("fill")
            .unwrap()
        };
        let supply = json!({"VPWR": {"direction": "inout", "bits": [2]}, "VGND": {"direction": "inout", "bits": [3]}});
        assert_eq!(physical(&module(supply)).unwrap().symbol, "physical");
        assert_eq!(physical(&module(json!({}))).unwrap().symbol, "physical");
        assert!(physical(&module(json!({"A": {"direction": "input", "bits": [2]}}))).is_none());
    }

    #[test]
    fn gates_are_drawn_from_their_function_with_the_fewest_bubbles() {
        // and2b: X = !A_N & B, as Yosys builds it from the Liberty function.
        let f = decode(
            &[("B", "input", 2), ("X", "output", 3), ("A_N", "input", 4)],
            vec![
                cell("$_AND_", &[("A", 5), ("B", 2), ("Y", 3)]),
                cell("$_NOT_", &[("A", 4), ("Y", 5)]),
            ],
        )
        .unwrap();
        assert_eq!(f.symbol, "and");
        assert_eq!(f.pins["A_N"].polarity, Some(false));
        assert_eq!(f.pins["B"].polarity, None);
        // nor2 written as a sum of products is still a NOR, without bubbles.
        let f = decode(
            &[("A", "input", 2), ("B", "input", 3), ("Y", "output", 4)],
            vec![
                cell("$_NOT_", &[("A", 2), ("Y", 5)]),
                cell("$_NOT_", &[("A", 3), ("Y", 6)]),
                cell("$_AND_", &[("A", 5), ("B", 6), ("Y", 4)]),
            ],
        )
        .unwrap();
        assert_eq!(f.symbol, "nor");
        assert!(f.pins.values().all(|pin| pin.polarity.is_none()));
    }

    #[test]
    fn compound_and_multiplexer_cells_expose_their_structure() {
        // a31o: X = (A1 & A2 & A3) | B1.
        let f = decode(
            &[
                ("A1", "input", 2),
                ("A2", "input", 3),
                ("A3", "input", 4),
                ("B1", "input", 5),
                ("X", "output", 6),
            ],
            vec![
                cell("$_AND_", &[("A", 2), ("B", 3), ("Y", 7)]),
                cell("$_AND_", &[("A", 7), ("B", 4), ("Y", 8)]),
                cell("$_OR_", &[("A", 8), ("B", 5), ("Y", 6)]),
            ],
        )
        .unwrap();
        assert_eq!((f.symbol.as_str(), f.title.as_str()), ("compound", "AO31"));
        assert_eq!(
            f.compound,
            Some(Compound {
                first: "and".into(),
                groups: vec![
                    vec!["A1".into(), "A2".into(), "A3".into()],
                    vec!["B1".into()]
                ],
                inverted: false,
            })
        );
        // mux2: X = S ? A1 : A0.
        let f = decode(
            &[
                ("A1", "input", 2),
                ("S", "input", 3),
                ("X", "output", 4),
                ("A0", "input", 5),
            ],
            vec![
                cell("$_AND_", &[("A", 5), ("B", 6), ("Y", 7)]),
                cell("$_AND_", &[("A", 2), ("B", 3), ("Y", 8)]),
                cell("$_OR_", &[("A", 7), ("B", 8), ("Y", 4)]),
                cell("$_NOT_", &[("A", 3), ("Y", 6)]),
            ],
        )
        .unwrap();
        assert_eq!(f.symbol, "mux");
        assert_eq!(f.pins["S"].role, PinRole::Select);
        assert_eq!(f.pins["A0"].label.as_deref(), Some("0"));
        assert_eq!(f.pins["A1"].label.as_deref(), Some("1"));
    }

    #[test]
    fn storage_cells_take_roles_from_the_element_their_pins_reach() {
        // dfrtp: rising clock, active-low asynchronous reset.
        let f = decode(
            &[
                ("CLK", "input", 2),
                ("D", "input", 3),
                ("Q", "output", 4),
                ("RESET_B", "input", 5),
            ],
            vec![
                cell("$_NOT_", &[("A", 4), ("Y", 6)]),
                cell("$_DFF_PN0_", &[("C", 2), ("D", 3), ("Q", 4), ("R", 5)]),
            ],
        )
        .unwrap();
        assert_eq!(f.symbol, "register");
        assert_eq!(f.pins["CLK"], control(PinRole::Clock, true, false));
        assert_eq!(f.pins["RESET_B"], control(PinRole::Reset, false, true));
        assert_eq!(f.pins["D"], data());
        // An enable written as feedback from Q, and an inverted second output.
        let f = decode(
            &[
                ("CLK", "input", 2),
                ("D", "input", 3),
                ("DE", "input", 4),
                ("Q", "output", 5),
                ("Q_N", "output", 9),
            ],
            vec![
                cell("$_MUX_", &[("A", 5), ("B", 3), ("S", 4), ("Y", 6)]),
                cell("$_DFF_P_", &[("C", 2), ("D", 6), ("Q", 5)]),
                cell("$_NOT_", &[("A", 5), ("Y", 9)]),
            ],
        )
        .unwrap();
        assert_eq!(f.pins["DE"], control(PinRole::Enable, true, false));
        assert_eq!(f.pins["Q_N"].polarity, Some(false));
        // A function this decoder cannot name is left unknown, not approximated.
        assert!(decode(
            &[
                ("A", "input", 2),
                ("B", "input", 3),
                ("C", "input", 4),
                ("X", "output", 5),
            ],
            vec![
                cell("$_XOR_", &[("A", 2), ("B", 3), ("Y", 6)]),
                cell("$_AND_", &[("A", 6), ("B", 4), ("Y", 5)]),
            ],
        )
        .is_none());
    }
}
