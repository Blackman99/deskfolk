"""Render the characters of the task map (ADR 0097): Pudding and Mochi's own folk, dressed for work.

Every character is the folk avatar's body (packages/protocol/scripts/folk-avatar/render.py), in a
flavour of its own and with what it wears and holds, seen from the map's camera: 30 degrees above
the ground like the town, turned so a little of its right side shows. Each layer is a transparent
square PNG, framed alike, so the messenger stacks them and moves the arms on their own:

  <id>-body                body, feet, cheeks and what it wears
  <id>-arm-l, <id>-arm-r   an arm (image left, image right) and what that hand holds
  <id>-front               what sits over the face (glasses), for a character that has one
  eyes-*, mouth-*          the face; every body is the same shape, so every character shares it
  pin                      the round pin on its chest; the Bot's avatar goes on its face

Parts that sit on the body are rendered with the body (and what it wears) as a holdout, so it hides
whatever is behind it. meta.json holds the pivots and the pin's face as fractions of the square.

Run with Blender 5.2 (headless):
  Blender -b --factory-startup --python figures.py -- OUT_DIR [layer,...]
then `python3 build.py OUT_DIR` writes src/lib/taskmap/scene/figure-assets.ts.
FIG_SIZE and FIG_SAMPLES (defaults 512 and 256) make quicker drafts; FIG_EL tries another camera height.
"""
import bpy, bmesh, math, os, sys, json
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector, Quaternion

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # importing the folk renderer must not leave a __pycache__ beside it
sys.path.insert(0, os.path.join(HERE, '..', '..', '..', '..', 'packages', 'protocol', 'scripts', 'folk-avatar'))
import render as folk  # noqa: E402  (the folk avatar's renderer: its body, face, lights and camera)

EL = float(os.environ.get('FIG_EL', '30'))  # the town's camera is 30 degrees above the ground (its 2:1 projection)
TURN = -25         # its face to you, a little of its right side showing
FRAME = 0.34       # orthographic frame width, metres; the body is 0.19 tall, the tallest hat 0.3
CENTER_Z = 0.133
SIZE = int(os.environ.get('FIG_SIZE', '512'))
SAMPLES = int(os.environ.get('FIG_SAMPLES', '256'))

up = Vector((0, 0, 1))


def material(name, color, rough=0.5, coat=0.0, metal=0.0, sss=0.0, sheen=0.0, bump=None):
    """A principled material; `bump` is ('knit' | 'fuzz' | 'felt', strength) for a cloth's surface."""
    m = folk.mat(name, color, rough=rough, coat=coat)
    nt = m.node_tree
    p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Metallic'].default_value = metal
    if sss:
        p.inputs['Subsurface Weight'].default_value = sss
        p.inputs['Subsurface Radius'].default_value = (0.02, 0.012, 0.008)
        p.inputs['Subsurface Scale'].default_value = 0.05
    if sheen:
        p.inputs['Sheen Weight'].default_value = sheen
    if bump:
        kind, strength = bump
        coord = nt.nodes.new('ShaderNodeTexCoord')
        if kind == 'knit':
            tex = nt.nodes.new('ShaderNodeTexWave')
            tex.wave_type, tex.bands_direction = 'BANDS', 'X'
            tex.inputs['Scale'].default_value = 180
            tex.inputs['Distortion'].default_value = 1.5
        else:
            tex = nt.nodes.new('ShaderNodeTexNoise')
            tex.inputs['Scale'].default_value = 900 if kind == 'fuzz' else 400
            tex.inputs['Detail'].default_value = 6
        nt.links.new(coord.outputs['Object'], tex.inputs['Vector'])
        b = nt.nodes.new('ShaderNodeBump')
        b.inputs['Strength'].default_value = strength
        b.inputs['Distance'].default_value = 0.002
        nt.links.new(tex.outputs['Fac' if kind != 'knit' else 'Color'], b.inputs['Height'])
        nt.links.new(b.outputs['Normal'], p.inputs['Normal'])
    return m


M = {}


