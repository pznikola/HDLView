import type { ToolchainReport, ToolchainStatus } from "../types";

const steps: { title: string; states: ToolchainStatus["state"][] }[] = [
  { title: "Install Docker", states: ["docker_missing"] },
  { title: "Start Docker", states: ["docker_stopped"] },
  { title: "Download the tools image", states: ["image_missing", "image_old"] },
];

/** A short name of what blocks the toolchain, for the footer. */
export function toolchainProblem(status: ToolchainStatus | undefined) {
  if (!status || status.state === "ready") return "";
  return {
    docker_missing: "Docker not installed",
    docker_stopped: "Docker not running",
    image_missing: "tools image missing",
    image_old: "tools image too old",
    unsupported: "not supported here",
  }[status.state];
}

function Copyable({ text }: { text: string }) {
  return (
    <div className="setup-command">
      <code>{text}</code>
      <button onClick={() => void navigator.clipboard.writeText(text)}>
        Copy
      </button>
    </div>
  );
}

/** The install steps, with the one that blocks the toolchain explained. */
export function ToolchainSetup({
  status,
  onCheck,
  onDefault,
  checkedAt,
}: {
  status: ToolchainStatus;
  /** When the status was last asked for, so a repeated check shows it ran. */
  checkedAt?: string;
  onCheck: () => void;
  /** Present when the selected profile is not the default one. */
  onDefault?: () => void;
}) {
  const current = steps.findIndex((s) => s.states.includes(status.state));
  const detail = (
    <>
      <p>{status.message}</p>
      {status.link && <Copyable text={status.link} />}
      {status.commands.map((command) => (
        <Copyable key={command} text={command} />
      ))}
    </>
  );
  return (
    <section className="setup" aria-label="Toolchain setup">
      {current < 0 ? (
        detail
      ) : (
        <ol>
          {steps.map((step, index) => (
            <li
              key={step.title}
              className={
                index < current ? "done" : index === current ? "current" : ""
              }
            >
              <strong>
                {index < current ? "✓ " : ""}
                {step.title}
              </strong>
              {index === current && detail}
            </li>
          ))}
        </ol>
      )}
      <div className="setup-actions">
        <button onClick={onCheck}>Check again</button>
        {onDefault && (
          <button onClick={onDefault}>Use the default profile</button>
        )}
        {checkedAt && (
          <span className="setup-checked">Checked {checkedAt}</span>
        )}
      </div>
    </section>
  );
}

/** What each tool of a working toolchain reported. */
export function ToolchainTools({ report }: { report: ToolchainReport }) {
  return (
    <table className="setup-tools">
      <tbody>
        {Object.entries(report.tools).map(([tool, text]) => (
          <tr
            key={tool}
            className={text.startsWith("unavailable:") ? "missing" : ""}
          >
            <th>{tool}</th>
            <td>{text.trim()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
