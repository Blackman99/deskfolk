"""The desk and its props for the mascot film, built procedurally with bpy (from the desk diorama).

Imported by scene.py; building nothing until its functions are called, apart from the materials.
"""
import bpy, bmesh, math, os, sys, time, glob
from mathutils import Vector, Matrix

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection
MODEL = []  # objects that go into the GLB


# ---------- materials ----------
def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def hexcol(h):
    h = h.lstrip('#')
    return tuple(lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)

def principled(m):
    nt = m.node_tree
    p = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if p is None:
        nt.nodes.clear()
        p = nt.nodes.new('ShaderNodeBsdfPrincipled')
        o = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(p.outputs['BSDF'], o.inputs['Surface'])
    return p

def mat(name, color, rough=0.5, metal=0.0, emit=None, emit_strength=1.0, sss=0.0, coat=0.0):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    p = principled(m)
    p.inputs['Base Color'].default_value = hexcol(color)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if emit:
        p.inputs['Base Color'].default_value = (0, 0, 0, 1)
        p.inputs['Emission Color'].default_value = hexcol(emit)
        p.inputs['Emission Strength'].default_value = emit_strength
        p.inputs['Roughness'].default_value = 0.6
        p.inputs['Specular IOR Level'].default_value = 0.15
    if sss:
        p.inputs['Subsurface Weight'].default_value = sss
        p.inputs['Subsurface Scale'].default_value = 0.01
    if coat:
        p.inputs['Coat Weight'].default_value = coat
    m.diffuse_color = hexcol(emit or color)
    m['fallback'] = color
    return m

def wood(name, light, dark, scale=2.5):
    m = mat(name, light, rough=0.45)
    nt = m.node_tree
    p = principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (0.6, 3.0, 1.0)
    wv = nt.nodes.new('ShaderNodeTexWave')
    wv.wave_type = 'BANDS'
    wv.bands_direction = 'Y'
    wv.inputs['Scale'].default_value = scale
    wv.inputs['Distortion'].default_value = 9.0
    wv.inputs['Detail'].default_value = 3.0
    wv.inputs['Detail Scale'].default_value = 1.5
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = hexcol(dark)
    ramp.color_ramp.elements[1].color = hexcol(light)
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[1].position = 1.0
    nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
    nt.links.new(mp.outputs['Vector'], wv.inputs['Vector'])
    nt.links.new(wv.outputs['Color'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], p.inputs['Base Color'])
    return m

TEAL = '#146a7c'
MUSTARD = '#f0ab3d'
MUSTARD_BODY = '#f6b52e'  # a touch more saturated: AgX pulls the brand mustard toward tan
M = {
    'desk': wood('Desk wood', '#d9a978', '#c48f5f', 1.6),
    'leg': wood('Leg wood', '#c08b5a', '#a7744a', 3.0),
    'backdrop': mat('Backdrop', '#dfe9ea', rough=0.9),
    'laptop': mat('Laptop shell', '#3a3f45', rough=0.32, metal=0.7),
    'bezel': mat('Bezel', '#15181b', rough=0.25),
    'keys': mat('Keys', '#1d2125', rough=0.6),
    'pad': mat('Trackpad', '#4a5056', rough=0.25, metal=0.5),
    'screen': mat('Screen', '#000000', rough=0.2, emit='#e9eff0', emit_strength=1.0),
    'sidebar': mat('UI sidebar', '#000000', rough=0.2, emit='#d6e4e7', emit_strength=1.0),
    'ui_white': mat('UI white', '#000000', rough=0.2, emit='#ffffff', emit_strength=1.0),
    'ui_teal': mat('UI teal', '#000000', rough=0.2, emit=TEAL, emit_strength=1.0),
    'ui_line': mat('UI line', '#000000', rough=0.2, emit='#b9c6c9', emit_strength=1.0),
    'ui_line_on_teal': mat('UI line on teal', '#000000', rough=0.2, emit='#8fc3cc', emit_strength=1.0),
    'ui_select': mat('UI select', '#000000', rough=0.2, emit='#b9d6dc', emit_strength=1.0),
    'ui_mustard': mat('UI mustard', '#000000', rough=0.2, emit=MUSTARD, emit_strength=1.0),
    'white_folk': mat('White folk', '#f7f5ef', rough=0.5, sss=0.15),
    'mustard_folk': mat('Mustard folk', MUSTARD_BODY, rough=0.45),
    'eye': mat('Eye', '#14171a', rough=0.12, coat=0.6),
    'mouth': mat('Mouth', '#5a2a24', rough=0.4),
    'glint': mat('Glint', '#000000', emit='#ffffff', emit_strength=3.0),
    'cheek': mat('Cheek', '#f3a59a', rough=0.6),
    'teal_glaze': mat('Teal glaze', TEAL, rough=0.25, coat=0.2),
    'coffee': mat('Coffee', '#3a2214', rough=0.08),
    'terracotta': mat('Terracotta', '#c66b47', rough=0.75),
    'soil': mat('Soil', '#3b2b20', rough=0.95),
    'leaf': mat('Leaf', '#3f7f52', rough=0.45),
    'leaf2': mat('Leaf light', '#5d9a5f', rough=0.45),
    'cream': mat('Cream', '#efe6d2', rough=0.6),
    'pages': mat('Pages', '#f6f0e1', rough=0.85),
    'coral': mat('Coral', '#d8705c', rough=0.55),
    'slate': mat('Slate', '#43535a', rough=0.55),
    'mustard_paint': mat('Mustard paint', MUSTARD, rough=0.5),
    'graphite': mat('Graphite', '#2a2a2a', rough=0.5),
    'note_teal': mat('Note teal', '#8ccbd3', rough=0.8),
    'note_mustard': mat('Note mustard', '#f5c25a', rough=0.8),
    'bubble': mat('Bubble teal', TEAL, rough=0.35, coat=0.15),
    'bubble_dot': mat('Bubble dot', '#ffffff', rough=0.35),
}


