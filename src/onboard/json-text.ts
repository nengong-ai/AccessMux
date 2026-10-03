// 文本级 JSON 编辑原语：在原文件字节上做"纯插入"，绝不重排、绝不重写既有字节。
//
// 为什么不用 JSON.parse → 修改 → JSON.stringify：
// T008 实测 ZCode 的 provider_config.json 对文件形态敏感，任何键序重排
// （如 jq -S 或 stringify 重排序）都会让它静默 fallback 到账号登录 provider。
// 本模块所有写入路径都保证：编辑结果 = 原文 + 单点插入（isPureInsertion 自检），
// 既有字节逐字保留、顺序不变。这是"键序保护 + 合并零破坏"的机制保证。

import { chmodSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OnboardError } from './errors.js';

/** JSON pointer 段：对象键名或数组下标 */
export type Pointer = (string | number)[];

export interface Range {
  start: number;
  end: number;
}

/** 受控替换的改写窗口：before 是原文中被允许改写的区间，after 是改写后在结果中的区间 */
export interface ReplaceWindow {
  before: Range;
  after: Range;
}

function isWsChar(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function fmtPointer(pointer: Pointer): string {
  return '/' + pointer.map(String).join('/');
}

class JsonScanner {
  pos = 0;

  constructor(readonly text: string) {}

  get len(): number {
    return this.text.length;
  }

  /** 当前字符（不跳空白） */
  cur(): string {
    return this.text[this.pos] ?? '';
  }

  /** 跳过空白后看当前字符 */
  peek(): string {
    this.ws();
    return this.cur();
  }

  ws(): void {
    while (this.pos < this.len && isWsChar(this.text[this.pos] ?? '')) this.pos++;
  }

  expect(ch: string): void {
    if (this.cur() !== ch) {
      throw malformed(this.text, this.pos, `期望 '${ch}'，实际 '${this.cur() || '<EOF>'}'`);
    }
    this.pos++;
  }

  /** 读一个完整 JSON 字符串（含引号），返回原文区间 */
  readString(): Range {
    this.ws();
    if (this.cur() !== '"') {
      throw malformed(this.text, this.pos, `期望字符串，实际 '${this.cur() || '<EOF>'}'`);
    }
    const start = this.pos;
    this.pos++;
    while (this.pos < this.len) {
      const c = this.text[this.pos];
      if (c === '\\') {
        this.pos += 2;
        continue;
      }
      if (c === '"') {
        this.pos++;
        return { start, end: this.pos };
      }
      this.pos++;
    }
    throw malformed(this.text, start, '字符串未闭合');
  }

  /** 跳过一个完整 JSON 值（对象/数组/字符串/数字/字面量），返回原文区间 */
  skipValue(): Range {
    this.ws();
    const start = this.pos;
    const c = this.cur();
    if (c === '') throw malformed(this.text, this.pos, '值不完整');
    if (c === '{') return this.skipContainer('{', '}');
    if (c === '[') return this.skipContainer('[', ']');
    if (c === '"') return this.readString();
    // 数字 / true / false / null：扫到值终止字符
    while (this.pos < this.len) {
      const ch = this.text[this.pos];
      if (ch === undefined || ',[]{}:'.includes(ch) || isWsChar(ch)) break;
      this.pos++;
    }
    if (this.pos === start) throw malformed(this.text, start, '无法识别的值');
    return { start, end: this.pos };
  }

  /** 跳过 {…} / […] 容器（含嵌套与字符串内的括号），pos 落在闭合符之后 */
  private skipContainer(open: string, close: string): Range {
    const start = this.pos;
    this.pos++; // 跳过 open
    let depth = 1;
    while (this.pos < this.len && depth > 0) {
      const c = this.text[this.pos];
      if (c === '"') {
        this.readString();
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          this.pos++;
          return { start, end: this.pos };
        }
      }
      this.pos++;
    }
    throw malformed(this.text, start, `容器 '${open}…${close}' 未闭合`);
  }
}

function malformed(text: string, pos: number, why: string): OnboardError {
  const line = text.slice(0, pos).split('\n').length;
  const ctx = text.slice(Math.max(0, pos - 20), pos + 20).replace(/\n/g, '\\n');
  return new OnboardError(`JSON 格式问题（第 ${line} 行附近：${why}）：…${ctx}…`);
}

