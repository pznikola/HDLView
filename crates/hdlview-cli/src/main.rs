use anyhow::Result;
use clap::{Parser, Subcommand};
use hdlview_core::{pipeline, project::*, runner::*, service::Service, simulation, waveform, *};
use std::{
    io::{self, BufRead},
    path::PathBuf,
};
#[derive(Parser)]
#[command(
    version,
    about = "HDLView reproducible HDL schematic and waveform workflows"
)]
struct Cli {
    #[arg(long, global = true, default_value = ".hdlview")]
    store: PathBuf,
    #[arg(long, global = true)]
    profile: Option<PathBuf>,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    Probe,
    ResumePhysical {
        directory: PathBuf,
    },
    Build {
        project: PathBuf,
        #[arg(long, default_value = "elaborated")]
        representation: String,
    },
    Simulate {
        snapshot: PathBuf,
        #[arg(long)]
        configuration: String,
    },
    Wave {
        trace: PathBuf,
    },
    Import {
        snapshot: PathBuf,
        trace: PathBuf,
        #[arg(long, value_delimiter = '.')]
        dut_scope: Vec<String>,
    },
    View {
        snapshot: PathBuf,
        #[arg(long, value_delimiter = '.')]
        scope: Vec<String>,
        #[arg(long)]
        focus: Option<String>,
    },
    Rpc,
}
fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--wave-worker") {
        return hdlview_core::waveprocess::worker_main();
    }
    let cli = Cli::parse();
    let profile = if let Some(path) = cli.profile {
        read_json(&path)?
    } else {
        ToolchainProfile::default()
    };
    let value = match cli.command {
        Commands::ResumePhysical { directory } => serde_json::to_value(pipeline::resume_physical(
            &directory,
            CancelToken::default(),
        )?)?,
        Commands::Probe => {
            let dir = unique_dir(&cli.store, "probe")?;
            Runner::new(profile, dir, CancelToken::default()).check()
        }
        Commands::Build {
            project,
            representation,
        } => {
            let rep = serde_json::from_value(serde_json::Value::String(representation))?;
            serde_json::to_value(pipeline::compile(
                &project,
                profile,
                rep,
                &cli.store,
                CancelToken::default(),
            )?)?
        }
        Commands::Simulate {
            snapshot,
            configuration,
        } => serde_json::to_value(simulation::simulate(
            &read_snapshot(&snapshot)?,
            &configuration,
            CancelToken::default(),
        )?)?,
        Commands::Wave { trace } => serde_json::to_value(waveform::WaveStore::open(&trace)?.info)?,
        Commands::Import {
            snapshot,
            trace,
            dut_scope,
        } => serde_json::to_value(waveform::import_trace(
            &read_snapshot(&snapshot)?,
            &trace,
            dut_scope,
            &cli.store,
        )?)?,
        Commands::View {
            snapshot,
            scope,
            focus,
        } => {
            let s = read_snapshot(&snapshot)?;
            let scope = if scope.is_empty() {
                vec![s.project.top.clone()]
            } else {
                scope
            };
            serde_json::to_value(schematic::view(
                &s,
                &scope,
                focus.as_deref(),
                hdlview_core::graph::LOGIC_LIMIT,
                false,
                &SchematicOptions::default(),
            )?)?
        }
        Commands::Rpc => {
            let service = Service::new(cli.store);
            for line in io::stdin().lock().lines() {
                let line = line?;
                let response = (|| -> Result<serde_json::Value> {
                    let v: serde_json::Value = serde_json::from_str(&line)?;
                    service.request(v["action"].as_str().unwrap_or(""), v["args"].clone())
                })();
                println!(
                    "{}",
                    match response {
                        Ok(v) => serde_json::json!({"ok":true,"result":v}),
                        Err(e) => serde_json::json!({"ok":false,"error":format!("{e:#}")}),
                    }
                );
            }
            return Ok(());
        }
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
