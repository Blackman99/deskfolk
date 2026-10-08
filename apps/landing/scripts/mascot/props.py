"""Props the story needs beyond the desk: the request bubble, the approval card, the delivered
files, the desk clock and the mark the two land in. Shapes and colours only: every word in the film
is laid over it afterwards, so one render serves both languages."""
import math
import bmesh
from mathutils import Matrix, Vector
from scene_lib import (M, add_cube, add_cyl, add_prism, add_tube, bevel, bubble_svg_pts, circle, empty,
                       mat, obj_from_bm, rrect, sphere, svg_to_xz, T, R)

GREEN = mat('Check green', '#2f9e63', rough=0.4)
WHITE = mat('Card white', '#fbfcfc', rough=0.45)
LINE = mat('Card line', '#c9d3d6', rough=0.7)
BUTTON = mat('Button teal', '#146a7c', rough=0.35)
BUTTON_LIT = mat('Button lit', '#000000', emit='#3fc1d6', emit_strength=4.0)
GREY_BUTTON = mat('Button grey', '#dfe6e8', rough=0.5)


def prism(name, pts, depth, material, parent, y0=0.0, bev=0.0):
    bm = bmesh.new()
    add_prism(bm, pts, y0 - depth / 2, y0 + depth / 2)
    o = obj_from_bm(name, bm, material, parent=parent, model=False)
    if bev:
        bevel(o, bev, segs=3)
    return o


def request_bubble(loc, size=0.11):
    """The teal speech bubble with three white dots: what you hand over."""
    root = empty('Request bubble', loc, model=False)
    k = size / 64
    prism('Request bubble body', svg_to_xz(bubble_svg_pts(), k), 0.018, M['bubble'], root, bev=0.004)
    for x in (20, 32, 44):
        px, pz = svg_to_xz([(x, 29)], k)[0]
        sphere('Request dot', 0.0075, (px, -0.0095, pz), M['bubble_dot'], scale=(1, 0.5, 1), parent=root)
    root.scale = (0, 0, 0)
    return root


def approval_card(loc):
    """A card asking to let something through: two lines of request, a teal Allow and a grey Deny."""
    root = empty('Approval card', loc, model=False)
    w, h = 0.26, 0.15
    prism('Card', rrect(w, h, 0.016), 0.008, WHITE, root, bev=0.002)
    prism('Card header', rrect(w - 0.03, 0.012, 0.006, cz=h / 2 - 0.03), 0.002, BUTTON, root, y0=-0.005)
    for i, lw in enumerate((0.17, 0.12)):
        prism('Card text', rrect(lw, 0.009, 0.0045, cx=-w / 2 + 0.015 + lw / 2, cz=0.012 - i * 0.022), 0.002,
              LINE, root, y0=-0.005)
    allow = empty('Allow', (0.055, -0.006, -0.045), parent=root, model=False)
    prism('Allow button', rrect(0.09, 0.03, 0.015), 0.006, BUTTON, allow)
    lit = prism('Allow lit', rrect(0.09, 0.03, 0.015), 0.0065, BUTTON_LIT, allow, y0=-0.0004)
    lit.hide_render = True
    prism('Deny button', rrect(0.07, 0.03, 0.015, cx=-0.035, cz=-0.045), 0.006, GREY_BUTTON, root, y0=-0.006)
    root.scale = (0, 0, 0)
    return root, allow, lit


def check_badge(name, parent, loc, r=0.016):
    badge = empty(name, loc, parent=parent, model=False)
    prism(name + ' disc', [(x, z) for x, z in circle(r, seg=32)], 0.004, GREEN, badge)
    bm = bmesh.new()
    pts = [Vector((-0.4 * r, -0.006, 0.0)), Vector((-0.1 * r, -0.006, -0.32 * r)), Vector((0.45 * r, -0.006, 0.38 * r))]
    path = [pts[0].lerp(pts[1], i / 6) for i in range(6)] + [pts[1].lerp(pts[2], i / 8) for i in range(9)]
    add_tube(bm, path, r * 0.13, rseg=8)
    obj_from_bm(name + ' tick', bm, WHITE, sharp_angle=0, parent=badge, model=False)
    badge.scale = (0, 0, 0)
    return badge


