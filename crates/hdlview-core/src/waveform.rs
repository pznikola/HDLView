use crate::{graph, model::*, project::*};
use anyhow::{bail, Context, Result};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
};
use wellen::{
    viewers, Hierarchy, LoadOptions, ScopeRef, Signal, SignalRef as WSignalRef, SignalSource,
    VarRef,
};

pub struct WaveStore {
    hierarchy: Hierarchy,
    source: SignalSource,
    times: Vec<u64>,
    refs: Vec<VarRef>,
    pub info: WaveInfo,
    loaded: HashMap<WSignalRef, Signal>,
}
fn walk(h: &Hierarchy, scope: ScopeRef, path: &[String], out: &mut Vec<(Vec<String>, VarRef)>) {
    let mut p = path.to_vec();
    p.push(h[scope].name(h).into());
    for v in h[scope].vars(h) {
        let mut n = p.clone();
        n.push(h[v].name(h).into());
        out.push((n, v));
    }
    for child in h[scope].scopes(h) {
        walk(h, child, &p, out);
    }
}
impl WaveStore {
    pub fn open(path: &Path) -> Result<Self> {
        let header = viewers::read_header_from_file(path, &LoadOptions::default())?;
        let body = viewers::read_body(header.body, &header.hierarchy, None)?;
        let h = header.hierarchy;
        let mut vars = Vec::new();
        for v in h.vars() {
            vars.push((vec![h[v].name(&h).into()], v));
        }
        for s in h.scopes() {
            walk(&h, s, &[], &mut vars);
        }
        let variables = vars
            .iter()
            .enumerate()
            .map(|(i, (path, v))| WaveVariable {
                id: i as u32,
                path: path.clone(),
                width: h[*v].length(&h).unwrap_or(0),
                index: h[*v].index().map(|i| (i.msb(), i.lsb())),
            })
            .collect();
        let info = WaveInfo {
            variables,
            end_time: body.time_table.last().copied().unwrap_or(0).to_string(),
            timescale: h
                .timescale()
                .map(|t| format!("{} {:?}", t.factor, t.unit))
                .unwrap_or_else(|| "unspecified".into()),
        };
        Ok(Self {
            hierarchy: h,
            source: body.source,
            times: body.time_table,
            refs: vars.into_iter().map(|(_, r)| r).collect(),
            info,
            loaded: HashMap::new(),
        })
    }
    pub fn window(
        &mut self,
        ids: &[u32],
        start: u64,
        end: u64,
        pixels: usize,
    ) -> Result<Vec<WaveRow>> {
        if ids.len() > 256 {
            bail!("Request at most 256 visible signals")
        }
        if start > end {
            bail!("Invalid time interval")
        }
        let refs: Vec<_> = ids
            .iter()
            .map(|i| {
                self.refs
                    .get(*i as usize)
                    .map(|v| self.hierarchy[*v].signal_ref())
                    .context("Unknown waveform variable")
            })
            .collect::<Result<_>>()?;
        self.loaded.retain(|id, _| refs.contains(id));
        let missing: Vec<_> = refs
            .iter()
            .filter(|r| !self.loaded.contains_key(r))
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        for s in self.source.load_signals(&missing, &self.hierarchy, true) {
            self.loaded.insert(s.signal_ref(), s);
        }
        let pixels = pixels.clamp(1, 8192) as u128;
        let span = (end as u128 - start as u128).max(1);
        Ok(ids
            .iter()
            .zip(refs)
            .map(|(id, r)| {
                let mut result = Vec::new();
                if let Some(sig) = self.loaded.get(&r) {
                    let indices = sig.time_indices();
                    let first = indices
                        .partition_point(|i| self.times[*i as usize] < start)
                        .saturating_sub(1);
                    let mut previous_bucket = None;
                    let mut bucket_count = 0usize;
                    for &idx in &indices[first..] {
                        let t = self.times[idx as usize];
                        if t > end {
                            break;
                        }
                        let offset = sig.get_offset(idx).unwrap();
                        let value = sig.get_value_at(&offset, 0).to_string();
                        let bucket =
                            ((t.max(start) as u128 - start as u128) * pixels / span).min(pixels);
                        if previous_bucket == Some(bucket) {
                            bucket_count += 1;
                            if bucket_count > 1 {
                                if let Some(last) = result.last_mut() {
                                    *last = Transition {
                                        time: t.to_string(),
                                        value: format!("activity:{value}"),
                                    };
                                }
                                continue;
                            }
                        } else {
                            previous_bucket = Some(bucket);
                            bucket_count = 0;
                        }
                        result.push(Transition {
                            time: t.to_string(),
                            value,
                        });
                    }
                }
                WaveRow {
                    id: *id,
                    transitions: result,
                }
            })
            .collect())
    }
    pub fn values(&mut self, ids: &[u32], time: u64) -> Result<Vec<WaveRow>> {
        self.window(ids, time, time, 1)
    }
}

fn range_matches(signal: &crate::model::SignalRef, variable: &WaveVariable) -> bool {
    if signal.width == 0 || signal.width != variable.width as usize {
        return false;
    }
    let (left, right) = variable.index.unwrap_or((variable.width as i64 - 1, 0));
    signal.offset == left.min(right) && signal.offset + signal.width as i64 - 1 == left.max(right)
}