def materials():
    """Made after each scene reset (setup_scene starts from an empty file)."""
    M.clear()
    for key, args in {
        'white_cloth': ('#f8f6f0', dict(rough=0.85, sheen=0.4, bump=('felt', 0.25))),
        'teal': ('#146a7c', dict(rough=0.3, coat=0.2)),
        'teal_knit': ('#1b7486', dict(rough=0.9, sheen=0.5, bump=('knit', 0.5))),
        'mustard_knit': ('#e7a134', dict(rough=0.9, sheen=0.5, bump=('knit', 0.5))),
        'cream_fuzz': ('#f4ede0', dict(rough=1.0, sheen=0.8, bump=('fuzz', 0.9))),
        'coral': ('#d8705c', dict(rough=0.55)),
        'berry_felt': ('#a8364a', dict(rough=0.95, sheen=0.5, bump=('felt', 0.35))),
        'navy_felt': ('#2a3570', dict(rough=0.9, sheen=0.5, bump=('felt', 0.3))),
        'gold': ('#d9a93a', dict(rough=0.3, metal=1.0)),
        'steel': ('#aab1b8', dict(rough=0.28, metal=1.0)),
        'graphite': ('#2a2a2a', dict(rough=0.5)),
        'wood': ('#c08b5a', dict(rough=0.6)),
        'wood_dark': ('#7a5236', dict(rough=0.6)),
        'paper': ('#f6f0e1', dict(rough=0.85)),
        'ink': ('#4a5359', dict(rough=0.7)),
        'hat_yellow': ('#f2bf2f', dict(rough=0.25, coat=0.5)),
        'ceramic': ('#f2efe8', dict(rough=0.2, coat=0.4)),
        'coffee': ('#3a2214', dict(rough=0.08)),
        'pencil': ('#f0b33c', dict(rough=0.45)),
        'eraser': ('#e98b8b', dict(rough=0.7)),
        'book': ('#2f7d6e', dict(rough=0.6)),
        'card': ('#fbfbf8', dict(rough=0.35, coat=0.3)),
        'card_window': ('#e3e9ec', dict(rough=0.5)),
        'paint_teal': ('#1b8a9c', dict(rough=0.15, coat=0.6)),
        'paint_mustard': ('#f0ab3d', dict(rough=0.15, coat=0.6)),
        'paint_coral': ('#e0705c', dict(rough=0.15, coat=0.6)),
        'paint_white': ('#f7f7f2', dict(rough=0.15, coat=0.6)),
    }.items():
        M[key] = material(key, args[0], **args[1])


# ---- Mesh helpers, on a Folk (its add / sphere / tube tag every object with its layer) ----

def mesh(f, name, bm, mat, layer, smooth=True, loc=(0, 0, 0), quat=None, mods=()):
    o = f.add(name, bm, mat, layer, smooth=smooth, loc=loc, quat=quat)
    for kind, opts in mods:
        m = o.modifiers.new(kind, kind)
        for k, v in opts.items():
            setattr(m, k, v)
    return o


def cyl(f, name, r1, r2, depth, loc, mat, layer, quat=None, segs=32, bevel=0.0):
    """A cylinder or cone along its local Z, centred on `loc`."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r1, radius2=r2, depth=depth)
    mods = [('BEVEL', dict(width=bevel, segments=3, limit_method='ANGLE', harden_normals=True))] if bevel else []
    return mesh(f, name, bm, mat, layer, loc=loc, quat=quat, mods=mods)


def box(f, name, size, loc, mat, layer, quat=None, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0, matrix=folk.S(*size))
    mods = [('BEVEL', dict(width=bevel, segments=3, limit_method='ANGLE', harden_normals=True))] if bevel else []
    return mesh(f, name, bm, mat, layer, smooth=False, loc=loc, quat=quat, mods=mods)


def prism(f, name, pts, depth, loc, mat, layer, quat=None, bevel=0.0):
    """A flat 2D outline (local x, y) pushed `depth` along local Z, centred on its plane."""
    bm = bmesh.new()
    front = [bm.verts.new((x, y, depth / 2)) for x, y in pts]
    back = [bm.verts.new((x, y, -depth / 2)) for x, y in pts]
    faces = [bm.faces.new(front), bm.faces.new(back[::-1])]
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        faces.append(bm.faces.new([front[i], back[i], back[j], front[j]]))
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    mods = [('BEVEL', dict(width=bevel, segments=2, limit_method='ANGLE', harden_normals=True))] if bevel else []
    return mesh(f, name, bm, mat, layer, smooth=False, loc=loc, quat=quat, mods=mods)


def dome(f, name, rx, rz, z_cut, loc, mat, layer, thick=0.003, quat=None):
    """The top of an ellipsoid (radius rx, half height rz) above `z_cut` (local), as a shell."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=rx, matrix=folk.S(1, 1, rz / rx))
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < z_cut], context='VERTS')
    return mesh(f, name, bm, mat, layer, loc=loc, quat=quat,
                mods=[('SOLIDIFY', dict(thickness=thick, offset=1.0))])


