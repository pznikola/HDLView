use crate::{graph, model::*, project::*};
use anyhow::{bail, Context, Result};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
};
use wellen::{
    viewers, FileFormat, Hierarchy, LoadOptions, ScopeRef, Signal, SignalRef as WSignalRef,
    SignalSource, VarRef,
};

pub struct WaveStore {
    hierarchy: Hierarchy,
    source: SignalSource,
    times: Vec<u64>,
    refs: Vec<VarRef>,
    pub info: WaveInfo,
    /// Decoded signals with the request that last used each.
    loaded: HashMap<WSignalRef, (u64, Signal)>,
    requests: u64,
}
/// Rows on screen and the schematic's cursor values alternate; both stay decoded.
const LOADED_SIGNALS: usize = 512;
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
/// Inspect only the header; collecting a run must not load every transition.
pub(crate) fn contains_dut(path: &Path, dut_scope: &[String]) -> Result<bool> {
    check_format(path)?;
    let header = viewers::read_header_from_file(path, &LoadOptions::default())?;
    let h = header.hierarchy;
    fn has_vars(h: &Hierarchy, s: ScopeRef) -> bool {
        h[s].vars(h).next().is_some() || h[s].scopes(h).any(|child| has_vars(h, child))
    }
    fn matches(h: &Hierarchy, s: ScopeRef, path: &[String]) -> bool {
        if path.first().is_none_or(|name| h[s].name(h) != name) {
            return false;
        }
        if path.len() == 1 {
            has_vars(h, s)
        } else {
            h[s].scopes(h).any(|child| matches(h, child, &path[1..]))
        }
    }
    let found = h.scopes().any(|scope| matches(&h, scope, dut_scope));
    Ok(found)
}
fn check_format(path: &Path) -> Result<()> {
    let mut input = std::io::BufReader::new(std::fs::File::open(path)?);
    if viewers::detect_file_format(&mut input) == FileFormat::Ghw {
        bail!("Unsupported waveform format; import VCD or FST")
    }
    Ok(())
}
impl WaveStore {
    pub fn open(path: &Path) -> Result<Self> {
        check_format(path)?;
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
            timescale: h.timescale().and_then(|t| {
                Some(Timescale {
                    factor: t.factor,
                    exponent: t.unit.to_exponent()?,
                })
            }),
        };
        Ok(Self {
            hierarchy: h,
            source: body.source,
            times: body.time_table,
            refs: vars.into_iter().map(|(_, r)| r).collect(),
            info,
            loaded: HashMap::new(),
            requests: 0,
        })
    }
    /// Decode the signals a request needs and forget the least recently used.
    fn load(&mut self, ids: &[u32]) -> Result<Vec<WSignalRef>> {
        let refs: Vec<_> = ids
            .iter()
            .map(|i| {
                self.refs
                    .get(*i as usize)
                    .map(|v| self.hierarchy[*v].signal_ref())
                    .context("Unknown waveform variable")
            })
            .collect::<Result<_>>()?;
        self.requests += 1;
        let missing: Vec<_> = refs
            .iter()
            .filter(|r| !self.loaded.contains_key(r))
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        for s in self.source.load_signals(&missing, &self.hierarchy, true) {
            self.loaded.insert(s.signal_ref(), (self.requests, s));
        }
        for r in &refs {
            if let Some((used, _)) = self.loaded.get_mut(r) {
                *used = self.requests;
            }
        }
        if self.loaded.len() > LOADED_SIGNALS {
            let mut uses: Vec<u64> = self.loaded.values().map(|(used, _)| *used).collect();
            uses.sort_unstable_by(|a, b| b.cmp(a));
            let oldest_kept = uses[LOADED_SIGNALS - 1];
            self.loaded.retain(|_, (used, _)| *used >= oldest_kept);
        }
        Ok(refs)
    }
    /// The nearest time after or before `time` at which a variable changes value.
    /// `bit` limits this to one character of the value as printed, leftmost first.
    pub fn edge(
        &mut self,
        id: u32,
        time: u64,
        forward: bool,
        bit: Option<usize>,
    ) -> Result<Option<u64>> {
        let r = self.load(&[id])?[0];
        let Some((_, sig)) = self.loaded.get(&r) else {
            return Ok(None);
        };
        let indices = sig.time_indices();
        let value = |position: usize| {
            let offset = sig.get_offset(indices[position]).unwrap();
            let text = sig.get_value_at(&offset, 0).to_string();
            match bit {
                Some(bit) => text.chars().nth(bit).map(String::from).unwrap_or_default(),
                None => text,
            }
        };
        // A dump may repeat a value, so a recorded entry is an edge only when it differs.
        let changed = |position: usize| position == 0 || value(position) != value(position - 1);
        let at = |position: usize| self.times[indices[position] as usize];
        let found = if forward {
            let first = indices.partition_point(|i| self.times[*i as usize] <= time);
            (first..indices.len()).find(|p| changed(*p))
        } else {
            let end = indices.partition_point(|i| self.times[*i as usize] < time);
            (0..end).rev().find(|p| changed(*p))
        };
        Ok(found.map(at))
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
        let refs = self.load(ids)?;
        let pixels = pixels.clamp(1, 8192) as u128;
        let span = (end as u128 - start as u128).max(1);
        Ok(ids
            .iter()
            .zip(refs)
            .map(|(id, r)| {
                let mut result = Vec::new();
                if let Some((_, sig)) = self.loaded.get(&r) {
                    let value = |idx| {
                        let offset = sig.get_offset(idx).unwrap();
                        sig.get_value_at(&offset, 0).to_string()
                    };
                    // Only the last transition of a busy pixel is shown, so only it is formatted.
                    let mut busy = None;
                    let settle = |result: &mut Vec<Transition>, busy: &mut Option<(u64, _)>| {
                        if let (Some((time, idx)), Some(last)) = (busy.take(), result.last_mut()) {
                            *last = Transition {
                                time: time.to_string(),
                                value: format!("activity:{}", value(idx)),
                            };
                        }
                    };
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
                        let bucket =
                            ((t.max(start) as u128 - start as u128) * pixels / span).min(pixels);
                        if previous_bucket == Some(bucket) {
                            bucket_count += 1;
                            if bucket_count > 1 {
                                busy = Some((t, idx));
                                continue;
                            }
                        } else {
                            settle(&mut result, &mut busy);
                            previous_bucket = Some(bucket);
                            bucket_count = 0;
                        }
                        result.push(Transition {
                            time: t.to_string(),
                            value: value(idx),
                        });
                    }
                    settle(&mut result, &mut busy);
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

/// A gate netlist names some wires bit by bit, `\name[3]`, and the simulator dumps
/// them so. The trace reader joins such neighbours into one vector `\name`, and
/// files `\name[9][3]` as vector `[9]` in a scope `\name`. Find the vector and the
/// declared index that a one-bit wire is.
fn joined_bit<'a>(
    wavepaths: &BTreeMap<Vec<String>, Vec<&'a WaveVariable>>,
    key: &[String],
) -> Option<(&'a WaveVariable, i64)> {
    let (name, scope) = key.split_last()?;
    let mut base = name.as_str();
    let mut indices = Vec::new();
    while let Some((head, index)) = base.strip_suffix(']').and_then(|b| b.rsplit_once('[')) {
        if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
            break;
        }
        indices.push(index);
        base = head;
    }
    let index: i64 = indices.first()?.parse().ok()?;
    let mut path = scope.to_vec();
    path.push(format!("\\{base}"));
    path.extend(indices[1..].iter().rev().map(|i| format!("[{i}]")));
    let mut found = wavepaths.get(&path)?.iter().filter(|v| {
        v.index.is_some_and(|(left, right)| {
            (left.min(right)..=left.max(right)).contains(&index)
                && v.width as i64 == (left - right).abs() + 1
        })
    });
    let variable = found.next()?;
    found.next().is_none().then_some((*variable, index))
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
    let mut wavepaths: BTreeMap<Vec<String>, Vec<&WaveVariable>> = BTreeMap::new();
    for v in &info.variables {
        wavepaths.entry(v.path.clone()).or_default().push(v);
    }
    let mut result = Vec::new();
    for scope in &snapshot.design.scopes {
        for sig in graph::signal_refs(snapshot, &scope.path)? {
            let mut path = run.dut_scope.clone();
            path.extend_from_slice(&sig.path[1..]);
            let key = path;
            // The trace keeps the backslash of an escaped identifier.
            let mut escaped = key.clone();
            if let Some(name) = escaped.last_mut() {
                name.insert(0, '\\');
            }
            let declared = wavepaths.get(&key).or_else(|| wavepaths.get(&escaped));
            let candidates: Vec<u32> = declared
                .into_iter()
                .flatten()
                .filter(|v| range_matches(&sig, v))
                .map(|v| v.id)
                .collect();
            let joined = (candidates.is_empty() && sig.width == 1)
                .then(|| joined_bit(&wavepaths, &key))
                .flatten();
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
            } else if let Some((variable, _)) = joined {
                (
                    vec![variable.id],
                    "exact",
                    "DUT scope and exact declaration path; the trace groups this wire with its neighbouring bits",
                )
            } else if declared.is_some() {
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
            let joined = joined.filter(|_| !manual.contains_key(&sig.id));
            let bit_correspondence = if let Some((_, index)) = joined {
                vec![(sig.offset, index)]
            } else if ["exact", "manual"].contains(&status) {
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
                variable_bit: joined.and_then(|(variable, index)| {
                    let (_, right) = variable.index?;
                    Some((index - right).unsigned_abs() as u32)
                }),
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
    fn an_unsupported_format_is_rejected_even_with_a_vcd_filename() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("renamed.vcd");
        std::fs::write(&path, b"GHDLwave\n\x10\x00\x01\x01\x04\x04\x00").unwrap();
        let error = WaveStore::open(&path).err().unwrap();
        assert!(error.to_string().contains("Unsupported waveform format"));
    }
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
    #[test]
    fn busy_pixels_show_their_last_value_and_other_requests_keep_rows_decoded() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("test.vcd");
        let mut text = String::from("$timescale 1 ps $end\n$scope module tb $end\n$var wire 1 ! a $end\n$var wire 1 \" b $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n0\"\n");
        for time in 1..=9 {
            text.push_str(&format!("#{time}\n{}!\n", time % 2));
        }
        text.push_str("#1000\n0!\n1\"\n");
        std::fs::write(&p, text).unwrap();
        let mut w = WaveStore::open(&p).unwrap();
        let rows = w.window(&[0], 0, 1000, 10).unwrap();
        let shown: Vec<_> = rows[0]
            .transitions
            .iter()
            .map(|t| (t.time.as_str(), t.value.as_str()))
            .collect();
        assert_eq!(shown, [("0", "0"), ("9", "activity:1"), ("1000", "0")]);
        w.values(&[1], 1000).unwrap();
        assert_eq!(w.loaded.len(), 2);
    }
    #[test]
    fn an_edge_is_the_nearest_change_of_the_variable_or_of_one_of_its_bits() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("test.vcd");
        std::fs::write(&p, "$timescale 10 ns $end\n$scope module tb $end\n$var wire 1 ! a $end\n$var wire 2 \" v [1:0] $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\nb00 \"\n#5\n1!\nb01 \"\n#7\n1!\nb11 \"\n#9\n0!\nb10 \"\n").unwrap();
        let mut w = WaveStore::open(&p).unwrap();
        assert_eq!(
            w.info.timescale,
            Some(Timescale {
                factor: 10,
                exponent: -9
            })
        );
        // The value repeated at 7 is not a change.
        assert_eq!(w.edge(0, 5, true, None).unwrap(), Some(9));
        assert_eq!(w.edge(0, 9, false, None).unwrap(), Some(5));
        assert_eq!(w.edge(0, 9, true, None).unwrap(), None);
        assert_eq!(w.edge(1, 0, true, None).unwrap(), Some(5));
        // The left bit of `v` first changes at 7, the right one at 5 and again at 9.
        assert_eq!(w.edge(1, 0, true, Some(0)).unwrap(), Some(7));
        assert_eq!(w.edge(1, 5, true, Some(1)).unwrap(), Some(9));
        assert_eq!(w.edge(1, 9, false, Some(0)).unwrap(), Some(7));
    }
}
