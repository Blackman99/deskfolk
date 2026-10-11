import { expect, test } from 'bun:test';
import type { CreateBotRequest, CreateGroupRequest } from '@real-bot/protocol';
import { ApiError } from './api.ts';
import { AdminMutations, type AdminMutationsHost, type TeamMember } from './admin-mutations.svelte.ts';
import type { MessengerApi } from './messenger-api.ts';

/** A client that makes Bots and groups, refusing the names it is told to. */
function team(refuse: string[] = [], groupFails = false) {
  const log: string[] = [];
  const api = {
    async createBot(body: CreateBotRequest) {
      log.push(`bot ${body.name} ${body.playbook_id}`);
      if (refuse.includes(body.name)) throw new ApiError(409, 'conflict', 'that name is already used');
      return { bot: { id: `b-${body.name}` }, direct_session: { id: `d-${body.name}` } };
    },
    async createGroup(body: CreateGroupRequest) {
      log.push(`group ${body.name} ${body.members.join(',')} ${body.playbook_id}`);
      if (groupFails) throw new ApiError(422, 'invalid', 'nope');
      return { id: 'g-1' };
    },
    async confirmGroupLead(sessionId: string, botId: string | null) {
      log.push(`lead ${sessionId} ${botId}`);
      return {};
    },
  } as unknown as MessengerApi;
  const host = {
    api,
    pendingMutation: null,
    durablePending: [],
    endpointKey: '',
    views: new Map(),
    selectedId: null,
    profileBotId: null,
    reconcilePendingMutation() {},
    closeSheets() {},
    async selectSession(id: string) { log.push(`open ${id}`); },
    closeProfile() {},
    closeSessionSettings() {},
    clearHighlight() {},
    markDisconnected() { log.push('down'); },
  } satisfies AdminMutationsHost;
  return { mutations: new AdminMutations(host), log };
}

const member = (name: string): TeamMember => ({ body: { name, duties: 'd', boundaries: 'b', model: null }, made: null });

test('one Bot opens its direct on the engine picked; no group', async () => {
  const { mutations, log } = team();
  const result = await mutations.createTeam({ members: [member('助理')], playbookId: 'general', groupName: '助手们', lead: 0 });
  expect(result).toEqual({ failed: null, error: null, groupFailed: false });
  expect(log).toEqual(['bot 助理 general', 'open d-助理']);
});

test('two or more make a group on the same engine, led by the lead, and open it', async () => {
  const { mutations, log } = team();
  const members = [member('编剧'), member('导演'), member('字幕')];
  await mutations.createTeam({ members, playbookId: 'video', groupName: '视频制作', lead: 1 });
  expect(log).toEqual([
    'bot 编剧 video', 'bot 导演 video', 'bot 字幕 video',
    'group 视频制作 b-编剧,b-导演,b-字幕 video',
    'lead g-1 b-导演',
    'open g-1',
  ]);
});

test('a refused Bot stops the rest; trying again makes only the ones left', async () => {
  const first = team(['导演']);
  const members = [member('编剧'), member('导演'), member('字幕')];
  const result = await first.mutations.createTeam({ members, playbookId: 'video', groupName: '视频制作', lead: 1 });
  expect(result.failed).toBe(1);
  expect(result.error?.status).toBe(409);
  expect(first.log).toEqual(['bot 编剧 video', 'bot 导演 video']);
  expect(members[0]!.made).toEqual({ botId: 'b-编剧', directId: 'd-编剧' });

  const again = team();
  members[1]!.body = { ...members[1]!.body, name: '导演二' };
  await again.mutations.createTeam({ members, playbookId: 'video', groupName: '视频制作', lead: 1 });
  expect(again.log).toEqual(['bot 导演二 video', 'bot 字幕 video', 'group 视频制作 b-编剧,b-导演二,b-字幕 video', 'lead g-1 b-导演二', 'open g-1']);
});

test('a group that cannot be made still lands on the first direct, and says so', async () => {
  const { mutations, log } = team([], true);
  const result = await mutations.createTeam({ members: [member('前端'), member('后端')], playbookId: 'coding', groupName: '开发', lead: 0 });
  expect(result).toEqual({ failed: null, error: null, groupFailed: true });
  expect(log.at(-1)).toBe('open d-前端');
});
