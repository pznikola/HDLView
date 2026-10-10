//! A fixed block outline: its LibreLane settings, its pin order file, and what
//! a stopped flow says about it.
use crate::model::*;
use anyhow::{bail, Result};
use std::{collections::BTreeSet, fs, path::Path};

/// LibreLane variables that a `floorplan` sets itself.
const OWNED: [&str; 6] = [
    "FP_SIZING",
    "DIE_AREA",
    "CORE_AREA",
    "IO_PIN_ORDER_CFG",
    "FP_DEF_TEMPLATE",
    "ERRORS_ON_UNMATCHED_IO",
];
const SIDES: [(Side, &str); 4] = [
    (Side::North, "#N"),
    (Side::East, "#E"),
    (Side::South, "#S"),
    (Side::West, "#W"),
];
/// OpenROAD tools whose errors mean the floorplan, power grid, pins, cells or
/// wires have no room: a step such as timing repair fails with the placer's code.
const FIT_TOOLS: [&str; 6] = ["IFP-", "PDN-", "PPL-", "GPL-", "DPL-", "GRT-"];
/// LibreLane's own pin placement reports a full side without a tool code.
const PIN_STEP: &str = "odb-customioplacement";

pub fn check(cfg: &PhysicalConfig) -> Result<()> {
    let Some(plan) = &cfg.floorplan else {
        return Ok(());
    };
    for side in [plan.width_um, plan.height_um] {
        if !side.is_finite() || side <= 0.0 {
            bail!("Floorplan width and height must be positive")
        }
    }
    if let Some(key) = OWNED.iter().find(|key| cfg.overrides.contains_key(**key)) {
        bail!("{key} in the LibreLane overrides conflicts with the floorplan; remove one of them")
    }
    let mut seen = BTreeSet::new();
    for pin in &plan.pins {
        if !seen.insert(&pin.port) {
            bail!("Port {} is placed twice", pin.port)
        }
    }
    Ok(())
}
/// The pin order file for LibreLane's custom pin placement; `None` when no pin
/// is placed and the flow's own placer decides. LibreLane puts a pin the file
/// omits on a random side, so each remaining port goes to the side with the
/// fewest pins.
pub fn pin_order(plan: &Floorplan, top: &str, ports: &[Port]) -> Result<Option<String>> {
    if plan.pins.is_empty() {
        return Ok(None);
    }
    let mut sides: Vec<Vec<&Port>> = vec![Vec::new(); SIDES.len()];
    let index = |side: Side| SIDES.iter().position(|(known, _)| *known == side).unwrap();
    for pin in &plan.pins {
        let port = ports
            .iter()
            .find(|port| port.name == pin.port)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "The floorplan places {}, which is not a port of {top}",
                    pin.port
                )
            })?;
        sides[index(pin.side)].push(port);
    }
    for port in ports {
        if !plan.pins.iter().any(|pin| pin.port == port.name) {
            let bits = |side: &Vec<&Port>| side.iter().map(|port| port.bits.len()).sum::<usize>();
            let least = (0..sides.len())
                .min_by_key(|side| bits(&sides[*side]))
                .unwrap();
            sides[least].push(port);
        }
    }
    let mut text = String::new();
    for ((_, header), ports) in SIDES.iter().zip(&sides) {
        text.push_str(header);
        text.push('\n');
        for port in ports {
            // Each line is a regular expression over the bit-level pin names.
            for character in port.name.chars() {
                if !character.is_ascii_alphanumeric() && character != '_' {
                    text.push('\\');
                }
                text.push(character);
            }
            if port.bits.len() > 1 {
                text.push_str(r"\[.*\]");
            }
            text.push('\n');
        }
        text.push('\n');
    }
    Ok(Some(text))
}
/// Why a build of `area` square microns of cells cannot start in the outline.
/// `strap_side` is the shortest side that holds one set of power straps.
pub fn too_small(
    plan: &Floorplan,
    area: f64,
    utilization: f64,
    strap_side: Option<f64>,
) -> Option<String> {
    let outline = format!("{} × {} µm", plan.width_um, plan.height_um);
    let rectangle = plan.width_um * plan.height_um;
    if area > rectangle {
        let side = (area / (utilization / 100.0)).sqrt().ceil();
        return Some(format!(
            "The design cannot fit in {outline}: its cells need {area:.0} µm² and the rectangle is {rectangle:.0} µm². At {utilization} % utilization it needs about {side} × {side} µm."
        ));
    }
    let shortest = plan.width_um.min(plan.height_um);
    strap_side.filter(|side| shortest < *side).map(|side| {
        format!(
            "The design cannot fit in {outline}: the power grid needs sides of at least {} µm.",
            side.ceil()
        )
    })
}
/// Name the step a flow stopped in and quote that step's own errors. A flow
/// that stopped for another reason keeps its error.
pub fn failure(
    run: &Path,
    cfg: &PhysicalConfig,
    utilization: Option<f64>,
    error: anyhow::Error,
) -> anyhow::Error {
    let step = fs::read_dir(run)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?.to_owned();
            let (number, title) = name.split_once('-')?;
            Some((number.parse::<u32>().ok()?, title.to_owned(), path))
        })
        .max_by_key(|(number, ..)| *number);
    let Some((_, step, directory)) =
        step.filter(|(.., path)| !path.join("state_out.json").exists())
    else {
        return error;
    };
    let mut messages = Vec::new();
    for entry in fs::read_dir(&directory).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "log") {
            for line in fs::read_to_string(&path).unwrap_or_default().lines() {
                let line = line.trim();
                if line.contains("[ERROR") && !messages.iter().any(|known| known == line) {
                    messages.push(line.to_owned());
                }
            }
        }
    }
    messages.truncate(6);
    let no_room = step == PIN_STEP
        || messages.iter().any(|message| {
            FIT_TOOLS
                .iter()
                .any(|tool| message.contains(&format!("[ERROR {tool}")))
        });
    let headline = if !no_room {
        format!("Place and route stopped at {step}.")
    } else if let Some(plan) = &cfg.floorplan {
        format!(
            "The design cannot fit in {} × {} µm: {step} failed.",
            plan.width_um, plan.height_um
        )
    } else {
        match utilization {
            Some(utilization) => format!(
                "The design cannot fit at {utilization:.1} % core utilization: {step} failed."
            ),
            None => format!("The design cannot fit in its floorplan: {step} failed."),
        }
    };
    let origin = format!("{error:#}");
    anyhow::anyhow!(
        "{headline}\n{}\n{}",
        messages.join("\n"),
        origin.lines().next().unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn physical(floorplan: serde_json::Value, overrides: serde_json::Value) -> PhysicalConfig {
        serde_json::from_value(json!({
            "pdk": "sky130A", "library": "sky130_fd_sc_hd", "clock_port": "clk",
            "clock_period_ns": 10.0, "floorplan": floorplan, "overrides": overrides
        }))
        .unwrap()
    }
    fn port(name: &str, bits: usize) -> Port {
        Port {
            name: name.into(),
            direction: "input".into(),
            bits: vec![Bit::Wire(0); bits],
        }
    }
    #[test]
    fn a_floorplan_needs_a_positive_size_its_own_variables_and_each_port_once() {
        let pins = json!([{"port": "clk", "side": "west"}]);
        let good = json!({"width_um": 80.0, "height_um": 60.0, "pins": pins});
        assert!(check(&physical(good.clone(), json!({}))).is_ok());
        assert!(check(&physical(json!(null), json!({"DIE_AREA": [0, 0, 1, 1]}))).is_ok());
        for (floorplan, overrides, message) in [
            (
                json!({"width_um": 0.0, "height_um": 60.0}),
                json!({}),
                "must be positive",
            ),
            (
                good,
                json!({"DIE_AREA": [0, 0, 1, 1]}),
                "DIE_AREA in the LibreLane overrides",
            ),
            (
                json!({"width_um": 80.0, "height_um": 60.0, "pins": [
                    {"port": "clk", "side": "west"}, {"port": "clk", "side": "east"}]}),
                json!({}),
                "Port clk is placed twice",
            ),
        ] {
            let error = check(&physical(floorplan, overrides))
                .unwrap_err()
                .to_string();
            assert!(error.contains(message), "{error}");
        }
    }
    #[test]
    fn the_pin_order_file_keeps_the_given_order_and_spreads_the_other_ports() {
        let plan: Floorplan = serde_json::from_value(json!({
            "width_um": 80.0, "height_um": 60.0,
            "pins": [{"port": "data", "side": "west"}, {"port": "clk", "side": "west"}]
        }))
        .unwrap();
        let ports = [
            port("clk", 1),
            port("data", 8),
            port("q", 4),
            port("ready", 1),
        ];
        assert_eq!(
            pin_order(&plan, "top", &ports).unwrap().unwrap(),
            "#N\nq\\[.*\\]\n\n#E\nready\n\n#S\n\n#W\ndata\\[.*\\]\nclk\n\n"
        );
        let empty = Floorplan {
            pins: Vec::new(),
            ..plan.clone()
        };
        assert_eq!(pin_order(&empty, "top", &ports).unwrap(), None);
        let error = pin_order(&plan, "top", &ports[2..])
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "The floorplan places data, which is not a port of top"
        );
    }
    #[test]
    fn an_outline_smaller_than_the_cells_or_the_power_grid_is_refused_before_the_flow() {
        let plan = Floorplan {
            width_um: 20.0,
            height_um: 20.0,
            pins: Vec::new(),
        };
        assert_eq!(
            too_small(&plan, 512.4, 30.0, Some(10.0)).unwrap(),
            "The design cannot fit in 20 × 20 µm: its cells need 512 µm² and the rectangle is 400 µm². At 30 % utilization it needs about 42 × 42 µm."
        );
        assert_eq!(
            too_small(&plan, 90.0, 30.0, Some(26.9)).unwrap(),
            "The design cannot fit in 20 × 20 µm: the power grid needs sides of at least 27 µm."
        );
        assert_eq!(too_small(&plan, 90.0, 30.0, Some(10.0)), None);
        assert_eq!(too_small(&plan, 90.0, 30.0, None), None);
    }
    #[test]
    fn a_stopped_flow_names_its_step_and_quotes_that_steps_errors() {
        let d = tempfile::tempdir().unwrap();
        let step = |name: &str, done: bool, log: &str| {
            let path = d.path().join(name);
            fs::create_dir(&path).unwrap();
            fs::write(path.join("step.log"), log).unwrap();
            if done {
                fs::write(path.join("state_out.json"), "{}").unwrap();
            }
        };
        step("06-yosys-synthesis", true, "[ERROR] not this one\n");
        fs::create_dir(d.path().join("final")).unwrap();
        let fixed = physical(json!({"width_um": 30.0, "height_um": 25.0}), json!({}));
        let unchanged = failure(d.path(), &fixed, None, anyhow::anyhow!("flow failed"));
        assert_eq!(unchanged.to_string(), "flow failed");
        step(
            "28-openroad-globalplacement",
            false,
            "[INFO] start\n[ERROR GPL-0302] Use a higher -density\n[ERROR GPL-0302] Use a higher -density\n",
        );
        let error = || anyhow::anyhow!("librelane failed (exit status: 1); log: /x.log\ntail");
        assert_eq!(
            failure(d.path(), &fixed, None, error()).to_string(),
            "The design cannot fit in 30 × 25 µm: openroad-globalplacement failed.\n[ERROR GPL-0302] Use a higher -density\nlibrelane failed (exit status: 1); log: /x.log"
        );
        let automatic = physical(json!(null), json!({}));
        assert!(failure(d.path(), &automatic, Some(30.0), error())
            .to_string()
            .starts_with("The design cannot fit at 30.0 % core utilization: openroad-globalplacement failed."));
        step(
            "32-openroad-repairdesignpostgpl",
            false,
            "[ERROR DPL-0036] Detailed placement failed.\n",
        );
        assert!(failure(d.path(), &fixed, None, error())
            .to_string()
            .starts_with("The design cannot fit in 30 × 25 µm: openroad-repairdesignpostgpl failed.\n[ERROR DPL-0036]"));
        step("35-openroad-cts", false, "[ERROR CTS-1] no clock\n");
        assert!(failure(d.path(), &fixed, None, error())
            .to_string()
            .starts_with("Place and route stopped at openroad-cts.\n[ERROR CTS-1] no clock\n"));
        step(
            "36-odb-customioplacement",
            false,
            "[ERROR] The N side of the floorplan doesn't have enough slots\n",
        );
        assert!(failure(d.path(), &fixed, None, error())
            .to_string()
            .starts_with("The design cannot fit in 30 × 25 µm: odb-customioplacement failed."));
    }
}
