import { flushSync, mount } from 'svelte';
import 'virtual:uno.css';
import '../../src/lib/styles/index.css';
import { rc11Stories, stories } from './stories.ts';
import type { StoryName } from './story-list.ts';

const params = new URLSearchParams(location.search);
const name = params.get('story') ?? '';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;

const story = (stories[name as StoryName] ?? rc11Stories[name as keyof typeof rc11Stories]) as
	| (typeof stories)[StoryName]
	| (typeof rc11Stories)[keyof typeof rc11Stories]
	| undefined;
const host = document.getElementById('story')!;
if (!story) {
	host.textContent = `unknown story: ${name}. known: ${Object.keys(stories).join(', ')}`;
} else {
	document.body.style.cssText = `margin:0;width:${story.width}px;height:${story.height}px;background:var(--bg)`;
	host.style.cssText = `width:${story.width}px;height:${story.height}px;position:relative;overflow:hidden`;
	mount(story.component as never, { target: host, props: story.props as never });
	story.afterMount?.(host);
	// Monaco arrives on a dynamic import, so the camera has to be told to wait for it.
	if (host.querySelector('.artifact-cm')) {
		void (async () => {
			for (let i = 0; i < 200 && !host.querySelector('.monaco-editor .view-line'); i += 1) {
				await new Promise((r) => setTimeout(r, 25));
			}
			await new Promise((r) => setTimeout(r, 150));
			document.documentElement.dataset.ready = 'yes';
		})();
	} else if (host.querySelector('.artifact-pane')) {
		void (async () => {
			for (let i = 0; i < 8 && !host.querySelector('.artifact-loading') && !host.querySelector('.artifact-img'); i += 1) {
				await new Promise((r) => setTimeout(r, 25));
			}
			for (let i = 0; i < 80 && host.querySelector('.artifact-loading'); i += 1) {
				await new Promise((r) => setTimeout(r, 25));
			}
			document.documentElement.dataset.ready = 'yes';
		})();
	}
	flushSync();
	if (!host.querySelector('.artifact-cm') && !host.querySelector('.artifact-pane')) {
		document.documentElement.dataset.ready = 'yes';
	}
}
