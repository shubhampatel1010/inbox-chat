// Two-tone notification chime synthesized with the Web Audio API — no asset.
// Browsers block audio until the user has interacted with the page, so we
// arm on the first real interaction and stay silent before that.

let ctx = null
let armed = false

export function armAudio() {
  armed = true
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
}

export function isArmed() {
  return armed
}

/** Call once at startup; resolves the autoplay guard on first interaction. */
export function listenForInteraction() {
  const events = ['pointerdown', 'keydown', 'touchstart']
  const onFirst = () => {
    armAudio()
    events.forEach((e) => window.removeEventListener(e, onFirst))
  }
  events.forEach((e) => window.addEventListener(e, onFirst, { once: true, passive: true }))
  return () => events.forEach((e) => window.removeEventListener(e, onFirst))
}

function tone(context, frequency, startAt, duration, peak) {
  const osc = context.createOscillator()
  const gain = context.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(frequency, startAt)

  // Short attack, exponential tail — reads as a soft "ding" rather than a beep.
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)

  osc.connect(gain)
  gain.connect(context.destination)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.02)
}

export function playChime() {
  if (!armed) return

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) return

    if (!ctx || ctx.state === 'closed') ctx = new AudioCtx()
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})

    const now = ctx.currentTime
    tone(ctx, 880, now, 0.16, 0.12) // A5
    tone(ctx, 1174.66, now + 0.11, 0.22, 0.1) // D6
  } catch {
    /* audio is a nicety — never let it break the inbox */
  }
}
