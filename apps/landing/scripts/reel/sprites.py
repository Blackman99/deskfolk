"""The reel's cast as sprites: Mochi (you), Pudding (the Producer) and the Reviewer, each move rendered on
its own as transparent PNG frames that film.js picks by time. Every move starts and ends at rest, so the
film can cut from one to the next without a jump. The rigs, materials and moves are the mascot film's
(../mascot/rig.py, scene_lib.py); the Reviewer is a Pudding with the folk avatar's headphones.

Run: Blender -b --factory-startup --python sprites.py -- OUT_DIR [--who mochi,pudding,reviewer]
     [--size 720] [--samples 32] [--still who:clip:frame]
Writes OUT_DIR/<who>/<clip>/NNNN.png and OUT_DIR/sprites.json ({who: {clip: frames}}).
"""
import json, math, os, sys, time
HERE = os.path.dirname(os.path.abspath(sys.argv[sys.argv.index('--python') + 1]))
sys.path.insert(0, os.path.join(HERE, '..', 'mascot'))
import bmesh
import bpy
from mathutils import Vector
import scene_lib as L
from scene_lib import M, add_tube, obj_from_bm, sphere
from rig import FPS, Mascot, frame, key

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default
OUT = os.path.abspath(argv[0] if argv and not argv[0].startswith('--') else 'sprites')
WHO = arg('--who', 'mochi,pudding,reviewer').split(',')
scene = L.scene

# Facing the viewer's right, three quarters on; film.js mirrors a sprite to face left.
FACE = math.radians(24)


def headphones(m):
    """The folk avatar's headphones (packages/protocol/scripts/folk-avatar/render.py), on a rig's squash."""
    r, sz, c = m.r, m.sz, m.c
    rb, rz = r + 0.009, r * sz + 0.009
    path = [c + Vector((rb * math.sin(t), 0.004, rz * math.cos(t))) for t in [-1.42 + 2.84 * i / 24 for i in range(25)]]
    bm = bmesh.new()
    add_tube(bm, path, 0.0045, rseg=12)
    obj_from_bm(m.name + ' headband', bm, M['slate'], sharp_angle=0, parent=m.squash, model=False)
    for s in (-1, 1):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=32, radius1=0.021, radius2=0.021,
                              depth=0.016, matrix=L.R(math.pi / 2, 'Y'))
        o = obj_from_bm(m.name + ' ear cup', bm, M['teal_glaze'], sharp_angle=30, parent=m.squash, model=False)
        o.location = c + Vector((s * (r + 0.004), 0.004, 0.012))
        b = o.modifiers.new('Bevel', 'BEVEL')
        b.width, b.segments, b.limit_method = 0.004, 3, 'ANGLE'


def cast(who):
    if who == 'mochi':
        return Mascot('Mochi', M['white_folk'], (0, 0, 0), FACE)
    if who == 'pudding':
        return Mascot('Pudding', M['mustard_folk'], (0, 0, 0), FACE, antenna=True)
    m = Mascot('Reviewer', M['mustard_folk'], (0, 0, 0), FACE)
    headphones(m)
    return m


# ---------- the moves, each from rest to rest; (name, seconds, keys(m, t0)) ----------
def breathe(m, t0, dur, blink_at=None):
    for i in range(int(dur)):
        key(m.squash, 'scale', t0 + i + 0.5, (1.012, 1.012, 0.985))
        key(m.squash, 'scale', t0 + i + 1.0, (1, 1, 1))
    if blink_at is not None:
        m.blink(t0 + blink_at)


def hop(m, t0):
    m.hop(t0 + 0.08, m.pos.copy(), height=0.06, dur=0.36)


def cheer(m, t0):
    m.cheer(t0, t0 + 1.3)
    m.hop(t0 + 0.1, m.pos.copy(), height=0.05, dur=0.32)
    m.hop(t0 + 0.62, m.pos.copy(), height=0.05, dur=0.32)
    key(m.smile, 'hide_render', t0, False)
    key(m.mouth, 'hide_render', t0, True)
    key(m.smile, 'hide_render', t0 + 0.15, True)
    key(m.mouth, 'hide_render', t0 + 0.15, False)
    key(m.smile, 'hide_render', t0 + 1.2, False)
    key(m.mouth, 'hide_render', t0 + 1.2, True)


def point(m, t0):
    """One arm reaches forward and presses, as on a button in front of it."""
    sh = m.shoulders['r']
    key(sh, 'rotation_euler', t0, (0, 0, 0))
    key(sh, 'rotation_euler', t0 + 0.2, (-1.45, -0.35, 0))
    key(sh, 'rotation_euler', t0 + 0.32, (-1.2, -0.35, 0))
    key(sh, 'rotation_euler', t0 + 0.4, (-1.45, -0.35, 0))
    key(sh, 'rotation_euler', t0 + 0.7, (0, 0, 0))
    key(m.squash, 'scale', t0 + 0.3, (1.03, 1.03, 0.96))
    key(m.squash, 'scale', t0 + 0.45, (1, 1, 1))