# ---------- geometry helpers ----------
def empty(name, loc=(0, 0, 0), rot=(0, 0, 0), parent=None, model=True):
    o = bpy.data.objects.new(name, None)
    col.objects.link(o)
    o.location = loc
    o.rotation_euler = rot
    o.empty_display_size = 0.05
    if parent:
        o.parent = parent
    if model:
        MODEL.append(o)
    return o

def obj_from_bm(name, bm, material, smooth=True, sharp_angle=35, parent=None,
                loc=(0, 0, 0), rot=(0, 0, 0), model=True):
    bm.normal_update()
    for f in bm.faces:
        f.smooth = smooth
    if smooth and sharp_angle:
        lim = math.radians(sharp_angle)
        for e in bm.edges:
            if len(e.link_faces) == 2 and e.calc_face_angle(0) > lim:
                e.smooth = False
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if material:
        me.materials.append(material)
    o = bpy.data.objects.new(name, me)
    col.objects.link(o)
    o.location = loc
    o.rotation_euler = rot
    if parent:
        o.parent = parent
    if model:
        MODEL.append(o)
    return o

def bevel(o, width, segs=3, angle=30):
    b = o.modifiers.new('Bevel', 'BEVEL')
    b.width = width
    b.segments = segs
    b.limit_method = 'ANGLE'
    b.angle_limit = math.radians(angle)
    b.harden_normals = True
    return o

def solidify(o, thick):
    s = o.modifiers.new('Solidify', 'SOLIDIFY')
    s.thickness = thick
    s.offset = -1
    s.use_even_offset = True
    return o

def T(x=0, y=0, z=0):
    return Matrix.Translation((x, y, z))

def S(x, y, z):
    return Matrix.Diagonal((x, y, z, 1))

def R(angle, axis):
    return Matrix.Rotation(angle, 4, axis)

def add_cube(bm, size, m=Matrix()):
    bmesh.ops.create_cube(bm, size=1.0, matrix=m @ S(*size))

def box(name, size, loc, material, bev=0.0, parent=None, rot=(0, 0, 0)):
    bm = bmesh.new()
    add_cube(bm, size)
    o = obj_from_bm(name, bm, material, parent=parent, loc=loc, rot=rot)
    if bev:
        bevel(o, bev)
    return o

def add_cyl(bm, r1, r2, depth, m=Matrix(), segs=48, caps=True):
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segs,
                          radius1=r1, radius2=r2, depth=depth, matrix=m)

def cyl(name, r1, r2, depth, loc, material, bev=0.0, parent=None, rot=(0, 0, 0), segs=48):
    bm = bmesh.new()
    add_cyl(bm, r1, r2, depth, T(0, 0, depth / 2), segs)
    o = obj_from_bm(name, bm, material, parent=parent, loc=loc, rot=rot)
    if bev:
        bevel(o, bev)
    return o

