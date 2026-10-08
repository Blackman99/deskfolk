"""The mascot film: Mochi and Pudding on the desk, animated from beats.py, rendered with Blender 5.2.

Run: Blender -b --factory-startup --python scene.py -- OUT_DIR [--test] [--range 1-900]
     [--res 100] [--engine eevee|cycles] [--samples 64] [--still SECONDS]
"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[sys.argv.index('--python') + 1])))
import bpy
from mathutils import Vector
import scene_lib as L
from scene_lib import M, DESK_TOP
from rig import FPS, Mascot, frame, key

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default
OUT = os.path.abspath(argv[0] if argv else 'frames')
os.makedirs(OUT, exist_ok=True)
scene = L.scene

# ---------- set ----------
L.build_backdrop()
L.build_desk()
L.build_laptop((-0.04, 0.06, DESK_TOP), 0.0)
L.build_mug((-0.52, -0.2, DESK_TOP), math.radians(-25))
L.build_plant((0.62, 0.28, DESK_TOP))
books = L.empty('Books', (0.55, 0.05, DESK_TOP), model=False)
L.build_book('Book A', (0, 0, 0.016), (0.24, 0.17, 0.032), M['teal_glaze'], 0.05, books)
L.build_book('Book B', (0.005, 0.0, 0.032 + 0.014), (0.22, 0.16, 0.028), M['cream'], -0.08, books)
L.build_book('Book C', (-0.004, 0.003, 0.06 + 0.013), (0.2, 0.15, 0.026), M['coral'], 0.12, books)
BOOKS_TOP = DESK_TOP + 0.086

mochi = Mascot('Mochi', M['white_folk'], (-0.34, -0.15, DESK_TOP), math.radians(28))
pudding = Mascot('Pudding', M['mustard_folk'], (0.55, 0.05, BOOKS_TOP), math.radians(22), antenna=True)

# ---------- light, world, camera ----------
def look_at(o, target):
    t = L.empty(o.name + ' target', target, model=False)
    c = o.constraints.new('TRACK_TO')
    c.target, c.track_axis, c.up_axis = t, 'TRACK_NEGATIVE_Z', 'UP_Y'
    return t

def area(name, loc, target, energy, size, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy, ld.size, ld.color = energy, size, color
    o = bpy.data.objects.new(name, ld)
    L.col.objects.link(o)
    o.location = loc
    look_at(o, target)
    return o

KEY = area('Key', (-2.2, -1.8, 3.2), (0, 0, 0.8), 700, 2.5, (1.0, 0.95, 0.88))
FILL = area('Fill', (2.8, -2.4, 1.8), (0, 0, 0.8), 180, 3.0, (0.9, 0.95, 1.0))
RIM = area('Rim', (0.5, 1.4, 3.6), (0, 0, 0.8), 320, 2.0, (1.0, 0.97, 0.92))
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

cam_data = bpy.data.cameras.new('Camera')
cam_data.lens = 40
cam = bpy.data.objects.new('Camera', cam_data)
L.col.objects.link(cam)
cam_target = L.empty('Camera target', (0, 0, 0.85), model=False)
c = cam.constraints.new('TRACK_TO')
c.target, c.track_axis, c.up_axis = cam_target, 'TRACK_NEGATIVE_Z', 'UP_Y'
scene.camera = cam

LAST = {}

def shot(t, loc, target, lens=None, cut=False):
    """A camera key; with `cut`, the shot before holds to the frame before `t`, so the change is a cut."""
    if cut and LAST:
        shot(t - 1 / FPS, LAST['loc'], LAST['target'], LAST['lens'])
    key(cam, 'location', t, Vector(loc))
    key(cam_target, 'location', t, Vector(target))
    if lens:
        cam_data.lens = lens
        cam_data.keyframe_insert('lens', frame=frame(t))
    LAST.update(loc=loc, target=target, lens=lens or cam_data.lens)

LIGHTS = {
    'day': {'Key': (700, (1.0, 0.95, 0.88)), 'Fill': (180, (0.9, 0.95, 1.0)), 'Rim': (320, (1.0, 0.97, 0.92)), 'world': 0.35},
    'evening': {'Key': (260, (1.0, 0.66, 0.42)), 'Fill': (70, (0.62, 0.72, 1.0)), 'Rim': (130, (1.0, 0.72, 0.5)), 'world': 0.12},
}

def daylight(t, mode):
    for light in (KEY, FILL, RIM):
        energy, color = LIGHTS[mode][light.name]
        light.data.energy, light.data.color = energy, color
        light.data.keyframe_insert('energy', frame=frame(t))
        light.data.keyframe_insert('color', frame=frame(t))
    bg.inputs['Strength'].default_value = LIGHTS[mode]['world']
    bg.inputs['Strength'].keyframe_insert('default_value', frame=frame(t))

# ---------- the timeline ----------
if '--test' in argv:
    shot(0, (1.05, -1.75, 1.2), (0.05, -0.02, 0.86), 40)
    shot(2.5, (0.95, -1.6, 1.15), (0.08, -0.04, 0.86), 40)
    t = pudding.hop(0.3, (0.3, -0.14, DESK_TOP), height=0.12, dur=0.5)
    pudding.turn(0.8, math.radians(-30))
    pudding.type(1.0, 2.4)
    pudding.think(1.0, 2.4)
    mochi.wave(0.2, 1.6, side='l')
    mochi.talk(0.4, 1.0)
    mochi.blink(1.9)
    END = 2.5
else:
    import beats, props
    from types import SimpleNamespace
    daylight(0, 'day')
    END = beats.apply(SimpleNamespace(mochi=mochi, pudding=pudding, key=key, shot=shot, props=props, M=M,
                                      daylight=daylight))
    # where the name tags go: the top of each head on screen, per frame, while S1 introduces them
    import json
    from bpy_extras.object_utils import world_to_camera_view
    anchors = {}
    a, b = (frame(t) for t in beats.NAMES)
    for f in range(a, b + 1):
        scene.frame_set(f)
        spots = {}
        for who in (mochi, pudding):
            head = who.root.matrix_world @ Vector((0, 0, 0.215))
            v = world_to_camera_view(scene, cam, head)
            spots[who.name] = [round(v.x, 4), round(1 - v.y, 4)]
        anchors[f] = spots
    json.dump(anchors, open(os.path.join(OUT, 'anchors.json'), 'w'))

# ---------- render ----------
r = scene.render
r.resolution_x, r.resolution_y = 1920, 1080
r.resolution_percentage = int(arg('--res', '100'))
r.fps = FPS
r.use_motion_blur = False
scene.frame_start, scene.frame_end = 1, frame(END)
engine = arg('--engine', 'eevee')
if engine == 'cycles':
    r.engine = 'CYCLES'
    scene.cycles.samples = int(arg('--samples', '64'))
    scene.cycles.use_denoising = True
    scene.cycles.seed = 7
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.refresh_devices()
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = 'GPU'
    except Exception as e:
        print('GPU setup failed:', e)
else:
    for name in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
        try:
            r.engine = name
            break
        except TypeError:
            pass
    ee = scene.eevee
    for attr, value in (('taa_render_samples', int(arg('--samples', '64'))), ('use_raytracing', True),
                        ('use_shadows', True), ('shadow_ray_count', 2), ('shadow_step_count', 8),
                        ('use_fast_gi', True)):
        try:
            setattr(ee, attr, value)
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

if '--still' in argv:
    t = float(arg('--still', '0'))
    scene.frame_set(frame(t))
    r.filepath = os.path.join(OUT, f'still-{t:05.2f}.png')
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'rendered still {t} with {r.engine} in {time.time() - t0:.1f}s')
else:
    a, b = (int(x) for x in arg('--range', f'1-{frame(END)}').split('-'))
    scene.frame_start, scene.frame_end = a, b
    r.filepath = os.path.join(OUT, 'f')
    t0 = time.time()
    bpy.ops.render.render(animation=True)
    print(f'rendered frames {a}-{b} with {r.engine} in {time.time() - t0:.1f}s')
