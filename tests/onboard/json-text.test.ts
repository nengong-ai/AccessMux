// T011 · 文本级 JSON 编辑原语测试。
// 核心验收点：键序保护（任何编辑结果必须是"单点纯插入"，jq -S 式重排必须被拒）
// 与合并零破坏（既有字节逐字保留）。
import { describe, expect, it } from 'vitest';
import {
  appendToArray,
  appendToObject,
  detectIndentUnit,
  getByPointer,
  isControlledReplacement,
  isPureInsertion,
  locateValue,
  replaceArrayContents,
} from '../../src/onboard/json-text.js';

/** 仿真 ZCode provider_config.json（键序刻意保持"非字母序"的真实形态） */
const ZCODE_LIKE = `{
  "schemaVersion": 3,
  "config": {
    "providerOrder": [
      "first-uuid",
      "second-uuid"
    ],
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "first-uuid",
          "providerName": "商汤",
          "config": { "group": "standard-personal" }
        },
        {
          "providerId": "second-uuid",
          "providerName": "小红书",
          "config": { "group": "standard-personal" }
        }
      ]
    },
    "modelConfigRules": { "keep": true },
    "defaultModelSelection": { "untouched": true }
  }
}`;

describe('isPureInsertion（键序保护的判定器）', () => {
  it('单点插入返回插入内容与位置', () => {
    const r = isPureInsertion('[\n  "a"\n]', '[\n  "a",\n  "b"\n]');
    expect(r).not.toBeNull();
    expect(r?.inserted).toBe(',\n  "b"');
  });

  it('检测删除（不是纯插入）', () => {
    expect(isPureInsertion('["a","b"]', '["a"]')).toBeNull();
  });

  it('检测替换', () => {
    expect(isPureInsertion('["a"]', '["b"]')).toBeNull();
  });

  it('检测键序重排（jq -S 事故复现）——重排结果必须被拒', () => {
    // jq -S 会把 {"b":1,"a":2} 排成 {"a":2,"b":1}：字节内容相同但顺序变了
    const original = '{"b": 1, "a": 2}';
    const reordered = '{"a": 2, "b": 1}';
    expect(isPureInsertion(original, reordered)).toBeNull();
  });

  it('检测 stringify 全量重写（缩进/格式变化也算破坏）', () => {
    const original = '{"a":[1,2]}';
    const rewritten = JSON.stringify(JSON.parse(original), null, 2);
    expect(isPureInsertion(original, rewritten)).toBeNull();
  });
});

describe('appendToArray', () => {
  it('多行数组尾插：既有字节零改动、缩进风格延续', () => {
    const edited = appendToArray(ZCODE_LIKE, ['config', 'providerOrder'], 'new-uuid');
    // 纯插入
    const ins = isPureInsertion(ZCODE_LIKE, edited);
    expect(ins).not.toBeNull();
    expect(ins?.inserted).toBe(',\n      "new-uuid"');
    // 语义：长度 +1，既有元素不变，新元素在尾部
    const after = getByPointer(JSON.parse(edited), ['config', 'providerOrder']);
    expect(after).toEqual(['first-uuid', 'second-uuid', 'new-uuid']);
    // 原文的每一行都原样保留（零破坏）
    for (const line of ZCODE_LIKE.split('\n')) {
      expect(edited).toContain(line === '' ? '' : line);
    }
  });

  it('深层嵌套对象数组尾插（providerRules 场景）', () => {
    const entry = {
      providerId: 'new-uuid',
      providerName: 'AccessMux',
      config: { group: 'standard-personal', personalModelIds: ['a:b'] },
    };
    const step1 = appendToArray(ZCODE_LIKE, ['config', 'providerOrder'], 'new-uuid');
    const edited = appendToArray(step1, ['config', 'providerConfigRules', 'providerRules'], entry);
    expect(isPureInsertion(step1, edited)).not.toBeNull();
    const rules = getByPointer(JSON.parse(edited), [
      'config',
      'providerConfigRules',
      'providerRules',
    ]) as unknown[];
    expect(rules).toHaveLength(3);
    expect(rules[2]).toEqual(entry);
    expect(rules[0]).toEqual({ providerId: 'first-uuid', providerName: '商汤', config: { group: 'standard-personal' } });
    // 两处插入后顶层键序保持原序
    expect(Object.keys(JSON.parse(edited))).toEqual(['schemaVersion', 'config']);
    expect(Object.keys((JSON.parse(edited) as { config: object }).config)).toEqual([
      'providerOrder',
      'providerConfigRules',
      'modelConfigRules',
      'defaultModelSelection',
    ]);
  });

  it('单行数组尾插', () => {
    const edited = appendToArray('{"list": ["a", "b"]}', ['list'], 'c');
    expect(edited).toBe('{"list": ["a", "b", "c"]}');
  });

  it('空数组（多行形态）尾插', () => {
    const edited = appendToArray('{\n  "list": [\n  ]\n}', ['list'], 'x');
    expect(JSON.parse(edited)).toEqual({ list: ['x'] });
    expect(isPureInsertion('{\n  "list": [\n  ]\n}', edited)).not.toBeNull();
  });

  it('紧凑空数组尾插后仍合法', () => {
    const edited = appendToArray('{"list": []}', ['list'], 'x');
    expect(JSON.parse(edited)).toEqual({ list: ['x'] });
  });

  it('指针指向的不是数组时拒绝', () => {
    expect(() => appendToArray(ZCODE_LIKE, ['config'], 'x')).toThrow(/不是数组/);
  });

  it('指针不存在时报可读错误', () => {
    expect(() => appendToArray(ZCODE_LIKE, ['nope', 'deeper'], 'x')).toThrow(/找不到键 'nope'/);
  });

  it('元素是二元数组也不会被误判（数组语义优先）', () => {
    const edited = appendToArray('{"list": []}', ['list'], ['key', 'value']);
    expect(JSON.parse(edited)).toEqual({ list: [['key', 'value']] });
  });
});

