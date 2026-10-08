"""The film's timeline: what Mochi and Pudding do, where the camera is, what is said and what is heard.

The data at the top is plain Python, read by mix.py and overlay.py too; `apply` keys it into Blender.
Times are seconds on the music's grid (120 BPM, a bar every 2 s); scenes start on bar lines.

  0.0  S1  Mochi hands the job to Pudding: a request bubble flies from one to the other
  4.0  S2  Pudding hops down to the laptop and works: typing, three dots over its head
 10.0  S3  Pudding stops and waves: an approval card; Mochi nods and lets it through on the downbeat
 14.0  S4  Mochi hops away; evening falls, the clock spins, Pudding keeps at it
 20.0  S5  next morning Mochi hops back to three handed-in files, each checked; Pudding cheers
 26.0  S6  the two hop up onto the Deskfolk mark; the end card lands on the last hit at 28.0
"""
DUR = 30.5
END_CARD = 28.0      # the music's last hit
END_FADE = 0.4

# what is said: (start, end, key in strings.py)
SUBS = [
    (0.7, 3.7, 'handoff'),
    (4.6, 9.7, 'works'),
    (10.4, 13.8, 'asks'),
    (14.5, 19.7, 'leave'),
    (20.6, 25.7, 'back'),
]
NAMES = (0.5, 3.4)   # name tags over the two while S1 introduces them

# what is heard, on top of the music: (time, sound)
CUES = [
    (1.6, 'pop'), (2.2, 'whoosh'), (3.55, 'tap'),
    (4.1, 'swish'), (4.55, 'pop'), (5.0, 'key'), (6.6, 'key'), (8.2, 'key'),
    (10.4, 'pop'), (10.5, 'tap'), (11.25, 'tap'), (12.0, 'click'), (12.5, 'swish'),
    (14.5, 'tap'), (15.15, 'whoosh'), (15.6, 'clock'),
    (20.3, 'tap'), (20.9, 'tap'), (21.4, 'pop'), (21.7, 'pop'), (22.0, 'pop'),
    (22.6, 'check'), (22.9, 'check'), (23.2, 'check'), (23.7, 'pass'),
    (26.0, 'whoosh'), (26.45, 'swish'), (27.05, 'tap'), (28.0, 'done'),
]

# keystrokes under the typing (mix.py spaces them ~0.13 s apart); none once the clock takes over
TYPING = [(0.6, 1.5), (5.0, 9.8), (12.9, 15.4)]

# where things stand (desk top at z 0.75)
DESK = 0.75
MOCHI_HOME = (-0.34, -0.15, DESK)
PUDDING_BOOKS = (0.55, 0.05, DESK + 0.086)
PUDDING_WORK = (0.27, -0.13, DESK)
MARK_AT = (0.0, -0.24, 1.05)