/** 定位 pointer 指向的值的原文区间 [start, end) */
export function locateValue(text: string, pointer: Pointer): Range {
  const s = new JsonScanner(text);
  let range = s.skipValue();
  for (const seg of pointer) {
    const inner = new JsonScanner(text);
    inner.pos = range.start;
    const open = inner.peek();
    if (typeof seg === 'string') {
      if (open !== '{') {
        throw new OnboardError(
          `路径 ${fmtPointer(pointer)} 期望经过对象，实际是 '${open}'（文件结构可能与预期不符）`,
        );
      }
      inner.pos = range.start + 1;
      let found: Range | null = null;
      for (;;) {
        inner.ws();
        if (inner.cur() === '}') break;
        const keyRange = inner.readString();
        const key = JSON.parse(text.slice(keyRange.start, keyRange.end)) as string;
        inner.ws();
        inner.expect(':');
        const val = inner.skipValue();
        if (key === seg) {
          found = val;
          break;
        }
        inner.ws();
        if (inner.cur() === ',') {
          inner.pos++;
          continue;
        }
        if (inner.cur() === '}') break;
        throw malformed(text, inner.pos, "期望 ',' 或 '}'");
      }
      if (!found) throw new OnboardError(`路径 ${fmtPointer(pointer)}：找不到键 '${seg}'`);
      range = found;
    } else {
      if (open !== '[') {
        throw new OnboardError(
          `路径 ${fmtPointer(pointer)} 期望经过数组，实际是 '${open}'（文件结构可能与预期不符）`,
        );
      }
      inner.pos = range.start + 1;
      let idx = 0;
      let found: Range | null = null;
      for (;;) {
        inner.ws();
        if (inner.cur() === ']') break;
        const val = inner.skipValue();
        if (idx === seg) {
          found = val;
          break;
        }
        idx++;
        inner.ws();
        if (inner.cur() === ',') {
          inner.pos++;
          continue;
        }
        if (inner.cur() === ']') break;
        throw malformed(text, inner.pos, "期望 ',' 或 ']'");
      }
      if (!found) {
        throw new OnboardError(`路径 ${fmtPointer(pointer)}：数组只有 ${idx} 个元素，取不到第 ${seg} 个`);
      }
      range = found;
    }
  }
  return range;
}

/** 按 pointer 从已解析对象中取值（轻量实现，仅供编辑后语义自检） */
export function getByPointer(root: unknown, pointer: Pointer): unknown {
  let cur: unknown = root;
  for (const seg of pointer) {
    if (typeof seg === 'string') {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    }
  }
  return cur;
}

/** 在已解析结构上按 pointer 赋值（仅供编辑后语义自检；路径存在性已由 locateValue 验证） */
function setByPointer(root: unknown, pointer: Pointer, value: unknown): void {
  let cur = root as Record<string | number, unknown>;
  for (let i = 0; i < pointer.length - 1; i++) {
    cur = cur[pointer[i] as string | number] as Record<string | number, unknown>;
  }
  cur[pointer[pointer.length - 1] as string | number] = value;
}

/**
 * 验证 edited 是 original 的"单点纯插入"（不删不改不重排任何既有字节）。
 * 返回插入内容与位置；不是纯插入（含删除、替换、重排）返回 null。
 * 这是键序保护的硬校验：jq -S 式重排、任何覆盖式写入都会在这里被拒。
 */
export function isPureInsertion(
  original: string,
  edited: string,
): { inserted: string; at: number } | null {
  const minLen = Math.min(original.length, edited.length);
  let p = 0;
  while (p < minLen && original[p] === edited[p]) p++;
  let o = original.length;
  let e = edited.length;
  while (o > p && e > p && original[o - 1] === edited[e - 1]) {
    o--;
    e--;
  }
  // original 必须被前后缀完全消耗，否则发生了删除/替换
  if (o !== p) return null;
  return { inserted: edited.slice(p, e), at: p };
}

/**
 * 受控替换判定器（"单点纯插入"的受控放宽版，T024）：
 * 允许白名单窗口内的内容任意改写（长度可变），但窗口外的每个字节必须逐一相同——
 * 删除、插入、重排一旦落到窗口外，一律判定失败。
 * jq -S 式整体重排在这里照样被拒（差异必然越出窗口）。
 */
