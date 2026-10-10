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

/** Open a model picker (`ModelPicker.svelte`) by its trigger's id and pick the row with this value. */
async function pick(host: HTMLElement, id: string, value: string) {
  click(host.querySelector(`#${id}`));
  await settle();
  click(host.querySelector(`.mp-row[data-value="${value}"]`));
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

    await pick(host, 'onboarding-default-model', 'custom-model');
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

/** ADR 0078: set up on the Claude Code on this computer, with no endpoint at all. */
function claudeClient(signedIn: boolean) {
  const status = {
    path: '/usr/local/bin/claude', source: 'path', version: '2.1.0', outdated: false,
    logged_in: signedIn, auth_method: signedIn ? 'claude.ai' : null, subscription_type: signedIn ? 'max' : null,
    email: signedIn ? 'me@example.com' : null, error: null,
  };
  return {
    claudeCode: async () => status,
    detectClaudeCode: async () => status,
    setClaudeCodePath: async () => status,
  };
}

test('on Claude Code, Next waits for a signed-in Claude Code instead of an endpoint', async () => {
  const { host } = open({ endpointUrl: '', endpointKey: '', client: claudeClient(false) });
  click(buttonByText(host, `${t.onboarding.step1Next} →`));
  click(host.querySelector('[data-connect-mode="claude"]'));
  await settle();
  expect(host.querySelector('#onboarding-endpoint')).toBeNull();
  expect(host.querySelector('[data-claude-not-ready]')?.textContent).toBe(t.onboarding.claudeNotReady);
  const next = buttonByText(host, `${t.onboarding.step2NextClaude} →`);
  expect(next.disabled).toBe(true);
  click(step(host, t.onboarding.step3Title));
  expect(host.querySelector('#onboarding-claude-model')).toBeNull();
  // Back to the endpoint: its fields and its own Next are there again.
  click(host.querySelector('[data-connect-mode="endpoint"]'));
  expect(host.querySelector('#onboarding-endpoint')).not.toBeNull();
});

test('on Claude Code, saving puts every built-in call on the Claude model, saves no endpoint, and the first Bot is a Claude Agent', async () => {
  const { host, calls } = open({ endpointUrl: '', endpointKey: '', client: claudeClient(true) });
  click(buttonByText(host, `${t.onboarding.step1Next} →`));
  click(host.querySelector('[data-connect-mode="claude"]'));
  await settle();
  expect(host.querySelector('[data-claude-not-ready]')).toBeNull();
  click(buttonByText(host, `${t.onboarding.step2NextClaude} →`));
  expect(host.querySelector('#onboarding-claude-model')?.textContent).toContain('sonnet');
  expect(host.textContent).toContain(t.onboarding.claudeLimits);
  click(buttonByText(host, `${t.onboarding.step3Next} →`));
  await settle();
  const saves = calls.filter((call) => call.name === 'patchSettings').map((call) => call.args[0]);
  const choice = { runner: 'claude_code', model: 'sonnet', config_dir: null };
  expect(saves).toEqual([
    { workspace_path: '/fixture' },
    { builtin_models: { reader: choice, organizer: choice, scribe: choice, judge: choice, composer: choice,
      judgement: choice, reflection: choice, retrospective: choice, compaction: choice } },
  ]);
  expect(calls.some((call) => call.name === 'createProvider' || call.name === 'patchProvider')).toBe(false);
  expect(host.textContent).toContain(t.onboarding.botClaudeHint);
  click(buttonByText(host, `${t.onboarding.createBot} ✓`));
  await settle();
  const created = calls.filter((call) => call.name === 'createBot').map((call) => call.args[0]);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ runner: 'claude_code', agent_config_dir: null });
});

test('on Claude Code, the model is picked from Claude\'s aliases and saved as chosen', async () => {
  const { host, calls } = open({ endpointUrl: '', endpointKey: '', client: claudeClient(true) });
  click(buttonByText(host, `${t.onboarding.step1Next} →`));
  click(host.querySelector('[data-connect-mode="claude"]'));
  await settle();
  click(buttonByText(host, `${t.onboarding.step2NextClaude} →`));
  click(host.querySelector('#onboarding-claude-model'));
  await settle();
  expect([...host.querySelectorAll('.mp-row')].map((row) => row.getAttribute('data-value'))).toEqual(['sonnet', 'opus', 'haiku', 'fable']);
  click(host.querySelector('.mp-row[data-value="opus"]'));
  expect(host.querySelector('#onboarding-claude-model')?.textContent).toContain('opus');
  click(buttonByText(host, `${t.onboarding.step3Next} →`));
  await settle();
  const saved = calls.filter((call) => call.name === 'patchSettings').map((call) => call.args[0]).at(-1) as { builtin_models: Record<string, unknown> };
  expect(saved.builtin_models.reader).toEqual({ runner: 'claude_code', model: 'opus', config_dir: null });
});

/** ADR 0079: setup on another local agent found and signed in on this computer. */
function agentsClient() {
  const codex = {
    runner: 'codex', custom_id: null, label: 'Codex', path: '/usr/local/bin/codex', source: 'path', version: '0.153.4', logged_in: true,
    auth: 'ChatGPT', login_command: 'codex login', models: [{ id: 'gpt-5.6', name: 'GPT-5.6', efforts: [] }, { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: [] }],
    default_model: 'gpt-5.6-luna', proxy: null, proxy_source: null, checked_at: new Date(0).toISOString(), error: null,
  };
  const grok = { ...codex, runner: 'grok', label: 'Grok', path: null, logged_in: null, models: [], default_model: null };
  return {
    ...claudeClient(false),
    agents: async () => ({ items: [codex, grok], custom_agents: [] }),
  };
}

