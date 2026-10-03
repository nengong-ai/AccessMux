import { expect, it } from 'vitest';
import { runWorkBuddyCheckin, fetchWorkBuddyCheckinStatus, claimWorkBuddyDaily } from '../../src/checkin/workbuddy.js';
import { runQoderCheckin } from '../../src/checkin/qoder.js';
import { runZcodeCheckin } from '../../src/checkin/zcode.js';
import { checkinResult, errorText, formatCheckinLine } from '../../src/checkin/types.js';

const response = (body: unknown) => new Response(JSON.stringify(body));
it.each(['short-token', 'long'.repeat(20), 'eyJhbGciOiJIUzI1NiJ9.synthetic.signature'])('WorkBuddy 业务错误不返回已知凭据 %s', async (token) => {
  const credential = { accessToken: token, userId: 'synthetic-user' };
  const deps = { fetchImpl: (async () => response({ code: 1, msg: `echo ${token}`, data: {} })) as typeof fetch };
  for (const result of [await fetchWorkBuddyCheckinStatus(credential, deps), await claimWorkBuddyDaily(credential, deps),
    await runWorkBuddyCheckin({ resolveCredential: async () => credential, ...deps })]) {
    expect(JSON.stringify(result)).not.toContain(token);
  }
});
it.each(['exchange', 'campaigns', 'claim'])('Qoder %s 任意短PAT/token回声不透出', async (stage) => {
  const pat = 'short-pat';
  const token = 'job-secret';
  const result = await runQoderCheckin({ resolvePat: () => pat, fetchImpl: (async (url) => {
    if (String(url).includes('exchange')) {
      if (stage === 'exchange') throw new Error(`echo ${pat}`);
      return response({ token });
    }
    if (String(url).endsWith('campaigns')) {
      if (stage === 'campaigns') throw new Error(`echo ${token} ${pat}`);
      return response({ campaigns: [{ campaignId: 'synthetic', claimStatus: 'CLAIMABLE' }] });
    }
    throw new Error(`Authorization: Bearer ${token}; personal_token=${pat}`);
  }) as typeof fetch });
  expect(result.verdict).toBe('error');
  expect(JSON.stringify(result)).not.toContain(pat);
  expect(JSON.stringify(result)).not.toContain(token);
});
it('ZCode 活动名和网络失败均精确屏蔽凭据', async () => {
  const jwt = 'short-zcode-jwt';
  for (const fetchImpl of [
    (async () => { throw new Error(`Cloud-IDE-JWT: ${jwt}`); }) as typeof fetch,
    (async () => response({ data: { plans: [{ name: `echo ${jwt}` }] } })) as typeof fetch,
  ]) {
    const result = await runZcodeCheckin({ loadCredential: () => ({ jwt, deviceMid: 'synthetic-mid' }), fetchImpl });
    expect(JSON.stringify(result)).not.toContain(jwt);
  }
});
it('共用签到出口兜底覆盖鉴权字段，正常消息保留', () => {
  const echo = 'Authorization: Bearer short-secret';
  expect(errorText(new Error(echo))).not.toContain('short-secret');
  expect(checkinResult('qoder', 'error', echo).message).not.toContain('short-secret');
  expect(formatCheckinLine({ source: 'qoder', verdict: 'error', message: echo })).not.toContain('short-secret');
  expect(checkinResult('qoder', 'claimed', '+100 credits').message).toBe('+100 credits');
});
