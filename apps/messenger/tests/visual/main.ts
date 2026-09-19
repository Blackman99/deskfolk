import { flushSync, mount } from 'svelte';
import 'virtual:uno.css';
import '../../src/lib/styles/index.css';
import { stories } from './stories.ts';
import type { StoryName } from './story-list.ts';

const params = new URLSearchParams(location.search);
const name = params.get('story') ?? '';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;

const story = stories[name as StoryName] as (typeof stories)[StoryName] | undefined;
const host = document.getElementById('story')!;
if (!story) {
	host.textContent = `unknown story: ${name}. known: ${Object.keys(stories).join(', ')}`;
} else {
	document.body.style.cssText = `margin:0;width:${story.width}px;height:${story.height}px;background:var(--bg)`;
	host.style.cssText = `width:${story.width}px;height:${story.height}px;position:relative;overflow:hidden`;
	mount(story.component as never, { target: host, props: story.props as never });
	story.afterMount?.(host);
	flushSync();
	document.documentElement.dataset.ready = 'yes';
}
