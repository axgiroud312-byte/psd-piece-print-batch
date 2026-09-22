import {
  FixedRegionOutputPort,
  type OutputCapabilityGate,
} from "./fixed-region-output-port";
import {
  PhotoshopFixedRegionRenderer,
  type PhotoshopRenderRuntime,
} from "./photoshop-fixed-region-renderer";
import {
  UxpOutputStorage,
  type UxpOutputFolder,
} from "./uxp-output-storage";

export interface UxpOutputPortOptions {
  rootLocation: string;
  storageScopeId: string;
  root: UxpOutputFolder;
  binaryFormat: unknown;
  capability: OutputCapabilityGate;
  runtime?: PhotoshopRenderRuntime;
  now?: () => string;
}

export function createUxpOutputPort(options: UxpOutputPortOptions): FixedRegionOutputPort {
  const storage = new UxpOutputStorage({
    rootLocation: options.rootLocation,
    root: options.root,
    binaryFormat: options.binaryFormat,
  });
  return new FixedRegionOutputPort({
    outputRoot: options.rootLocation,
    storageScopeId: options.storageScopeId,
    storage,
    renderer: new PhotoshopFixedRegionRenderer(storage, options.runtime),
    capability: options.capability,
    now: options.now,
  });
}
