// 审阅台 · 浏览器半边
//   - 侧栏加一个「审阅台」入口，主区域是插件页面（/proof-board/，iframe）
//   - 页面里点「把批注交给 agent」：页面 postMessage 一段整理好的提示词，
//     这里开一个新对话把它填进输入框（不直接发送，用户还能补两句）
//   - 主题 / 语言跟随 DSH，切换时热更新页面，不重新加载
window.__ModuleLoader__.load({
  id: 'dsh-proof-board',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const PANEL = 'proof-board'
    const SRC = '/proof-board/'
    const LABEL = { zh: '审阅台', en: 'Proof Board' }

    // 侧栏图标：一块立起来的展板，右下角有个勾
    function BoardIcon(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 3.2, y: 4.2, width: 17.6, height: 13.6, rx: 2 }),
        h('path', { d: 'M8 7.8h4.2M8 11h3' }),
        h('path', { d: 'm14.6 10.8 1.9 1.9 3.2-3.4' }),
        h('path', { d: 'M7.5 17.8v2M16.5 17.8v2' }),
      )
    }

    function apply(ctx) {
      let lang = /^en\b/i.test(navigator.language) ? 'en' : 'zh'
      let scheme = null
      const frames = new Set()

      const post = (frame, message) => {
        if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, location.origin)
      }
      const pushScheme = () => {
        for (const frame of frames) post(frame, { type: 'proof-board:scheme', scheme })
      }
      const pushLang = () => {
        for (const frame of frames) post(frame, { type: 'proof-board:locale', lang })
      }

      ctx.inject(['theme'], (c) => {
        const push = (snapshot) => {
          scheme = snapshot?.active?.colorScheme
          pushScheme()
        }
        push(c.theme.getTheme())
        c.on('theme/change', push)
      })

      ctx.inject(['locale'], (c) => {
        const push = (snapshot) => {
          lang = snapshot?.active === 'en' ? 'en' : 'zh'
          pushLang()
        }
        push(c.locale.getSnapshot())
        c.on('locale/change', push)
      })

      function BoardPanel() {
        const ref = React.useRef(null)
        // 首帧语言放地址里；之后切换走 postMessage
        const [src] = React.useState(() => `${SRC}?lang=${lang}`)
        React.useEffect(() => {
          const self = ref.current
          if (self) frames.add(self)
          function onMessage(event) {
            const frame = ref.current
            if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return
            const message = event.data
            if (!message || message.type !== 'proof-board:revise' || typeof message.prompt !== 'string') return
            try {
              ctx.uiWorkspace.startSession(undefined, { prompt: message.prompt, whenDraftExists: 'replace' })
            } catch (error) {
              console.error('[proof-board] 开新对话失败', error)
              post(frame, { type: 'proof-board:start-failed', message: String((error && error.message) || error) })
            }
          }
          addEventListener('message', onMessage)
          return () => {
            removeEventListener('message', onMessage)
            frames.delete(self)
          }
        }, [])
        return h('iframe', {
          ref,
          src,
          title: LABEL[lang],
          allow: 'fullscreen',
          onLoad: (event) => {
            const frame = event.currentTarget
            post(frame, { type: 'proof-board:scheme', scheme })
            post(frame, { type: 'proof-board:locale', lang })
          },
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' },
        })
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 7, label: () => LABEL[lang] }, BoardIcon),
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, BoardPanel))
    }

    exports.isPlugin = true
    exports.inject = ['slots', 'uiWorkspace']
    exports.apply = apply
    return module.exports
  },
})