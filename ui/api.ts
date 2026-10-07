import { invoke, isTauri } from "@tauri-apps/api/core";
declare global {
  interface Window {
    __HDLVIEW_TEST_API__?: (action: string, args: unknown) => Promise<unknown>;
  }
}
export async function api<T>(action: string, args: unknown = {}): Promise<T> {
  if (
    (import.meta.env.DEV || import.meta.env.MODE === "e2e") &&
    window.__HDLVIEW_TEST_API__
  )
    return window.__HDLVIEW_TEST_API__(action, args) as Promise<T>;
  return invoke<T>("api", { action, args });
}

export async function saveSchematicSvg(svg: string): Promise<void> {
  if (isTauri()) {
    await invoke("save_schematic_svg", { svg });
    return;
  }
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "hdlview-schematic.svg";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
