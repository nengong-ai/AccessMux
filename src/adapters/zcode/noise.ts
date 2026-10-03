// 本机插件噪音剥离（T019，D21 噪音处置第 2 层兜底）。
//
// app-server 形态的回复可能带用户全局 `~/.zcode/cli/config.json` 插件（如
// tokline）指示模型附加的遥测尾巴（R016 §5.2 实测：`"\n\n> ⏱ tokline · …"`）。
// 第一层处置是 spawn HOME 沙箱（配置文件解析进沙箱，插件根本不加载）；
// 本模块只做兜底：确定性剥离**末尾**的已知插件尾巴，绝不碰其余上游内容。

/** 末尾已知插件尾巴行（目前只有 tokline 遥测行一族）。 */
const TRAILING_NOISE_LINE_RE = /^>\s*⏱\s*tokline\b/;

/**
 * 剥离回复末尾的已知插件尾巴：从最后一段连续的 `> ⏱ tokline …` 引用行
 * （连同其前的空行）往前删；正文中间出现的同款行不动（保守——只在收尾剥）。
 */
export function stripKnownNoise(text: string): string {
  let lines = text.split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last !== undefined && TRAILING_NOISE_LINE_RE.test(last)) {
      lines = lines.slice(0, -1);
      // 尾行删掉后紧邻的空行一并删（保持不留悬挂空行）
      while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines = lines.slice(0, -1);
      }
      continue;
    }
    break;
  }
  return lines.join('\n');
}
