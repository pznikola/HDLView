import { useEffect, useRef } from "react";
import { EditorState, Transaction } from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  keymap,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import {
  linter,
  lintGutter,
  lintKeymap,
  previousDiagnostic,
  setDiagnostics,
  setDiagnosticsEffect,
} from "@codemirror/lint";
import type { EditorDiagnostic } from "../types";
const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: "#7bc6bb" },
  { tag: [tags.string, tags.number, tags.bool], color: "#e8ba82" },
  { tag: tags.comment, color: "#899baa" },
  { tag: [tags.typeName, tags.atom], color: "#b7a5e5" },
]);
export interface EditorTab {
  id: string;
  label: string;
  text: string;
  saved: string;
  readonly: boolean;
  line?: number;
  source?: string;
  snapshotId?: string;
  version?: number;
  selection?: { from: number; to: number };
}
export function SourceEditor({
  tab,
  tabIds,
  onChange,
  diagnostics,
}: {
  tab?: EditorTab;
  tabIds: string[];
  onChange: (id: string, text: string) => void;
  diagnostics: EditorDiagnostic[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const states = useRef(new Map<string, EditorState>());
  const changed = useRef(onChange);
  const current = useRef(tab);
  useEffect(() => {
    changed.current = onChange;
    current.current = tab;
  }, [onChange, tab]);
  useEffect(() => {
    const tab = current.current;
    if (!host.current || !tab) return;
    const id = tab.id;
    const savedStates = states.current;
    const state =
      savedStates.get(id) ??
      EditorState.create({
        doc: tab.text,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          search(),
          linter(null),
          lintGutter(),
          EditorState.transactionExtender.of((transaction) =>
            transaction.docChanged
              ? { effects: setDiagnosticsEffect.of([]) }
              : null,
          ),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
            ...lintKeymap,
            { key: "Shift-F8", run: previousDiagnostic },
          ]),
          StreamLanguage.define(verilog),
          syntaxHighlighting(highlighting),
          EditorState.readOnly.of(tab.readonly),
          EditorView.editable.of(!tab.readonly),
          EditorView.theme(
            {
              "&": {
                height: "100%",
                backgroundColor: "#101923",
                color: "#dbe5ee",
              },
              ".cm-scroller": {
                overflow: "auto",
                overscrollBehavior: "contain",
                fontFamily: "monospace",
              },
              ".cm-gutters": {
                backgroundColor: "#15202b",
                color: "#8295a8",
                border: "none",
              },
              ".cm-activeLine": { backgroundColor: "#1c2a37" },
            },
            { dark: true },
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              changed.current(id, update.state.doc.toString());
          }),
        ],
      });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    return () => {
      savedStates.set(id, editor.state);
      editor.destroy();
      view.current = undefined;
    };
    // Buffer updates synchronize below without rebuilding the editor or its undo history.
  }, [tab?.id, tab?.readonly]);
  useEffect(() => {
    for (const id of states.current.keys()) {
      if (!tabIds.includes(id)) states.current.delete(id);
    }
  }, [tabIds]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !tab) return;
    if (editor.state.doc.toString() !== tab.text)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: tab.text },
        annotations: Transaction.addToHistory.of(false),
      });
  }, [tab?.text, tab]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !tab?.line) return;
    const line = editor.state.doc.line(
      Math.max(1, Math.min(tab.line, editor.state.doc.lines)),
    );
    editor.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
  }, [tab?.id, tab?.line]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(
      setDiagnostics(
        editor.state,
        diagnostics.flatMap((d) =>
          d.from !== undefined &&
          d.to !== undefined &&
          d.to <= editor.state.doc.length
            ? [
                {
                  from: d.from,
                  to: d.to,
                  severity: d.severity,
                  source: `${d.engine} · ${d.code}`,
                  message: [d.message, ...d.related.map((r) => r.message)].join(
                    "\n",
                  ),
                },
              ]
            : [],
        ),
      ),
    );
  }, [diagnostics, tab?.id]);
  useEffect(() => {
    const editor = view.current;
    const selection = tab?.selection;
    if (!editor || !selection) return;
    editor.dispatch({
      selection: {
        anchor: Math.min(selection.from, editor.state.doc.length),
        head: Math.min(selection.to, editor.state.doc.length),
      },
      scrollIntoView: true,
    });
    editor.focus();
  }, [tab?.selection, tab?.id]);
  return (
    <div className="source-editor" aria-label="RTL editor" ref={host}>
      {!tab && <p className="hint">Select a source file to edit it.</p>}
    </div>
  );
}
