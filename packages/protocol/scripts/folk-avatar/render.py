"""Render the layers of the folk avatar: the mustard teammate from the Deskfolk mark, in 3D.

Each layer is a transparent 512 px PNG of one part, framed identically, so src/folk-avatar.ts can
stack any body, arms, eyes, mouth and accessory into one avatar, and the messenger can move the
parts on their own (arms turn about the shoulders written to meta.json). Parts that sit on the
body are rendered with the body as a holdout, so the body hides whatever is behind it. The ground
shadow is not a layer: the messenger draws it, so a hopping folk leaves it on the ground.

Run with Blender 5.2 (headless):
  Blender -b --factory-startup --python render.py -- OUT_DIR
then `python3 build.py OUT_DIR` writes src/folk-avatar-assets.ts.
"""
import bpy, bmesh, math, os, sys, glob, json
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else 'folk-layers')
os.makedirs(OUT, exist_ok=True)

MUSTARD = '#f0ab3d'
# A shade more orange than the mark's mustard: soft light washes a sphere toward yellow, and this
# brings the rendered body's average back to the mark's colour.
BODY = '#ef9f2c'
TEAL = '#146a7c'
FRAME = 0.225   # orthographic frame width, metres; the body is 0.19 tall
CENTER_Z = 0.11
EXPOSURE = float(os.environ.get('FOLK_EXPOSURE', '-2.55'))  # Standard view transform keeps the brand colours as authored


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def hexcol(h):
    h = h.lstrip('#')
    return tuple(lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)

def mat(name, color, rough=0.5, emit=None, emit_strength=1.0, coat=0.0):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value = hexcol(color)
    p.inputs['Roughness'].default_value = rough
    if emit:
        p.inputs['Base Color'].default_value = (0, 0, 0, 1)
        p.inputs['Emission Color'].default_value = hexcol(emit)
        p.inputs['Emission Strength'].default_value = emit_strength
    if coat:
        p.inputs['Coat Weight'].default_value = coat
    return m


def T(x=0, y=0, z=0):
    return Matrix.Translation((x, y, z))

def S(x, y, z):
    return Matrix.Diagonal((x, y, z, 1))

def R(angle, axis):
    return Matrix.Rotation(angle, 4, axis)


