import { expect, test } from 'bun:test';
import { createRawSnippet, flushSync } from 'svelte';
import Workbench from './Workbench.svelte';
import { copyFor } from '../copy.ts';
import { click, press, render } from '../test-render.ts';
import { reactive } from '../test-reactive.svelte.ts';
import { closeLeaf, makeBranch, makeLeaf, tiledLeaves } from './layout-tree.ts';
import type { WorkbenchLayout, WorkbenchTab } from './layout-types.ts';

const t = copyFor('zh');
const tab = (id: string): WorkbenchTab => ({ id, kind: 'chat', params: {} });
const tabBody = createRawSnippet((value: () => WorkbenchTab) => ({ render: () => `<div>${value().id}</div>` }));
const tabLabel = createRawSnippet((value: () => WorkbenchTab) => ({ render: () => `<span>${value().id}</span>` }));

function mount(layout: WorkbenchLayout, onClosePane?: (leafId: string) => void) {
  const state = reactive({ layout });
  const mounted = render(Workbench as never, {
    get layout() { return state.layout; },
    mins: () => ({ width: 100, height: 100 }), t, wide: true, tabBody, tabLabel,
    onLayout: (next: WorkbenchLayout) => { state.layout = next; },
    onClosePane,
  } as never);
  return { ...mounted, state };
}

function splitLayout(): WorkbenchLayout {
  return {
    version: 1,
    root: makeBranch('root', 'row', [makeLeaf('kept', [tab('chat')]), makeLeaf('empty')]),
    floating: [], focus: { zone: 'tiled', leafId: 'kept' },
  };
}

function rightClick(element: Element | null): HTMLElement {
  if (!element) throw new Error('missing pane');
  element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 50 }));
  flushSync();
  const menu = document.querySelector<HTMLElement>('[data-testid="wb-context-menu"]');
  if (!menu) throw new Error('missing context menu');
  return menu;
}

test('the empty pane has a keyboard-accessible close button that removes its split', () => {
  const { host, state, close } = mount(splitLayout());
  try {
    const button = host.querySelector<HTMLButtonElement>('[data-leaf="empty"] .wb-pane-close');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-label')).toBe(t.pane.close);
    expect(button!.tabIndex).toBe(0);
    expect(host.querySelector('[data-leaf="kept"] .wb-pane-close')).toBeNull();
    click(button);
    expect(tiledLeaves(state.layout.root).map((leaf) => leaf.id)).toEqual(['kept']);
    expect(state.layout.focus.leafId).toBe('kept');
    expect(host.querySelector('[data-sash]')).toBeNull();
  } finally { close(); }
});

for (const surface of ['.wb-strip', '.wb-body']) {
  test(`right-click close targets its pane from ${surface} and removes all its tabs`, () => {
    const layout = splitLayout();
    layout.root = makeBranch('root', 'row', [makeLeaf('kept', [tab('chat')]), makeLeaf('other', [tab('one'), tab('two')])]);
    const { host, state, close } = mount(layout);
    try {
      const menu = rightClick(host.querySelector(`[data-leaf="other"] ${surface}`));
      const button = menu.querySelector<HTMLButtonElement>('[data-close-pane]');
      expect(button?.textContent).toContain(t.pane.close);
      expect(button?.disabled).toBe(false);
      press(menu, 'End');
      expect(document.activeElement).toBe(button);
      click(button);
      expect(tiledLeaves(state.layout.root).map((leaf) => leaf.id)).toEqual(['kept']);
      expect(document.querySelector('[data-testid="wb-context-menu"]')).toBeNull();
    } finally { close(); }
  });
}

for (const via of ['button', 'menu']) {
  test(`an empty floating pane closes through its ${via}`, () => {
    const layout = splitLayout();
    layout.root = makeLeaf('kept', [tab('chat')]);
    layout.floating = [{ leaf: makeLeaf('float'), frame: { x: 20, y: 20, width: 320, height: 240 } }];
    const { host, state, close } = mount(layout);
    try {
      click(via === 'button'
        ? host.querySelector('[data-leaf="float"] .wb-pane-close')
        : rightClick(host.querySelector('[data-float="float"] .wb-float-bar')).querySelector('[data-close-pane]'));
      expect(state.layout.floating).toHaveLength(0);
      expect(state.layout.root.id).toBe('kept');
      expect(state.layout.focus.leafId).toBe('kept');
    } finally { close(); }
  });
}

test('closing the last populated pane leaves a usable empty pane', () => {
  const layout = splitLayout();
  layout.root = makeLeaf('kept', [tab('chat')]);
  const { host, state, close } = mount(layout);
  try {
    click(rightClick(host.querySelector('.wb-body')).querySelector('[data-close-pane]'));
    expect(tiledLeaves(state.layout.root)).toHaveLength(1);
    expect(tiledLeaves(state.layout.root)[0]!.tabs).toEqual([]);
    expect(host.querySelector('.wb-empty')).not.toBeNull();
    click(host.querySelector('.wb-pane-close'));
    expect(tiledLeaves(state.layout.root)).toHaveLength(1);
  } finally { close(); }
});

for (const via of ['button', 'menu']) {
  test(`closing through the ${via} waits for the host's unsaved-edit guard`, () => {
    const requested: string[] = [];
    const { host, state, close } = mount(splitLayout(), (id) => requested.push(id));
    try {
      click(via === 'button'
        ? host.querySelector('[data-leaf="empty"] .wb-pane-close')
        : rightClick(host.querySelector('[data-leaf="empty"] .wb-body')).querySelector('[data-close-pane]'));
      expect(requested).toEqual(['empty']);
      expect(tiledLeaves(state.layout.root)).toHaveLength(2);
      flushSync(() => { state.layout = closeLeaf(state.layout, requested[0]!, 'fallback'); });
      expect(tiledLeaves(state.layout.root).map((leaf) => leaf.id)).toEqual(['kept']);
    } finally { close(); }
  });
}
