import { EventEmitter } from "eventemitter3"
import { inflate } from "pako"
import Debug from "debug"
import type { HeaderRecord } from "undici-types/header"

const debugHttp = Debug("screepsapi:http")
const debugRateLimit = Debug("screepsapi:ratelimit")

const DEFAULT_SHARD = "shard0"
const OFFICIAL_HISTORY_INTERVAL = 100
const PRIVATE_HISTORY_INTERVAL = 20

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const mapToShard = <T>(res: T & { list?: any; rooms?: any; shards?: any }) => {
  if (!res.shards) {
    res.shards = {
      privSrv: res.list || res.rooms,
    }
  }
  return res
}

interface RawOpts extends URL {
  url: string | URL
  path: string
  token: string
}
export class RawAPI extends EventEmitter<{
  token: [token: string]
  auth: []
  rateLimit: [ReturnType<typeof RawAPI.prototype.buildRateLimit>]
  response: [Response]
}> {
  opts: {
    url: string
    host?: string
    port?: string
    pathname?: string
    email?: string
    password?: string
    experimentalRetry429?: boolean
  } & AdditonalKeys
  token?: string
  private __authed = false

  constructor(opts: Partial<RawOpts> = {}) {
    super()
    this.opts = {} as any
    this.setServer(opts)
  }

  readonly raw = {
    token: undefined as string | undefined,
    /**
     * GET /api/version
     */
    version: (): Res<
      {
        package: number
        protocol: number
        serverData: AtLeast<{
          customObjectTypes: object
          historyChunkSize: number
          features: AtLeast<{ name: string; version: number }>[]
          shards: string[]
        }>
        users: number
      } & Partial<{
        currentSeason: string | undefined
        seasonAccessCost: string | undefined
        decorationConvertationCost: number | undefined
        decorationPixelizationCost: number | undefined
      }>
    > => this.req("GET", "/api/version"),
    /**
     * GET /api/authmod
     */
    authmod: (): Res<{ name: string; version?: any }> => {
      if (this.isOfficialServer()) {
        return Promise.resolve({ ok: 1, name: "official" })
      }
      return this.req("GET", "/api/authmod")
    },
    /**
     * Official:
     * GET /room-history/${shard}/${room}/${tick}.json
     * Private:
     * GET /room-history
     */
    history: (
      room: string,
      tick: number,
      shard = DEFAULT_SHARD,
    ): Promise<{
      /** milliseconds since the Unix epoch */
      timestamp: number
      room: string
      base: number
      ticks: { [time: string]: AdditonalKeys }
    }> => {
      if (this.isOfficialServer()) {
        tick -= tick % OFFICIAL_HISTORY_INTERVAL
        return this.req("GET", `/room-history/${shard}/${room}/${tick}.json`)
      } else {
        tick -= tick % PRIVATE_HISTORY_INTERVAL
        return this.req("GET", "/room-history", { room, time: tick })
      }
    },
    servers: {
      /**
       * POST /api/servers/list
       * A list of community servers
       */
      list: (): Res<{
        servers: {
          _id: string
          settings: {
            host: string
            port: string
            pass: string
          }
          name: string
          status: string
          likeCount: number
        }[]
      }> => this.req("POST", "/api/servers/list", {}),
    },
    auth: {
      /**
       * POST /api/auth/signin
       */
      signin: (email: string, password: string): Res<{ token: string }> =>
        this.req("POST", "/api/auth/signin", { email, password }),
      /**
       * POST /api/auth/steam-ticket
       */
      steamTicket: (ticket: any, useNativeAuth = false): UndocumentedRes =>
        this.req("POST", "/api/auth/steam-ticket", { ticket, useNativeAuth }),
      /**
       * GET /api/auth/me
       */
      me: (): Res<Me> => this.req("GET", "/api/auth/me"),
      /**
       * GET /api/auth/query-token
       */
      queryToken: (token: string): UndocumentedRes =>
        this.req("GET", "/api/auth/query-token", { token }),
    },
    register: {
      /**
       * GET /api/register/check-email
       */
      checkEmail: (email: string): UndocumentedRes =>
        this.req("GET", "/api/register/check-email", { email }),
      /**
       * GET /api/register/check-username
       */
      checkUsername: (username: string): UndocumentedRes =>
        this.req("GET", "/api/register/check-username", { username }),
      /**
       * POST /api/register/set-username
       */
      setUsername: (username: string): UndocumentedRes =>
        this.req("POST", "/api/register/set-username", { username }),
      /**
       * POST /api/register/submit
       */
      submit: (username: string, email: string, password: string, modules: any): UndocumentedRes =>
        this.req("POST", "/api/register/submit", { username, email, password, modules }),
    },
    userMessages: {
      /**
       * GET /api/user/messages/list?respondent={userId}
       * @param respondent the long `_id` of the user, not the username
       */
      list: (
        respondent: string,
      ): Res<{
        messages: { _id: string; date: string; type: string; text: string; unread: boolean }[]
      }> => this.req("GET", "/api/user/messages/list", { respondent }),
      /**
       * GET /api/user/messages/index
       */
      index: (): Res<{
        messages: {
          _id: string
          message: {
            _id: string
            user: string
            respondent: string
            date: string
            type: string
            text: string
            unread: boolean
          }
        }[]
        users: { [userId: string]: { _id: string; username: string; badge: Badge } }
      }> => this.req("GET", "/api/user/messages/index"),
      /**
       * GET /api/user/messages/unread-count
       */
      unreadCount: (): Res<{ count: number }> => this.req("GET", "/api/user/messages/unread-count"),
      /**
       * POST /api/user/messages/send
       * @param respondent the long `_id` of the user, not the username
       */
      send: (respondent: string, text: string): Res<{}> =>
        this.req("POST", "/api/user/messages/send", { respondent, text }),
      /**
       * POST /api/user/messages/mark-read
       */
      markRead: (id: string): UndocumentedRes =>
        this.req("POST", "/api/user/messages/mark-read", { id }),
    },
    game: {
      /**
       * @param rooms An array of room names
       * The return type is not mapped correctly
       */
      mapStats: (
        rooms: string[],
        statName: "owner0" | "claim0" | StatKey,
        shard = DEFAULT_SHARD,
      ): Res<{
        stats: {
          [roomName: string]: {
            status: string
            novice: string
            own: { user: string; level: number }
          } & { [key in StatKey]: { user: string; value: number }[] }
        }
        users: { [userId: string]: { _id: string; username: string; badge: Badge } }
      }> => this.req("POST", "/api/game/map-stats", { rooms, statName, shard }),
      /**
       * POST /api/game/gen-unique-object-name
       */
      genUniqueObjectName: (type: "flag" | "spawn", shard = DEFAULT_SHARD): Res<{ name: string }> =>
        this.req("POST", "/api/game/gen-unique-object-name", { type, shard }),
      /**
       * POST /api/game/check-unique-object-name
       */
      checkUniqueObjectName: (type: string, name: string, shard = DEFAULT_SHARD): UndocumentedRes =>
        this.req("POST", "/api/game/check-unique-object-name", { type, name, shard }),
      /**
       * POST /api/game/place-spawn
       */
      placeSpawn: (
        room: string,
        x: number,
        y: number,
        name: string,
        shard = DEFAULT_SHARD,
      ): UndocumentedRes => this.req("POST", "/api/game/place-spawn", { name, room, x, y, shard }),
      /**
       * POST /api/game/create-flag
       * - if the name is new, result.upserted[0]._id is the game id of the created flag
       * - if not, this moves the flag and the response does not contain the id (but the id doesn't change)
       * - `connection` looks like some internal MongoDB thing that is irrelevant to us
       */
      createFlag: (
        room: string,
        x: number,
        y: number,
        name: string,
        color: FlagColor = 1,
        secondaryColor: FlagColor = 1,
        shard = DEFAULT_SHARD,
      ): DbResponse =>
        this.req("POST", "/api/game/create-flag", {
          name,
          room,
          x,
          y,
          color,
          secondaryColor,
          shard,
        }),
      /**
       * POST/api/game/gen-unique-flag-name
       */
      genUniqueFlagName: (shard = DEFAULT_SHARD): UndocumentedRes =>
        this.req("POST", "/api/game/gen-unique-flag-name", { shard }),
      /**
       * POST /api/game/check-unique-flag-name
       */
      checkUniqueFlagName: (name: string, shard = DEFAULT_SHARD): UndocumentedRes =>
        this.req("POST", "/api/game/check-unique-flag-name", { name, shard }),
      /**
       * POST /api/game/change-flag-color
       */
      changeFlagColor: (
        color: FlagColor = 1,
        secondaryColor: FlagColor = 1,
        shard = DEFAULT_SHARD,
      ): DbResponse =>
        this.req("POST", "/api/game/change-flag-color", { color, secondaryColor, shard }),
      /**
       * POST /api/game/remove-flag
       */
      removeFlag: (room: string, name: string, shard = DEFAULT_SHARD): UndocumentedRes =>
        this.req("POST", "/api/game/remove-flag", { name, room, shard }),
      /**
       * POST /api/game/add-object-intent
       * [Missing parameter] _id is the game id of the object to affect (except for destroying structures), room is the name of the room it's in
       * this method is used for a variety of actions, depending on the `name` and `intent` parameters
       * @example remove flag: name = "remove", intent = {}
       * @example destroy structure: _id = "room", name = "destroyStructure", intent = [ {id: <structure id>, roomName, <room name>, user: <user id>} ]
  can destroy multiple structures at once
        * @example suicide creep: name = "suicide", intent = {id: <creep id>}
        * @example unclaim controller: name = "unclaim", intent = {id: <controller id>}
  intent can be an empty object for suicide and unclaim, but the web interface sends the id in it, as described
        * @example remove construction site: name = "remove", intent = {}
        */
      addObjectIntent: (
        room: string,
        name: string,
        intent: string,
        shard = DEFAULT_SHARD,
      ): DbResponse =>
        this.req("POST", "/api/game/add-object-intent", { room, name, intent, shard }),
      /**
       * POST /api/game/create-construction
       * @returns {{ ok, result: { ok, n }, ops: [ { type, room, x, y, structureType, user, progress, progressTotal, _id } ], insertedCount, insertedIds }}
       */
      createConstruction: (
        room: string,
        x: number,
        y: number,
        structureType: string,
        name: string,
        shard = DEFAULT_SHARD,
      ): DbInsertResponse<{
        ops: {
          type: string
          room: string
          x: number
          y: number
          structureType: string
          user: string
          progress: number
          progressTotal: number
          _id: string
        }[]
      }> =>
        this.req("POST", "/api/game/create-construction", {
          room,
          x,
          y,
          structureType,
          name,
          shard,
        }),
      /**
       * POST /api/game/set-notify-when-attacked
       */
      setNotifyWhenAttacked: (_id: string, enabled = true, shard = DEFAULT_SHARD): DbResponse =>
        this.req("POST", "/api/game/set-notify-when-attacked", { _id, enabled, shard }),
      /**
       * POST /api/game/create-invader
       */
      createInvader: (
        room: string,
        x: number,
        y: number,
        size: any,
        type: any,
        boosted = false,
        shard = DEFAULT_SHARD,
      ): UndocumentedRes =>
        this.req("POST", "/api/game/create-invader", {
          room,
          x,
          y,
          size,
          type,
          boosted,
          shard,
        }),
      /**
       * POST /api/game/remove-invader
       */
      removeInvader: (_id: string, shard = DEFAULT_SHARD): UndocumentedRes =>
        this.req("POST", "/api/game/remove-invader", { _id, shard }),
      /**
       * GET /api/game/time
       */
      time: (shard = DEFAULT_SHARD): Res<{ time: number }> =>
        this.req("GET", "/api/game/time", { shard }),
      /**
       * GET /api/game/world-size
       */
      worldSize: (shard = DEFAULT_SHARD): UndocumentedRes =>
        this.req("GET", "/api/game/world-size", { shard }),
      /**
       * GET /api/game/room-decorations
       */
      roomDecorations: (room: string, shard = DEFAULT_SHARD): UndocumentedRes =>
        this.req("GET", "/api/game/room-decorations", { room, shard }),
      /**
       * GET /api/game/room-objects
       */
      roomObjects: (room: string, shard = DEFAULT_SHARD): UndocumentedRes =>
        this.req("GET", "/api/game/room-objects", { room, shard }),
      /**
       * GET /api/game/room-terrain
       * terrain is a string of digits, giving the terrain left-to-right and top-to-bottom
       * 0: plain, 1: wall, 2: swamp, 3: also wall
       */
      roomTerrain: (
        room: string,
        encoded = 1,
        shard = DEFAULT_SHARD,
      ):
        | Res<{
            terrain: { room: string; x: number; y: number; type: "wall" | "swamp" }[]
          }>
        | Res<{
            terrain: { _id: string; room: string; terrain: string; type: "wall" | "swamp" }[]
          }> => this.req("GET", "/api/game/room-terrain", { room, encoded, shard }),
      /**
       * GET /api/game/room-status
       * if the room is in a novice area, novice will contain the Unix timestamp of the end of the protection (otherwise it is absent)
       */
      roomStatus: (
        room: string,
        shard = DEFAULT_SHARD,
      ): Promise<{
        _id: string
        status: "normal" | "out of borders"
        novice?: string
      }> => this.req("GET", "/api/game/room-status", { room, shard }),
      /**
       * GET /api/game/room-overview
       */
      roomOverview: (room: string, interval = 8, shard = DEFAULT_SHARD): UndocumentedRes =>
        this.req("GET", "/api/game/room-overview", { room, interval, shard }),
      /**
       * POST /api/game/rooms
       * Fetch multiple rooms terrain at once. Out of borders will not be included in the response.
       */
      rooms: (
        rooms: string[],
        shard = DEFAULT_SHARD,
      ): Res<{ rooms: { _id: string; room: string; type: "terrain"; terrain: string }[] }> =>
        this.req("POST", "/api/game/rooms", { rooms, shard }),

      market: {
        /**
         * GET /api/game/market/orders-index
         * - _id is the resource type, and there will only be one of each type.
         * - `count` is the number of orders.
         */
        ordersIndex: (
          shard = DEFAULT_SHARD,
        ): Res<{
          list: { _id: string; count: number }[]
        }> => this.req("GET", "/api/game/market/orders-index", { shard }),
        /**
         * GET /api/game/market/my-orders
         * `resourceType` is one of the RESOURCE_* constants.
         */
        myOrders: (): Res<{
          list: MarketOrder[]
        }> => this.req("GET", "/api/game/market/my-orders").then(mapToShard),
        /**
         * GET /api/game/market/orders
         * @param resourceType one of the RESOURCE_* constants.
         * `resourceType` is one of the RESOURCE_* constants.
         */
        orders: (
          resourceType: string,
          shard = DEFAULT_SHARD,
        ): Res<{
          list: MarketOrder[]
        }> => this.req("GET", "/api/game/market/orders", { resourceType, shard }),
        /**
         * GET /api/game/market/stats
         */
        stats: (resourceType: string, shard = DEFAULT_SHARD): UndocumentedRes =>
          this.req("GET", "/api/game/market/stats", { resourceType, shard }),
      },
      shards: {
        /**
         * GET /api/game/shards/info
         */
        info: (): Res<{
          shards: {
            name: string
            lastTicks: number[]
            cpuLimit: number
            rooms: number
            users: number
            tick: number
          }[]
        }> => this.req("GET", "/api/game/shards/info"),
      },
    },
    leaderboard: {
      /**
       * GET /api/leaderboard/list
       */
      list: (
        limit = 10,
        mode: "world" | "power" = "world",
        offset = 0,
        season?: string,
      ): Res<{
        list: { _id: string; season: string; user: string; score: number; rank: number }[]
        count: number
        users: { [userId: string]: User }
      }> => {
        if (mode !== "world" && mode !== "power") throw new Error("incorrect mode parameter")
        if (!season) season = this.currentSeason()
        return this.req("GET", "/api/leaderboard/list", { limit, mode, offset, season })
      },
      /**
       * GET /api/leaderboard/find
       * @param season An optional date in the format YYYY-MM, if not supplied all ranks in all seasons is returned.
       * - `user` (not `_id`) is the user's _id, as returned by `me` and `user/find`
       * - `rank` is 0-based
       */
      find: (
        username: string,
        mode: string = "world",
        season: string = "",
      ): Res<{
        _id: string
        season: string
        user: string
        score: number
        rank: number
      }> => this.req("GET", "/api/leaderboard/find", { season, mode, username }),
      /**
       * GET /api/leaderboard/seasons
       * The _id returned here is used for the season name in the other leaderboard calls
       */
      seasons: (): Res<{
        seasons: { _id: string; name: string; date: string }[]
      }> => this.req("GET", "/api/leaderboard/seasons"),
    },
    user: {
      /**
       * POST /api/user/badge
       */
      badge: (
        badge: Badge,
      ): Promise<{
        ok?: number
        error?: string
      }> => this.req("POST", "/api/user/badge", { badge }),
      /**
       * POST /api/user/respawn
       */
      respawn: (): UndocumentedRes => this.req("POST", "/api/user/respawn"),
      /**
       * POST /api/user/set-active-branch
       */
      setActiveBranch: (branch: string, activeName: string): UndocumentedRes =>
        this.req("POST", "/api/user/set-active-branch", { branch, activeName }),
      /**
       * POST /api/user/clone-branch
       */
      cloneBranch: (branch = "", newName: string, defaultModules: CodeList): UndocumentedRes =>
        this.req("POST", "/api/user/clone-branch", { branch, newName, defaultModules }),
      /**
       * POST /api/user/delete-branch
       */
      deleteBranch: (branch: string): UndocumentedRes =>
        this.req("POST", "/api/user/delete-branch", { branch }),
      /**
       * POST /api/user/notify-prefs
       */
      notifyPrefs: (prefs: any): UndocumentedRes =>
        // disabled,disabledOnMessages,sendOnline,interval,errorsInterval
        this.req("POST", "/api/user/notify-prefs", prefs),
      /**
       * POST /api/user/tutorial-done
       */
      tutorialDone: (): UndocumentedRes => this.req("POST", "/api/user/tutorial-done"),
      /**
       * POST /api/user/email
       */
      email: (email: string): UndocumentedRes => this.req("POST", "/api/user/email", { email }),
      /**
       * GET /api/user/world-start-room
       */
      worldStartRoom: (shard: string): UndocumentedRes =>
        this.req("GET", "/api/user/world-start-room", { shard }),
      /**
       * GET /api/user/world-status
       * returns a world status
       * - 'normal'
       * - 'lost' when you loose all your spawns
       * - 'empty' when you have respawned and not placed your spawn yet
       */
      worldStatus: (): Res<{
        status: "normal" | "lost" | "empty"
      }> => this.req("GET", "/api/user/world-status"),
      /**
       * GET /api/user/branches
       */
      branches: (): Res<{
        list: {
          _id: string
          branch: string
          activeWorld: boolean
          activeSim: boolean
        }[]
      }> => this.req("GET", "/api/user/branches"),
      code: {
        /**
         * GET /api/user/code
         * for pushing or pulling code, as documented at http://support.screeps.com/hc/en-us/articles/203022612
         * @returns code
         */
        get: (branch: string): Res<{ modules: CodeList }> =>
          this.req("GET", "/api/user/code", { branch }),
        /**
         * POST /api/user/code
         * for pushing or pulling code, as documented at http://support.screeps.com/hc/en-us/articles/203022612
         */
        set: (branch: string, modules: CodeList, _hash?: any): UndocumentedRes => {
          if (!_hash) _hash = Date.now()
          return this.req("POST", "/api/user/code", { branch, modules, _hash })
        },
      },
      decorations: {
        /**
         * GET /api/user/decorations/inventory
         */
        inventory: (): UndocumentedRes => this.req("GET", "/api/user/decorations/inventory"),
        /**
         * GET /api/user/decorations/themes
         */
        themes: (): UndocumentedRes => this.req("GET", "/api/user/decorations/themes"),
        /**
         * POST /api/user/decorations/convert
         */
        convert: (decorations: number[]): UndocumentedRes =>
          this.req("POST", "/api/user/decorations/convert", { decorations }),
        /**
         * POST /api/user/decorations/pixelize
         */
        pixelize: (count: number, theme = ""): UndocumentedRes =>
          this.req("POST", "/api/user/decorations/pixelize", { count, theme }),
        /**
         * POST /api/user/decorations/activate
         */
        activate: (_id: string, active: any): UndocumentedRes =>
          this.req("POST", "/api/user/decorations/activate", { _id, active }),
        /**
         * POST /api/user/decorations/deactivate
         */
        deactivate: (decorations: string[]): UndocumentedRes =>
          this.req("POST", "/api/user/decorations/deactivate", { decorations }),
      },
      /**
       * GET /api/user/respawn-prohibited-rooms
       * - `rooms` is an array, but seems to always contain only one element
       */
      respawnProhibitedRooms: (): Res<{ rooms: string[] }> =>
        this.req("GET", "/api/user/respawn-prohibited-rooms"),

      memory: {
        /**
         * GET /api/user/memory?path={path}
         * @param path the path may be empty or absent to retrieve all of Memory, Example: flags.Flag1
         * @returns gz: followed by base64-encoded gzipped JSON encoding of the requested memory path
         */
        get: (path = "", shard = DEFAULT_SHARD): Res<{ data: string }> =>
          this.req("GET", "/api/user/memory", { path, shard }),
        /**
         * POST /api/user/memory
         * @param path the path may be empty or absent to retrieve all of Memory, Example: flags.Flag1
         */
        set: (
          path: string,
          value: any,
          shard = DEFAULT_SHARD,
        ): DbInsertResponse<{
          ops: { user: string; expression: string; hidden: boolean }[]
          data: any
        }> => this.req("POST", "/api/user/memory", { path, value, shard }),

        segment: {
          /**
           * GET /api/user/memory-segment?segment=[0-99]
           * @param segment A number from 0-99
           */
          get: (segment: number, shard = DEFAULT_SHARD): Res<{ data: string }> =>
            this.req("GET", "/api/user/memory-segment", { segment, shard }),
          /**
           * POST /api/user/memory-segment
           * @param segment A number from 0-99
           */
          set: (segment: number, data: any, shard = DEFAULT_SHARD): UndocumentedRes =>
            this.req("POST", "/api/user/memory-segment", { segment, data, shard }),
        },
      },
      /**
       * GET /api/user/find?username={username}
       */
      find: (username: string): Res<{ user: User }> =>
        this.req("GET", "/api/user/find", { username }),
      /**
       * GET /api/user/find?id={userId}
       */
      findById: (id: string): Res<{ user: User }> => this.req("GET", "/api/user/find", { id }),
      /**
       * GET /api/user/stats
       */
      stats: (interval: number): UndocumentedRes =>
        this.req("GET", "/api/user/stats", { interval }),
      /**
       * GET /api/user/rooms
       */
      rooms: (id: string): UndocumentedRes =>
        this.req("GET", "/api/user/rooms", { id }).then(mapToShard),
      /**
       * GET /api/user/overview?interval={interval}&statName={statName}
       * @param statName energyControl
       */
      overview: (interval: number, statName: string): UndocumentedRes =>
        this.req("GET", "/api/user/overview", { interval, statName }),
      /**
       * GET /api/user/money-history
       */
      moneyHistory: (
        page = 0,
      ): Res<{
        page: number
        hasMore: boolean
        list: {
          _id: string
          date: string
          tick: number
          user: string
          type: string
          balance: number
          change: number
          market:
            | {
                order: {
                  type: string
                  resourceType: string
                  price: number
                  totalAmount: number
                  roomName: string
                }
              }
            | { extendOrder: { orderId: string; addAmount: number } }
            | {
                resourceType: string
                roomName: string
                targetRoomName: string
                price: number
                npc: boolean
                amount: number
              }
            | { changeOrderPrice: { orderId: string; oldPrice: number; newPrice: number } }
        }[]
      }> => this.req("GET", "/api/user/money-history", { page }),
      /**
       * POST /api/user/console
       */
      console: (
        expression: any,
        shard = DEFAULT_SHARD,
      ): DbInsertResponse<{
        ops: { user: string; expression: any; _id: string }[]
      }> => this.req("POST", "/api/user/console", { expression, shard }),
      /**
       * GET /api/user/name
       */
      name: (): UndocumentedRes => this.req("GET", "/api/user/name"),
    },
    experimental: {
      // https://screeps.com/api/experimental/pvp?start=14787157 seems to not be implemented in the api
      /**
       * time is the current server tick
       * _id contains the room name for each room, and lastPvpTime contains the last tick pvp occurred
       * if neither a valid interval nor a valid start argument is provided, the result of the call is still ok, but with an empty rooms array.
       */
      pvp: (
        interval = 100,
      ): Res<{
        time: number
        rooms: { _id: string; lastPvpTime: number }[]
      }> => this.req("GET", "/api/experimental/pvp", { interval }).then(mapToShard),
      /**
       * GET /api/experimental/nukes
       */
      nukes: (): Res<{
        nukes: {
          [shard: string]: {
            _id: string
            type: "nuke"
            room: string
            x: number
            y: number
            landTime: number
            launchRoomName: string
          }
        }
      }> => this.req("GET", "/api/experimental/nukes").then(mapToShard),
    },
    warpath: {
      /**
       * GET /api/warpath/battles
       */
      battles: (interval = 100): UndocumentedRes =>
        this.req("GET", "/api/warpath/battles", { interval }),
    },
    scoreboard: {
      /**
       * GET /api/scoreboard/list
       */
      list: (limit = 20, offset = 0): UndocumentedRes =>
        this.req("GET", "/api/scoreboard/list", { limit, offset }),
    },
  }

  currentSeason() {
    const now = new Date()
    const year = now.getFullYear()
    let month = (now.getUTCMonth() + 1).toString()
    if (month.length === 1) month = `0${month}`
    return `${year}-${month}`
  }

  isOfficialServer() {
    return this.opts.url.match(/screeps\.com/) !== null
  }

  mapToShard = mapToShard

  setServer(opts: Partial<RawOpts>) {
    if (!this.opts) {
      this.opts = {} as any
    }
    Object.assign(this.opts, opts)
    if (opts.path && !opts.pathname) {
      this.opts.pathname = opts.path
    }
    if (opts.port) {
      this.opts.port = String(opts.port)
      if (opts.hostname) {
        this.opts.host = `${opts.hostname}:${opts.port}`
      }
    }
    if (!opts.url) {
      this.opts.url = urlFormat(this.opts)
      if (!this.opts.url.endsWith("/")) this.opts.url += "/"
    }
    if (opts.token) {
      this.token = opts.token
    }
  }

  async auth(email: string, password: string, opts: Partial<RawOpts> = {}) {
    this.setServer(opts)
    if (email && password) {
      Object.assign(this.opts, { email, password })
    }
    const res = await this.raw.auth.signin(this.opts.email!, this.opts.password!)
    this.emit("token", res.token)
    this.emit("auth")
    this.__authed = true
    return res
  }

  async req(method: string, path: string, body: any = {}): UndocumentedRes {
    let url = new URL(path, this.opts.url)
    const opts: RequestInit & { headers: HeaderRecord } = {
      method,
      headers: {},
    }
    if (debugHttp.enabled) {
      debugHttp(`${method} ${path}`)
    }
    if (this.token) {
      Object.assign(opts.headers, {
        "X-Token": this.token,
        "X-Username": this.token,
      })
    }
    if (method === "GET") {
      Object.entries(body).forEach(([key, value]) => {
        if (value !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          url.searchParams.append(key, String(value))
        }
      })
    } else {
      opts.body = body
      if (typeof body === "object") {
        opts.body = JSON.stringify(body)
        opts.headers["Content-Type"] = "application/json"
      }
    }

    const res: Response & { data?: any } = await fetch(url, opts)

    const token = res.headers.get("x-token")
    if (token) {
      this.emit("token", token)
    }

    const rateLimit = this.buildRateLimit(method, path, res)
    this.emit("rateLimit", rateLimit)
    debugRateLimit(
      `${method} ${path} ${rateLimit.remaining}/${rateLimit.limit} ${rateLimit.toReset}s`,
    )

    if (res.headers.get("content-type")?.includes("application/json")) {
      res.data = await res.json()
    } else {
      res.data = await res.text()
    }

    if (!res.ok) {
      if (res.status === 401) {
        if (this.__authed && this.opts.email && this.opts.password) {
          this.__authed = false
          await this.auth(this.opts.email, this.opts.password)
          return this.req(method, path, body)
        } else {
          throw new Error("Not Authorized")
        }
      } else if (
        res.status === 429 &&
        !res.headers.get("x-ratelimit-limit") &&
        this.opts.experimentalRetry429
      ) {
        await sleep(Math.floor(Math.random() * 500) + 200)
        return this.req(method, path, body)
      }
      throw new Error(res.data)
    }

    this.emit("response", res)
    return res.data!
  }

  gz(data: string) {
    if (!data.startsWith("gz:")) return data
    const buf = Buffer.from(data.slice(3), "base64")
    return inflate(buf, { to: "string" })
  }

  inflate(data: string) {
    return JSON.parse(this.gz(data))
  }

  buildRateLimit(method: string, path: string, res: Response) {
    const limit = Number(res.headers.get("x-ratelimit-limit"))
    const remaining = Number(res.headers.get("x-ratelimit-remaining"))
    const reset = Number(res.headers.get("x-ratelimit-reset"))
    return {
      method,
      path,
      limit,
      remaining,
      reset,
      toReset: reset - Math.floor(Date.now() / 1000),
    }
  }
}

