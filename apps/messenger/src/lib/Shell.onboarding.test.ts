import { afterEach, expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import { ApiError } from './api.ts';
import { emptySnapshot } from './snapshot.ts';
import { aBot, aDirect, aProjectSession, fakeRuntime } from './test-fixtures.ts';
import { reactive } from './test-reactive.svelte.ts';
import { buttonByText, click, fill, render } from './test-render.ts';
import { copyFor } from './copy.ts';
import { settle } from './test-async.ts';
import { loadShell } from './test-shell-kit.ts';

const Shell = await loadShell();

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

/**
 * The first-run wizard ends on the first Bots, from templates. Saving the endpoint completes setup,
 * which is what takes the wizard down, so it holds itself up across that save for its last step.
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

test('saving setup on an empty roster leads to the first Bots, and making them opens the app', async () => {
  const zh = copyFor('zh');
  const made: Array<{ members: Array<{ body: unknown }>; playbookId: string }> = [];
  const runtime = firstRunRuntime({}, {
    createTeam: async (input: { members: Array<{ body: unknown }>; playbookId: string }) => {
      made.push(input);
      runtime.snapshot.bots = [aBot({ id: 'first', name: zh.templates.templates.assistant!.name })];
      return { failed: null, error: null, groupFailed: false };
    },
  });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  saveSetup(host, `${zh.onboarding.step3Next} →`);
  await settle();
  // Setup is complete, and the wizard is still up on its last step.
  expect(runtime.snapshot.settings.wizard_complete).toBe(true);
  expect(host.querySelector('.onboarding-screen')).not.toBeNull();
  expect(host.querySelector('.shell')).toBeNull();
  expect(host.querySelector('[data-team-step]')).not.toBeNull();
  // The steps behind it are done and no longer open; so is the skip-setup link.
  const steps = [...host.querySelectorAll<HTMLButtonElement>('.step-bar-item')];
  expect(steps).toHaveLength(4);
  expect(steps.slice(0, 3).every((b) => b.disabled && b.classList.contains('is-complete'))).toBe(true);
  expect(steps[3]!.classList.contains('is-active')).toBe(true);
  expect(host.textContent).not.toContain(zh.onboarding.skip);

  click(host.querySelector('[data-team-template="assistant"] .team-edit'));
  flushSync();
  fill(host.querySelector('[data-team-name="assistant"]'), '阿福');
  click(buttonByText(host, `${zh.templates.create(1)} ✓`));
  await settle();
  expect(made).toHaveLength(1);
  expect(made[0]!.playbookId).toBe('general');
  expect(made[0]!.members[0]!.body).toMatchObject({
    name: '阿福',
    duties: zh.templates.templates.assistant!.duties,
    boundaries: zh.templates.templates.assistant!.boundaries,
    model: null,
  });
  expect(host.querySelector('.onboarding-screen')).toBeNull();
  expect(host.querySelector('.shell')).not.toBeNull();
});

test('carrying a terminal session on at the last step opens the app in it, with no Bot made', async () => {
  const zh = copyFor('zh');
  const listing = { session_id: 's1', config_dir: null, title: '修登录页的跳转', cwd: '/Users/a/proj', git_branch: null, modified_at: new Date().toISOString(), size: 1 };
  const carried: unknown[] = [];
  const runtime = firstRunRuntime({}, {
    client: { claudeCodeSessions: async () => [listing] },
    createProjectSession: async (body: unknown) => {
      carried.push(body);
      runtime.snapshot.sessions = [aProjectSession({ id: 'p1', name: listing.title, project_dir: listing.cwd })];
      return null;
    },
  });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  await settle();
  saveSetup(host, `${zh.onboarding.step3NextStart} →`);
  await settle();
  click(host.querySelector('[data-start-way="carry"]'));
  flushSync();
  click(host.querySelector('[data-picker-dir="/Users/a/proj"] .picker-head'));
  flushSync();
  click(host.querySelector('[data-claude-session="s1"]'));
  flushSync();
  click(buttonByText(host, zh.sidebar.importClaudeSubmit));
  await settle();
  expect(carried).toEqual([{ agent: 'claude_code', import: { session_id: 's1', config_dir: null } }]);
  expect(host.querySelector('.onboarding-screen')).toBeNull();
  expect(host.querySelector('.shell')).not.toBeNull();
  expect(runtime.snapshot.bots).toEqual([]);
});

test('the first-Bot step can be skipped into the app', async () => {
  const zh = copyFor('zh');
  let made = 0;
  const runtime = firstRunRuntime({}, { createTeam: async () => { made++; return { failed: null, error: null, groupFailed: false }; } });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  saveSetup(host, `${zh.onboarding.step3Next} →`);
  await settle();
  click(buttonByText(host, zh.onboarding.skipBot));
  expect(host.querySelector('.onboarding-screen')).toBeNull();
  expect(host.querySelector('.shell')).not.toBeNull();
  expect(made).toBe(0);
});

test('a refused first Bot keeps the wizard up with the reason on its field', async () => {
  const zh = copyFor('zh');
  const runtime = firstRunRuntime({}, {
    createTeam: async () => ({ failed: 0, error: new ApiError(409, 'conflict', 'that name is already used'), groupFailed: false }),
  });
  const { host, close } = render(Shell, { runtime }); cleanups.push(close);
  saveSetup(host, `${zh.onboarding.step3Next} →`);
  await settle();
  click(buttonByText(host, `${zh.templates.create(1)} ✓`));
  await settle();
  expect(host.querySelector('.onboarding-screen')).not.toBeNull();
  expect(host.textContent).toContain(zh.sidebar.nameConflict);
  expect(host.textContent).toContain(zh.templates.failed(zh.templates.templates.assistant!.name));
  expect(host.querySelector('[data-team-name="assistant"]')).not.toBeNull();
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
  expect(host.querySelector('[data-team-step]')).toBeNull();
  // Setup finished elsewhere (another window, the phone): nothing holds this wizard up any more.
  runtime.snapshot.settings.wizard_complete = true;
  flushSync();
  expect(host.querySelector('.onboarding-screen')).toBeNull();
});
