import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { aBot, aRoutine, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import RoutineCard from "./RoutineCard.svelte";
import { planRoutine, routineDraft } from "./routine-form.ts";

const t = copyFor("en");
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); flushSync(); };
function open(rows = [aRoutine()], stubs: Record<string, unknown> = {}) {
  const runtime = reactive(fakeRuntime({ bots: [aBot()], routines: rows }, stubs));
  return { ...render(RoutineCard, { runtime, bot: aBot(), t }), runtime };
}
function submit(host: HTMLElement) {
  host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
}

test("empty state and daily creation validate title and clock before sending the owning Bot", async () => {
  const { host, runtime, close } = open([]);
  expect(host.textContent).toContain(t.routines.empty);
  click(buttonByText(host, t.routines.add));
  fill(host.querySelector('#routine-time'), '24:01'); submit(host);
  expect(host.textContent).toContain(t.routines.nameRequired);
  expect(host.textContent).toContain(t.routines.timeInvalid);
  expect(runtime.calls).toHaveLength(0);
  fill(host.querySelector('#routine-title'), '  Daily brief  ');
  fill(host.querySelector('#routine-time'), '07:45');
  fill(host.querySelector('#routine-instruction'), 'Read the backlog'); submit(host); await settle();
  expect(runtime.calls[0]).toEqual({ name: 'createRoutine', args: [{ bot_id: 'bot-1', title: 'Daily brief', instruction: 'Read the backlog', enabled: true, schedule: { kind: 'daily', time: '07:45' } }] });
  expect(host.querySelector('form')).toBeNull();
  expect(runtime.snapshot.routines).toHaveLength(0);
  close();
});

test("weekly editing requires a weekday and preserves the revision and exact civil time", async () => {
  const { host, runtime, close } = open();
  click(host.querySelector('.routine-open'));
  click(host.querySelector('input[value=weekly]')); submit(host);
  expect(host.textContent).toContain(t.routines.daysRequired);
  click(host.querySelector('input[value=mon]')); click(host.querySelector('input[value=fri]'));
  fill(host.querySelector('#routine-time'), '23:59'); submit(host); await settle();
  expect(runtime.calls[0]!.args).toEqual(['routine-1', { title: 'Morning brief', instruction: "Summarize today's work", enabled: true, schedule: { kind: 'weekly', time: '23:59', weekdays: ['mon', 'fri'] }, if_revision: aRoutine().updated_at }]);
  close();
});

test("pause and resume use the live row revision without optimistic snapshot writes", async () => {
  const { host, runtime, close } = open();
  click(buttonByText(host, t.routines.pause)); await settle();
  expect(runtime.calls[0]!.args).toEqual(['routine-1', { enabled: false, if_revision: aRoutine().updated_at }]);
  expect(runtime.snapshot.routines[0]!.enabled).toBe(true);
  flushSync(() => { runtime.snapshot.routines = [aRoutine({ enabled: false, updated_at: 'next' })]; });
  click(buttonByText(host, t.routines.resume)); await settle();
  expect(runtime.calls[1]!.args).toEqual(['routine-1', { enabled: true, if_revision: 'next' }]); close();
});

test("delete cancellation is inert and confirmation pins the revision at prompt time", async () => {
  const { host, runtime, close } = open();
  click(buttonByText(host, t.routines.remove)); click(buttonByText(host, t.routines.cancel));
  expect(runtime.calls).toHaveLength(0);
  click(buttonByText(host, t.routines.remove));
  flushSync(() => { runtime.snapshot.routines = [aRoutine({ updated_at: 'newer' })]; });
  click(buttonByText(host, t.routines.confirm)); await settle();
  expect(runtime.calls[0]!.args).toEqual(['routine-1', aRoutine().updated_at]); close();
});

for (const status of [409, 404, 422, 0, 500]) test(`save failure ${status} retains the draft`, async () => {
  const { host, close } = open([], { createRoutine: async () => new ApiError(status, 'failed', 'fixture') });
  click(buttonByText(host, t.routines.add)); fill(host.querySelector('#routine-title'), 'Unsaved'); submit(host); await settle();
  expect(host.querySelector('[role=alert]')).not.toBeNull();
  expect((host.querySelector('#routine-title') as HTMLInputElement).value).toBe('Unsaved'); close();
});