test('on another local agent, saving puts every built-in call on its model and the first Bot runs on it', async () => {
  const { host, calls } = open({ endpointUrl: '', endpointKey: '', client: agentsClient() });
  click(buttonByText(host, `${t.onboarding.step1Next} →`));
  click(host.querySelector('[data-connect-mode="claude"]'));
  await settle();
  // Only agents that are found and signed in are offered; Claude Code stays the first.
  const picks = [...host.querySelectorAll<HTMLButtonElement>('[data-agent-pick]')].map((button) => button.dataset.agentPick);
  expect(picks).toEqual(['claude_code', 'codex']);
  // Each agent's chip leads with its logo.
  expect([...host.querySelectorAll('[data-agent-pick]')].map((chip) => chip.querySelector('[data-agent-logo]')?.getAttribute('data-agent-logo'))).toEqual(['claude_code', 'codex']);
  expect(buttonByText(host, `${t.onboarding.step2NextClaude} →`).disabled).toBe(true);
  click(host.querySelector('[data-agent-pick="codex"]'));
  expect(host.querySelector('[data-claude-not-ready]')).toBeNull();
  click(buttonByText(host, `${t.onboarding.step2NextAgent.replace('{agent}', 'Codex')} →`));
  // Starts on the agent's own default model.
  expect(host.querySelector('#onboarding-agent-model')?.textContent).toContain('GPT-5.6 Luna');
  expect(host.querySelector('#onboarding-claude-model')).toBeNull();
  expect(host.textContent).toContain(t.onboarding.agentModelsDesc.replace('{agent}', 'Codex'));
  click(buttonByText(host, `${t.onboarding.step3Next} →`));
  await settle();
  const saves = calls.filter((call) => call.name === 'patchSettings').map((call) => call.args[0]);
  const choice = { runner: 'codex', model: 'gpt-5.6-luna', config_dir: null };
  expect(saves.at(-1)).toEqual({ builtin_models: { reader: choice, organizer: choice, scribe: choice, judge: choice, composer: choice,
    judgement: choice, reflection: choice, retrospective: choice, compaction: choice } });
  expect(calls.some((call) => call.name === 'createProvider' || call.name === 'patchProvider')).toBe(false);
  expect(host.textContent).toContain(t.onboarding.botAgentHint.replace('{agent}', 'Codex'));
  click(buttonByText(host, `${t.onboarding.createBot} ✓`));
  await settle();
  const created = calls.filter((call) => call.name === 'createBot').map((call) => call.args[0]);
  expect(created[0]).toMatchObject({ runner: 'codex' });
  expect(created[0]).not.toHaveProperty('agent_config_dir');
});

test('on another local agent, a listed model can be picked instead of its default', async () => {
  const { host, calls } = open({ endpointUrl: '', endpointKey: '', client: agentsClient() });
  click(buttonByText(host, `${t.onboarding.step1Next} →`));
  click(host.querySelector('[data-connect-mode="claude"]'));
  await settle();
  click(host.querySelector('[data-agent-pick="codex"]'));
  click(buttonByText(host, `${t.onboarding.step2NextAgent.replace('{agent}', 'Codex')} →`));
  await pick(host, 'onboarding-agent-model', 'gpt-5.6');
  expect(host.querySelector('#onboarding-agent-model')?.textContent).toContain('GPT-5.6');
  click(buttonByText(host, `${t.onboarding.step3Next} →`));
  await settle();
  const saved = calls.filter((call) => call.name === 'patchSettings').map((call) => call.args[0]).at(-1) as { builtin_models: Record<string, unknown> };
  expect(saved.builtin_models.reader).toEqual({ runner: 'codex', model: 'gpt-5.6', config_dir: null });
});

test('on an agent that lists no models, saving waits for a model name typed as the agent spells it', async () => {
  const client = agentsClient();
  const listed = await client.agents();
  const bare = { ...listed.items[0]!, models: [], default_model: null };
  const { host, calls } = open({ endpointUrl: '', endpointKey: '', client: { ...client, agents: async () => ({ items: [bare], custom_agents: [] }) } });
  click(buttonByText(host, `${t.onboarding.step1Next} →`));
  click(host.querySelector('[data-connect-mode="claude"]'));
  await settle();
  click(host.querySelector('[data-agent-pick="codex"]'));
  click(buttonByText(host, `${t.onboarding.step2NextAgent.replace('{agent}', 'Codex')} →`));
  const field = host.querySelector<HTMLButtonElement>('#onboarding-agent-model');
  expect(field).not.toBeNull();
  const save = buttonByText(host, `${t.onboarding.step3Next} →`);
  expect(save.disabled).toBe(true);
  // The picker lists nothing: a name typed into its search is offered as a row, and taken as typed.
  click(field);
  await settle();
  expect(host.querySelector('.mp-empty')?.textContent).toContain(t.modelPicker.noModels);
  fill(host.querySelector('.mp-search input'), 'o5-mini');
  expect([...host.querySelectorAll('.mp-row')].map((row) => row.querySelector('.mp-row-label')?.textContent?.trim())).toEqual([t.modelPicker.useTyped('o5-mini')]);
  click(host.querySelector('.mp-row[data-value="o5-mini"]'));
  expect(save.disabled).toBe(false);
  click(save);
  await settle();
  const saved = calls.filter((call) => call.name === 'patchSettings').map((call) => call.args[0]).at(-1) as { builtin_models: Record<string, unknown> };
  expect(saved.builtin_models.reader).toEqual({ runner: 'codex', model: 'o5-mini', config_dir: null });
});
