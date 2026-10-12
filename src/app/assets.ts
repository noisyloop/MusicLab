import type { Id } from '../model/types';
import { computePeaks, type Peaks } from '../util/peaks';

export interface LoadedAsset {
  /** Original file bytes, saved verbatim into .musiclab files. */
  bytes: Uint8Array;
  buffer: AudioBuffer;
  peaks: Peaks;
}

/**
 * Runtime audio data keyed by asset id. Lives outside the project model (and
 * outside undo history) because it is large and immutable; the project only
 * references assets by id.
 */
export class AssetStore {
  private map = new Map<Id, LoadedAsset>();

  get(id: Id): LoadedAsset | undefined {
    return this.map.get(id);
  }

  add(id: Id, bytes: Uint8Array, buffer: AudioBuffer): LoadedAsset {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const asset = { bytes, buffer, peaks: computePeaks(channels, buffer.sampleRate) };
    this.map.set(id, asset);
    return asset;
  }

  clear(): void {
    this.map.clear();
  }

  bytesMap(): Map<Id, Uint8Array> {
    return new Map([...this.map].map(([id, a]) => [id, a.bytes]));
  }
}
