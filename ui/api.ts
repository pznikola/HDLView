import { invoke } from "@tauri-apps/api/core";
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