def ring(center, ax, ay, radius, n=40, closed=True):
    pts = [center + radius * (math.cos(2 * math.pi * k / n) * ax + math.sin(2 * math.pi * k / n) * ay) for k in range(n)]
    return pts + [pts[0], pts[1]] if closed else pts


def star(r_out, r_in, points=5, turn=math.pi / 2):
    out = []
    for k in range(points * 2):
        a = turn + math.pi * k / points
        r = r_out if k % 2 == 0 else r_in
        out.append((r * math.cos(a), r * math.sin(a)))
    return out


def track(direction, up_axis='Y'):
    return Vector(direction).normalized().to_track_quat('Z', up_axis)


# ---- Where things sit on a folk ----

def head_top(f):
    return f.c + Vector((0, 0, f.r * f.sz))


def hand(f, s):
    """The tip of the arm at side s (+1 image right), and the way the arm hangs."""
    p, n = f.shoulder(s)
    d = Vector((s * 0.3, -0.2, -1.0)).normalized()
    return p - n * 0.006 + d * 0.05, d


def ellipse_radius_at(f, z):
    """The body's radius across at height z."""
    t = (z - f.c.z) / (f.r * f.sz)
    return f.r * math.sqrt(max(0.0, 1 - t * t))


# ---- What each character wears (layer 'body') and holds (layer 'part', with its arm) ----

def wear_antenna(f):
    f.accessory('antenna')
    f.objects[-2] = (f.objects[-2][0], 'body')
    f.objects[-1] = (f.objects[-1][0], 'body')


def wear_beanie(f):
    top = head_top(f)
    z0 = f.c.z + f.r * f.sz * 0.5
    dome(f, 'Beanie', f.r + 0.003, f.r * f.sz + 0.004, z0 + 0.012 - f.c.z, f.c, M['mustard_knit'], 'body', thick=0.003)
    zb, zt = z0 - 0.002, z0 + 0.016
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, cap_tris=False, segments=64, radius1=ellipse_radius_at(f, zb) + 0.006,
                          radius2=ellipse_radius_at(f, zt) + 0.006, depth=zt - zb)
    mesh(f, 'Beanie cuff', bm, M['mustard_knit'], 'body', loc=Vector((0, 0, (zb + zt) / 2)),
         mods=[('SOLIDIFY', dict(thickness=0.004, offset=-1.0)), ('BEVEL', dict(width=0.0015, segments=3))])
    f.sphere('Pom', 0.02, top + Vector((0.003, 0, 0.017)), M['cream_fuzz'], 'body', scale=(1, 1, 0.92))


def hold_mug(f, s):
    p, d = hand(f, s)
    at = p + Vector((0, -0.016, 0.006))
    cyl(f, 'Mug', 0.016, 0.0145, 0.03, at, M['teal'], 'part', segs=40, bevel=0.0015)
    cyl(f, 'Coffee', 0.0135, 0.0135, 0.001, at + Vector((0, 0, 0.0135)), M['coffee'], 'part', segs=40)
    f.tube('Mug handle', [at + Vector((s * 0.019, 0, 0)) + 0.008 * Vector((s * math.cos(a), 0, math.sin(a)))
                          for a in [-1.5 + 3.0 * i / 12 for i in range(13)]], 0.0026, M['teal'], 'part')


def wear_headphones(f):
    f.accessory('headphones')
    for i in range(1, 4):
        f.objects[-i] = (f.objects[-i][0], 'body')


