import type { ModelActivity } from '../../types.js';

function minute(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]); const min = Number(match[2]);
  return hour < 24 && min < 60 ? hour * 60 + min : undefined;
}

function dailyRange(activity: ModelActivity): string | undefined {
  const ranges = activity.daily?.map(({ start, end }) => ({ start, end, from: minute(start), to: minute(end) })).filter((range) => range.from !== undefined && range.to !== undefined);
  if (!ranges?.length) return undefined;
  let text: string;
  const reachesMidnight = (range: typeof ranges[number]) => range.to === 23 * 60 + 59;
  const late = ranges.length === 2 ? ranges.find((range) => reachesMidnight(range) && range.from! > 0) : undefined;
  const early = ranges.length === 2 ? ranges.find((range) => range.from === 0 && range.to! > 0) : undefined;
  if (late && early) text = `${late.start}—次日${early.end}`;
  else text = ranges.map((range) => `${range.start}—${range.from! > range.to! ? '次日' : ''}${range.end}`).join('、');
  return `（${text}${activity.timezone === 'Asia/Shanghai' ? ' 北京时间' : activity.timezone ? ` ${activity.timezone}` : ''}）`;
}

function formatDateTime(value: string, timezone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try { return date.toLocaleString('zh-CN', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { return date.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
}

function dateRange(activity: ModelActivity): string | undefined {
  if (!activity.starts_at && !activity.ends_at) return undefined;
  const start = activity.starts_at ? formatDateTime(activity.starts_at, activity.timezone) : '';
  const end = activity.ends_at ? formatDateTime(activity.ends_at, activity.timezone) : '';
  return `活动日期 ${start}${start && end ? '—' : ''}${end}`;
}

function isWithinDaily(activity: ModelActivity, now: Date): boolean {
  if (!activity.daily?.length || !activity.timezone) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: activity.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const current = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value);
    return activity.daily.some((range) => {
      const from = minute(range.start); const rawEnd = minute(range.end);
      if (from === undefined || rawEnd === undefined || from === rawEnd) return false;
      const end = rawEnd === 23 * 60 + 59 ? 24 * 60 : rawEnd;
      return from < end ? current >= from && current < end : current >= from || current < end;
    });
  } catch { return false; }
}

/** Human-facing activity summary shared by model cards and /v1/models display names. */
export function formatModelActivity(activity: ModelActivity, options: { now?: Date; detailed?: boolean } = {}): string {
  const now = options.now ?? new Date();
  const dates = dateRange(activity);
  const daily = dailyRange(activity);
  const end = activity.ends_at ? Date.parse(activity.ends_at) : NaN;
  const expiry = Number.isFinite(end) && now.getTime() >= end ? `活动信息待更新${activity.ends_at ? `（原定截至 ${formatDateTime(activity.ends_at, activity.timezone)}）` : ''}` : '';
  if (activity.scheduleMeaning === 'label') {
    const detail = [dates, !dates ? activity.daily?.length ? '优惠时段待确认' : '优惠规则待确认' : '', expiry].filter(Boolean).join(' · ');
    return `${activity.label}${detail ? ` · ${detail}` : ''}`;
  }
  const start = activity.starts_at ? Date.parse(activity.starts_at) : NaN;
  let state = expiry || (Number.isFinite(start) && now.getTime() < start ? '活动尚未开始'
    : activity.daily?.length ? isWithinDaily(activity, now) ? '优惠时段内' : '当前非优惠时段' : '');
  if (!options.detailed && !expiry) state = '';
  if (expiry) state = expiry;
  return `${activity.label}${daily ?? (dates ? ` · ${dates}` : '')}${state ? ` · ${state}` : ''}`;
}
