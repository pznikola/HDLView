import { prepareSolid, solidTransfers, type SolidScene } from "./solid-scene";
import type { SolidData } from "./types";

export type SolidResponse = { scene: SolidScene } | { error: string };
self.onmessage = ({ data }: MessageEvent<SolidData>) => {
  try {
    const scene = prepareSolid(data);
    self.postMessage({ scene } satisfies SolidResponse, {
      transfer: solidTransfers(scene),
    });
  } catch (error) {
    self.postMessage({ error: String(error) } satisfies SolidResponse);
  }
};