pub fn bindings(
    snapshot: &DesignSnapshot,
    run: &SimulationRun,
    info: &WaveInfo,
    manual: &BTreeMap<String, u32>,
) -> Result<Vec<SignalBinding>> {
    if run.snapshot_id != snapshot.id || run.representation != snapshot.representation {
        bail!("Waveform and schematic belong to different snapshots/stages")
    }
    let vhdl = snapshot
        .project
        .sources
        .iter()
        .all(|s| s.language == Language::Vhdl)
        && !snapshot.representation.is_gate();
    let normalize = |s: &str| {
        if vhdl && !s.starts_with('\\') {
            s.to_ascii_lowercase()
        } else {
            s.to_owned()
        }
    };
    let mut wavepaths: BTreeMap<Vec<String>, Vec<&WaveVariable>> = BTreeMap::new();
    for v in &info.variables {
        wavepaths
            .entry(v.path.iter().map(|s| normalize(s)).collect())
            .or_default()
            .push(v);
    }
    let mut result = Vec::new();
    for scope in &snapshot.design.scopes {
        for sig in graph::signal_refs(snapshot, &scope.path)? {
            let mut path = run.dut_scope.clone();
            path.extend_from_slice(&sig.path[1..]);
            let key = path.iter().map(|s| normalize(s)).collect::<Vec<_>>();
            let candidates: Vec<u32> = wavepaths
                .get(&key)
                .into_iter()
                .flatten()
                .filter(|v| range_matches(&sig, v))
                .map(|v| v.id)
                .collect();
            let (ids, status, evidence) = if let Some(id) = manual.get(&sig.id) {
                let v = info
                    .variables
                    .iter()
                    .find(|v| v.id == *id)
                    .context("Manual mapping refers to a missing variable")?;
                if !range_matches(&sig, v) {
                    bail!("Manual mapping width differs for {}", sig.path.join("."))
                }
                (
                    vec![*id],
                    "manual",
                    "User mapping scoped to this snapshot and trace",
                )
            } else if candidates.len() == 1 {
                (
                    candidates,
                    "exact",
                    "DUT scope and exact declaration path/width",
                )
            } else if candidates.len() > 1 {
                (
                    candidates,
                    "ambiguous",
                    "Multiple waveform declarations match",
                )
            } else if wavepaths.contains_key(&key) {
                (
                    vec![],
                    "range_mismatch",
                    "Declaration exists but width or bit range differs",
                )
            } else if !wavepaths
                .keys()
                .any(|p| p.starts_with(&key[..key.len() - 1]))
            {
                (
                    vec![],
                    "out_of_scope",
                    "This schematic scope is absent from the selected DUT trace",
                )
            } else {
                (
                    vec![],
                    "missing",
                    "No matching dumped declaration; no value inferred",
                )
            };
            let bit_correspondence = if ["exact", "manual"].contains(&status) {
                (0..sig.width)
                    .map(|i| (sig.offset + i as i64, sig.offset + i as i64))
                    .collect()
            } else {
                vec![]
            };
            result.push(SignalBinding {
                signal_id: sig.id,
                variable_ids: ids,
                status: status.into(),
                evidence: evidence.into(),
                bit_correspondence,
            });
        }
    }
    for id in manual.keys() {
        if !result.iter().any(|binding| &binding.signal_id == id) {
            bail!("Manual mapping refers to a signal outside this snapshot")
        }
    }
    Ok(result)
}
pub fn import_trace(
    snapshot: &DesignSnapshot,
    path: &Path,
    dut_scope: Vec<String>,
    store: &Path,
) -> Result<SimulationRun> {
    let run = prepare_import(snapshot, path, dut_scope, store)?;
    let info = WaveStore::open(&run.trace)?.info;
    if !info
        .variables
        .iter()
        .any(|v| v.path.starts_with(&run.dut_scope))
    {
        bail!("No waveform variables exist under the selected DUT scope")
    }
    Ok(run)
}
pub fn prepare_import(
    snapshot: &DesignSnapshot,
    path: &Path,
    dut_scope: Vec<String>,
    store: &Path,
) -> Result<SimulationRun> {
    if dut_scope.is_empty() {
        bail!("Select the waveform DUT scope")
    }
    let dir = unique_dir(store, "import")?;
    let trace = dir.join(format!(
        "trace.{}",
        path.extension().and_then(|s| s.to_str()).unwrap_or("vcd")
    ));
    std::fs::copy(path, &trace)?;
    let trace_hash = file_hash(&trace)?;
    let id = hash(format!(
        "{}:{trace_hash}:{}",
        snapshot.id,
        serde_json::to_string(&dut_scope)?
    ));
    let run=SimulationRun{schema_version:SCHEMA,id,snapshot_id:snapshot.id.clone(),representation:snapshot.representation.clone(),trace,trace_hash,dut_scope,simulator:None,diagnostics:vec![Diagnostic{severity:"info".into(),message:"Imported trace association is user-declared; its source revision cannot be inferred from a waveform file.".into(),source:None}],directory:dir.clone(),imported:true};
    atomic_json(&dir.join("run.json"), &run)?;
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vcd_alias_and_large_time() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("test.vcd");
        std::fs::write(&p,"$timescale 1 ps $end\n$scope module tb $end\n$var wire 1 ! a $end\n$var wire 1 ! alias $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n#9007199254740993\n1!\n").unwrap();
        let mut w = WaveStore::open(&p).unwrap();
        assert_eq!(w.info.variables.len(), 2);
        assert_eq!(w.info.end_time, "9007199254740993");
        let rows = w.window(&[0, 1], 0, 9007199254740993, 100).unwrap();
        assert_eq!(rows[0].transitions.last().unwrap().time, "9007199254740993");
        assert_eq!(rows[1].transitions.last().unwrap().value, "1");
    }
}
