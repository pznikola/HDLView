use crate::model::*;
use anyhow::{bail, Context, Result};
use serde::{
    de::{IgnoredAny, MapAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

fn bits(v: &Value) -> Vec<Bit> {
    serde_json::from_value(v.clone()).unwrap_or_default()
}
fn truth(v: &Value) -> bool {
    v.as_bool().unwrap_or(false)
        || v.as_u64().is_some_and(|v| v != 0)
        || v.as_str().is_some_and(|s| s.contains('1'))
}
fn source(v: &Value) -> Option<String> {
    v.get("src").and_then(Value::as_str).map(String::from)
}
// Yosys emits module ports in port-ID order. Preserve that order locally,
// without changing JSON map ordering in project fingerprints or old artifacts.
pub fn from_yosys_text(text: &str, top: &str) -> Result<Design> {
    #[derive(Deserialize)]
    struct Export {
        modules: BTreeMap<String, OrderedModule>,
    }
    #[derive(Deserialize)]
    struct OrderedModule {
        #[serde(default, deserialize_with = "port_names")]
        ports: Vec<String>,
    }
    fn port_names<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<String>, D::Error> {
        struct Names;
        impl<'de> Visitor<'de> for Names {
            type Value = Vec<String>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a Yosys port map")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut names = Vec::new();
                while let Some((name, _)) = map.next_entry::<String, IgnoredAny>()? {
                    names.push(name);
                }
                Ok(names)
            }
        }
        d.deserialize_map(Names)
    }
    let order: Export = serde_json::from_str(text)?;
    let mut design = from_yosys(&serde_json::from_str(text)?, top)?;
    for (name, module) in &mut design.modules {
        let names = &order.modules[name].ports;
        module
            .ports
            .sort_by_key(|p| names.iter().position(|n| n == &p.name));
        for cell in &mut module.cells {
            if let Some(child) = order.modules.get(&cell.kind) {
                cell.ports
                    .sort_by_key(|p| child.ports.iter().position(|n| n == &p.name));
            }
        }
    }
    Ok(design)
}
pub fn from_yosys(json: &Value, top: &str) -> Result<Design> {
    let mut design = Design::default();
    for (name, m) in json["modules"]
        .as_object()
        .context("Yosys JSON has no modules")?
    {
        let ports = m["ports"]
            .as_object()
            .map(|ps| {
                ps.iter()
                    .map(|(n, p)| Port {
                        name: n.clone(),
                        direction: p["direction"].as_str().unwrap_or("inout").into(),
                        bits: bits(&p["bits"]),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let signals = m["netnames"]
            .as_object()
            .map(|ss| {
                ss.iter()
                    .map(|(n, s)| Signal {
                        name: n.clone(),
                        bits: bits(&s["bits"]),
                        offset: s["offset"].as_i64().unwrap_or(0),
                        upto: truth(&s["upto"]),
                        signed: truth(&s["signed"]),
                        hidden: truth(&s["hide_name"]),
                        source: source(&s["attributes"]),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let cells = m["cells"]
            .as_object()
            .map(|cs| {
                cs.iter()
                    .filter(|(_, c)| c["type"] != "$scopeinfo")
                    .map(|(n, c)| {
                        let ports = c["connections"]
                            .as_object()
                            .map(|ps| {
                                ps.iter()
                                    .map(|(pn, b)| Port {
                                        name: pn.clone(),
                                        direction: c["port_directions"][pn]
                                            .as_str()
                                            .or_else(|| {
                                                json["modules"][c["type"].as_str().unwrap_or("")]
                                                    ["ports"][pn]["direction"]
                                                    .as_str()
                                            })
                                            .unwrap_or("inout")
                                            .into(),
                                        bits: bits(b),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let parameters = c
                            .get("parameters")
                            .map(|value| {
                                serde_json::from_value(value.clone()).with_context(|| {
                                    format!("Invalid Yosys parameters at {name}/{n}")
                                })
                            })
                            .transpose()?
                            .unwrap_or_default();
                        Ok(Cell {
                            name: n.clone(),
                            kind: c["type"].as_str().unwrap_or("unknown").into(),
                            ports,
                            source: source(&c["attributes"]),
                            attributes: serde_json::from_value(c["attributes"].clone())
                                .unwrap_or_default(),
                            parameters,
                            behavior: None,
                        })
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default();
        design.modules.insert(
            name.clone(),
            Module {
                name: name.clone(),
                ports,
                signals,
                cells,
                blackbox: truth(&m["attributes"]["blackbox"])
                    || truth(&m["attributes"]["whitebox"]),
            },
        );
    }
    build_scopes(&mut design, top)?;
    Ok(design)
}
pub fn build_scopes(d: &mut Design, top: &str) -> Result<()> {
    if !d.modules.contains_key(top) {
        bail!("Top module {top} was not exported")
    }
    d.scopes.clear();
    let mut queue = VecDeque::from([(vec![top.into()], top.to_owned(), BTreeSet::new())]);
    while let Some((path, name, mut ancestors)) = queue.pop_front() {
        if !ancestors.insert(name.clone()) {
            bail!("Recursive module hierarchy at {}", path.join("."))
        }
        if d.scopes.len() > 1_000_000 {
            bail!("Hierarchy exceeds one million scopes")
        }
        d.scopes.push(Scope {
            path: path.clone(),
            module: name.clone(),
        });
        for cell in &d.modules[&name].cells {
            if d.modules.get(&cell.kind).is_some_and(|m| !m.blackbox) {
                let mut p = path.clone();
                p.push(cell.name.clone());
                queue.push_back((p, cell.kind.clone(), ancestors.clone()));
            }
        }
    }
    Ok(())
}
pub fn signal_refs(s: &DesignSnapshot, scope: &[String]) -> Result<Vec<SignalRef>> {
    let sc = s
        .design
        .scopes
        .iter()
        .find(|sc| sc.path == scope)
        .context("Unknown scope")?;
    let mut refs: Vec<SignalRef> = s.design.modules[&sc.module]
        .signals
        .iter()
        .map(|sig| {
            let mut p = scope.to_vec();
            p.push(sig.name.clone());
            SignalRef {
                id: identity(&s.id, &p, "signal"),
                path: p,
                width: sig.bits.len(),
                offset: sig.offset,
                upto: sig.upto,
                source: sig.source.clone(),
            }
        })
        .collect();
    // Cell pins remain independently bindable even when interconnect delays separate values.
    if s.representation.is_gate() {
        for cell in &s.design.modules[&sc.module].cells {
            for port in &cell.ports {
                let mut path = scope.to_vec();
                path.extend([cell.name.clone(), port.name.clone()]);
                refs.push(SignalRef {
                    id: identity(&s.id, &path, "signal"),
                    path,
                    width: port.bits.len(),
                    offset: 0,
                    upto: false,
                    source: cell.source.clone(),
                });
            }
        }
    }
    Ok(refs)
}
pub fn view(
    s: &DesignSnapshot,
    scope: &[String],
    focus: Option<&str>,
    limit: usize,
) -> Result<GraphView> {
    view_with_options(s, scope, focus, limit, false)
}
pub fn view_with_options(
    s: &DesignSnapshot,
    scope: &[String],
    focus: Option<&str>,
    limit: usize,
    split_buses: bool,
) -> Result<GraphView> {
    view_for_schematic(s, scope, focus, limit, split_buses, true)
}
pub fn view_for_schematic(
    s: &DesignSnapshot,
    scope: &[String],
    focus: Option<&str>,
    limit: usize,
    split_buses: bool,
    show_physical_cells: bool,
) -> Result<GraphView> {
    let sc = s
        .design
        .scopes
        .iter()
        .find(|sc| sc.path == scope)
        .context("Unknown scope")?;
    let m = &s.design.modules[&sc.module];
    let limit = limit.clamp(1, 2000);
    let signals = signal_refs(s, scope)?;
    let mut bybit: BTreeMap<Bit, Vec<String>> = BTreeMap::new();
    for (sig, r) in m.signals.iter().zip(&signals) {
        for b in &sig.bits {
            if matches!(b, Bit::Wire(_)) {
                bybit.entry(b.clone()).or_default().push(r.id.clone());
            }
        }
    }
    let focusbits: BTreeSet<Bit> = m
        .signals
        .iter()
        .zip(&signals)
        .filter(|(_, r)| Some(r.id.as_str()) == focus)
        .flat_map(|(sig, _)| sig.bits.clone())
        .collect();
    let mut selected: Vec<&Cell> = m
        .cells
        .iter()
        .filter(|c| show_physical_cells || !crate::schematic::is_physical(c))
        .filter(|c| {
            focus.is_none()
                || c.ports
                    .iter()
                    .any(|p| p.bits.iter().any(|b| focusbits.contains(b)))
        })
        .take(limit)
        .collect();
    if split_buses {
        let endpoints: usize = m
            .ports
            .iter()
            .chain(selected.iter().flat_map(|c| c.ports.iter()))
            .map(|p| p.bits.len())
            .sum();
        if endpoints > 20_000 {
            bail!(
                "Bus expansion exceeds 20,000 pin bits; select a smaller signal neighborhood first"
            )
        }
    }
    let hidden_physical_cells = if show_physical_cells {
        0
    } else {
        m.cells
            .iter()
            .filter(|c| crate::schematic::is_physical(c))
            .count()
    };
    let omitted_cells = m
        .cells
        .len()
        .saturating_sub(hidden_physical_cells + selected.len());
    let mut full_drivers = BTreeSet::new();
    let mut full_loads = BTreeSet::new();
    for port in m.cells.iter().flat_map(|c| &c.ports) {
        if port.direction != "input" {
            full_drivers.extend(port.bits.clone());
        }
        if port.direction != "output" {
            full_loads.extend(port.bits.clone());
        }
    }
    let named_signals: BTreeSet<_> = m
        .signals
        .iter()
        .filter(|s| !s.hidden)
        .map(|signal| {
            let mut path = scope.to_vec();
            path.push(signal.name.clone());
            identity(&s.id, &path, "signal")
        })
        .collect();
    selected.sort_by(|a, b| a.name.cmp(&b.name));
    let mut nodes = Vec::new();
    let mut endpoints: BTreeMap<Bit, (Vec<String>, Vec<String>)> = BTreeMap::new();
    let mut add = |name: &str,
                   kind: &str,
                   ports: &[Port],
                   boundary: bool,
                   source: Option<String>,
                   child: Option<Vec<String>>| {
        let mut path = scope.to_vec();
        path.push(name.into());
        let id = identity(&s.id, &path, if boundary { "boundary" } else { "cell" });
        let mut vp = Vec::new();
        for p in ports {
            let declarations = m.signals.iter().find(|sig| boundary && sig.name == p.name);
            let partitions: Vec<(String, &[Bit])> = if split_buses && p.bits.len() > 1 {
                p.bits
                    .iter()
                    .enumerate()
                    .map(|(index, bit)| {
                        let declared = declarations
                            .map(|sig| {
                                sig.offset
                                    + if sig.upto {
                                        sig.bits.len() - 1 - index
                                    } else {
                                        index
                                    } as i64
                            })
                            .unwrap_or(index as i64);
                        (format!("{}[{declared}]", p.name), std::slice::from_ref(bit))
                    })
                    .collect()
            } else {
                vec![(
                    if p.bits.len() > 1 {
                        format!("{} /{}", p.name, p.bits.len())
                    } else {
                        p.name.clone()
                    },
                    p.bits.as_slice(),
                )]
            };
            // Wire storage is least-significant first; display declarations from
            // their left bound to their right bound without changing partition IDs.
            let mut partitions: Vec<_> = partitions.into_iter().enumerate().collect();
            if boundary && split_buses {
                partitions.reverse();
            }
            for (partition, (label, bits)) in partitions {
                let pid = format!(
                    "{id}:{}:{partition}",
                    serde_json::to_string(&p.name).unwrap()
                );
                for b in bits {
                    let (drivers, loads) = endpoints.entry(b.clone()).or_default();
                    let output = (p.direction == "output") ^ boundary;
                    if output || p.direction == "inout" {
                        drivers.push(pid.clone());
                    }
                    if !output || p.direction == "inout" {
                        loads.push(pid.clone());
                    }
                }
                let mut signal_ids: Vec<String> = bits
                    .iter()
                    .flat_map(|b| bybit.get(b).cloned().unwrap_or_default())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                signal_ids.sort_by(|a, b| {
                    (!named_signals.contains(a), a).cmp(&(!named_signals.contains(b), b))
                });
                if boundary {
                    let declaration = identity(&s.id, &path, "signal");
                    if signal_ids.contains(&declaration) {
                        signal_ids.retain(|id| id != &declaration);
                        signal_ids.insert(0, declaration);
                    }
                }
                if !boundary && s.representation.is_gate() {
                    let mut endpoint = path.clone();
                    endpoint.push(p.name.clone());
                    signal_ids.insert(0, identity(&s.id, &endpoint, "signal"));
                }
                vp.push(ViewPort {
                    id: pid,
                    label,
                    direction: if boundary {
                        match p.direction.as_str() {
                            "input" => "output",
                            "output" => "input",
                            _ => "inout",
                        }
                        .into()
                    } else {
                        p.direction.clone()
                    },
                    signal_ids,
                    display: Some(PinDisplay {
                        name: p.name.clone(),
                        width: bits.len(),
                        bits: bits.to_vec(),
                        role: PinRole::Data,
                        polarity: None,
                        declared_direction: boundary.then(|| p.direction.clone()),
                        range: declarations
                            .filter(|sig| !split_buses && sig.bits.len() > 1)
                            .map(|sig| {
                                let low = sig.offset;
                                let high = low + sig.bits.len() as i64 - 1;
                                if sig.upto {
                                    (low, high)
                                } else {
                                    (high, low)
                                }
                            }),
                    }),
                });
            }
        }
        nodes.push(ViewNode {
            id,
            label: name.into(),
            kind: kind.into(),
            ports: vp,
            child_scope: child,
            source,
            display: None,
        });
    };
    for p in &m.ports {
        add(&p.name, "port", std::slice::from_ref(p), true, None, None);
    }
    for c in selected {
        let mut p = scope.to_vec();
        p.push(c.name.clone());
        let child = s.design.scopes.iter().any(|sc| sc.path == p).then_some(p);
        add(&c.name, &c.kind, &c.ports, false, c.source.clone(), child);
    }
    // Aggregate bits only when their endpoint sets match; partial buses retain separate routes.
    let mut groups: BTreeMap<(Vec<String>, Vec<String>), Vec<Bit>> = BTreeMap::new();
    for (bit, (mut drivers, mut loads)) in endpoints {
        drivers.sort();
        drivers.dedup();
        loads.sort();
        loads.dedup();
        if let Bit::Constant(ref value) = bit {
            let id = format!("{}:constant:{value}", identity(&s.id, scope, "scope"));
            let port = format!("{id}:out");
            if !nodes.iter().any(|n| n.id == id) {
                nodes.push(ViewNode {
                    id,
                    label: value.clone(),
                    kind: "constant".into(),
                    ports: vec![ViewPort {
                        id: port.clone(),
                        label: value.clone(),
                        direction: "output".into(),
                        signal_ids: vec![],
                        display: None,
                    }],
                    child_scope: None,
                    source: None,
                    display: None,
                });
            }
            drivers = vec![port];
        }
        if drivers.is_empty() || loads.is_empty() {
            let undriven = drivers.is_empty();
            let kind = if undriven { "undriven" } else { "unconnected" };
            let outside = if undriven {
                full_drivers.contains(&bit)
            } else {
                full_loads.contains(&bit)
            };
            let kind = if outside { "off_view" } else { kind };
            let id = format!("{}:{kind}:{bit:?}", identity(&s.id, scope, "scope"));
            let port = format!("{id}:pin");
            nodes.push(ViewNode {
                id,
                label: kind.into(),
                kind: kind.into(),
                ports: vec![ViewPort {
                    id: port.clone(),
                    label: String::new(),
                    direction: if undriven { "output" } else { "input" }.into(),
                    signal_ids: bybit.get(&bit).cloned().unwrap_or_default(),
                    display: None,
                }],
                child_scope: None,
                source: None,
                display: None,
            });
            if undriven {
                drivers.push(port)
            } else {
                loads.push(port)
            }
        }
        groups.entry((drivers, loads)).or_default().push(bit);
    }
    let edges = groups
        .into_iter()
        .enumerate()
        .map(|(i, ((drivers, loads), bs))| {
            let ids: BTreeSet<String> = bs
                .iter()
                .flat_map(|b| bybit.get(b).cloned().unwrap_or_default())
                .collect();
            let names: Vec<String> = signals
                .iter()
                .filter(|r| ids.contains(&r.id))
                .map(|r| {
                    let name = r.path.last().unwrap();
                    if split_buses && bs.len() == 1 && r.width > 1 {
                        if let Some(sig) = m.signals.iter().find(|sig| &sig.name == name) {
                            let positions: Vec<String> = sig
                                .bits
                                .iter()
                                .enumerate()
                                .filter(|(_, bit)| **bit == bs[0])
                                .map(|(i, _)| {
                                    (sig.offset
                                        + if sig.upto { sig.bits.len() - 1 - i } else { i } as i64)
                                        .to_string()
                                })
                                .collect();
                            return format!("{name}[{}]", positions.join(","));
                        }
                    }
                    name.clone()
                })
                .collect();
            ViewEdge {
                id: format!("{}:edge:{i}", identity(&s.id, scope, "scope")),
                sources: drivers,
                targets: loads,
                signal_ids: signals
                    .iter()
                    .filter(|signal| ids.contains(&signal.id))
                    .map(|signal| signal.id.clone())
                    .collect(),
                label: format!(
                    "{}{}",
                    names.first().cloned().unwrap_or_default(),
                    if bs.len() > 1 {
                        format!(" /{}", bs.len())
                    } else {
                        String::new()
                    }
                ),
                semantics: if s.representation == Representation::Source {
                    EdgeSemantics::Dependency
                } else {
                    EdgeSemantics::Electrical
                },
                bits: bs,
            }
        })
        .collect();
    Ok(GraphView {
        nodes,
        edges,
        signals,
        truncated: omitted_cells > 0,
        total_cells: m.cells.len(),
        hidden_physical_cells,
        omitted_cells,
        detail: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn compiler_port_order_survives_json_decoding() {
        let text = r#"{"modules":{"top":{"ports":{"z":{"direction":"input","bits":[2]},"a":{"direction":"output","bits":[3]},"m":{"direction":"input","bits":[4]}},"cells":{},"netnames":{}}}}"#;
        let design = from_yosys_text(text, "top").unwrap();
        assert_eq!(
            design.modules["top"]
                .ports
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            vec!["z", "a", "m"]
        );
    }
    #[test]
    fn instances_and_aliases_are_distinct() {
        let d=from_yosys(&json!({"modules":{"top":{"ports":{},"netnames":{},"cells":{"a":{"type":"leaf"},"b":{"type":"leaf"}}},"leaf":{"ports":{},"cells":{},"netnames":{"x":{"bits":[2]},"alias":{"bits":[2]}}}}}),"top").unwrap();
        assert_eq!(d.scopes.len(), 3);
        assert_ne!(d.scopes[1].path, d.scopes[2].path);
        assert_eq!(d.modules["leaf"].signals.len(), 2);
    }
    #[test]
    fn recursion_is_rejected() {
        assert!(from_yosys(&json!({"modules":{"t":{"cells":{"u":{"type":"t"}}}}}), "t").is_err());
    }
    #[test]
    fn path_segments_do_not_collide() {
        assert_ne!(
            identity("a", &["b.c".into()], "signal"),
            identity("a", &["b".into(), "c".into()], "signal")
        );
    }
}
