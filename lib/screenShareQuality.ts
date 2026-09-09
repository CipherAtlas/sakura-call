export type ScreenSharePresetId =
  | "detail"
  | "balanced"
  | "motion"
  | "ultra"
  | "custom";
export type ScreenShareOptimization = "detail" | "motion";
export type ScreenShareQualitySettings = {
  presetId: ScreenSharePresetId;
  width: number;
  height: number;
  frameRate: number;
  bitrateKbps: number;
  optimization: ScreenShareOptimization;
  prioritizeScreen: boolean;
};
export const screenSharePresetDefaults: Record<
  Exclude<ScreenSharePresetId, "custom">,
  ScreenShareQualitySettings
> = {
  detail: {
    presetId: "detail",
    width: 1920,
    height: 1080,
    frameRate: 15,
    bitrateKbps: 4500,
    optimization: "detail",
    prioritizeScreen: true,
  },
  balanced: {
    presetId: "balanced",
    width: 1920,
    height: 1080,
    frameRate: 24,
    bitrateKbps: 6000,
    optimization: "detail",
    prioritizeScreen: true,
  },
  motion: {
    presetId: "motion",
    width: 1920,
    height: 1080,
    frameRate: 60,
    bitrateKbps: 8500,
    optimization: "motion",
    prioritizeScreen: true,
  },
  ultra: {
    presetId: "ultra",
    width: 3840,
    height: 2160,
    frameRate: 30,
    bitrateKbps: 18000,
    optimization: "detail",
    prioritizeScreen: true,
  },
};