export function isControlledReplacement(
  original: string,
  edited: string,
  windows: ReplaceWindow[],
): boolean {
  let o = 0;
  let e = 0;
  for (const w of windows) {
    const { before, after } = w;
    if (before.start > before.end || after.start > after.end) return false;
    if (before.end > original.length || after.end > edited.length) return false;
    if (before.start < o || after.start < e) return false; // 窗口必须有序、不重叠
    const gap = before.start - o;
    if (after.start !== e + gap) return false; // 窗口外不允许出现任何插入/删除
    if (original.slice(o, before.start) !== edited.slice(e, after.start)) return false;
    o = before.end;
    e = after.end;
  }
  return original.slice(o) === edited.slice(e);
}


export function detectIndentUnit(text: string): number {
  const lens = new Set<number>();
  for (const line of text.split('\n')) {
    const m = /^[ \t]*/.exec(line);
    if (m && m[0].length > 0) lens.add(m[0].length);
  }
  const sorted = [...lens].sort((a, b) => a - b);
  let unit = 0;
  for (let i = 1; i < sorted.length; i++) {
    const diff = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    if (diff > 0 && (unit === 0 || diff < unit)) unit = diff;
  }
  return unit || 2;
}

/** pos 所在行的行首空白 */
function lineIndentAt(text: string, pos: number): string {
  const bol = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  let i = bol;
  while (i < text.length && ((text[i] === ' ') || (text[i] === '\t'))) i++;
  return text.slice(bol, i);
}

function firstNonWsIndex(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (!isWsChar(s[i] ?? '')) return i;
  }
  return -1;
}

/**
 * 依据原数组形态（单行/多行、缩进层级）序列化新内容，风格延续：
 * 单行数组保持单行；多行数组沿用原首元素行的行首缩进与闭括号缩进。
 */
function serializeArrayInterior(text: string, range: Range, values: unknown[]): string {
  const interior = text.slice(range.start + 1, range.end - 1);
  if (!interior.includes('\n')) {
    return values.map((v) => JSON.stringify(v) ?? 'null').join(', ');
  }
  const closeIndent = lineIndentAt(text, range.end - 1);
  const first = firstNonWsIndex(interior);
  const elemIndent =
    first >= 0
      ? lineIndentAt(text, range.start + 1 + first)
      : closeIndent + ' '.repeat(detectIndentUnit(text));
  if (values.length === 0) return `\n${closeIndent}`;
  const indentUnit = detectIndentUnit(text);
  const body = values
    .map((v) => elemIndent + serializeValue(v, elemIndent, indentUnit))
    .join(',\n');
  return `\n${body}\n${closeIndent}`;
}

/** 序列化 value：JSON.stringify(indentUnit) 后，非首行统一补 firstLineIndent（嵌入原文件缩进层级） */
function serializeValue(value: unknown, firstLineIndent: string, indentUnit: number): string {
  const raw = JSON.stringify(value, null, indentUnit) ?? 'null';
  if (!firstLineIndent) return raw;
  return raw
    .split('\n')
    .map((l, i) => (i === 0 ? l : firstLineIndent + l))
    .join('\n');
}

/** splice：在 at 处插入文本 */
function splice(text: string, at: number, insert: string): string {
  return text.slice(0, at) + insert + text.slice(at);
}

/** 在 pointer 指向的数组末尾插入一个元素（文本级纯插入） */
export function appendToArray(text: string, pointer: Pointer, value: unknown): string {
  const range = locateValue(text, pointer);
  const open = text[range.start];
  if (open !== '[') {
    throw new OnboardError(`路径 ${fmtPointer(pointer)} 不是数组（实际 '${open}'），拒绝写入`);
  }
  const edited = insertTail(text, range, { kind: 'elem', value });
  return assertEdited(text, edited, pointer, { kind: 'array', value });
}

/** 在 pointer 指向的对象末尾插入一个键值对（文本级纯插入，新键追加在既有键之后） */
export function appendToObject(
  text: string,
  pointer: Pointer,
  key: string,
  value: unknown,
): string {
  const range = locateValue(text, pointer);
  const open = text[range.start];
  if (open !== '{') {
    throw new OnboardError(`路径 ${fmtPointer(pointer)} 不是对象（实际 '${open}'），拒绝写入`);
  }
  const edited = insertTail(text, range, { kind: 'entry', key, value });
  return assertEdited(text, edited, pointer, { kind: 'object', key, value });
}