def open_cup(name, r1, r2, depth, wall, loc, material, parent=None, rot=(0, 0, 0)):
    """A cylinder with a bottom and no top, thickened inward."""
    bm = bmesh.new()
    add_cyl(bm, r1, r2, depth, T(0, 0, depth / 2), caps=True)
    top = max(bm.faces, key=lambda f: f.calc_center_median().z)
    bmesh.ops.delete(bm, geom=[top], context='FACES_ONLY')
    o = obj_from_bm(name, bm, material, parent=parent, loc=loc, rot=rot)
    solidify(o, wall)
    bevel(o, wall * 0.35, segs=3)
    return o

def add_sphere(bm, r, m=Matrix(), segs=32, rings=16):
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=r, matrix=m)

def sphere(name, r, loc, material, scale=(1, 1, 1), parent=None, rot=None, quat=None, segs=32, rings=16):
    bm = bmesh.new()
    add_sphere(bm, r, S(*scale), segs, rings)
    o = obj_from_bm(name, bm, material, sharp_angle=0, parent=parent, loc=loc)
    if quat is not None:
        o.rotation_mode = 'QUATERNION'
        o.rotation_quaternion = quat
    elif rot is not None:
        o.rotation_euler = rot
    return o

def add_prism(bm, pts, y0, y1, m=Matrix()):
    """Extrude a 2D outline drawn in (x, z) along y, from y0 to y1."""
    front = [bm.verts.new(m @ Vector((x, y0, z))) for x, z in pts]
    back = [bm.verts.new(m @ Vector((x, y1, z))) for x, z in pts]
    faces = [bm.faces.new(front), bm.faces.new(list(reversed(back)))]
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        faces.append(bm.faces.new([front[i], front[j], back[j], back[i]]))
    bmesh.ops.recalc_face_normals(bm, faces=faces)

def rrect(w, h, r, seg=6, cx=0.0, cz=0.0):
    r = min(r, w / 2, h / 2)
    pts = []
    for (x, z, a0) in [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90),
                       (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)]:
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((cx + x + r * math.cos(a), cz + z + r * math.sin(a)))
    return pts

