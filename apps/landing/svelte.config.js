import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    paths: {
      base: process.env.BASE_PATH ?? '',
      relative: false
    },
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: '404.html',
      precompress: false,
      strict: false
    }),
    prerender: {
      // A dead link between pages the site builds fails the build instead of shipping.
      handleHttpError: 'fail'
    }
  }
};

export default config;
