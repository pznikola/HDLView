---
name: hdlview-toolchain-debug
description: Reproduce and diagnose HDLView compilation, simulation, Docker, plugin, PDK, or LibreLane failures, and verify changes to tool adapters or compiler helpers. Use for tool execution and artifact-generation problems, rather than purely visual UI defects.
---

# HDLView toolchain debugging

Work from the repository root and follow [the project rules](../../../AGENTS.md).
Use the shared core/CLI runner so diagnosis exercises the same tool execution as
the desktop. Read [qualified versions and known limits](../../../docs/QUALIFICATION.md)
when compatibility or claimed tool coverage matters.

## Reproduce with evidence

1. Capture the failing project, representation, simulation configuration if any,
   selected profile, and artifact directory. Inspect captured files and generated
   scripts before changing source or tool configuration.
2. Build the current CLI with `cargo build -p hdlview`; run `target/debug/hdlview --help`
   if command options are uncertain. Compiler helpers embedded through `include_str!`
   require rebuilding the CLI after Python edits.
3. Probe the selected profile:

   ```sh
   target/debug/hdlview --store .hdlview/skill-debug --profile tools/profiles/docker.json probe
   ```

   Substitute the user's configured profile. Inspect each probe result: an
   `unavailable:` entry can appear even when the probe command exits successfully.
   Version probes do not prove plugin, model, or language-feature compatibility.

4. Reproduce the affected stage in an isolated artifact store. For example:

   ```sh
   target/debug/hdlview --store .hdlview/skill-debug --profile tools/profiles/docker.json build tests/fixtures/counter/hdlview.project.json --representation elaborated
   ```

   Use the returned snapshot directory for simulation. A snapshot carries its
   toolchain profile; passing a different global profile to `simulate` does not
   replace it. Build a new snapshot to compare providers or changed tool settings.

5. Inspect the failed invocation's `logs/*.log` and paired `*.command.json` files:
   executable, arguments, working directory, environment, exit code, and duration.
   Reduce the failure to the relevant HDL construct or tool input. Redact sensitive
   environment values when reporting evidence.

## Read only the relevant procedure

- For source extraction, elaboration, or synthesis, read [compilation.md](references/compilation.md).
- For testbenches, model loading, traces, or SDF, read [simulation.md](references/simulation.md).
- For LibreLane steps or final artifact collection, read [physical-flow.md](references/physical-flow.md).

For Docker execution, verify the selected image exists locally and inspect the
resolved immutable image identity. Start from [the qualified profile](../../../tools/profiles/docker.json)
and [derived image](../../../tools/Dockerfile), rather than assuming the base image
contains all dependencies. Preserve tool-specific library paths and writable caches.
Keep captured inputs and external PDK mounts read-only, output directories writable,
and flow execution inside the configured container without nested Docker.

For native execution, compare executable/plugin paths, Python bindings, environment,
and PDK roots against [the native profile example](../../../tools/profiles/native.example.json).
Do not silently switch providers, simulators, or plugin versions after a failure.

## Verify and finish

Fix the adapter or configuration responsible for the reproduced failure. Preserve
logs, cancellation, argument-array execution, and atomic artifact publication.
Use a focused real-tool fixture plus [applicable code checks](../hdlview-coding-style/references/verification.md#verification).
Run the wider [qualification script](../../../tools/qualify.py) only when its matrix
is relevant; `--physical` also launches mapped and post-layout flows for both technology variants.

Report the cause, effective versions/profile, exact exercised workflow, and remaining
compatibility limits. If a prerequisite is missing, identify it and stop that run;
successful mocks or version probes must not be presented as real-tool validation.
