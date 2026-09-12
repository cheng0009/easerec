/** 默认录制配置（真正接通到录制引擎的参数）。
 *  1080p30 是流畅与画质的平衡点：4K60 的实时合成+VP9 软编码是回放卡顿主因。 */
export const DEFAULT_RECORDING_CONFIG = {
  fps: 30,
  resolution: { width: 1920, height: 1080 } as const,
  bitrateMbps: 20,
/** 智能跟焦：录轨迹、导出渲染 —— 卖点功能，默认开启。 */
  zoomEnabled: true,
  zoomLevel: 1.5,
} as const;