def circle(r, cx=0.0, cz=0.0, seg=40):
    return [(cx + r * math.cos(2 * math.pi * i / seg), cz + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]

def add_tube(bm, path, radius, rseg=12, caps=True):
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
        rings.append([bm.verts.new(p + radius * (math.cos(2 * math.pi * k / rseg) * a +
                                                 math.sin(2 * math.pi * k / rseg) * b))
                      for k in range(rseg)])
    faces = []
    for i in range(n - 1):
        r0, r1 = rings[i], rings[i + 1]
        for k in range(rseg):
            faces.append(bm.faces.new([r0[k], r0[(k + 1) % rseg], r1[(k + 1) % rseg], r1[k]]))
    if caps:
        faces.append(bm.faces.new(rings[0][::-1]))
        faces.append(bm.faces.new(rings[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=faces)


# ---------- the Deskfolk bubble outline (BrandMark.svelte, viewBox 64) ----------
def bubble_svg_pts():
    pts = [(22, 6), (42, 6)]
    def arc(c, r, a0, a1, n=10):
        for i in range(1, n + 1):
            a = math.radians(a0 + (a1 - a0) * i / n)
            pts.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a)))
    arc((42, 22), 16, -90, 0)
    pts.append((58, 36))
    arc((42, 36), 16, 0, 90)
    pts += [(24.5, 52), (11, 61.5)]
    p0, c1, c2, p3 = map(Vector, [(11, 61.5), (9.8, 62.5), (8.1, 61.6), (8.3, 60.1)])
    for i in range(1, 7):
        t = i / 6
        q = (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * c1 + 3 * (1 - t) * t ** 2 * c2 + t ** 3 * p3
        pts.append((q.x, q.y))
    pts.append((9.6, 50))
    arc((22, 40), 16, math.degrees(math.atan2(10, -12.4)), 180, 6)
    pts.append((6, 22))
    arc((22, 22), 16, 180, 270)
    out = []
    for p in pts:
        if not out or (Vector(p) - Vector(out[-1])).length > 1e-4:
            out.append(p)
    if (Vector(out[0]) - Vector(out[-1])).length < 1e-4:
        out.pop()
    return out

def svg_to_xz(pts, k, cx=32, cy=32):
    return [((x - cx) * k, (cy - y) * k) for x, y in pts]


# ---------- scene ----------
DESK_TOP = 0.75

def build_backdrop():
    prof = [(-6.0, 0.0), (1.2, 0.0)]
    Rr = 2.0
    for i in range(1, 17):
        a = math.radians(90 * i / 16)
        prof.append((1.2 + Rr * math.sin(a), Rr - Rr * math.cos(a)))
    prof.append((1.2 + Rr, 8.0))
    bm = bmesh.new()
    left = [bm.verts.new((-8, y, z)) for y, z in prof]
    right = [bm.verts.new((8, y, z)) for y, z in prof]
    for i in range(len(prof) - 1):
        bm.faces.new([left[i], right[i], right[i + 1], left[i + 1]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    o = obj_from_bm('Backdrop', bm, M['backdrop'], sharp_angle=0, model=False)
    # make sure normals face up / toward the scene
    if o.data.polygons[0].normal.z < 0:
        o.data.flip_normals()

def build_desk():
    w, d, t = 1.6, 0.8, 0.045
    root = empty('Desk')
    box('Desk top', (w, d, t), (0, 0, DESK_TOP - t / 2), M['desk'], bev=0.008, parent=root)
    leg_h = DESK_TOP - t
    for sx in (-1, 1):
        for sy in (-1, 1):
            bm = bmesh.new()
            add_cyl(bm, 0.024, 0.033, leg_h, T(0, 0, leg_h / 2), segs=24)
            o = obj_from_bm('Desk leg', bm, M['leg'], parent=root,
                            loc=(sx * (w / 2 - 0.09), sy * (d / 2 - 0.08), 0))
            bevel(o, 0.004)
    # apron under the top
    box('Desk apron front', (w - 0.2, 0.02, 0.06), (0, -(d / 2 - 0.09), leg_h - 0.03), M['leg'], bev=0.004, parent=root)
    box('Desk apron back', (w - 0.2, 0.02, 0.06), (0, d / 2 - 0.09, leg_h - 0.03), M['leg'], bev=0.004, parent=root)

def build_laptop(loc, rot_z):
    root = empty('Laptop', loc, (0, 0, rot_z))
    bw, bd, bh = 0.44, 0.30, 0.016
    box('Laptop base', (bw, bd, bh), (0, 0, bh / 2), M['laptop'], bev=0.005, parent=root)
    # keyboard
    bm = bmesh.new()
    cols, rows, pitch, key = 13, 5, 0.026, 0.021
    x0 = -(cols - 1) * pitch / 2
    y0 = 0.115
    for r in range(rows):
        for c in range(cols):
            if r == 0 and 4 <= c <= 8:
                continue
            add_cube(bm, (key, key, 0.002), T(x0 + c * pitch, y0 - (rows - 1 - r) * pitch, bh + 0.001))
    add_cube(bm, (5 * pitch - (pitch - key), key, 0.002), T(0, y0 - (rows - 1) * pitch, bh + 0.001))
    obj_from_bm('Laptop keys', bm, M['keys'], parent=root)
    pad = box('Trackpad', (0.14, 0.085, 0.001), (0, -0.095, bh + 0.0002), M['pad'], parent=root)
    # lid hinged at the back edge, tilted back
    lid = empty('Laptop lid', (0, bd / 2, bh), (math.radians(-14), 0, 0), parent=root)
    lw, lh, lt = bw, 0.29, 0.010
    box('Lid shell', (lw, lt, lh), (0, lt / 2, lh / 2), M['laptop'], bev=0.004, parent=lid)
    box('Lid bezel', (lw - 0.008, 0.0006, lh - 0.008), (0, -0.0002, lh / 2), M['bezel'], parent=lid)
    build_screen_ui(lid, lh)
    return root

def ui(name, pts, layer, material, parent):
    y = -0.0006 - 0.0005 * layer
    bm = bmesh.new()
    add_prism(bm, pts, y, y + 0.0004)
    return obj_from_bm(name, bm, material, sharp_angle=0, parent=parent)

def build_screen_ui(lid, lh):
    sw, sh = 0.41, 0.255
    cz = lh / 2 + 0.004
    left, right = -sw / 2, sw / 2
    bottom, top = cz - sh / 2, cz + sh / 2
    ui('Screen', rrect(sw, sh, 0.003, cz=cz), 0, M['screen'], lid)
    side_w = 0.088
    sx = left + side_w / 2
    ui('Sidebar', rrect(side_w, sh, 0.003, cx=sx, cz=cz), 1, M['sidebar'], lid)
    # mark in the sidebar
    k = 0.016 / 64
    ui('Sidebar mark', svg_to_xz(bubble_svg_pts(), k, cx=32 - (left + 0.016) / k, cy=32 + (top - 0.016) / k), 2, M['ui_teal'], lid)
    rows = [(top - 0.045, True), (top - 0.07, False), (top - 0.095, False), (top - 0.12, False)]
    for i, (z, sel) in enumerate(rows):
        if sel:
            ui('Sidebar selected', rrect(side_w - 0.01, 0.02, 0.004, cx=sx, cz=z), 2, M['ui_select'], lid)
        av = [M['ui_teal'], M['ui_mustard'], M['ui_white'], M['ui_teal']][i]
        ui('Sidebar avatar', circle(0.0065, left + 0.016, z), 3, av, lid)
        ui('Sidebar label', rrect(0.045, 0.005, 0.0025, cx=left + 0.05, cz=z), 3, M['ui_line'], lid)
    main_l = left + side_w + 0.008
    main_r = right - 0.008
    # header
    ui('Header', rrect(main_r - main_l + 0.008, 0.024, 0.0, cx=(main_l + main_r) / 2, cz=top - 0.012), 1, M['ui_white'], lid)
    ui('Header title', rrect(0.06, 0.006, 0.003, cx=main_l + 0.032, cz=top - 0.012), 2, M['ui_line'], lid)
    # messages: (side, center z, width, lines)
    msgs = [('l', top - 0.05, 0.12, 2), ('r', top - 0.092, 0.11, 1), ('l', top - 0.135, 0.15, 3), ('r', top - 0.178, 0.085, 1)]
    for side, z, w, lines in msgs:
        h = 0.012 + 0.009 * lines
        if side == 'l':
            ui('Avatar', circle(0.007, main_l + 0.007, z + h / 2 - 0.007), 1, M['ui_mustard'], lid)
            cx = main_l + 0.019 + w / 2
            ui('Bubble', rrect(w, h, 0.006, cx=cx, cz=z), 1, M['ui_white'], lid)
            line_mat = M['ui_line']
        else:
            cx = main_r - w / 2
            ui('Bubble', rrect(w, h, 0.006, cx=cx, cz=z), 1, M['ui_teal'], lid)
            line_mat = M['ui_line_on_teal']
        for i in range(lines):
            lw = (w - 0.02) * (0.65 if i == lines - 1 and lines > 1 else 1.0)
            lz = z + h / 2 - 0.0105 - i * 0.009
            ui('Text line', rrect(lw, 0.0035, 0.00175, cx=cx - (w - 0.02 - lw) / 2, cz=lz), 2, line_mat, lid)
    # composer
    comp_w = main_r - main_l
    ui('Composer', rrect(comp_w, 0.022, 0.006, cx=(main_l + main_r) / 2, cz=bottom + 0.017), 1, M['ui_white'], lid)
    ui('Composer hint', rrect(0.07, 0.004, 0.002, cx=main_l + 0.045, cz=bottom + 0.017), 2, M['ui_line'], lid)
    ui('Send', circle(0.0075, main_r - 0.012, bottom + 0.017), 2, M['ui_teal'], lid)

def ellipsoid_point(center, r, sz, direction):
    d = direction.normalized()
    t = 1.0 / math.sqrt((d.x / r) ** 2 + (d.y / r) ** 2 + (d.z / (r * sz)) ** 2)
    p = center + d * t
    rel = p - center
    n = Vector((rel.x / r ** 2, rel.y / r ** 2, rel.z / (r * sz) ** 2)).normalized()
    return p, n

def dir_az_el(az, el):
    return Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))

def build_mug(loc, rot_z):
    root = empty('Mug', loc, (0, 0, rot_z))
    r, h = 0.042, 0.095
    open_cup('Mug body', r, r, h, 0.005, (0, 0, 0), M['teal_glaze'], parent=root)
    cyl('Coffee', r - 0.004, r - 0.004, 0.002, (0, 0, h - 0.016), M['coffee'], parent=root)
    path = []
    for i in range(17):
        a = math.radians(-105 + 210 * i / 16)
        path.append(Vector((r - 0.004 + 0.024 * math.cos(a) + 0.006, 0, h * 0.52 + 0.026 * math.sin(a))))
    bm = bmesh.new()
    add_tube(bm, path, 0.0065, rseg=16)
    obj_from_bm('Mug handle', bm, M['teal_glaze'], sharp_angle=0, parent=root)

def build_plant(loc):
    root = empty('Plant', loc)
    h = 0.12
    open_cup('Pot', 0.054, 0.07, h, 0.006, (0, 0, 0), M['terracotta'], parent=root)
    bm = bmesh.new()
    add_cyl(bm, 0.077, 0.077, 0.026, T(0, 0, h - 0.013), caps=False)
    rim = obj_from_bm('Pot rim', bm, M['terracotta'], parent=root)
    solidify(rim, 0.009)
    bevel(rim, 0.003)
    cyl('Soil', 0.064, 0.064, 0.004, (0, 0, h - 0.022), M['soil'], parent=root)
    leaves = [(0.0, 0.30, 0.05, 0.0), (1.2, 0.26, 0.20, 0.5), (2.3, 0.22, 0.28, 1.4),
              (3.3, 0.27, 0.18, 2.0), (4.3, 0.20, 0.30, 0.3), (5.3, 0.24, 0.22, 1.1),
              (0.6, 0.18, 0.38, 2.5), (2.9, 0.16, 0.42, 0.9), (4.9, 0.17, 0.40, 1.9)]
    for i, (theta, lh, tilt, twist) in enumerate(leaves):
        bm = bmesh.new()
        base = Vector((0.022 * math.cos(theta), 0.022 * math.sin(theta), h - 0.024))
        axis = Vector((-math.sin(theta), math.cos(theta), 0))
        m = T(*base) @ R(tilt, axis) @ R(twist, 'Z') @ S(1.0, 0.32, 1.0) @ T(0, 0, lh / 2)
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=16,
                              radius1=0.021, radius2=0.0015, depth=lh, matrix=m)
        obj_from_bm('Leaf', bm, M['leaf'] if i % 2 == 0 else M['leaf2'], sharp_angle=0, parent=root)

