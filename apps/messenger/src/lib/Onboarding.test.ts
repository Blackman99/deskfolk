import { afterEach, expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import Onboarding from './Onboarding.svelte';
import { ApiError } from './api.ts';
import { copyFor } from './copy.ts';
import { fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { buttonByText, click, fieldErrors, fill, render } from './test-render.ts';
import { settle } from './test-async.ts';

const t = copyFor('zh');
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function open(stubs: Record<string, unknown> = {}) {
  const fixture = fakeRuntime({}, {
    workspacePath: '/fixture',
    endpointUrl: 'https://api.example.com/v1',
    endpointKey: 'fixture-key',
    endpointModelsText: 'gpt-4o',
    endpointDefaultModel: 'gpt-4o',
    probeModels: async () => ({ ok: true, models: [], catalog: [] }),
    ...stubs,
  });
  const runtime = reactive(fixture);
  const view = render(Onboarding, { runtime });
  cleanups.push(view.close);
  return { ...view, runtime, calls: fixture.calls };
}

function step(host: HTMLElement, title: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('.step-bar-item')]
    .find((button) => button.textContent?.includes(title));
}

test('workspace Next is disabled until a valid path is selected, and forward tabs cannot bypass it', () => {
  const { host, runtime, calls } = open({ workspacePath: '   ' });
  const next = buttonByText(host, `${t.onboarding.step1Next} →`);
  expect(next.disabled).toBe(true);
  click(next);
  expect(fieldErrors(host)).toEqual([]);
  expect(calls).toEqual([]);
  for (const title of [t.onboarding.step2Title, t.onboarding.step3Title]) {
    click(step(host, title));
    expect(host.querySelector('.step-pane-title')?.textContent).toBe(t.onboarding.stepWorkspace);
    expect(fieldErrors(host)).toContain(t.settings.workspaceEmpty);
    expect(calls).toEqual([]);
  }
  click(buttonByText(host, t.onboarding.useDefaultWorkspace));
  expect(next.disabled).toBe(false);
  runtime.workspacePath = 'relative/folder';
  flushSync();
  expect(next.disabled).toBe(true);
  runtime.workspacePath = '';
  flushSync();
  expect(next.disabled).toBe(true);
  runtime.workspacePath = '/fixture';
  flushSync();
  expect(next.disabled).toBe(false);
  click(next);
  expect(host.querySelector('#onboarding-endpoint')).not.toBeNull();
});

test('forward step navigation refuses an invalid workspace instead of bypassing Next validation', () => {
  const { host, calls } = open({ workspacePath: 'relative/folder' });
  click(step(host, t.onboarding.step2Title));
  expect(host.querySelector('.step-pane-title')?.textContent).toBe(t.onboarding.stepWorkspace);
  expect(fieldErrors(host)).toContain(t.settings.workspaceInvalid);
  click(step(host, t.onboarding.step3Title));
  expect(host.querySelector('.step-pane-title')?.textContent).toBe(t.onboarding.stepWorkspace);
  expect(calls).toEqual([]);

  click(buttonByText(host, t.onboarding.useDefaultWorkspace));
  expect(fieldErrors(host)).toEqual([]);
  click(buttonByText(host, `${t.onboarding.step1Next} →`));
  expect(host.querySelector('#onboarding-endpoint')).not.toBeNull();
});

for (const navigation of ['next', 'tab'] as const) {
  test(`provider ${navigation} refuses empty names and malformed URLs before model selection`, () => {
    const { host, calls } = open();
    click(buttonByText(host, `${t.onboarding.step1Next} →`));
    const advance = () => click(navigation === 'next'
      ? buttonByText(host, `${t.onboarding.step2Next} →`)
      : step(host, t.onboarding.step3Title));

    for (const name of ['', '   ']) {
      fill(host.querySelector('#onboarding-provider-name'), name);
      if (navigation === 'next') expect(buttonByText(host, `${t.onboarding.step2Next} →`).disabled).toBe(true);
      advance();
      expect(host.querySelector('#onboarding-provider-name')).not.toBeNull();
      if (navigation === 'tab') expect(fieldErrors(host)).toContain(t.settings.providerNameEmpty);
      expect(calls).toEqual([]);
    }
    fill(host.querySelector('#onboarding-provider-name'), 'Fixture');
    expect(buttonByText(host, `${t.onboarding.step2Next} →`).disabled).toBe(false);
    expect(fieldErrors(host)).not.toContain(t.settings.providerNameEmpty);
    for (const url of ['', 'https://', 'https://bad host/v1', 'ftp://example.com']) {
      fill(host.querySelector('#onboarding-endpoint'), url);
      if (navigation === 'next') expect(buttonByText(host, `${t.onboarding.step2Next} →`).disabled).toBe(true);
      advance();
      expect(host.querySelector('#onboarding-endpoint')).not.toBeNull();
      if (navigation === 'tab') expect(fieldErrors(host)).toContain(url ? t.settings.endpointInvalid : t.settings.endpointEmpty);
      expect(calls).toEqual([]);
    }
    fill(host.querySelector('#onboarding-endpoint'), 'https://api.example.com/v1');
    fill(host.querySelector('#onboarding-endpoint-key'), '   ');
    if (navigation === 'next') expect(buttonByText(host, `${t.onboarding.step2Next} →`).disabled).toBe(true);
    advance();
    if (navigation === 'tab') expect(fieldErrors(host)).toContain(t.settings.keyEmpty);
    fill(host.querySelector('#onboarding-endpoint-key'), 'fixture-key');
    expect(buttonByText(host, `${t.onboarding.step2Next} →`).disabled).toBe(false);
    advance();
    expect(host.querySelector('#onboarding-default-model')).not.toBeNull();
    expect(fieldErrors(host)).toEqual([]);
  });
}

test('choosing a preset clears the name error for the name it fills in', () => {
  const { host } = open({ endpointKey: '' });
  click(buttonByText(host, `${t.onboarding.step1Next} →`));
  fill(host.querySelector('#onboarding-provider-name'), '');
  click(step(host, t.onboarding.step3Title));
  expect(fieldErrors(host)).toContain(t.settings.providerNameEmpty);
  click(buttonByText(host, 'OpenAI'));
  expect(fieldErrors(host)).not.toContain(t.settings.providerNameEmpty);
  expect(fieldErrors(host)).toContain(t.settings.keyEmpty);
});

for (const probed of [false, true]) {
  test(`model step requires a selection and valid default before saving (probed: ${probed})`, async () => {
    const { host, runtime, calls } = open({
      probeModels: async () => ({ ok: true, models: probed ? ['gpt-4o', 'gpt-4o-mini'] : [] }),
    });
    click(step(host, t.onboarding.step3Title));
    await settle();
    const next = buttonByText(host, `${t.onboarding.step3Next} →`);
    expect(next.disabled).toBe(false);
    click(buttonByText(host, t.settings.modelsManualToggle));
    fill(host.querySelector('#endpoint-models'), ' \n ');
    expect(next.disabled).toBe(true);
    click(next);
    await settle();
    expect(host.querySelector('#onboarding-default-model')).not.toBeNull();
    expect(calls.filter((call) => call.name !== 'probeModels')).toEqual([]);

    fill(host.querySelector('#endpoint-models'), 'custom-model');
    expect(next.disabled).toBe(true);
    click(next);
    await settle();
    expect(calls.filter((call) => call.name !== 'probeModels')).toEqual([]);

    runtime.endpointDefaultModel = '';
    flushSync();
    expect(next.disabled).toBe(true);
    click(next);
    await settle();
    expect(calls.filter((call) => call.name !== 'probeModels')).toEqual([]);

    click(host.querySelector('#onboarding-default-model'));
    click([...host.querySelectorAll('[role="option"]')].find((option) => option.textContent?.trim() === 'custom-model'));
    expect(next.disabled).toBe(false);
    click(next);
    await settle();
    expect(host.querySelector('#onboarding-bot-name')).not.toBeNull();
    expect(calls.filter((call) => call.name === 'createProvider')).toHaveLength(1);
    expect(calls.find((call) => call.name === 'createProvider')?.args[0]).toMatchObject({
      default_model: 'custom-model', models: [{ name: 'custom-model' }],
    });
  });
}

test('clearing all models blocks completion and bulk selection repairs the default and feedback', async () => {
  const { host, runtime, calls } = open();
  click(step(host, t.onboarding.step3Title));
  await settle();
  click(buttonByText(host, t.settings.modelsDeselectAll));
  click(buttonByText(host, `${t.onboarding.step3Next} →`));
  await settle();
  expect(buttonByText(host, `${t.onboarding.step3Next} →`).disabled).toBe(true);
  expect(calls).toEqual([]);
  fill(host.querySelector('.models-filter-input'), 'deepseek');
  click(buttonByText(host, t.settings.modelsSelectAll));
  expect(fieldErrors(host)).toEqual([]);
  expect(runtime.endpointDefaultModel).toBe('deepseek-chat');
  fill(host.querySelector('.models-filter-input'), 'gpt-4o-mini');
  click(buttonByText(host, t.settings.modelsSelectAll));
  expect(runtime.endpointDefaultModel).toBe('gpt-4o-mini');
  click(buttonByText(host, `${t.onboarding.step3Next} →`));
  await settle();
  expect(host.querySelector('#onboarding-bot-name')).not.toBeNull();
});

test('going back and clearing a completed connection invalidates forward navigation', async () => {
  const { host, runtime, calls } = open();
  click(step(host, t.onboarding.step3Title));
  await settle();
  click(buttonByText(host, `← ${t.onboarding.prevStep}`));
  fill(host.querySelector('#onboarding-endpoint-key'), '   ');
  click(step(host, t.onboarding.step3Title));
  expect(fieldErrors(host)).toContain(t.settings.keyEmpty);
  expect(host.querySelector('#onboarding-endpoint-key')).not.toBeNull();
  click(step(host, t.onboarding.step1Title));
  runtime.workspacePath = 'relative';
  flushSync();
  click(step(host, t.onboarding.step3Title));
  expect(fieldErrors(host)).toContain(t.settings.workspaceInvalid);
  expect(calls).toEqual([]);
});

for (const mode of ['hosted', 'remote'] as const) {
  test(`${mode} skips the host workspace but still validates connection and models`, async () => {
    const { host, calls } = open({ [mode]: true, workspacePath: '', endpointUrl: 'https://' });
    expect(host.querySelector('.step-pane-title')?.textContent).toBe(t.onboarding.stepProvider);
    click(step(host, t.onboarding.step3Title));
    expect(fieldErrors(host)).toContain(t.settings.endpointInvalid);
    fill(host.querySelector('#onboarding-endpoint'), 'https://api.example.com/v1');
    click(buttonByText(host, `${t.onboarding.step2Next} →`));
    await settle();
    click(buttonByText(host, t.settings.modelsDeselectAll));
    click(buttonByText(host, `${t.onboarding.step3Next} →`));
    await settle();
    expect(buttonByText(host, `${t.onboarding.step3Next} →`).disabled).toBe(true);
    expect(calls.filter((call) => call.name !== 'probeModels')).toEqual([]);
    click(buttonByText(host, 'gpt-4o'));
    click(buttonByText(host, `${t.onboarding.step3Next} →`));
    await settle();
    expect(host.querySelector('#onboarding-bot-name')).not.toBeNull();
    expect(calls.some((call) => call.name === 'patchSettings')).toBe(false);
    expect(calls.filter((call) => call.name === 'createProvider')).toHaveLength(1);
  });
}

test('the first Bot cannot be created with blank required fields and recovers after correction', async () => {
  const { host, calls } = open();
  click(step(host, t.onboarding.step3Title));
  click(buttonByText(host, `${t.onboarding.step3Next} →`));
  await settle();
  const create = buttonByText(host, `${t.onboarding.createBot} ✓`);
  expect(create.disabled).toBe(false);
  for (const [id, value] of [
    ['onboarding-bot-name', 'Fixture Bot'],
    ['onboarding-bot-duties', 'Do the work'],
    ['onboarding-bot-boundaries', 'Ask before deleting'],
  ] as const) {
    fill(host.querySelector(`#${id}`), '   ');
    expect(create.disabled).toBe(true);
    click(create);
    await settle();
    expect(calls.some((call) => call.name === 'createBot')).toBe(false);
    fill(host.querySelector(`#${id}`), value);
    expect(create.disabled).toBe(false);
  }
  click(buttonByText(host, `${t.onboarding.createBot} ✓`));
  await settle();
  expect(calls.filter((call) => call.name === 'createBot')).toHaveLength(1);
});

test('workspace persistence errors return to the failed step without saving the provider', async () => {
  let failed = true;
  let providerSaves = 0;
  const { host } = open({
    patchSettings: async () => failed ? new ApiError(422, 'invalid_args', 'workspace_path must be a directory') : null,
    createProvider: async () => { providerSaves++; return null; },
  });
  click(step(host, t.onboarding.step3Title));
  click(buttonByText(host, `${t.onboarding.step3Next} →`));
  await settle();
  expect(host.querySelector('.step-pane-title')?.textContent).toBe(t.onboarding.stepWorkspace);
  expect(fieldErrors(host)).toContain(t.settings.workspaceInvalid);
  expect(providerSaves).toBe(0);
  failed = false;
  click(step(host, t.onboarding.step3Title));
  click(buttonByText(host, `${t.onboarding.step3Next} →`));
  await settle();
  expect(host.querySelector('#onboarding-bot-name')).not.toBeNull();
  expect(providerSaves).toBe(1);
});