def hold_clipboard(f, s):
    p, d = hand(f, s)
    q = track((-s * 0.25, -1, 0.35), 'Y')
    at = p + Vector((s * 0.006, -0.02, 0.016))
    rot = lambda v: q @ Vector(v)
    box(f, 'Board', (0.046, 0.06, 0.003), at, M['wood'], 'part', quat=q, bevel=0.0012)
    box(f, 'Paper', (0.04, 0.05, 0.0008), at + rot((0, -0.003, 0.002)), M['paper'], 'part', quat=q)
    box(f, 'Clip', (0.02, 0.008, 0.004), at + rot((0, 0.027, 0.003)), M['steel'], 'part', quat=q, bevel=0.0012)
    for i, w in enumerate((0.03, 0.026, 0.03, 0.018)):
        box(f, 'Line', (w, 0.0025, 0.0006), at + rot((-0.004 + (0.03 - w) / 2, 0.014 - i * 0.009, 0.0026)), M['ink'], 'part', quat=q)
    box(f, 'Tick', (0.007, 0.0025, 0.0006), at + rot((0.014, 0.014, 0.0027)), M['paint_teal'], 'part', quat=q)


def wear_beret(f):
    top = head_top(f)
    q = Quaternion((0, 1, 0), math.radians(-14)) @ Quaternion((1, 0, 0), math.radians(6))
    f.sphere('Beret', 0.066, top + Vector((-0.012, 0.004, -0.004)), M['berry_felt'], 'body', scale=(1, 1, 0.3), quat=q)
    cyl(f, 'Beret stem', 0.0035, 0.002, 0.012, top + Vector((-0.016, 0.004, 0.017)), M['berry_felt'], 'body', quat=q, segs=12)


def hold_brush(f, s):
    p, d = hand(f, s)
    axis = Vector((s * 0.35, -0.45, 1.0)).normalized()
    q = track(axis, 'Y')
    at = p + Vector((0, -0.01, 0.004))
    cyl(f, 'Brush handle', 0.0032, 0.0042, 0.06, at, M['wood_dark'], 'part', quat=q, segs=16)
    cyl(f, 'Ferrule', 0.0045, 0.0045, 0.009, at + axis * 0.034, M['steel'], 'part', quat=q, segs=16)
    cyl(f, 'Bristles', 0.0046, 0.0012, 0.014, at + axis * 0.045, M['graphite'], 'part', quat=q, segs=16)
    cyl(f, 'Paint tip', 0.0026, 0.0006, 0.006, at + axis * 0.0505, M['paint_teal'], 'part', quat=q, segs=16)


def hold_palette(f, s):
    p, d = hand(f, s)
    q = track((s * 0.15, -1, 0.5), 'Y')
    at = p + Vector((0, -0.02, 0.022))
    outline = [(0.038 * math.cos(a) * (1 + 0.12 * math.cos(2 * a)), 0.028 * math.sin(a)) for a in [2 * math.pi * k / 32 for k in range(32)]]
    prism(f, 'Palette', outline, 0.003, at, M['wood'], 'part', quat=q, bevel=0.001)
    for (x, y), m in zip(((-0.018, 0.01), (0.0, 0.016), (0.018, 0.009), (0.016, -0.01)),
                         ('paint_teal', 'paint_mustard', 'paint_coral', 'paint_white')):
        f.sphere('Dab', 0.006, at + q @ Vector((x, y, 0.0022)), M[m], 'part', scale=(1, 1, 0.45), quat=q)


def wear_toque(f):
    top = head_top(f)
    z = top.z - 0.022
    cyl(f, 'Toque band', ellipse_radius_at(f, z) + 0.004, 0.05, 0.026, Vector((0, 0, z + 0.013)), M['white_cloth'], 'body', segs=48)
    for k in range(6):
        a = 2 * math.pi * k / 6
        f.sphere('Puff', 0.03, Vector((0.026 * math.cos(a), 0.026 * math.sin(a), z + 0.05)), M['white_cloth'], 'body', scale=(1, 1, 0.85))
    f.sphere('Puff top', 0.034, Vector((0, 0, z + 0.06)), M['white_cloth'], 'body', scale=(1, 1, 0.8))


