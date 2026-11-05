"""Write the brand marks the home page's models scene shows, from the app's own logo components.

Run: python3 scripts/logos/build.py   (from apps/landing; standard library only)

Each mark is the glyph the messenger draws (settings/AgentLogo.svelte for the local agents,
settings/ConnectorLogo.svelte for the endpoints, ClaudeSpark.svelte for Claude Code), on the same
tile colour and with the same inset, written as one self-contained SVG in static/logos/<socket>.svg
so the page shows it as a plain picture. OpenRouter and Ollama have no mark in the app; theirs are
lobe-icons' drawings as published (scripts/logos/lobe/, @lobehub/icons-static-svg 1.95.1, MIT),
on the brands' own tiles. The marks are their owners' trademarks (THIRD_PARTY_NOTICES.md).
"""
import os, re

here = os.path.dirname(os.path.abspath(__file__))
landing = os.path.normpath(os.path.join(here, '..', '..'))
settings = os.path.normpath(os.path.join(landing, '..', 'messenger', 'src', 'lib', 'settings'))
out_dir = os.path.join(landing, 'static', 'logos')

# The models scene's sockets, and where each one's mark comes from: (component, key in it).
SOCKETS = {
    'claude': ('agent', 'claude_code'),
    'codex': ('agent', 'codex'),
    'grok': ('agent', 'grok'),
    'opencode': ('agent', 'opencode'),
    'antigravity': ('agent', 'antigravity'),
    'zcode': ('agent', 'zcode'),
    'anthropic': ('connector', 'anthropic'),
    'deepseek': ('connector', 'deepseek'),
    'qwen': ('connector', 'qwen'),
    'mimo': ('connector', 'xiaomi'),
    'openrouter': ('lobe', 'openrouter'),
    'ollama': ('lobe', 'ollama'),
}

# Tiles for the two the app does not draw: lobe-icons' own avatar colours for them.
LOBE_TILES = {
    'openrouter': {'background': '#6566F1', 'color': '#ffffff', 'padding': 0.2},
    'ollama': {'background': '#ffffff', 'color': '#000000', 'padding': 0.18},
}

DEFAULT_PAD = 0.16


def tiles(source):
    """The `TILE` record of a logo component: key → background, color, padding."""
    block = re.search(r'const TILE: Record<[^>]+> = \{(.*?)\n\t\};', source, re.S).group(1)
    found = {}
    for key, body in re.findall(r"(\w+): \{([^}]*)\}", block):
        tile = {}
        for name, value in re.findall(r"(background|color|padding): ('[^']*'|[\d.]+)", body):
            tile[name] = float(value) if name == 'padding' else value.strip("'")
        found[key] = tile
    return found


def branches(source, var):
    """Each `{#if var === 'key'}` / `{:else if …}` branch's markup, by key."""
    parts = re.split(r"\{(?:#if|:else if) " + var + r" === '(\w+)'\}", source)
    found = {}
    for i in range(1, len(parts), 2):
        found[parts[i]] = re.split(r'\{:else\}|\{/if\}', parts[i + 1])[0].strip()
    return found


def plain(svg):
    """Svelte expressions in a glyph made plain: generated ids become fixed ones."""
    svg = re.sub(r"id=\{id\('([\w-]+)'\)\}", r'id="\1"', svg)
    svg = re.sub(r"\{id\('([\w-]+)'\)\}", r'\1', svg)
    svg = svg.replace('id={gradient}', 'id="qwen-gradient"').replace('{`url(#${gradient})`}', '"url(#qwen-gradient)"')
    if '{' in svg:
        raise SystemExit(f'an expression is left in a glyph: {svg[:120]}')
    return svg


def inner(svg):
    """An <svg> element's attributes (as a string, without its size) and its children."""
    m = re.match(r'<svg([^>]*)>(.*)</svg>\s*$', svg, re.S)
    if not m:
        raise SystemExit(f'not one <svg> element: {svg[:120]}')
    attrs = re.sub(r'\s(width|height|class|style|xmlns|data-[\w-]+|aria-hidden)=("[^"]*"|\{[^}]*\})', '', m.group(1))
    attrs = re.sub(r'\sdata-[\w-]+(?=[\s>]|$)', '', attrs)
    body = re.sub(r'<title>.*?</title>', '', m.group(2), flags=re.S)
    return attrs, body


def tile_svg(glyph, tile):
    """One self-contained tile: the brand colour behind the glyph, inset as the app insets it."""
    attrs, body = inner(glyph)
    pad = tile.get('padding', DEFAULT_PAD)
    color = tile.get('color', '#000000')
    attrs = attrs.replace('currentColor', color)
    if 'fill=' not in attrs:
        attrs += f' fill="{color}"'
    at, size = round(pad * 100, 2), round((1 - 2 * pad) * 100, 2)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        f'<rect width="100" height="100" fill="{tile["background"]}"/>'
        f'<svg x="{at}" y="{at}" width="{size}" height="{size}"{attrs}>{body}</svg>'
        f'</svg>\n'
    )


agent_src = open(os.path.join(settings, 'AgentLogo.svelte')).read()
connector_src = open(os.path.join(settings, 'ConnectorLogo.svelte')).read()
spark_src = open(os.path.join(settings, 'ClaudeSpark.svelte')).read()

sources = {
    'agent': (tiles(agent_src), branches(agent_src, 'runner')),
    'connector': (tiles(connector_src), branches(connector_src, 'id')),
}
# Claude Code's branch is the Spark component, drawn at 64% of the tile.
spark = re.search(r'<svg class="claude-spark".*?</svg>', spark_src, re.S).group(0)
sources['agent'][1]['claude_code'] = spark
sources['agent'][0]['claude_code'] = {**sources['agent'][0]['claude_code'], 'padding': 0.18}

os.makedirs(out_dir, exist_ok=True)
total = 0
for socket, (kind, key) in SOCKETS.items():
    if kind == 'lobe':
        glyph, tile = open(os.path.join(here, 'lobe', key + '.svg')).read().strip(), LOBE_TILES[key]
    else:
        tile_map, glyphs = sources[kind]
        glyph, tile = glyphs[key], tile_map[key]
    svg = tile_svg(plain(re.sub(r'\s(width|height)=\{[^}]*\}', '', glyph)), tile)
    path = os.path.join(out_dir, socket + '.svg')
    with open(path, 'w') as f:
        f.write(svg)
    total += len(svg.encode())
print(f'wrote {len(SOCKETS)} marks to {os.path.relpath(out_dir, landing)}, {total} bytes')
