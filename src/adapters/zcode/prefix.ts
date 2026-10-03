// Copyright 2026 Z.AI Co., Ltd. Licensed under Apache-2.0.
// Modified by AccessMux contributors: extracted/combined prompt builders and
// added SHA-256 verification; original prompt text is preserved verbatim.
// License: docs/third-party-licenses/ZCode-Apache-2.0.txt; attribution: NOTICE.
// 官方 harness 提示词前缀（T019，D23/R017 §1.3.2 合同）。
//
// 3012 前缀门的事实：直连模型请求的 body.system 首部必须以官方 harness 前缀
// （1253 字符）精确开头。前缀不是秘密——它是 ZCode 开源仓库里的常量拼接：
// `core/src/context/sections/cli-prefix.ts` 的 CLI_PREFIX_PROMPT（42 字符）
// + `identity.ts` 的 buildIdentityPrompt()（无 outputStyle 分支，1211 字符，
// 自带起始换行）。以下常量逐字节照抄 clone @ 872ad96，改任何一字节即过不了
// sha256 自检（EXPECTED_OFFICIAL_PREFIX_SHA256，R017 clean-room 实测值）。
// 铁律：不猜、不硬闯、不改写前缀——上游改动导致 sha256/门槛失配时降级
// app-server 形态，绝不本地修补前缀。

import { createHash } from 'node:crypto';

const CLI_PREFIX_PROMPT = 'You are ZCode, an interactive coding agent';

const SECURITY_NOTICE =
  'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.';

function buildHarnessBlock(): string {
  return [
    '# Harness',
    '- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.',
    '- Tools run behind a user-selected permission mode; a denied call means the user declined it \u2014 adjust, don\'t retry verbatim.',
    '- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.',
    '- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.',
    '- Reference code as `file_path:line_number` \u2014 it\'s clickable.',
  ].join('\n');
}

function buildIdentityPrompt(): string {
  const intro = 'You are an interactive ZCode agent that helps users with software engineering tasks.';
  const identityLines = ['', intro, '', SECURITY_NOTICE].join('\n');
  return [identityLines, '', buildHarnessBlock()].join('\n');
}

/** 官方前缀：1253 字符（1257 UTF-8 字节，含两处 em-dash）。 */
export const OFFICIAL_HARNESS_PREFIX = CLI_PREFIX_PROMPT + buildIdentityPrompt();

/** R017 clean-room 实测的官方前缀 sha256（UTF-8 字节）。 */
export const EXPECTED_OFFICIAL_PREFIX_SHA256 =
  '7e93b98617f4e5eaaf53391445761a5d8624c70064ff3af14cf2b47b0e34737d';

export function officialPrefixSha256(prefix: string = OFFICIAL_HARNESS_PREFIX): string {
  return createHash('sha256').update(prefix, 'utf-8').digest('hex');
}

export interface PrefixVerification {
  ok: boolean;
  chars: number;
  sha256: string;
  expected: string;
}

/** 前缀常量自检：与已知官方值逐字节比对（防本仓常量被改坏后硬闯门槛）。 */
export function verifyOfficialPrefix(prefix: string = OFFICIAL_HARNESS_PREFIX): PrefixVerification {
  const sha256 = officialPrefixSha256(prefix);
  return {
    ok: sha256 === EXPECTED_OFFICIAL_PREFIX_SHA256,
    chars: [...prefix].length,
    sha256,
    expected: EXPECTED_OFFICIAL_PREFIX_SHA256,
  };
}
