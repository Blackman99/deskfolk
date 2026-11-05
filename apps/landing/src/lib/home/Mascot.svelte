<script lang="ts">
  import { base } from '$app/paths';
  import { MASCOT_GEOMETRY, MASCOT_LAYERS } from './mascot-assets';
  import { POSES } from './motion';
  import type { MascotState, Who } from './stage.svelte';
  import Held from './Held.svelte';

  /**
   * Mochi or Pudding, stacked from its rendered layers (scripts/mascots) the way the messenger's
   * FolkAvatar stacks the folk: body, arms that turn about the shoulders, a face that follows
   * `--look-x`/`--look-y` (set by whoever places it), blinking eyes and a mouth that talks while a
   * bubble shows. It fills its box, which is square, and leans by `--lean` (degrees). A press pokes.
   */
  let {
    who,
    state,
    label,
    bubble = null,
    hopping = false,
    poke
  }: {
    who: Who;
    state: MascotState;
    /** Its name, for the button that pokes it. */
    label: string;
    /** A line over its head: the scene's `say`, or a poke's answer. */
    bubble?: string | null;
    /** In the air between two places: arms out, a happy face. */
    hopping?: boolean;
    poke?: () => void;
  } = $props();

  const layers = $derived(MASCOT_LAYERS[who] as Record<string, readonly number[]>);
  const g = $derived(MASCOT_GEOMETRY[who]);
  const pose = $derived(POSES[hopping ? 'hop' : state.pose]);
  const eyes = $derived(`eyes-${pose.eyes}`);
  const mouth = $derived(`mouth-${pose.mouth}`);

  const src = (layer: string) => `${base}/mascots/${who}/${layer}.webp`;
  const box = (layer: string) => {
    const [x, y, w, h] = layers[layer];
    return `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%`;
  };
  const at = ([x, y]: readonly number[]) => `${x * 100}% ${y * 100}%`;
  const spot = ([x, y]: readonly number[]) => `left:${x * 100}%;top:${y * 100}%`;
</script>

<button
  type="button"
  class="mascot is-{pose.move}"
  class:is-away={state.away}
  class:is-talking={!!bubble}
  class:is-hopping={hopping}
  data-who={who}
  aria-label={label}
  tabindex={state.away ? -1 : 0}
  onclick={() => poke?.()}
  style:--shoulder-l={at(g.shoulderL)}
  style:--shoulder-r={at(g.shoulderR)}
  style:--head={at(g.headTop)}
  style:--raise-l="{pose.armL}deg"
  style:--raise-r="{-pose.armR}deg"