/**
 * 受控替换：把 pointer 指向数组的内容整段替换为 values（元素数量/内容都可变），
 * 数组外的每个字节必须原样保留。自检（不过即抛错、绝不写盘）：
 * 1. 差异白名单：与原文的全部差异必须落在该数组内部（isControlledReplacement）；
 * 2. JSON 合法；
 * 3. 语义：替换后该数组内容恰为 values，文件其余部分逐项与原文一致。
 * 用于"已接入宿主的模型清单同步"（T024）：数组内容可变，键序等其余部分严禁触碰。
 */
export function replaceArrayContents(text: string, pointer: Pointer, values: unknown[]): string {
  const range = locateValue(text, pointer);
  const open = text[range.start];
  if (open !== '[') {
    throw new OnboardError(`路径 ${fmtPointer(pointer)} 不是数组（实际 '${open}'），拒绝写入`);
  }
  const interiorStart = range.start + 1;
  const interiorEnd = range.end - 1;
  const interior = serializeArrayInterior(text, range, values);
  const edited = text.slice(0, interiorStart) + interior + text.slice(interiorEnd);
  return assertControlledReplace(text, edited, pointer, values, {
    before: { start: interiorStart, end: interiorEnd },
    after: { start: interiorStart, end: interiorStart + interior.length },
  });
}

type TailPayload = { kind: 'elem'; value: unknown } | { kind: 'entry'; key: string; value: unknown };

/**
 * 通用尾插：
 * - 容器非空：在最后一个非空白字符后插入 `,\n<元素缩进><序列化>`（单行容器用 `, `）
 * - 容器为空：在开括号后插入 `\n<新缩进><序列化>\n<闭括号行缩进>`
 */
function insertTail(text: string, range: Range, payload: TailPayload): string {
  const inside = text.slice(range.start + 1, range.end - 1);
  let lastNonWs = -1;
  for (let i = inside.length - 1; i >= 0; i--) {
    if (!isWsChar(inside[i] ?? '')) {
      lastNonWs = i;
      break;
    }
  }
  const indentUnit = detectIndentUnit(text);
  if (lastNonWs >= 0) {
    const lastPos = range.start + 1 + lastNonWs; // 最后非空白字符在全文中的位置
    const onSameLine = !text.slice(range.start, lastPos).includes('\n');
    const indent = onSameLine ? '' : lineIndentAt(text, lastPos);
    const serialized = serializeValue(payload.value, indent, indentUnit);
    if (payload.kind === 'entry') {
      const keyText = JSON.stringify(payload.key);
      const insertion = onSameLine
        ? `, ${keyText}: ${serialized}`
        : `,\n${indent}${keyText}: ${serialized}`;
      return splice(text, lastPos + 1, insertion);
    }
    const insertion = onSameLine ? `, ${serialized}` : `,\n${indent}${serialized}`;
    return splice(text, lastPos + 1, insertion);
  }
  // 容器为空：闭括号缩进 = 其所在行行首空白；新条目缩进 = 闭括号缩进 + 一个缩进单位
  const closePos = range.end - 1;
  const closeIndent = lineIndentAt(text, closePos);
  const pad = ' '.repeat(indentUnit);
  const serialized = serializeValue(payload.value, closeIndent + pad, indentUnit);
  if (payload.kind === 'entry') {
    const keyText = JSON.stringify(payload.key);
    return splice(
      text,
      range.start + 1,
      `\n${closeIndent}${pad}${keyText}: ${serialized}\n${closeIndent}`,
    );
  }
  return splice(text, range.start + 1, `\n${closeIndent}${pad}${serialized}\n${closeIndent}`);
}

type AssertSpec =
  | { kind: 'array'; value: unknown }
  | { kind: 'object'; key: string; value: unknown };

/**
 * 编辑后三重自检（任何一条不过直接抛错，绝不写盘）：
 * 1. 纯插入：isPureInsertion 必须成立（既有字节零删改零重排）
 * 2. JSON 合法：结果可解析
 * 3. 语义正确：目标数组/对象恰好新增一个元素/键，既有内容不变
 */
