/**
 * The task map's side column (ADR 0096) at the map pane's width and height: two Bots' cards, then
 * what was asked and the moments with as many lines as each story gives them, so how the two share
 * the column can be measured. Every line is a fixture.
 */
import { copyFor } from '../../src/lib/copy.ts';
import type { CharacterLook } from '../../src/lib/taskmap/characters.ts';
import type { FrameActor } from '../../src/lib/taskmap/frame.ts';
import type { MomentText } from '../../src/lib/taskmap/moment-text.ts';
import type { Quest } from '../../src/lib/taskmap/timeline.ts';
import MapSide from '../../src/lib/taskmap/MapSide.svelte';

function lead(b: number, short: string, status: FrameActor['status']): FrameActor {
  return {
    b, key: `lead-${b}`, lead: true, sessionId: null, at: null, short, description: null, x: 0, y: 0, z: 0, present: true,
    walking: false, busy: status === 'work', status, idleMin: status === 'idle' ? 45 : 0, verb: '翻阅', file: null, tile: 0,
    model: 'claude-opus-5-5', modelShort: 'Opus 5.5', hasModel: b === 0, modelFamily: 'opus', motion: 'idle', step: 40, fails: 0,
    side: 0, lift: 0, badgeTop: 0, scale: 1,
  };
}

export function taskmapSideStory(said: number, moments: number) {
  const t = copyFor('zh').taskmap;
  const looks: CharacterLook[] = [
    { name: '视频导演', figure: 'pudding', face: { eyes: 'dot', mouth: 'smile' }, avatar: null, source: { kind: 'custom', name: 'Claude Agent' } },
    { name: '审核员', figure: 'taro', face: { eyes: 'dot', mouth: 'smile' }, avatar: null, source: { kind: 'custom', name: 'Claude Agent' } },
  ];
  const quests: Quest[] = Array.from({ length: said }, (_, i) => ({ kind: 'say', at: i * 60_000, v: i * 10, text: `第 ${i + 1} 句：继续把成片做完` }));
  const lines: (MomentText & { v: number })[] = Array.from({ length: moments }, (_, i) => ({ title: `时刻 ${i + 1}`, sub: '09:04 · 继续', color: '#3aa0a8', v: i * 10 + 5 }));
  return {
    component: MapSide as never,
    props: {
      t, looks, faces: false, actors: [lead(0, '视频导演', 'work'), lead(1, '审核员', 'idle')], colors: ['#3aa0a8', '#6b7bd6'],
      place: () => 'shots', follow: -1, quests, quest: Math.max(0, said - 1), moments: lines, live: -1,
      when: (at: number) => `${String(Math.floor(at / 3_600_000) % 24).padStart(2, '0')}:${String(Math.floor(at / 60_000) % 60).padStart(2, '0')}`,
      onFollow: () => {}, onJump: () => {},
    },
    width: 300, height: 900,
    // The map pane's side column around it: a flex column with the note under the cards.
    afterMount(host: HTMLElement) {
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      host.style.gap = '8px';
      host.style.padding = '10px';
      host.style.boxSizing = 'border-box';
      host.style.background = 'var(--ground)';
      const note = document.createElement('p');
      note.textContent = t.note;
      note.style.cssText = 'margin:0;font-size:var(--text-micro);color:var(--muted);line-height:1.4';
      host.append(note);
    },
  };
}