def hold_whisk(f, s):
    p, d = hand(f, s)
    axis = Vector((s * 0.3, -0.5, 1.0)).normalized()
    q = track(axis, 'Y')
    at = p + Vector((0, -0.01, 0.002))
    cyl(f, 'Whisk handle', 0.0045, 0.004, 0.03, at, M['wood'], 'part', quat=q, segs=16, bevel=0.001)
    base = at + axis * 0.015
    side = q @ Vector((1, 0, 0))
    fwd = q @ Vector((0, 1, 0))
    for k in range(4):
        a = math.pi * k / 4
        w = math.cos(a) * side + math.sin(a) * fwd
        pts = [base + axis * (0.004 + 0.036 * (1 - math.cos(t)) / 2) + w * (0.012 * math.sin(t))
               for t in [math.pi * i / 16 for i in range(17)]] + \
              [base + axis * (0.004 + 0.036 * (1 - math.cos(t)) / 2) - w * (0.012 * math.sin(t))
               for t in [math.pi * i / 16 for i in range(16, -1, -1)]]
        f.tube('Whisk wire', pts, 0.0009, M['steel'], 'part')


def wear_hardhat(f):
    top = head_top(f)
    z0 = f.c.z + f.r * f.sz * 0.55
    dome(f, 'Hard hat', f.r + 0.007, f.r * f.sz + 0.008, z0 - f.c.z, f.c, M['hat_yellow'], 'body', thick=0.004)
    rr = ellipse_radius_at(f, z0) + 0.009
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=64, radius1=rr + 0.009, radius2=rr + 0.009, depth=0.003)
    for v in bm.verts:
        if v.co.y < 0:
            v.co.y *= 1.12
    mesh(f, 'Brim', bm, M['hat_yellow'], 'body', loc=Vector((0, 0, z0 + 0.001)),
         mods=[('BEVEL', dict(width=0.0012, segments=3, limit_method='ANGLE'))])
    ridge = [f.c + Vector((0, (f.r + 0.011) * math.sin(t), (f.r * f.sz + 0.012) * math.cos(t))) for t in [-0.9 + 1.8 * i / 20 for i in range(21)]]
    f.tube('Ridge', ridge, 0.004, M['hat_yellow'], 'body')


def hold_hammer(f, s):
    p, d = hand(f, s)
    axis = Vector((s * 0.25, -0.4, 1.0)).normalized()
    q = track(axis, 'Y')
    at = p + Vector((0, -0.008, 0.008))
    cyl(f, 'Hammer handle', 0.0045, 0.005, 0.07, at, M['wood'], 'part', quat=q, segs=16, bevel=0.001)
    head = at + axis * 0.037
    hq = track(q @ Vector((1, 0, 0)), 'Y')
    cyl(f, 'Hammer head', 0.0095, 0.0095, 0.042, head, M['steel'], 'part', quat=hq, segs=8, bevel=0.002)


def front_glasses(f):
    for s in (-1, 1):
        p, n = f.surface_point(f.dir(s * 0.3, 0.2))
        X = Vector((math.cos(s * 0.3), math.sin(s * 0.3), 0))
        f.tube('Rim', ring(p + n * 0.005, X, up, 0.0175, n=36), 0.0016, M['gold'], 'part')
        q, _ = f.surface_point(f.dir(s * 1.0, 0.24))
        f.tube('Temple', [p + n * 0.005 + X * (s * 0.0175), (p + q) / 2 + n * 0.006 + Vector((0, 0, 0.002)), q + Vector((0, 0, 0.001))], 0.0013, M['gold'], 'part')
    a, na = f.surface_point(f.dir(-0.12, 0.24))
    b, nb = f.surface_point(f.dir(0.12, 0.24))
    mid, nm = f.surface_point(f.dir(0, 0.26))
    f.tube('Bridge', [a + na * 0.005, mid + nm * 0.008, b + nb * 0.005], 0.0014, M['gold'], 'part')


def wear_pencil(f):
    p, n = f.surface_point(f.dir(-1.25, 0.42))
    axis = Vector((0.25, 1.0, 0.55)).normalized()
    q = track(axis, 'Y')
    at = p + n * 0.004
    cyl(f, 'Pencil', 0.0042, 0.0042, 0.05, at, M['pencil'], 'body', quat=q, segs=6)
    cyl(f, 'Eraser', 0.0042, 0.0042, 0.007, at + axis * 0.028, M['eraser'], 'body', quat=q, segs=16)
    cyl(f, 'Ferrule', 0.0044, 0.0044, 0.003, at + axis * 0.0245, M['steel'], 'body', quat=q, segs=16)
    cyl(f, 'Tip wood', 0.0042, 0.0012, 0.008, at - axis * 0.029, M['wood'], 'body', quat=track(-axis, 'Y'), segs=6)