def deliverable(name, loc, rz, accent):
    """A handed-in file standing on the desk, tilted back, with a check badge that pops on later."""
    root = empty(name, loc, (math.radians(-12), 0, rz), model=False)
    w, h = 0.075, 0.095
    prism(name + ' page', [(x, z + h / 2) for x, z in rrect(w, h, 0.008)], 0.004, WHITE, root, bev=0.0012)
    prism(name + ' band', rrect(w - 0.016, 0.012, 0.005, cz=h - 0.016), 0.0015, accent, root, y0=-0.0025)
    for i, lw in enumerate((0.05, 0.04, 0.046)):
        prism(name + ' line', rrect(lw, 0.005, 0.0025, cx=-w / 2 + 0.008 + lw / 2, cz=h - 0.036 - i * 0.013),
              0.0012, LINE, root, y0=-0.0025)
    badge = check_badge(name + ' check', root, (w / 2 - 0.006, -0.006, h - 0.01))
    root.scale = (0, 0, 0)
    return root, badge


def desk_clock(loc, rz):
    root = empty('Desk clock', loc, (0, 0, rz), model=False)
    bm = bmesh.new()
    add_cyl(bm, 0.05, 0.05, 0.022, T(0, 0, 0.062) @ R(math.pi / 2, 'X'), segs=48)
    case = obj_from_bm('Clock case', bm, M['bubble'], parent=root, model=False)
    bevel(case, 0.006)
    face = prism('Clock face', circle(0.042, 0, 0.062, seg=48), 0.002, WHITE, root, y0=-0.0115)
    for i in range(12):
        a = i / 12 * math.tau
        prism('Clock mark', rrect(0.003, 0.008 if i % 3 == 0 else 0.005, 0.0015,
                                  cx=0.034 * math.sin(a), cz=0.062 + 0.034 * math.cos(a)), 0.001, LINE, root, y0=-0.0128)
    for s in (-1, 1):
        bm = bmesh.new()
        add_cube(bm, (0.012, 0.03, 0.012), T(s * 0.028, 0, 0.006))
        obj_from_bm('Clock foot', bm, M['bubble'], parent=root, model=False)
    hands = []
    for name, length, width in (('hour', 0.022, 0.0042), ('minute', 0.033, 0.003)):
        pivot = empty('Clock ' + name, (0, -0.0135, 0.062), parent=root, model=False)
        bm = bmesh.new()
        add_cube(bm, (width, 0.0012, length), T(0, 0, length / 2 - 0.004))
        obj_from_bm('Clock hand', bm, M['graphite'], parent=pivot, model=False)
        hands.append(pivot)
    sphere('Clock pin', 0.003, (0, -0.0145, 0.062), BUTTON, parent=root)
    return root, hands


MARK_K = 0.0086  # metres per unit of the mark's 64-unit viewBox: its circles come out folk-sized


def mark(loc):
    """The Deskfolk bubble, big enough that Mochi and Pudding stand where its circles are."""
    root = empty('Mark', loc, model=False)
    prism('Mark bubble', svg_to_xz(bubble_svg_pts(), MARK_K), 0.03, M['bubble'], root, bev=0.006)
    root.scale = (0, 0, 0)
    return root


def mark_spot(mark_loc, which):
    """Where a mascot's root goes to stand on the mark's circle: Mochi the white one, Pudding the mustard."""
    x = 25 if which == 'mochi' else 39.5
    cx, cz = svg_to_xz([(x, 29)], MARK_K)[0]
    body_centre = 0.0838  # Mascot.c.z
    y = -0.045 if which == 'mochi' else -0.07
    return Vector((mark_loc[0] + cx, mark_loc[1] + y, mark_loc[2] + cz - body_centre))
