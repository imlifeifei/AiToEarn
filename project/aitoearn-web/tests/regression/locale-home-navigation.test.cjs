// Run with: node --test tests/regression/locale-home-navigation.test.cjs
// Execute real TSX components with only framework/UI boundaries stubbed; no server needed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')
const React = require('react')
const root = path.resolve(__dirname, '../..')

function harness(lng, options = {}) {
  const calls = []
  const effects = []
  const callbacks = []
  const cache = new Map()
  const node = tag => props => React.createElement(tag, props, props.children)
  const ui = new Proxy({}, { get: (_, name) => node(String(name)) })
  const user = { token: options.token, _hasHydrated: true, setToken() {}, setUserInfo() {} }
  const dialog = { visible: true, fromGuard: true, closeLoginDialog() {}, openLoginDialog() {}, ...options.dialog }
  const store = state => selector => selector ? selector(state) : state
  const userStore = store(user)
  const dialogStore = store(dialog)
  dialogStore.getState = () => dialog
  const router = Object.fromEntries(['push', 'replace', 'back'].map(method => [method, value => calls.push([method, value])]))
  const react = {
    ...React,
    memo: component => component,
    useEffect: fn => effects.push(fn),
    useCallback: fn => { callbacks.push(fn); return fn },
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value === 0 ? 400 : value, () => {}],
  }
  const mocks = {
    react,
    'next/link': { __esModule: true, default: node('a') },
    'next/image': { __esModule: true, default: node('img') },
    'next/navigation': { useParams: () => ({ lng, taskId: 'task' }), useRouter: () => router, useSearchParams: () => ({ get: key => options.query?.[key] ?? null }) },
    '@/app/i18n/client': { useTransClient: () => ({ t: key => key }) },
    '@/app/layout/shared': { BRAND_TITLE: 'AiToEarn', BrandWordmark: node('span') },
    '@/utils/className': { cn: (...args) => args.filter(Boolean).join(' ') },
    '@/utils/oss': { getOssUrl: value => value },
    '@/store/user': { useUserStore: userStore },
    '@/store/login-dialog': { useLoginDialogStore: dialogStore },
    '@/hooks/useIsMobile': { useIsMobile: () => false },
    'zustand/shallow': { useShallow: fn => fn },
    'lucide-react': ui,
    'framer-motion': { motion: { div: node('div') } },
    '@hookform/resolvers/zod': { zodResolver: () => () => {} },
    '@react-oauth/google': { GoogleLogin: node('google-login') },
    'react-hook-form': { useForm: () => ({ handleSubmit: fn => fn, register: () => ({}), formState: { errors: {} } }) },
    './useCountdown': { useCountdown: () => ({ countdown: 0, isCounting: false }) },
    '@/api/auth/auth.api': Object.fromEntries(['emailCodeLoginApi', 'googleLoginApi', 'phoneCodeLoginApi'].map(name => [name, async () => ({ code: 0, data: { token: 'test-token' } })])),
    '@/utils/ui/toast': { toast: { success() {}, error(message) { throw new Error(message) } } },
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const mod = { exports: {} }
    cache.set(file, mod)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2020 },
      fileName: file,
    }).outputText
    const localRequire = name => {
      if (name in mocks) return mocks[name]
      if (/\.(png|svg)$/.test(name)) return 'logo.png'
      if (name.startsWith('@/components/')) return ui
      if (name === './EmailLoginForm') return { EmailLoginForm: node('email-login') }
      if (name.startsWith('@/') || name.startsWith('.')) {
        const base = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : path.resolve(path.dirname(file), name)
        const resolved = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map(ext => base + ext).find(p => fs.existsSync(p) && fs.statSync(p).isFile())
        if (!resolved) throw new Error(`Cannot resolve ${name} in ${file}`)
        return load(resolved)
      }
      return require(name)
    }
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console, window: { history: { length: options.historyLength ?? 1 } } }, { filename: file })(localRequire, mod, mod.exports)
    return mod.exports
  }
  function flatten(element) {
    if (element == null || typeof element !== 'object') return []
    if (Array.isArray(element)) return element.flatMap(flatten)
    if (typeof element.type === 'function') return flatten(element.type(element.props))
    return [element, ...flatten(element.props?.children)]
  }
  return { load: name => load(path.join(root, 'src', name)), flatten, calls, effects, callbacks, mocks, ui, node, router }
}