def build_book(name, center, size, cover, rot_z, parent=None):
    root = empty(name, center, (0, 0, rot_z), parent=parent)
    w, d, h = size
    ct = 0.003
    box(name + ' cover top', (w, d, ct), (0, 0, h / 2 - ct / 2), cover, bev=0.0012, parent=root)
    box(name + ' cover bottom', (w, d, ct), (0, 0, -h / 2 + ct / 2), cover, bev=0.0012, parent=root)
    box(name + ' spine', (ct * 1.5, d, h), (-w / 2 + ct * 0.75, 0, 0), cover, bev=0.0012, parent=root)
    box(name + ' pages', (w - ct - 0.005, d - 0.008, h - 2 * ct), (ct / 2 - 0.0025 + 0.0005, 0, 0), M['pages'], parent=root)
    return root

def build_pencil_cup(loc):
    root = empty('Pencil cup', loc)
    open_cup('Cup', 0.032, 0.032, 0.085, 0.004, (0, 0, 0), M['cream'], parent=root)
    for i, (mtl, ang, az, length) in enumerate([(M['mustard_paint'], 0.16, 0.4, 0.16),
                                                (M['teal_glaze'], 0.22, 2.4, 0.15),
                                                (M['coral'], 0.12, 4.2, 0.17)]):
        axis = Vector((-math.sin(az), math.cos(az), 0))
        m = T(0.01 * math.cos(az), 0.01 * math.sin(az), 0.008) @ R(ang, axis)
        bm = bmesh.new()
        add_cyl(bm, 0.0045, 0.0045, length, m @ T(0, 0, length / 2), segs=6)
        o = obj_from_bm('Pencil', bm, mtl, parent=root)
        bm = bmesh.new()
        add_cyl(bm, 0.0045, 0.0008, 0.016, m @ T(0, 0, length + 0.008), segs=6)
        obj_from_bm('Pencil tip', bm, M['cream'], parent=root)

def build_speech_bubble(loc, rot):
    root = empty('Speech bubble', loc, rot)
    k = 0.14 / 64
    th = 0.02
    bm = bmesh.new()
    add_prism(bm, svg_to_xz(bubble_svg_pts(), k), -th / 2, th / 2)
    o = obj_from_bm('Speech bubble body', bm, M['bubble'], parent=root)
    bevel(o, 0.004, segs=4)
    for x in (20, 32, 44):
        px, pz = svg_to_xz([(x, 29)], k)[0]
        sphere('Typing dot', 0.0085, (px, -th / 2 - 0.001, pz), M['bubble_dot'],
               scale=(1, 0.5, 1), parent=root)

def build_notes(loc):
    root = empty('Sticky notes', loc)
    box('Note', (0.07, 0.07, 0.0015), (0, 0, 0.00075), M['note_mustard'], parent=root, rot=(0, 0, 0.25))
    box('Note', (0.07, 0.07, 0.0015), (0.03, -0.02, 0.0024), M['note_teal'], parent=root, rot=(0, 0, -0.18))