class Folk:
    """Builds one folk; every object is tagged with the layer it belongs to."""

    def __init__(self):
        self.objects = []  # (object, layer)
        self.M = {
            'body': mat('Body', os.environ.get('FOLK_BODY', BODY), rough=0.45),
            'eye': mat('Eye', '#14171a', rough=0.12, coat=0.6),
            'glint': mat('Glint', '#000000', emit='#ffffff', emit_strength=8.0),
            'cheek': mat('Cheek', '#f3a59a', rough=0.6),
            'mouth': mat('Mouth', '#5a2a24', rough=0.4),
            'leaf': mat('Leaf', '#3f7f52', rough=0.45),
            'leaf2': mat('Leaf light', '#5d9a5f', rough=0.45),
            'graphite': mat('Graphite', '#2a2a2a', rough=0.5),
            'teal': mat('Teal glaze', TEAL, rough=0.25, coat=0.2),
            'coral': mat('Coral', '#d8705c', rough=0.55),
            'slate': mat('Slate', '#43535a', rough=0.55),
        }
        self.r, self.sz = 0.085, 1.12
        self.zmin = -self.r * self.sz * 0.88
        self.c = Vector((0, 0, -self.zmin))

    def add(self, name, bm, material, layer, smooth=True, loc=(0, 0, 0), quat=None, rot=None):
        bm.normal_update()
        for f in bm.faces:
            f.smooth = smooth
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(material)
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        o.location = loc
        if quat is not None:
            o.rotation_mode = 'QUATERNION'
            o.rotation_quaternion = quat
        elif rot is not None:
            o.rotation_euler = rot
        self.objects.append((o, layer))
        return o

    def sphere(self, name, r, loc, material, layer, scale=(1, 1, 1), quat=None, rot=None):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=r, matrix=S(*scale))
        return self.add(name, bm, material, layer, loc=loc, quat=quat, rot=rot)

    def tube(self, name, path, radius, material, layer):
        bm = bmesh.new()
        rings, a_prev, n = [], None, len(path)
        for i, p in enumerate(path):
            t = (path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized()
            if a_prev is None:
                up = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
                a = t.cross(up).normalized()
            else:
                a = (a_prev - t * a_prev.dot(t)).normalized()
            b = t.cross(a)
            a_prev = a
            rings.append([bm.verts.new(p + radius * (math.cos(2 * math.pi * k / 10) * a +
                                                     math.sin(2 * math.pi * k / 10) * b)) for k in range(10)])
        faces = []
        for i in range(n - 1):
            r0, r1 = rings[i], rings[i + 1]
            for k in range(10):
                faces.append(bm.faces.new([r0[k], r0[(k + 1) % 10], r1[(k + 1) % 10], r1[k]]))
        faces.append(bm.faces.new(rings[0][::-1]))
        faces.append(bm.faces.new(rings[-1]))
        bmesh.ops.recalc_face_normals(bm, faces=faces)
        return self.add(name, bm, material, layer)

    def surface_point(self, direction):
        r, sz, c = self.r, self.sz, self.c
        d = direction.normalized()
        t = 1.0 / math.sqrt((d.x / r) ** 2 + (d.y / r) ** 2 + (d.z / (r * sz)) ** 2)
        p = c + d * t
        rel = p - c
        n = Vector((rel.x / r ** 2, rel.y / r ** 2, rel.z / (r * sz) ** 2)).normalized()
        return p, n

    @staticmethod
    def dir(az, el):
        return Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))

    def surface_tube(self, name, points, radius, layer):
        path = []
        for target in points:
            p, n = self.surface_point(target - self.c)
            path.append(p - n * 0.0006)
        return self.tube(name, path, radius, self.M['eye'], layer)

    @staticmethod
    def arc(base, X, Z, rx, rz, t0, t1, up, n=13):
        out = []
        for i in range(n):
            t = t0 + (t1 - t0) * i / (n - 1)
            dz = (rz * math.cos(t) - rz * 0.55) if up else (-rz * math.cos(t) + rz * 0.55)
            out.append(base + X * (rx * math.sin(t)) + Z * dz)
        return out

    def body(self):
        M, r, sz, c = self.M, self.r, self.sz, self.c
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=r, matrix=S(1, 1, sz))
        for v in bm.verts:
            v.co.z = max(v.co.z, self.zmin) - self.zmin
        self.add('Body', bm, M['body'], 'body')
        for s in (-1, 1):
            p, n = self.surface_point(self.dir(s * 0.58, 0.02))
            self.sphere('Cheek', 0.015, p - n * 0.0025, M['cheek'], 'body', scale=(1, 0.25, 0.62),
                        quat=n.to_track_quat('-Y', 'Z'))
            self.sphere('Foot', 0.024, Vector((s * 0.034, -0.045, 0.011)), M['body'], 'body',
                        scale=(1.05, 1.35, 0.55))

    def shoulder(self, s):
        return self.surface_point(self.dir(s * 1.42, -0.06))

    def arm(self, s, layer):
        """A stubby arm hanging close to the body, from the shoulder at side s (+1 is image right)."""
        p, n = self.shoulder(s)
        d = Vector((s * 0.3, -0.2, -1.0)).normalized()
        self.sphere('Arm', 0.021, p - n * 0.006 + d * 0.024, self.M['body'], layer, scale=(1, 1, 1.75),
                    quat=d.to_track_quat('Z', 'Y'))

    def eyes(self, style):
        up = Vector((0, 0, 1))
        for s in (-1, 1):
            az = s * 0.3
            kind = style if style != 'wink' else ('dot' if s == -1 else 'happy')
            p, n = self.surface_point(self.dir(az, 0.2))
            if kind == 'closed':
                X = Vector((math.cos(az), math.sin(az), 0))
                self.surface_tube('Eye', self.arc(p - up * 0.003, X, up, 0.0095, 0.0055, -1.2, 1.2, False), 0.0024, 'part')
                continue
            if kind == 'dot':
                self.sphere('Eye', 0.0115, p - n * 0.004, self.M['eye'], 'part', scale=(1, 0.55, 1.2),
                            quat=n.to_track_quat('-Y', 'Z'))
                g = p + n * 0.0025 + Vector((-0.003, 0, 0.005))
                self.sphere('Glint', 0.0028, g, self.M['glint'], 'part')
            else:
                X = Vector((math.cos(az), math.sin(az), 0))
                self.surface_tube('Eye', self.arc(p, X, up, 0.0105, 0.0085, -1.25, 1.25, True), 0.0026, 'part')

    def mouth(self, style):
        up, X = Vector((0, 0, 1)), Vector((1, 0, 0))
        base, _ = self.surface_point(self.dir(0, 0.05))
        if style == 'smile':
            self.surface_tube('Smile', self.arc(base, X, up, 0.011, 0.011, -0.95, 0.95, False), 0.0021, 'part')
        elif style == 'cat':
            for s in (-1, 1):
                self.surface_tube('Mouth', self.arc(base + X * (s * 0.0062), X, up, 0.0062, 0.0062,
                                                    -1.35, 1.35, False), 0.0019, 'part')
        elif style == 'open':
            p, n = self.surface_point(self.dir(0, -0.02))
            self.sphere('Mouth', 0.0085, p - n * 0.003, self.M['mouth'], 'part', scale=(1.0, 0.45, 0.85),
                        quat=n.to_track_quat('-Y', 'Z'))

    def accessory(self, kind):
        M, r, sz, c = self.M, self.r, self.sz, self.c
        top = c + Vector((0, 0, r * sz))
        if kind == 'sprout':
            path = [top + Vector((0.004 * math.sin(i / 8 * 1.6), 0, -0.004 + 0.03 * i / 8)) for i in range(9)]
            self.tube('Stem', path, 0.0028, M['leaf'], 'part')
            for s in (-1, 1):
                self.sphere('Sprout leaf', 0.016, path[-1] + Vector((s * 0.013, 0, 0.004)), M['leaf2'], 'part',
                            scale=(1.0, 0.32, 0.55), rot=(0, -s * 0.55, 0))
        elif kind == 'antenna':
            path = [top + Vector((0.006 * (i / 8) ** 2, 0, -0.004 + 0.03 * i / 8)) for i in range(9)]
            self.tube('Antenna', path, 0.0022, M['graphite'], 'part')
            self.sphere('Antenna ball', 0.0095, path[-1] + Vector((0, 0, 0.006)), M['teal'], 'part')
        elif kind == 'bow':
            p, n = self.surface_point(self.dir(0.55, 0.95))
            q = n.to_track_quat('Z', 'Y')
            X = q @ Vector((1, 0, 0))
            for s in (-1, 1):
                self.sphere('Bow wing', 0.013, p + X * (s * 0.014) + n * 0.004, M['coral'], 'part',
                            scale=(1.35, 0.7, 0.85), quat=q)
            self.sphere('Bow knot', 0.0065, p + n * 0.006, M['coral'], 'part')
        elif kind == 'headphones':
            rb, rz = r + 0.009, r * sz + 0.009
            path = [c + Vector((rb * math.sin(t), 0.004, rz * math.cos(t)))
                    for t in [-1.42 + 2.84 * i / 24 for i in range(25)]]
            self.tube('Headband', path, 0.0045, M['slate'], 'part')
            for s in (-1, 1):
                bm = bmesh.new()
                bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=32, radius1=0.021,
                                      radius2=0.021, depth=0.016, matrix=R(math.pi / 2, 'Y'))
                o = self.add('Ear cup', bm, M['teal'], 'part', loc=c + Vector((s * (r + 0.004), 0.004, 0.012)))
                b = o.modifiers.new('Bevel', 'BEVEL')
                b.width, b.segments, b.limit_method = 0.004, 3, 'ANGLE'
                b.harden_normals = True


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    col = scene.collection

    def look_at(o, target):
        t = bpy.data.objects.new(o.name + ' target', None)
        col.objects.link(t)
        t.location = target
        c = o.constraints.new('TRACK_TO')
        c.target, c.track_axis, c.up_axis = t, 'TRACK_NEGATIVE_Z', 'UP_Y'

    for name, loc, energy, size, color in [
        ('Key', (-0.6, -1.2, 0.9), 100, 0.9, (1.0, 0.96, 0.9)),
        ('Fill', (1.0, -1.0, 0.35), float(os.environ.get('FOLK_FILL', '70')), 1.0, (0.92, 0.96, 1.0)),
        ('Rim', (0.3, 1.0, 0.9), 60, 0.8, (1, 1, 1)),
    ]:
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy, ld.size, ld.color = energy, size, color
        o = bpy.data.objects.new(name, ld)
        col.objects.link(o)
        o.location = loc
        look_at(o, (0, 0, CENTER_Z))

    world = bpy.data.worlds.new('World')
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    exr = glob.glob(os.path.join(os.path.dirname(bpy.app.binary_path), '..', 'Resources', '*', 'datafiles',
                                 'studiolights', 'world', 'studio.exr'))
    if exr:
        env = world.node_tree.nodes.new('ShaderNodeTexEnvironment')
        env.image = bpy.data.images.load(exr[0])
        world.node_tree.links.new(env.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = float(os.environ.get('FOLK_WORLD', '0.9'))

    el = math.radians(8)
    cd = bpy.data.cameras.new('Camera')
    cd.type, cd.ortho_scale = 'ORTHO', FRAME
    cam = bpy.data.objects.new('Camera', cd)
    col.objects.link(cam)
    cam.location = (0, -2 * math.cos(el), CENTER_Z + 2 * math.sin(el))
    look_at(cam, (0, 0, CENTER_Z))
    scene.camera = cam

    r = scene.render
    r.engine = 'CYCLES'
    r.resolution_x = r.resolution_y = 512
    r.film_transparent = True
    r.image_settings.color_mode = 'RGBA'
    scene.cycles.samples = 256
    scene.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.refresh_devices()
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = 'GPU'
    except Exception as e:
        print('GPU setup failed, rendering on CPU:', e)
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.exposure = EXPOSURE
    return scene


def render(name, build, holdout):
    scene = setup_scene()
    folk = Folk()
    build(folk)
    for o, layer in folk.objects:
        o.is_holdout = holdout and layer == 'body'
    scene.render.filepath = os.path.join(OUT, name + '.png')
    bpy.ops.render.render(write_still=True)
    print('rendered', name)


LAYERS = [('body', lambda f: f.body(), False)]
for side, s_ in (('l', -1), ('r', 1)):
    LAYERS.append((f'arm-{side}', lambda f, s_=s_: (f.body(), f.arm(s_, 'part')), True))
for style in ('dot', 'happy', 'wink', 'closed'):
    LAYERS.append((f'eyes-{style}', lambda f, s=style: (f.body(), f.eyes(s)), True))
for style in ('smile', 'open', 'cat'):
    LAYERS.append((f'mouth-{style}', lambda f, s=style: (f.body(), f.mouth(s)), True))
for kind in ('sprout', 'antenna', 'bow', 'headphones'):
    LAYERS.append((f'acc-{kind}', lambda f, k=kind: (f.body(), f.accessory(k)), True))

only = set(argv[1].split(',')) if len(argv) > 1 else None
for name, build, holdout in LAYERS:
    if only is None or name in only:
        render(name, build, holdout)

# Where the animation pivots sit on the image, as fractions from the top-left corner.
scene = setup_scene()
folk = Folk()
cam = scene.camera
bpy.context.view_layer.update()
def at(point):
    v = world_to_camera_view(scene, cam, point)
    return [round(v.x, 4), round(1 - v.y, 4)]
meta = {
    'shoulder_l': at(folk.shoulder(-1)[0]),
    'shoulder_r': at(folk.shoulder(1)[0]),
    'eyes': at(folk.surface_point(folk.dir(0, 0.2))[0]),
    'head_top': at(folk.c + Vector((0, 0, folk.r * folk.sz))),
    'feet': at(Vector((0, 0, 0))),
}
json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), indent=1)
print('meta', meta)