for (const lng of ['zh-CN', 'en', 'ja']) {
  test(`self-hosted AI publish submits with zero local credits and preserves /${lng} task state`, async () => {
    for (const creditsBalance of [0, 100]) {
      const h = harness(lng, { token: 'test-token' })
      const pending = []
      let lowBalanceAlerts = 0
      h.mocks.react.useState = initial => [initial === '' ? '  测试提交反馈  ' : initial, () => {}]
      h.mocks.react.useImperativeHandle = () => {}
      h.mocks['zustand/react/shallow'] = { useShallow: fn => fn }
      h.mocks['@/store/user'].useUserStore.getState = () => ({ creditsBalance })
      h.mocks['@/store/account'] = { useAccountStore: { getState: () => ({ setLowBalanceAlertOpen: () => lowBalanceAlerts++ }) } }
      h.mocks['@/store/agent'] = { useAgentStore: () => ({ setPendingTask: task => pending.push(task), setActionContext() {} }) }
      h.mocks['@/hooks/useMediaUpload'] = { useMediaUpload: () => ({ medias: [], isUploading: false }) }
      h.mocks['@/hooks/usePlatformMetadata'] = { usePlatformInfoList: () => [] }
      h.mocks['@/utils/auth'] = { navigateToLogin() { throw new Error('Authenticated user must not be sent to login') } }
      h.mocks['./style.css'] = {}
      const { HomeChat } = h.load('app/[lng]/ai-social/components/HomeChat/index.tsx')
      const tree = h.flatten(HomeChat.render({}, null))
      const composer = tree.find(el => el.type === 'ChatInput')
      assert.ok(composer, 'Composer must be rendered')
      await composer.props.onSend()
      assert.equal(lowBalanceAlerts, 0, 'Self-hosted submit must not depend on unused SaaS credit balance')
      assert.equal(pending.length, 1, 'Submitted text must be stored before navigation')
      assert.equal(pending[0].prompt, '测试提交反馈')
      assert.deepEqual(h.calls, [['push', `/${lng}/chat/new`]])
    }
  })

  test(`AI assets start-conversation opens the creation entry, not shared chat, for /${lng}`, () => {
    const h = harness(lng)
    h.mocks.react.useState = initial => [initial === true ? false : initial, () => {}]
    h.mocks['@/hooks'] = { useDocumentTitle() {} }
    h.mocks['@/api/ai/ai.api'] = { getAgentAssets: async () => ({ data: { list: [], total: 0 } }) }
    h.mocks['@/utils/agent/asset'] = { getAssetMediaType: () => 'image' }
    h.mocks['react-infinite-scroll-component'] = { __esModule: true, default: h.node('scroll') }
    h.mocks['react-masonry-css'] = { __esModule: true, default: h.node('masonry') }
    h.mocks['./components/AgentAssetCard'] = h.ui
    h.mocks['./components/AgentAssetCard/AgentAssetCardSkeleton'] = h.ui
    h.mocks['./components/AgentAssetsHeader'] = h.ui
    const { AgentAssetsPageCore } = h.load('app/[lng]/agent-assets/agentAssetsPageCore.tsx')
    const link = h.flatten(AgentAssetsPageCore()).find(el => el.type === 'a' && el.props.children === 'agentAssets.goToChat')
    assert.ok(link, 'Empty-assets start-conversation entry must be present')
    assert.equal(link.props.href, `/${lng}/ai-social`)
  })

  test(`shell home anchors stay within /${lng}`, () => {
    const h = harness(lng)
    const { LogoSection } = h.load('app/layout/LayoutSidebar/components/LogoSection.tsx')
    const { MobileTopBar } = h.load('app/layout/MobileNav/components/MobileTopBar.tsx')
    const { MobileBottomBar } = h.load('app/layout/MobileNav/components/MobileBottomBar/index.tsx')
    const elements = [LogoSection({ collapsed: false }), LogoSection({ collapsed: true }), MobileTopBar({}), MobileBottomBar({ currentRoute: '/', hidden: false })]
    const links = elements.flatMap(h.flatten).filter(el => ['sidebar-logo-link', 'mobile-topbar-logo', 'mobile-bottom-nav-content'].includes(el.props?.['data-testid']))
    assert.equal(links.length, 4)
    for (const link of links) assert.equal(link.props.href, `/${lng}`, link.props['data-testid'])
    const content = links.find(el => el.props['data-testid'] === 'mobile-bottom-nav-content')
    assert.equal(content.props['aria-current'], 'page')
  })

  test(`login logos and authenticated redirect stay within /${lng}`, () => {
    const h = harness(lng)
    const LoginContent = h.load('app/[lng]/auth/login/components/LoginContent/index.tsx').default
    const homeLinks = h.flatten(LoginContent()).filter(el => el.type === 'a' && !el.props.href.includes('websit'))
    assert.equal(homeLinks.length, 2)
    for (const link of homeLinks) assert.equal(link.props.href, `/${lng}`)
    const authenticated = harness(lng, { token: 'test-token' })
    authenticated.load('app/[lng]/auth/login/components/LoginContent/index.tsx').default()
    authenticated.effects.forEach(fn => fn())
    assert.deepEqual(authenticated.calls, [['replace', `/${lng}`]])
  })

  test(`auth redirects and guarded dialog close stay within /${lng}`, () => {
    for (const token of [undefined, 'test-token']) {
      const h = harness(lng, { token })
      h.load('app/[lng]/auth/components/AuthRedirect.tsx').default()
      h.effects.forEach(fn => fn())
      assert.deepEqual(h.calls, [['replace', `/${lng}`]])
    }
    const h = harness(lng)
    const tree = h.flatten(h.load('app/layout/LoginDialog/index.tsx').default())
    tree.find(el => el.type === 'Dialog').props.onOpenChange(false)
    assert.deepEqual(h.calls, [['push', `/${lng}`]])
  })

  test(`not-found return-home anchor stays within /${lng}`, () => {
    const h = harness(lng)
    const tree = h.flatten(h.load('app/[lng]/not-found.tsx').default())
    assert.equal(tree.find(el => el.type === 'a').props.href, `/${lng}`)
  })

  test(`chat return-home actions stay within /${lng} without changing back/stop behavior`, () => {
    const shared = harness(lng)
    shared.mocks['@/hooks'] = { useDocumentTitle() {} }
    shared.mocks['./[taskId]/utils'] = { convertMessages: () => [] }
    shared.mocks['@/api/ai/ai.api'] = { agentApi: {} }
    shared.load('app/[lng]/chat/page.tsx').default()
    shared.callbacks[0]()
    assert.deepEqual(shared.calls, [['push', `/${lng}`]])
  })

  test(`chat detail home fallback preserves /${lng}, back history, and stopping generation`, () => {
    for (const historyLength of [1, 2]) {
      let stopped = 0
      const h = harness(lng, { historyLength })
      h.mocks['@/hooks'] = { useDocumentTitle() {}, useMediaUpload: () => ({ medias: [] }) }
      h.mocks['@/store/agent'] = { useAgentStore: () => ({ stopTask: () => stopped++ }) }
      h.mocks['@/store/plugin'] = { usePluginStore: selector => selector({ publishTasks: [] }) }
      h.mocks['@/api/ai/ai.api'] = { agentApi: {} }
      h.mocks['./components'] = h.ui
      h.mocks['./hooks'] = {
        useChatState: () => ({ displayMessages: [], workflowSteps: [], isLoading: false, isGenerating: true }),
        useScrollControl: () => ({}),
      }
      const tree = h.flatten(h.load('app/[lng]/chat/[taskId]/page.tsx').default())
      tree.find(el => el.type === 'ChatHeader').props.onBack()
      assert.equal(stopped, 1)
      assert.deepEqual(h.calls, historyLength === 1 ? [['push', `/${lng}`]] : [['back', undefined]])
    }
  })

  test(`login dialog explicit root redirect stays within /${lng}`, () => {
    const h = harness(lng, { dialog: { fromGuard: false, redirectUrl: '/' } })
    h.flatten(h.load('app/layout/LoginDialog/index.tsx').default())
    h.callbacks[1]()
    assert.deepEqual(h.calls, [['push', `/${lng}`]])
  })

  test(`successful login home fallbacks preserve /${lng} and explicit non-home targets`, async () => {
    for (const redirect of [undefined, '', '/', '/tasks-history', `/${lng}/accounts`]) {
      for (const kind of ['Email', 'Phone', 'Google']) {
        const h = harness(lng, { query: { redirect } })
        const formType = kind === 'Phone' ? 'Phone' : 'Email'
        const Component = h.load(`app/[lng]/auth/login/components/LoginContent/${formType}LoginForm.tsx`)[`${formType}LoginForm`]
        const tree = h.flatten(Component())
        if (kind === 'Google') await tree.find(el => el.type === 'google-login').props.onSuccess({ credential: 'test-credential' })
        else await tree.find(el => el.type === 'form').props.onSubmit({ email: 'test@example.invalid', phone: '13000000000', code: '123456' })
        assert.deepEqual(h.calls, [['push', redirect && redirect !== '/' ? redirect : `/${lng}`]], `${kind}: ${redirect}`)
      }
    }
  })
}
