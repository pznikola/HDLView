use hdlview_core::{graph, model::*, waveform};
use serde_json::json;
use std::collections::BTreeMap;
fn fixture() -> (DesignSnapshot, SimulationRun, WaveInfo) {
    let design=graph::from_yosys(&json!({"modules":{"top":{"cells":{"first":{"type":"leaf"},"second":{"type":"leaf"}},"netnames":{}},"leaf":{"netnames":{"count":{"bits":[2,3,4,5],"offset":4}},"cells":{},"ports":{}}}}),"top").unwrap();
    let snapshot:DesignSnapshot=serde_json::from_value(json!({"schema_version":1,"id":"snapshot","representation":"elaborated","project":{"name":"fixture","top":"top","sources":[{"path":"top.sv","language":"system_verilog"}]},"profile":{"provider":"native"},"directory":"/tmp/example","design":design,"diagnostics":[],"tool_versions":{},"input_hashes":{},"netlist":null})).unwrap();
    let run:SimulationRun=serde_json::from_value(json!({"schema_version":1,"id":"run","snapshot_id":"snapshot","representation":"elaborated","trace":"/tmp/trace.vcd","trace_hash":"abc","dut_scope":["tb","dut"],"simulator":"icarus","diagnostics":[],"directory":"/tmp/run","imported":false})).unwrap();
    let info = WaveInfo {
        variables: vec![WaveVariable {
            id: 0,
            path: vec!["tb".into(), "dut".into(), "first".into(), "count".into()],
            width: 4,
            index: Some((7, 4)),
        }],
        end_time: "100".into(),
        timescale: "1ns".into(),
    };
    (snapshot, run, info)
}
#[test]
fn repeated_instances_never_bind_by_basename() {
    let (s, r, w) = fixture();
    let b = waveform::bindings(&s, &r, &w, &BTreeMap::new()).unwrap();
    assert_eq!(b[0].status, "exact");
    assert_eq!(b[1].status, "out_of_scope");
    assert_eq!(
        b[0].bit_correspondence,
        vec![(4, 4), (5, 5), (6, 6), (7, 7)]
    );
}
#[test]
fn range_offsets_are_checked() {
    let (s, r, mut w) = fixture();
    w.variables[0].index = Some((3, 0));
    assert_eq!(
        waveform::bindings(&s, &r, &w, &BTreeMap::new()).unwrap()[0].status,
        "range_mismatch"
    );
}
#[test]
fn ascending_range_preserves_index_correspondence() {
    let (s, r, mut w) = fixture();
    w.variables[0].index = Some((4, 7));
    assert_eq!(
        waveform::bindings(&s, &r, &w, &BTreeMap::new()).unwrap()[0].status,
        "exact"
    );
}
#[test]
fn duplicate_declarations_are_ambiguous() {
    let (s, r, mut w) = fixture();
    let mut alias = w.variables[0].clone();
    alias.id = 1;
    w.variables.push(alias);
    assert_eq!(
        waveform::bindings(&s, &r, &w, &BTreeMap::new()).unwrap()[0].status,
        "ambiguous"
    );
}
#[test]
fn stage_and_snapshot_are_both_required() {
    let (s, mut r, w) = fixture();
    r.representation = Representation::Mapped;
    assert!(waveform::bindings(&s, &r, &w, &BTreeMap::new()).is_err());
    r.representation = s.representation.clone();
    r.snapshot_id = "other".into();
    assert!(waveform::bindings(&s, &r, &w, &BTreeMap::new()).is_err());
}
#[test]
fn cell_endpoints_are_distinct_from_connected_net() {
    let (mut s, _, _) = fixture();
    s.representation = Representation::Mapped;
    s.design.modules.get_mut("leaf").unwrap().cells = vec![Cell {
        name: "buf".into(),
        kind: "buffer".into(),
        ports: vec![
            Port {
                name: "A".into(),
                direction: "input".into(),
                bits: vec![Bit::Wire(2)],
            },
            Port {
                name: "Y".into(),
                direction: "output".into(),
                bits: vec![Bit::Wire(2)],
            },
        ],
        source: None,
        attributes: BTreeMap::new(),
    }];
    let refs = graph::signal_refs(&s, &["top".into(), "first".into()]).unwrap();
    assert_eq!(refs.len(), 3);
    assert_ne!(refs[1].id, refs[2].id);
    assert_ne!(refs[0].id, refs[1].id);
    let view = graph::view(&s, &["top".into(), "first".into()], None, 2000).unwrap();
    let cell = view.nodes.iter().find(|node| node.label == "buf").unwrap();
    assert_eq!(cell.ports[0].signal_ids[0], refs[1].id);
    assert_eq!(cell.ports[1].signal_ids[0], refs[2].id);
}
#[test]
fn bounded_graph_does_not_expand_entire_design() {
    let (mut s, _, _) = fixture();
    let m = s.design.modules.get_mut("leaf").unwrap();
    m.cells = (0..100_000)
        .map(|i| Cell {
            name: format!("cell{i}"),
            kind: "unknown".into(),
            ports: vec![],
            source: None,
            attributes: BTreeMap::new(),
        })
        .collect();
    let g = graph::view(&s, &["top".into(), "first".into()], None, 2000).unwrap();
    assert_eq!(g.total_cells, 100_000);
    assert!(g.truncated);
    assert_eq!(g.nodes.len(), 2000);
}

#[test]
fn cancelled_native_job_stops_promptly() {
    use hdlview_core::runner::{CancelToken, Runner};
    let directory = tempfile::tempdir().unwrap();
    let token = CancelToken::default();
    let interrupt = token.clone();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        interrupt.cancel()
    });
    let runner = Runner::new(ToolchainProfile::default(), directory.path().into(), token);
    let start = std::time::Instant::now();
    assert!(runner
        .run("sleep", &["10".into()], directory.path(), "cancel")
        .is_err());
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    handle.join().unwrap();
}
#[test]
fn compiler_source_locations_are_parsed_without_losing_paths() {
    use hdlview_core::project::source_location;
    assert_eq!(
        source_location("/tmp/a b.sv:14.2-20.1"),
        ("/tmp/a b.sv", "14".into(), "2".into())
    );
    assert_eq!(
        source_location("/tmp/c.vhd:7:4"),
        ("/tmp/c.vhd", "7".into(), "4".into())
    );
}

#[test]
fn expanded_buses_preserve_declared_indices_and_inouts() {
    let (mut s, _, _) = fixture();
    let m = s.design.modules.get_mut("leaf").unwrap();
    m.signals[0].upto = true;
    m.ports = vec![Port {
        name: "count".into(),
        direction: "inout".into(),
        bits: m.signals[0].bits.clone(),
    }];
    let g =
        graph::view_with_options(&s, &["top".into(), "first".into()], None, 2000, true).unwrap();
    assert_eq!(
        g.nodes[0]
            .ports
            .iter()
            .map(|p| p.label.as_str())
            .collect::<Vec<_>>(),
        vec!["count[7]", "count[6]", "count[5]", "count[4]"]
    );
    assert!(g.nodes[0].ports.iter().all(|p| p.direction == "inout"));
    assert_eq!(g.edges.len(), 4);
    assert!(g.edges.iter().any(|e| e.label == "count[7]"));
    assert!(g
        .edges
        .iter()
        .all(|e| e.signal_ids == vec![g.signals[0].id.clone()]));
}
