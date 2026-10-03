export function switchTargetFromProgress(progress: number): boolean {
  return progress >= 0.5;
}

export interface SwitchGesture {
  start: boolean;
  startX: number;
  startY: number;
  travel: number;
  progress: number;
  horizontal: boolean;
  vertical: boolean;
}

export function beginSwitchGesture(start: boolean, x: number, y: number, travel: number): SwitchGesture {
  return { start, startX: x, startY: y, travel: Math.max(1, travel), progress: start ? 1 : 0, horizontal: false, vertical: false };
}

export function moveSwitchGesture(gesture: SwitchGesture, x: number, y: number): SwitchGesture {
  const dx = x - gesture.startX;
  const dy = y - gesture.startY;
  if (!gesture.horizontal && !gesture.vertical) {
    if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.2) return { ...gesture, vertical: true };
    if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2) gesture.horizontal = true;
  }
  if (!gesture.horizontal) return gesture;
  const progress = Math.max(0, Math.min(1, ((gesture.start ? gesture.travel : 0) + dx) / gesture.travel));
  return { ...gesture, progress };
}

export function finishSwitchGesture(gesture: SwitchGesture, canceled: boolean, endX: number): { value: boolean; commit: boolean; progress: number } {
  if (canceled || gesture.vertical) return { value: gesture.start, commit: false, progress: gesture.start ? 1 : 0 };
  if (!gesture.horizontal) return { value: gesture.start, commit: false, progress: gesture.start ? 1 : 0 };
  const progress = Math.max(0, Math.min(1, ((gesture.start ? gesture.travel : 0) + endX - gesture.startX) / gesture.travel));
  const value = switchTargetFromProgress(progress);
  return { value, commit: value !== gesture.start, progress: value ? 1 : 0 };
}

export function syncSwitch(input: HTMLInputElement, progress = Number(input.checked)): void {
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-checked', String(input.checked));
  const thumb = input.nextElementSibling?.querySelector<HTMLElement>('.switch-thumb');
  thumb?.style.setProperty('--switch-progress', String(progress));
  thumb?.style.setProperty('--switch-offset', `${progress * 17}px`);
}

export function bindSwitch(input: HTMLInputElement, onCommit: (value: boolean) => void): void {
  input.setAttribute('role', 'switch');
  const track = input.nextElementSibling;
  const thumb = track?.querySelector<HTMLElement>('.switch-thumb');
  const sync = (progress = Number(input.checked)) => syncSwitch(input, progress);
  sync();
  let gesture: SwitchGesture | undefined;
  let suppressPointerClick = false;
  input.addEventListener('click', (event) => {
    if (suppressPointerClick && event.detail > 0) {
      event.preventDefault();
      suppressPointerClick = false;
    }
  });
  input.addEventListener('change', () => { sync(); onCommit(input.checked); });
  input.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || input.disabled || !thumb || !track) return;
    suppressPointerClick = false;
    const travel = Math.max(1, track.getBoundingClientRect().width - thumb.getBoundingClientRect().width - 6);
    gesture = beginSwitchGesture(input.checked, event.clientX, event.clientY, travel);
    input.classList.add('switch-pressed');
    thumb.style.setProperty('--switch-stretch', '1.14');
  });
  input.addEventListener('pointermove', (event) => {
    if (!gesture || gesture.vertical) return;
    gesture = moveSwitchGesture(gesture, event.clientX, event.clientY);
    if (gesture.horizontal) {
      if (!input.hasPointerCapture(event.pointerId)) input.setPointerCapture(event.pointerId);
      input.classList.add('switch-dragging');
      input.checked = switchTargetFromProgress(gesture.progress);
      sync(gesture.progress);
    }
  });
  const finish = (event: PointerEvent, canceled: boolean) => {
    if (!gesture) return;
    const current = gesture;
    gesture = undefined;
    input.classList.remove('switch-pressed', 'switch-dragging');
    thumb?.style.removeProperty('--switch-stretch');
    thumb?.style.removeProperty('--switch-progress');
    thumb?.style.removeProperty('--switch-offset');
    if (current.horizontal && input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
    const result = finishSwitchGesture(current, canceled, event.clientX);
    if (current.horizontal || current.vertical || canceled) {
      suppressPointerClick = true;
      setTimeout(() => { suppressPointerClick = false; }, 0);
    }
    if (current.horizontal) {
      input.checked = result.value;
      sync(result.progress);
      if (!canceled) {
        suppressPointerClick = true;
        setTimeout(() => { suppressPointerClick = false; }, 0);
        if (result.commit) onCommit(result.value);
      }
      if (canceled) sync();
    } else if (current.vertical || canceled) {
      input.checked = current.start;
      sync();
    }
  };
  input.addEventListener('pointerup', (event) => finish(event, false));
  input.addEventListener('pointercancel', (event) => finish(event, true));
  input.addEventListener('lostpointercapture', (event) => finish(event, true));
}
