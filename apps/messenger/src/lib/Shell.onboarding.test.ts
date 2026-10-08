import { afterEach, expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import { ApiError } from './api.ts';
import { emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { buttonByText, click, fill, render } from './test-render.ts';
import { copyFor } from './copy.ts';
import { settle } from './test-async.ts';
import { loadShell } from './test-shell-kit.ts';

const Shell = await loadShell();

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

/**
 * The first-run wizard ends on the first Bot. Saving the endpoint completes setup, which is what
 * takes the wizard down, so it holds itself up across that save for its last step.
 */
function firstRunRuntime(snapshot: Partial<ReturnType<typeof emptySnapshot>> = {}, stubs: Record<string, unknown> = {}) {
  const runtime = reactive(fakeRuntime({
    settings: { ...emptySnapshot().settings, locale: 'zh', wizard_complete: false, workspace_path: null },
    ...snapshot,
  }, {
    createProvider: async () => {
      runtime.snapshot.settings.wizard_complete = true;
      return null;
    },
    ...stubs,
  }));
  runtime.workspacePath = '/fixture';
  runtime.endpointUrl = 'https://api.example.com/v1';
  runtime.endpointKey = 'sk-fixture';
  runtime.endpointModelsText = 'gpt-4o';
  runtime.endpointDefaultModel = 'gpt-4o';
  return runtime;
}

function saveSetup(host: HTMLElement, label: string) {
  const zh = copyFor('zh');
  click([...host.querySelectorAll('.step-bar-item')].find((b) => b.textContent?.includes(zh.onboarding.step3Title)));
  click(buttonByText(host, label));
}

test('saving setup on an empty roster leads to the first Bot, and making it opens the app on its direct', async () => {
  const zh = copyFor('zh');
  const created: unknown[] = [];
  const runtime = firstRunRuntime({}, {
    createBot: async (body: unknown) => {
      created.push(body);
      runtime.snapshot.bots = [aBot({ id: 'first', name: zh.onboarding.botNameSuggested })];
      return null;
    },
  });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  saveSetup(host, `${zh.onboarding.step3Next} →`);
  await settle();
  // Setup is complete, and the wizard is still up on its last step.
  expect(runtime.snapshot.settings.wizard_complete).toBe(true);
  expect(host.querySelector('.onboarding-screen')).not.toBeNull();
  expect(host.querySelector('.shell')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('#onboarding-bot-name')?.value).toBe(zh.onboarding.botNameSuggested);
  // The steps behind it are done and no longer open; so is the skip-setup link.
  const steps = [...host.querySelectorAll<HTMLButtonElement>('.step-bar-item')];
  expect(steps).toHaveLength(4);
  expect(steps.slice(0, 3).every((b) => b.disabled && b.classList.contains('is-complete'))).toBe(true);
  expect(steps[3]!.classList.contains('is-active')).toBe(true);
  expect(host.textContent).not.toContain(zh.onboarding.skip);

  fill(host.querySelector('#onboarding-bot-name'), '阿福');
  click(buttonByText(host, `${zh.onboarding.createBot} ✓`));
  await settle();
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    name: '阿福',
    duties: zh.onboarding.botDutiesSuggested,
    boundaries: zh.onboarding.botBoundariesSuggested,
    model: null,
  });
  expect(host.querySelector('.onboarding-screen')).toBeNull();
  expect(host.querySelector('.shell')).not.toBeNull();
});

test('the first-Bot step can be skipped into the app', async () => {
  const zh = copyFor('zh');
  let created = 0;
  const runtime = firstRunRuntime({}, { createBot: async () => { created++; return null; } });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  saveSetup(host, `${zh.onboarding.step3Next} →`);
  await settle();
  click(buttonByText(host, zh.onboarding.skipBot));
  expect(host.querySelector('.onboarding-screen')).toBeNull();
  expect(host.querySelector('.shell')).not.toBeNull();
  expect(created).toBe(0);
});

test('a refused first Bot keeps the wizard up with the reason on the field', async () => {
  const zh = copyFor('zh');
  const runtime = firstRunRuntime({}, {
    createBot: async () => new ApiError(409, 'conflict', 'that name is already used'),
  });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  saveSetup(host, `${zh.onboarding.step3Next} →`);
  await settle();
  click(buttonByText(host, `${zh.onboarding.createBot} ✓`));
  await settle();
  expect(host.querySelector('.onboarding-screen')).not.toBeNull();
  expect(host.textContent).toContain(zh.sidebar.nameConflict);
});

test('with Bots already on the roster, saving setup goes straight into the app', async () => {
  const zh = copyFor('zh');
  const runtime = firstRunRuntime({ bots: [aBot()], sessions: [aDirect()] });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  expect(host.querySelectorAll('.step-bar-item')).toHaveLength(3);
  saveSetup(host, `${zh.onboarding.submit} ✓`);
  await settle();
  expect(host.querySelector('.onboarding-screen')).toBeNull();
  expect(host.querySelector('.shell')).not.toBeNull();
});

test('a failed setup save lets go of the wizard, so it leaves once setup is complete', async () => {
  const zh = copyFor('zh');
  const runtime = firstRunRuntime({}, {
    createProvider: async () => new ApiError(500, 'internal', 'boom'),
  });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  saveSetup(host, `${zh.onboarding.step3Next} →`);
  await settle();
  expect(host.textContent).toContain(zh.settings.saveFailed);
  expect(host.querySelector('#onboarding-bot-name')).toBeNull();
  // Setup finished elsewhere (another window, the phone): nothing holds this wizard up any more.
  runtime.snapshot.settings.wizard_complete = true;
  flushSync();
  expect(host.querySelector('.onboarding-screen')).toBeNull();
});
