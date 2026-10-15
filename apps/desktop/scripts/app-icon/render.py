"""Mochi and Pudding for the app icon: the film's rigs standing side by side, rendered on a transparent
ground with their contact shadow, for compose.py to place on the icon's tile.

Run (Blender 5.2): blender -b --python render.py -- OUT.png [--res 1600] [--samples 256]
"""
import math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', '..', 'landing', 'scripts', 'mascot'))

import bpy  # noqa: E402
import scene_lib as L  # noqa: E402  (resets to an empty scene and builds the materials)
from rig import Mascot  # noqa: E402
from scene_lib import M  # noqa: E402

# AgX pulls the film's mustard toward tan on the teal tile; the icon takes a deeper one so Pudding
# reads as the mark's mustard at Dock size.
L.principled(M['mustard_folk']).inputs['Base Color'].default_value = L.hexcol('#f5aa00')

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
out = argv[0] if argv else os.path.join(HERE, 'mascots.png')
arg = lambda k, d: argv[argv.index(k) + 1] if k in argv else d
scene = L.scene

# Mochi (white, you) on the left, Pudding (mustard, your Bot) a step in front and to the right, as in the
# mark: the two overlap a little and turn toward each other.
mochi = Mascot('Mochi', M['white_folk'], (-0.078, 0.03, 0), math.radians(-14))
pudding = Mascot('Pudding', M['mustard_folk'], (0.07, -0.025, 0), math.radians(12), antenna=True)
for o in bpy.data.objects:
    o.animation_data_clear()
for m in (mochi, pudding):
    m.root.location = m.pos
    m.root.rotation_euler = (0, 0, m.rz)
    m.smile.hide_render = False
    m.mouth.hide_render = True
# Pudding waves; Mochi's near arm rests on Pudding's shoulder side, the far one hangs.
pudding.shoulders['r'].rotation_euler = (0, -2.45, 0)
mochi.shoulders['r'].rotation_euler = (-0.25, -0.55, 0)

# A shadow catcher under their feet: only the contact shadow survives on the transparent film.
ground = L.box('Ground', (2, 2, 0.01), (0, 0, -0.005), M['backdrop'])
ground.is_shadow_catcher = True


def look_at(o, target):
    t = L.empty(o.name + ' target', target, model=False)
    c = o.constraints.new('TRACK_TO')
    c.target, c.track_axis, c.up_axis = t, 'TRACK_NEGATIVE_Z', 'UP_Y'


def area(name, loc, target, energy, size, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy, ld.size, ld.color = energy, size, color
    o = bpy.data.objects.new(name, ld)
    L.col.objects.link(o)
    o.location = loc
    look_at(o, target)


area('Key', (-0.9, -1.1, 1.4), (0, 0, 0.1), 115, 0.9, (1.0, 0.95, 0.88))
area('Fill', (1.1, -0.9, 0.5), (0, 0, 0.1), 45, 1.2, (0.88, 0.95, 1.0))
area('Rim', (0.3, 0.9, 1.1), (0, 0, 0.12), 120, 0.7, (0.85, 0.97, 1.0))

world = bpy.data.worlds.new('World')
scene.world = world
world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
bg.inputs['Color'].default_value = L.hexcol('#9fd0da')
bg.inputs['Strength'].default_value = 0.35

cam_data = bpy.data.cameras.new('Camera')
cam_data.lens = 85
cam = bpy.data.objects.new('Camera', cam_data)
L.col.objects.link(cam)
cam.location = (0, -1.25, 0.3)
look_at(cam, (0, 0, 0.105))
scene.camera = cam

res = int(arg('--res', '1600'))
scene.render.resolution_x = scene.render.resolution_y = res
scene.render.film_transparent = True
scene.render.engine = 'CYCLES'
scene.cycles.samples = int(arg('--samples', '256'))
scene.cycles.use_denoising = True
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = 'GPU'
except Exception as e:  # CPU still renders, only slower
    print('GPU unavailable:', e)
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Punchy'
scene.view_settings.exposure = -0.5
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
print('wrote', out)
