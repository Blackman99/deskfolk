"""Mochi and Pudding as rigs a timeline can drive, and the moves the film uses.

A mascot is a root empty (where it stands and which way it faces), a squash empty at its feet
(squash and stretch), and parts parented under it: eye pivots that flatten to blink, a smile and an
open mouth to toggle, and an empty at each shoulder that turns its arm. Times are in seconds.
"""
import math
import bmesh
from mathutils import Vector
from scene_lib import (M, add_sphere, add_tube, dir_az_el, ellipsoid_point, empty, obj_from_bm,
                       sphere, S)

FPS = 30


def frame(t):
    return round(t * FPS) + 1


_KEYED = {}


def key(obj, path, t, value):
    """Keys obj.path to value at t. Two keys closer than a frame land on one frame and the later one
    silently wins, so a clash with a different value is reported."""
    f = frame(t)
    seen = _KEYED.get((obj.name, path, f))
    now = tuple(value) if hasattr(value, '__len__') else value
    if seen is not None and seen != now:
        print(f'KEY CLASH {obj.name}.{path} at frame {f} (t={t}): {seen} then {now}')
    _KEYED[(obj.name, path, f)] = now
    setattr(obj, path, value)
    obj.keyframe_insert(data_path=path, frame=f)


class Mascot:
    def __init__(self, name, body_mat, loc, rot_z, antenna=False):
        self.name = name
        self.pos = Vector(loc)
        self.rz = rot_z
        self.root = empty(name, loc, (0, 0, rot_z), model=False)
        self.squash = empty(name + ' squash', parent=self.root, model=False)
        r, sz = 0.085, 1.12
        zmin = -r * sz * 0.88
        c = Vector((0, 0, -zmin))
        self.r, self.sz, self.c = r, sz, c
        bm = bmesh.new()
        add_sphere(bm, r, S(1, 1, sz), 48, 24)
        for v in bm.verts:
            v.co.z = max(v.co.z, zmin) - zmin
        obj_from_bm(name + ' body', bm, body_mat, sharp_angle=0, parent=self.squash, model=False)
        for s in (-1, 1):
            sphere(name + ' foot', 0.024, Vector((s * 0.034, -0.045, 0.011)), body_mat,
                   scale=(1.05, 1.35, 0.55), parent=self.squash)
            p, n = ellipsoid_point(c, r, sz, dir_az_el(s * 0.58, 0.02))
            sphere(name + ' cheek', 0.015, p - n * 0.0025, M['cheek'], scale=(1, 0.25, 0.62),
                   parent=self.squash, quat=n.to_track_quat('-Y', 'Z'))
        self.eyes = []
        for s in (-1, 1):
            p, n = ellipsoid_point(c, r, sz, dir_az_el(s * 0.3, 0.2))
            pivot = empty(name + ' eye', p - n * 0.004, parent=self.squash, model=False)
            pivot.rotation_mode = 'QUATERNION'
            pivot.rotation_quaternion = n.to_track_quat('-Y', 'Z')
            sphere(name + ' eye ball', 0.0115, (0, 0, 0), M['eye'], scale=(1, 0.55, 1.2), parent=pivot)
            sphere(name + ' glint', 0.0028, (-0.003, -0.0065, 0.005), M['glint'], parent=pivot)
            self.eyes.append(pivot)
        path = []
        for i in range(13):
            t = -0.95 + 1.9 * i / 12
            target = c + dir_az_el(0, 0.05) * r + Vector((0.011 * math.sin(t), 0, -0.011 * math.cos(t) + 0.006))
            p, n = ellipsoid_point(c, r, sz, target - c)
            path.append(p - n * 0.0006)
        bm = bmesh.new()
        add_tube(bm, path, 0.0021, rseg=10)
        self.smile = obj_from_bm(name + ' smile', bm, M['eye'], sharp_angle=0, parent=self.squash, model=False)
        p, n = ellipsoid_point(c, r, sz, dir_az_el(0, -0.02))
        self.mouth = sphere(name + ' mouth', 0.0085, p - n * 0.003, M['mouth'], scale=(1.0, 0.45, 0.85),
                            parent=self.squash, quat=n.to_track_quat('-Y', 'Z'))
        self.mouth.hide_render = True
        self.shoulders = {}
        for s, side in ((-1, 'l'), (1, 'r')):
            p, n = ellipsoid_point(c, r, sz, dir_az_el(s * 1.42, -0.06))
            shoulder = empty(f'{name} shoulder {side}', p, parent=self.squash, model=False)
            d = Vector((s * 0.3, -0.2, -1.0)).normalized()
            sphere(name + ' arm', 0.021, -n * 0.006 + d * 0.024, body_mat, scale=(1, 1, 1.75),
                   parent=shoulder, quat=d.to_track_quat('Z', 'Y'))
            self.shoulders[side] = shoulder
        if antenna:
            top = c + Vector((0, 0, r * sz))
            stalk = [top + Vector((0.006 * (i / 8) ** 2, 0, -0.004 + 0.03 * i / 8)) for i in range(9)]
            bm = bmesh.new()
            add_tube(bm, stalk, 0.0022, rseg=10)
            obj_from_bm(name + ' antenna', bm, M['graphite'], sharp_angle=0, parent=self.squash, model=False)
            sphere(name + ' antenna ball', 0.0095, stalk[-1] + Vector((0, 0, 0.006)), M['teal_glaze'],
                   parent=self.squash)
        self.dots = [sphere(name + ' thinking dot', 0.0085, Vector((0.055 + i * 0.024, 0, 0.225)),
                            M['teal_glaze'], parent=self.root) for i in range(3)]
        for d in self.dots:
            d.scale = (0, 0, 0)
        self.rest(0)

    # ---------- state ----------
    def rest(self, t):
        key(self.root, 'location', t, self.pos.copy())
        key(self.root, 'rotation_euler', t, (0, 0, self.rz))
        key(self.squash, 'scale', t, (1, 1, 1))
        key(self.squash, 'rotation_euler', t, (0, 0, 0))
        for side in 'lr':
            key(self.shoulders[side], 'rotation_euler', t, (0, 0, 0))
        for e in self.eyes:
            key(e, 'scale', t, (1, 1, 1))
        for d in self.dots:
            key(d, 'scale', t, (0, 0, 0))
        key(self.smile, 'hide_render', t, False)
        key(self.mouth, 'hide_render', t, True)

    # ---------- moves ----------
    def hop(self, t, to, height=0.09, dur=0.45):
        """A hop from where it stands to `to`: crouch, stretch on the way up, squash on landing."""
        to = Vector(to)
        key(self.root, 'location', t, self.pos.copy())
        key(self.squash, 'scale', t - 0.1, (1, 1, 1))
        key(self.squash, 'scale', t, (1.08, 1.08, 0.86))
        key(self.squash, 'scale', t + 0.1, (0.94, 0.94, 1.1))
        key(self.root, 'location', t + dur / 2, (self.pos + to) / 2 + Vector((0, 0, height)))
        key(self.root, 'location', t + dur, to)
        key(self.squash, 'scale', t + dur - 0.04, (0.97, 0.97, 1.04))
        key(self.squash, 'scale', t + dur + 0.05, (1.1, 1.1, 0.85))
        key(self.squash, 'scale', t + dur + 0.2, (1, 1, 1))
        self.pos = to
        return t + dur + 0.2

    def hops_in_place(self, t, count, height=0.05, beat=0.5):
        for i in range(count):
            self.hop(t + i * beat, self.pos, height, dur=beat * 0.6)

    def turn(self, t, rz, dur=0.3):
        key(self.root, 'rotation_euler', t, (0, 0, self.rz))
        key(self.root, 'rotation_euler', t + dur, (0, 0, rz))
        self.rz = rz

    def blink(self, t):
        for e in self.eyes:
            key(e, 'scale', t - 0.02, (1, 1, 1))
            key(e, 'scale', t + 0.05, (1, 1, 0.12))
            key(e, 'scale', t + 0.13, (1, 1, 1))

    def close_eyes(self, t, closed=True):
        for e in self.eyes:
            key(e, 'scale', t, (1, 1, 1) if closed else (1, 1, 0.12))
            key(e, 'scale', t + 0.12, (1, 1, 0.12) if closed else (1, 1, 1))

    def talk(self, t0, t1, step=0.14):
        t, open_ = t0, True
        while t < t1:
            key(self.smile, 'hide_render', t, open_)
            key(self.mouth, 'hide_render', t, not open_)
            open_ = not open_
            t += step
        key(self.smile, 'hide_render', t1, False)
        key(self.mouth, 'hide_render', t1, True)

    def type(self, t0, t1, step=0.13):
        """Arms reach forward in turn, the body bobbing."""
        for side in 'lr':
            key(self.shoulders[side], 'rotation_euler', t0, (0, 0, 0))
        t, i = t0 + 0.1, 0
        while t < t1 - 0.1:
            up, down = (-0.95, -0.45) if i % 2 == 0 else (-0.45, -0.95)
            key(self.shoulders['l'], 'rotation_euler', t, (up, 0, 0))
            key(self.shoulders['r'], 'rotation_euler', t, (down, 0, 0))
            key(self.squash, 'scale', t, (1, 1, 1) if i % 2 == 0 else (1.02, 1.02, 0.97))
            t += step
            i += 1
        for side in 'lr':
            key(self.shoulders[side], 'rotation_euler', t1, (0, 0, 0))
        key(self.squash, 'scale', t1, (1, 1, 1))

    def wave(self, t0, t1, side='r', step=0.22):
        sign = -1 if side == 'r' else 1
        sh = self.shoulders[side]
        key(sh, 'rotation_euler', t0, (0, 0, 0))
        t, i = t0 + 0.18, 0
        while t < t1 - 0.2:
            key(sh, 'rotation_euler', t, (0, sign * (2.25 if i % 2 == 0 else 2.75), 0))
            t += step
            i += 1
        key(sh, 'rotation_euler', t1, (0, 0, 0))

    def cheer(self, t0, t1):
        for side, sign in (('l', 1), ('r', -1)):
            key(self.shoulders[side], 'rotation_euler', t0, (0, 0, 0))
            key(self.shoulders[side], 'rotation_euler', t0 + 0.15, (0, sign * 2.6, 0))
            key(self.shoulders[side], 'rotation_euler', t1 - 0.15, (0, sign * 2.6, 0))
            key(self.shoulders[side], 'rotation_euler', t1, (0, 0, 0))

    def nod(self, t, count=2, beat=0.32):
        for i in range(count):
            key(self.squash, 'rotation_euler', t + i * beat, (0, 0, 0))
            key(self.squash, 'rotation_euler', t + i * beat + beat / 2, (0.28, 0, 0))
        key(self.squash, 'rotation_euler', t + count * beat, (0, 0, 0))

    def think(self, t0, t1):
        """Three dots over the head, rising and falling in turn."""
        for i, d in enumerate(self.dots):
            base = d.location.copy()
            key(d, 'scale', t0 + i * 0.08, (0, 0, 0))
            key(d, 'scale', t0 + i * 0.08 + 0.15, (1, 1, 1))
            t, up = t0 + 0.2 + i * 0.13, True
            while t < t1 - 0.2:
                key(d, 'location', t, base + Vector((0, 0, 0.012 if up else 0)))
                up = not up
                t += 0.2
            key(d, 'location', t1 - 0.15, base)
            key(d, 'scale', t1 - 0.15, (1, 1, 1))
            key(d, 'scale', t1, (0, 0, 0))
