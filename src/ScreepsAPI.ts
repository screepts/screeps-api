import { Socket } from "./Socket"
export type { SocketEventTypes } from "./Socket"
import { RawAPI, type CodeList, type Me, type UndocumentedRes, type User } from "./RawAPI"
export type { CodeList, Me, User, Badge, MarketOrder, UndocumentedRes } from "./RawAPI"
import { ConfigManager } from "./ConfigManager"
export { ConfigManager } from "./ConfigManager"

const DEFAULTS = {
  protocol: "https",
  hostname: "screeps.com",
  port: 443,
  path: "/",
}

const configManager = new ConfigManager()

interface RateLimit {
  limit: number
  period: string
  remaining: number
  reset: number
  toReset: number
}

export class ScreepsAPI extends RawAPI {
  socket: Socket

  appConfig: { [metadata: string]: any } = {}
  rateLimits: {
    global: RateLimit
    GET: { [path: string]: RateLimit }
    POST: { [path: string]: RateLimit }
  }

  private _user?: (Me | User) & { ok: number }
  private _tokenInfo?: { full: boolean }

  static async fromConfig(server = "main", config: string | false = false, opts = {}) {
    const data = await configManager.getConfig()

    if (!data) throw new Error("No valid config found")
    if (!server && process.stdin.isTTY && process.stdout.isTTY) {
      const { select, isCancel } = await import("@clack/prompts")
      const selectedServer = await select({
        message: "Select a server:",
        withGuide: false,
        options: Object.entries(data.servers).map(([value, args]) => ({
          value,
          hint: args!.host,
        })),
      })
      if (isCancel(selectedServer)) throw new Error("Server selection cancelled")
      server = selectedServer
    }

    const conf = data.servers[server]
    if (!conf) throw new Error(`Server '${server}' does not exist in '${configManager.path}'`)

    if (conf.ptr) conf.path = "/ptr"
    if (conf.season) conf.path = "/season"
    const api = new ScreepsAPI(
      Object.assign(
        {
          hostname: conf.host,
          protocol: conf.secure ? "https" : "http",
          path: "/",
        },
        conf,
        opts,
      ),
    )

    api.appConfig = data.configs?.[config || ""] || {}

    if (!conf.token && conf.username && conf.password) {
      await api.auth(conf.username, conf.password)
    }

    return api
  }

  constructor(opts = {}) {
    opts = Object.assign({}, DEFAULTS, opts)
    super(opts)
    this.on("token", (token) => {
      this.token = token
      this.raw.token = token
    })
    const defaultLimit = (limit: number, period: string) => ({
      limit,
      period,
      remaining: limit,
      reset: 0,
      toReset: 0,
    })
    this.rateLimits = {
      global: defaultLimit(120, "minute"),
      GET: {
        "/api/game/room-terrain": defaultLimit(360, "hour"),
        "/api/user/code": defaultLimit(60, "hour"),
        "/api/user/memory": defaultLimit(1440, "day"),
        "/api/user/memory-segment": defaultLimit(360, "hour"),
        "/api/game/market/orders-index": defaultLimit(60, "hour"),
        "/api/game/market/orders": defaultLimit(60, "hour"),
        "/api/game/market/my-orders": defaultLimit(60, "hour"),
        "/api/game/market/stats": defaultLimit(60, "hour"),
        "/api/game/user/money-history": defaultLimit(60, "hour"),
      },
      POST: {
        "/api/user/console": defaultLimit(360, "hour"),
        "/api/game/map-stats": defaultLimit(60, "hour"),
        "/api/user/code": defaultLimit(240, "day"),
        "/api/user/set-active-branch": defaultLimit(240, "day"),
        "/api/user/memory": defaultLimit(240, "day"),
        "/api/user/memory-segment": defaultLimit(60, "hour"),
      },
    }
    this.on("rateLimit", (limits) => {
      const rates = (
        this.rateLimits as Partial<Record<string, RateLimit | Partial<Record<string, RateLimit>>>>
      )[limits.method] as Partial<Record<string, RateLimit>> | undefined
      const rate = rates?.[limits.path] || this.rateLimits.global
      const copy: Partial<typeof limits> = Object.assign({}, limits)
      delete copy.path
      delete copy.method
      Object.assign(rate, copy)
    })
    this.socket = new Socket(this)
  }

  getRateLimit(method: "GET" | "POST", path: string) {
    return this.rateLimits[method][path] || this.rateLimits.global
  }

  get rateLimitResetUrl() {
    return `https://screeps.com/a/#!/account/auth-tokens/noratelimit?token=${this.token!.slice(
      0,
      8,
    )}`
  }

  async me() {
    if (this._user) return this._user
    const tokenInfo = await this.tokenInfo()
    if (tokenInfo.full) {
      this._user = await this.raw.auth.me()
    } else {
      const { username } = await this.raw.user.name()
      const { ok, user } = await this.raw.user.find(username)
      this._user = { ...user, ok }
    }
    return this._user
  }

  async tokenInfo() {
    if (this._tokenInfo) {
      return this._tokenInfo
    }
    if ("token" in this.opts) {
      const { token } = await this.raw.auth.queryToken(this.token!)
      this._tokenInfo = token
    } else {
      this._tokenInfo = { full: true }
    }
    return this._tokenInfo!
  }

  async userID() {
    const user = await this.me()
    return user._id
  }

  readonly registerUser = this.raw.register.submit

  readonly history = this.raw.history
  readonly authmod = this.raw.authmod
  readonly version = this.raw.version
  readonly time = this.raw.game.time
  readonly leaderboard = this.raw.leaderboard
  readonly market = this.raw.game.market
  readonly console = this.raw.user.console

  readonly code = codeRepository(this)

  readonly memory = {
    ...this.raw.user.memory,
    /** Unlike raw.user.memory.get, this method returns uncompressed memory */
    get: async (path?: string, shard?: string) => {
      const { data } = await this.raw.user.memory.get(path, shard)
      return this.gz(data)
    },
  }
  readonly segment = this.raw.user.memory.segment
}

const codeRepository = ({ raw: { user } }: RawAPI) => ({
  get: user.code.get,
  /** Unlike raw.code.set, this method will create a new branch if it doesn't exist */
  set: async (branch: string, code: CodeList): UndocumentedRes => {
    const { list } = await user.branches()
    if (list.some((b) => b.branch == branch)) {
      return user.code.set(branch, code)
    } else {
      return user.cloneBranch("", branch, code)
    }
  },
  branches: user.branches,
  cloneBranch: user.cloneBranch,
  deleteBranch: user.deleteBranch,
  setActiveBranch: user.setActiveBranch,
})
