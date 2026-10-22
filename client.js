/**
 * Client half of @local/next-suggestion.
 *
 * Draws the predicted next user message as grey ghost text *inside* the
 * composer editor, and inserts it into the draft with Tab (or a click).
 * The prediction itself is produced by the Host half from the live session log.
 */

window.__ModuleLoader__.load({
  id: '@local/next-suggestion',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/dsh-next-suggestion'
    const POLL_MS = 800
    const PROBE_MS = 300

    function readEditorText(editor) {
      if (!editor) return null
      const raw = typeof editor.innerText === 'string' ? editor.innerText : editor.textContent
      return String(raw || '').replace(/[\u200b\u200e\u200f\ufeff]/g, '').trim()
    }

    function placeholderOf(editor) {
      if (!editor || typeof editor.getAttribute !== 'function') return ''
      const names = ['data-placeholder', 'aria-placeholder', 'placeholder']
      for (const name of names) {
        const value = editor.getAttribute(name)
        if (value && value.trim()) return value.trim()
      }
      return ''
    }

    // Walk up until an opaque background is found: the ghost is painted on top
    // of it so the native placeholder underneath is fully covered.
    function solidBackground(element) {
      let node = element
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const colour = window.getComputedStyle(node).backgroundColor
        if (colour && colour !== 'transparent' && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(colour)) return colour
        node = node.parentElement
      }
      return 'transparent'
    }

    // The composer editor is the visible, bottom-most contenteditable on screen.
    function pickEditor(host) {
      if (host && typeof host.querySelector === 'function') {
        const scoped = host.querySelector('[contenteditable="true"]')
        if (scoped) {
          const rect = scoped.getBoundingClientRect()
          if (rect.width > 60 && rect.height > 12) return scoped
        }
      }
      const all = Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"]'))
      let best = null
      let bestTop = -Infinity
      for (const element of all) {
        const rect = element.getBoundingClientRect()
        if (rect.width < 60 || rect.height < 12) continue
        const style = window.getComputedStyle(element)
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
        if (rect.top > bestTop) {
          bestTop = rect.top
          best = element
        }
      }
      return best
    }

    function NextSuggestion(props) {
      const sid = props && props.sessionId !== undefined && props.sessionId !== null ? String(props.sessionId) : ''
      const inputActions = props && props.inputActions

      const wrapRef = React.useRef(null)
      const [text, setText] = React.useState('')
      const [draftEmpty, setDraftEmpty] = React.useState(false)
      const [box, setBox] = React.useState(null)

      // --- prediction polling -------------------------------------------------
      React.useEffect(() => {
        if (!sid) return undefined
        let alive = true
        const tick = async () => {
          if (!alive) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try {
            const response = await fetch(`${ENDPOINT}/get?sessionId=${encodeURIComponent(sid)}`, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            if (!alive || !response.ok) return
            const data = await response.json()
            setText(data && typeof data.text === 'string' ? data.text : '')
          } catch {
            /* keep the last suggestion; the next tick retries */
          }
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sid])

      // --- find the composer editor, track emptiness and geometry -------------
      React.useEffect(() => {
        if (!sid) return undefined
        let alive = true
        const probe = () => {
          if (!alive) return
          const wrap = wrapRef.current
          if (!wrap) return
          const host = wrap.parentElement
          const editor = pickEditor(host)
          if (!editor) return
          const content = readEditorText(editor)
          const placeholder = placeholderOf(editor)
          const blank = content !== null &&
            (content.length === 0 || (placeholder !== '' && content === placeholder))
          setDraftEmpty(blank)
          const baseEl = wrap.offsetParent || host || editor.parentElement
          if (!baseEl) return
          const base = baseEl.getBoundingClientRect()
          const rect = editor.getBoundingClientRect()
          const style = window.getComputedStyle(editor)
          const padTop = parseFloat(style.paddingTop || '0') || 0
          const padLeft = parseFloat(style.paddingLeft || '0') || 0
          const padRight = parseFloat(style.paddingRight || '0') || 0
          const padBottom = parseFloat(style.paddingBottom || '0') || 0
          const next = {
            left: Math.round(rect.left - base.left) + padLeft,
            top: Math.round(rect.top - base.top) + padTop,
            width: Math.max(0, Math.round(rect.width) - padLeft - padRight),
            height: Math.max(0, Math.round(rect.height) - padTop - padBottom),
            fontSize: style.fontSize,
            fontFamily: style.fontFamily,
            lineHeight: style.lineHeight,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
            color: style.color,
            background: solidBackground(editor),
          }
          setBox((prev) => {
            if (prev &&
              prev.left === next.left && prev.top === next.top &&
              prev.width === next.width && prev.height === next.height &&
              prev.fontSize === next.fontSize && prev.fontFamily === next.fontFamily) {
              return prev
            }
            return next
          })
        }
        probe()
        const timer = setInterval(probe, PROBE_MS)
        window.addEventListener('resize', probe)
        return () => {
          alive = false
          clearInterval(timer)
          window.removeEventListener('resize', probe)
        }
      }, [sid, text])

      const consume = React.useCallback(() => {
        if (!sid) return
        try {
          fetch(`${ENDPOINT}/consume`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sid }),
          }).catch(() => {})
        } catch {
          /* ignore */
        }
      }, [sid])

      const accept = React.useCallback(() => {
        if (!text || !inputActions) return
        const editor = document.querySelector('[contenteditable="true"]')
        if (!editor) return
        editor.focus()
        try {
          const span = typeof inputActions.captureInsertion === 'function' ? inputActions.captureInsertion() : undefined
          if (typeof inputActions.insertText === 'function') inputActions.insertText(text, span)
        } catch {
          return
        }
        setText('')
        setDraftEmpty(false)
        consume()
      }, [text, inputActions, consume])

      // Tab inside the composer accepts the ghost text.
      React.useEffect(() => {
        if (!text) return undefined
        const onKeyDown = (event) => {
          if (!event || event.key !== 'Tab') return
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
          const target = event.target
          const editable = target && typeof target.closest === 'function'
            ? target.closest('[contenteditable="true"]')
            : null
          if (!editable) return
          event.preventDefault()
          event.stopPropagation()
          accept()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [text, accept])

      // The wrapper always stays mounted (as a zero-size anchor) so the probe can
      // find the composer and measure it before anything is ever shown.
      const showGhost = Boolean(text) && draftEmpty && box && box.width > 24

      const anchor = {
        position: 'absolute',
        left: '0px',
        top: '0px',
        width: '0px',
        height: '0px',
        overflow: 'hidden',
        pointerEvents: 'none',
        opacity: '0',
      }

      const ghost = showGhost ? {
        position: 'absolute',
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${Math.max(box.height || 24, 20)}px`,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        pointerEvents: 'none',
        cursor: 'pointer',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        color: box.color || 'inherit',
        // Opaque backing hides the native placeholder that sits at the same spot.
        background: box.background && box.background !== 'transparent' ? box.background : 'transparent',
        opacity: '1',
        fontFamily: box.fontFamily,
        fontSize: box.fontSize,
        fontWeight: box.fontWeight,
        lineHeight: box.lineHeight,
        letterSpacing: box.letterSpacing,
        userSelect: 'none',
        zIndex: 2,
      } : anchor

      return h('div', {
        ref: wrapRef,
        className: 'dsh-next-suggestion-ghost',
        style: ghost,
        title: showGhost ? '按 Tab 填入' : undefined,
        onMouseDown: (event) => event.preventDefault(),
        onClick: (event) => {
          event.preventDefault()
          accept()
        },
      }, showGhost ? [
        h('span', {
          key: 'text',
          style: { flex: '0 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', opacity: '0.5' },
        }, text),
      ] : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'next-suggestion',
          order: 9,
        }, NextSuggestion))
      },
    }
  },
})
