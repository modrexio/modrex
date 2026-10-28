import type p5 from 'p5'

type Point = { x: number; y: number }

export default function archiveUnpack(p: p5) {
    const CFG = {
        contentWidth: 1376,
        minGutter: 205,
        side: 'right',
        anchors: ['#features', '#compare'],
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
    const OPTIONS = ['.zip', '.7z']
    const files = ['.utoc', '.ucas', '.pak']

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

    function plate(
        x: number,
        y: number,
        w: number,
        h: number,
        depth: number,
        color: string,
        edge: string
    ) {
        p.stroke(edge)
        p.strokeWeight(1.2)
        p.fill('#171411')

        p.beginShape()
        p.vertex(x - w / 2, y)
        p.vertex(x, y + h / 2)
        p.vertex(x + w / 2, y - 25)
        p.vertex(x + w / 2, y - 25 + depth)
        p.vertex(x, y + h / 2 + depth)
        p.vertex(x - w / 2, y + depth)
        p.endShape(p.CLOSE)

        p.fill(color)

        p.beginShape()
        p.vertex(x - w / 2, y)
        p.vertex(x, y - h / 2)
        p.vertex(x + w / 2, y - 25)
        p.vertex(x, y + h / 2)
        p.endShape(p.CLOSE)
    }

    function artwork(v: number) {
        const opening = ease((v - 0.06) / 0.18)
        const grouping = ease((v - 0.62) / 0.22)
        const ready = ease((v - 0.86) / 0.1)

        const near = clamp(1 - Math.hypot(mouse.x - 210, mouse.y - 310) / 280)

        const tilt = reduced ? 0 : clamp((mouse.x - 210) * 0.025, -5, 5) * near

        text(v < 0.15 ? 'Archive' : v < 0.62 ? 'Files' : v < 0.86 ? 'Install' : 'Ready', 24, 32, 22)

        plate(
            210,
            507,
            278,
            120,
            12,
            ready > 0.5 ? '#2B1D12' : C.panel,
            ready > 0.5 ? C.orange : C.line
        )

        files.forEach((ext, i) => {
            const spread = ease((v - 0.13 - (2 - i) * 0.035) / 0.24)

            const folded = 310 - i * 13
            const expanded = 447 - i * 109
            const installed = 477 - i * 13

            let y = mix(mix(folded, expanded, spread), installed, grouping)

            const openness = spread * (1 - grouping)
            const hover = clamp(1 - Math.abs(mouse.y - y) / 80) * near

            if (!reduced) y -= hover * 7 * openness

            const x = 210 + tilt * (i - 1) * openness
            const hot = hover > 0.35 && openness > 0.4

            plate(
                x,
                y,
                244,
                108,
                7,
                hot ? '#352519' : ['#211C18', '#282019', '#302318'][i]!,
                hot ? C.light : C.dark
            )

            p.push()
            p.translate(x, y)
            p.applyMatrix(1, -0.27, 0.78, 0.44, -65, -3)
            text(ext, 0, 0, 27, hot ? C.ink : C.light)
            p.pop()
        })

        if (grouping < 0.995) {
            const x = 210 + opening * 24 + tilt
            const y = mix(258, 130, opening)

            p.push()
            ;(p.drawingContext as CanvasRenderingContext2D).globalAlpha *= 1 - grouping

            plate(x, y, 267, 120, 12, '#2A1F16', C.orange)

            p.push()
            p.translate(x, y)
            p.applyMatrix(1, -0.27, 0.78, 0.44, -67, 0)

            text(OPTIONS[choice]!, 0, 5, 32, C.ink)

            p.stroke(C.orange)
            p.strokeWeight(1.4)
            p.line(111, -37, 111, 28)

            for (let k = -32; k < 28; k += 8) {
                p.line(107, k, 115, k)
            }

            p.pop()
            p.pop()
        }

        text('Mod', 30, 587, 18, ready > 0.5 ? C.ink : C.muted)

        p.stroke(ready > 0.5 ? C.orange : C.line)
        p.fill(ready > 0.5 ? C.dark : C.panel)
        p.strokeWeight(1)
        p.rect(330, 568, 58, 28, 14)

        p.noStroke()
        p.fill(ready > 0.5 ? C.light : C.muted)
        p.circle(mix(344, 374, ready), 582, 18)
    }

    p.windowResized = () => p.resizeCanvas(gutterWidth(), p.windowHeight)
}
