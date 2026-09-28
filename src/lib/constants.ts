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

/** MiniMax 预置音色（AI 换声用）——共享给渲染端下拉框与主进程客户端。
 *  只收录适合中文讲解的教学感音色；用户克隆的音色在设置里动态追加。 */
export const MINIMAX_PRESET_VOICES: { id: string; label: string }[] = [
  { id: "male-qn-qingse", label: "青涩男声 · 干净清爽" },
  { id: "male-qn-jingying", label: "精英男声 · 沉稳专业" },
  { id: "male-qn-badao", label: "霸道男声 · 磁性浑厚" },
  { id: "female-shaonv", label: "少女音 · 明快亲切" },
  { id: "female-yujie", label: "御姐音 · 从容大气" },
  { id: "female-chengshu", label: "成熟女声 · 温和可信" },
  { id: "female-tianmei", label: "甜美女声 · 活泼轻快" },
];