/** Based on Node.js built-in URL format */
function urlFormat(obj: Partial<URL>) {
  let protocol = obj.protocol || ""
  if (protocol && !protocol.endsWith(":")) {
    protocol += ":"
  }

  let pathname = obj.pathname || ""
  let host = ""

  if (obj.host) {
    host = obj.host
  } else if (obj.hostname) {
    host =
      obj.hostname.includes(":") &&
      (obj.hostname[0] !== "[" || obj.hostname[obj.hostname.length - 1] !== "]")
        ? "[" + obj.hostname + "]"
        : obj.hostname
    if (obj.port) {
      host += ":" + obj.port
    }
  }

  if (pathname.includes("#") || pathname.includes("?")) {
    let newPathname = ""
    let lastPos = 0
    const len = pathname.length
    for (let i = 0; i < len; i++) {
      const code = pathname.charAt(i)
      if (code === "#" || code === "?") {
        if (i > lastPos) {
          newPathname += pathname.slice(lastPos, i)
        }
        newPathname += code === "#" ? "%23" : "%3F"
        lastPos = i + 1
      }
    }
    if (lastPos < len) {
      newPathname += pathname.slice(lastPos)
    }
    pathname = newPathname
  }

  if (host) {
    if (pathname && pathname[0] !== "/") pathname = "/" + pathname
    host = "//" + host
  }

  return protocol + host + pathname
}