describe('appendToObject', () => {
  it('多行对象尾插新键（DSH dependencies 场景）', () => {
    const pkg = `{
  "name": "dsh-profile-desktop",
  "dependencies": {
    "dshmarket": "^1.66.5"
  }
}`;
    const edited = appendToObject(pkg, ['dependencies'], 'dsh-accessmux-connect', 'link:/x/y');
    const ins = isPureInsertion(pkg, edited);
    expect(ins).not.toBeNull();
    expect(JSON.parse(edited)).toEqual({
      name: 'dsh-profile-desktop',
      dependencies: { dshmarket: '^1.66.5', 'dsh-accessmux-connect': 'link:/x/y' },
    });
    // 新键追加在既有键之后（不是重排）
    expect(Object.keys((JSON.parse(edited) as { dependencies: object }).dependencies)).toEqual([
      'dshmarket',
      'dsh-accessmux-connect',
    ]);
  });

  it('键名含特殊字符时正确转义', () => {
    const edited = appendToObject('{"a": {}}', ['a'], 'we"ird', 1);
    expect(JSON.parse(edited)).toEqual({ a: { 'we"ird': 1 } });
  });

  it('空对象尾插', () => {
    const edited = appendToObject('{"deps": {}}', ['deps'], 'k', { x: 1 });
    expect(JSON.parse(edited)).toEqual({ deps: { k: { x: 1 } } });
  });

  it('目标不是对象时拒绝', () => {
    expect(() => appendToObject(ZCODE_LIKE, ['schemaVersion'], 'k', 1)).toThrow(/不是对象/);
  });
});

describe('isControlledReplacement（受控替换判定器，T024）', () => {
  it('合法替换过：差异只落在窗口内（内容长度可变）', () => {
    const original = '{"a": [1, 2], "b": 3}';
    const edited = '{"a": [1, 2, 3], "b": 3}';
    const ok = isControlledReplacement(original, edited, [
      { before: { start: 7, end: 11 }, after: { start: 7, end: 14 } },
    ]);
    expect(ok).toBe(true);
  });

  it('越界替换拒：窗口外哪怕一个字节变了也拒绝', () => {
    const original = '{"a": [1, 2], "b": 3}';
    const tampered = '{"a": [1, 2], "b": 4}'; // 窗口外的 b 被改
    expect(
      isControlledReplacement(original, tampered, [
        { before: { start: 7, end: 11 }, after: { start: 7, end: 11 } },
      ]),
    ).toBe(false);
  });

  it('窗口外的插入/删除也被拒（对齐必须精确）', () => {
    const original = '{"a": [1, 2], "b": 3}';
    const inserted = '{"x": 0, "a": [1, 2], "b": 3}';
    expect(
      isControlledReplacement(original, inserted, [
        { before: { start: 7, end: 11 }, after: { start: 7, end: 11 } },
      ]),
    ).toBe(false);
    const deleted = '{"a": [1, 2]"b": 3}';
    expect(
      isControlledReplacement(original, deleted, [
        { before: { start: 7, end: 11 }, after: { start: 7, end: 11 } },
      ]),
    ).toBe(false);
  });

  it('jq -S 式整体重排被拒（护栏不许松）', () => {
    const original = '{"b": 1, "a": [1, 2]}';
    const reordered = '{"a": [1, 2], "b": 1}';
    // 即便把"a 数组内部"声明成窗口，重排导致的窗口位移也对不上
    expect(
      isControlledReplacement(original, reordered, [
        { before: { start: 15, end: 19 }, after: { start: 7, end: 11 } },
      ]),
    ).toBe(false);
  });

  it('多个窗口按序一一对应时通过', () => {
    const original = '{"a": [1], "b": [2]}';
    const edited = '{"a": [9, 9], "b": [8]}';
    expect(
      isControlledReplacement(original, edited, [
        { before: { start: 7, end: 8 }, after: { start: 7, end: 11 } },
        { before: { start: 17, end: 18 }, after: { start: 20, end: 21 } },
      ]),
    ).toBe(true);
  });
});

