// get_detail_param 请求体构造（端口 spec §3.2.5 + §3.3 + 协议事实）。
//
// Trae 把"模型目录"分散在多个 SOLO-mode function 里（solo_work_lite /
// solo_work_remote / solo_agent），一个 model 只在某个 function 下能被调用。
// 我们 union 多 function 的结果；每个 model 绑定的 wireFunction 由第一次
// 见到该 config_name 的 function 决定。

export interface TraeGetDetailParamRequest {
  function: string;
  config_names: null;
  need_prompt: false;
  current_config_info: null;
  poly_prompt: true;
  mode_type: null;
  agent_type: null;
}

export function buildGetDetailParamBody(directoryFunction: string): TraeGetDetailParamRequest {
  return {
    function: directoryFunction,
    config_names: null,
    need_prompt: false,
    current_config_info: null,
    poly_prompt: true,
    mode_type: null,
    agent_type: null,
  };
}

/** 默认 SOLO chat function——首选的目录入口（CN / AI 共用）。 */
export const TRAE_SOLO_FUNCTION = 'solo_work_lite';

/** 每个区域要 union 的 directory function 列表。顺序决定优先级（first wins）。 */
export const TRAE_DIRECTORY_FUNCTIONS: Readonly<Record<'cn' | 'ai', readonly string[]>> = {
  cn: ['solo_work_remote', TRAE_SOLO_FUNCTION],
  ai: ['solo_agent', 'solo_work_remote', TRAE_SOLO_FUNCTION],
};