def ask(m, t0):
    """Stops, raises a hand and says so: a wave with an open mouth and a small hop."""
    m.hop(t0, m.pos.copy(), height=0.03, dur=0.26)
    m.wave(t0 + 0.2, t0 + 1.3, side='r')
    m.talk(t0 + 0.3, t0 + 1.0, step=0.16)


def slump(m, t0):
    """Sent back: sinks, eyes shut, then straightens up to go again."""
    key(m.squash, 'scale', t0, (1, 1, 1))
    key(m.squash, 'scale', t0 + 0.2, (1.12, 1.12, 0.8))
    for e in m.eyes:
        key(e, 'scale', t0, (1, 1, 1))
        key(e, 'scale', t0 + 0.12, (1, 1, 0.12))
        key(e, 'scale', t0 + 0.5, (1, 1, 0.12))
        key(e, 'scale', t0 + 0.6, (1, 1, 1))
    for side, sign in (('l', 1), ('r', -1)):
        key(m.shoulders[side], 'rotation_euler', t0, (0, 0, 0))
        key(m.shoulders[side], 'rotation_euler', t0 + 0.2, (0.3, sign * 0.25, 0))
        key(m.shoulders[side], 'rotation_euler', t0 + 0.75, (0, 0, 0))
    key(m.squash, 'scale', t0 + 0.55, (1.12, 1.12, 0.8))
    key(m.squash, 'scale', t0 + 0.7, (0.95, 0.95, 1.08))
    key(m.squash, 'scale', t0 + 0.85, (1, 1, 1))


def present(m, t0):
    """Both arms forward and up, as if handing something over, then back."""
    for side, sign in (('l', 1), ('r', -1)):
        sh = m.shoulders[side]
        key(sh, 'rotation_euler', t0, (0, 0, 0))
        key(sh, 'rotation_euler', t0 + 0.25, (-1.35, sign * 0.5, 0))
        key(sh, 'rotation_euler', t0 + 0.65, (-1.35, sign * 0.5, 0))
        key(sh, 'rotation_euler', t0 + 0.9, (0, 0, 0))
    key(m.squash, 'scale', t0 + 0.25, (0.97, 0.97, 1.04))
    key(m.squash, 'scale', t0 + 0.5, (1, 1, 1))


def inspect(m, t0):
    """Leans in to look closely, head tilted, then sits back."""
    key(m.squash, 'rotation_euler', t0, (0, 0, 0))
    key(m.squash, 'rotation_euler', t0 + 0.3, (0.22, -0.12, 0))
    key(m.squash, 'rotation_euler', t0 + 0.9, (0.24, 0.1, 0))
    key(m.squash, 'rotation_euler', t0 + 1.4, (0, 0, 0))
    m.blink(t0 + 0.75)


def work(m, t0):
    m.type(t0, t0 + 2.0)
    m.think(t0, t0 + 2.0)


CLIPS = {
    'idle': (2.0, lambda m, t: breathe(m, t, 2, blink_at=1.3)),
    'hop': (0.7, hop),
    'cheer': (1.4, cheer),
    'nod': (0.8, lambda m, t: m.nod(t + 0.05, 2, 0.32)),
    'talk': (1.0, lambda m, t: m.talk(t + 0.05, t + 0.95)),
    'wave': (1.3, lambda m, t: m.wave(t, t + 1.3, side='r')),
    'type': (1.4, lambda m, t: m.type(t, t + 1.4)),
    'point': (0.75, point),
    'think': (2.0, lambda m, t: m.think(t, t + 2.0)),
    'work': (2.0, work),
    'ask': (1.4, ask),
    'slump': (0.9, slump),
    'present': (0.95, present),
    'inspect': (1.5, inspect),
}
MOVES = {
    'mochi': ['idle', 'hop', 'cheer', 'nod', 'talk', 'wave', 'type', 'point'],
    'pudding': ['idle', 'hop', 'cheer', 'nod', 'talk', 'think', 'work', 'ask', 'slump', 'present'],
    'reviewer': ['idle', 'hop', 'cheer', 'nod', 'inspect', 'think'],
}

# ---------- light, world, camera: the mascot film's daylight ----------
def look_at(o, target):
    t = L.empty(o.name + ' target', target, model=False)
    c = o.constraints.new('TRACK_TO')
    c.target, c.track_axis, c.up_axis = t, 'TRACK_NEGATIVE_Z', 'UP_Y'