describe('replaceArrayContents（数组内容受控替换，T024）', () => {
  const NESTED = `{
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerName": "既有",
          "config": {
            "personalModelIds": [
              "keep-1"
            ]
          }
        },
        {
          "providerName": "AccessMux",
          "config": {
            "personalModelIds": [
              "old-1",
              "old-2"
            ],
            "modelOrder": [
              "old-1",
              "old-2"
            ]
          }
        }
      ]
    },
    "defaultModelSelection": { "untouched": true }
  }
}`;
  const PTR = ['config', 'providerConfigRules', 'providerRules', 1, 'config', 'personalModelIds'];

  it('多行数组：内容整段替换、风格延续、数组外字节逐字保留', () => {
    const edited = replaceArrayContents(NESTED, PTR, ['a:1', 'b:2', 'c:3']);
    expect(getByPointer(JSON.parse(edited), PTR)).toEqual(['a:1', 'b:2', 'c:3']);
    // 语义：把原文里的目标数组换成新值后，整体应逐项一致
    const expected = JSON.parse(NESTED) as {
      config: { providerConfigRules: { providerRules: { config: { personalModelIds: string[] } }[] } };
    };
    expected.config.providerConfigRules.providerRules[1]!.config.personalModelIds = ['a:1', 'b:2', 'c:3'];
    expect(JSON.parse(edited)).toEqual(expected);
    // 字节层：替换区间之外的原文前缀/后缀逐字保留
    const r = locateValue(NESTED, PTR);
    const oldInteriorLen = r.end - r.start - 2;
    const newInteriorLen = edited.length - NESTED.length + oldInteriorLen;
    expect(edited.slice(0, r.start + 1)).toBe(NESTED.slice(0, r.start + 1));
    expect(edited.slice(r.start + 1 + newInteriorLen)).toBe(NESTED.slice(r.end - 1));
    // 缩进风格延续：沿用原首元素行缩进（12 空格）
    expect(edited).toContain('\n              "a:1",\n              "b:2",\n              "c:3"\n            ]');
    // 其它数组/键一字未动
    expect(edited).toContain('"keep-1"');
    expect(edited).toContain('"untouched": true');
  });

  it('幂等：用与原文相同的内容替换，结果与原文字节一致', () => {
    expect(replaceArrayContents(NESTED, PTR, ['old-1', 'old-2'])).toBe(NESTED);
  });

  it('单行数组替换', () => {
    const edited = replaceArrayContents('{"list": ["a", "b"], "keep": 1}', ['list'], ['x']);
    expect(edited).toBe('{"list": ["x"], "keep": 1}');
  });

  it('目标不是数组时拒绝', () => {
    expect(() => replaceArrayContents(NESTED, ['config'], ['x'])).toThrow(/不是数组/);
  });

  it('指针不存在时报可读错误', () => {
    expect(() => replaceArrayContents(NESTED, ['nope'], ['x'])).toThrow(/找不到键 'nope'/);
  });
});

describe('locateValue / detectIndentUnit', () => {
  it('数组下标定位', () => {
    const text = '{"a": [10, 20, 30]}';
    const r = locateValue(text, ['a', 1]);
    expect(text.slice(r.start, r.end)).toBe('20');
  });

  it('越界下标报错', () => {
    expect(() => locateValue('{"a": [10]}', ['a', 5])).toThrow(/取不到第 5 个/);
  });

  it('字符串内的括号与冒号不干扰结构扫描', () => {
    const text = '{"weird:key": "va[l]ue { }", "target": [1]}';
    const r = locateValue(text, ['target']);
    expect(text.slice(r.start, r.end)).toBe('[1]');
  });

  it('缩进单位推断：2 与 4', () => {
    expect(detectIndentUnit('{\n  "a": {\n    "b": 1\n  }\n}')).toBe(2);
    expect(detectIndentUnit('{\n    "a": {\n        "b": 1\n    }\n}')).toBe(4);
    expect(detectIndentUnit('[]')).toBe(2);
  });

  it('畸形 JSON 报可读错误', () => {
    expect(() => locateValue('{"a": [1,}', ['a'])).toThrow(/JSON 格式问题/);
  });
});
