// Path / 标识符的红化工具：诊断输出可分享时不暴露用户名 / token / 真实 id。
// 参考 dsh-connect-trae/src/redact.ts（D11 同款需求，安全金标准 D4 兜底）。
//
// 原则：
// - 路径只替换用户段，保留有意义的后缀（应用名 + storage.json 等）
// - 标识符只描述形状（位数 / 是否纯数字），从不打印原值
// - 自由文本诊断统一过滤鉴权字段 / token；不用于正常模型正文

/**
 * 把路径里的用户段替换为 `<user>`，其余部分保留。
 *
 * 覆盖：
 * - Windows：`C:\Users\<name>\...` 与 `C:\Documents and Settings\<name>\...`
 * - POSIX：`/Users/<name>/...` 与 `/home/<name>/...`
 */
export function maskUserPath(path: string): string {
  return String(path)
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/i, '$1<user>')
    .replace(/([A-Za-z]:\\Documents and Settings\\)[^\\]+/i, '$1<user>')
    .replace(/^(\/(?:Users|home)\/)[^/]+/, '$1<user>');
}

/**
 * 用形状代替原值描述一个名字：字符数 + 是否纯数字。
 * 适合账号名、用户名等"知道存在即可、不暴露内容"的场景。
 */
export function describeNameShape(name: unknown): string {
  const text = String(name ?? '');
  return `${text.length} 字符${/^\d+$/.test(text) ? '，纯数字' : ''}`;
}

/**
 * 用形状代替原值描述一个标识符：位数 + 是否含非数字。
 * 适合 device id / machine id 等稳定安装标识——绝不能打印原值。
 */
export function describeIdShape(value: unknown): string {
  const text = String(value ?? '');
  if (text === '') return '(空)';
  return `${text.length} 位${/^\d+$/.test(text) ? '，纯数字' : '，含非数字'}`;
}

/**
 * 自由文本日志脱敏：错误摘要等"可能混入上游返回内容 / 请求回声"的字段，
 * 落日志前过一遍——Bearer token、JWT、sk- 前缀 key、长 token 形字符串
 * 只留形状，路径替换用户段，压成单行并截断。
 *
 * 注意：这是"可分享日志"级别的兜底，不是机密擦除器——日志本来就不该
 * 主动打印凭据字段（红线 D4），本函数只防"错误文本里夹带"。
 */
export function redactLogText(text: unknown, maxLen = 300, knownSecrets: readonly string[] = []): string {
  let out = String(text ?? '');
  // 精确替换必须在字段规则与截断之前；短 PAT 也不能靠形状判断。
  for (const secret of [...knownSecrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('<redacted>');
  }
  // JSON / header / query / key=value 回声，不设最短长度。先消费完整 Authorization
  // 值（包括不同 scheme），避免 Basic / Cloud-IDE-JWT 等短值绕过 Bearer 规则。
  out = out.replace(/(["']?(?:authorization|proxy-authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic|Token|Cloud-IDE-JWT)\s+[^\s,;"'\]}]+|[^\s,;"'\]}]+)/gi, '$1<redacted>');
  out = out.replace(/(["']?(?:[\w-]*token|api[-_]?key|pat|password|secret|cookie|set-cookie|cloud[-_]ide[-_]jwt)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"'\]}]+)/gi, '$1<redacted>');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
  out = out.replace(/(?:Basic|Cloud-IDE-JWT)\s+[A-Za-z0-9._~+/=-]+/gi, '<redacted>');
  out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>');
  // 长 token 形字符串（≥40 位 token 字符集）只留形状
  out = out.replace(/[A-Za-z0-9._~+/=-]{40,}/g, (m) => `<redacted:${m.length}chars>`);
  out = maskUserPath(out);
  out = out.replace(/[\r\n\t]+/g, ' ').trim();
  if (out.length > maxLen) out = `${out.slice(0, maxLen)}…`;
  return out;
}