>
  <span class="shadow" aria-hidden="true"></span>
  <span class="lean" aria-hidden="true">
    <span class="flip" class:is-mirrored={state.mirror}>
      <span class="fig">
        <img class="layer" src={src('body')} alt="" style={box('body')} />
        {#if who === 'pudding'}
          <span class="antenna"><img class="layer" src={src('acc-antenna')} alt="" style={box('acc-antenna')} /></span>
        {/if}
        <span class="face">
          <img class="layer eyes" src={src(eyes)} alt="" style={box(eyes)} />
          <img class="layer blink" src={src('eyes-closed')} alt="" style={box('eyes-closed')} />
          <img class="layer mouth" src={src(mouth)} alt="" style={box(mouth)} />
          <img class="layer talk" src={src('mouth-open')} alt="" style={box('mouth-open')} />
        </span>
        <span class="arm arm-l"><img class="layer" src={src('arm-l')} alt="" style={box('arm-l')} /></span>
        <span class="arm arm-r">
          <img class="layer" src={src('arm-r')} alt="" style={box('arm-r')} />
          {#if state.held}
            <span class="held" style={spot(g.handR)}><Held item={state.held} /></span>
          {/if}
        </span>
      </span>
    </span>
    {#if pose.mark === 'ask'}
      <span class="mark ask">?</span>
    {:else if pose.mark === 'think'}
      <span class="mark think"><i></i><i></i><i></i></span>
    {:else if pose.mark === 'rest'}
      <span class="mark rest"><i>z</i><i>z</i></span>
    {/if}
  </span>
  {#if bubble}
    {#key bubble}
      <span class="bubble" aria-hidden="true">{bubble}</span>
    {/key}
  {/if}
</button>

<style>
  .mascot {
    all: unset;
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    cursor: pointer;
    container-type: size;
    transition: opacity 320ms ease;
    -webkit-tap-highlight-color: transparent;
  }

  .mascot:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 4px;
    border-radius: var(--radius-lg);
  }

  .mascot.is-away {
    opacity: 0;
    pointer-events: none;
  }

  .lean,
  .flip,
  .fig,
  .face,
  .arm,
  .antenna {
    position: absolute;
    inset: 0;
  }

  .lean {
    transform-origin: 50% 98%;
    transform: rotate(calc(var(--lean, 0) * 1deg));
  }

  .flip.is-mirrored {
    transform: scaleX(-1);
  }

  .fig {
    transform-origin: 50% 98%;
  }

  .layer {
    position: absolute;
    display: block;
    max-width: none;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-user-drag: none;
  }

  /* The face looks where it is told; mirrored figures flip it with the rest. */
  .face {
    transform: translate(calc(var(--look-x, 0) * 3.2%), calc(var(--look-y, 0) * 2.4%));
    transition: transform 120ms linear;
  }

  .antenna {
    transform-origin: var(--head);
    animation: antenna 2.8s ease-in-out infinite;
  }

  .arm {
    transition: transform 320ms cubic-bezier(0.3, 1.4, 0.5, 1);
  }

  .arm-l {
    transform-origin: var(--shoulder-l);
    transform: rotate(var(--raise-l));
  }

  .arm-r {
    transform-origin: var(--shoulder-r);
    transform: rotate(var(--raise-r));
  }

  /* What the hand holds stays upright however the arm is raised. */
  .held {
    position: absolute;
    width: 0;
    height: 0;
    rotate: calc(-1 * var(--raise-r));
    transition: rotate 320ms cubic-bezier(0.3, 1.4, 0.5, 1);
  }

  .blink {
    opacity: 0;
    animation: blink 4.6s infinite;
  }

  .mascot[data-who='mochi'] .blink {
    animation-delay: -2.1s;
  }

  .blink ~ .mouth {
    opacity: 1;
  }

  .eyes {
    animation: blink-hide 4.6s infinite;
  }

  .mascot[data-who='mochi'] .eyes {
    animation-delay: -2.1s;
  }

  .talk {
    opacity: 0;
  }

  .is-talking .talk {
    animation: talk 0.36s steps(1) 4;
  }

  .is-talking .mouth {
    animation: talk-hide 0.36s steps(1) 4;
  }

  /* ── Moves ── */
  .is-breathe .fig {
    animation: breathe 3.2s ease-in-out infinite;
  }

  .is-bob .fig {
    animation: bob 1.1s ease-in-out infinite;
  }

  .is-hop .fig {
    animation: hop 0.9s cubic-bezier(0.3, 0, 0.4, 1) infinite;
  }

  .is-sway .fig {
    animation: sway 2.4s ease-in-out infinite;
  }

  .is-walk .fig {
    animation: walk 0.52s ease-in-out infinite;
  }

  .is-wave .arm-r {
    animation: wave 0.62s ease-in-out infinite alternate;
  }

  .is-type .arm-l {
    animation: type 0.34s ease-in-out infinite alternate;
  }

  .is-type .arm-r {
    animation: type 0.34s ease-in-out infinite alternate-reverse;
  }

  .is-walk .arm-l {
    animation: swing 0.52s ease-in-out infinite alternate;
  }

  .is-walk .arm-r {
    animation: swing 0.52s ease-in-out infinite alternate-reverse;
  }

  .is-hopping .fig {
    animation: none;
    scale: 0.96 1.05;
  }

  .shadow {
    position: absolute;
    left: 22%;
    right: 22%;
    bottom: -1%;
    height: 7%;
    border-radius: 50%;
    background: radial-gradient(closest-side, rgba(18, 28, 32, 0.28), transparent);
    transition: opacity 200ms ease, scale 200ms ease;
  }

  .is-hopping .shadow {
    opacity: 0.4;
    scale: 0.7;
  }

  .is-away .shadow {
    opacity: 0;
  }

  /* ── Marks over the head ── */
  .mark {
    position: absolute;
    left: 74%;
    top: 4%;
    font-family: var(--font-display);
    font-weight: 800;
    color: var(--teal);
    pointer-events: none;
  }

  .ask {
    font-size: max(16px, 24cqw);
    line-height: 1;
    animation: bob 1.1s ease-in-out infinite;
  }

  .think {
    display: flex;
    gap: 3px;
  }

  .think i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--teal);
    animation: dot 1.2s ease-in-out infinite;
  }

  .think i:nth-child(2) {
    animation-delay: 0.15s;
  }

  .think i:nth-child(3) {
    animation-delay: 0.3s;
  }

  .rest i {
    position: absolute;
    font-style: normal;
    font-size: 15px;
    color: var(--ink-3);
    animation: z 2.4s ease-out infinite;
  }

  .rest i:nth-child(2) {
    animation-delay: 1.2s;
  }

  /* ── The bubble ── */
  .bubble {
    position: absolute;
    left: 50%;
    bottom: calc(100% - 4%);
    translate: -50% 0;
    width: max-content;
    max-width: 230px;
    padding: 7px 12px;
    border-radius: 14px;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-float);
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.35;
    text-align: center;
    white-space: normal;
    pointer-events: none;
    animation: pop 260ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .bubble::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 100%;
    width: 10px;
    height: 10px;
    translate: -50% -5px;
    rotate: 45deg;
    background: var(--paper);
    border-right: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }

  @keyframes breathe {
    0%,
    100% {
      scale: 1 1;
    }
    50% {
      scale: 1.012 0.984;
    }
  }

  @keyframes bob {
    0%,
    100% {
      translate: 0 0;
    }
    50% {
      translate: 0 -4%;
    }
  }

  @keyframes hop {
    0%,
    100% {
      translate: 0 0;
      scale: 1.06 0.92;
    }
    18% {
      scale: 0.95 1.06;
    }
    45% {
      translate: 0 -16%;
      scale: 1 1;
    }
    72% {
      translate: 0 0;
      scale: 1.04 0.95;
    }
  }

  @keyframes sway {
    0%,
    100% {
      rotate: -3deg;
    }
    50% {
      rotate: 3deg;
    }
  }

  @keyframes walk {
    0%,
    100% {
      translate: 0 0;
      rotate: -2.5deg;
    }
    50% {
      translate: 0 -3%;
      rotate: 2.5deg;
    }
  }

  @keyframes wave {
    from {
      rotate: 14deg;
    }
    to {
      rotate: -16deg;
    }
  }

  @keyframes type {
    from {
      rotate: -9deg;
    }
    to {
      rotate: 9deg;
    }
  }

  @keyframes swing {
    from {
      rotate: -14deg;
    }
    to {
      rotate: 14deg;
    }
  }

  @keyframes antenna {
    0%,
    100% {
      rotate: -4deg;
    }
    50% {
      rotate: 5deg;
    }
  }

  @keyframes blink {
    0%,
    95%,
    100% {
      opacity: 0;
    }
    96.5%,
    98.5% {
      opacity: 1;
    }
  }

  @keyframes blink-hide {
    0%,
    95%,
    100% {
      opacity: 1;
    }
    96.5%,
    98.5% {
      opacity: 0;
    }
  }

  @keyframes talk {
    0% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  @keyframes talk-hide {
    0% {
      opacity: 0;
    }
    50% {
      opacity: 1;
    }
  }

  @keyframes dot {
    0%,
    100% {
      translate: 0 0;
      opacity: 0.45;
    }
    50% {
      translate: 0 -4px;
      opacity: 1;
    }
  }

  @keyframes z {
    from {
      translate: 0 0;
      opacity: 0;
    }
    30% {
      opacity: 1;
    }
    to {
      translate: 10px -22px;
      opacity: 0;
    }
  }

  @keyframes pop {
    from {
      opacity: 0;
      scale: 0.8;
      translate: -50% 6px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .mascot *,
    .mascot {
      animation: none !important;
      transition: none !important;
    }

    .blink,
    .talk {
      opacity: 0;
    }
  }
</style>