test("dirty draft blocks stale save; explicit reload takes the streamed revision", async () => {
  const { host, runtime, close } = open();
  click(host.querySelector('.routine-open')); fill(host.querySelector('#routine-title'), 'My draft');
  flushSync(() => { runtime.snapshot.routines = [aRoutine({ title: 'Other client', updated_at: 'next' })]; });
  expect((host.querySelector('#routine-title') as HTMLInputElement).value).toBe('My draft');
  expect(host.textContent).toContain(t.routines.conflict);
  expect(buttonByText(host, t.routines.save).disabled).toBe(true);
  submit(host); expect(runtime.calls).toHaveLength(0);
  click(buttonByText(host, t.routines.reload));
  fill(host.querySelector('#routine-title'), 'Rebased'); submit(host); await settle();
  expect((runtime.calls[0]!.args[1] as { if_revision: string }).if_revision).toBe('next'); close();
});

test("clean editor follows live updates and a removed routine cannot be saved", () => {
  const { host, runtime, close } = open(); click(host.querySelector('.routine-open'));
  flushSync(() => { runtime.snapshot.routines = [aRoutine({ title: 'Live', updated_at: 'next' })]; });
  expect((host.querySelector('#routine-title') as HTMLInputElement).value).toBe('Live');
  flushSync(() => { runtime.snapshot.routines = []; });
  expect(host.textContent).toContain(t.routines.missing);
  expect(buttonByText(host, t.routines.save).disabled).toBe(true); close();
});

test("search target opens and highlights only its owning routine", () => {
  const { host, runtime, close } = open([aRoutine(), aRoutine({ id: 'other', bot_id: 'bot-2' })]);
  flushSync(() => { runtime.profileRoutineId = 'routine-1'; });
  expect(host.querySelector('.routine-row.is-open')?.getAttribute('data-routine-id')).toBe('routine-1');
  expect(host.querySelectorAll('.routine-row')).toHaveLength(1);
  expect(host.querySelector('form')).not.toBeNull(); close();
});

test("in-flight delete disables duplicate confirm and dismissal", async () => {
  let done!: (value: null) => void;
  const { host, close } = open([aRoutine()], { deleteRoutine: () => new Promise((r) => { done = r; }) });
  click(buttonByText(host, t.routines.remove)); click(buttonByText(host, t.routines.confirm));
  expect(buttonByText(host, t.routines.confirm).disabled).toBe(true);
  expect(buttonByText(host, t.routines.cancel).disabled).toBe(true);
  done(null); await settle(); expect(host.querySelector('[role=dialog]')).toBeNull(); close();
});

test("disconnected and in-flight forms do not dispatch or double submit", async () => {
  let done!: (value: null) => void;
  let calls = 0;
  const { host, runtime, close } = open([], { createRoutine: () => { calls++; return new Promise((r) => { done = r; }); } });
  click(buttonByText(host, t.routines.add)); fill(host.querySelector('#routine-title'), 'Once'); submit(host); submit(host);
  expect(calls).toBe(1); expect((host.querySelector('#routine-title') as HTMLInputElement).disabled).toBe(true);
  done(null); await settle();
  flushSync(() => { runtime.connection = 'disconnected'; });
  expect(buttonByText(host, t.routines.add).disabled).toBe(true); close();
});

test("validation matches the existing daily/weekly clock boundary", () => {
  for (const time of ['00:00', '23:59']) expect(planRoutine({ ...routineDraft(aRoutine()), time }, t).errors).toEqual({});
  for (const time of ['9:00', '24:00', '12:60', '09:00:00', '']) expect(planRoutine({ ...routineDraft(aRoutine()), time }, t).errors.time).toBeTruthy();
  expect(planRoutine({ ...routineDraft(aRoutine()), kind: 'weekly', weekdays: ['oops'] }, t).errors.weekdays).toBeTruthy();
});
