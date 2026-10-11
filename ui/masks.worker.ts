import { prepareMasks, sceneTransfers, type MaskScene } from "./mask-scene";
import type { MaskData } from "./types";

export type MaskResponse = { scene: MaskScene } | { error: string };
self.onmessage = ({ data }: MessageEvent<MaskData>) => {
  try {
    const scene = prepareMasks(data);
    self.postMessage({ scene } satisfies MaskResponse, {
      transfer: sceneTransfers(scene),
    });
  } catch (error) {
    self.postMessage({ error: String(error) } satisfies MaskResponse);
  }
};