type Res<T extends object> = Promise<T & { ok: number }>
export type UndocumentedRes = Promise<any>

type AdditonalKeys<T = any> = Partial<Record<string, T>>
type AtLeast<T extends object> = T & AdditonalKeys

type DbResponse = Res<{
  result: {
    nModified: number
    ok: number
    upserted?: { index: number; _id: string }[]
    n: number
  }
  connection: { host: string; id: string; port: number }
}>
type DbInsertResponse<T> = Res<
  {
    result: { ok: number; n: number }
    insertedCount: number
    insertedIds: string[]
  } & T
>

export interface Badge {
  color1: string
  color2: string
  color3: string
  flip: boolean
  param: number
  type: number | { path1: string; path2: string }
}

/**
 * - Red = 1,
 * - Purple = 2,
 * - Blue = 3,
 * - Cyan = 4,
 * - Green = 5,
 * - Yellow = 6,
 * - Orange = 7,
 * - Brown = 8,
 * - Grey = 9,
 * - White = 10
 */
type FlagColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

type StatKey =
  | "creepsLost"
  | "creepsProduced"
  | "energyConstruction"
  | "energyControl"
  | "energyCreeps"
  | "energyHarvested"

export interface MarketOrder {
  _id: string
  created: string
  user: string
  active: boolean
  type: "buy" | "sell"
  amount: number
  remainingAmount: number
  resourceType: string
  price: number
  totalAmount: number
  roomName: string
}

export interface Me extends User {
  email: string
  cpu: number
  password: string
  notifyPrefs: {
    sendOnline: any
    errorsInterval: any
    disabledOnMessages: any
    disabled: any
    interval: any
  }
  credits: number
  lastChargeTime: any
  lastTweetTime: any
  github: { id: any; username: any }
  twitter: { username: string; followers_count: number }
}

export interface User {
  _id: string
  username: string
  badge: Badge
  gcl: number
}

interface BinaryModule {
  /** base64 encoded binary data */
  binary: string
}
export interface CodeList {
  [fileName: string]: string | BinaryModule
}