def apply(ctx):
    """Keys the timeline into the scene. `ctx` carries the rigs, the props module and the helpers."""
    import math
    from mathutils import Vector
    m, p, key, shot = ctx.mochi, ctx.pudding, ctx.key, ctx.shot
    P = ctx.props
    rad = math.radians

    # props
    bubble = P.request_bubble((MOCHI_HOME[0] + 0.05, MOCHI_HOME[1] - 0.02, DESK + 0.3))
    card, allow, allow_lit = P.approval_card((0.0, -0.2, 1.06))
    files = [P.deliverable(f'File {i}', (x, -0.27, DESK), rz, accent)
             for i, (x, rz, accent) in enumerate(((-0.13, 0.18, ctx.M['teal_glaze']), (0.0, 0.0, ctx.M['mustard_folk']),
                                                  (0.13, -0.18, ctx.M['coral'])))]
    clock, (hour, minute) = P.desk_clock((-0.42, 0.24, DESK), rad(12))
    mark = P.mark(MARK_AT)

    def pop(obj, t, to=1.0, dur=0.25):
        key(obj, 'scale', t, (0, 0, 0))
        key(obj, 'scale', t + dur * 0.7, (to * 1.12,) * 3)
        key(obj, 'scale', t + dur, (to,) * 3)

    def unpop(obj, t, dur=0.2):
        key(obj, 'scale', t, tuple(obj.scale))
        key(obj, 'scale', t + dur, (0, 0, 0))

    # ---------------- S1 0-4: the hand-over
    shot(0.0, (0.95, -1.62, 1.12), (0.06, 0.0, 0.89), 44)
    shot(3.95, (0.78, -1.42, 1.07), (0.1, -0.01, 0.89), 46)
    m.blink(0.5)
    m.type(0.6, 1.5)
    m.talk(1.5, 2.1)
    pop(bubble, 1.55, to=1.0)
    key(bubble, 'location', 2.15, bubble.location.copy())
    key(bubble, 'location', 2.8, Vector((0.12, -0.05, DESK + 0.42)))
    key(bubble, 'location', 3.45, Vector((PUDDING_BOOKS[0] - 0.09, PUDDING_BOOKS[1] - 0.03, PUDDING_BOOKS[2] + 0.27)))
    p.blink(1.2)
    p.turn(2.5, rad(-5), dur=0.4)
    p.hop(3.55, PUDDING_BOOKS, height=0.04, dur=0.3)
    p.blink(3.0)

    # ---------------- S2 4-10: Pudding takes it and works
    shot(4.0, (0.78, -1.32, 1.06), (0.2, -0.04, 0.88), 52, cut=True)
    shot(9.95, (0.68, -1.25, 1.03), (0.17, -0.04, 0.88), 52)
    p.hop(4.1, PUDDING_WORK, height=0.12, dur=0.5)
    key(bubble, 'location', 4.25, Vector((PUDDING_BOOKS[0] - 0.09, PUDDING_BOOKS[1] - 0.03, PUDDING_BOOKS[2] + 0.27)))
    key(bubble, 'location', 4.55, Vector(PUDDING_WORK) + Vector((0, -0.02, 0.2)))
    unpop(bubble, 4.5, dur=0.15)
    p.turn(4.75, rad(-12), dur=0.3)
    p.type(5.0, 9.8)
    p.think(5.0, 9.8)
    m.blink(6.3)
    m.blink(8.8)
    p.blink(7.4)

    # ---------------- S3 10-14: it stops and asks
    shot(10.0, (0.12, -1.5, 1.1), (0.0, -0.08, 0.93), 44, cut=True)
    shot(13.95, (0.08, -1.42, 1.08), (0.0, -0.08, 0.93), 44)
    p.turn(10.0, rad(-2), dur=0.25)
    p.hops_in_place(10.15, 2, height=0.04, beat=0.5)
    p.wave(10.15, 12.0, side='r')
    pop(card, 10.4)
    m.turn(10.8, rad(20), dur=0.3)
    m.nod(11.1, count=2, beat=0.3)
    m.hop(11.8, MOCHI_HOME, height=0.05, dur=0.3)
    key(allow, 'scale', 11.97, (1, 1, 1))
    key(allow, 'scale', 12.03, (0.92, 0.92, 0.92))
    key(allow, 'scale', 12.2, (1.05, 1.05, 1.05))
    key(allow_lit, 'hide_render', 11.9, True)  # keys closer than a frame (1/30 s) land on one frame
    key(allow_lit, 'hide_render', 12.0, False)
    key(allow_lit, 'hide_render', 12.4, True)
    unpop(card, 12.5, dur=0.22)
    m.blink(13.0)
    p.turn(12.6, rad(-12), dur=0.3)
    p.type(12.9, 14.0)

    # ---------------- S4 14-20: you leave, it keeps going
    shot(14.0, (1.15, -1.62, 1.16), (0.02, 0.0, 0.87), 40, cut=True)
    shot(19.95, (-0.62, -1.7, 1.16), (0.02, 0.0, 0.87), 40)
    m.turn(14.3, rad(95), dur=0.25)
    m.hop(14.5, (-0.62, -0.12, DESK), height=0.07, dur=0.45)
    m.hop(15.15, (-1.05, -0.1, 0.32), height=0.1, dur=0.5)
    key(m.root, 'scale', 15.6, (1, 1, 1))  # gone: off the desk and out of the story until it comes back
    key(m.root, 'scale', 15.64, (0, 0, 0))
    key(m.root, 'scale', 19.95, (0, 0, 0))
    key(m.root, 'scale', 20.0, (1, 1, 1))
    p.type(14.0, 19.85)
    p.think(14.0, 19.85)
    p.blink(16.4)
    p.blink(18.6)
    key(hour, 'rotation_euler', 15.5, (0, 0, 0))
    key(minute, 'rotation_euler', 15.5, (0, 0, 0))
    key(hour, 'rotation_euler', 19.6, (0, math.tau, 0))
    key(minute, 'rotation_euler', 19.6, (0, math.tau * 8, 0))
    ctx.daylight(15.6, 'day')
    ctx.daylight(18.6, 'evening')
    ctx.daylight(19.95, 'evening')
    ctx.daylight(20.0, 'day')

    # ---------------- S5 20-26: back to work done and checked
    shot(20.0, (0.1, -1.45, 1.06), (0.0, -0.1, 0.86), 44, cut=True)
    shot(25.95, (0.05, -1.36, 1.04), (0.0, -0.1, 0.86), 44)
    p.turn(20.0, rad(-8), dur=0.2)
    key(m.root, 'location', 20.0, Vector((-1.0, -0.15, 0.3)))
    m.pos = Vector((-1.0, -0.15, 0.3))
    m.turn(20.0, rad(25), dur=0.05)
    m.hop(20.05, (-0.58, -0.15, DESK), height=0.12, dur=0.45)
    m.hop(20.65, MOCHI_HOME, height=0.06, dur=0.35)
    for i, (f, badge) in enumerate(files):
        pop(f, 21.4 + i * 0.3)
        pop(badge, 22.6 + i * 0.3)
    p.blink(21.0)
    m.blink(22.1)
    p.cheer(23.6, 25.2)
    p.hops_in_place(23.6, 3, height=0.05, beat=0.5)
    m.hops_in_place(23.85, 2, height=0.04, beat=0.55)
    m.blink(25.4)

    # ---------------- S6 26-30.5: home to the mark
    shot(26.0, (0.0, -1.62, 1.07), (0.0, -0.24, 1.03), 50, cut=True)
    shot(30.5, (0.0, -1.55, 1.065), (0.0, -0.24, 1.03), 50)
    for f, _ in files:
        unpop(f, 26.0, dur=0.15)
    pop(mark, 26.0, dur=0.4)
    m.turn(26.2, 0.0, dur=0.2)
    p.turn(26.2, 0.0, dur=0.2)
    m.hop(26.45, P.mark_spot(MARK_AT, 'mochi'), height=0.12, dur=0.55)
    p.hop(26.5, P.mark_spot(MARK_AT, 'pudding'), height=0.12, dur=0.55)
    # Pudding's inner arm goes round Mochi's shoulder instead of through it; the outer ones wave goodbye
    key(p.shoulders['l'], 'rotation_euler', 26.95, (0, 0, 0))
    key(p.shoulders['l'], 'rotation_euler', 27.15, (-0.75, 0, -0.35))
    m.wave(27.2, 28.6, side='l')
    p.wave(27.3, 28.6, side='r')
    m.blink(27.9)
    p.blink(28.05)
    return DUR
