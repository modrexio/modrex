import type p5 from 'p5'

type Point = { x: number; y: number }

export default function modRoute(p: p5) {
    const CFG = {
        contentWidth: 1376,
        minGutter: 205,
        side: 'left',
        anchors: ['#screenshots', '#features', '#compare', '#download'],
    }

    const C = {
        bg: '#131313',
        panel: '#201B17',
        ink: '#F4F4F3',
        muted: '#A39A92',
        line: '#38312C',
        orange: '#C45500',
        light: '#E6A16B',
        dark: '#6B3516',
    }

    const FONT = 'Helvetica, Arial, sans-serif'
    const OPTIONS = ['ModWorkshop', 'Nexus Mods']
    const stops = [145, 270, 395, 520]
    const names = ['Browse', 'Install', 'Enable', 'Play']

    const clamp = (n: number, a = 0, b = 1) => Math.max(a, Math.min(b, n))

    const mix = (a: number, b: number, t: number) => a + (b - a) * t

    const ease = (n: number) => {
        n = clamp(n)
        return n * n * (3 - 2 * n)
    }

    // Each canvas covers only its own margin, so the browser repaints a strip, not the window.
    const gutterWidth = () => Math.max(1, (p.windowWidth - CFG.contentWidth) / 2)

    let canvas: p5.Element
    let value = 0,
        target = 0,
        time = 0,
        previous = 0
    let visible = true
    let reduced = false
    const choice = 0
    let pointer: Point = { x: -1000, y: -1000 }
    let mouse: Point = { x: -1000, y: -1000 }

    p.setup = () => {
        const preference = window.matchMedia('(prefers-reduced-motion: reduce)')

        reduced = preference.matches

        p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2))
        canvas = p.createCanvas(gutterWidth(), p.windowHeight)
        p.frameRate(30)
        p.strokeJoin(p.ROUND)
        p.strokeCap(p.ROUND)
        canvas.style('display', 'block')
        canvas.style('position', 'fixed')
        canvas.style('top', '0')
        canvas.style(CFG.side, '0')
        canvas.style('pointer-events', 'none')
        canvas.style('z-index', '1')
        canvas.attribute('aria-hidden', 'true')

        window.addEventListener(
            'pointermove',
            (e) => {
                const r = canvas.elt.getBoundingClientRect()
                pointer = {
                    x: e.clientX - r.left,
                    y: e.clientY - r.top,
                }
            },
            { passive: true }
        )

        new IntersectionObserver((entries) => {
            visible = entries[0]!.isIntersecting
            previous = p.millis()
        }).observe(canvas.elt)

        document.addEventListener('visibilitychange', () => {
            previous = p.millis()
            if (document.hidden) p.noLoop()
            else p.loop()
        })

        preference.addEventListener('change', (e) => {
            reduced = e.matches
        })

        previous = p.millis()
    }

    p.draw = () => {
        const now = p.millis()
        const dt = Math.min((now - previous) / 1000, 0.06)
        previous = now

        if (!visible) return

        p.clear()

        if (p.width < CFG.minGutter) {
            return
        }

        target = scrollProgress()

        value = reduced ? target : mix(value, target, 1 - Math.exp(-dt * 12))

        if (!reduced) time += dt

        const gutter = p.width

        const s = Math.min((gutter - 24) / 420, (p.height - 70) / 620, 0.8)

        const x = (gutter - 420 * s) / 2

        const y = (p.height - 620 * s) / 2

        mouse = {
            x: (pointer.x - x) / s,
            y: (pointer.y - y) / s,
        }

        p.push()
        p.translate(x, y)
        p.scale(s)
        artwork(value)
        p.pop()
    }

    function text(
        t: string,
        x: number,
        y: number,
        size = 14,
        col = C.ink,
        align: typeof p.LEFT | typeof p.CENTER = p.LEFT
    ) {
        p.push()
        p.noStroke()
        p.fill(col)
        p.textFont(FONT)
        p.textStyle(p.NORMAL)
        p.textSize(size)
        p.textAlign(align, p.BASELINE)
        p.text(t, x, y)
        p.pop()
    }

    function wire(points: Point[], col = C.line, weight = 1) {
        p.noFill()
        p.stroke(col)
        p.strokeWeight(weight)
        p.beginShape()
        points.forEach((q) => p.vertex(q.x, q.y))
        p.endShape()
    }

    function curve(a: Point, b: Point, c: Point, d: Point): Point[] {
        return Array.from({ length: 61 }, (_, i) => {
            const t = i / 60
            const u = 1 - t

            return {
                x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
                y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
            }
        })
    }

    function scrollProgress() {
        const elements = CFG.anchors
            .map((s) => document.querySelector(s))
            .filter((el): el is Element => el !== null)

        if (elements.length > 1) {
            const f = p.height * 0.4

            for (let i = 0; i < elements.length - 1; i++) {
                const a = elements[i]!.getBoundingClientRect().top
                const b = elements[i + 1]!.getBoundingClientRect().top

                if (b > f) {
                    return clamp((i + clamp((f - a) / Math.max(1, b - a))) / (elements.length - 1))
                }
            }

            return 1
        }

        return clamp(window.scrollY / Math.max(1, document.documentElement.scrollHeight - p.height))
    }

    function routeX(y: number) {
        const x = 210 + 24 * Math.sin(((y - 145) / 375) * Math.PI * 2)
        const near = Math.exp(-Math.pow((y - mouse.y) / 90, 2))
        const reach = clamp(1 - Math.abs(mouse.x - x) / 150)

        return x + (reduced ? 0 : clamp((mouse.x - x) * 0.055, -6, 6) * near * reach)
    }

    function travel(v: number) {
        if (v < 0.12) return 0
        if (v < 0.34) return ease((v - 0.12) / 0.22) / 3
        if (v < 0.43) return 1 / 3
        if (v < 0.64) return (1 + ease((v - 0.43) / 0.21)) / 3
        if (v < 0.73) return 2 / 3

        return (2 + ease((v - 0.73) / 0.19)) / 3
    }

    function artwork(v: number) {
        const progress = travel(v)
        const index = Math.min(3, Math.floor(progress * 3 + 0.001))

        ;[104, 316].forEach((x, i) => {
            const selected = i === choice

            p.fill(selected ? C.panel : C.bg)
            p.stroke(selected ? C.orange : C.line)
            p.strokeWeight(1)
            p.rect(x - 77, 42, 154, 43, 6)

            text(OPTIONS[i]!, x, 69, 14, selected ? C.ink : C.muted, p.CENTER)

            const branch = curve(
                { x, y: 85 },
                { x, y: 120 },
                { x: 210, y: 115 },
                { x: 210, y: 145 }
            )

            wire(branch, selected ? C.orange : C.line, selected ? 1.8 : 1)

            if (selected && !reduced) {
                const q = branch[Math.floor(((time * 0.35) % 1) * 60)]!
                p.noStroke()
                p.fill(C.light)
                p.circle(q.x, q.y, 4)
            }
        })

        for (const offset of [-6, 0, 6]) {
            const points = Array.from({ length: 126 }, (_, i) => ({
                x: routeX(145 + i * 3) + offset,
                y: 145 + i * 3,
            }))

            wire(points, offset === 0 ? C.dark : C.line, offset === 0 ? 2 : 1)

            const active = points.filter((q) => q.y <= 145 + progress * 375)

            if (active.length > 1) {
                wire(active, offset === 0 ? C.orange : C.dark, offset === 0 ? 3 : 1)
            }
        }

        if (progress > 0.01 && !reduced) {
            for (let k = 0; k < 3; k++) {
                const t = ((time * 0.16 + k / 3) % 1) * progress

                const segment = Array.from({ length: 10 }, (_, j) => {
                    const y = 145 + clamp(t - j * 0.003) * 375
                    return { x: routeX(y), y }
                })

                wire(segment, C.light, 2.3)
            }
        }

        stops.forEach((y, i) => {
            const x = routeX(y)
            const active = i === index
            const done = i < index
            const col = active ? C.light : done ? C.orange : C.muted
            const left = i % 2 === 0

            wire(
                [
                    { x: x + (left ? -23 : 23), y },
                    { x: left ? 55 : 365, y },
                ],
                active ? C.dark : C.line
            )

            text(names[i]!, left ? 30 : 285, y - 12, 20, active ? C.ink : C.muted)

            p.fill(C.bg)
            p.stroke(active ? C.orange : C.line)
            p.strokeWeight(active ? 2 : 1)
            p.circle(x, y, 40)

            p.push()
            p.translate(x, y)
            p.stroke(col)
            p.strokeWeight(1.5)
            p.noFill()

            if (i === 0) {
                p.circle(-2, -2, 12)
                p.line(3, 3, 8, 8)
            }

            if (i === 1) {
                p.line(-8, -6, 8, -6)
                p.line(-8, 0, 8, 0)
                p.line(-8, 6, 8, 6)
            }

            if (i === 2) {
                p.rect(-11, -6, 22, 12, 6)
                p.fill(col)
                p.noStroke()
                p.circle(active || done ? 5 : -5, 0, 7)
            }

            if (i === 3) {
                p.fill(col)
                p.noStroke()
                p.triangle(-4, -8, -4, 8, 8, 0)
            }

            p.pop()

            if (active) {
                p.noFill()
                p.stroke(C.orange)
                p.strokeWeight(2)
                p.arc(x, y, 50, 50, -p.HALF_PI, p.PI * 0.9)
            }
        })

        ;[125, 295].forEach((x, i) => {
            wire(
                curve({ x: 210, y: 543 }, { x: 210, y: 564 }, { x, y: 555 }, { x, y: 580 }),
                progress > 0.96 ? C.dark : C.line
            )

            text(
                i ? 'Modded' : 'Vanilla',
                x,
                606,
                14,
                progress > 0.96 ? (i ? C.light : C.ink) : C.muted,
                p.CENTER
            )
        })
    }

    p.windowResized = () => p.resizeCanvas(gutterWidth(), p.windowHeight)
}
