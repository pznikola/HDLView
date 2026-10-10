//! Isolates waveform parsing so cancellation can terminate even a parser call.
use crate::{
    model::{WaveInfo, WaveRow},
    runner::CancelToken,
    waveform::WaveStore,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};
pub struct WaveProcess {
    child: Child,
    input: ChildStdin,
    replies: Receiver<String>,
    pub info: WaveInfo,
}
impl Drop for WaveProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl WaveProcess {
    pub fn open(path: &Path, cancel: &CancelToken) -> Result<Self> {
        let mut child = Command::new(std::env::current_exe()?)
            .arg("--wave-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(File::create(path.with_extension("parser.log"))?)
            .spawn()?;
        let input = child.stdin.take().context("Missing worker input")?;
        let output = child.stdout.take().context("Missing worker output")?;
        let (sender, replies) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let mut worker = Self {
            child,
            input,
            replies,
            info: WaveInfo {
                variables: vec![],
                end_time: "0".into(),
                timescale: None,
            },
        };
        let value = worker.request(json!({"open":path}), cancel, 3600)?;
        worker.info = serde_json::from_value(value)?;
        Ok(worker)
    }
    fn request(&mut self, value: Value, cancel: &CancelToken, timeout: u64) -> Result<Value> {
        writeln!(self.input, "{value}")?;
        self.input.flush()?;
        let start = Instant::now();
        loop {
            cancel.check()?;
            if start.elapsed() > Duration::from_secs(timeout) {
                let _ = self.child.kill();
                bail!("Waveform worker timed out")
            }
            match self.replies.recv_timeout(Duration::from_millis(40)) {
                Ok(line) => {
                    let result: Value = serde_json::from_str(&line)?;
                    if result["ok"] == true {
                        return Ok(result["result"].clone());
                    }
                    bail!("Waveform parser: {}", result["error"])
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => bail!("Waveform worker exited; inspect parser.log"),
            }
        }
    }
    pub fn window(
        &mut self,
        ids: &[u32],
        start: u64,
        end: u64,
        pixels: usize,
    ) -> Result<Vec<WaveRow>> {
        serde_json::from_value(self.request(
            json!({"ids":ids,"start":start,"end":end,"pixels":pixels}),
            &CancelToken::default(),
            120,
        )?)
        .map_err(Into::into)
    }
    pub fn edge(
        &mut self,
        id: u32,
        time: u64,
        forward: bool,
        bit: Option<usize>,
    ) -> Result<Option<u64>> {
        serde_json::from_value(self.request(
            json!({"edge":id,"time":time,"forward":forward,"bit":bit}),
            &CancelToken::default(),
            120,
        )?)
        .map_err(Into::into)
    }
}
pub fn worker_main() -> Result<()> {
    let mut wave = None;
    for line in std::io::stdin().lock().lines() {
        let response = (|| -> Result<Value> {
            let v: Value = serde_json::from_str(&line?)?;
            if let Some(path) = v["open"].as_str() {
                let opened = WaveStore::open(Path::new(path))?;
                let info = json!(opened.info);
                wave = Some(opened);
                return Ok(info);
            }
            let wave = wave.as_mut().context("Open trace first")?;
            if let Some(id) = v["edge"].as_u64() {
                return Ok(json!(wave.edge(
                    id as u32,
                    v["time"].as_u64().context("time required")?,
                    v["forward"] == true,
                    v["bit"].as_u64().map(|bit| bit as usize)
                )?));
            }
            let ids = serde_json::from_value::<Vec<u32>>(v["ids"].clone())?;
            Ok(json!(wave.window(
                &ids,
                v["start"].as_u64().context("start required")?,
                v["end"].as_u64().context("end required")?,
                v["pixels"].as_u64().context("pixels required")? as usize
            )?))
        })();
        println!(
            "{}",
            match response {
                Ok(value) => json!({"ok":true,"result":value}),
                Err(error) => json!({"ok":false,"error":format!("{error:#}")}),
            }
        );
        std::io::stdout().flush()?;
    }
    Ok(())
}
