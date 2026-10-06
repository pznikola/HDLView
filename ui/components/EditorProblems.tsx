import type {
  EditorDiagnostic,
  EditorLintResult,
  EditorLocation,
} from "../types";
import { fileLabel } from "../projects";

export function EditorProblems({
  result,
  error,
  status,
  onNavigate,
  onConfigure,
}: {
  result?: EditorLintResult;
  error?: string;
  status: string;
  onNavigate: (location: EditorLocation) => void;
  onConfigure?: () => void;
}) {
  const groups = new Map<string, EditorDiagnostic[]>();
  for (const diagnostic of result?.diagnostics ?? []) {
    const label = diagnostic.file ? fileLabel(diagnostic.file) : "Project";
    const group = groups.get(label) ?? [];
    group.push(diagnostic);
    groups.set(label, group);
  }
  return (
    <div
      className="editor-problems"
      aria-label="Editor problems"
      aria-live="polite"
    >
      <p>{status || "Open a working RTL file to check it."}</p>
      {onConfigure && (
        <button onClick={onConfigure}>Configure Simulation…</button>
      )}
      {error && <p className="error">{error}</p>}
      {result?.engines.map(
        (engine) =>
          engine.message && (
            <p
              key={engine.engine}
              className={engine.status === "failed" ? "error" : "hint"}
            >
              {engine.engine}: {engine.message}
            </p>
          ),
      )}
      {result?.truncated && (
        <p className="hint">
          Showing the first 1,000 diagnostics; additional findings were omitted.
        </p>
      )}
      {result &&
        !result.limited &&
        !result.truncated &&
        !result.diagnostics.length && <p>No problems found.</p>}
      {Array.from(groups, ([label, diagnostics]) => (
        <section key={label}>
          <strong>{label}</strong>
          <ul>
            {diagnostics.map((diagnostic, index) => (
              <li
                key={`${diagnostic.engine}:${diagnostic.code}:${diagnostic.from}:${index}`}
                className={diagnostic.severity}
              >
                <button
                  disabled={!diagnostic.file}
                  onClick={() => onNavigate(diagnostic)}
                >
                  <span>
                    {diagnostic.severity} · {diagnostic.engine} ·{" "}
                    {diagnostic.code}
                  </span>{" "}
                  {diagnostic.line !== undefined && (
                    <span>
                      {diagnostic.line}:{diagnostic.column}{" "}
                    </span>
                  )}
                  {diagnostic.message}
                </button>
                {diagnostic.related.map((related, i) => (
                  <button
                    className="related-problem"
                    key={i}
                    disabled={!related.file}
                    onClick={() => onNavigate(related)}
                  >
                    {related.file &&
                      `${fileLabel(related.file)}:${related.line}:${related.column} `}
                    {related.message}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