def hold_book(f, s):
    p, d = hand(f, s)
    q = track((-s * 0.3, -1, 0.15), 'Y')
    at = p + Vector((0, -0.012, 0.022))
    rot = lambda v: q @ Vector(v)
    box(f, 'Pages', (0.04, 0.052, 0.011), at, M['paper'], 'part', quat=q)
    for z in (-0.0065, 0.0065):
        box(f, 'Cover', (0.043, 0.055, 0.002), at + rot((0.0015, 0, z)), M['book'], 'part', quat=q, bevel=0.0006)
    box(f, 'Spine', (0.003, 0.055, 0.015), at + rot((-0.021, 0, 0)), M['book'], 'part', quat=q, bevel=0.0008)
    box(f, 'Label', (0.024, 0.008, 0.0006), at + rot((0.002, 0.012, -0.0078)), M['paint_mustard'], 'part', quat=q)


def wear_wizard_hat(f):
    top = head_top(f)
    z = top.z - 0.016
    cyl(f, 'Brim', 0.078, 0.078, 0.003, Vector((0, 0, z)), M['navy_felt'], 'body', segs=64, bevel=0.001)
    path, rad = [], []
    for i in range(14):
        t = i / 13
        path.append(Vector((0.03 * t ** 2.2, 0.012 * t ** 2, z + 0.11 * t)))
        rad.append(0.05 * (1 - t) ** 1.05 + 0.0015)
    bm = bmesh.new()
    rings = []
    for i, (pt, r) in enumerate(zip(path, rad)):
        tng = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        a = tng.cross(Vector((0, 1, 0))).normalized()
        b = tng.cross(a)
        rings.append([bm.verts.new(pt + r * (math.cos(2 * math.pi * k / 32) * a + math.sin(2 * math.pi * k / 32) * b)) for k in range(32)])
    faces = []
    for i in range(len(rings) - 1):
        for k in range(32):
            faces.append(bm.faces.new([rings[i][k], rings[i][(k + 1) % 32], rings[i + 1][(k + 1) % 32], rings[i + 1][k]]))
    faces.append(bm.faces.new(rings[0][::-1]))
    faces.append(bm.faces.new(rings[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    mesh(f, 'Wizard hat', bm, M['navy_felt'], 'body')
    f.tube('Hat band', ring(Vector((0, 0, z + 0.008)), Vector((1, 0, 0)), Vector((0, 1, 0)), 0.0475, n=48), 0.0035, M['gold'], 'body')
    for (az, h, r) in ((-0.5, 0.035, 0.0075), (0.35, 0.06, 0.0058), (-0.15, 0.082, 0.0045)):
        t = h / 0.11
        rr = 0.05 * (1 - t) ** 1.05 + 0.0015
        c = Vector((0.03 * t ** 2.2, 0.012 * t ** 2, z + h))
        nrm = Vector((math.sin(az), -math.cos(az), 0.35)).normalized()
        prism(f, 'Star', star(r, r * 0.45), 0.0012, c + Vector((math.sin(az), -math.cos(az), 0)) * (rr + 0.0004), M['gold'], 'body', quat=track(nrm, 'Y'))


def hold_wand(f, s):
    p, d = hand(f, s)
    axis = Vector((s * 0.45, -0.5, 1.0)).normalized()
    q = track(axis, 'Y')
    at = p + Vector((0, -0.01, 0.004))
    cyl(f, 'Wand', 0.0022, 0.003, 0.06, at, M['wood_dark'], 'part', quat=q, segs=12)
    prism(f, 'Wand star', star(0.011, 0.0048), 0.004, at + axis * 0.036, M['gold'], 'part', quat=track((0.2, -1, 0.3), 'Y'), bevel=0.0008)


# id, flavour (the body's colour), what it wears, what each hand holds (image left, right), front
CHARACTERS = [
    ('pudding', '#ef9f2c', dict(rough=0.45), wear_antenna, None, None, None),
    ('mochi', '#f6f3ec', dict(rough=0.55, sss=0.12), wear_beanie, None, hold_mug, None),
    ('taro', '#ad93d6', dict(rough=0.45), wear_headphones, None, hold_clipboard, None),
    ('sakura', '#f2a9bb', dict(rough=0.5, sss=0.05), wear_beret, hold_palette, hold_brush, None),
    ('matcha', '#93b45a', dict(rough=0.5), wear_toque, None, hold_whisk, None),
    ('caramel', '#c27d45', dict(rough=0.4, coat=0.15), wear_hardhat, None, hold_hammer, None),
    ('sesame', '#77716c', dict(rough=0.5), wear_pencil, hold_book, None, front_glasses),
    ('blueberry', '#6b82d6', dict(rough=0.45), wear_wizard_hat, None, hold_wand, None),
]


def pin(f):
    """The badge: a round pin on its chest, turned square to the camera; the Bot's avatar fills its face."""
    a, e = math.radians(TURN), math.radians(EL)
    view = Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
    p, _ = f.surface_point(f.dir(-0.55, -0.33))
    at = p + view * 0.009
    q = view.to_track_quat('Z', 'Y')
    cyl(f, 'Pin', 0.0245, 0.0245, 0.004, at, M['steel'], 'part', quat=q, segs=64, bevel=0.0014)
    cyl(f, 'Pin face', 0.0205, 0.0205, 0.0008, at + view * 0.0022, M['card'], 'part', quat=q, segs=64)
    return at + view * 0.0026, 0.0205


def scene():
    s = folk.setup_scene(el_deg=EL, turn_deg=TURN, frame=FRAME, center_z=CENTER_Z, px=SIZE)
    s.cycles.samples = SAMPLES
    materials()
    return s


def new_folk(body_color=None, body_opts=None):
    f = folk.Folk()
    if body_color:
        f.M['body'] = material('Body', body_color, **(body_opts or {}))
    return f


def render(out, name, build, holdout):
    s = scene()
    f = build()
    for o, layer in f.objects:
        o.is_holdout = holdout and layer == 'body'
    s.render.filepath = os.path.join(out, name + '.png')
    bpy.ops.render.render(write_still=True)
    print('rendered', name)


def layers():
    out = []
    for cid, color, opts, wear, hold_l, hold_r, front in CHARACTERS:
        def dressed(cid=cid, color=color, opts=opts, wear=wear):
            f = new_folk(color, opts)
            f.body()
            wear(f)
            return f
        out.append((f'{cid}-body', dressed, False))
        for side, s_, hold in (('l', -1, hold_l), ('r', 1, hold_r)):
            def arm(dressed=dressed, s_=s_, hold=hold):
                f = dressed()
                f.arm(s_, 'part')
                if hold:
                    hold(f, s_)
                return f
            out.append((f'{cid}-arm-{side}', arm, True))
        if front:
            def fr(dressed=dressed, front=front):
                f = dressed()
                front(f)
                return f
            out.append((f'{cid}-front', fr, True))
    for style in ('dot', 'happy', 'wink', 'closed'):
        out.append((f'eyes-{style}', lambda s=style: (lambda f: (f.body(), f.eyes(s), f)[2])(new_folk()), True))
    for style in ('smile', 'open', 'cat'):
        out.append((f'mouth-{style}', lambda s=style: (lambda f: (f.body(), f.mouth(s), f)[2])(new_folk()), True))
    # Drawn over the body and under the arms: it stands proud of the body, so nothing hides it.
    out.append(('pin', lambda: (lambda f: (pin(f), f)[1])(new_folk()), False))
    return out


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = os.path.abspath(argv[0] if argv else 'figure-layers')
    os.makedirs(out, exist_ok=True)
    only = set(argv[1].split(',')) if len(argv) > 1 else None
    for name, build, holdout in layers():
        if only is None or name in only:
            render(out, name, build, holdout)

    # Pivots and the badge's window, as fractions of the square from its top-left corner.
    s = scene()
    f = new_folk()
    f.body()
    centre, radius = pin(f)
    for o, _ in f.objects:
        o.hide_render = True
    bpy.context.view_layer.update()
    def at(point):
        v = world_to_camera_view(s, s.camera, point)
        return [round(v.x, 4), round(1 - v.y, 4)]
    meta = {
        'shoulder_l': at(f.shoulder(-1)[0]),
        'shoulder_r': at(f.shoulder(1)[0]),
        'feet': at(Vector((0, 0, 0))),
        'head_top': at(head_top(f)),
        'pin': at(centre),
        'pin_r': round(radius / FRAME, 4),
    }
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w'), indent=1)
    print('meta', meta)
