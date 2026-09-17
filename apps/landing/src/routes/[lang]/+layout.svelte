<script lang="ts">
  import { base, resolve } from '$app/paths';
  import { page } from '$app/state';
  import { DICT, type Lang } from '$lib/i18n';
  import { GITHUB_URL } from '$lib/site';
  import Logo from '$lib/Logo.svelte';

  let { data, children } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);

  const targetLang = $derived(lang === 'zh' ? 'en' : 'zh');
  const switchedPath = $derived.by(() => {
    const routeId = page.route.id ?? '/[lang]';
    const suffix = routeId.startsWith('/[lang]') ? routeId.slice('/[lang]'.length) : '';
    return resolve(`/${targetLang}${suffix}`);
  });

  $effect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  });
</script>

<div class="site">
  <header class="nav">
    <div class="page nav-inner">
      <a class="brand" href="{base}/{lang}">
        <span class="brand-mark"><Logo size={26} /></span>
        <span class="brand-name serif">Real Bot</span>
        <span class="brand-wip">{t.nav.wip}</span>
      </a>

      <nav class="links" aria-label="Sections">
        <a href="{base}/{lang}#demo">{t.nav.demo}</a>
        <a href="{base}/{lang}#boundaries">{t.nav.boundaries}</a>
        <a href="{base}/{lang}#quickstart">{t.nav.quickstart}</a>
        <a href="{base}/{lang}/manifesto">{t.nav.manifesto}</a>
        <a href="{base}/{lang}/roadmap">{t.nav.roadmap}</a>
      </nav>

      <div class="actions">
        <a class="lang" href={switchedPath} hreflang={targetLang}>{t.nav.switchLang}</a>
        <a class="gh" href={GITHUB_URL} target="_blank" rel="noreferrer">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
          <span>{t.nav.github}</span>
        </a>
      </div>
    </div>
  </header>

  <main>
    {@render children()}
  </main>

  <footer class="foot">
    <div class="page foot-inner">
      <div class="foot-brand">
        <span class="foot-id"><Logo size={22} /><span class="brand-name serif">Real Bot</span></span>
        <p>{t.footer.tagline}</p>
        <p class="fine">{t.footer.mit}</p>
      </div>
      <nav class="foot-links" aria-label="Footer">
        <a href="{base}/{lang}/manifesto">{t.nav.manifesto}</a>
        <a href="{base}/{lang}/roadmap">{t.nav.roadmap}</a>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
        <span class="fine">© 2026 {t.footer.contributors}</span>
      </nav>
    </div>
  </footer>
</div>

<style>
  .site {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .nav {
    position: sticky;
    top: 0;
    z-index: 20;
    height: var(--nav-h);
    background: color-mix(in srgb, var(--ground) 86%, transparent);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line);
  }

  .nav-inner {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    color: var(--ink);
  }

  .brand-mark,
  .foot-id {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }

  .brand-name {
    font-size: 1.2rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .brand-wip {
    display: none;
    white-space: nowrap;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--mustard-ink);
    background: var(--mustard-tint);
    border: 1px solid var(--mustard-line);
    border-radius: 999px;
    padding: 1px 8px;
    line-height: 1.6;
  }

  .links {
    display: none;
    gap: 26px;
    font-size: 14.5px;
  }

  .links a {
    color: var(--ink-2);
    text-decoration: none;
  }

  .links a:hover {
    color: var(--teal-2);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .lang,
  .gh {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 0 10px;
    white-space: nowrap;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--paper);
    color: var(--ink);
    font-size: 13.5px;
    font-weight: 600;
    text-decoration: none;
  }

  .lang:hover,
  .gh:hover {
    border-color: var(--teal-line);
    color: var(--teal-2);
  }

  .gh span {
    display: none;
  }

  @media (min-width: 480px) {
    .brand-wip {
      display: inline-block;
    }

    .gh span {
      display: inline;
    }

    .lang,
    .gh {
      padding: 0 12px;
    }
  }

  main {
    flex: 1;
  }

  .foot {
    border-top: 1px solid var(--line);
    padding-block: 40px 48px;
    font-size: 14px;
    color: var(--ink-2);
  }

  .foot-inner {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .foot-brand p {
    margin: 6px 0 0;
  }

  .fine {
    font-size: 13px;
    color: var(--ink-3);
  }

  .foot-links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 22px;
  }

  .foot-links a {
    color: var(--ink-2);
    text-decoration: none;
  }

  .foot-links a:hover {
    color: var(--teal-2);
    text-decoration: underline;
    text-underline-offset: 4px;
  }

  @media (min-width: 900px) {
    .links {
      display: flex;
    }

    .foot-inner {
      flex-direction: row;
      justify-content: space-between;
      align-items: flex-end;
    }
  }
</style>