def area(name, loc, target, energy, size, color):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy, ld.size, ld.color = energy, size, color
    o = bpy.data.objects.new(name, ld)
    L.col.objects.link(o)
    o.location = loc
    look_at(o, target)


area('Key', (-2.2, -1.8, 3.2), (0, 0, 0.1), 700, 2.5, (1.0, 0.95, 0.88))
area('Fill', (2.8, -2.4, 1.8), (0, 0, 0.1), 180, 3.0, (0.9, 0.95, 1.0))
area('Rim', (0.5, 1.4, 3.6), (0, 0, 0.1), 320, 2.0, (1.0, 0.97, 0.92))
world = bpy.data.worlds.new('World')
scene.world = world
if world.node_tree is None:
    world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
exr = L.glob.glob(os.path.join(os.path.dirname(bpy.app.binary_path), '..', 'Resources', '*', 'datafiles',
                               'studiolights', 'world', 'studio.exr'))
if exr:
    env = world.node_tree.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(exr[0])
    world.node_tree.links.new(env.outputs['Color'], bg.inputs['Color'])
bg.inputs['Strength'].default_value = 0.35

# Orthographic, a little above eye level: every sprite of every move is framed alike, the feet at a fixed
# row (FEET_Y in sprites.json), so film.js stands a sprite on a line by its feet.
cam_data = bpy.data.cameras.new('Camera')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 0.34
cam = bpy.data.objects.new('Camera', cam_data)
L.col.objects.link(cam)
cam.location = (0, -2.0, 0.62)
look_at(cam, (0, 0, 0.13))
scene.camera = cam

r = scene.render
size = int(arg('--size', '720'))
r.resolution_x = r.resolution_y = size
r.resolution_percentage = 100
r.fps = FPS
r.film_transparent = True
r.use_motion_blur = False
for name in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
    try:
        r.engine = name
        break
    except TypeError:
        pass
for attr, value in (('taa_render_samples', int(arg('--samples', '32'))), ('use_raytracing', True),
                    ('use_shadows', True), ('use_fast_gi', True)):
    try:
        setattr(scene.eevee, attr, value)
    except Exception:
        pass
scene.view_settings.view_transform = 'AgX'
for look in ('Punchy', 'AgX - Punchy'):
    try:
        scene.view_settings.look = look
        break
    except TypeError:
        pass
scene.view_settings.exposure = -0.1
r.image_settings.file_format = 'PNG'
r.image_settings.color_mode = 'RGBA'


def feet_row():
    """Where the ground under a mascot lands in the frame, from the top, as a fraction of the height."""
    from bpy_extras.object_utils import world_to_camera_view
    bpy.context.view_layer.update()
    v = world_to_camera_view(scene, cam, Vector((0, 0, 0)))
    return round(1 - v.y, 4)


# ---------- lay the moves out on one timeline, a second of rest between them ----------
cast_objs = {}
plan = {}
for who in WHO:
    m = cast(who)
    cast_objs[who] = m
    t = 0.5
    plan[who] = {}
    for clip in MOVES[who]:
        dur, fn = CLIPS[clip]
        m.rest(t - 0.2)
        fn(m, t)
        m.rest(t + dur)
        plan[who][clip] = (frame(t), frame(t + dur))
        t += dur + 1.0
# Only one mascot renders at a time; the others are hidden from the render.
def show_only(who):
    for name, m in cast_objs.items():
        for o in [m.root] + list(m.root.children_recursive):
            o.hide_render = name != who

meta_path = os.path.join(OUT, 'sprites.json')
meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
meta['fps'], meta['size'], meta['feetY'] = FPS, size, feet_row()

if '--still' in argv:
    who, clip, f = arg('--still', 'pudding:idle:1').split(':')
    show_only(who)
    a, _ = plan[who][clip]
    scene.frame_set(a + int(f) - 1)
    r.filepath = os.path.join(OUT, f'still-{who}-{clip}-{f}.png')
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'still {r.filepath} in {time.time() - t0:.1f}s; feet at {meta["feetY"]}')
    sys.exit(0)

for who in WHO:
    show_only(who)
    meta.setdefault(who, {})
    for clip, (a, b) in plan[who].items():
        d = os.path.join(OUT, who, clip)
        os.makedirs(d, exist_ok=True)
        t0 = time.time()
        for i, f in enumerate(range(a, b + 1)):
            scene.frame_set(f)
            r.filepath = os.path.join(d, f'{i + 1:04d}.png')
            bpy.ops.render.render(write_still=True)
        meta[who][clip] = b - a + 1
        print(f'{who}/{clip}: {b - a + 1} frames in {time.time() - t0:.1f}s', flush=True)
        json.dump(meta, open(meta_path, 'w'), indent=1)
