import { describe, expect, it, vi } from 'vitest';
import { beginSwitchGesture, bindSwitch, finishSwitchGesture, moveSwitchGesture, switchTargetFromProgress } from '../src/ui/public/toggle.js';

function fakeInput(initial = false) {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  const thumb = { style: { setProperty: (key: string, value: string) => properties.set(key, value), removeProperty: (key: string) => properties.delete(key) }, getBoundingClientRect: () => ({ width: 19 }) };
  const track = { querySelector: () => thumb, getBoundingClientRect: () => ({ width: 42 }) };
  const input: any = {
    checked: initial, disabled: false, nextElementSibling: track, dataset: {}, attributes: {},
    setAttribute: (key: string, value: string) => { input.attributes[key] = value; },
    addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, [...(listeners.get(name) ?? []), handler]),
    dispatch: (name: string, event = {}) => (listeners.get(name) ?? []).forEach((handler) => handler({ detail: 0, button: 0, pointerId: 1, clientX: 0, clientY: 0, preventDefault: vi.fn(), ...event })),
    classList: { add: (...names: string[]) => names.forEach((name) => classes.add(name)), remove: (...names: string[]) => names.forEach((name) => classes.delete(name)) },
    hasPointerCapture: () => false, setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
  };
  return { input, properties };
}

describe('滑动开关手势状态机', () => {
  it('连续跟手并在轨道中点吸附', () => {
    let gesture = beginSwitchGesture(false, 20, 10, 34);
    gesture = moveSwitchGesture(gesture, 24, 10);
    expect(gesture.progress).toBeCloseTo(0);
    gesture = moveSwitchGesture(gesture, 30, 10);
    expect(gesture.progress).toBeCloseTo(10 / 34);
    gesture = moveSwitchGesture(gesture, 39, 10);
    expect(gesture.progress).toBeCloseTo(19 / 34);
    expect(switchTargetFromProgress(gesture.progress)).toBe(true);
    expect(finishSwitchGesture(gesture, false, 39)).toEqual({ value: true, commit: true, progress: 1 });
  });

  it('已启用开关从起点按实际 travel 判断阈值', () => {
    let gesture = beginSwitchGesture(true, 80, 5, 34);
    gesture = moveSwitchGesture(gesture, 70, 5);
    expect(finishSwitchGesture(gesture, false, 70)).toMatchObject({ value: true, commit: false });
    gesture = moveSwitchGesture(gesture, 60, 5);
    expect(finishSwitchGesture(gesture, false, 60)).toMatchObject({ value: false, commit: true });
  });

  it('越界回起点不误当 tap，垂直移动交还滚动，cancel 复原', () => {
    let gesture = beginSwitchGesture(false, 10, 5, 34);
    gesture = moveSwitchGesture(gesture, 80, 5);
    gesture = moveSwitchGesture(gesture, 11, 5);
    expect(finishSwitchGesture(gesture, false, 11)).toMatchObject({ value: false, commit: false });
    const vertical = moveSwitchGesture(beginSwitchGesture(false, 10, 5, 34), 13, 20);
    expect(vertical.vertical).toBe(true);
    expect(finishSwitchGesture(vertical, false, 13)).toMatchObject({ value: false, commit: false });
    let canceled = beginSwitchGesture(true, 10, 5, 34);
    canceled = moveSwitchGesture(canceled, 0, 5);
    expect(finishSwitchGesture(canceled, true, 0)).toMatchObject({ value: true, commit: false, progress: 1 });
  });

  it('真实绑定的点击只提交一次，确认取消后下一次点击仍可提交', () => {
    const { input, properties } = fakeInput(false);
    const commit = vi.fn();
    bindSwitch(input, commit);
    input.checked = true;
    input.dispatch('change');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(input.attributes['aria-checked']).toBe('true');
    input.checked = false;
    input.dispatch('change');
    expect(commit).toHaveBeenCalledTimes(2);
    expect(input.attributes['aria-checked']).toBe('false');
    expect(properties.get('--switch-offset')).toBe('0px');
  });

  it('真实绑定的拖动只提交一次，取消手势不提交且后续点击可用', () => {
    vi.useFakeTimers();
    const { input } = fakeInput(false);
    const commit = vi.fn();
    bindSwitch(input, commit);
    input.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    input.dispatch('pointermove', { clientX: 40, clientY: 0 });
    input.dispatch('pointerup', { clientX: 40, clientY: 0 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenLastCalledWith(true);
    input.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    input.dispatch('pointermove', { clientX: 40, clientY: 0 });
    input.dispatch('pointercancel', { clientX: 40, clientY: 0 });
    expect(input.checked).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    vi.runOnlyPendingTimers();
    input.checked = false;
    input.dispatch('change');
    expect(commit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('端点与中点吸附保持确定性', () => {
    expect(switchTargetFromProgress(0)).toBe(false);
    expect(switchTargetFromProgress(0.49)).toBe(false);
    expect(switchTargetFromProgress(0.5)).toBe(true);
    expect(switchTargetFromProgress(1)).toBe(true);
  });
});