function assertEdited(original: string, edited: string, pointer: Pointer, spec: AssertSpec): string {
  const ins = isPureInsertion(original, edited);
  if (!ins) {
    throw new OnboardError(
      `编辑自检失败：结果不是对原文的纯插入（路径 ${fmtPointer(pointer)}），拒绝写入。` +
        '这通常意味着文件结构与预期不符，未做任何修改。',
    );
  }
  let parsed: unknown;
  let before: unknown;
  try {
    parsed = JSON.parse(edited);
    before = JSON.parse(original);
  } catch (e) {
    throw new OnboardError(
      `编辑自检失败：JSON 解析出错（路径 ${fmtPointer(pointer)}）：${String(e)}`,
    );
  }
  const prev = getByPointer(before, pointer);
  const next = getByPointer(parsed, pointer);
  if (spec.kind === 'array') {
    if (!Array.isArray(prev) || !Array.isArray(next)) {
      throw new OnboardError(`编辑自检失败：路径 ${fmtPointer(pointer)} 不是数组`);
    }
    if (next.length !== prev.length + 1) {
      throw new OnboardError(
        `编辑自检失败：数组长度 ${prev.length} → ${next.length}（应恰好 +1）`,
      );
    }
    const tail = next[next.length - 1];
    if (JSON.stringify(tail) !== JSON.stringify(spec.value)) {
      throw new OnboardError('编辑自检失败：新元素与期望不一致');
    }
  } else {
    if (
      prev === null ||
      typeof prev !== 'object' ||
      Array.isArray(prev) ||
      next === null ||
      typeof next !== 'object' ||
      Array.isArray(next)
    ) {
      throw new OnboardError(`编辑自检失败：路径 ${fmtPointer(pointer)} 不是对象`);
    }
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    if (nextKeys.length !== prevKeys.length + 1 || nextKeys[nextKeys.length - 1] !== spec.key) {
      throw new OnboardError('编辑自检失败：新键未追加在对象末尾');
    }
    const val = (next as Record<string, unknown>)[spec.key];
    if (val === undefined || JSON.stringify(val) !== JSON.stringify(spec.value)) {
      throw new OnboardError('编辑自检失败：新键值与期望不一致');
    }
  }
  return edited;
}

/**
 * 受控替换后的三重自检（任何一条不过直接抛错，绝不写盘）：
 * 1. 差异白名单：所有字节差异只在窗口内；2. JSON 合法；
 * 3. 语义：目标数组内容 == values，其余部分与原文逐项一致。
 */
function assertControlledReplace(
  original: string,
  edited: string,
  pointer: Pointer,
  values: unknown[],
  window: ReplaceWindow,
): string {
  if (!isControlledReplacement(original, edited, [window])) {
    throw new OnboardError(
      `编辑自检失败：改动了目标数组之外的字节（路径 ${fmtPointer(pointer)}），拒绝写入。` +
        '受控替换只允许改数组内部，文件其余部分必须逐字节原样。',
    );
  }
  let parsed: unknown;
  let before: unknown;
  try {
    parsed = JSON.parse(edited);
    before = JSON.parse(original);
  } catch (e) {
    throw new OnboardError(
      `编辑自检失败：JSON 解析出错（路径 ${fmtPointer(pointer)}）：${String(e)}`,
    );
  }
  const next = getByPointer(parsed, pointer);
  if (!Array.isArray(next) || JSON.stringify(next) !== JSON.stringify(values)) {
    throw new OnboardError(
      `编辑自检失败：替换后数组内容与期望不一致（路径 ${fmtPointer(pointer)}）`,
    );
  }
  setByPointer(before, pointer, values);
  if (JSON.stringify(parsed) !== JSON.stringify(before)) {
    throw new OnboardError(
      `编辑自检失败：除目标数组外还有其它内容被改动（路径 ${fmtPointer(pointer)}）`,
    );
  }
  return edited;
}

/** 解析 JSON 文本，错误转成可读 OnboardError */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new OnboardError(`文件不是合法 JSON：${String(e)}`);
  }
}

/**
 * 原子写文件：同目录临时文件 → 保权限 → rename。
 * mode 传原文件的 mode（保持 600/644 等原有权限）。
 */
export function atomicWrite(absPath: string, content: string, mode: number): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-onboard-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, content, { flag: 'wx' });
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, absPath);
  } catch (e) {
    try {
      statSync(tmp);
      unlinkSync(tmp);
    } catch {
      /* tmp 已不存在 */
    }
    throw e;
  }
}
